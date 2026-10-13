# Dashboard

```bash
avc ui            # http://127.0.0.1:4317
avc ui --monitor  # also run scheduled audits while it is open
```

The terminal prints a link with a one-time session token and opens it in your browser. Keep the
terminal open while you use the dashboard; Ctrl+C stops it. It works offline (no CDN fonts or
scripts), is keyboard friendly, and works on a phone-sized screen.

## Pages

**Sites.** Every configured site with its last score and a trend line. Add a site with its URL,
brand name and competitors.

**Overview.** Score gauge and grade, the six pillars, issue counts by severity, AI mention rate
trend, the fixes to do first, the next scheduled run and which connections are set up. Export the
audit as HTML, PDF, Excel, Markdown, CSV (issues, pages or custom extraction), JSON or SARIF.

**Run audit.** Start URL, page and depth limits, JavaScript rendering, URL include/exclude
patterns, a check filter and an optional AI visibility run. Progress streams live; you can cancel.

**Issues.** Filter by pillar, category and severity, or search. Grouped by check, worst first. Each
group shows why it matters, the affected URLs, the fix for your stack with a copy button for the
snippet, and a **Copy prompt for Claude Code / Cursor** button.

**Pages.** Every crawled URL: status, title, words in raw HTML and after JavaScript, depth, inlinks,
issues and indexability. Sort any column, filter by status, indexability, depth, words, inlinks,
issues or schema type, and add up to three field/operator/value rules. Click a page for all its
issues, the raw vs rendered comparison, its structured data, custom extraction results and a
desktop or phone screenshot.

**Site graph.** The internal link graph (drag, zoom, click a page to open it), pages per click
depth, and the URL folder tree.

**Resources.** Scripts, stylesheets and images with how many pages use each, size and status;
filter by type and by first or third party.

**Snippets.** Titles and descriptions as they would look in search results, with pixel widths and
descriptions too thin to give AI context.

**AI crawlers.** For each known AI crawler: what robots.txt decides and the line that decides it,
the live fetch verdict (ok, blocked, challenge, different content), and verified real visits from
your server logs when connected. Also errors served to bots and key pages no AI bot fetched.

**Agentic web.** The origin probes (llms.txt, MCP server card, A2A agent card, OAuth discovery,
markdown negotiation, Web Bot Auth, commerce rails and more), the llms.txt structure, and
generators with preview, copy and download for llms.txt, robots.txt, JSON-LD and an agent card.

**AI visibility.** Edit the prompts you track (or load suggestions), pick engines, set repeats, and
see an estimate before you run. Results: mention rate and position by engine, share of voice,
prompts where competitors win and the sources they used, "why not you" gaps with pages to create or
improve, your cited pages, the most cited domains, every answer with citations and fact-check
notes, and the trend across runs.

**Fixes.** The full plan. Preview changes for WordPress or a local repo as a diff, apply them after
ticking a confirmation, and roll back WordPress changes from a snapshot.

**Connections.** Status of every source, with a test button. Google sign-in, Search Console and GA4
properties, PageSpeed and Bing keys, log paths, WordPress application password and repo path. Setup
steps: [CONNECTIONS.md](CONNECTIONS.md).

**History & diff.** Pick any two audits to compare score, pillars, new and fixed issues, pages and
AI visibility. Set the audit and AI visibility schedules.

**Ask.** Ask a question about the latest audit; answered by your writer model, or from the ranked
priorities without a key.

**Settings.** AI keys (shown masked), mock mode, spend caps, and alert webhook and email with a
"send a test alert" button.

**All checks.** The searchable check catalogue.

## Security

- Listens on `127.0.0.1` only. `--host 0.0.0.0` (for Docker) prints a warning; bind the published
  port to `127.0.0.1` on the host.
- Every request needs the session cookie, set from the token in the printed link (HttpOnly,
  SameSite=Strict). Other websites and local programs cannot use the dashboard without it.
- Requests with an unexpected `Host` header are refused, which blocks DNS-rebinding attacks.
  Form posts must come from the dashboard's own origin.
- A strict Content Security Policy allows only the dashboard's own scripts.
- Keys you save go to `~/.avc/config.json` with file mode 600 and are never shown in full.
- `AVC_UI_TOKEN` sets a fixed token (for example in Docker); otherwise a new random one is made at
  each start.
