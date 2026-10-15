# Install

AI Visibility Checker is a Node.js command-line app with a local dashboard. You need:

- **Node.js 22.5 or newer** (22 LTS or 24). It uses Node's built-in SQLite, so there is nothing to compile.
- **Chrome or Chromium** (optional) to render JavaScript pages and compare them with the raw HTML.
- **AI keys** (optional) for AI visibility tracking.

## The quick way

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Devs-Core-Company/ai-visibility-checker/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Devs-Core-Company/ai-visibility-checker/main/install.ps1 | iex
```

The script checks your Node version, runs `npm install -g github:Devs-Core-Company/ai-visibility-checker`,
then `avc doctor`, then `avc setup-claude` to connect AVC to the Claude desktop app, Claude Code and
Cursor if you have them ([below](#connect-it-to-claude-mcp); set `AVC_SKIP_CLAUDE=1` to skip). It never installs system packages for you; if Node is missing or too old it tells
you how to get it. You can read both scripts in this repository before running them.

## Step by step

### macOS

1. Install Node 22: download the installer from [nodejs.org](https://nodejs.org/en/download), or
   `brew install node@22`, or `nvm install 22`.
2. Check: `node --version` shows `v22.5.0` or newer.
3. Install: `npm i -g github:Devs-Core-Company/ai-visibility-checker`
4. Optional: install [Google Chrome](https://www.google.com/chrome/). It is found automatically.
5. Run `avc doctor`, then `avc init`.
6. Optional: `avc setup-claude` to use AVC from Claude ([below](#connect-it-to-claude-mcp)).

### Windows

1. Install Node 22 LTS: `winget install OpenJS.NodeJS.LTS`, or the installer from
   [nodejs.org](https://nodejs.org/en/download).
2. Open a new PowerShell window and check `node --version`.
3. Install: `npm i -g github:Devs-Core-Company/ai-visibility-checker`
4. Optional: install Chrome or use Edge's Chromium (set `AVC_CHROME_PATH` to its `msedge.exe` if it
   is not found).
5. Run `avc doctor`, then `avc init`.
6. Optional: `avc setup-claude` to use AVC from Claude ([below](#connect-it-to-claude-mcp)).

### Linux

1. Install Node 22 with your package manager, [NodeSource](https://github.com/nodesource/distributions)
   or [nvm](https://github.com/nvm-sh/nvm): `nvm install 22`.
2. Install: `npm i -g github:Devs-Core-Company/ai-visibility-checker`. If that fails with a
   permissions error, use nvm, or `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin`
   to your `PATH`. Avoid `sudo npm`.
3. Optional: `sudo apt install chromium` (Debian/Ubuntu) or `sudo dnf install chromium` (Fedora).
4. Run `avc doctor`, then `avc init`.
5. Optional: `avc setup-claude` to use AVC from Claude Code or Cursor
   ([below](#connect-it-to-claude-mcp)).

### Without installing

```bash
npx github:Devs-Core-Company/ai-visibility-checker audit https://yoursite.com
```

### Docker

```bash
git clone https://github.com/Devs-Core-Company/ai-visibility-checker.git
cd ai-visibility-checker
docker build -t avc .
docker run --rm -v avc-data:/data -v "$PWD/avc-reports:/app/avc-reports" avc audit https://yoursite.com
```

The image is `node:22-slim` with Chromium. Data lives in the `/data` volume (`AVC_DATA_DIR`). For the
dashboard and scheduled monitoring, use `docker compose up -d`; it publishes the port on
`127.0.0.1` only. Run `docker compose logs avc` to get the sign-in link.

### From source

```bash
git clone https://github.com/Devs-Core-Company/ai-visibility-checker.git
cd ai-visibility-checker
npm ci
npm run compile
npm link        # makes `avc` available
```

## Connect it to Claude (MCP)

AVC is also an MCP server, so the Claude desktop app, Claude Code and Cursor can run audits, read the
issues and apply fixes for you. After installing (any method above except npx and Docker), run:

```bash
avc setup-claude
```

It finds what you have and sets each one up:

| Client                                   | What it does                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Claude desktop app (chat)                | Adds `avc` to `claude_desktop_config.json`, keeping your other servers and saving a backup of the old file |
| Claude Code (CLI and the app's Code tab) | Runs `claude mcp add --scope user`, so it works in every folder, not just one                              |
| Cursor                                   | Adds `avc` to `~/.cursor/mcp.json`                                                                         |

The desktop app does not see your terminal's `PATH`, so the entry uses absolute paths to Node and to
AVC. That is why a plain `claude mcp add` or a bare `npx` entry often fails there silently.

Then **fully quit the Claude app and open it again**: ⌘Q on a Mac, File → Exit on Windows. Closing
the window is not enough. In a new chat, `avc` shows under the tools menu. Try: _"Audit
https://yoursite.com with avc and tell me the three things to fix first."_

Useful options:

- `avc setup-claude --dry-run` shows what it would write, and writes nothing.
- `avc setup-claude --desktop`, `--code` or `--cursor` sets up only that one.
- `avc setup-claude --remove` takes AVC out again.
- Changed Node version (nvm, Homebrew upgrade)? Run `avc setup-claude` again so the path is current.

Where the desktop app keeps its config and its log for AVC:

| OS      | Config                                                            | Log                                        |
| ------- | ----------------------------------------------------------------- | ------------------------------------------ |
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` | `~/Library/Logs/Claude/mcp-server-avc.log` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json`                     | `%APPDATA%\Claude\logs\mcp-server-avc.log` |
| Linux   | `~/.config/Claude/claude_desktop_config.json`                     | `~/.config/Claude/logs/mcp-server-avc.log` |

Setting it up by hand, VS Code and other clients, and the full tool list: [MCP.md](MCP.md).

## Keys

Keys are optional: audits need none. AI visibility runs need at least one AI key; without one
they are skipped and every result says so (the CLI summary, the reports, the dashboard and the
MCP tools all list what was skipped and why). Nothing falls back to sample answers unless you ask
for them with `--mock`.

Add keys in any of these ways. Each keeps them on your computer:

- **Terminal:** `avc keys setup` asks for each key at a hidden prompt (Enter skips one).
  `avc keys set <id>` adds one, `avc keys` shows what is set, `avc keys remove <id>` deletes one.
  `avc init` and the first `avc audit` offer the same setup, and `avc audit --visibility` and
  `avc visibility` offer it when a key is missing.
- **Dashboard:** `avc ui` → Settings.
- **Claude, Cursor or VS Code (MCP):** ask for AI visibility, or for the `setup_keys` tool. A
  private page opens on your computer (`127.0.0.1`, one-time link, expires after 15 minutes) where
  you type the keys. They go from your browser straight to AVC and never pass through the chat or
  the AI model. Never paste a key into the chat.
- **Environment variables** (below), for CI and Docker. They take precedence over stored keys.

Where stored keys live: the macOS Keychain, the Secret Service keyring on Linux (GNOME Keyring,
KWallet), or a DPAPI-encrypted file for your Windows account. Without one of those (for example
in a container), `~/.avc/secrets.json` with file mode 600. Set `AVC_SECRET_STORE=file` to use the
file anyway. Keys are never written to `~/.avc/config.json`: keys an older version saved there
are moved to the keychain automatically. Keys in `avc.config.json`, which is meant to be committed,
are ignored with a warning. A key is sent only to the provider it belongs to.

| Variable                                                                                                   | Used for                                              |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `AI_GATEWAY_API_KEY`                                                                                       | One Vercel AI Gateway key for every engine            |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `PERPLEXITY_API_KEY`, `XAI_API_KEY` | Direct provider keys (used before the gateway)        |
| `AVC_MAX_RUN_USD`, `AVC_MAX_MONTH_USD`                                                                     | Spend caps (defaults 3 and 30)                        |
| `AVC_LLM_MOCK=1`                                                                                           | Sample answers, no spend                              |
| `PSI_API_KEY`, `BING_WEBMASTER_API_KEY`                                                                    | PageSpeed Insights, Bing Webmaster Tools              |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_APPLICATION_CREDENTIALS`                               | Search Console and GA4                                |
| `AVC_WP_APP_PASSWORD`                                                                                      | WordPress auto-fix                                    |
| `AVC_DATA_DIR`                                                                                             | Where the database and tokens live (default `~/.avc`) |
| `AVC_CHROME_PATH`                                                                                          | Chrome or Chromium binary                             |

