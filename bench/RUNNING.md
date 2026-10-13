# Running the benchmark

Everything below runs on one Linux (or macOS) machine with no network access beyond
package registries during setup and `127.0.0.1` during the runs. Rules: [SPEC.md](SPEC.md).

## 1. Prerequisites

- Node.js 22.5 or newer, npm
- Python 3.11 or newer with `venv` and `pip` (3.13 was used)
- git
- Chromium or Chrome. Set `CHROME_PATH` to its binary. Our runs used Playwright's
  Chromium 141 build at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, which is the
  runners' default when `CHROME_PATH` is unset.
- For Scrawly: a Playwright browser folder that matches the Playwright version installed in
  its venv (see step 3). Set `PLAYWRIGHT_BROWSERS_PATH` to it (default `/opt/pw-browsers`).

The app itself must be installed (`npm ci` at the repo root) so `bin/avc.mjs` runs.

## 2. Install the tools (all under `bench/.tools/`, which is git-ignored)

Nothing is installed globally and the app's `package.json` is not touched.

```bash
cd bench
mkdir -p .tools && cd .tools

# Lighthouse 13 and Unlighthouse, in a local npm prefix
mkdir -p npm && cd npm
echo '{"name":"bench-tools","private":true}' > package.json
PUPPETEER_SKIP_DOWNLOAD=1 npm install lighthouse@13 @unlighthouse/cli
cd ..
# versions used: lighthouse 13.5.0, @unlighthouse/cli 0.19.1 (bundles lighthouse 13.5.0)

# python-seo-analyzer, in its own venv
python3 -m venv venv-pysa
venv-pysa/bin/pip install pyseoanalyzer          # used: 2025.4.3

# Scrawly, from its repository, in its own venv
git clone https://github.com/IliasSami/scrawly-seo-crawler scrawly-src
git -C scrawly-src checkout 8fdebcf              # commit used
python3 -m venv venv-scrawly
venv-scrawly/bin/pip install -e ./scrawly-src uvicorn
# Scrawly needs Playwright's Chromium. Normally `playwright install chromium` downloads
# it; our sandbox could not reach the Playwright CDN, so we pinned the Playwright
# version whose browser build (chromium-1194) was already on the machine. Scrawly's
# requirement is playwright>=1.42, so this is within its supported range:
venv-scrawly/bin/pip install "playwright==1.56.0"
# With network access you can instead keep the latest Playwright and run:
#   PLAYWRIGHT_BROWSERS_PATH=$PWD/pw venv-scrawly/bin/playwright install chromium
# and export PLAYWRIGHT_BROWSERS_PATH=$PWD/pw before running the benchmark.
cd ../..
```

## 3. Run

```bash
# Detection suite: starts bench/serve.mjs, runs every tool in turn, scores.
node bench/run.mjs

# A subset
node bench/run.mjs --tools avc,scrawly

# Re-score without re-running tools
node bench/score.mjs

# Performance suite: 1,000-page generated site (bench/gen-large-site.mjs);
# Lighthouse and Unlighthouse audit a 50-page sample.
node bench/run.mjs --perf
node bench/run.mjs --perf --tools avc,scrawly --pages 1000 --sample 50
```

Tools run one at a time, never in parallel, so wall time and memory are not disturbed.

Outputs:

| Path | What |
| --- | --- |
| `bench/results/findings/<tool>.json` | Normalised findings `{tool, type, url, message, severity}` + run meta (version, settings, wall time, peak RSS, pages, errors). URLs are stored relative to the site origin. |
| `bench/results/raw/<tool>/` | The tool's own output, kept small enough to commit (over 1.5 MB → gzipped; still over → dropped with a note). |
| `bench/results/results.json`, `RESULTS.md` | Scores and tables. |
| `bench/results/perf.json` | Performance runs. |

## 4. How each tool is run

| Tool | Command / route | Settings beyond defaults |
| --- | --- | --- |
| AVC | `node bin/avc.mjs audit <url> --format json --out <dir> --render --max-pages 0` with `AVC_PSI=off AVC_LLM_MOCK=1 AVC_DATA_DIR=<tmp> AVC_CHROME_PATH=$CHROME_PATH` | `--render` (Chrome rendering); `--max-pages 0` lifts the default 500-page cap. |
| Scrawly | Its local engine, `python -m uvicorn sentinelseo.web.api:app` (what the desktop app starts, minus the GUI window and self-updater), driven through the HTTP API its own `scripts/scheduled_audit.py` uses: `POST /api/clients`, `POST /api/audit/start`, poll `/api/audit/status/{id}`, then `GET /api/export/{id}?format=json` (developer export), `/api/issues/{id}`, `/api/agentic/{id}`. Env: `SCRAWLY_AUTO_UPDATE=0`, `SCRAWLY_DATA_DIR`/`SCRAWLY_DB_PATH` in a temp folder. | `max_depth: 10` (default 3) and `max_pages: 5000` (default 500), so the whole site is crawled. JS rendering, robots.txt, sitemap discovery: defaults (on). Scrawly has no localhost or private-IP blocking in its crawler, so nothing had to be allowed. Failed agentic probes are counted as site-wide findings. |
| Lighthouse | `lighthouse <page> --output json --chrome-flags="--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage"`, once per page | Default config (all five categories, including Agentic Browsing). Page list: start URL + sitemap URLs (robots.txt `Sitemap:`, else `/sitemap.xml`), capped at 60 pages (50 in the performance suite). An audit is a finding when its score is below 0.9 (Lighthouse's pass threshold); informative, manual and not-applicable audits are ignored. |
| Unlighthouse | `unlighthouse-ci --site <url> --reporter jsonExpanded --no-cache` | Defaults (crawler, robots.txt, sitemap, dynamic sampling 8, max 200 routes, mobile, four categories). Findings come from the per-route Lighthouse reports it writes, same rule as Lighthouse. Performance suite: `scanner.maxRoutes: 50`. |
| python-seo-analyzer | `python-seo-analyzer <url> --sitemap <sitemap from robots.txt> --output-format json` | Following links is its default. Its warnings are free text and are normalised to ids by fixed patterns (`runners/pyseoanalyzer.mjs`). |

Wall time is measured around the whole tool run (for Scrawly, from engine start to the last
export; for Lighthouse, the sum over pages). Peak RSS is the maximum summed RSS of the tool's
process tree (including Chrome), sampled from `/proc` every 250 ms.

## 5. Mappings

`bench/mappings/<tool>.json` maps each native finding id to the ground-truth defect types it
identifies. They were written from each tool's own catalogue of checks, which is saved in
`bench/mappings/catalogues/` (AVC: `avc checks --json`; Scrawly: its check registry and
agentic probe ids; Lighthouse: the audit list of 13.5.0; python-seo-analyzer: every
`warn()` string in its source). The same standard applies to every tool: a native id is
mapped when its finding clearly names the same problem as the defect.
