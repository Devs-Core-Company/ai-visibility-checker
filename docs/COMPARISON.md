# How it compares

An honest comparison by capability. It is based on each tool's public documentation at the time of
writing (October 2026); check their sites for the latest. If something here is wrong or out of date,
please open an issue.

## AI Visibility Checker vs Scrawly

[Scrawly](https://github.com/IliasSami/scrawly-seo-crawler) is a free, MIT-licensed desktop SEO
crawler (Python) with technical SEO, GEO and agentic-web checks, WordPress fixes and an MCP server.
It is a good tool, and both are free and open source. The main difference: Scrawly audits whether a
site is _ready_ for AI search; this app also measures whether AI engines _actually name and cite
you_, and connects the two.

| Capability                                                                                      | Scrawly                                                                           | AI Visibility Checker                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Licence and price                                                                               | MIT, free                                                                         | AGPL-3.0, free (commercial licence available)                                                                                                                                |
| Runs on                                                                                         | Desktop app (macOS, Windows, Linux)                                               | CLI, local web dashboard, Docker, CI, MCP (macOS, Windows, Linux)                                                                                                            |
| Full-site crawl, JavaScript rendering                                                           | Yes                                                                               | Yes, with raw vs rendered comparison per page                                                                                                                                |
| Technical SEO checks                                                                            | Yes (its README lists 250 checks across all areas)                                | Yes (`avc checks` lists them)                                                                                                                                                |
| AI crawler access from robots.txt                                                               | Yes                                                                               | Yes, with the deciding robots.txt line per bot                                                                                                                               |
| Live fetch as each AI bot, firewall and challenge detection                                     | Not described in its docs                                                         | Yes                                                                                                                                                                          |
| Verified AI crawler visits from server logs                                                     | Not described in its docs                                                         | Yes (IP ranges and reverse DNS, spoofed-bot detection)                                                                                                                       |
| llms.txt                                                                                        | Presence and quality                                                              | Presence, structure and grade, plus a generator                                                                                                                              |
| Agentic web (MCP card, A2A card, OAuth discovery, markdown negotiation, Web Bot Auth, commerce) | Agentic-web checks                                                                | Yes, with probes and generators                                                                                                                                              |
| **AI visibility outcome** (do ChatGPT, Claude, Gemini, Perplexity name you)                     | No                                                                                | Yes: mentions, position, share of voice, competitor wins, citations, sentiment, fact-checks, repeat runs                                                                     |
| Gaps: why a competitor is named instead of you                                                  | No                                                                                | Yes                                                                                                                                                                          |
| Search Console, GA4                                                                             | Yes                                                                               | Yes, plus GA4 AI-assistant referral sessions                                                                                                                                 |
| PageSpeed Insights / CrUX                                                                       | Yes                                                                               | Yes                                                                                                                                                                          |
| Bing Webmaster Tools, IndexNow                                                                  | Not described in its docs                                                         | Yes                                                                                                                                                                          |
| Fixes                                                                                           | Plain-language fixes; safe WordPress fixes with rollback via its connector plugin | Stack-specific fixes (files and snippets per framework or CMS), agent prompts, WordPress auto-apply with rollback (application password, no plugin), patches to a local repo |
| AI writer for titles and descriptions                                                           | Yes (bring your own key)                                                          | Meta suggestions in the fixes module                                                                                                                                         |
| Scheduled audits, regression alerts                                                             | Yes                                                                               | Yes, plus AI visibility trends and competitor alerts; webhook and email                                                                                                      |
| Crawl-to-crawl comparison                                                                       | Yes                                                                               | Yes                                                                                                                                                                          |
| CI                                                                                              | Not described in its docs                                                         | GitHub Action, SARIF for code scanning, `--fail-under`                                                                                                                       |
| MCP server                                                                                      | Yes                                                                               | Yes, including AI visibility (with spend confirmation) and dry-run-first fix tools                                                                                           |
| Reports                                                                                         | HTML, PDF, Excel/CSV, SQLite                                                      | HTML, Markdown, CSV, JSON, SARIF                                                                                                                                             |

### Where Scrawly has something this app does not

- **A native desktop app** with an app icon and automatic updates. This app is a command plus a
  local web dashboard you open in the browser.
- **3D site graph and depth tree** visualisations of the site architecture.
- **Custom extraction** (pull your own fields from pages) and **saved crawl profiles**.
- **PDF and Excel export.** This app exports HTML (which prints to PDF) and CSV.
- **In-app feedback** without a GitHub account.

## AI Visibility Checker vs the free web checker

Devs Core's [free web checker](https://devs-core.com/ai-visibility-checker) is the quickest way to
look at any site. This app is for working on your own.

| Capability             | Free web checker                                | This app                                                          |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| Setup                  | None                                            | Node 22.5+ or Docker                                              |
| Sites                  | Any URL                                         | Your own sites                                                    |
| Coverage               | Instant scan of the URL you enter               | Whole site, every page                                            |
| JavaScript rendering   | No                                              | Yes (local Chrome)                                                |
| AI crawler access      | Yes                                             | Yes, plus logs-based verified visits                              |
| AI visibility          | Gated by email; Devs Core's prompts and engines | Your prompts, engines and keys; repeats; history and trends       |
| Connected data         | No                                              | Search Console, GA4, PageSpeed/CrUX, Bing, logs                   |
| Fixes                  | Advice                                          | Stack-specific code, agent prompts, WordPress and repo auto-apply |
| Monitoring, alerts, CI | No                                              | Yes                                                               |
| Where data goes        | Devs Core's servers                             | Stays on your machine                                             |