The full list is in [.env.example](../.env.example).

## Connecting data sources

Each source has its own step-by-step guide in [CONNECTIONS.md](CONNECTIONS.md): Google Search
Console and GA4 (`avc connect google`), PageSpeed Insights, Bing Webmaster Tools and IndexNow,
server logs, WordPress and a local repo.

## Uninstall

```bash
avc uninstall
```

This removes AVC from the Claude desktop app, Claude Code and Cursor (other servers and settings in
those files are kept, with a backup). It then asks whether to delete your stored API keys (yes by
default) and your audit history, settings, Google sign-in and WordPress rollback snapshots (no by
default). It deletes only files AVC created, never anything else in the folder. Finish with:

```bash
npm uninstall -g @devs-core/ai-visibility-checker
```

Options: `--yes` (ask nothing: delete keys, keep data), `--keep-keys`, `--delete-data`,
`--keep-data`. Installed as the Claude Desktop extension instead? Use Claude Desktop → Settings →
Extensions → AI Visibility Checker → **Uninstall**; then run `avc uninstall` too if you also
installed the `avc` command and want your keys and data gone. Quit and reopen Claude Desktop so
AVC disappears from the tools list.

## Troubleshooting

| Problem                                           | Fix                                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `avc: command not found`                          | Open a new terminal. Otherwise add `$(npm prefix -g)/bin` (Windows: `npm prefix -g`) to `PATH`.                                                                     |
| `needs Node.js 22.5 or newer`                     | Upgrade Node; `node:sqlite` arrived in 22.5.                                                                                                                        |
| `EACCES` during `npm i -g`                        | Use nvm/fnm/volta, or set an npm prefix in your home folder (see Linux above).                                                                                      |
| Chrome not found                                  | Install Chrome or Chromium, or set `AVC_CHROME_PATH`. Audits still run without it; render checks are skipped.                                                       |
| Crawl stops early or sees 403s                    | The site's firewall may block unknown bots. Allow the `AVC` user agent in your firewall, or audit fewer pages with `--max-pages`.                                   |
| Dashboard says "Open the link from your terminal" | Use the full link printed by `avc ui`; it carries a one-time token. Restarting `avc ui` makes a new one.                                                            |
| Port 4317 in use                                  | `avc ui --port 4318`                                                                                                                                                |
| AI visibility shows sample answers                | No keys found. Run `avc doctor` to see which are set.                                                                                                               |
| "Monthly cap reached"                             | Raise `AVC_MAX_MONTH_USD` or wait for next month.                                                                                                                   |
| AVC does not show in the Claude app               | Quit the app fully (⌘Q / File → Exit) and reopen it. Still missing: read the log in the table [above](#connect-it-to-claude-mcp), and run `avc setup-claude` again. |
| `claude mcp list` shows `avc` as failed           | Run `avc setup-claude` again (usually a Node version change). `claude mcp get avc` shows the command it runs.                                                       |
| Google sign-in fails                              | See the common errors in [CONNECTIONS.md](CONNECTIONS.md#common-errors).                                                                                            |

Still stuck? Run `avc doctor --json` and include the output in an
[issue](https://github.com/Devs-Core-Company/ai-visibility-checker/issues) (it contains no keys).
