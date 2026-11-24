# RouteQuay Windows installer.
# Requires Node.js at the version declared by package.json engines.node.
# Does not install Node.js. Does not change the machine PATH.
# Update and uninstall do not delete %USERPROFILE%\.routequay.

[CmdletBinding()]
param(
  [ValidateSet('install', 'update', 'uninstall')]
  [string]$Action = 'install',
  [string]$InstallDir,
  [string]$Source,
  [switch]$ConfirmPath,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'

function Test-AnswerYes([string]$Value) {
  return $Value -match '^(?i:y|yes)$'
}

function Confirm-RouteQuay {
  param(
    [Parameter(Mandatory = $true)][string]$Prompt,
    [switch]$Accepted,
    [switch]$DefaultNoWhenRedirected
  )
  if ($Accepted) { return $true }
  if ([Console]::IsInputRedirected) {
    if ($DefaultNoWhenRedirected) { return $false }
    Write-Error "Confirmation required before continuing. $Prompt Re-run with -Yes."
    exit 2
  }
  $answer = Read-Host "$Prompt [y/N]"
  return (Test-AnswerYes $answer)
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error 'Node.js was not found. Install Node.js first. RouteQuay does not install Node.js.'
  exit 2
}

if (-not $Source) {
  $Source = Split-Path -Parent $PSScriptRoot
}
if (-not $InstallDir) {
  if (-not $env:LOCALAPPDATA) {
    Write-Error 'LOCALAPPDATA is not set. Pass -InstallDir.'
    exit 2
  }
  $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\RouteQuay'
}

$packagePath = Join-Path $Source 'package.json'
if (-not (Test-Path -LiteralPath $packagePath)) {
  Write-Error 'package.json was not found in the runtime source.'
  exit 2
}
$manifest = Get-Content -LiteralPath $packagePath -Raw -Encoding utf8 | ConvertFrom-Json
$required = [string]$manifest.engines.node
if ($required -notmatch '^>=(\d+)\.(\d+)\.(\d+)$') {
  Write-Error 'package.json engines.node must be a >= major.minor.patch range.'
  exit 2
}
$current = (& node -p "process.versions.node").Trim()
$currentParts = $current.Split('.')
$requiredParts = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
$actualParts = @([int]$currentParts[0], [int]$currentParts[1], [int]$currentParts[2])
$nodeOk = $false
for ($i = 0; $i -lt 3; $i++) {
  if ($actualParts[$i] -gt $requiredParts[$i]) { $nodeOk = $true; break }
  if ($actualParts[$i] -lt $requiredParts[$i]) { $nodeOk = $false; break }
  if ($i -eq 2) { $nodeOk = $true }
}
if (-not $nodeOk) {
  Write-Error "Node.js $required is required. Found $current. RouteQuay does not install Node.js."
  exit 2
}

$installPrompt = "Copy RouteQuay program files to $InstallDir"
if ($Action -eq 'update') { $installPrompt = "Update RouteQuay program files in $InstallDir" }
if ($Action -eq 'uninstall') { $installPrompt = "Remove RouteQuay program files from $InstallDir. User configuration is kept." }
if (-not (Confirm-RouteQuay -Prompt $installPrompt -Accepted:$Yes)) {
  Write-Output 'Cancelled. No files were changed.'
  exit 0
}

$pathFlag = 'no'
if ($Action -eq 'uninstall') {
  $pathFlag = 'yes'
} elseif (Confirm-RouteQuay -Prompt "Add $InstallDir to the current-user PATH? The machine PATH is not changed." -Accepted:$ConfirmPath -DefaultNoWhenRedirected) {
  $pathFlag = 'yes'
}

$installer = Join-Path $PSScriptRoot 'install-win.mjs'
& node $installer $Action --source $Source --dest $InstallDir --confirm-path $pathFlag
exit $LASTEXITCODE
