# AI Visibility Checker installer for Windows (PowerShell 5.1+).
#   irm https://raw.githubusercontent.com/Devs-Core-Company/ai-visibility-checker/main/install.ps1 | iex
# It checks Node.js, installs the `avc` command with npm, then runs `avc doctor`.
# It never installs system packages for you.
$ErrorActionPreference = 'Stop'
$Repo = 'github:Devs-Core-Company/ai-visibility-checker'
$Need = [version]'22.5.0'

Write-Host 'AI Visibility Checker by Devs Core' -ForegroundColor Cyan

function Show-NodeHint {
  Write-Host ''
  Write-Host 'Install Node.js 22 LTS or 24, then run this script again:'
  Write-Host '  - Download: https://nodejs.org/en/download'
  Write-Host '  - winget:   winget install OpenJS.NodeJS.LTS'
  Write-Host '  - nvm-windows: https://github.com/coreybutler/nvm-windows'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js was not found.' -ForegroundColor Yellow
  Show-NodeHint
  exit 1
}

$ver = [version](node -p 'process.versions.node')
if ($ver -lt $Need) {
  Write-Host "Node.js $ver is too old. AI Visibility Checker needs $Need or newer." -ForegroundColor Yellow
  Show-NodeHint
  exit 1
}
Write-Host "Node.js $ver found."

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host 'npm was not found. It ships with Node.js; reinstall Node from https://nodejs.org.' -ForegroundColor Red
  exit 1
}

Write-Host "Installing the avc command (npm install -g $Repo)..."
npm install -g $Repo
if ($LASTEXITCODE -ne 0) {
  Write-Host 'The global install failed. Try again in a new PowerShell window, or check `npm config get prefix`.' -ForegroundColor Red
  exit 1
}

if (-not (Get-Command avc -ErrorAction SilentlyContinue)) {
  Write-Host "Installed, but 'avc' is not on your PATH. Open a new terminal, or add $(npm prefix -g) to PATH." -ForegroundColor Yellow
  exit 1
}

Write-Host ''
avc doctor

# Connect AVC to Claude (desktop app, Claude Code at user scope, Cursor): whichever are
# installed. Set AVC_SKIP_CLAUDE=1 to skip.
if ($env:AVC_SKIP_CLAUDE -ne '1') {
  Write-Host ''
  Write-Host 'Connecting AVC to Claude...' -ForegroundColor Cyan
  avc setup-claude
  if ($LASTEXITCODE -ne 0) { Write-Host "Could not connect AVC to Claude. Run 'avc setup-claude' later." -ForegroundColor Yellow }
}

Write-Host ''
Write-Host 'Done. Next steps:' -ForegroundColor Cyan
Write-Host '  Quit the Claude app fully (File > Exit) and reopen it, then ask: "Audit https://yoursite.com with avc"'
Write-Host '  avc init                        # set up your site'
Write-Host '  avc audit https://yoursite.com  # run an audit'
Write-Host '  avc ui                          # open the dashboard'
