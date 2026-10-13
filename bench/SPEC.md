# AVC benchmark specification

Goal: a reproducible, published comparison of AI Visibility Checker (AVC) against four widely used
free or open-source site audit tools, on identical inputs, with rules fixed before any tool is run.

## Tools under test

| Tool | Why it is included | How it runs here |
| --- | --- | --- |
| AI Visibility Checker (this repo) | Subject | `avc audit` |
| Scrawly (IliasSami/scrawly-seo-crawler) | Closest open-source competitor: full-site SEO + GEO + agentic audit | Python package from its repo |
| Google Lighthouse 13 | The most widely used audit engine (SEO, accessibility, best practices, agentic browsing) | `lighthouse` CLI, per page |
| Unlighthouse | Popular site-wide Lighthouse scanner | `unlighthouse` CLI |
| python-seo-analyzer (pyseoanalyzer) | Popular open-source Python SEO crawler | `python-seo-analyzer` CLI |

Not tested: Screaming Frog, Sitebulb, Ahrefs, Semrush and similar commercial tools. They need paid
licences or accounts and could not be run under the same conditions. No claims are made about them.

## Suites

1. **Detection (ground truth).** `bench/site/` is a static site served locally, with planted defects
   listed in `bench/ground-truth.json` and clean control pages. Defects come from public sources
   (Google Search Central, web.dev/Lighthouse audits, WCAG, robots.txt RFC 9309, llmstxt.org, MCP /
   A2A / OAuth discovery specs, and the topic list of Scrawly's own check manifest) so that every
   tool is tested on things it claims to cover. Areas: technical SEO, content/on-page,
   accessibility, AI crawler access, AEO/GEO readiness, agentic web.
   - Recall = planted defects a tool reports / planted defects in that area.
   - Precision = findings that match a planted defect / all findings of mapped types on the site
     (findings on clean control pages count against the tool).
   - A finding matches a defect when its type maps to the defect's type in
     `bench/mappings/<tool>.json` AND it names the defect's URL (or is site-wide for site-wide
     defects). Mapping tables are written from each tool's documentation and output, and published.
2. **Performance.** A generated 1,000-page site; wall time and peak RSS for a full audit with each
   tool's default settings (Lighthouse-based tools on a 50-page sample, stated as such).
3. **Capabilities.** Feature matrix verified from each tool's code or docs, with links.

## Fairness rules

- Same machine, same local server, no network beyond localhost.
- Default settings, plus the documented options a normal user would set to audit a whole site
  (stated per tool in the results).
- The ground-truth site is built without reference to AVC's check list.
- AVC improvements made after a run must be general (they must make sense on any site) and are
  listed in the results with the run they followed. No site-specific special-casing.
- Every script, fixture, mapping and raw output is committed under `bench/`.
