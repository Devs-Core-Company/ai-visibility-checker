# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [semantic versioning](https://semver.org). Check ids are stable across versions.

## [Unreleased]

### Changed

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
