# Changes between benchmark runs

Rules for these changes are in [SPEC.md](../SPEC.md) ("Fairness rules"): AVC changes must be
general rules that are correct on any website, based on public standards, and listed here with
the run they followed. Nothing below names a path, page, colour, number or text of the
benchmark site. The ground truth and the site were not changed.

## Changes after run 1

Run 1 (all five tools, 2026-10-13): AVC recall 77% (93/121), precision 80%, 2 findings on
control pages. Every one of AVC's 28 misses and every false positive in run 1 was classified
as one of: a detection gap in AVC, a mapping gap, a URL-attribution mismatch in the scorer, or
a ground-truth judgement AVC disagrees with. The fixes follow.

### Scorer (applies identically to every tool; all five tools re-scored)

- **`related_url` names the defect too.** Page-scope defects that describe a relationship
  between two URLs carry the other end in `related_url` (the hreflang partner, the target of
  an internal link to a redirect, a canonical target, a nofollowed link target). A tool may
  attach such a finding to either end, exactly as the existing `found_on` rule already allows
  for broken links. A finding now matches when its URL is the defect's `url`, `found_on` or
  `related_url`; the finding's type must still map to the defect's type. Site-scope defects
  are unaffected. Effect on run-1 findings: AVC +1 (hreflang return link reported on the page
  that declares it), Scrawly +1, other tools unchanged. Implemented in `bench/score.mjs`
  (`loadGroundTruth`).

### Mappings (`bench/mappings/avc.json`; same standard as for the other tools)

New or newly mapped AVC ids, each mapped only to the ground-truth type its finding names:

| AVC id                                | Ground-truth type                  | Note                                                                                             |
| ------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `response.doctype-missing`            | `missing-doctype`                  | existed in run 1 (it found the defect) but had been left out of the mapping                      |
| `accessibility.low-contrast-rendered` | `low-contrast-text`                | existed in run 1, unmapped; same problem as `low-contrast-inline`, measured from computed styles |
| `geo-content.date-invalid`            | + `date-modified-before-published` | its message for this case is "dateModified is before datePublished"                              |
| `schema.type-unknown`                 | `schema-unknown-type`              | new check                                                                                        |
| `schema.date-order`                   | `schema-invalid-value`             | new check                                                                                        |
| `schema.localbusiness-missing`        | `missing-localbusiness-schema`     | new check                                                                                        |
| `geo-entity.nap-page-mismatch`        | `nap-inconsistent`                 | new check                                                                                        |
| `security.security-txt-invalid`       | `security-txt-invalid`             | new check                                                                                        |
| `duplicates.copied-content`           | `duplicate-content`                | new check                                                                                        |
| `llms-txt.markdown-alternate-broken`  | `markdown-alternate-broken`        | new check                                                                                        |
| `js-rendering.loading-placeholder`    | `client-side-rendered-content`     | new check                                                                                        |
| `ai-crawlers.path-blocked`            | `robots-blocks-ai-bot-path`        | new check                                                                                        |
| `agentic.webmcp-schema-invalid`       | `webmcp-schema-invalid`            | new check                                                                                        |
| `agentic.a2a-endpoint-unreachable`    | `a2a-endpoint-unreachable`         | new check                                                                                        |
| `agentic.api-catalog-broken-link`     | `api-catalog-broken-link`          | new check                                                                                        |
| `accessibility.autocomplete-invalid`  | `autocomplete-invalid`             | new check                                                                                        |

`bench/mappings/catalogues/avc.json` was regenerated from `avc checks --json`.

### AVC: new checks

