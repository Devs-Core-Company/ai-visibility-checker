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
then `avc doctor`. It never installs system packages for you; if Node is missing or too old it tells
you how to get it. You can read both scripts in this repository before running them.

## Step by step

### macOS

1. Install Node 22: download the installer from [nodejs.org](https://nodejs.org/en/download), or
   `brew install node@22`, or `nvm install 22`.
2. Check: `node --version` shows `v22.5.0` or newer.
3. Install: `npm i -g github:Devs-Core-Company/ai-visibility-checker`
4. Optional: install [Google Chrome](https://www.google.com/chrome/). It is found automatically.
5. Run `avc doctor`, then `avc init`.

### Windows

1. Install Node 22 LTS: `winget install OpenJS.NodeJS.LTS`, or the installer from
   [nodejs.org](https://nodejs.org/en/download).
2. Open a new PowerShell window and check `node --version`.
3. Install: `npm i -g github:Devs-Core-Company/ai-visibility-checker`
4. Optional: install Chrome or use Edge's Chromium (set `AVC_CHROME_PATH` to its `msedge.exe` if it
   is not found).
5. Run `avc doctor`, then `avc init`.

### Linux

1. Install Node 22 with your package manager, [NodeSource](https://github.com/nodesource/distributions)
   or [nvm](https://github.com/nvm-sh/nvm): `nvm install 22`.
2. Install: `npm i -g github:Devs-Core-Company/ai-visibility-checker`. If that fails with a
   permissions error, use nvm, or `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin`
   to your `PATH`. Avoid `sudo npm`.
3. Optional: `sudo apt install chromium` (Debian/Ubuntu) or `sudo dnf install chromium` (Fedora).
4. Run `avc doctor`, then `avc init`.

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
npm run build
npm link        # makes `avc` available
```

## Keys

Keys are optional. Set them as environment variables, or save them in the dashboard (`avc ui` →
Settings), which writes `~/.avc/config.json` with file mode 600. Never put keys in
`avc.config.json`: that file is meant to be committed.

| Variable | Used for |
| --- | --- |
| `AI_GATEWAY_API_KEY` | One Vercel AI Gateway key for every engine |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `PERPLEXITY_API_KEY`, `XAI_API_KEY` | Direct provider keys (used before the gateway) |
| `AVC_MAX_RUN_USD`, `AVC_MAX_MONTH_USD` | Spend caps (defaults 3 and 30) |
| `AVC_LLM_MOCK=1` | Sample answers, no spend |
| `PSI_API_KEY`, `BING_WEBMASTER_API_KEY` | PageSpeed Insights, Bing Webmaster Tools |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_APPLICATION_CREDENTIALS` | Search Console and GA4 |
| `AVC_WP_APP_PASSWORD` | WordPress auto-fix |
| `AVC_DATA_DIR` | Where the database and tokens live (default `~/.avc`) |
| `AVC_CHROME_PATH` | Chrome or Chromium binary |

The full list is in [.env.example](../.env.example).

## Connecting data sources

Each source has its own step-by-step guide in [CONNECTIONS.md](CONNECTIONS.md): Google Search
Console and GA4 (`avc connect google`), PageSpeed Insights, Bing Webmaster Tools and IndexNow,
server logs, WordPress and a local repo.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `avc: command not found` | Open a new terminal. Otherwise add `$(npm prefix -g)/bin` (Windows: `npm prefix -g`) to `PATH`. |
| `needs Node.js 22.5 or newer` | Upgrade Node; `node:sqlite` arrived in 22.5. |
| `EACCES` during `npm i -g` | Use nvm/fnm/volta, or set an npm prefix in your home folder (see Linux above). |
| Chrome not found | Install Chrome or Chromium, or set `AVC_CHROME_PATH`. Audits still run without it; render checks are skipped. |
| Crawl stops early or sees 403s | The site's firewall may block unknown bots. Allow the `AVC` user agent in your firewall, or audit fewer pages with `--max-pages`. |
| Dashboard says "Open the link from your terminal" | Use the full link printed by `avc ui`; it carries a one-time token. Restarting `avc ui` makes a new one. |
| Port 4317 in use | `avc ui --port 4318` |
| AI visibility shows sample answers | No keys found. Run `avc doctor` to see which are set. |
| "Monthly cap reached" | Raise `AVC_MAX_MONTH_USD` or wait for next month. |
| Google sign-in fails | See the common errors in [CONNECTIONS.md](CONNECTIONS.md#common-errors). |

Still stuck? Run `avc doctor --json` and include the output in an
[issue](https://github.com/Devs-Core-Company/ai-visibility-checker/issues) (it contains no keys).
