# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [semantic versioning](https://semver.org). Check ids are stable across versions.

## [Unreleased]

### Added

- `avc setup-claude`: connects the MCP server to the Claude desktop app, Claude Code (user scope,
  every folder) and Cursor in one step, with absolute paths so the desktop app finds Node without
  your shell's PATH. The one-line installers run it (`AVC_SKIP_CLAUDE=1` to skip).

### Added

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
