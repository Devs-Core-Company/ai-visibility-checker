# Feature parity: AI Visibility Checker and Scrawly

A line-by-line comparison with [Scrawly](https://github.com/IliasSami/scrawly-seo-crawler)
(MIT, Python), read from its code and docs at commit `8fdebcf` (10 October 2026): the check
manifest (`docs/CHECK_MANIFEST.yaml`), the check implementations, the agentic probe, the crawler,
enrichment, WordPress connector, MCP server, reports, web UI and desktop launcher. AVC's side is
this repository (`avc checks --json`, `src/**`).

Every AVC feature listed here is AVC's own implementation; no Scrawly code or wording was copied.

## How to read it

- **better**: AVC does what Scrawly does and more (more cases, evidence, validation, or Scrawly's
  entry does not actually run).
- **equal**: comparable coverage.
- **weaker**: AVC covers it with less depth; the note says how.
- **missing**: AVC has nothing comparable.
- **n/a**: not a feature of Scrawly's local app, or neither tool has it.
- *Before* is AVC as of this audit; *after* is AVC with the changes listed in the notes ("New").

## Facts about Scrawly's check catalogue

- Its README says **250 checks**. Its manifest lists **241** entries: **221 active** and **20 deferred**.
- Reading the code: **45 active entries are placeholders** that only fire when the page HTML
  contains a test marker (`TRIGGER_G01` and so on), so they never fire on a real site (domains G
  outbound links, H images, I hreflang, J structured data, K07–K10 sitemaps, L02–L04/L06
  robots.txt). One more (D10) is a no-op folded into D09.
- The 20 deferred entries are implemented as site-level checks, and 5 further site-level checks
  (V13–V17) are not in the manifest.
- So Scrawly runs **195 real checks from its manifest plus 5 extra**, against AVC's **630** (`avc checks`).

## Summary

| Area | better | equal | weaker | missing | n/a | total |
| --- | --- | --- | --- | --- | --- | --- |
| Scrawly manifest checks, before | 74 | 138 | 13 | 16 | 0 | 241 |
| Scrawly manifest checks, after | 84 | 157 | 0 | 0 | 0 | 241 |
| Other capabilities, before | 22 | 37 | 11 | 44 | 2 | 117 |
| Other capabilities, after | 26 | 86 | 1 | 1 | 2 | 117 |
| **All, before** | 96 | 175 | 24 | 60 | 2 | 358 |
| **All, after** | 110 | 243 | 1 | 1 | 2 | 358 |

The remaining *weaker* and *missing* rows are explained in [Not matched](#not-matched).

## Checks

Scrawly status: **active** (runs), **placeholder** (fires only on a test marker), **no-op**,
**active/deferred (site-level)** (implemented as a site-wide check).

### Crawlability & Indexability

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| A01 | Blocked by robots.txt | deferred (site-level) | `crawlability.robots-blocks-linked-pages`, `crawlability.blocked-but-linked`, `crawlability.robots-blocks-home` | better | better | AVC names the deciding robots.txt line. |
| A02 | Robots.txt disallows CSS/JS | deferred (site-level) | `crawlability.robots-blocks-resources` | equal | equal |  |
| A03 | Robots.txt missing / returns 5xx | deferred (site-level) | `crawlability.robots-txt-missing`, `crawlability.robots-txt-server-error`, `crawlability.robots-txt-unreachable` | better | better | Missing, 5xx and unreachable are separate findings. |
| A04 | Meta robots `noindex` on key page | active | `crawlability.noindex`, `crawlability.homepage-noindex`, `crawlability.gsc-noindex-with-impressions` | better | better | Escalates the home page; GSC impressions on noindex pages. |
| A05 | X-Robots-Tag `noindex` (header) | active | `crawlability.noindex-header` | equal | equal |  |
| A06 | `noindex` + `follow` vs `noindex,nofollow` mismatch | active | `crawlability.noindex-nofollow` | missing | equal | New. Fires only when the page links to 3+ internal pages. |
| A07 | Conflicting index signals (meta vs header vs canonical) | active | `crawlability.robots-conflict`, `crawlability.noindex-canonical`, `canonical.header-mismatch` | equal | equal |  |
| A08 | `noindex` present in response but removed by JS (or vice-versa) | active | `js-rendering.robots-changed` | equal | equal |  |
| A09 | Orphan URL (in sitemap/GSC but no internal inlinks) | active | `links-internal.orphan`, `crawlability.gsc-impressions-not-crawled` | equal | equal |  |
| A10 | Excessive crawl depth (>4 clicks from home) | active | `crawlability.deep-page` | equal | equal |  |
| A11 | Crawl-budget waste: many low-value indexable URLs (params, faceted) | active | `crawlability.parameter-waste`, `crawlability.low-indexable-share` | better | better |  |
| A12 | Non-indexable page receiving internal links | active | `crawlability.noindex-linked` | equal | equal |  |
| A13 | Nofollowed internal links to important pages | active | `links-internal.nofollow` | equal | equal |  |
| A14 | Meta robots `nosnippet`/`noarchive`/`max-snippet` unexpected | active | `crawlability.snippet-restricted`, `crawlability.image-preview-restricted`, `ai-crawlers.page-nosnippet`, `ai-crawlers.page-max-snippet-low` | better | better | Separate AI-quoting impact. |
| A15 | Disallowed URL still internally linked | deferred (site-level) | `crawlability.blocked-but-linked`, `links-internal.to-blocked` | equal | equal |  |

### Response codes & redirects

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| B01 | 4xx client errors (esp. 404) | active | `response.client-error`, `response.forbidden`, `response.rate-limited` | better | better | 401/403 and 429 reported separately. |
| B02 | 5xx server errors | active | `response.server-error`, `response.error-rate` | better | better |  |
| B03 | Soft 404 (200 status, "not found" content) | active | `response.soft-404`, `response.missing-page-returns-200` | better | better | Also probes a made-up URL. |
| B04 | Broken internal links (→4xx/5xx) | deferred (site-level) | `links-internal.broken` | equal | equal |  |
| B05 | Broken external (outbound) links | deferred (site-level) | `links-external.broken` | equal | equal | Needs --external-links. |
| B06 | Redirect chains (A→B→C…) | active | `redirects.chain` | equal | equal |  |
| B07 | Redirect loops | active | `redirects.loop` | equal | equal |  |
| B08 | Temporary redirect (302/307) that should be 301/308 | active | `redirects.temporary`, `redirects.http-temporary` | equal | equal |  |
| B09 | Internal links pointing to redirects | deferred (site-level) | `links-internal.to-redirect`, `redirects.linked-internally` | equal | equal |  |
| B10 | Canonical → redirected URL | deferred (site-level) | `canonical.to-redirect` | equal | equal |  |
| B11 | Redirect to 4xx/5xx (broken redirect target) | active | `redirects.to-error` | equal | equal |  |
| B12 | Meta-refresh / JS redirect | active | `redirects.meta-refresh`, `redirects.javascript` | equal | equal |  |
| B13 | HTTP → HTTPS redirect missing | active | `redirects.http-not-redirected`, `security.http-pages` | equal | equal |  |
| B14 | Mixed redirect status across templates (migration check) | active | `redirects.mixed-status` | missing | equal | New. Groups redirects by top-level section. |

### Canonicalization

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| C01 | Missing canonical | active | `canonical.missing` | equal | equal |  |
| C02 | Non-self-referential canonical (unintended) | active | `canonical.points-elsewhere` | equal | equal |  |
| C03 | Canonical to non-indexable (noindex) URL | deferred (site-level) | `canonical.to-noindex` | equal | equal |  |
| C04 | Canonical to 4xx/5xx/redirect | active | `canonical.to-error`, `canonical.to-redirect` | equal | equal |  |
| C05 | Multiple conflicting canonicals on one page | active | `canonical.multiple` | equal | equal |  |
| C06 | Canonical set only in HTTP header vs HTML mismatch | active | `canonical.header-mismatch` | equal | equal |  |
| C07 | Canonical changed/added/removed by JS (response vs render) | active | `js-rendering.canonical-changed` | equal | equal |  |
| C08 | Cross-domain canonical (unintended) | active | `canonical.cross-domain` | equal | equal |  |
| C09 | Canonical uses relative / protocol-relative / non-absolute URL | active | `canonical.relative`, `canonical.empty`, `canonical.has-fragment` | better | better |  |
| C10 | Parameterized URL not canonicalized to clean URL | active | `canonical.parameter-self`, `canonical.keeps-parameters` | equal | equal |  |
| C11 | Paginated page 2+ canonicalized to page 1 (anti-pattern) | active | `pagination.canonical-to-first` | equal | equal |  |

### "On-page \u2014 titles, meta, headings"

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| D01 | Missing page title | active | `onpage.title-missing` | equal | equal |  |
| D02 | Duplicate titles (across URLs) | deferred (site-level) | `onpage.title-duplicate` | equal | equal |  |
| D03 | Title too long (>~60 chars / ~575px) | active | `onpage.title-too-long` | weaker | equal | Now measures characters and Arial pixel width (580 px), like Scrawly. |
| D04 | Title too short (<~30 chars) | active | `onpage.title-too-short` | equal | equal |  |
| D05 | Multiple `<title>` elements | active | `onpage.title-multiple` | equal | equal |  |
| D06 | Title same as H1 (exact) on all pages | deferred (site-level) | `onpage.title-same-as-h1` | missing | equal | New, site level (80%+ of pages). |
| D07 | Missing meta description | active | `onpage.description-missing` | equal | equal |  |
| D08 | Duplicate meta descriptions | deferred (site-level) | `onpage.description-duplicate` | equal | equal |  |
| D09 | Meta description too thin for AI | active | `onpage.description-thin-for-ai` | missing | equal | New: 70–119 characters (shorter is description-too-short). |
| D10 | Meta description too short | no-op | `onpage.description-too-short` | better | better | In Scrawly D10 is a no-op folded into D09. |
| D11 | Multiple meta descriptions | active | `onpage.description-multiple` | equal | equal |  |
| D12 | Missing H1 | active | `headings.h1-missing` | equal | equal |  |
| D13 | Multiple H1s | active | `headings.h1-multiple` | equal | equal |  |
| D14 | Duplicate H1 across URLs | deferred (site-level) | `headings.h1-duplicate` | equal | equal |  |
| D15 | Broken heading order (skips H2→H4) | active | `headings.skipped-level`, `headings.not-first` | equal | equal |  |
| D16 | Empty heading tags | active | `headings.empty`, `headings.h1-empty` | equal | equal |  |
| D17 | Title/description created or modified by JS only | active | `js-rendering.title-changed`, `js-rendering.description-changed` | equal | equal |  |
| D18 | Meta keywords tag present | active | `onpage.meta-keywords` | equal | equal |  |
| D19 | Missing/incorrect OG + Twitter Card tags | active | `onpage.og-missing`, `onpage.og-image-invalid`, `onpage.og-url-mismatch`, `onpage.twitter-card-missing` | better | better |  |
| D20 | Missing viewport meta | active | `mobile.viewport-missing` | equal | equal |  |

### "Content \u2014 duplicate, thin, quality"

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| E01 | Exact duplicate content (MD5 body hash) | deferred (site-level) | `duplicates.exact` | equal | equal |  |
| E02 | Near-duplicate content (similarity threshold) | deferred (site-level) | `duplicates.near`, `duplicates.semantic` | equal | better | Embeddings add meaning-based duplicates (opt-in). |
| E03 | Technically duplicate URLs (same path+query, dup content) | deferred (site-level) | `duplicates.url-variants` | equal | equal |  |
| E04 | Thin content (low word count / low main-content ratio) | active | `content.thin` | equal | equal |  |
| E05 | Duplicate title + meta description pair | deferred (site-level) | `duplicates.title-and-description` | equal | equal |  |
| E06 | Keyword cannibalization (same H1/title competing) | deferred (site-level) | `content.cannibalisation` | missing | better | New. Matches shared topic terms in title and H1, not only identical text. |
| E07 | Boilerplate-heavy pages (nav/footer >> main content) | active | `content.boilerplate-heavy` | equal | equal |  |
| E08 | Lorem ipsum / placeholder text detected | active | `content.lorem-ipsum`, `content.placeholder` | better | better |  |
| E09 | Spelling/grammar density anomalies (optional, LLM) | active | `content.hard-to-read`, `content.long-sentences`, `content.spelling`, `content.repeated-words` | equal | better | Scrawly E09 is a Flesch score. AVC adds LanguageTool spelling (opt-in) and doubled-word detection. |
| E10 | Low text-to-HTML ratio | active | `content.low-text-ratio` | equal | equal |  |
| E11 | Content hidden behind tabs/accordions/JS interactions | active | `ai-crawlers.hidden-content` | equal | equal |  |
| E12 | Missing/duplicate publish + modified dates | active | `content.article-date-missing`, `content.date-in-future`, `content.modified-before-published`, `geo-content.date-invalid` | better | better |  |

### Internal linking & architecture

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| F01 | Orphan pages (no internal inlinks) | active | `links-internal.orphan` | equal | equal |  |
| F02 | Pages with only 1 internal inlink | active | `links-internal.single-inlink` | equal | equal |  |
| F03 | Excessive on-page links (>~100–150) | active | `links-internal.too-many` | equal | equal |  |
| F04 | Deep pages (>3–4 clicks from home) | active | `crawlability.deep-page` | equal | equal |  |
| F05 | Broken/empty anchor text | active | `accessibility.link-name-missing` | equal | equal |  |
| F06 | Generic anchors ("click here", "read more") at scale | active | `links-internal.generic-anchors` | equal | equal |  |
| F07 | Internal links to non-canonical / redirected URLs | active | `links-internal.to-canonicalised`, `links-internal.to-redirect` | equal | equal |  |
| F08 | Uncrawlable links (JS onclick, buttons, no `href`) | active | `links-internal.uncrawlable`, `links-internal.hashbang` | better | better |  |
| F09 | Internal `nofollow` sculpting (unintended) | active | `links-internal.nofollow` | equal | equal |  |
| F10 | Links created/removed only by JS (response vs render) | active | `js-rendering.links-only-rendered` | equal | equal |  |
| F11 | No breadcrumb / weak hierarchical linking | active | `schema.breadcrumbs-missing` | equal | equal |  |
| F12 | Internal link to HTTP (from HTTPS page) | active | `links-internal.insecure` | equal | equal |  |

### External / outbound links

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| G01 | Broken outbound links (4xx/5xx) | placeholder | `links-external.broken` | better | better | Scrawly G01 is a placeholder (fires only on a test marker). |
| G02 | Outbound links to redirecting URLs | placeholder | `links-external.redirecting` | better | better | Scrawly: placeholder. |
| G03 | Links to non-secure (HTTP) external resources | placeholder | `links-external.insecure` | better | better | Scrawly: placeholder. |
| G04 | Missing `rel` on sponsored/UGC links | placeholder | `links-external.sponsored-unqualified` | better | better | Scrawly: placeholder. |
| G05 | Outbound links to malware/spam domains (optional API) | placeholder | `links-external.unsafe` | missing | better | New: Google Safe Browsing with your key. Scrawly: placeholder. |
| G06 | `target=_blank` without `rel=noopener` | placeholder | `links-external.noopener` | better | better | Scrawly: placeholder. |

### Images & media

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| H01 | Missing alt text (non-decorative) | placeholder | `images.alt-missing` | better | better | Scrawly: placeholder. |
| H02 | Decorative image missing empty `alt=""` | placeholder | `images.alt-missing`, `images.alt-unhelpful` | better | better | Scrawly: placeholder. |
| H03 | Alt text too long / keyword-stuffed | placeholder | `images.alt-too-long`, `images.alt-stuffed` | better | better | Scrawly: placeholder. |
| H04 | Images >100KB (unoptimized) | placeholder | `images.large` | better | better | Scrawly: placeholder. |
| H05 | Images missing width/height (CLS risk) | placeholder | `images.dimensions-missing` | better | better | Scrawly: placeholder. |
| H06 | Broken image src (4xx) | placeholder | `images.broken`, `images.wrong-content-type` | better | better | Scrawly: placeholder. |
| H07 | Next-gen format not used (no WebP/AVIF) | placeholder | `images.legacy-format` | better | better | Scrawly: placeholder. |
| H08 | Missing lazy-loading below the fold | placeholder | `images.no-lazy-loading`, `images.lazy-above-fold` | better | better | Scrawly: placeholder. |
| H09 | Missing `fetchpriority` on LCP image | placeholder | `images.lcp-priority` | better | better | Scrawly: placeholder. |
| H10 | Oversized images (rendered << natural dimensions) | placeholder | `images.oversized-rendered` | missing | better | New, from rendered image boxes. Scrawly: placeholder. |
| H11 | Missing image sitemap entries | placeholder | `sitemaps.no-image-entries` | missing | better | New. Scrawly: placeholder. |

### Hreflang / international

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| I01 | Missing return (reciprocal) hreflang | active (site-level) | `hreflang.missing-return` | equal | equal |  |
| I02 | hreflang to non-canonical / non-200 URL | placeholder | `hreflang.target-problem` | better | better | Scrawly: placeholder. |
| I03 | Invalid language/region codes | placeholder | `hreflang.invalid-code` | better | better | Scrawly: placeholder. |
| I04 | Missing `x-default` | placeholder | `hreflang.missing-x-default` | better | better | Scrawly: placeholder. |
| I05 | hreflang + canonical conflict (canonical to different lang) | placeholder | `hreflang.canonical-conflict` | better | better | Scrawly: placeholder. |
| I06 | Multiple/duplicate hreflang entries for same locale | placeholder | `hreflang.duplicate-code` | better | better | Scrawly: placeholder. |
| I07 | hreflang in HTML vs sitemap vs header inconsistency | placeholder | `hreflang.source-conflict` | better | better | Scrawly: placeholder. |
| I08 | Self-referential hreflang missing | placeholder | `hreflang.missing-self` | better | better | Scrawly: placeholder. |

### Structured data / schema

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| J01 | Missing required property (per type) | placeholder | `schema.*-incomplete (14 types)` | better | better | Scrawly: placeholder. |
| J02 | Missing recommended property | placeholder | `schema.*-incomplete (recommended properties)` | better | better | Scrawly: placeholder. |
| J03 | Invalid JSON-LD syntax | placeholder | `schema.invalid-json`, `schema.missing-context`, `schema.missing-type` | better | better | Scrawly: placeholder. |
| J04 | Legacy Microdata/RDFa where JSON-LD expected | placeholder | `schema.microdata-only` | better | better | Scrawly: placeholder. |
| J05 | Schema type mismatch with page content | placeholder | `schema.headline-mismatch`, `schema.faq-not-visible`, `schema.price-not-visible`, `schema.article-missing` | better | better | Scrawly: placeholder. |
| J06 | Duplicate/conflicting `@id` references | placeholder | `schema.conflicting-ids` | better | better | Scrawly: placeholder. |
| J07 | Missing Organization / LocalBusiness / Website schema | placeholder | `schema.organization-missing`, `schema.website-missing`, `geo-entity.no-organization` | better | better | Scrawly: placeholder. |
| J08 | Missing Breadcrumb schema | placeholder | `schema.breadcrumbs-missing` | better | better | Scrawly: placeholder. |
| J09 | Missing Article/author/date schema (E-E-A-T, GEO) | placeholder | `schema.article-incomplete`, `geo-content.missing-article-schema`, `geo-content.author-not-in-schema` | better | better | Scrawly: placeholder. |
| J10 | Missing FAQ/HowTo/Product/Review schema where applicable | placeholder | `geo-content.faq-without-schema`, `agentic-commerce.products-without-schema` | better | better | Scrawly: placeholder. |
| J11 | NAP in schema inconsistent with GBP/site (local) | placeholder | `geo-entity.nap-inconsistent`, `schema.organization-inconsistent` | better | better | Scrawly: placeholder. |
| J12 | ratingValue/reviewCount fabricated or self-serving | placeholder | `schema.self-serving-reviews` | better | better | Scrawly: placeholder. |
| J13 | Schema present in response vs render mismatch | placeholder | `js-rendering.schema-only-rendered`, `ai-crawlers.bot-missing-schema` | better | better | Scrawly: placeholder. |

### XML sitemaps

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| K01 | Sitemap missing / not referenced in robots.txt | active (site-level) | `sitemaps.missing`, `sitemaps.not-in-robots` | equal | equal |  |
| K02 | Sitemap contains non-200 URLs | active (site-level) | `sitemaps.error-urls` | equal | equal |  |
| K03 | Sitemap contains noindex / canonicalized-away URLs | active (site-level) | `sitemaps.noindex-urls`, `sitemaps.canonicalised-urls` | equal | equal |  |
| K04 | Sitemap contains redirects | active (site-level) | `sitemaps.redirect-urls` | equal | equal |  |
| K05 | Indexable pages missing from sitemap | active (site-level) | `sitemaps.indexable-missing` | equal | equal |  |
| K06 | Sitemap >50k URLs / >50MB (uncompressed) | active (site-level) | `sitemaps.too-large` | equal | equal |  |
| K07 | Invalid XML / malformed sitemap | placeholder | `sitemaps.parse-errors`, `sitemaps.unreachable` | better | better | Scrawly: placeholder. |
| K08 | `<lastmod>` missing or clearly inaccurate | placeholder | `sitemaps.lastmod-invalid`, `sitemaps.lastmod-future`, `sitemaps.lastmod-uniform`, `sitemaps.lastmod-missing` | better | better | Scrawly: placeholder. |
| K09 | Orphan sitemap URLs (in sitemap, no inlinks) | placeholder | `links-internal.orphan` | better | better | Scrawly: placeholder. |
| K10 | Sitemap not auto-updating (stale vs new content) | placeholder | `sitemaps.stale` | better | better | Scrawly: placeholder. |

### Robots directives (file-level)

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| L01 | `Disallow: /` (whole site blocked) | active (site-level) | `crawlability.robots-blocks-all` | equal | equal |  |
| L02 | Important directories disallowed | placeholder | `crawlability.robots-blocks-linked-pages` | better | better | Scrawly: placeholder. |
| L03 | CSS/JS/asset paths disallowed | placeholder | `crawlability.robots-blocks-resources` | equal | equal | Scrawly L03 is a placeholder, A02 covers it. |
| L04 | Wildcard/pattern errors | placeholder | `crawlability.robots-syntax`, `crawlability.robots-unsupported-rules`, `ai-crawlers.misspelt-tokens` | better | better | Scrawly: placeholder. |
| L05 | Robots.txt not at root / wrong content-type | active (site-level) | `crawlability.robots-is-html`, `ai-crawlers.robots-not-text` | equal | equal |  |
| L06 | Sitemap directive missing | placeholder | `crawlability.robots-no-sitemap`, `crawlability.robots-sitemap-invalid` | better | better | Scrawly: placeholder. |
| L07 | Crawl-delay set high (throttles Google) | active (site-level) | `crawlability.robots-crawl-delay`, `ai-crawlers.crawl-delay-high` | equal | equal |  |

### Security

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| M01 | Site not on HTTPS | active | `security.not-https` | equal | equal |  |
| M02 | Mixed content (HTTPS page loads HTTP assets) | active | `security.mixed-content` | equal | equal |  |
| M03 | Missing HSTS header | active | `security.hsts-missing`, `security.hsts-short` | equal | equal |  |
| M04 | Expired / invalid / soon-expiring TLS cert | active (site-level) | `security.tls-expired`, `security.tls-expiring`, `security.tls-invalid` | missing | equal | New: certificate read once per crawl (expired, under 21 days, untrusted). |
| M05 | Protocol-relative resource links (`//host`) | active | `security.protocol-relative` | equal | equal |  |
| M06 | Missing security headers (CSP, X-Content-Type-Options, X-Frame-Options, | active | `security.csp-missing`, `security.csp-unsafe`, `security.nosniff-missing`, `security.frame-protection-missing`, `security.referrer-policy-missing` | better | better |  |
| M07 | `target=_blank` tabnabbing (noopener) | active | `links-external.noopener` | equal | equal |  |
| M08 | Server/software version leakage in headers | active | `security.version-disclosure` | equal | equal |  |
| M09 | WordPress version exposed (generator meta / readme.html) | active | `cms.wp-version-exposed`, `cms.wp-readme-exposed` | equal | equal |  |
| M10 | XML-RPC / wp-json user enumeration open | active (site-level) | `cms.wp-xmlrpc-enabled`, `cms.wp-user-enumeration`, `cms.wp-rest-users-exposed` | better | better |  |

### Performance / Core Web Vitals

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| N01 | LCP > 2.5s (good) / > 4s (poor) | active | `performance.lcp`, `performance.rendered-lcp` | equal | equal |  |
| N02 | INP > 200ms (good) / > 500ms (poor) | active | `performance.inp` | equal | equal |  |
| N03 | CLS > 0.1 (good) / > 0.25 (poor) | active | `performance.cls`, `performance.rendered-cls` | equal | equal |  |
| N04 | TTFB slow (>~0.8s) | active | `performance.ttfb-slow`, `performance.slow-pages-share` | equal | equal |  |
| N05 | Render-blocking CSS/JS | active | `performance.render-blocking-scripts`, `performance.render-blocking-css` | equal | equal |  |
| N06 | Unminified CSS/JS | active | `performance.unminified-assets`, `performance.unminified-inline` | weaker | equal | New: fetches a sample of the site's CSS/JS files. |
| N07 | No compression (gzip/brotli) | active | `performance.no-compression` | equal | equal |  |
| N08 | No/short cache headers on static assets | active | `performance.asset-cache-short`, `performance.html-no-validators` | equal | equal |  |
| N09 | Excessive DOM size (agentic + perf) | active | `performance.dom-size` | equal | equal |  |
| N10 | Large total page weight (>~2–3MB) | active | `performance.page-weight`, `performance.html-heavy` | equal | equal |  |
| N11 | Excessive HTTP requests | active | `performance.too-many-requests` | equal | equal |  |
| N12 | Missing preconnect/preload for critical origins | active | `performance.no-preconnect` | equal | equal |  |
| N13 | Font loading causes FOIT/FOUT / no font-display | active | `performance.font-display` | equal | equal |  |
| N14 | Third-party script bloat (analytics/chat/ads) | active | `performance.third-party-heavy`, `performance.too-many-scripts` | equal | equal |  |

### Mobile

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| O01 | Missing/incorrect viewport meta | active | `mobile.viewport-missing`, `mobile.viewport-not-responsive`, `mobile.zoom-disabled`, `mobile.viewport-multiple` | better | better |  |
| O02 | Tap targets too small / too close | active | `mobile.tap-targets` | missing | equal | New: phone render, WCAG 2.5.8 (24×24 px), inline links exempt. |
| O03 | Content wider than viewport (horizontal scroll) | active | `mobile.horizontal-scroll`, `mobile.fixed-width` | weaker | equal | New phone-render measurement. |
| O04 | Font size too small on mobile | active | `mobile.rendered-small-text`, `mobile.small-text` | weaker | equal | New: computed font sizes in the phone render. |
| O05 | Mobile vs desktop content parity gap (mobile-first index) | active | `mobile.content-parity` | missing | equal | New: words and links, phone vs desktop render. |
| O06 | Intrusive interstitials/pop-ups on mobile | active | `mobile.interstitial` | missing | equal | New: fixed layers covering 30%+ of the phone screen. |
| O07 | Blocked resources on mobile UA only | active | `mobile.blocked-resources` | missing | equal | New: requests failing only in the phone render. |

### JavaScript rendering (response vs render)

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| P01 | Primary content only in rendered DOM (not in response HTML) | active | `js-rendering.client-only`, `js-rendering.content-gap`, `ai-crawlers.empty-shell`, `ai-crawlers.js-gap` | better | better |  |
| P02 | Internal links injected only by JS | active | `js-rendering.links-only-rendered` | equal | equal |  |
| P03 | Title/meta/canonical/robots differ response vs render | active | `js-rendering.title-changed`, `js-rendering.canonical-changed`, `js-rendering.robots-changed`, `js-rendering.description-changed` | equal | equal |  |
| P04 | Render blocked by JS error / failed resource | active | `js-rendering.console-errors`, `js-rendering.failed-requests` | equal | equal |  |
| P05 | Long render/hydration time | active | `performance.rendered-load-slow`, `performance.rendered-tbt` | equal | equal |  |
| P06 | Client-side-only routing without SSR/prerender | active | `ai-crawlers.empty-shell`, `links-internal.hashbang` | equal | equal |  |

### "Accessibility (WCAG subset \u2014 dual SEO + agentic value)"

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Q01 | Interactive element missing accessible name/label | active | `accessibility.button-name-missing`, `accessibility.link-name-missing`, `agentic.icon-only-controls` | weaker | equal | Scrawly runs axe-core in the browser; AVC now runs its rules on the rendered DOM when pages are rendered. |
| Q02 | Invalid/unsupported ARIA attributes | active | `accessibility.invalid-aria-attribute`, `accessibility.invalid-role` | weaker | equal | As Q01. |
| Q03 | Form field without associated label | active | `accessibility.form-label-missing`, `agentic.form-unlabelled` | weaker | equal | As Q01. |
| Q04 | Insufficient color contrast | active | `accessibility.low-contrast-rendered`, `accessibility.low-contrast-inline` | weaker | equal | New: computed colours in the render (WCAG AA). |
| Q05 | Content interactive but hidden from a11y tree | active | `accessibility.aria-hidden-focusable` | equal | equal |  |
| Q06 | Improper role/parent-child nesting (tree integrity) | active | `accessibility.role-nesting`, `accessibility.list-structure` | missing | equal | New: WAI-ARIA required context roles. |
| Q07 | Missing document language attribute | active | `accessibility.lang-missing`, `accessibility.lang-invalid` | better | better |  |
| Q08 | Non-semantic markup for interactive controls (div-as-button) | active | `accessibility.clickable-div`, `agentic.div-buttons` | equal | equal |  |
| Q09 | Missing skip links / landmark regions | active | `accessibility.skip-link-missing`, `accessibility.main-landmark-missing`, `accessibility.main-landmark-multiple` | equal | equal |  |

### "GEO \u2014 AI crawler access & citation readiness"

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| R01 | AI training crawlers blocked in robots.txt (GPTBot, ClaudeBot, CCBot, Google-Extended) | active | `ai-crawlers.training-bots-blocked` | better | better | 38 bots, deciding line per bot. |
| R02 | AI search crawlers blocked (OAI-SearchBot, Claude-SearchBot, PerplexityBot) | active | `ai-crawlers.search-bots-blocked`, `ai-crawlers.key-pages-blocked` | better | better |  |
| R03 | AI user-fetch agents blocked (ChatGPT-User, Claude-User, Perplexity-User) | active | `ai-crawlers.user-fetchers-blocked`, `ai-crawlers.user-fetcher-robots-ineffective` | better | better |  |
| R04 | CDN/WAF (Cloudflare) silently blocks AI bots | active (site-level) | `ai-crawlers.firewall-challenge`, `ai-crawlers.live-blocked`, `ai-crawlers.live-differs` | better | better | Live fetch as each bot vs a browser. |
| R05 | Primary content client-side rendered (AI bots don't run JS) | active | `ai-crawlers.js-gap`, `ai-crawlers.empty-shell`, `ai-crawlers.rendered-headings-missing` | better | better |  |
| R06 | Content behind login/paywall/interaction | active | `geo-content.gated-content` | missing | better | New: password fields, paywall markup, isAccessibleForFree without hasPart. |
| R07 | Missing answer-capsule structure (direct answer before context) | active | `geo-content.no-answer-first`, `geo-content.answer-buried` | better | better |  |
| R08 | Weak heading hierarchy / not scannable (one topic per section) | active | `geo-content.too-few-headings`, `geo-content.long-sections`, `geo-content.no-question-headings` | better | better |  |
| R09 | Missing author + freshness signals (E-E-A-T for GEO) | active | `geo-content.no-author`, `geo-content.no-visible-date`, `geo-content.stale`, `geo-content.author-no-credentials` | better | better |  |
| R10 | Missing/weak entity + Organization/Website schema | active | `geo-entity.* (25 checks)` | better | better |  |
| R11 | Google-Agent / Google-Extended handling not set intentionally | active | `ai-crawlers.extended-optout-scope` | equal | equal |  |
| R12 | No first-party structured facts (pricing, FAQ, policies) exposed | active | `geo-content.no-first-party-facts` | weaker | better | New, site level. Scrawly flags every page without FAQ/Product schema. |

### Agentic-web experience (Lighthouse 13.3 Agentic Browsing + beyond)

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| S01 | Missing `llms.txt` at root | active (site-level) | `llms-txt.missing` | equal | equal |  |
| S02 | `llms.txt` present but missing H1 / too short / no links | active | `llms-txt.no-h1`, `llms-txt.no-summary`, `llms-txt.no-links`, `llms-txt.too-thin`, `llms-txt.malformed-items` | better | better |  |
| S03 | `llms.txt` is a link dump (800–1200 unsorted links) | active | `llms-txt.link-dump` | equal | equal |  |
| S04 | Optional `llms-full.txt` absent (large-doc sites) | active (site-level) | `llms-txt.full-missing` | equal | equal |  |
| S05 | Accessibility tree fails agent-centric names/labels | active | `accessibility.button-name-missing`, `accessibility.link-name-missing`, `agentic.form-unlabelled` | equal | equal |  |
| S06 | Accessibility tree integrity fail (roles/relationships) | active | `accessibility.role-nesting`, `accessibility.broken-aria-reference`, `accessibility.invalid-role` | weaker | equal | role-nesting is new. |
| S07 | Interactive-but-invisible-to-a11y-tree elements | active | `accessibility.aria-hidden-focusable` | equal | equal |  |
| S08 | Post-load CLS (menus/late banners shift after settle) | active | `performance.rendered-cls` | equal | equal |  |
| S09 | Forms lack WebMCP declarative annotations | active | `agentic.webmcp-not-used` | equal | equal |  |
| S10 | WebMCP tool schema invalid / incomplete (if registered) | active | `agentic.webmcp-form-incomplete`, `agentic.webmcp-tool-incomplete` | weaker | equal | Tools registered at runtime are now captured in the render (any script, not only inline). |
| S11 | Key flows (checkout/booking/contact) not agent-completable | active | `agentic.webmcp-not-used`, `agentic.captcha-only-form`, `agentic.form-unlabelled` | better | better |  |
| S12 | Dynamic JS tool/element registration timing issues | active | `js-rendering.links-only-rendered`, `agentic.webmcp-tool-incomplete` | equal | equal |  |
| S13 | No AI-assistant traffic channel/attribution set up (GA4) | active | `analytics.no-ai-referrals` | weaker | better | New check on connected GA4 data (AVC already reported AI referral sessions). |

### URL structure & hygiene

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| T01 | Uppercase characters in URL | active | `urls.uppercase`, `urls.case-duplicates` | better | better |  |
| T02 | Whitespace / unsafe / non-ASCII chars | active | `urls.unsafe-characters` | equal | equal |  |
| T03 | Double slashes / repetitive path segments | active | `urls.double-slash`, `urls.repeated-segment` | equal | equal |  |
| T04 | Excessive URL length (>~115 chars) | active | `urls.too-long` | equal | equal |  |
| T05 | Session IDs / tracking params in indexable URLs | active | `urls.session-id`, `urls.tracking-parameters` | equal | equal |  |
| T06 | Deep/over-nested path structure | active | `urls.deep-path` | equal | equal |  |
| T07 | Non-descriptive URLs (`?p=123`) | active | `urls.non-descriptive` | equal | equal |  |
| T08 | Trailing-slash inconsistency (both resolve 200) | active (site-level) | `redirects.trailing-slash-duplicates`, `urls.trailing-slash-mixed` | equal | equal |  |
| T09 | Underscores instead of hyphens as word separators | active | `urls.underscores` | equal | equal |  |

### Pagination

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| U01 | Paginated pages `noindex`'d | active | `pagination.noindex` | equal | equal |  |
| U02 | Multiple rel=next/prev on one page | active | `pagination.multiple-rel` | equal | equal |  |
| U03 | Page 2+ canonicalized to page 1 | active | `pagination.canonical-to-first` | equal | equal |  |
| U04 | Infinite scroll with no paginated URLs | active | `pagination.load-more-only` | equal | equal |  |
| U05 | Missing "view-all" or crawl path for deep lists | active | `pagination.deep-series` | missing | better | New: only long series (6+ pages) with no jump links or view-all. |

### WordPress-specific

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| V01 | Default "Uncategorized" category indexed | active | `cms.wp-uncategorized` | equal | equal |  |
| V02 | Tag/author/date archives indexed & thin/duplicate | active | `cms.wp-thin-archive`, `cms.thin-taxonomy-share` | better | better |  |
| V03 | Attachment (media) pages indexed | active | `cms.wp-attachment-page` | equal | equal |  |
| V04 | Paginated comment URLs (`/comment-page-`) indexed | active | `cms.wp-comment-pages` | equal | equal |  |
| V05 | Search results pages (`?s=`) indexable | active | `urls.internal-search-indexable`, `cms.search-results-crawlable` | equal | equal |  |
| V06 | Both SEO plugins active (Yoast + RankMath) | active | `cms.wp-seo-plugin-conflict` | equal | equal |  |
| V07 | Missing/duplicate canonical from theme + plugin both emitting | active | `canonical.multiple`, `cms.wp-seo-plugin-conflict` | equal | equal |  |
| V08 | Auto-generated image sizes bloating media / no WebP | active | `images.legacy-format`, `images.no-srcset` | equal | equal |  |
| V09 | `?replytocom` / feed / trackback URLs crawlable | active | `cms.wp-replytocom` | equal | equal |  |
| V10 | Staging/dev site indexable (noindex leaked to prod, or dev public) | active | `crawlability.staging-indexable` | equal | equal |  |
| V11 | Heavy plugin count inflating render/requests | active | `cms.wp-many-plugins` | equal | equal |  |
| V12 | REST API / feeds exposing more than intended | active | `cms.wp-rest-users-exposed`, `cms.wp-user-enumeration` | equal | equal |  |

### Analytics, tracking & config (context, mostly info)

| Scrawly | Check | Scrawly status | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| W01 | Missing/duplicate GA4 or GTM tags | active | `analytics.duplicate-ga4`, `analytics.duplicate-gtm`, `analytics.none`, `analytics.inconsistent` | better | better |  |
| W02 | Missing GSC verification | active | `analytics.verification-missing` | equal | equal |  |
| W03 | Favicon missing / broken | active | `onpage.favicon-missing`, `onpage.favicon-broken` | weaker | equal | favicon-broken is new (fetches the icon). |
| W04 | Missing 404 template / unhelpful 404 | active (site-level) | `response.404-page-unhelpful`, `response.missing-page-returns-200` | equal | equal |  |
| W05 | Multiple homepage versions resolve 200 (/, /index.php, /home) | active (site-level) | `response.homepage-duplicates`, `redirects.host-variants` | equal | equal |  |

### Site-level checks not in Scrawly's manifest

| Scrawly | Check | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- | --- |
| V13 | Missing or misplaced DOCTYPE | `response.doctype-missing` | missing | equal | New. |
| V14 | Missing `<html lang>` | `accessibility.lang-missing`, `accessibility.lang-invalid` | better | better | |
| V15 | Multiple `<title>` elements | `onpage.title-multiple` | equal | equal | |
| V16 | Missing character-encoding declaration | `response.charset-missing`, `response.charset-late` | better | better | |
| V17 | Invalid element in `<head>` | `crawlability.head-broken` | equal | equal | |

## Other capabilities

### Agentic-web probe

| Scrawly | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- |
| robots.txt and sitemap probes | `robots` + `ai-crawlers.*`, `sitemaps.*` checks | better | better | Per-bot deciding line; sitemap validity, not only presence. |
| Link response headers (RFC 8288) | probe `link-headers`, `agentic.link-header-missing` | weaker | equal | AVC probed the header but had no finding. Now flags discovery documents the home page does not advertise. |
| DNS for AI Discovery (SVCB/HTTPS at `_mcp._agents`, `_a2a._agents`, `_index._agents`) | probe `dns-aid` (src/agentic/dns-aid.ts), `agentic.dns-aid-missing` | missing | equal | Uses the machine's own resolver over UDP (Scrawly asks Cloudflare DNS-over-HTTPS). Only checked when the site publishes an MCP or A2A card. |
| Markdown content negotiation | `agentic.markdown-negotiation-missing`, `agentic.markdown-no-vary`, `agentic.markdown-is-html` | better | better |  |
| llms.txt | `llms-txt.*` (27 checks), generator | better | better |  |
| AI bot rules in robots.txt | `ai-crawlers.*` | better | better |  |
| Content Signals in robots.txt | `agentic.ai-preferences-missing`, `-invalid`, `-conflict` | better | better | Also IETF aipref Content-Usage. |
| Web Bot Auth key directory | `agentic.web-bot-auth-invalid` | equal | equal |  |
| API catalog (RFC 9727) | `agentic.api-catalog-missing`, `agentic.api-catalog-invalid`, OpenAPI checks | better | better |  |
| OAuth / OpenID discovery, protected resource metadata | `agentic.oauth-*`, `agentic.prm-*`, `agentic.openid-invalid` | better | better | Validates PKCE, issuer, registration. |
| auth.md agent registration | probe `auth-md`, `agentic.auth-md-missing` | missing | equal | Only when OAuth discovery exists (an API to register with). |
| MCP server card | `agentic.mcp-card-*`, `agentic.mcp-auth-no-prm` | better | better |  |
| A2A agent card | `agentic.a2a-card-*` | better | better |  |
| Agent skills index (`/.well-known/agent-skills/index.json`) | probe `agent-skills`, `agentic.agent-skills-invalid` | missing | equal |  |
| Legacy AI plugin manifest | `agentic.ai-plugin-legacy` | equal | equal |  |
| x402 payments | `agentic-commerce.x402-invalid` | better | better | Follows the advertised resource and validates the 402 answer. |
| MPP (`x-payment-info` in OpenAPI) | `agentic-commerce.no-checkout-protocol` recognises it | missing | equal |  |
| UCP profile | `agentic-commerce.ucp-invalid` | better | better |  |
| ACP discovery (`/.well-known/acp.json`) | probe `acp-json`, `agentic-commerce.acp-invalid` | missing | equal |  |
| Commerce probes only scored on shops | `productPages()` gating in agentic-commerce checks | equal | equal |  |
| WebMCP tools registered at runtime (browser) | render captures `navigator.modelContext` registrations; `agentic.webmcp-tool-incomplete` | weaker | equal | Before: inline-script parsing only. |
| Category scores and readiness level | `agentic` pillar score, `agentic_readiness` MCP tool | equal | equal |  |

### Crawl

| Scrawly | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- |
| Page limit, depth, concurrency, rate limit, user agent, custom headers, timeouts, max page size | `--max-pages`, `--depth`, `--concurrency`, `--delay`, `--user-agent`, CrawlOptions | equal | equal |  |
| Include / exclude patterns | `--include`, `--exclude` | equal | equal |  |
| Respect / ignore / ignore-but-report robots.txt | `--ignore-robots` (blocked URLs are always reported) | equal | equal |  |
| robots.txt user agent to obey | `--robots-ua` | missing | equal |  |
| Sitemap discovery and seeding | sitemap loader, orphan seeding | equal | equal |  |
| Sitemap-only mode | `--sitemap-only` | missing | equal |  |
| List mode (exact URLs) | `--list <file>` | missing | equal |  |
| URL rewriting: remove parameters, regex replace, lower-case | `--remove-param`, `--rewrite`, `--lowercase-urls` | missing | equal |  |
| Crawl subdomains / outside the start folder | `--subdomains`, `--stay-in-folder` | missing | equal |  |
| Follow nofollow toggle | `--no-follow-nofollow` | missing | equal |  |
| Limits: URL length, query parameters, folder depth, URLs per depth | `--max-url-length`, `--max-query-params`, `--max-folder-depth`, `maxPerDepth` | missing | equal | Scrawly's per-subdomain cap is not copied: `--include`/`--exclude` per host do the same. |
| Retries on 429 / 5xx | `fetchRetry` in src/crawl/index.ts (429 and 503, Retry-After) | missing | equal |  |
| Resource toggles (images, external, CSS, JS, media) | `checkImages`, `--external-links`; CSS/JS sampled by `performance.unminified-assets` | equal | equal |  |
| Follow hreflang / AMP / pagination targets | always followed (not counted as inlinks) | equal | equal | Different default: AVC audits them. |
| JavaScript rendering (all or a sample), render timeout, JS errors | `--render` / auto (home, thin pages, one per section), `js-rendering.*` | better | better |  |
| Phone render (mobile context) | `mobileRender` (phone viewport + UA, 10 pages) | missing | equal |  |
| Shadow DOM and iframe flattening | render adds open-shadow-root and same-origin iframe text | missing | equal |  |
| PDF crawling with document properties | src/crawl/pdf.ts, `content.pdf-title-missing` | missing | better | Scrawly extracts properties; AVC also checks the title. |
| Form login (credentials from env) | `--form-login <url>` with AVC_FORM_USER / AVC_FORM_PASS; log-out/delete/admin links skipped | weaker | equal | Before: basic auth or a cookie only. |
| Custom extraction (CSS, XPath, regex) and custom search | `--extract name=css:…`, `xpath:` (simple paths), `regex:`, `count:`; CSV/Excel/page detail | missing | equal | XPath is converted to CSS, so only simple paths (no functions) work. |
| Content area include/exclude for word counts | `--content-selector`, `--content-exclude` | missing | equal |  |
| Crawl presets per platform (with sub-types) | `--preset auto | wordpress[:woocommerce | blog] | shopify |
| Saved crawl profiles (default per client) | `profiles` in avc.config.json, `--profile`, per-site `crawl.profile` | weaker | equal |  |
| Screaming Frog CSV import | `avc import <internal_all.csv>` | missing | equal | Runs the checks the export can support. |
| On-demand screenshots (desktop, Googlebot smartphone) | `avc screenshot [--mobile]`, dashboard page detail | missing | equal |  |
| TLS certificate probe | src/crawl/tls.ts, `security.tls-*` | missing | equal |  |
| IDN hosts | WHATWG URL (punycode) | equal | equal |  |
| CDN hosts treated as own assets | `--cdn <host>` (not counted as third party in `performance.third-party-heavy` or the resource inventory) | missing | equal |  |

### Detection

| Scrawly | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- |
| Tech-stack fingerprint with confidence and signals | src/crawl/stack.ts (24 stacks incl. Magento, Laravel; SEO plugin, host, CDN) | weaker | better | Before: no Magento or Laravel. AVC detects more stacks overall. |
| Stack-specific fix prompts | stack-aware recipes + agent prompts per fix | better | better |  |

### Connected data

| Scrawly | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- |
| Google Search Console | `avc connect gsc`, 10 GSC checks, URL Inspection | better | better |  |
| Google Analytics 4 | `avc connect ga4`, AI-assistant referrals, `analytics.no-ai-referrals` | better | better |  |
| Google OAuth | OAuth or service account | better | better |  |
| PageSpeed Insights / Lighthouse | `avc connect psi`, `performance.*` (psi), MCP `pagespeed` | equal | equal |  |
| Backlinks (Moz, Ahrefs, Majestic; own subscription) | `avc connect backlinks`, src/connect/backlinks.ts → `external.backlinks` | missing | equal |  |
| Spelling and grammar (LanguageTool, public or local) | `avc connect spelling`, `content.spelling` | missing | equal | Public API is opt-in; a local server keeps text on your network. |
| Embeddings (similar pages, low relevance) | `avc connect embeddings`, `duplicates.semantic`, `content.off-topic` | missing | equal | OpenAI key, AI Gateway, OpenAI-compatible endpoint or mock. |

### AI

| Scrawly | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- |
| AI provider: Anthropic or any OpenAI-compatible endpoint | OpenAI, Anthropic, Google, Perplexity, xAI, AI Gateway; `OPENAI_BASE_URL` for writer/judge/embeddings | weaker | equal | Visibility answers always come from the real engine, never the custom endpoint. |
| AI writer for titles and descriptions | `avc serp --write`, WordPress auto-apply | equal | equal |  |
| SERP preview (pixel widths, AI context) | src/report/serp.ts, `avc serp`, dashboard Snippets, MCP `serp_preview` | missing | equal |  |
| AI assistant chat about an audit | `avc ask`, dashboard Ask, MCP `ask_audit` (and any MCP client) | missing | equal | Single question per request; multi-turn chat through MCP clients. |
| AI fix agent (plan, then apply with confirmation) | `plan_fixes` / `apply_fixes` (dry run first), model-written meta | equal | equal |  |
| Editable fix guidance knowledge base | `fixes.overrides` in config (per check: note, steps, replace) | missing | equal |  |
| AI visibility tracking (do engines name you) | `avc visibility` | better | better | Scrawly has no equivalent. |

### WordPress

| Scrawly | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- |
| Connector (plugin with connection key) vs helper + Application Password | AVC helper mu-plugin, `avc connect wordpress` | equal | equal | Different model, same scope. |
| Write title and meta description | `seo-title`, `seo-description` changes | equal | equal |  |
| Write robots (noindex) | `noindex` change | equal | equal |  |
| Write canonical | `canonical` change via helper (`CANONICAL_SELF` checks) | missing | equal |  |
| Redirect store | `avc redirect`, MCP `create_redirect`, helper `avc_redirects` + template_redirect | missing | equal |  |
| robots.txt additions | `avc_robots_txt` helper setting | equal | equal | AVC also serves llms.txt and writes image alt text. |
| Rollback snapshot before every write | snapshot + `avc rollback`, MCP `rollback` | equal | equal |  |
| Live writes need confirmation; manual tier never auto-fixed | dry run by default, `--apply`, `confirm: true` | equal | equal |  |
| Refuse writes when two SEO plugins are active | helper `seoPlugins` + plan guard | missing | equal |  |
| Per-site "allow fixes" kill switch | remove the helper file or revoke the Application Password | equal | equal | Different mechanism; no extra admin screen. |

### MCP

| Scrawly | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- |
| `list_crawls` | `list_audits` | weaker | equal |  |
| `get_issues` | `get_issues` | equal | equal |  |
| `get_page_detail` | `get_page` | equal | equal |  |
| `propose_fix` | `get_fix`, `plan_fixes` | better | better |  |
| `diff_crawls` | `diff_audits` | equal | equal |  |
| `check_ai_access` | `crawler_access` | better | better |  |
| `run_lighthouse` | `pagespeed` | missing | equal |  |
| `generate_report` | `generate_report` (html, md, csv, json, sarif, xlsx, pdf) | missing | better |  |
| `apply_fix` | `apply_fixes` | equal | equal |  |
| `create_redirect` | `create_redirect` | missing | equal |  |
| `revert` | `rollback` | missing | equal |  |
| Runs audits from the assistant | `audit_site`, `ai_visibility`, generators | better | better | Scrawly's MCP server reads stored audits only. |

### Reports

| Scrawly | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- |
| White-label HTML report (name, colour, logo, contact) | `report` config: brandName, brandColor, brandLogo, brandContact | weaker | equal |  |
| PDF report | `-f pdf` (local Chrome), dashboard PDF export | weaker | equal | Before: print the HTML. |
| CSV / JSON developer export | `-f csv,json` | equal | equal |  |
| Excel (README claim; the code exports CSV) | `-f xlsx` (Summary, Issues, Pages, Extraction, Resources) | equal | better |  |
| Portable SQLite | `~/.avc/avc.sqlite` | equal | equal |  |
| Crawl comparison (resolved, new, persisting) | `avc diff`, dashboard History & diff | equal | equal |  |

### Dashboard

| Scrawly | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- |
| Overview with health score and charts | Overview, pillars, trends | equal | equal |  |
| Issues view | Issues with filters | equal | equal |  |
| URL explorer with filter builder | Pages: status, indexable, depth, words, inlinks, issues, schema type, up to three field/operator/value rules, text search | weaker | equal |  |
| 3D site graph and depth tree | Site graph (2D force layout), depth histogram, URL tree | missing | equal | 2D, not 3D. |
| Resources view (CSS, JS, media) | Resources (type and host filters) | missing | equal |  |
| SERP view | Snippets | missing | equal |  |
| Agentic view | Agentic web | equal | equal |  |
| AI assistant panel | Ask | missing | equal |  |
| Fix agent UI | Fixes (preview, apply, rollback) | equal | equal |  |
| Live crawl console | job page with streamed progress | equal | equal |  |
| Client wizard, settings, integrations | Sites, Connections, Settings | equal | equal |  |
| Screenshots in URL detail | Page detail: desktop / phone screenshot | missing | equal |  |
| Light / dark theme | dark theme; reports have a light print mode | missing | missing | Not matched: Devs Core's dashboard design is dark only. |
| Public audit window (signed, quota-gated) | n/a | n/a | n/a | Part of Scrawly's hosted control plane, not the local app. Devs Core's web checker plays this role. |
| In-app feedback | `avc feedback`, dashboard footer link (prefilled GitHub issue or email; nothing sent until you submit) | missing | equal |  |

### Desktop

| Scrawly | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- |
| Native desktop window (pywebview) | `avc ui` opens the dashboard in your browser | weaker | weaker | Not matched on purpose: a browser tab needs no native GUI toolkit. `avc shortcut` adds the app icon. |
| App icon in Applications / Start Menu / app menu | `avc shortcut` | missing | equal |  |
| One-line installers (macOS, Linux, Windows) | install.sh, install.ps1 | equal | equal |  |
| Self-update on launch | `avc update` (asks first, never automatic) | missing | equal | By design no network call without asking. |
| Docker | Dockerfile, docker-compose.yml | equal | equal |  |

### Monitoring

| Scrawly | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- |
| Scheduled audit with regression exit code | `avc schedule`, `avc monitor`, alerts (webhook, email), GitHub Action, `--fail-under` | better | better |  |

### Privacy

| Scrawly | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- |
| Local-only data, no accounts or telemetry | same | better | better | Scrawly checks GitHub for updates by default; AVC makes no call you did not configure. |

### Other

| Scrawly | AVC equivalent | Before | After | Notes |
| --- | --- | --- | --- | --- |
| Internationalisation (UI languages) | n/a | n/a | n/a | Neither tool has UI translations. |

## Not matched

| Item | Verdict | Why |
| --- | --- | --- |
| Dashboard: Light / dark theme | missing | Not matched: Devs Core's dashboard design is dark only. |
| Desktop: Native desktop window (pywebview) | weaker | Not matched on purpose: a browser tab needs no native GUI toolkit. `avc shortcut` adds the app icon. |

## What AVC has that Scrawly does not

AI visibility measurement (mentions, share of voice, citations, competitor wins, fact-checks),
live fetches as each AI crawler with firewall and challenge detection, verified AI crawler visits
from server logs, Bing Webmaster Tools and IndexNow, Search Console URL Inspection, stack-specific
fixes with agent prompts and local-repo patches, generators (llms.txt, robots.txt, JSON-LD, agent
card), SARIF and Markdown reports, a GitHub Action with `--fail-under`, and alerts by webhook or
email.
