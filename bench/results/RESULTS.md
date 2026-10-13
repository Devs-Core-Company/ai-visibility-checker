# Benchmark results

Generated 2026-10-13T20:12:30.279Z. Rules: [SPEC.md](../SPEC.md). Mappings: [mappings/](../mappings/). Raw outputs: [raw/](raw/). Changes since earlier runs: [CHANGES.md](CHANGES.md).

Ground truth: 121 planted defects in 6 areas, 12 clean control pages.

## Detection: overall

| Tool | Version | Recall | Precision | Defects found | Mapped findings | FP on controls | Unmapped findings | Pages | Time | Peak RSS |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| avc | avc 1.0.0 | 100% | 88% | 121/121 | 181 | 0 | 280 | 96 | 1.1 min | 1262 MB |
| lighthouse | lighthouse 13.5.0 | 26% | 51% | 31/121 | 77 | 1 | 130 | 60 | 11.7 min | 1497 MB |
| pyseoanalyzer | pyseoanalyzer 2025.4.3 | 6% | 13% | 7/121 | 68 | 5 | 63 | 63 | 9.2 s | 152 MB |
| scrawly | sentinelseo 1.0.0 (git 8fdebcf) | 48% | 20% | 58/121 | 447 | 45 | 851 | 88 | 32.3 s | 1490 MB |
| unlighthouse | @unlighthouse/cli 0.19.1 (lighthouse 13.5.0) | 22% | 46% | 27/121 | 61 | 2 | 112 | 51 | 8.7 min | 3192 MB |

## Recall by area

| Area | avc | lighthouse | pyseoanalyzer | scrawly | unlighthouse |
| --- | ---: | ---: | ---: | ---: | ---: |
| technical | 100% (40/40) | 28% (11/40) | 0% (0/40) | 63% (25/40) | 23% (9/40) |
| content | 100% (24/24) | 13% (3/24) | 25% (6/24) | 71% (17/24) | 13% (3/24) |
| accessibility | 100% (17/17) | 88% (15/17) | 6% (1/17) | 41% (7/17) | 82% (14/17) |
| ai-access | 100% (12/12) | 8% (1/12) | 0% (0/12) | 50% (6/12) | 0% (0/12) |
| geo | 100% (15/15) | 0% (0/15) | 0% (0/15) | 7% (1/15) | 0% (0/15) |
| agentic | 100% (13/13) | 8% (1/13) | 0% (0/13) | 15% (2/13) | 8% (1/13) |

## Precision by area

| Area | avc | lighthouse | pyseoanalyzer | scrawly | unlighthouse |
| --- | ---: | ---: | ---: | ---: | ---: |
| technical | 83% (70/84) | 28% (12/43) | – (0/0) | 31% (47/153) | 29% (10/34) |
| content | 85% (40/47) | 100% (3/3) | 12% (8/66) | 42% (25/59) | 100% (3/3) |
| accessibility | 100% (18/18) | 96% (22/23) | 50% (1/2) | 6% (12/185) | 100% (14/14) |
| ai-access | 88% (23/26) | 100% (1/1) | – (0/0) | 82% (14/17) | – (0/0) |
| geo | 90% (19/21) | – (0/0) | – (0/0) | 2% (1/47) | – (0/0) |
| agentic | 87% (13/15) | 53% (8/15) | – (0/0) | 50% (4/8) | 10% (1/10) |

## Run notes

- **avc** (avc 1.0.0): settings `{"command":"avc audit <url> --format json --out <dir> --render --max-pages 0","env":{"AVC_PSI":"off","AVC_LLM_MOCK":"1","AVC_DATA_DIR":"<tmp>","AVC_CHROME_PATH":"/opt/pw-browsers/chromium-1194/chrome-linux/chrome"},"note":"Defaults otherwise (depth 10). --max-pages 0 lifts the default 500-page cap so the whole site is audited. AVC_DATA_DIR is a throwaway folder deleted after the run."}`
- **lighthouse** (lighthouse 13.5.0): settings `{"config":"default (all categories incl. agentic-browsing; mobile; simulated throttling)","chromeFlags":"--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage","pageList":"start URL + sitemap URLs (robots.txt Sitemap lines, else /sitemap.xml), first 60","pageCap":60,"failure":"an audit is a finding when its score is below 0.9 (Lighthouse pass threshold); informative/manual/n.a. audits ignored","runs":"one page at a time, sequentially; durationMs and peakRssMb are the sum and the max over pages"}`
  - error: http://127.0.0.1:34719/services/root-canal: ERRORED_DOCUMENT_REQUEST Lighthouse was unable to reliably load the page you requested. Make sure you are testing the correct URL and that the server is properly responding to all requests. (Status code: 404)
- **pyseoanalyzer** (pyseoanalyzer 2025.4.3): settings `{"command":"python-seo-analyzer <url> --output-format json --sitemap <robots.txt sitemap>","sitemap":"http://127.0.0.1:34719/sitemap.xml","note":"follow links is the default; --analyze-headings/--analyze-extra-tags only add data, not warnings, so they were left off"}`
  - error: tool output: Error occurred during crawling: 'NoneType' object is not subscriptable
- **scrawly** (sentinelseo 1.0.0 (git 8fdebcf)): settings `{"route":"local engine HTTP API (uvicorn sentinelseo.web.api:app), as scripts/scheduled_audit.py uses it","crawl":{"max_depth":10,"max_pages":5000,"note":"all other crawl settings are Scrawly defaults (js_render on, respect_robots on, discover_sitemap on)"},"env":{"SCRAWLY_AUTO_UPDATE":"0","PLAYWRIGHT_BROWSERS_PATH":"/opt/pw-browsers"},"localhost":"no private-IP/localhost blocking exists in the crawler; nothing had to be enabled"}`
- **unlighthouse** (@unlighthouse/cli 0.19.1 (lighthouse 13.5.0)): settings `{"command":"unlighthouse-ci --site <url> --reporter jsonExpanded --no-cache","defaults":"crawler + robots.txt + sitemap, dynamicSampling 8, maxRoutes 200, mobile, 4 categories (no agentic-browsing by default)","failure":"audit score < 0.9 in the per-route Lighthouse report"}`

## Performance (generated large site)

| Tool | Pages audited | Wall time | Peak RSS | Note | Errors |
| --- | ---: | ---: | ---: | --- | --- |
| avc | 1006 | 3.9 min | 1477 MB | full site (1000 pages generated) | 0 |
| scrawly | 1006 | 3.9 min | 1490 MB | full site (1000 pages generated) | 0 |
| lighthouse | 50 | 9.6 min | 1402 MB | sample capped at 50 pages (Lighthouse-based) | 0 |
| unlighthouse | 28 | 4.7 min | 3203 MB | sample capped at 50 pages (Lighthouse-based) | 0 |
| pyseoanalyzer | 1007 | 31.5 s | 202 MB | full site (1000 pages generated) | 0 |
