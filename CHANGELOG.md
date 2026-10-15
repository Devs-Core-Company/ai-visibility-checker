# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [semantic versioning](https://semver.org). Check ids are stable across versions.

## [Unreleased]

## [1.1.0] - 2026-10-15

### Fixed

- Dashboard forms were refused as "cross-origin" in Chrome: with `Referrer-Policy: no-referrer` the
  browser sends `Origin: null` on form posts. The dashboard now sends `same-origin` and accepts
  `Origin: null` only when the browser marks the request `Sec-Fetch-Site: same-origin`.
- The MCP server (and every command) crashed with "No such built-in module: node:sqlite" on
  Node 22.5 to 22.12, where node:sqlite needs `--experimental-sqlite`. The launcher now adds the
  flag on those versions.
- No AI key no longer means silent sample answers: AI steps are skipped, and the CLI, reports,
  dashboard and MCP tools say what was skipped and why. `--mock` still gives sample answers.

### Security

- API keys move from `~/.avc/config.json` to the OS keychain (macOS Keychain, Linux Secret
  Service, Windows DPAPI; a mode-600 file where none exists). Existing keys are migrated on first
  run. Keys in the committed `avc.config.json` are ignored with a warning. The dashboard no longer
  shows the last four characters of a key.

### Added

- `avc uninstall`: removes AVC from Claude Desktop, Claude Code (including per-folder entries) and
  Cursor, the `avc shortcut` launcher and scheduled runs from `avc schedule`, deletes stored API keys
  and, if asked, local data (only files AVC created). Uninstall steps in the README and INSTALL.md.
- The AVC logo: the Claude Desktop extension's icon, the MCP server's announced icon (`serverInfo.icons`,
  for clients that show one) and the dashboard's browser-tab icon.
- Claude Desktop extension (`npm run bundle:mcpb` → `build/ai-visibility-checker-<version>.mcpb`) with
  a settings page for API keys and spend caps under Settings → Extensions. Key fields are masked and
  kept in the system's secure storage by Claude Desktop.
- Dashboard **API keys** page: add, replace, test (one free provider request) and remove keys. Saved
  keys show only as `••••••••` and are never sent back to the browser.
- `avc keys` (`status`, `setup`, `set`, `remove`): hidden-prompt key entry, never via arguments.
  `avc init`, the first `avc audit`, `avc audit --visibility` and `avc visibility` offer it when a
  key is missing.
- MCP `setup_keys` and `keys_status`: keys are typed on a one-time page on the user's computer
  (URL elicitation where the client supports it), never through the chat.
- `audit_site` (MCP) returns a `skipped` summary and sends progress notifications.
- `avc doctor` reports where keys are stored and any left in a config file.
- `avc setup-claude`: connects the MCP server to the Claude desktop app, Claude Code (user scope,
  every folder) and Cursor in one step, with absolute paths so the desktop app finds Node without
  your shell's PATH. The one-line installers run it (`AVC_SKIP_CLAUDE=1` to skip).
- 13 standards-based checks after benchmark run 1 (bench/results/CHANGES.md): unknown schema.org
  types (full vocabulary), end dates before start dates, location pages missing LocalBusiness
  markup their siblings have, markup phone numbers not shown on the page, RFC 9116 security.txt
  fields, main content copied from another page, broken markdown alternates, loading
  placeholders replaced by JavaScript, AI bots blocked from sections by robots.txt, invalid WebMCP
  input schemas, unreachable A2A endpoints, broken api-catalog links, invalid autocomplete tokens.
- 36 checks (630 in total), including meta descriptions too thin for AI, doctype, mixed redirect
  codes per section, cannibalisation, doubled words, spelling (LanguageTool), PDF titles,
  meaning-based duplicates and off-topic pages (embeddings), oversized images, image sitemap
  entries, TLS certificate expiry and trust, unminified CSS/JS files, phone-render checks (tap
  targets, sideways scrolling, content parity, pop-ups, failing resources, small text), ARIA role
  nesting, rendered contrast, deep pagination, unsafe outbound links (Safe Browsing), GA4 AI
  referrals, gated content, first-party facts, and agent discovery (Link header, DNS-AID, auth.md,
  agent skills, ACP).
