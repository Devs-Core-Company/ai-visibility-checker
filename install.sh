#!/usr/bin/env bash
# AI Visibility Checker installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/Devs-Core-Company/ai-visibility-checker/main/install.sh | bash
# It checks Node.js, installs the `avc` command with npm, then runs `avc doctor`.
# It never installs system packages for you.
set -euo pipefail

REPO="github:Devs-Core-Company/ai-visibility-checker"
NEED_MAJOR=22
NEED_MINOR=5

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

bold "AI Visibility Checker by Devs Core"

node_hint() {
  echo
  echo "Install Node.js 22 LTS or 24, then run this script again:"
  echo "  - Download:  https://nodejs.org/en/download"
  case "$(uname -s)" in
    Darwin) echo "  - Homebrew:  brew install node@22" ;;
    Linux) echo "  - Your package manager, or NodeSource: https://github.com/nodesource/distributions" ;;
  esac
  echo "  - nvm:       nvm install 22 && nvm use 22   (https://github.com/nvm-sh/nvm)"
}

if ! command -v node >/dev/null 2>&1; then
  warn "Node.js was not found."
  node_hint
  exit 1
fi

VERSION="$(node -p 'process.versions.node')"
MAJOR="${VERSION%%.*}"
REST="${VERSION#*.}"
MINOR="${REST%%.*}"
if [ "$MAJOR" -lt "$NEED_MAJOR" ] || { [ "$MAJOR" -eq "$NEED_MAJOR" ] && [ "$MINOR" -lt "$NEED_MINOR" ]; }; then
  warn "Node.js $VERSION is too old. AI Visibility Checker needs $NEED_MAJOR.$NEED_MINOR or newer."
  node_hint
  exit 1
fi
echo "Node.js $VERSION found."

command -v npm >/dev/null 2>&1 || fail "npm was not found. It ships with Node.js; reinstall Node from https://nodejs.org."

echo "Installing the avc command (npm install -g $REPO)…"
if ! npm install -g "$REPO"; then
  warn "The global install failed. If it was a permissions error, either:"
  echo "  - use a Node version manager (nvm, fnm, volta) so global installs go to your home folder, or"
  echo "  - set an npm prefix you own: npm config set prefix ~/.npm-global && export PATH=~/.npm-global/bin:\$PATH"
  echo "Avoid sudo for npm if you can."
  exit 1
fi

if ! command -v avc >/dev/null 2>&1; then
  warn "Installed, but 'avc' is not on your PATH. Add \"$(npm prefix -g)/bin\" to PATH."
  exit 1
fi

echo
avc doctor || true

# Connect AVC to Claude (desktop app, Claude Code at user scope, Cursor): whichever are
# installed. Set AVC_SKIP_CLAUDE=1 to skip.
if [ "${AVC_SKIP_CLAUDE:-}" != "1" ]; then
  echo
  bold "Connecting AVC to Claude…"
  avc setup-claude || warn "Could not connect AVC to Claude. Run 'avc setup-claude' later."
fi

echo
bold "Done. Next steps:"
echo "  Quit the Claude app fully and reopen it, then ask: \"Audit https://yoursite.com with avc\""
echo "  avc init                       # set up your site"
echo "  avc audit https://yoursite.com # run an audit"
echo "  avc ui                         # open the dashboard"
