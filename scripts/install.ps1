<#
.SYNOPSIS
dsh-browser 安装（Windows）：从本地 checkout 构建并安装。
dsh-browser installer (Windows): build and install from a local checkout.

.DESCRIPTION
扩展可自动发现本机地址；启动 Host 后在仓库运行 pnpm run pair:browser 获取一次性配对码。
The local address is discovered automatically; run pnpm run pair:browser after starting the Host.

这是 scripts/install.sh 的 Windows 对应版本。
This is the Windows counterpart of scripts/install.sh.
#>
# This file is UTF-8 with a BOM on purpose: Windows PowerShell 5.1 decodes a BOM-less script
# with the machine's ANSI codepage and turns every Chinese line into mojibake.
$ErrorActionPreference = 'Stop'
# Invoke-WebRequest is an order of magnitude slower in Windows PowerShell while it draws a progress bar.
$ProgressPreference = 'SilentlyContinue'

# Windows PowerShell picks the console codepage, which turns the Chinese half of every
# message into question marks on a non-Chinese install.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

$DshHomeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$LegacyPlugins = @('@yuxianglin/dsh-bridge-browser', '@deepseek-ai/dsh-bridge-browser')
$BridgePlugin = '@eilyeee/dsh-stride-browser-bridge'

function Write-Step {
  param([int]$Number, [string]$Zh, [string]$En)
  Write-Host ''
  Write-Host ("[{0}/4] {1}" -f $Number, $Zh)
  Write-Host ("      {0}" -f $En)
}

function Write-Pair {
  param([string]$Zh, [string]$En)
  Write-Host $Zh
  Write-Host ("   {0}" -f $En)
}

function Stop-Install {
  param([string]$Zh, [string]$En)
  Write-Host ''
  [Console]::Error.WriteLine("错误：$Zh")
  [Console]::Error.WriteLine("Error: $En")
  exit 1
}

