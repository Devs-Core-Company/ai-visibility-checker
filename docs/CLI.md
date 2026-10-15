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

### `avc keys [status|setup|set|remove]`

API keys, stored in your OS keychain (macOS Keychain, Linux Secret Service, Windows DPAPI; a
mode-600 file elsewhere). `avc keys` lists which are set (never their values) and what each one
unlocks. `avc keys setup [--ai]` asks for each at a hidden prompt, Enter to skip. `avc keys set <id>`
adds or replaces one (`--stdin` to pipe it in a script; keys are never taken as arguments, which
other users can read in the process list). `avc keys remove <id>` deletes one. Environment variables
win over stored keys. Steps that need a missing key are skipped and listed under "Skipped" with
the reason.

### `avc connect <source> [site]`

`google | gsc | ga4 | psi | bing | wordpress | logs | repo | spelling | safe-browsing | embeddings |
backlinks | status`. Saves the settings, runs the
Google sign-in when needed, then tests the connection. Options: `--property`, `--key`,
`--client-id`, `--client-secret`, `--service-account <file>`, `--wp-url`, `--wp-user`,
`--wp-app-password`, `--path <paths>`, `--no-test`. See [CONNECTIONS.md](CONNECTIONS.md).

## Audits

### `avc audit <url>`

| Option                                        | Meaning                                                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--max-pages <n>`                             | Stop after n pages (0 = no limit). Default 500 or the site config.                                                                                   |
| `--depth <n>`                                 | Maximum click depth.                                                                                                                                 |
| `--render` / `--no-render`                    | Always (every crawled HTML page, within `--max-pages`) / never render with Chrome. Default: `auto` (home page, thin pages and a sample of up to 50). |
| `--include <regex>`, `--exclude <regex>`      | URL filters for the crawl (repeatable).                                                                                                              |
| `--only <sel>`, `--skip <sel>`                | Checks to run or skip: ids, id prefixes, categories or pillars.                                                                                      |
| `--visibility`                                | Also run an AI visibility check (uses your keys).                                                                                                    |
| `--engines <list>`, `--repeats <n>`, `--mock` | Options for `--visibility`.                                                                                                                          |
| `-f, --format <list>`                         | `html,json,md,csv,sarif,xlsx,pdf`. Default `html,json`. PDF needs local Chrome.                                                                      |
| `-o, --out <dir>`                             | Report folder. Default `avc-reports`.                                                                                                                |
| `--fail-under <score>`                        | Exit with code 2 when the score is below this.                                                                                                       |
| `--open`                                      | Open the HTML report.                                                                                                                                |
| `--json`                                      | Print the full result to stdout.                                                                                                                     |
| `-q, --quiet`, `--no-save`                    | No progress output; do not store in history.                                                                                                         |

Crawl scope and options (all optional):

| Option                                                                                            | Meaning                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--profile <name>`                                                                                | Use a named crawl profile from `profiles` in `avc.config.json`.                                                                                                                                                             |
| `--preset <name>`                                                                                 | Platform preset: `auto` (detect), `wordpress`, `wordpress:woocommerce`, `wordpress:blog`, `shopify`, `magento`, `drupal`, `joomla`, `laravel`, `nextjs`, `spa`, `hosted`, `static`. See `avc presets`.                      |
| `--list <file>`                                                                                   | List mode: audit exactly these URLs (one per line), follow no links.                                                                                                                                                        |
| `--sitemap-only`                                                                                  | Crawl only the URLs in the sitemaps.                                                                                                                                                                                        |
| `--subdomains`, `--stay-in-folder`                                                                | Also crawl subdomains; or stay inside the start URL's folder.                                                                                                                                                               |
| `--no-follow-nofollow`                                                                            | Do not follow `rel="nofollow"` links.                                                                                                                                                                                       |
| `--external-links`                                                                                | Check that outbound links work (needed for Safe Browsing too).                                                                                                                                                              |
| `--ignore-robots`, `--robots-ua <token>`                                                          | Crawl disallowed URLs (still reported); obey another robots.txt group.                                                                                                                                                      |
| `--user-agent <ua>`, `--concurrency <n>`, `--delay <ms>`                                          | Crawler identity and pace. 429 and 503 answers are retried with back-off.                                                                                                                                                   |
| `--remove-param <name>`, `--rewrite "regex=>replacement"`, `--lowercase-urls`                     | URL rewriting (repeatable).                                                                                                                                                                                                 |
| `--max-url-length <n>`, `--max-query-params <n>`, `--max-folder-depth <n>`, `--max-per-depth <n>` | Skip URLs beyond these limits.                                                                                                                                                                                              |
| `--cdn <host>`                                                                                    | A host serving your own files (not counted as third party).                                                                                                                                                                 |
| `--extract "name=css:selector[@attr]"`                                                            | Custom extraction (repeatable). Also `xpath:` (simple paths such as `//div[@class='price']/text()`), `regex:` (group 1) and `count:` (number of matches). Results go to the page detail, CSV (`-extraction.csv`) and Excel. |
| `--content-selector <css>`, `--content-exclude <css>`                                             | Content area used for word counts and duplicate detection.                                                                                                                                                                  |
| `--form-login <url>`                                                                              | Sign in at this login form in Chrome first (credentials only from `AVC_FORM_USER` / `AVC_FORM_PASS`). Log-out, delete and admin links are not followed while signed in. Use an account with the least access.               |
| `--no-mobile`, `--no-pdf`                                                                         | Skip the phone render; do not read linked PDFs' properties.                                                                                                                                                                 |

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
snapshot path. `--only <checks>`, `--json`. `--wp-helper` prints the WordPress helper plugin.

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

