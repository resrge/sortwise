<#
  Builds the SortWise Windows installer.

    .\build-installer.ps1              # stamps today's build date, packages, compiles installer
    .\build-installer.ps1 -KeepBuild   # keeps the buildStamp already in package.json
    .\build-installer.ps1 -Clean       # wipes dist\ and installer\Output\ first
    .\build-installer.ps1 -SkipTests   # skips npm test
    .\build-installer.ps1 -Iscc "D:\Tools\Inno Setup 7\ISCC.exe"   # use a specific Inno Setup
    .\build-installer.ps1 -Publish -Notes "What's new..."          # also create the GitHub release (needs gh CLI)

  Output (installer\Output):
    SortWise-Setup-<version>-build<yyyyMMdd>.exe   the installer
    latest.json                                    update info for the resrge.com mirror
  Needs Node.js and Inno Setup (6 or 7; found automatically).
#>
param(
  [switch]$KeepBuild,
  [switch]$Clean,
  [switch]$SkipTests,
  [string]$Iscc,
  [switch]$Publish,
  [string]$Notes = '',
  [string]$GitHubRepo = 'resrge/sortwise',
  [string]$MirrorBase = 'https://resrge.com/sortwise'
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "`nBUILD FAILED: $msg" -ForegroundColor Red; exit 1 }
function Run($exe, [string[]]$argList) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { Fail "$exe $($argList -join ' ') exited with code $LASTEXITCODE" }
}

# ---- Version + build stamp -------------------------------------------------
$pkgPath = Join-Path $Root 'package.json'
$pkgText = [IO.File]::ReadAllText($pkgPath)
$pkg     = $pkgText | ConvertFrom-Json
$Version = $pkg.version

if ($KeepBuild -and $pkg.buildStamp) {
  $Build = $pkg.buildStamp
} else {
  $Build = Get-Date -Format 'yyyyMMdd'
  # Edit just the buildStamp line so package.json formatting is untouched (and saved without a BOM)
  $pkgText = $pkgText -replace '"buildStamp"\s*:\s*"[^"]*"', "`"buildStamp`": `"$Build`""
  [IO.File]::WriteAllText($pkgPath, $pkgText, (New-Object Text.UTF8Encoding $false))
}
Write-Host "SortWise v$Version build $Build" -ForegroundColor Green

# ---- Tools -----------------------------------------------------------------
Step 'Checking tools'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js not found on PATH.' }
Write-Host "Node $(node -v)"

function Find-Iscc {
  # 1. Explicit path passed with -Iscc
  if ($Iscc) {
    if (Test-Path $Iscc) { return (Resolve-Path $Iscc).Path }
    Fail "ISCC.exe not found at the -Iscc path: $Iscc"
  }
  # 2. On PATH
  $onPath = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
  if ($onPath) { return $onPath }

  # 3. Any "Inno Setup <version>" folder in the usual places, newest first (7, 6, ...)
  $roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, "$env:LOCALAPPDATA\Programs") | Where-Object { $_ -and (Test-Path $_) }
  $found = foreach ($r in $roots) {
    Get-ChildItem -Path $r -Directory -Filter 'Inno Setup*' -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'ISCC.exe' } | Where-Object { Test-Path $_ }
  }
  if ($found) {
    return $found | Sort-Object {
        $v = (Get-Item $_).VersionInfo.ProductVersion -replace '[^\d.].*$', ''
        try { [version]$v } catch { [version]'0.0' }
      } -Descending | Select-Object -First 1
  }

  # 4. Installed location from the uninstall registry entries
  $keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
          'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
          'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  $reg = Get-ItemProperty $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'Inno Setup*' -and $_.InstallLocation } |
    ForEach-Object { Join-Path $_.InstallLocation 'ISCC.exe' } | Where-Object { Test-Path $_ } |
    Select-Object -First 1
  return $reg
}

$isccPath = Find-Iscc
if (-not $isccPath) { Fail 'Inno Setup (ISCC.exe) not found. Pass its location with -Iscc "C:\path\to\ISCC.exe".' }
$isccVer = (Get-Item $isccPath).VersionInfo.ProductVersion
Write-Host "Inno Setup $isccVer`: $isccPath"
$iscc = $isccPath

