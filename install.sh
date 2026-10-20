#!/usr/bin/env bash
# dsh-pocket（Solium 分支）macOS / Linux 一键安装
# 用法：
#   curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/335589054/Solium-s-Pocket-DSH/main/install.sh | bash
# 可选环境变量：DSH_POCKET_PROFILE=web|desktop（默认 web）、DSH_HOME（默认 ~/.dsh）
set -euo pipefail

repo="335589054/Solium-s-Pocket-DSH"
profile="${DSH_POCKET_PROFILE:-web}"
dsh_home="${DSH_HOME:-$HOME/.dsh}"
profile_dir="$dsh_home/profiles/$profile"
dest="$profile_dir/node_modules/dsh-pocket"

[ -d "$profile_dir" ] || { echo "未找到 profile 目录：$profile_dir"; exit 1; }

# 1) 尚未注册 dsh-pocket 时，先用官方 CLI 装一份（让 DSH 能加载插件）
if ! grep -q '"dsh-pocket"' "$profile_dir/package.json" 2>/dev/null; then
  if command -v dsh >/dev/null 2>&1; then
    echo "首次安装：向 profile '$profile' 注册 dsh-pocket ..."
    dsh plugin --profile "$profile" add dsh-pocket -w || true
  else
    echo "警告：profile 未注册 dsh-pocket 且找不到 dsh CLI，请先在插件市场安装 dsh-pocket。"
  fi
fi

# 2) 下载 Solium 分支源码（直连失败自动走 gh-proxy 镜像）
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for u in \
  "https://github.com/$repo/archive/refs/heads/main.zip" \
  "https://gh-proxy.com/https://github.com/$repo/archive/refs/heads/main.zip" \
  "https://gh-proxy.org/https://github.com/$repo/archive/refs/heads/main.zip"; do
  echo "下载 $u"
  if curl -fsSL --max-time 180 -o "$tmp/repo.zip" "$u"; then break; fi
done
[ -f "$tmp/repo.zip" ] || { echo "下载失败：请检查网络"; exit 1; }

if command -v unzip >/dev/null 2>&1; then
  unzip -q "$tmp/repo.zip" -d "$tmp"
else
  python3 - "$tmp/repo.zip" "$tmp" <<'PY'
import sys, zipfile
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PY
fi

src="$tmp/$repo-main"
[ -d "$src" ] || src="$tmp/Solium-s-Pocket-DSH-main"
[ -f "$src/lib/files.mjs" ] || { echo "压缩包内容异常：缺少 lib/files.mjs"; exit 1; }

# 3) 替换插件目录（不碰 $DSH_HOME/dsh-pocket/settings.json 等用户数据）
rm -rf "$dest"
mv "$src" "$dest"

echo ""
echo "✔ dsh-pocket（Solium 分支，含项目文件公网访问）已安装到："
echo "  $dest"
echo "  重启 dsh web 后生效。入口：<地址>/pocket-files"