function Test-Workspace {
  param([string]$Candidate)

  if (-not $Candidate) { return $false }
  foreach ($relative in @(
      'package.json',
      'pnpm-lock.yaml',
      'extensions\dsh-browser\package.json',
      'packages\browser\bridge-browser\package.json',
      'scripts\install.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Candidate $relative) -PathType Leaf)) { return $false }
  }
  return $true
}

function Get-WorkspaceRoot {
  # A complete local checkout is required.
  if (-not $PSScriptRoot) { return $null }
  $candidate = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
  if (Test-Workspace $candidate) { return $candidate }
  return $null
}

function Test-Command {
  param([string]$Name)
  return [bool](Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

function Assert-Command {
  param([string]$Name, [string]$Zh, [string]$En)
  if (-not (Test-Command $Name)) { Stop-Install $Zh $En }
}

function Test-ExcludedPath {
  param([string]$RelativePath, [hashtable]$Excluded)

  foreach ($segment in $RelativePath.Split([char]'\', [char]'/')) {
    if ($segment -and $Excluded.ContainsKey($segment)) { return $true }
  }
  return $false
}

function Get-SyncEntry {
  <#
    Walk $Root breadth-first without ever descending into an excluded directory, so a
    node_modules tree costs nothing instead of dominating the walk.
  #>
  param([string]$Root, [hashtable]$Excluded)

  $entries = New-Object System.Collections.Generic.List[object]
  $pending = New-Object System.Collections.Generic.Queue[string]
  $pending.Enqueue('')

  while ($pending.Count -gt 0) {
    $relativeDir = $pending.Dequeue()
    $absoluteDir = if ($relativeDir) { Join-Path $Root $relativeDir } else { $Root }
    foreach ($child in @(Get-ChildItem -LiteralPath $absoluteDir -Force)) {
      if ($Excluded.ContainsKey($child.Name)) { continue }
      $relative = if ($relativeDir) { Join-Path $relativeDir $child.Name } else { $child.Name }
      $entries.Add([pscustomobject]@{ Relative = $relative; Item = $child })
      if ($child.PSIsContainer) { $pending.Enqueue($relative) }
    }
  }
  return $entries
}

function Sync-Directory {
  <#
    The `rsync -a --delete-after` the Unix installer relies on: copy everything across first,
    then drop whatever the source no longer has. Excluded names are skipped on both sides, so
    node_modules and the managed marker survive the purge instead of being treated as extra.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string[]]$ExcludeName = @()
  )

  $sourceRoot = (Resolve-Path -LiteralPath $Source).ProviderPath.TrimEnd('\')
  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  }
  $destinationRoot = (Resolve-Path -LiteralPath $Destination).ProviderPath.TrimEnd('\')

  $excluded = @{}
  foreach ($name in $ExcludeName) { $excluded[$name] = $true }

  $keep = @{}
  foreach ($entry in @(Get-SyncEntry -Root $sourceRoot -Excluded $excluded)) {
    $keep[$entry.Relative] = $true
    $target = Join-Path $destinationRoot $entry.Relative
    if ($entry.Item.PSIsContainer) {
      if (-not (Test-Path -LiteralPath $target -PathType Container)) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
      }
      continue
    }
    $existing = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    if ($existing -and -not $existing.PSIsContainer -and
        $existing.Length -eq $entry.Item.Length -and
        $existing.LastWriteTimeUtc -eq $entry.Item.LastWriteTimeUtc) {
      continue
    }
    $parent = Split-Path -Parent $target
    if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item -LiteralPath $entry.Item.FullName -Destination $target -Force
  }

  $stale = @(Get-SyncEntry -Root $destinationRoot -Excluded $excluded |
    Where-Object { -not $keep.ContainsKey($_.Relative) })
  # Deepest first: removing a child before its parent keeps Remove-Item off already-gone paths.
  foreach ($entry in @($stale | Sort-Object { $_.Relative.Length } -Descending)) {
    if (Test-Path -LiteralPath $entry.Item.FullName) {
      Remove-Item -LiteralPath $entry.Item.FullName -Recurse -Force
    }
  }
}

function Test-ProfileDependency {
  param([string]$Manifest, [string]$PackageName)

  if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) { return $false }
  try {
    $parsed = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $false
  }
  if ($null -eq $parsed -or $null -eq $parsed.dependencies) { return $false }
  return [bool]($parsed.dependencies.PSObject.Properties.Name -contains $PackageName)
}

function Get-BrowserPath {
  <# Echoes the path to a local Chrome/Chromium executable, or $null when none is installed. #>
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if (-not $base) { continue }
    $candidates.Add((Join-Path $base 'Google\Chrome\Application\chrome.exe'))
    $candidates.Add((Join-Path $base 'Google\Chrome SxS\Application\chrome.exe'))
    $candidates.Add((Join-Path $base 'Chromium\Application\chrome.exe'))
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }

  # Fallback: a browser installed outside those roots still registers an App Paths entry.
  foreach ($hive in @('HKLM:', 'HKCU:')) {
    foreach ($exe in @('chrome.exe', 'chromium.exe')) {
      $key = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe"
      try {
        $registered = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).'(default)'
      } catch {
        continue
      }
      if ($registered -and (Test-Path -LiteralPath $registered -PathType Leaf)) { return $registered }
    }
  }
  return $null
}