# ---- Clean -----------------------------------------------------------------
if ($Clean) {
  Step 'Cleaning old output'
  foreach ($d in 'dist', 'installer\Output') {
    if (Test-Path $d) { Remove-Item $d -Recurse -Force }
  }
}

# ---- Dependencies ----------------------------------------------------------
Step 'Installing dependencies'
if (Test-Path 'package-lock.json') { Run 'npm' @('ci') } else { Run 'npm' @('install') }

# ---- Tests -----------------------------------------------------------------
if (-not $SkipTests) {
  Step 'Running tests'
  Run 'npm' @('test')
}

# ---- Package app -----------------------------------------------------------
Step 'Packaging app (electron-builder --dir)'
if (Test-Path 'dist\win-unpacked') { Remove-Item 'dist\win-unpacked' -Recurse -Force }
# No code signing; exe editing is off in package.json (it needs symlink rights) and done by rcedit below
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
Run 'npx' @('electron-builder', '--win', '--x64', '--dir')

$unpacked = Join-Path $Root 'dist\win-unpacked'
$appExe   = Join-Path $unpacked 'SortWise.exe'
if (-not (Test-Path $appExe)) { Fail "SortWise.exe not found in $unpacked" }

Step 'Setting exe icon and version info'
Run 'node' @((Join-Path $Root 'scripts\set-exe-info.js'), $appExe)

# ---- Installer -------------------------------------------------------------
Step 'Compiling installer'
Run $iscc @(
  "/DAppVersion=$Version",
  "/DAppBuild=$Build",
  "/DSourceDir=$unpacked",
  (Join-Path $Root 'installer\SortWise.iss')
)

$setup = Join-Path $Root "installer\Output\SortWise-Setup-$Version-build$Build.exe"
if (-not (Test-Path $setup)) { Fail "Installer not found at $setup" }

# ---- Update manifest (latest.json) -------------------------------------------
Step 'Writing latest.json'
$setupName = Split-Path $setup -Leaf
$sha256    = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower()
$manifest  = [ordered]@{
  version = $Version
  build   = $Build
  url     = "$MirrorBase/$setupName"
  sha256  = $sha256
  notes   = $Notes
  date    = (Get-Date).ToString('yyyy-MM-dd')
}
$manifestPath = Join-Path $Root 'installer\Output\latest.json'
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
Write-Host "sha256 $sha256"

# ---- Publish to GitHub (optional) ------------------------------------------
if ($Publish) {
  Step "Publishing GitHub release v$Version to $GitHubRepo"
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail 'GitHub CLI (gh) not found. Install it and run "gh auth login", or upload by hand.' }
  $title = "SortWise v$Version build $Build"
  $body  = if ($Notes) { $Notes } else { $title }
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & gh release view "v$Version" --repo $GitHubRepo *> $null
  $exists = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $eap
  if ($exists) {
    # Same version, new build: replace the files on the existing release
    Run 'gh' @('release', 'upload', "v$Version", $setup, $manifestPath, '--repo', $GitHubRepo, '--clobber')
    Run 'gh' @('release', 'edit', "v$Version", '--repo', $GitHubRepo, '--title', $title, '--notes', $body)
  } else {
    Run 'gh' @('release', 'create', "v$Version", $setup, $manifestPath, '--repo', $GitHubRepo, '--title', $title, '--notes', $body, '--latest')
  }
}

$sizeMB = [math]::Round((Get-Item $setup).Length / 1MB, 1)
Write-Host "`nDone! $setup ($sizeMB MB)" -ForegroundColor Green
Write-Host "To ship this update:" -ForegroundColor Yellow
if (-not $Publish) {
  Write-Host "  GitHub:     create release v$Version on $GitHubRepo and attach $setupName + latest.json"
  Write-Host "              (or rerun with -Publish)"
}
Write-Host "  resrge.com: upload $setupName and latest.json to $MirrorBase/"
