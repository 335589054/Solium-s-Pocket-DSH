# dsh-pocket（Solium 分支）Windows 一键安装
# 用法（PowerShell）：
#   irm https://gh-proxy.com/https://raw.githubusercontent.com/335589054/Solium-s-Pocket-DSH/main/install.ps1 | iex
# 可选环境变量：DSH_POCKET_PROFILE=desktop|web（默认 desktop）、DSH_HOME（默认 %USERPROFILE%\.dsh）
$ErrorActionPreference = 'Stop'
$repo    = '335589054/Solium-s-Pocket-DSH'
$profile = if ($env:DSH_POCKET_PROFILE) { $env:DSH_POCKET_PROFILE } else { 'desktop' }
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$profile"
$dest    = Join-Path $profileDir 'node_modules\dsh-pocket'
$pkgJson = Join-Path $profileDir 'package.json'

if (-not (Test-Path $profileDir)) {
  throw "未找到 profile 目录：$profileDir（可用 DSH_POCKET_PROFILE 指定 desktop/web）"
}

# 1) 若 profile 尚未注册 dsh-pocket 依赖，先用官方 CLI 装一份（让 DSH 能加载插件）
$registered = (Test-Path $pkgJson) -and ((Get-Content $pkgJson -Raw) -match '"dsh-pocket"\s*:')
if (-not $registered) {
  $dshCmd = (Get-Command dsh.cmd -ErrorAction SilentlyContinue).Source
  if (-not $dshCmd) {
    $dshCmd = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  }
  if (-not (Test-Path $dshCmd)) {
    throw "profile 未注册 dsh-pocket，且找不到 dsh CLI。请先在 DSH 插件市场安装 dsh-pocket 后再运行本脚本。"
  }
  Write-Host "首次安装：向 profile '$profile' 注册 dsh-pocket ..."
  & $dshCmd plugin --profile $profile add dsh-pocket -w
}

# 2) 下载 Solium 分支源码（GitHub 直连失败时自动走 gh-proxy 镜像）
$tmp = Join-Path $env:TEMP ('dsh-pocket-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp 'repo.zip'
$urls = @(
  "https://github.com/$repo/archive/refs/heads/main.zip",
  "https://gh-proxy.com/https://github.com/$repo/archive/refs/heads/main.zip",
  "https://gh-proxy.org/https://github.com/$repo/archive/refs/heads/main.zip"
)
$ok = $false
foreach ($u in $urls) {
  try {
    Write-Host "下载 $u"
    Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $zip -TimeoutSec 180
    $ok = $true; break
  } catch { Write-Host "  失败：$($_.Exception.Message)" }
}
if (-not $ok) { throw '下载失败：请检查网络，或手动克隆 https://github.com/335589054/Solium-s-Pocket-DSH' }

Expand-Archive -Path $zip -DestinationPath $tmp -Force
$src = Join-Path $tmp 'Solium-s-Pocket-DSH-main'
if (-not (Test-Path (Join-Path $src 'lib\files.mjs'))) { throw '压缩包内容异常：缺少 lib/files.mjs' }

# 3) 替换插件目录（不碰 $DSH_HOME/dsh-pocket/settings.json 等用户数据）
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Move-Item $src $dest
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "✔ dsh-pocket（Solium 分支，含项目文件公网访问）已安装到："
Write-Host "  $dest"
Write-Host '  重启 DSH Desktop / dsh web 后生效。'
Write-Host '  入口：设置页「手机访问」开启公网后，访问 <地址>/pocket-files'