| Check                                | General rule                                                                                                                                                                                                                                                                        | Standard                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `schema.type-unknown`                | An `@type` in a schema.org context that is not in the schema.org vocabulary (full type list of release 29.3, core and extensions, in `src/checks/schema-vocabulary.ts`), with a spelling suggestion. Other vocabularies and prefixed types are skipped.                             | schema.org                                                               |
| `schema.date-order`                  | `endDate` before `startDate` (also `validThrough`/`validFrom` and similar pairs).                                                                                                                                                                                                   | schema.org, Google Event docs                                            |
| `schema.localbusiness-missing`       | A page in a folder where at least two and two thirds of the sibling pages carry LocalBusiness (any subtype) markup, but this page has none.                                                                                                                                         | Google LocalBusiness docs                                                |
| `geo-entity.nap-page-mismatch`       | The telephone in the LocalBusiness/Organization node describing this page (its `url`/`@id`) is not among the numbers the page shows (click-to-call links and phone numbers in the text).                                                                                            | Google structured-data policies ("markup must describe visible content") |
| `security.security-txt-invalid`      | security.txt without a Contact or Expires field, Expires repeated, not RFC 3339, passed, or more than a year ahead.                                                                                                                                                                 | RFC 9116                                                                 |
| `duplicates.copied-content`          | At least half of a page's main-content text (60+ words) is copied word for word from one other page (paragraphs shared by exactly two pages; template text on 3+ pages and listing pages are excluded). Whole-page duplicate checks miss this because navigation and footer differ. | Google duplicate-content guidance                                        |
| `llms-txt.markdown-alternate-broken` | `<link rel="alternate" type="text/markdown">` whose URL returns an error. Reported on the advertising page.                                                                                                                                                                         | HTML rel=alternate, llmstxt.org                                          |
| `js-rendering.loading-placeholder`   | The raw HTML's main content shows a short loading placeholder ("Loading…", "Please wait") that is gone after rendering, and rendering added text.                                                                                                                                   | Google JavaScript SEO basics                                             |
| `ai-crawlers.path-blocked`           | A bot-specific robots.txt group disallows indexable pages for an AI crawler while the site root is allowed (all purposes, including training bots).                                                                                                                                 | RFC 9309; OpenAI, Anthropic crawler docs                                 |
| `agentic.webmcp-schema-invalid`      | A WebMCP tool's `inputSchema` (captured at runtime in the render) is not valid JSON Schema (type outside the seven JSON types, `required` not an array of strings, properties not schemas…) or its top-level type is not `object`.                                                  | JSON Schema 2020-12, WebMCP, MCP                                         |
| `agentic.a2a-endpoint-unreachable`   | The agent card's `url` (and `additionalInterfaces`) returns 404/410/5xx or does not answer. 405 or 401/403 count as present.                                                                                                                                                        | A2A specification                                                        |
| `agentic.api-catalog-broken-link`    | A `service-desc`/`service-doc`/`service-meta`/`status` href in /.well-known/api-catalog returns 404/410/5xx or does not answer.                                                                                                                                                     | RFC 9727, RFC 8631                                                       |
| `accessibility.autocomplete-invalid` | `autocomplete` values outside the WHATWG autofill grammar (e.g. "e-mail", "phone").                                                                                                                                                                                                 | WHATWG HTML autofill, WCAG 1.3.5                                         |

Each new check has tests (`test/checks-standards.test.ts`) and a fix recipe
(`src/fixes/recipes/standards.ts`, or the existing category recipe where it fits).

### AVC: improved checks

