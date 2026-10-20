// dsh-pocket 项目文件浏览（插件级扩展）
//
// 目的：让 dsh 里的每个项目（= $DSH_HOME/storages/workspace.json 里的工作区）
// 都能从公网/局域网入口浏览与下载，复用 dsh-pocket 已有的 PIN 认证——
// 文件页挂在代理的 /pocket-files 路径下，认证在 proxy.mjs 的 auth 块里先做完，
// 本模块永远只处理已经通过 PIN 校验的请求。
//
// 路由（全部要求认证后再到达本模块）：
//   GET /pocket-files                     项目列表（HTML，手机优先）
//   GET /pocket-files?ws=<id>&p=<rel>     目录浏览（HTML，面包屑 + 下载按钮）
//   GET /pocket-files/api/projects        项目列表（JSON）
//   GET /pocket-files/api/list?ws&p       目录内容（JSON）
//   GET /pocket-files/dl?ws&p[&inline=1]  下载单个文件（默认 attachment；inline=1 供预览）
//   GET /pocket-files/zip?ws[&p][&all=1]  流式打包下载（store 算法，无压缩；默认跳过 .git/node_modules 等）
//
// 安全：项目路径来自 workspace.json / settings.fileBrowserRoots，属于可信来源；
// 相对路径参数 p 一律做 realpath 归一化并校验仍在项目根目录内（防 ../ 穿越与符号链接逃逸）。

import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, basename, extname, isAbsolute, relative as pathRelative, sep as PATH_SEP } from 'node:path';
import { homedir } from 'node:os';

export const FILES_PREFIX = '/pocket-files';