- Crawl options: list mode, sitemap-only, presets per platform (with auto-detection), URL rewriting,
  subdomains, folder scope, URL limits, nofollow toggle, robots user agent, retries on 429/503,
  own CDN hosts, form sign-in, custom extraction (CSS, simple XPath, regex, counts), content-area
  selectors, PDF properties, phone render, shadow DOM and iframe text, named crawl profiles.
- `avc serp`, `avc ask`, `avc screenshot`, `avc import` (Screaming Frog CSV), `avc redirect`,
  `avc presets`, `avc update`, `avc shortcut`, `avc feedback`.
- Reports: Excel and PDF formats, white-label branding, custom extraction CSV.
- Connections: LanguageTool, Google Safe Browsing, embeddings, backlinks (Moz, Ahrefs, Majestic),
  OpenAI-compatible endpoints for the writer, judge and embeddings.
- WordPress: canonical writes, redirects and a two-SEO-plugin guard (helper 1.1.0).
- MCP tools: `list_audits`, `pagespeed`, `serp_preview`, `ask_audit`, `generate_report`,
  `create_redirect`, `rollback`.
- Dashboard: site graph and URL tree, resources, snippets, ask, page filter rules, screenshots,
  feedback link.
- Fix overrides (`fixes.overrides`) for your own guidance per check.
- Stack detection for Magento and Laravel.
- docs/PARITY.md: line-by-line comparison with Scrawly.

### Changed

- `--render` now renders every crawled page (desktop and phone) instead of stopping at 50; CLS is
  observed until 1.5 s after load and in the phone render (Lighthouse's 412×823 viewport); AI-bot
  sample fetches cover each site section; security headers and version leaks are checked per page
  and over HTTP; several thresholds now follow Lighthouse (unsized images, text compression, link
  text). See bench/results/CHANGES.md for the full list and rationale.
- `onpage.title-too-long` and `onpage.description-too-long` also measure pixel width.
- Accessibility checks use the rendered DOM when a page was rendered.
- JavaScript rendering serves a blank stand-in for images instead of aborting them, so rendered
  image sizes are measured.
- Licence changed from MIT to the GNU Affero General Public License v3.0 only (AGPL-3.0-only).
  Commercial licences are available from Devs Core. Commit `f13a0c9` and earlier remain available
  under MIT.

## [1.0.0] - 2026-10-13

First public release.

### Added

- `avc` command: `init`, `audit`, `visibility`, `prompts suggest`, `fix`, `rollback`, `generate`,
  `connect`, `logs`, `diff`, `history`, `report`, `sites`, `schedule`, `monitor`, `ui`, `mcp`,
  `checks`, `doctor`.
- Full-site crawler with robots.txt, sitemaps, optional JavaScript rendering in local Chrome, and
  stack detection.
- Checks for technical SEO, content, AI crawler access, AEO/GEO readiness and the agentic web.
- Live fetch of the home page as each AI crawler, with firewall and challenge detection.
- AI visibility tracking with your own keys or one Vercel AI Gateway key: mentions, share of voice,
  competitor wins, citations, sentiment, fact-checks, repeated runs, spend caps.
- Stack-aware fixes with agent prompts; WordPress auto-apply with rollback; local repo patches.
- Generators for llms.txt, robots.txt AI rules, Organization JSON-LD and an A2A agent card.
- Connections: Google Search Console, GA4, PageSpeed Insights, Bing Webmaster Tools and IndexNow,
  server access logs, WordPress.
- Local history in SQLite, diffs, trends, scheduled runs, webhook and email alerts.
- Reports in HTML, Markdown, CSV, JSON and SARIF; GitHub Action.
- Local dashboard (`avc ui`) and MCP server (`avc mcp`).
- Installers for macOS, Linux and Windows; Dockerfile and docker-compose.
