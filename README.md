# AI Visibility Checker

**Audit your own website for Google and AI engines, measure whether ChatGPT, Claude, Gemini and
Perplexity actually name you, and fix what holds you back.** It runs on your machine, with your
keys, against your site.

Built by [Devs Core](https://devs-core.com). Free and open source under the AGPL-3.0.

```bash
npx github:Devs-Core-Company/ai-visibility-checker audit https://yoursite.com
```

That one line crawls the site, runs every check, and writes an HTML and JSON report to
`./avc-reports`. No account, no sign-up.

## Who it is for

- **Site owners and marketers** who want to know why AI assistants recommend a competitor and not them.
- **Developers** who want fixes as code for their stack (Next.js, WordPress, Shopify, Astro, Nuxt and
  more), a prompt they can paste into Claude Code or Cursor, and a CI gate.
- **Agencies** who run the same audit on many client sites and track them over time.

## Quickstart (60 seconds)

You need [Node.js](https://nodejs.org) 22.5 or newer. Chrome is optional (for JavaScript rendering).

```bash
# Run once without installing
npx github:Devs-Core-Company/ai-visibility-checker audit https://yoursite.com

# Or install the `avc` command
npm i -g github:Devs-Core-Company/ai-visibility-checker
avc init          # your site, brand and competitors
avc audit yoursite.com
avc ui            # the dashboard, at http://127.0.0.1:4317
```

One-line installers check Node, install `avc`, then run `avc doctor`:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Devs-Core-Company/ai-visibility-checker/main/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/Devs-Core-Company/ai-visibility-checker/main/install.ps1 | iex
```

Docker (Chromium included, data in a volume):

```bash
docker build -t avc https://github.com/Devs-Core-Company/ai-visibility-checker.git
docker run --rm -v avc-data:/data -v "$PWD/avc-reports:/app/avc-reports" avc audit https://yoursite.com
```

Step-by-step setup per operating system: [docs/INSTALL.md](docs/INSTALL.md).

## What it checks

594 checks in version 1.0: 411 technical SEO, content, accessibility and CMS checks, and 183 AI
crawler, llms.txt, AEO/GEO, entity and agentic-web checks. Every check has a stable id, a severity, the reason it matters, and a fix. List them all with
`avc checks` (or `avc checks --json`). Checks that need data you have not connected are skipped
with a reason, never failed.

### 1. Technical SEO breadth

Crawlability and indexability (robots.txt, meta robots, `X-Robots-Tag`, noindex conflicts, orphan
pages, depth), response codes and redirect chains, canonicals, titles, meta descriptions and headings,
duplicate and thin content, internal and external links, images, structured data (JSON-LD, Microdata,
RDFa), hreflang, mobile, performance and Core Web Vitals, security headers and mixed content, URL
hygiene, XML sitemaps, pagination, accessibility basics, JavaScript rendering gaps, analytics and CMS
specifics.

### 2. Full-site coverage

A real crawler, not a one-page scan: follows links and sitemaps, respects robots.txt, renders
JavaScript pages in local Chrome when you ask (`--render`, or `auto` for a sample plus pages with
little raw text), and compares raw HTML with the rendered page, because most AI crawlers do not run
JavaScript. Set `--max-pages 0` for no limit.

### 3. AEO / GEO readiness

Whether pages answer questions directly (answer-first leads, question headings, FAQ and HowTo
structure), whether your entity is clear (Organization schema, `sameAs`, consistent name and
contact details), freshness signals, and whether pages are easy to quote and cite.

### 4. AI crawler access

38 AI and search crawlers (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, PerplexityBot,
Google-Extended, Applebot-Extended, Bytespider, CCBot, Meta and Amazon bots and more), each with its
operator and purpose (training, search, user-triggered fetch). For each one: what robots.txt decides
and **which line decides it**, plus a **live fetch of your home page as that bot**, compared with a
browser fetch, to catch firewalls, bot challenges (Cloudflare, Akamai, DataDome) and content that
differs. With server logs connected: **verified real visits** (IP ranges and reverse DNS), spoofed
user agents, errors served to bots, and key pages no AI bot has fetched.

### 5. Agentic-web readiness

`llms.txt` (presence, structure and a grade), `llms-full.txt`, MCP server card, A2A agent card, OAuth
protected-resource and authorisation-server discovery, Web Bot Auth, markdown content negotiation,
WebMCP form annotations, and commerce rails for agents.

### 6. Actionability: fixes you can apply

- **Stack-aware fixes.** The stack is detected (Next.js app or pages router, WordPress with Yoast or
  Rank Math, Shopify, Webflow, Astro, Nuxt, static and more), and each fix names the files to change
  with a copy-paste snippet for that stack.
- **Agent prompts.** Every fix has a ready prompt for Claude Code, Cursor or Copilot.
- **Auto-apply to WordPress** (titles, descriptions, canonicals and more through the REST API with an
  application password), with a **rollback snapshot** saved before every change.
- **Patches to a local repo**, previewed as a diff first.
- **Generators** for llms.txt, robots.txt AI rules, Organization/WebSite JSON-LD and an A2A agent card.

### 7. Ongoing monitoring

Scheduled audits and AI visibility runs (`avc schedule`, `avc monitor`, or your system scheduler),
diffs between any two audits, trends, and alerts by webhook (Slack, Discord, Teams) or email when the
score drops, a critical issue appears, a key page goes noindex, an AI bot gets blocked, robots.txt or
llms.txt changes, or a competitor overtakes you. Plus a GitHub Action for CI.

### Plus: real AI visibility tracking

Readiness is half the picture. `avc visibility` asks the engines the questions your customers ask,
using **your own API keys** (OpenAI, Anthropic, Google, Perplexity, xAI) or **one Vercel AI Gateway
key**, and measures:

- **mention rate** and average position, per engine,
- **share of voice** against your competitors,
- **competitor wins**: prompts where a competitor is named and you are not, with the sources they used,
- **citations**: which of your pages are cited, and which other domains are,
- **sentiment** and **fact-checks** of what the engines say about you, against your own site,
- **why not you**: likely gaps per prompt, and the pages to create or improve,
- **repeated runs** (`--repeats`) to see how much answers vary.

Answers come from the providers' APIs (with web search where the engine supports it). They are
samples, not recordings of the consumer apps, and can differ from what a person sees.

## Free web version vs this app

Devs Core also runs a free web checker at
[devs-core.com/ai-visibility-checker](https://devs-core.com/ai-visibility-checker).

|                      | Free web checker                   | This app                                                                             |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| Install              | None, in the browser               | Node 22+, or Docker                                                                  |
| Which site           | Any URL                            | Your own sites                                                                       |
| Scope                | Instant scan of the page you enter | Full-site crawl, every page                                                          |
| AI visibility        | Sample, gated by email             | Your prompts, your engines, repeats, history                                         |
| JavaScript rendering | No                                 | Yes, with local Chrome                                                               |
| Connected data       | No                                 | Search Console, GA4, PageSpeed/CrUX, Bing, server logs                               |
| Fixes                | Advice                             | Stack-specific code, agent prompts, WordPress auto-apply with rollback, repo patches |
| Monitoring           | No                                 | Schedules, diffs, trends, alerts, GitHub Action                                      |
| Where it runs        | Devs Core servers                  | Your machine                                                                         |
| Cost                 | Free                               | Free (AGPL-3.0); AI checks use your own API keys                                     |

Use the web version for a quick look at any site; use this app to work on your own.

## Connections

All optional. Each one unlocks more checks. Setup for each: [docs/CONNECTIONS.md](docs/CONNECTIONS.md).

| Connection              | Command                                 | What it unlocks                                                          |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| AI keys (or AI Gateway) | `avc ui` → Settings, or env vars        | Real AI visibility runs, prompt suggestions written from your site       |
| Google Search Console   | `avc connect google`, `avc connect gsc` | Clicks, impressions and queries per page; URL Inspection index status    |
| Google Analytics 4      | `avc connect ga4`                       | Sessions referred by ChatGPT, Perplexity, Gemini, Claude, Copilot        |
| PageSpeed Insights      | `avc connect psi`                       | Lab and field (CrUX) Core Web Vitals                                     |
| Bing Webmaster Tools    | `avc connect bing`                      | Bing crawl and index data (Copilot grounds on Bing); IndexNow submission |
| Server access logs      | `avc connect logs`, `avc logs <files>`  | Verified AI crawler visits, spoofed bots, errors served to bots          |
| WordPress               | `avc connect wordpress`                 | Auto-apply fixes with rollback                                           |
| Local repo              | `avc connect repo`                      | Fixes as patches to your code                                            |
| Chrome / Chromium       | install it, or `AVC_CHROME_PATH`        | Rendered vs raw HTML comparison                                          |

`avc doctor` shows what is set up and what is missing.

## Privacy

- Everything runs locally. Audits, history, OAuth tokens and snapshots live in `~/.avc` (or
  `AVC_DATA_DIR`) in a local SQLite database.
- The app only contacts: the sites you audit, and the APIs you configure (AI providers or the AI
  Gateway, Google, Bing, Wikidata for entity checks, your webhook or SMTP server).
- No telemetry, no analytics, no account.
- Secrets go in environment variables or `~/.avc/config.json` (file mode 600), never in the project
  file `avc.config.json`, which is meant to be committed.
- The dashboard listens on `127.0.0.1` only, needs a one-time session token, and rejects requests
  with an unexpected `Host` or `Origin` header.

## Costs

The app is free. AI visibility runs use your own keys and cost what your provider charges. Before a
run, the CLI and dashboard show an upper-bound estimate, and two hard caps stop spending: **per run**
(default $3) and **per calendar month** (default $30). Change them in Settings, `avc.config.json`
(`ai.maxRunUsd`, `ai.maxMonthUsd`) or `AVC_MAX_RUN_USD` / `AVC_MAX_MONTH_USD`. Use `--mock` to try
everything with sample answers and no spend. Prices in the estimate are list prices and can be out of
date; your provider's dashboard is the bill.

## MCP: use it from Claude Code, Cursor or VS Code

```bash
claude mcp add avc -- npx -y github:Devs-Core-Company/ai-visibility-checker mcp
```

Then ask: "Audit example.com and fix the top three issues in this repo." Tools include `audit_site`,
`get_issues`, `get_fix` (with agent prompts), `crawler_access`, `agentic_readiness`, `ai_visibility`
(asks before spending), `diff_audits`, generators, and `plan_fixes` / `apply_fixes` (dry run unless
confirmed). Setup for every client: [docs/MCP.md](docs/MCP.md).

## CI

```yaml
- uses: Devs-Core-Company/ai-visibility-checker/.github/actions/avc-audit@main
  with:
    url: https://yoursite.com
    fail-under: 70
```

Or call the CLI directly: `avc audit https://yoursite.com --format sarif,md --fail-under 70` exits
with code 2 when the score is below 70. SARIF uploads to GitHub code scanning. See
[docs/GITHUB_ACTION.md](docs/GITHUB_ACTION.md).

## Commands

| Command                                                   | What it does                                               |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `avc init`                                                | Set up a site: URL, brand, competitors                     |
| `avc audit <url>`                                         | Crawl and check; reports in html, json, md, csv, sarif     |
| `avc visibility <url>`                                    | Ask AI engines your prompts                                |
| `avc prompts suggest <url>`                               | Suggest prompts to track                                   |
| `avc fix [site]`                                          | Plan fixes; preview and apply to WordPress or a repo       |
| `avc rollback <file>`                                     | Undo a WordPress change                                    |
| `avc generate llms-txt\|robots\|schema\|agent-card <url>` | Generate files                                             |
| `avc connect <source>`                                    | Connect Google, GSC, GA4, PSI, Bing, logs, WordPress, repo |
| `avc logs <files…>`                                       | AI crawler visits from access logs                         |
| `avc diff`, `avc history`, `avc report`                   | Compare, list and export stored audits                     |
| `avc schedule`, `avc monitor`                             | Scheduled audits with alerts                               |
| `avc ui`                                                  | Dashboard                                                  |
| `avc mcp`                                                 | MCP server                                                 |
| `avc checks`, `avc doctor`                                | List checks; check your setup                              |

Full reference: [docs/CLI.md](docs/CLI.md). Dashboard tour: [docs/DASHBOARD.md](docs/DASHBOARD.md).
How it compares with other tools: [docs/COMPARISON.md](docs/COMPARISON.md).

## FAQ

**Does it work on any website?** The audit works on any site you can reach. Auto-apply works on
WordPress and on sites whose source code you have locally; every other stack gets exact, copy-paste
fixes.

**Do I need AI keys?** No. Audits, crawler access, agentic checks and fixes need no keys. AI
visibility needs a key for each engine you want, or one AI Gateway key. Without keys it shows sample
answers so you can see how it works.

**Can I audit a site I do not own?** It is built for your own sites. Respect the site's terms and
robots.txt; the crawler identifies itself and respects robots.txt by default.

**How big a site?** You set the limit. Memory and time grow with pages; tens of thousands of pages
work on a normal laptop with rendering off.

**Is the score the same as the web checker's?** They share the idea, not the code path. This app sees
the whole site and connected data, so its score is more complete.

## Licence

GNU Affero General Public License v3.0 only (`AGPL-3.0-only`), © 2026 Devs Core. See
[LICENSE](LICENSE).

What that means in practice:

- **Using it for your own site, your clients' sites or in your CI is free, with no obligations.**
  Running the app does not require you to publish anything.
- **If you change the code and give the app to others, or run your changed version as a service
  other people use over a network**, you must offer those people the full source of your version
  under the same licence.
- **Want to embed it in a closed product or offer it as a hosted service without sharing your
  changes?** Devs Core offers commercial licences: contact@devs-core.com.

Versions published before 13 October 2026 (commit `f13a0c9` and earlier) were released under the
MIT licence and remain available under it.

Built by [Devs Core](https://devs-core.com). Contributions welcome: [CONTRIBUTING.md](CONTRIBUTING.md).
Security reports: [SECURITY.md](SECURITY.md).