| Check                                                                                            | Change                                                                                                                                                                                                                       | Why it is correct in general                                                                                             |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `images.dimensions-missing`                                                                      | Reports one image without width/height (was two or more); images whose inline style sets an aspect ratio or both dimensions are exempt.                                                                                      | Lighthouse `unsized-images` fails on any unsized image.                                                                  |
| `performance.no-compression`                                                                     | Measures the saving instead of a 10 KB size floor: reported when gzip would save at least 1,400 bytes and 10%. The crawler now sends `Accept-Encoding: gzip, deflate, br` explicitly.                                        | Lighthouse `uses-text-compression` thresholds.                                                                           |
| `security.csp-missing`, `nosniff-missing`, `frame-protection-missing`, `referrer-policy-missing` | Checked on every HTML page, over HTTP too (only HSTS stays HTTPS-only). When some pages send a header and others do not, each page without it is reported; when none do, one site-wide finding.                              | These headers protect on HTTP as well; a header missing on some routes is a server/CDN misconfiguration of those routes. |
| `security.version-disclosure`                                                                    | Checks every HTML page, not only the home page; one finding when every page leaks the same versions.                                                                                                                         | Version leaks are often per route (one app behind a proxy).                                                              |
| `links-internal.generic-anchors`                                                                 | One generic anchor is enough (was three). Digits are kept when matching, so "Page 2" is not read as "page".                                                                                                                  | Lighthouse `link-text` fails on a single generic link.                                                                   |
| `accessibility.list-structure`                                                                   | Also reports elements other than `<li>`, `<script>` or `<template>` directly inside `<ul>`/`<ol>`.                                                                                                                           | HTML content model; axe `list` rule.                                                                                     |
| `accessibility.low-contrast-rendered`                                                            | One sample below the WCAG ratio is enough (was two).                                                                                                                                                                         | WCAG 1.4.3 applies to each text element.                                                                                 |
| `accessibility.clickable-div`                                                                    | Also uses the render: elements with their own `cursor: pointer` that are not links, buttons or form controls and have no role or tabindex (handlers attached from scripts, often delegated, are invisible in HTML).          | WAI-ARIA APG button pattern; WCAG 2.1.1, 4.1.2.                                                                          |
| `headings.no-subheadings`                                                                        | Counts headings and words in the main content only (headings in header, nav, aside and footer no longer count; link lists are not running text). Threshold 350 words (was 600 of whole-page text).                           | Yoast readability guidance: sections over 300–350 words need a subheading.                                               |
| `geo-content.no-author` / `author-not-in-schema`                                                 | A generic "byline" element counts as an author only if it names someone ("By …") or links to a person page; a byline that holds only a date no longer hides a missing author.                                                | A date is not an author (Google Article docs).                                                                           |
| `isArticleLike` (AI checks)                                                                      | Tag, category, author, archive and paginated pages are listings, not articles.                                                                                                                                               | Same rule the technical checks already used.                                                                             |
| `schema.article-missing`, `geo-content.missing-article-schema`                                   | Not reported when a JSON-LD block on the page fails to parse (the Article may be in it; `schema.invalid-json` reports the real problem).                                                                                     | Avoids a misleading second finding.                                                                                      |
| `redirects.chain`                                                                                | A redirect loop is reported only as `redirects.loop`, not also as a chain.                                                                                                                                                   | A loop never reaches a final URL.                                                                                        |
| `onpage.description-too-long`                                                                    | Reported only when the description is over 160 characters **and** its estimated width is over 920 px (was either). Arial widths added for typographic punctuation (’ “ ” – — … ·), which were counted as full-width letters. | Character and pixel limits are both estimates; requiring both removes false alarms at 149 characters.                    |

### AVC: crawler, renderer and bot sampling

- **`--render` renders every crawled page.** The CLI documents `--render` as "always render",
  but rendering stopped after 50 pages. An explicit `--render` now renders every crawled HTML
  page within `--max-pages` (desktop and phone); `auto` keeps its small sample. This makes AVC
  slower on large sites with `--render` (see the performance table).
- **Layout shift after load.** Renders of pages that run scripts keep observing for 1.5 s after
  the load event (CLS counts the page's whole life; banners and late content arrive after
  load). CLS is also measured in the phone render, now at Lighthouse's mobile viewport
  (412×823), and `performance.rendered-cls` uses the larger of the two.
- **Renders that navigate away** (meta refresh or a script redirect) are discarded, so the
  target page's content is not compared with the original page's HTML.
- **`net::ERR_BLOCKED_BY_CLIENT` console messages** come from the renderer's own blocking of
  fonts and media and are no longer recorded as page console errors.
- **WebMCP capture** now keeps each registered tool's `inputSchema` (JSON copy, 20 KB cap).
- **AI-bot sample fetches cover sections.** The live fetch of key pages as AI bots sampled the
  five most-linked pages, which on most sites are all navigation pages. It now samples eight
  pages: the most-linked page of each section/template (first path segment, and whether the
  page is below it), largest sections first, so a firewall rule on one subtree is caught.