function Start-ExtensionsPage {
  param([string]$BrowserPath)

  if (-not $BrowserPath) { return $false }
  try {
    # Start-Process returns as soon as the browser is launched, so the instructions below
    # print immediately even on a first run that opens a brand new window.
    Start-Process -FilePath $BrowserPath -ArgumentList 'chrome://extensions' | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Set-ClipboardText {
  param([string]$Text)

  try {
    Set-Clipboard -Value $Text -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Write-BrowserInstallHint {
  if (Test-Command 'winget') {
    Write-Pair "请手动安装：winget install --id Google.Chrome --exact" "Install it manually: winget install --id Google.Chrome --exact"
  } else {
    Write-Pair "请手动安装 Google Chrome：https://www.google.com/chrome/" "Install Google Chrome manually: https://www.google.com/chrome/"
  }
}

function Install-Browser {
  if (-not (Test-Command 'winget')) {
    Write-Pair "未找到 winget，无法自动安装。" "winget was not found, so the browser cannot be installed automatically."
    Write-BrowserInstallHint
    return
  }
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & winget install --id Google.Chrome --exact --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
  } catch {
    Write-Pair "自动安装过程中出错。" "The automatic installation reported an error."
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Confirm-Browser {
  if (Get-BrowserPath) { return $true }

  Write-Pair "未检测到 Chrome/Chromium 浏览器。" "No Chrome/Chromium browser was detected."

  # Installing a browser is a surprising side effect for a one-line installer, so it stays
  # opt-in, exactly as scripts/install.sh does on Linux and macOS.
  if ($env:DSH_INSTALL_BROWSER -ne '1') {
    Write-BrowserInstallHint
    Write-Pair "安装后重新运行本脚本；或设置 DSH_INSTALL_BROWSER=1 让脚本尝试自动安装。" "Install it and rerun this script, or set DSH_INSTALL_BROWSER=1 to let the installer attempt it."
    return $false
  }

  Write-Pair "DSH_INSTALL_BROWSER=1，尝试自动安装……" "DSH_INSTALL_BROWSER=1 is set; attempting to install…"
  Install-Browser

  if (Get-BrowserPath) { return $true }
  Write-Pair "自动安装未完成，本次安装会继续，但需要你手动安装浏览器后再加载扩展。" "Automatic browser installation did not complete; continuing, but install a browser manually before loading the extension."
  return $false
}

function Invoke-Quiet {
  <# Run a build/registration command silently, and surface its output only when it fails. #>
  param(
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailZh,
    [Parameter(Mandatory = $true)][string]$FailEn
  )

  Push-Location -LiteralPath $WorkingDirectory
  # PowerShell 7.3+ turns a native command's stderr into a terminating error while
  # $ErrorActionPreference is Stop; a non-zero exit code is the signal we actually want.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $code = $null
  try {
    $output = & $Command @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
    Pop-Location
  }
  if ($code -ne 0) {
    foreach ($line in @($output)) { Write-Host $line }
    Stop-Install $FailZh $FailEn
  }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Stop-Install "install.ps1 仅用于 Windows；macOS 与 Linux 请运行 scripts/install.sh。" "install.ps1 is for Windows only; run scripts/install.sh on macOS and Linux."
}

$Root = Get-WorkspaceRoot
if (-not $Root) { Stop-Install "请从 DSH Stride 的完整源码目录运行 scripts/install.ps1。" "Run scripts/install.ps1 from a complete DSH Stride checkout." }

$Ext = Join-Path $Root 'extensions\dsh-browser'
$Plugin = Join-Path $Root 'packages\browser\bridge-browser'
$WebProfileDir = Join-Path $DshHomeDir 'profiles\web'
$WebProfileManifest = Join-Path $DshHomeDir 'profiles\web\package.json'
$DshCli = Join-Path $Root 'node_modules\@deepseek-ai\dsh\lib\bin.js'

Assert-Command 'pnpm' "未找到 pnpm；请先启用 Corepack 或安装 pnpm。" "pnpm was not found; enable Corepack or install pnpm first."
Assert-Command 'node' "未找到 Node.js；请先安装受支持的 Node.js 版本。" "Node.js was not found; install a supported Node.js version first."

Write-Step 1 "构建浏览器桥" "Build the browser bridge"
Invoke-Quiet -WorkingDirectory $Root -Command 'pnpm' -Arguments @('install', '--frozen-lockfile') `
  -FailZh "依赖安装失败。" -FailEn "Dependency installation failed."
Invoke-Quiet -WorkingDirectory $Root -Command 'pnpm' -Arguments @('--filter', $BridgePlugin, 'run', 'build') `
  -FailZh "桥插件构建失败。" -FailEn "The bridge plugin build failed."

Write-Step 2 "注册到本机 web profile" "Register with the local web profile"
# Initialize through dsh without forwarding a package path through cmd.exe.
if (-not (Test-Path -LiteralPath $WebProfileManifest -PathType Leaf)) {
  Invoke-Quiet -WorkingDirectory $Root -Command 'node' `
    -Arguments @($DshCli, 'plugin', '--profile', 'web', 'install') `
    -FailZh "初始化 web profile 失败。" -FailEn "Initializing the web profile failed."
}

# A profile-local junction keeps the link spec free of absolute Windows paths.
# This avoids cmd.exe splitting a checkout path that contains spaces.
$ProfileSourceLink = Join-Path $WebProfileDir '.dsh-browser-source'
$DesiredTarget = (Resolve-Path -LiteralPath $Plugin).ProviderPath
if (Test-Path -LiteralPath $ProfileSourceLink) {
  $SourceItem = Get-Item -LiteralPath $ProfileSourceLink -Force
  if (-not ($SourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    Stop-Install `
      "$ProfileSourceLink 已存在且不是目录联接；请移动该路径后重试。" `
      "$ProfileSourceLink exists and is not a directory junction; move it and retry."
  }
  $ExistingTarget = [System.IO.Path]::GetFullPath([string]$SourceItem.Target)
  if ($ExistingTarget -ne $DesiredTarget) {
    Remove-Item -LiteralPath $ProfileSourceLink -Force
    New-Item -ItemType Junction -Path $ProfileSourceLink -Target $DesiredTarget | Out-Null
  }
} else {
  New-Item -ItemType Junction -Path $ProfileSourceLink -Target $DesiredTarget | Out-Null
}

Invoke-Quiet -WorkingDirectory $WebProfileDir -Command 'pnpm' `
  -Arguments @('add', '-w', 'link:./.dsh-browser-source') `
  -FailZh "注册桥插件失败。" -FailEn "Registering the bridge plugin failed."

foreach ($LegacyPlugin in $LegacyPlugins) {
  if (Test-ProfileDependency -Manifest $WebProfileManifest -PackageName $LegacyPlugin) {
    Invoke-Quiet -WorkingDirectory $WebProfileDir -Command 'pnpm' `
      -Arguments @('remove', '-w', $LegacyPlugin) `
      -FailZh "移除旧插件失败。" -FailEn "Removing the legacy plugin failed."
  }
}

# The direct pnpm registration above bypasses dsh's bundle-roster update.
$ProfileManifest = Get-Content -LiteralPath $WebProfileManifest -Raw -Encoding UTF8 | ConvertFrom-Json
$Bundles = @($ProfileManifest.dsh.profile.bundles) | Where-Object { $_ -and $_ -ne $BridgePlugin -and $_ -notin $LegacyPlugins } | Select-Object -Unique
$Bundles = @($Bundles)
if ($Bundles -notcontains $BridgePlugin) { $Bundles += $BridgePlugin }
$ProfileManifest.dsh.profile.bundles = $Bundles
$ProfileJson = ($ProfileManifest | ConvertTo-Json -Depth 20) + "`n"
[System.IO.File]::WriteAllText(
  $WebProfileManifest,
  $ProfileJson,
  (New-Object System.Text.UTF8Encoding $false))

Write-Step 3 "构建 Chrome 扩展" "Build the Chrome extension"
Invoke-Quiet -WorkingDirectory $Root -Command 'pnpm' -Arguments @('--filter', 'dsh-browser-extension', 'run', 'build') `
  -FailZh "扩展构建失败。" -FailEn "The extension build failed."

Write-Step 4 "准备扩展并打开 Chrome" "Prepare the extension and open Chrome"
Confirm-Browser | Out-Null
$DistDir = Join-Path $DshHomeDir 'browser-extension'
$IsUpdate = Test-Path -LiteralPath (Join-Path $DistDir 'manifest.json') -PathType Leaf
New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
Sync-Directory -Source (Join-Path $Ext 'dist') -Destination $DistDir

$ClipboardReady = Set-ClipboardText $DistDir
$ChromeOpened = Start-ExtensionsPage (Get-BrowserPath)

Write-Host ''
if (-not $ChromeOpened) {
  Write-Pair "无法自动打开 Chrome，请手动打开浏览器并在地址栏输入 chrome://extensions。" "Could not open Chrome automatically; open the browser and type chrome://extensions in the address bar."
}
# PowerShell treats the typographic quotes “ ” as string delimiters, so every message that
# contains them has to use single-quoted literals or it splits into extra arguments.
if ($IsUpdate) {
  Write-Pair "检测到已有扩展目录，文件已安全更新。" "Existing extension directory detected; its files were updated safely."
  Write-Pair "打开 Google Chrome（注意不是 Edge/Firefox）：" "Open Google Chrome (not Edge/Firefox):"
  Write-Host ''
  Write-Pair "    地址栏输入 chrome://extensions" "    Type chrome://extensions in the address bar"
  Write-Host ''
  Write-Pair '如果页面上已有“dsh 浏览器助手”卡片：' 'If the “dsh Browser Assistant” card is already listed:'
  Write-Pair '  点击卡片上的“重新加载”按钮，让扩展加载新文件。' '  Click “Reload” on that card so it picks up the updated files.'
  Write-Host ''
  Write-Pair "如果没有该卡片（例如从未加载过）：" "If the card is not listed (e.g. it was never loaded):"
  Write-Pair '  打开右上角 “开发者模式”' '  Enable “Developer mode” in the upper-right corner'
  Write-Pair '  点左上角 “加载已解压的扩展程序”' '  Click “Load unpacked” in the upper-left corner'
  Write-Pair "  选择这个目录：" "  Select this directory:"
  Write-Host ("   {0}" -f $DistDir)
  Write-Host ''
  Write-Pair '出现 “dsh 浏览器助手” 卡片即成功。' 'When the “dsh Browser Assistant” card appears, it is loaded.'
} else {
  if ($ChromeOpened) {
    Write-Pair "Chrome 扩展管理页已打开，请完成以下操作：" "Chrome Extensions is open. Complete these steps:"
  } else {
    Write-Pair "请在 Chrome 扩展管理页完成以下操作：" "Complete these steps on the Chrome Extensions page:"
  }
  Write-Host ''
  Write-Pair '1. 开启右上角的“开发者模式”' 'Enable “Developer mode” in the upper-right corner'
  Write-Pair '2. 点击“加载已解压的扩展程序”' 'Click “Load unpacked”'
  if ($ClipboardReady) {
    Write-Pair "3. 在路径栏粘贴以下路径（已复制到剪贴板）：" "Paste this path into the folder picker's address bar (already copied):"
  } else {
    Write-Pair "3. 在路径栏复制并粘贴以下路径：" "Copy and paste this path into the folder picker's address bar:"
  }
  Write-Host ("   {0}" -f $DistDir)
}

Write-Host ''
Write-Pair "加载完成后：" "After loading the extension:"
Write-Pair "• 点击工具栏中的 DeepSeek 鲸鱼图标，打开侧边栏" "Click the DeepSeek whale icon in the toolbar to open the side panel"
Write-Pair "• 启动 Host 后，在仓库根目录运行 pnpm run pair:browser，将一次性配对码填入侧栏设置" "After starting the Host, run pnpm run pair:browser from the repository and enter the one-time code in side-panel settings"
$QuotedRoot = "'" + $Root.Replace("'", "''") + "'"
Write-Host ("• 启动固定版本：cd {0}; pnpm start" -f $QuotedRoot)
Write-Host ("   Start the pinned version: cd {0}; pnpm start" -f $QuotedRoot)
Write-Host ''
