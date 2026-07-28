# install.ps1
# 把本 fork 修改的文件复制到 CodexBridge 安装目录
# 用法：在 PowerShell 里 cd 到本仓库根目录，然后执行：
#   .\install.ps1
# 或者指定安装目录：
#   .\install.ps1 -InstallDir "C:\path\to\CodexBridge\resources\app"

param(
    [string]$InstallDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── 1. 找安装目录 ──────────────────────────────────────────────────────────────
if (-not $InstallDir) {
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\codex-bridge\resources\app",
        "$env:LOCALAPPDATA\Programs\CodexBridge\resources\app",
        "$env:ProgramFiles\codex-bridge\resources\app",
        "$env:ProgramFiles\CodexBridge\resources\app"
    )
    foreach ($c in $candidates) {
        if (Test-Path "$c\package.json") {
            $InstallDir = $c
            break
        }
    }
}

if (-not $InstallDir -or -not (Test-Path "$InstallDir\package.json")) {
    Write-Host ""
    Write-Host "ERROR: 找不到 CodexBridge 安装目录。" -ForegroundColor Red
    Write-Host ""
    Write-Host "请手动指定安装目录，例如：" -ForegroundColor Yellow
    Write-Host '  .\install.ps1 -InstallDir "C:\Users\你的用户名\AppData\Local\Programs\codex-bridge\resources\app"' -ForegroundColor Yellow
    Write-Host ""
    Write-Host "安装目录的特征：里面有 package.json、src\、desktop\ 这些文件夹。" -ForegroundColor Cyan
    exit 1
}

# 检查版本
$pkgJson = Get-Content "$InstallDir\package.json" -Raw | ConvertFrom-Json
$installedVersion = $pkgJson.version
if ($installedVersion -ne "0.3.13") {
    Write-Host ""
    Write-Host "WARNING: 检测到安装版本是 $installedVersion，本 fork 基于 0.3.13 开发。" -ForegroundColor Yellow
    Write-Host "         版本不一致可能导致问题，建议先用 0.3.13 版本再继续。" -ForegroundColor Yellow
    $confirm = Read-Host "仍要继续安装？(y/N)"
    if ($confirm -notmatch "^[yY]$") { exit 0 }
}

Write-Host ""
Write-Host "安装目录：$InstallDir" -ForegroundColor Cyan
Write-Host "CodexBridge 版本：$installedVersion" -ForegroundColor Cyan

# ── 2. 备份原始文件 ────────────────────────────────────────────────────────────
$backupDir = "$InstallDir\.fork-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

$filesToPatch = @(
    "src\claude-messages.js",
    "src\upstream.js",
    "src\adapter-profile.js",
    "src\config.js",
    "src\route-snapshot.js",
    "desktop\settings.mjs",
    "desktop\config-import-validation.mjs",
    "desktop\main.cjs",
    "desktop\preload.cjs",
    "desktop\renderer\app.js",
    "desktop\renderer\index.html"
)

Write-Host ""
Write-Host "正在备份原始文件到：$backupDir" -ForegroundColor Green
foreach ($f in $filesToPatch) {
    $src = "$InstallDir\$f"
    $dst = "$backupDir\$f"
    if (Test-Path $src) {
        New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null
        Copy-Item $src $dst
        Write-Host "  备份: $f" -ForegroundColor DarkGray
    }
}

# ── 3. 复制修改后的文件 ────────────────────────────────────────────────────────
$repoRoot = $PSScriptRoot
Write-Host ""
Write-Host "正在复制文件..." -ForegroundColor Green
foreach ($f in $filesToPatch) {
    $srcFile = "$repoRoot\$f"
    $dstFile = "$InstallDir\$f"
    if (-not (Test-Path $srcFile)) {
        Write-Host "  SKIP (源文件不存在): $f" -ForegroundColor Yellow
        continue
    }
    New-Item -ItemType Directory -Path (Split-Path $dstFile) -Force | Out-Null
    Copy-Item $srcFile $dstFile -Force
    Write-Host "  复制: $f" -ForegroundColor Cyan
}

# ── 4. 完成 ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "安装完成！" -ForegroundColor Green
Write-Host "请重启 CodexBridge（完全退出后重新打开）使修改生效。" -ForegroundColor Green
Write-Host ""
Write-Host "如需回滚，可以把 $backupDir 里的文件复制回对应位置。" -ForegroundColor DarkGray