### Run-1 false positives that remain (AVC's finding is correct; the ground truth does not list it)

- `response.client-error` on two URLs that return 404 (targets of a redirect and a canonical).
- `performance.rendered-cls` on two pages whose content is inserted by JavaScript (measured CLS above 0.1).
- `links-internal.to-canonicalised`, `links-internal.orphan`, `content.thin`, `onpage.og-missing`, `onpage.description-too-short`, `geo-content.too-few-headings`, `schema.organization-inconsistent`: real conditions on pages where the ground truth plants a different defect or none.

### Run 2 results (all five tools re-run, then `--perf`)

| Area                       |   AVC run 1 |    AVC run 2 | Best competitor run 2   |
| -------------------------- | ----------: | -----------: | ----------------------- |
| technical                  | 83% (33/40) | 100% (40/40) | Scrawly 63% (25/40)     |
| content                    | 92% (22/24) | 100% (24/24) | Scrawly 71% (17/24)     |
| accessibility              | 88% (15/17) | 100% (17/17) | Lighthouse 88% (15/17)  |
| ai-access                  |  67% (8/12) | 100% (12/12) | Scrawly 50% (6/12)      |
| geo                        |  60% (9/15) | 100% (15/15) | Scrawly 7% (1/15)       |
| agentic                    |  46% (6/13) | 100% (13/13) | Unlighthouse 15% (2/13) |
| overall recall / precision |   77% / 80% |   100% / 88% | Scrawly 47% / 19%       |
| findings on control pages  |           2 |            0 | Lighthouse 1            |

Competitors moved by at most two defects between runs: the `related_url` rule (Scrawly +1) and
run-to-run variation (Unlighthouse's dynamic sampling picked different pages: 26 → 24 defects).

Performance: AVC's full-site audit with `--render` on the 1,000-page site went from 1.6 min to
11.9 min, because `--render` now renders every page on desktop and as a phone instead of
stopping at 50. Peak memory is unchanged (about 1.1 GB). The detection run took 2.5 min (was
50 s) for the same reason.

All 121 planted defects are now found. Remaining non-matching AVC findings are listed under
"Run-1 false positives that remain"; none are on control pages.

## Changes after run 2

Run 2: AVC found 121/121 with 0 findings on control pages, but on the 1,000-page site it took
11.9 min against Scrawly's 4.0 min, because `--render` now renders every page on desktop and
as a phone. Detection was not changed after run 2; these changes are about speed and hygiene.

- **Crawl politeness adapts to the server** (like Scrapy's AutoThrottle): the pause between
  requests follows the server's own response time, capped at the old 250 ms default. robots.txt
  `Crawl-delay` is honoured, and an explicit `--delay` is used as given.
- **Renders wait for a quiet spell, not a fixed pause:** 800 ms without DOM changes, finished
  requests or layout shifts (each resets the clock), up to 5 s. Pages without scripts need no
  wait.
- **Render tabs** default to one per CPU core but one, between 2 and 4, chosen by measuring
  time and memory at 2, 3, 4, 6 and 8 tabs on the 1,000-page site; desktop and phone renders of
  a page run back to back in the same worker. Tab reuse was tried and dropped (faster, but
  memory grew without bound).
- **Launcher:** `bin/avc.mjs` no longer runs a `dist/` build older than `src/` (an intermediate
  re-run had measured a stale build; it was discarded).
- **Privacy fix:** a `--disable-features` Chrome switch added during this work replaced
  Playwright's own list and let the audit browser contact www.google.com. It was removed before
  the final run, with a regression test; a full AVC audit was then checked to make no outbound
  connections.
- **Runner:** after each tool, `bench/run.mjs` stops any browser process the tool left running
  (Unlighthouse left 24 per run), so it cannot load the machine while the next tool is
  measured.

## Final run

All five tools were re-run on both suites after the changes above, in that clean state. Those
are the numbers in [RESULTS.md](RESULTS.md) and the README.