### `avc serp [audit]`

Titles and descriptions as they would show in search results: pixel width (Arial, like Google's
desktop layout), truncation, and descriptions too thin to give AI context. Problems only unless
`--all`. `--write` drafts new titles and descriptions (your AI key, or rules without one); apply them
in your CMS or with `avc fix --target wordpress`. `--json`.

### `avc ask <question>`

Answers a question about the latest audit (`--audit <ref>` for another) with your writer model, or
from the ranked priorities without a key.

### `avc screenshot <url>`

PNG of a page as a desktop or `--mobile` phone; `--full` for the whole page; `-o <file>`.

### `avc import <csv>`

Audits a Screaming Frog "Internal: All" CSV export without crawling: status, titles,
descriptions, H1, canonicals, robots, word counts, depth, response time and URL checks. `--site`,
`-f`, `-o`, `--no-save`.

### `avc redirect <site> <from> <to>`

Adds a redirect on a connected WordPress site through the AVC helper (version 1.1+; print it with
`avc fix --wp-helper`). Dry run unless `--apply`; a rollback file is written first.
`--code 301|302|307|308`.

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

### `avc setup-claude`

Connects the MCP server to the Claude desktop app (chat), Claude Code at user scope (every folder) and
Cursor, whichever are installed. Uses absolute paths to `node` and AVC, so the desktop app finds them
without your shell's `PATH`, and backs up any config file it changes.

```bash
avc setup-claude              # all that are installed
avc setup-claude --desktop    # only the Claude desktop app (also --code, --cursor)
avc setup-claude --dry-run    # show the change, write nothing
avc setup-claude --remove     # take AVC out again
```

Then fully quit the Claude app and reopen it. Details: [MCP.md](MCP.md).

### `avc mcp`

MCP server on stdio. See [MCP.md](MCP.md).

### `avc presets`, `avc update`, `avc shortcut`, `avc feedback`

List crawl presets. Check for a newer version (`--check`) and install it with npm; nothing runs on
its own. Add (or `--remove`) an app icon that opens the dashboard. Open a prefilled GitHub issue
(or `--email`); nothing is sent until you submit it.

## Environment

`AVC_DATA_DIR`, `AVC_LLM_MOCK`, `AVC_CHROME_PATH`, `AVC_VERBOSE=1` (show info logs), `AVC_DEBUG=1`
(stack traces), `NO_COLOR`. Keys: see [INSTALL.md](INSTALL.md#keys).

Optional data sources: `AVC_FORM_USER` / `AVC_FORM_PASS` (form sign-in), `AVC_LANGUAGETOOL_URL`,
`AVC_LANGUAGETOOL_IGNORE` (comma-separated words), `AVC_SAFE_BROWSING_KEY`, `AVC_EMBEDDINGS=1`,
`AVC_EMBED_MODEL`, `AVC_MOZ_TOKEN`, `AVC_AHREFS_TOKEN`, `AVC_MAJESTIC_KEY`, and `OPENAI_BASE_URL` (an
OpenAI-compatible endpoint for the writer, judge and embeddings; AI visibility answers always come
from the real engines).
