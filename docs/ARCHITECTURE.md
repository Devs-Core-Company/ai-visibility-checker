# Architecture

AI Visibility Checker (AVC) is a Node.js 22+ TypeScript app that runs on the
site owner's machine (or CI, or a server). One binary, `avc`, with:

- a CLI (`avc audit`, `avc visibility`, `avc monitor`, `avc fix`, `avc connect`, `avc diff`, `avc report`),
- a local dashboard (`avc ui` → http://127.0.0.1:4317, Hono + server-rendered JSX, no build step),
- an MCP server (`avc mcp`) so Claude Code / Cursor / Claude Desktop can run audits and apply fixes,
- a GitHub Action for scheduled audits in CI.

Data stays local: SQLite at `~/.avc/avc.sqlite` (`node:sqlite`, no native build).

## The contract

`src/core/types.ts` is the shared contract. `src/core/config.ts` is config + keys.
Do not change either without updating every module that reads it.

ESM with NodeNext resolution: **relative imports end in `.js`** (`import { x } from './y.js'`).
JSX (dashboard only) uses `hono/jsx`.

## Pipeline

```
crawlSite(opts)                       src/crawl/index.ts      → SiteContext (pages, robots, sitemaps, stack)
  runAgenticProbes(site)              src/agentic/probe.ts    → site.probes
  fetchAsBots(site)                   src/agentic/bot-fetch.ts→ site.botFetches, site.browserFetch
  collectExternal(site, config)       src/connect/index.ts    → site.external (PSI, GSC, GA4, logs, WP, repo)
runChecks(site, ALL_CHECKS)           src/audit/run-checks.ts → issues + per-check status
scoreAudit(...)                       src/audit/score.ts      → overall + pillars
buildFixes(result)                    src/fixes/index.ts      → stack-aware Fix per failing check
runVisibility(brand, prompts, cfg)    src/ai/index.ts         → VisibilityRun (optional, needs keys or mock)
saveAudit / diffAudits                src/monitor/*           → history, diffs, alerts
renderHtml / markdown / csv / json    src/report/*            → files
```

`runAudit(opts, config, onProgress)` in `src/audit/index.ts` drives the whole thing and is what
the CLI, dashboard, MCP server and scheduler call.

## Module ownership (one owner per folder)

| Folder | Owns | Key exports |
| --- | --- | --- |
| `src/core/http.ts`, `src/core/url.ts`, `src/crawl/` | Fetcher, URL normalisation, crawler, page extraction, robots, sitemaps, rendering (desktop and phone), stack detection, crawl options and presets, custom extraction, PDF properties, TLS, form sign-in, Screaming Frog import, screenshots | `createFetcher`, `normaliseUrl`, `crawlSite`, `extractPage`, `loadRobots`, `loadSitemaps`, `renderPages`, `detectStack`, `resolvePreset`, `runExtractors`, `extractPdfInfo`, `readTls`, `siteFromScreamingFrog`, `captureScreenshot` |
| `src/checks/` (technical files + `_util.ts`) | Classic technical SEO, content, a11y, CMS checks | `checks: Check[]` per file |
| `src/checks/{ai-crawlers,llms-txt,geo,entity,agentic}.ts`, `src/checks/_ai-util.ts`, `src/agentic/` | AI crawler access, llms.txt, AEO/GEO, entity, agentic web, origin probes, the AI bot list | `AI_BOTS`, `runAgenticProbes`, `fetchAsBots`, `checks` |
| `src/ai/` | AI visibility outcome: engines (BYOK / AI Gateway / mock), prompts, judge, share of voice, citations, fact-check, entity | `runVisibility`, `inferBrand`, `suggestPrompts`, `availableEngines` |
| `src/fixes/` | Stack-aware fixes, agent prompts, auto-apply (WordPress with rollback, local repo patches) | `buildFix`, `buildFixes`, `applyFixes`, `rollback` |
| `src/connect/` | Google OAuth/service account, Search Console, GA4, PageSpeed, Bing, server logs, WordPress client, LanguageTool, Safe Browsing, backlinks | `collectExternal`, `googleAuth`, `analyseLogs`, `collectSpelling`, `collectSafeBrowsing`, `fetchBacklinks`, … |
| `src/audit/`, `src/monitor/`, `src/report/` | Orchestration, scoring, storage, diffs, scheduler, alerts, report files | `runAudit`, `scoreAudit`, `openStore`, `diffAudits`, `startScheduler`, `renderHtmlReport` |
| `src/cli.ts`, `src/server/`, `src/mcp/`, `README.md`, `docs/`, `scripts/`, `install.*`, `Dockerfile`, `.github/` | User surfaces and docs | — |

## Check ids

`<category>.<slug>`, kebab-case, stable forever (history and diffs key on them).
Every check declares `pillar`, `severity`, `scope`, `fixTier`, `fix`, `why`, and `requires` when it
needs optional data (render, psi, gsc, ga4, logs, llm, repo). Checks never throw and never fetch,
except site checks, which may make a few requests through `site.fetcher`.

## Scoring

Overall 0–100 from six pillars. Without an AI visibility run, its weight is redistributed
and the report says the score is "readiness only".

| Pillar | Weight |
| --- | --- |
| technical | 20 |
| content | 15 |
| ai-access | 20 |
| geo | 15 |
| agentic | 5 |
| ai-visibility | 25 |
