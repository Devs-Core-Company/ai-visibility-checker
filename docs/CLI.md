# CLI reference

`avc <command> [options]`. Run `avc <command> --help` for the full option list.
A site argument can be a URL (`https://example.com`, or just `example.com`) or the id of a
configured site (the host without `www.`).

## Setup

### `avc init`

Asks for the site URL, brand name, competitors and location, writes `avc.config.json` in the current
folder (safe to commit), and explains which keys to set.

```
--url <url>  --brand <name>  --competitors <a,b>  --user (save to ~/.avc/config.json)  -y, --yes
```

### `avc sites [list|add|remove]`

List configured sites (and sites that only exist in history), add one (`avc sites add <url>
--name "Brand"`), or remove one (`--purge` also deletes its history).

### `avc doctor`

Checks Node, SQLite, Chrome, the data folder, AI keys, spend, sites and connections. `--json` for
machine-readable output. Exits 1 if something essential is missing.

### `avc connect <source> [site]`

`google | gsc | ga4 | psi | bing | wordpress | logs | repo | status`. Saves the settings, runs the
Google sign-in when needed, then tests the connection. Options: `--property`, `--key`,
`--client-id`, `--client-secret`, `--service-account <file>`, `--wp-url`, `--wp-user`,
`--wp-app-password`, `--path <paths>`, `--no-test`. See [CONNECTIONS.md](CONNECTIONS.md).

## Audits

### `avc audit <url>`

| Option | Meaning |
| --- | --- |
| `--max-pages <n>` | Stop after n pages (0 = no limit). Default 500 or the site config. |
| `--depth <n>` | Maximum click depth. |
| `--render` / `--no-render` | Always / never render with Chrome. Default: `auto`. |
| `--include <regex>`, `--exclude <regex>` | URL filters for the crawl (repeatable). |
| `--only <sel>`, `--skip <sel>` | Checks to run or skip: ids, id prefixes, categories or pillars. |
| `--visibility` | Also run an AI visibility check (uses your keys). |
| `--engines <list>`, `--repeats <n>`, `--mock` | Options for `--visibility`. |
| `-f, --format <list>` | `html,json,md,csv,sarif`. Default `html,json`. |
| `-o, --out <dir>` | Report folder. Default `avc-reports`. |
| `--fail-under <score>` | Exit with code 2 when the score is below this. |
| `--open` | Open the HTML report. |
| `--json` | Print the full result to stdout. |
| `-q, --quiet`, `--no-save` | No progress output; do not store in history. |

The terminal shows a progress line, the score and pillars, the top 10 priorities with their first
fix step, the change since the last audit, and where the reports were saved.

Exit codes: `0` done, `1` error, `2` score below `--fail-under`.

### `avc report [auditId]`

Writes report files for a stored audit (`latest`, an audit id, or a site). `-f`, `-o`, `--open`.

### `avc diff [a] [b]`

Compare two audits. With one site argument it compares that site's last two audits. `--md` prints
Markdown (what the GitHub Action posts), `--json` the raw diff.

### `avc history [site]`

Stored audits with score changes, and AI visibility runs. `-n` limit, `--json`.

### `avc checks`

Every check. Filter with `--pillar`, `--category`, `--search`; `--json` for everything.

## AI visibility

### `avc visibility <url>`

Reads the site briefly to learn the brand, then asks each engine every prompt. Shows the prompt,
engine and answer counts and an upper-bound cost estimate, and asks before spending (`--yes` skips
the question; required when not in a terminal).

`--prompts <file>` (one per line, or JSON), `--engines chatgpt,claude,gemini,perplexity,grok,deepseek`,
`--repeats <n>`, `--mock`, `--json`.

### `avc prompts suggest <url>`

Suggested prompts (category, comparison, problem and brand). `--save` stores them on the site.

## Fixes

### `avc fix [site|auditId]`

Without `--target`: the ranked fix plan for the latest audit, with stack-specific steps and files.
With `--target wordpress` or `--target repo [--repo <path>]`: a dry-run preview of the changes.
Add `--apply` to make them (asks first unless `--yes`). WordPress changes print the rollback
snapshot path. `--only <checks>`, `--json`.

### `avc rollback <file>`

Restores the values saved in a WordPress snapshot.

### `avc generate <kind> <url>`

`llms-txt | robots | schema | agent-card`. Uses the latest audit (or crawls 100 pages first;
`--fresh` forces a new crawl). `--policy allow-all|allow-search|block-training|block-all` for
robots.txt. `-o <file>` to write a file.

### `avc logs <files…>`

AI crawler visits from access logs (plain or gzipped; Nginx, Apache, Caddy and similar formats).
Verifies bots by published IP ranges and reverse DNS (`--no-verify` to skip). `--site` lists key
pages no AI bot fetched. `--json`.

## Monitoring

### `avc schedule <site> --cron "<expr>" [--visibility-cron "<expr>"]`

Saves the schedule and prints the line for cron, launchd or Task Scheduler. Nothing is installed
on your system without you doing it.

### `avc monitor` / `avc monitor run <site>`

`avc monitor` runs every schedule in the foreground. `avc monitor run <site>` runs one job now:
audit (or `--visibility`), diff against the last one, send alerts (`--dry-run-alerts` prints them).

## Surfaces

### `avc ui`

The dashboard on `http://127.0.0.1:4317`. `--port`, `--no-open`, `--monitor` (run schedules while
open), `--host` (listen on another interface; prints a warning). See [DASHBOARD.md](DASHBOARD.md).

### `avc mcp`

MCP server on stdio. See [MCP.md](MCP.md).

## Environment

`AVC_DATA_DIR`, `AVC_LLM_MOCK`, `AVC_CHROME_PATH`, `AVC_VERBOSE=1` (show info logs), `AVC_DEBUG=1`
(stack traces), `NO_COLOR`. Keys: see [INSTALL.md](INSTALL.md#keys).