/** 打包 zip 默认跳过的大目录（二进制/依赖/缓存，几乎不是用户想下载的内容）。 */
const ZIP_SKIP = new Set(['.git', '.svn', '.hg', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.turbo', '.next', '.nuxt', '.gradle', '.idea', 'build']);
const ZIP_MAX_BYTES = 4 * 1024 * 1024 * 1024 - 65536; // ZIP 经典格式上限 4GB
const ZIP_MAX_ENTRIES = 60000;
const PROJECT_CACHE_MS = 3000;

// ---------- 小工具 ----------

function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtSize(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtDate(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.py': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8', '.toml': 'text/plain; charset=utf-8', '.ini': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function mimeOf(file) {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** 这些类型允许 inline 预览（图片/PDF/文本）；其余默认 attachment。 */
const INLINE_OK = /^(image\/|text\/|application\/pdf|application\/json|application\/xml)/;

function sendText(res, code, text) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendHtml(res, html, headOnly = false) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    // 文件页自带内联样式/脚本；禁掉上游可能存在的 CSP 影响不大（本页不经注入），
    // 但仍显式设置，避免某些中间层追加的默认策略把页面搞残。
    'referrer-policy': 'no-referrer',
  });
  res.end(headOnly ? '' : html);
}

function disposition(type, name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ---------- 路径解析 ----------

/** 归一化用户给的相对路径：去掉空段/`.`，`..` 只允许在根内回退，越界抛错。 */
function normalizeRel(input) {
  const raw = String(input ?? '').replace(/\\/g, '/');
  const out = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) throw new Error('path escapes project root | 路径越界');
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

function assertInside(rootReal, targetReal) {
  const rel = pathRelative(rootReal, targetReal);
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${PATH_SEP}`) && !isAbsolute(rel))) return rel;
  throw new Error('path escapes project root | 路径越界');
}

/** 把项目根 + 相对路径解析成真实绝对路径；不存在抛 { code:'not-found' }。 */
function resolveInProject(rootPath, rel) {
  const rootReal = realpathSync(rootPath);
  const target = rel ? join(rootReal, ...rel.split('/')) : rootReal;
  let real;
  try {
    real = realpathSync(target);
  } catch {
    const err = new Error('not found | 文件不存在');
    err.code = 'not-found';
    throw err;
  }
  assertInside(rootReal, real);
  return { abs: real, rootReal };
}

// ---------- 项目列表 ----------

/**
 * @param {object} opts
 * @param {string} [opts.home]  $DSH_HOME（默认 env / ~/.dsh）
 * @param {() => boolean} [opts.enabled] 功能开关（settings.fileBrowserEnabled）
 * @param {() => string[]} [opts.extraRoots] 自定义项目根（settings.fileBrowserRoots；非空则覆盖 workspace.json）
 */
export function createFileBrowser({ home, enabled = () => true, extraRoots = () => [], log = null } = {}) {
  const dshHome = home || process.env.DSH_HOME || join(homedir(), '.dsh');
  let cache = { at: 0, items: [] };

  function readProjects() {
    const now = Date.now();
    if (now - cache.at < PROJECT_CACHE_MS) return cache.items;
    const items = [];
    let custom = [];
    try {
      const v = extraRoots?.();
      if (Array.isArray(v)) custom = v.map((p) => String(p ?? '').trim()).filter(Boolean);
    } catch { /* 设置读取失败 → 回退 workspace.json */ }
    if (custom.length) {
      custom.forEach((p, i) => {
        try {
          if (statSync(p).isDirectory()) items.push({ id: `r${i}`, title: basename(p) || p, path: p });
        } catch { /* 目录不存在 → 跳过 */ }
      });
    } else {
      try {
        const raw = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'));
        const rows = raw?.tables?.workspaces ?? {};
        for (const [id, row] of Object.entries(rows)) {
          const p = typeof row?.path === 'string' ? row.path : '';
          if (!p) continue;
          try {
            if (!statSync(p).isDirectory()) continue;
          } catch { continue; }
          items.push({ id, title: String(row?.title || basename(p) || p), path: p });
        }
      } catch (err) {
        log?.warn?.(`dsh-pocket: files: cannot read workspace.json | 读不到工作区列表：${err.message}`);
      }
    }
    items.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    cache = { at: now, items };
    return items;
  }

  function findProject(wsId) {
    const items = readProjects();
    const id = String(wsId ?? '');
    return items.find((p) => p.id === id) ?? null;
  }

  // ---------- 页面渲染 ----------

  const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:18px 14px 40px;background:#f4f6f9;color:#111827;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
h1{font-size:19px;margin:0 0 4px}
.sub{color:#6b7280;font-size:13px;margin:0 0 18px}
a{color:#2563eb;text-decoration:none}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px 15px;margin:0 0 12px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.proj-title{font-size:16px;font-weight:650;word-break:break-all}
.proj-path{color:#6b7280;font-size:12.5px;margin-top:3px;word-break:break-all}
.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:5px;padding:8px 13px;border-radius:10px;background:#2563eb;color:#fff;font-size:13.5px;font-weight:600}
.btn.ghost{background:#eef2ff;color:#3730a3}
.btn.gray{background:#f3f4f6;color:#374151}
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:13.5px;margin:0 0 12px;color:#6b7280;word-break:break-all}
.crumbs a{padding:2px 4px;border-radius:6px}
.crumbs .sep{color:#c0c4cc}
.toolbar{display:flex;gap:8px;margin:0 0 14px;flex-wrap:wrap}
.list{padding:0;margin:0;list-style:none;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden}
.row{display:flex;align-items:center;gap:10px;padding:11px 13px;border-top:1px solid #f1f3f5}
.row:first-child{border-top:none}
.row .icon{flex:0 0 auto;font-size:17px}
.row .main{min-width:0;flex:1 1 auto}
.row .name{display:block;font-size:14.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .meta{color:#9ca3af;font-size:12px;margin-top:1px}
.row .dl{flex:0 0 auto;font-size:12.5px;padding:6px 10px;border-radius:9px;background:#f3f4f6;color:#374151;font-weight:600}
.empty{padding:26px 14px;text-align:center;color:#9ca3af;font-size:14px}
.foot{margin-top:18px;text-align:center;color:#9ca3af;font-size:12px}
@media (prefers-color-scheme:dark){
  body{background:#0f1115;color:#e5e7eb}
  .card,.list{background:#171a21;border-color:#2a2f3a}
  .row{border-top-color:#232833}
  .proj-path,.meta,.crumbs{color:#9aa3b2}
  .btn.ghost{background:#1e2748;color:#c7d2fe}
  .btn.gray,.row .dl{background:#232833;color:#d1d5db}
}`;

  function pageShell(title, body, { headOnly = false } = {}) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${htmlEscape(title)}</title><style>${CSS}</style></head>
<body>${headOnly ? '' : body}<div class="foot">dsh-pocket · 项目文件</div></body></html>`;
  }

  function renderProjects() {
    const items = readProjects();
    const body = items.length
      ? items.map((p) => `
<div class="card">
  <div class="proj-title">📁 ${htmlEscape(p.title)}</div>
  <div class="proj-path">${htmlEscape(p.path)}</div>
  <div class="actions">
    <a class="btn" href="${FILES_PREFIX}/?ws=${encodeURIComponent(p.id)}">打开</a>
    <a class="btn ghost" href="${FILES_PREFIX}/zip?ws=${encodeURIComponent(p.id)}">打包下载 ZIP</a>
  </div>
</div>`).join('')
      : '<div class="card"><div class="empty">没有找到任何项目（工作区列表为空，或路径已不存在）。</div></div>';
    return pageShell('项目文件', `<h1>📁 项目文件</h1><p class="sub">选择一个项目浏览/下载；地址可直接收藏。</p>${body}`);
  }

  function crumbs(project, rel) {
    const parts = rel ? rel.split('/') : [];
    let acc = '';
    const segs = parts.map((seg) => {
      acc = acc ? `${acc}/${seg}` : seg;
      return `<span class="sep">/</span><a href="${FILES_PREFIX}/?ws=${encodeURIComponent(project.id)}&p=${encodeURIComponent(acc)}">${htmlEscape(seg)}</a>`;
    }).join('');
    return `<div class="crumbs"><a href="${FILES_PREFIX}">📁 项目文件</a><span class="sep">/</span><a href="${FILES_PREFIX}/?ws=${encodeURIComponent(project.id)}">${htmlEscape(project.title)}</a>${segs}</div>`;
  }

  async function renderDir(project, rel) {
    const { abs } = resolveInProject(project.path, rel);
    const st = statSync(abs);
    if (!st.isDirectory()) {
      const err = new Error('not a directory | 不是目录');
      err.code = 'not-dir';
      throw err;
    }
    const entries = await listDir(abs);
    const rows = entries.map((e) => {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const href = `${FILES_PREFIX}/?ws=${encodeURIComponent(project.id)}&p=${encodeURIComponent(childRel)}`;
      if (e.isDir) {
        return `<li class="row"><span class="icon">📁</span><div class="main"><a class="name" href="${href}">${htmlEscape(e.name)}/</a><div class="meta">目录</div></div><a class="dl" href="${FILES_PREFIX}/zip?ws=${encodeURIComponent(project.id)}&p=${encodeURIComponent(childRel)}">ZIP</a></li>`;
      }
      const dl = `${FILES_PREFIX}/dl?ws=${encodeURIComponent(project.id)}&p=${encodeURIComponent(childRel)}`;
      const inlineOpen = `<a class="name" href="${dl}&inline=1" target="_blank" rel="noopener">${htmlEscape(e.name)}</a>`;
      return `<li class="row"><span class="icon">📄</span><div class="main">${inlineOpen}<div class="meta">${fmtSize(e.size)} · ${fmtDate(e.mtime)}</div></div><a class="dl" href="${dl}">下载</a></li>`;
    }).join('');
    const parentBtn = rel
      ? `<a class="btn gray" href="${FILES_PREFIX}/?ws=${encodeURIComponent(project.id)}&p=${encodeURIComponent(rel.split('/').slice(0, -1).join('/'))}">⬆ 上一级</a>`
      : '';
    const zipBtn = `<a class="btn" href="${FILES_PREFIX}/zip?ws=${encodeURIComponent(project.id)}&p=${encodeURIComponent(rel)}">⬇ 打包下载本目录</a>`;
    const list = rows ? `<ul class="list">${rows}</ul>` : '<div class="card"><div class="empty">这个目录是空的。</div></div>';
    return pageShell(`${project.title}${rel ? ` / ${rel}` : ''}`, `${crumbs(project, rel)}<div class="toolbar">${zipBtn}${parentBtn}</div>${list}`);
  }

  // ---------- 文件下载 ----------

  async function serveDownload(req, res, head, url) {
    const project = findProject(url.searchParams.get('ws'));
    if (!project) { sendText(res, 404, '项目不存在'); return; }
    const rel = normalizeRel(url.searchParams.get('p'));
    if (!rel) { sendText(res, 400, '缺少文件路径参数 p'); return; }
    const { abs } = resolveInProject(project.path, rel);
    const st = statSync(abs);
    if (st.isDirectory()) { sendText(res, 400, '这是目录，请用 zip 接口打包下载'); return; }
    const name = basename(abs);
    const type = mimeOf(name);
    const inline = url.searchParams.get('inline') === '1' && INLINE_OK.test(type);
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(st.size),
      'last-modified': st.mtime.toUTCString(),
      'cache-control': 'private, max-age=0, must-revalidate',
      'content-disposition': disposition(inline ? 'inline' : 'attachment', name),
      'x-content-type-options': 'nosniff',
    });
    if (head) { res.end(); return; }
    const stream = createReadStream(abs);
    stream.on('error', (err) => {
      log?.warn?.(`dsh-pocket: files: read failed | 读取失败 ${abs}: ${err.message}`);
      if (!res.headersSent) sendText(res, 500, '读取失败');
      else res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  // ---------- 流式 ZIP ----------

  async function collectFiles(rootAbs, relStart, all) {
    const out = [];
    let total = 0;
    async function walk(absDir, relDir) {
      let dirents;
      try {
        dirents = await readdir(absDir, { withFileTypes: true });
      } catch { return; }
      for (const d of dirents) {
        const rel = relDir ? `${relDir}/${d.name}` : d.name;
        if (!all && ZIP_SKIP.has(d.name)) continue;
        const abs = join(absDir, d.name);
        let isDir = d.isDirectory();
        let isFile = d.isFile();
        if (d.isSymbolicLink()) {
          // 符号链接：只跟踪到文件；链接目录跳过（防环）
          try {
            const st = statSync(abs);
            isDir = false;
            isFile = st.isFile();
          } catch { continue; }
        }
        if (isDir) { await walk(abs, rel); continue; }
        if (!isFile) continue;
        let st;
        try { st = statSync(abs); } catch { continue; }
        total += st.size;
        if (total > ZIP_MAX_BYTES) { const e = new Error('too large'); e.code = 'too-large'; throw e; }
        out.push({ abs, name: rel, size: st.size, mtime: st.mtimeMs });
        if (out.length > ZIP_MAX_ENTRIES) { const e = new Error('too many files'); e.code = 'too-many'; throw e; }
      }
    }
    const baseAbs = relStart ? resolveInProject(rootAbs, relStart).abs : realpathSync(rootAbs);
    const st = statSync(baseAbs);
    if (st.isFile()) {
      out.push({ abs: baseAbs, name: basename(baseAbs), size: st.size, mtime: st.mtimeMs });
      return out;
    }
    await walk(baseAbs, relStart || '');
    return out;
  }

  // CRC32（IEEE 802.3，查表实现）
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32Update(crc, buf) {
    let c = crc ^ 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(ms) {
    const d = new Date(Number.isFinite(ms) ? ms : Date.now());
    const year = Math.max(1980, d.getFullYear());
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xffff, date: date & 0xffff };
  }

  async function writeChunk(res, buf) {
    if (res.destroyed) throw new Error('client closed | 客户端已断开');
    if (res.write(buf)) return;
    await new Promise((resolve) => {
      const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
      res.once('drain', done);
      res.once('close', done);
    });
    if (res.destroyed) throw new Error('client closed | 客户端已断开');
  }

  async function serveZip(req, res, head, url) {
    const project = findProject(url.searchParams.get('ws'));
    if (!project) { sendText(res, 404, '项目不存在'); return; }
    const rel = normalizeRel(url.searchParams.get('p'));
    const all = url.searchParams.get('all') === '1';
    let entries;
    try {
      entries = await collectFiles(project.path, rel, all);
    } catch (err) {
      if (err.code === 'too-large') { sendText(res, 413, '打包内容超过 4GB，请分目录下载'); return; }
      if (err.code === 'too-many') { sendText(res, 413, '文件数量过多（超过 60000 个），请分目录下载'); return; }
      if (err.code === 'not-found') { sendText(res, 404, '目录不存在'); return; }
      throw err;
    }
    if (!entries.length) { sendText(res, 404, '该目录没有可打包的文件'); return; }
    const zipName = `${basename(rel) || project.title || 'files'}.zip`;
    res.writeHead(200, {
      'content-type': 'application/zip',
      'cache-control': 'no-store',
      'content-disposition': disposition('attachment', zipName),
    });
    if (head) { res.end(); return; }
    const central = [];
    let offset = 0;
    try {
      for (const e of entries) {
        const nameBuf = Buffer.from(e.name, 'utf8');
        const { time, date } = dosDateTime(e.mtime);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);      // version needed
        local.writeUInt16LE(0x0808, 6);  // bit 3 data descriptor + bit 11 UTF-8 文件名
        local.writeUInt16LE(0, 8);       // method: store
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(0, 14);      // crc (deferred)
        local.writeUInt32LE(0, 18);      // csize
        local.writeUInt32LE(0, 22);      // usize
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        const localOffset = offset;
        await writeChunk(res, local);
        await writeChunk(res, nameBuf);
        offset += local.length + nameBuf.length;
        let crc = 0;
        let size = 0;
        const stream = createReadStream(e.abs);
        for await (const chunk of stream) {
          crc = crc32Update(crc, chunk);
          size += chunk.length;
          offset += chunk.length;
          await writeChunk(res, chunk);
        }
        const desc = Buffer.alloc(16);
        desc.writeUInt32LE(0x08074b50, 0);
        desc.writeUInt32LE(crc, 4);
        desc.writeUInt32LE(size, 8);
        desc.writeUInt32LE(size, 12);
        await writeChunk(res, desc);
        offset += 16;
        central.push({ nameBuf, crc, size, time, date, localOffset });
      }
      const centralStart = offset;
      let centralSize = 0;
      for (const c of central) {
        const rec = Buffer.alloc(46);
        rec.writeUInt32LE(0x02014b50, 0);
        rec.writeUInt16LE(20, 4);
        rec.writeUInt16LE(20, 6);
        rec.writeUInt16LE(0x0808, 8);
        rec.writeUInt16LE(0, 10);
        rec.writeUInt16LE(c.time, 12);
        rec.writeUInt16LE(c.date, 14);
        rec.writeUInt32LE(c.crc, 16);
        rec.writeUInt32LE(c.size, 20);
        rec.writeUInt32LE(c.size, 24);
        rec.writeUInt16LE(c.nameBuf.length, 28);
        rec.writeUInt16LE(0, 30);
        rec.writeUInt16LE(0, 32);
        rec.writeUInt16LE(0, 34);
        rec.writeUInt16LE(0, 36);
        rec.writeUInt32LE(0, 38);
        rec.writeUInt32LE(c.localOffset, 42);
        centralSize += rec.length + c.nameBuf.length;
      }
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(0, 4);
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(central.length, 8);
      eocd.writeUInt16LE(central.length, 10);
      eocd.writeUInt32LE(centralSize, 12);
      eocd.writeUInt32LE(centralStart, 16);
      eocd.writeUInt16LE(0, 20);
      // central directory 记录统一在最后写（数据部分已经流式发完）
      for (const c of central) {
        const rec = Buffer.alloc(46);
        rec.writeUInt32LE(0x02014b50, 0);
        rec.writeUInt16LE(20, 4);
        rec.writeUInt16LE(20, 6);
        rec.writeUInt16LE(0x0808, 8);
        rec.writeUInt16LE(0, 10);
        rec.writeUInt16LE(c.time, 12);
        rec.writeUInt16LE(c.date, 14);
        rec.writeUInt32LE(c.crc, 16);
        rec.writeUInt32LE(c.size, 20);
        rec.writeUInt32LE(c.size, 24);
        rec.writeUInt16LE(c.nameBuf.length, 28);
        rec.writeUInt16LE(0, 30);
        rec.writeUInt16LE(0, 32);
        rec.writeUInt16LE(0, 34);
        rec.writeUInt16LE(0, 36);
        rec.writeUInt32LE(0, 38);
        rec.writeUInt32LE(c.localOffset, 42);
        await writeChunk(res, rec);
        await writeChunk(res, c.nameBuf);
      }
      await writeChunk(res, eocd);
      res.end();
    } catch (err) {
      log?.warn?.(`dsh-pocket: files: zip aborted | 打包中止：${err.message}`);
      res.destroy();
    }
  }

  // ---------- 入口 ----------

  return {
    handle(req, res) {
      let url;
      try {
        url = new URL(req.url ?? '/', 'http://pocket.local');
      } catch {
        return false;
      }
      const pathname = url.pathname;
      if (pathname !== FILES_PREFIX && !pathname.startsWith(`${FILES_PREFIX}/`)) return false;
      const sub = pathname.slice(FILES_PREFIX.length) || '/';
      const head = req.method === 'HEAD';
      if (req.method !== 'GET' && !head) {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
        res.end('method not allowed');
        return true;
      }
      if (!enabled()) {
        sendText(res, 403, '项目文件浏览已在设置中关闭');
        return true;
      }
      try {
        if (sub === '/' || sub === '') {
          const ws = url.searchParams.get('ws');
          if (!ws) {
            sendHtml(res, renderProjects(), head);
            return true;
          }
          const project = findProject(ws);
          if (!project) { sendText(res, 404, '项目不存在'); return true; }
          const rel = normalizeRel(url.searchParams.get('p'));
          // 异步渲染：先占位，出错再替换（渲染很快，直接 await 也可以，但 handle 是同步接口）
          renderDir(project, rel).then((html) => {
            if (!res.writableEnded && !res.destroyed) sendHtml(res, html, head);
          }).catch((err) => {
            if (res.headersSent || res.destroyed) return;
            if (err.code === 'not-found') sendText(res, 404, '目录不存在');
            else if (err.code === 'not-dir') sendText(res, 400, '该路径不是目录，请用下载接口');
            else if (/路径越界/.test(err.message)) sendText(res, 400, '非法路径');
            else { log?.warn?.(`dsh-pocket: files: render failed | 渲染失败：${err.message}`); sendText(res, 500, '打开失败'); }
          });
          return true;
        }
        if (sub === '/api/projects') {
          sendJson(res, 200, { projects: readProjects().map(({ id, title, path }) => ({ id, title, path })) });
          return true;
        }
        if (sub === '/api/list') {
          const project = findProject(url.searchParams.get('ws'));
          if (!project) { sendJson(res, 404, { error: 'project-not-found' }); return true; }
          const rel = normalizeRel(url.searchParams.get('p'));
          listDir(resolveInProject(project.path, rel).abs, project, rel).then((entries) => {
            if (!res.writableEnded && !res.destroyed) sendJson(res, 200, { project: { id: project.id, title: project.title }, path: rel, entries });
          }).catch((err) => {
            if (res.headersSent || res.destroyed) return;
            sendJson(res, err.code === 'not-found' ? 404 : 400, { error: err.code ?? 'bad-path' });
          });
          return true;
        }
        if (sub === '/dl') {
          serveDownload(req, res, head, url).catch((err) => {
            if (res.headersSent || res.destroyed) return;
            if (err.code === 'not-found') sendText(res, 404, '文件不存在');
            else if (/路径越界/.test(err.message)) sendText(res, 400, '非法路径');
            else { log?.warn?.(`dsh-pocket: files: download failed | 下载失败：${err.message}`); sendText(res, 500, '下载失败'); }
          });
          return true;
        }
        if (sub === '/zip') {
          serveZip(req, res, head, url).catch((err) => {
            if (res.headersSent || res.destroyed) return;
            if (err.code === 'not-found') sendText(res, 404, '目录不存在');
            else if (/路径越界/.test(err.message)) sendText(res, 400, '非法路径');
            else { log?.warn?.(`dsh-pocket: files: zip failed | 打包失败：${err.message}`); sendText(res, 500, '打包失败'); }
          });
          return true;
        }
        sendText(res, 404, '未知的文件浏览路径');
        return true;
      } catch (err) {
        if (!res.headersSent && !res.destroyed) {
          if (/路径越界/.test(err?.message)) sendText(res, 400, '非法路径');
          else if (err?.code === 'not-found') sendText(res, 404, '不存在');
          else { log?.warn?.(`dsh-pocket: files: request failed | 请求失败：${err?.message}`); sendText(res, 500, '出错了'); }
        }
        return true;
      }
    },
  };
}

/** 目录内容（排序：目录在前，然后按名称）。 */
async function listDir(abs, project = null, rel = null) {
  const dirents = await readdir(abs, { withFileTypes: true });
  const items = [];
  for (const d of dirents) {
    const full = join(abs, d.name);
    let st;
    try { st = statSync(full); } catch { continue; }
    const isDir = d.isDirectory() || (d.isSymbolicLink() && st.isDirectory());
    items.push({ name: d.name, isDir, size: isDir ? 0 : st.size, mtime: st.mtimeMs });
  }
  items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-CN') : a.isDir ? -1 : 1));
  if (project != null && rel != null) {
    // API 里补上可直接使用的相对路径，方便脚本调用方拼接
    for (const it of items) it.path = rel ? `${rel}/${it.name}` : it.name;
  }
  return items;
}

/**
 * 注入到 dsh web 页面的悬浮入口（仅手机宽度、且不在文件页内时显示）。
 * 桌面端不显示，避免干扰；用户也可以直接访问 <公网地址>/pocket-files。
 */
export function pocketFilesEntryScript() {
  const js = `(function(){try{var d=document;if(location.pathname.indexOf('${FILES_PREFIX}')===0)return;`
    + `if(!(window.matchMedia&&matchMedia('(max-width: 1023px)').matches))return;`
    + `var add=function(){if(!d.body||d.querySelector('[data-dsh-pocket-files-entry]'))return;`
    + `var a=d.createElement('a');a.href='${FILES_PREFIX}';a.textContent='📁 项目文件';`
    + `a.setAttribute('data-dsh-pocket-files-entry','1');`
    + `a.style.cssText='position:fixed;right:14px;bottom:88px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border-radius:999px;background:rgba(17,24,39,.9);color:#fff;font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;text-decoration:none;box-shadow:0 6px 18px rgba(0,0,0,.28);-webkit-tap-highlight-color:transparent;opacity:.94';`
    + `d.body.appendChild(a);};`
    + `if(d.readyState==='loading')d.addEventListener('DOMContentLoaded',add);else add();`
    + `}catch(e){}})();`;
  return `<script data-dsh-pocket-files-entry="1">${js}</script>`;
}
