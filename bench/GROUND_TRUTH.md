# Ground truth: Harbourline Dental Studio test site

This is the human-readable form of `bench/ground-truth.json` (generated from the same source; the JSON is authoritative).

The site at `bench/site/` is a fictional UK dental practice served by `node bench/serve.mjs`. It has 80 HTML pages and **121 planted defects**, each defined by a public source. Every defect is placed once. Pages listed under *Controls* carry no page-level defect.

| Area | Defects |
| --- | --- |
| Technical SEO | 40 |
| Content and on-page | 24 |
| Accessibility | 17 |
| AI crawler access | 12 |
| AEO / GEO readiness | 15 |
| Agentic web | 13 |
| **Total** | **121** |

## How matching works

- `url` is where the defect is. `found_on` (if present) is the page that links to it; a report at either URL counts.
- `scope: site` defects live in site-wide files (robots.txt, llms.txt, sitemaps, `/.well-known/`) or a site-wide rule (the `/services/` firewall rule, `url_prefix`).
- `alt_types` are other names for the same problem or its direct consequence.
- The site is served over plain HTTP on localhost, so HTTPS/HSTS/mixed-content findings are not planted defects.
- Run `node bench/verify-ground-truth.mjs` to check that every defect still manifests.

## Controls

- `/`
- `/blog/choosing-a-toothpaste`
- `/blog/wisdom-teeth`
- `/blog/pregnancy-and-dental-care`
- `/blog/dental-checkups-how-often`
- `/blog/cracked-tooth-first-aid`
- `/blog`
- `/legal/accessibility`
- `/careers`
- `/finance`
- `/referrals`
- `/developers`

## Technical SEO

| ID | Type | URL | What is wrong | Evidence | Source |
| --- | --- | --- | --- | --- | --- |
| GT-001 | `soft-404` | `/services/sedation` (linked from `/services`) | URL returns 200 OK but the page says the content cannot be found. | HTTP 200 with <title>Page not found…</title> and "we can’t find that page". | [link](https://developers.google.com/search/docs/crawling-indexing/http-network-errors#soft-404-errors) |
| GT-002 | `sitemap-contains-noindex` | `/services/invisalign` | Key treatment page carries meta robots noindex while being listed in the XML sitemap and linked from the treatments list: contradictory indexing signals. | <meta name="robots" content="noindex, follow"> and <loc>…/services/invisalign</loc> in sitemap-pages.xml. | [link](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) |
| GT-003 | `redirect-chain` | `/book-now` (linked from `/services/emergency-dentist`) | Internal link points to a URL that redirects twice (301 → 301) before reaching the final page. | /book-now → 301 /booking → 301 /book → 200. | [link](https://developers.google.com/search/docs/crawling-indexing/301-redirects) |
| GT-004 | `multiple-canonicals` | `/services/veneers` | Page declares two different rel=canonical URLs. | Two <link rel="canonical"> tags: /services/veneers and /services/teeth-whitening. | [link](https://developer.chrome.com/docs/lighthouse/seo/canonical) |
| GT-005 | `slow-server-response` | `/team` | Server takes about 2.5 seconds before sending the first byte. | TTFB ≈ 2,500 ms (all other pages < 50 ms). | [link](https://developer.chrome.com/docs/lighthouse/performance/server-response-time) |
| GT-006 | `broken-image` | `/team/priya-shah` | Image source returns 404. | <img src="/images/team/priya-shah.jpg"> → 404. | [link](https://developers.google.com/search/docs/crawling-indexing/http-network-errors) |
| GT-007 | `temporary-redirect` | `/team/dr-hart` (linked from `/about`) | Old profile URL is moved permanently but uses a 302 (temporary) redirect. | /team/dr-hart → 302 → /team/dr-amelia-hart; linked from /about. | [link](https://developers.google.com/search/docs/crawling-indexing/301-redirects) |
| GT-008 | `http-404` | `/services/gum-treatment` (linked from `/blog/how-to-floss-properly`) | Internal link points to a page that returns 404 Not Found. | <a href="/services/gum-treatment"> → 404. | [link](https://developers.google.com/search/docs/crawling-indexing/http-network-errors) |
| GT-009 | `canonical-to-redirect` | `/blog/nervous-patients` | rel=canonical points to a URL that 301-redirects (back to this page). | canonical {{ORIGIN}}/blog/nervous-patients-guide → 301 → /blog/nervous-patients. | [link](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) |
| GT-010 | `canonical-to-4xx` | `/blog/whitening-myths` | rel=canonical points to a URL that returns 404. | canonical {{ORIGIN}}/blog/whitening-myths-old → 404. | [link](https://developer.chrome.com/docs/lighthouse/seo/canonical) |
| GT-011 | `image-missing-dimensions` | `/blog/what-to-expect-implants` | Above-the-fold image has no width/height attributes, causing layout shift as it loads. | <img src="/images/blog/post-04.jpg" … fetchpriority="high"> without width or height. | [link](https://developer.chrome.com/docs/lighthouse/performance/unsized-images) |
| GT-012 | `redirect-to-4xx` | `/old-prices` (linked from `/blog/dental-implants-cost`) | Internal link points to a redirect whose target returns 404. | /old-prices → 301 → /prices-2023 → 404. | [link](https://developers.google.com/search/docs/crawling-indexing/301-redirects) |
| GT-013 | `x-robots-noindex` | `/blog/fluoride-facts` | Article is sent with an X-Robots-Tag: noindex HTTP header although it is linked internally and listed in the sitemap. | Response header X-Robots-Tag: noindex; <loc> in sitemap-blog.xml. | [link](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag) |
| GT-014 | `url-uppercase` | `/blog/Top-10-Brushing-Mistakes` | URL path contains uppercase letters; the lowercase form returns 404. | /blog/Top-10-Brushing-Mistakes is 200; /blog/top-10-brushing-mistakes is 404. | [link](https://developers.google.com/search/docs/crawling-indexing/url-structure) |
| GT-015 | `url-underscores` | `/blog/gum_disease_signs` | URL uses underscores instead of hyphens to separate words. | /blog/gum_disease_signs | [link](https://developers.google.com/search/docs/crawling-indexing/url-structure) |
| GT-016 | `orphan-page` | `/blog/retainer-care` | Article is listed in the XML sitemap but no page on the site links to it. | Present in sitemap-blog.xml; zero internal inlinks. | [link](https://developers.google.com/search/docs/crawling-indexing/links-crawlable) |
| GT-017 | `pagination-canonical-to-first-page` | `/blog/page/2` (linked from `/blog`) | Paginated page 2 sets rel=canonical to page 1, telling search engines to ignore the articles listed only here. | /blog/page/2 has <link rel="canonical" href="{{ORIGIN}}/blog">. | [link](https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading) |
| GT-018 | `http-5xx` | `/offers` (linked from `/blog/page/2`) | Internal link points to a URL that returns 500 Internal Server Error. | /offers → 500. | [link](https://developers.google.com/search/docs/crawling-indexing/http-network-errors) |
| GT-019 | `missing-canonical` | `/blog/page/3` | Page has no rel=canonical (all other pages declare one). | No <link rel="canonical">. | [link](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) |
| GT-020 | `missing-charset` | `/blog/page/3` | Character encoding is declared neither in the Content-Type header nor in a <meta charset> (page contains non-ASCII characters). | Content-Type: text/html (no charset); no <meta charset>. | [link](https://developer.chrome.com/docs/lighthouse/best-practices/charset) |
| GT-021 | `no-text-compression` | `/blog/category/oral-health` | HTML is served uncompressed even when the client sends Accept-Encoding: gzip (all other pages are gzip-compressed). | No Content-Encoding header in response to Accept-Encoding: gzip, br. | [link](https://developer.chrome.com/docs/lighthouse/performance/uses-text-compression) |
| GT-022 | `console-error` | `/blog/category/cosmetic` | A page script throws an uncaught ReferenceError on load. | /assets/js/gallery.js calls initLightbox(), which is not defined. | [link](https://developer.chrome.com/docs/lighthouse/best-practices/errors-in-console) |
| GT-023 | `http-410` | `/blog/open-day-2019` (linked from `/blog/category/news`) | Internal link points to a page that returns 410 Gone. | /blog/open-day-2019 → 410. | [link](https://developers.google.com/search/docs/crawling-indexing/http-network-errors) |
| GT-024 | `redirect-loop` | `/special-offer` (linked from `/blog/tag/whitening`) | Internal link leads into a redirect loop. | /special-offer → 301 /special-offer-2024 → 301 /special-offer. | [link](https://developers.google.com/search/docs/crawling-indexing/301-redirects) |
| GT-025 | `meta-refresh-redirect` | `/whitening-offer` (linked from `/blog/tag/whitening`) | Page redirects with an HTML meta refresh instead of an HTTP redirect. | <meta http-equiv="refresh" content="0; url=/services/teeth-whitening"> | [link](https://developers.google.com/search/docs/crawling-indexing/301-redirects) |
| GT-026 | `missing-doctype` | `/blog/tag/kids` | Page has no <!doctype html> and renders in quirks mode. | Document starts with <html lang="en-GB">. | [link](https://developer.chrome.com/docs/lighthouse/best-practices/doctype) |
| GT-027 | `image-oversized-file` | `/about` | A single JPEG of about 600 KB is served for an image displayed at 1200×500. | /images/clinic-panorama.jpg is ~590 KB (2400×1000). | [link](https://developer.chrome.com/docs/lighthouse/performance/uses-optimized-images) |
| GT-028 | `missing-security-headers` | `/pricing` | Response omits Content-Security-Policy, X-Content-Type-Options, X-Frame-Options/frame-ancestors, Referrer-Policy and Strict-Transport-Security, which every other page sends. | No CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy or HSTS headers on /pricing. | [link](https://owasp.org/www-project-secure-headers/) |
| GT-029 | `hreflang-invalid-code` | `/new-patients` | hreflang uses "en-uk", which is not a valid language-region code (the UK region code is GB). | <link rel="alternate" hreflang="en-uk" href="{{ORIGIN}}/new-patients"> | [link](https://developers.google.com/search/docs/specialty/international/localized-versions) |
| GT-030 | `hreflang-missing-return-link` | `/us/invisalign-guide` | /invisalign-guide declares /us/invisalign-guide as its en-us alternate, but the US page does not link back with an en-gb (or x-default) hreflang. | /us/invisalign-guide has only <link rel="alternate" hreflang="en-us" …> (self). | [link](https://developers.google.com/search/docs/specialty/international/localized-versions) |
| GT-031 | `excessive-dom-size` | `/legal/privacy` | Page has over 3,000 DOM elements (a 420-row table), well above Lighthouse’s 1,400-element warning level. | <table class="register"> with 420 rows × 6 cells. | [link](https://developer.chrome.com/docs/lighthouse/performance/dom-size) |
| GT-032 | `server-version-disclosure` | `/legal/cookies` | Response headers disclose server software and versions. | Server: Apache/2.4.29 (Ubuntu); X-Powered-By: PHP/7.2.24 | [link](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/02-Fingerprint_Web_Server) |
| GT-033 | `canonical-relative-url` | `/legal/terms` | rel=canonical uses a relative URL; it should be absolute. | <link rel="canonical" href="/legal/terms"> | [link](https://developer.chrome.com/docs/lighthouse/seo/canonical) |
| GT-034 | `missing-viewport` | `/legal/complaints` | Page has no <meta name="viewport">, so mobile browsers render it at desktop width. | No viewport meta tag. | [link](https://developer.chrome.com/docs/lighthouse/pwa/viewport) |
| GT-035 | `robots-blocks-resources` | `/robots.txt` | robots.txt disallows /assets/js/ for all crawlers, blocking the scripts search engines need to render pages (including the client-side rendered /patient-stories and /pricing). | User-agent: * / Disallow: /assets/js/ | [link](https://developers.google.com/search/docs/crawling-indexing/robots/intro) |
| GT-036 | `sitemap-contains-4xx` | `/services/root-canal` | XML sitemap lists a URL that returns 404. | <loc>{{ORIGIN}}/services/root-canal</loc> in sitemap-pages.xml → 404. | [link](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) |
| GT-037 | `sitemap-contains-redirect` | `/blog/tooth-brushing-guide` | XML sitemap lists a URL that 301-redirects. | <loc>{{ORIGIN}}/blog/tooth-brushing-guide</loc> → 301 → /blog/how-to-brush-your-teeth. | [link](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) |
| GT-038 | `sitemap-invalid-xml` | `/sitemaps/sitemap-images.xml` | Child sitemap referenced from the sitemap index is not well-formed XML (an <image:image> element is never closed). | <image:image><image:loc>…clinic-panorama.jpg</image:loc>\n  </url> — missing </image:image>. | [link](https://www.sitemaps.org/protocol.html) |
| GT-039 | `sitemap-invalid-lastmod` | `/sitemaps/sitemap-blog.xml` | A <lastmod> value is not in W3C Datetime format. | <lastmod>13/05/2024</lastmod> for /blog/healthy-snacks. | [link](https://www.sitemaps.org/protocol.html) |
| GT-040 | `security-txt-invalid` | `/.well-known/security.txt` | security.txt is missing the required Expires field. | Fields present: Contact, Preferred-Languages, Canonical. No Expires. | [link](https://www.rfc-editor.org/rfc/rfc9116) |

## Content and on-page

| ID | Type | URL | What is wrong | Evidence | Source |
| --- | --- | --- | --- | --- | --- |
| GT-041 | `img-alt-keyword-stuffed` | `/services/dental-implants` | Image alt text is a string of repeated keywords rather than a description of the image. | alt="dental implants Bristol best dental implants Bristol cheap dental implants…" (160+ characters, keyword repeated). | [link](https://developers.google.com/search/docs/appearance/google-images) |
| GT-042 | `multiple-h1` | `/services/teeth-whitening` | Page has two <h1> elements. | <h1>Professional teeth whitening</h1> and <h1>Sensitivity and safety</h1>. | [link](https://developers.google.com/search/docs/appearance/title-link) |
| GT-043 | `thin-content` | `/services/emergency-dentist` | Service page has under 60 words of main content. | Main content is one lead paragraph and one sentence. | [link](https://developers.google.com/search/docs/fundamentals/creating-helpful-content) |
| GT-044 | `title-too-long` | `/services/childrens-dentistry` | Title is far longer than search results display (over 150 characters). | <title>Children's Dentistry, Fissure Sealants, Fluoride Varnish and First Dental Visits for Babies, Toddlers and Teenagers \| Harbourline Dental Studio Bristol</title> (151 characters). | [link](https://developers.google.com/search/docs/appearance/title-link) |
| GT-045 | `missing-title` | `/team/dr-rohan-mehta` | Page has no <title> element. | No <title> in <head>. | [link](https://dequeuniversity.com/rules/axe/4.10/document-title) |
| GT-046 | `meta-description-too-short` | `/team/dr-sophie-lang` | Meta description is a single word (8 characters). | <meta name="description" content="Dentist."> | [link](https://developers.google.com/search/docs/appearance/snippet) |
| GT-047 | `placeholder-text` | `/team/tom-ellis` | Biography contains Lorem ipsum placeholder text. | "Lorem ipsum dolor sit amet, consectetur adipiscing elit…" | [link](https://developers.google.com/search/docs/fundamentals/creating-helpful-content) |
| GT-048 | `internal-link-to-redirect` | `/locations` | Internal link points to a URL that 301-redirects instead of linking the final URL. | <a href="/locations/bristol-clinic"> → 301 → /locations/bristol. | [link](https://developers.google.com/search/docs/crawling-indexing/301-redirects) |
| GT-049 | `title-too-short` | `/locations/bath` | Title is a single four-letter word. | <title>Bath</title> | [link](https://developers.google.com/search/docs/appearance/title-link) |
| GT-050 | `duplicate-title` | `/blog/sugar-and-teeth`, `/blog/healthy-snacks` | Two different articles share the same <title>. | Both use <title>Healthy Eating for Healthy Teeth \| Harbourline Dental Studio</title>. | [link](https://developers.google.com/search/docs/appearance/title-link) |
| GT-051 | `multiple-titles` | `/blog/electric-vs-manual-toothbrush` | Page has two <title> elements. | <title>Electric or Manual Toothbrush…</title> and <title>Toothbrush Buying Guide \| Harbourline</title>. | [link](https://developers.google.com/search/docs/appearance/title-link) |
| GT-052 | `missing-meta-description` | `/blog/mouthwash-guide` | Page has no meta description. | No <meta name="description">. | [link](https://developer.chrome.com/docs/lighthouse/seo/meta-description) |
| GT-053 | `duplicate-meta-description` | `/blog/bad-breath-causes`, `/blog/dry-mouth` | Two articles use the identical meta description. | Both: "Common causes of bad breath and dry mouth, and practical steps that help…" | [link](https://developers.google.com/search/docs/appearance/snippet) |
| GT-054 | `multiple-meta-descriptions` | `/blog/sensitive-teeth` | Page has two meta description tags with different content. | Two <meta name="description"> elements. | [link](https://developers.google.com/search/docs/appearance/snippet) |
| GT-055 | `missing-h1` | `/blog/kids-first-visit` | Page has no <h1>; the headline is a styled paragraph. | <p class="h1-style">Your child’s first dental visit</p>; zero <h1>. | [link](https://dequeuniversity.com/rules/axe/4.10/page-has-heading-one) |
| GT-056 | `empty-heading` | `/blog/teeth-grinding` | Page contains an empty <h2></h2>. | <h2></h2> | [link](https://dequeuniversity.com/rules/axe/4.10/empty-heading) |
| GT-057 | `thin-content` | `/blog/new-parking-at-bristol` | Article body is a single 30-word paragraph. | Main content ≈ 30 words. | [link](https://developers.google.com/search/docs/fundamentals/creating-helpful-content) |
| GT-058 | `duplicate-content` | `/blog/scale-and-polish-explained`, `/services/hygiene` | Article body is copied word for word from the hygiene service page; neither page canonicalises to the other. | Identical paragraphs ("A hygiene appointment removes the hard tartar…") on both URLs, each with a self canonical. | [link](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) |
| GT-059 | `missing-open-graph` | `/blog/invisalign-vs-braces` | Page has no Open Graph or Twitter Card tags (every other article has them). | No og:title, og:description, og:image or twitter:card. | [link](https://ogp.me/) |
| GT-060 | `nofollow-internal-link` | `/blog/invisalign-vs-braces` | Internal link to a treatment page carries rel="nofollow". | <a href="/services/invisalign" rel="nofollow"> | [link](https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links) |
| GT-061 | `non-descriptive-link-text` | `/blog/whitening-at-home` | Links use generic anchor text ("Click here", "read more"). | <a href="/services/teeth-whitening">Click here</a>, <a href="/pricing">read more</a> | [link](https://developer.chrome.com/docs/lighthouse/seo/link-text) |
| GT-062 | `uncrawlable-link` | `/blog/category/oral-health` | Navigation link uses href="javascript:void(0)" and relies on a script to navigate; crawlers cannot follow it. | <a href="javascript:void(0)" data-href="/blog/page/2"> | [link](https://developer.chrome.com/docs/lighthouse/seo/crawlable-anchors) |
| GT-063 | `duplicate-h1` | `/blog/category/cosmetic`, `/blog/tag/whitening` | Two different archive pages use the same H1 "Cosmetic dentistry". | <h1>Cosmetic dentistry</h1> on both pages. | [link](https://developers.google.com/search/docs/appearance/title-link) |
| GT-064 | `meta-description-too-long` | `/legal/terms` | Meta description is 333 characters, far beyond what search results display (~155–160). | 333-character meta description. | [link](https://developers.google.com/search/docs/appearance/snippet) |

## Accessibility

| ID | Type | URL | What is wrong | Evidence | Source |
| --- | --- | --- | --- | --- | --- |
| GT-065 | `list-invalid-children` | `/services` | A <ul> contains a <div> as a direct child; lists may only contain <li>, <script> or <template>. | <ul class="service-list"><div class="list-intro">Routine care</div>… | [link](https://dequeuniversity.com/rules/axe/4.10/list) |
| GT-066 | `aria-invalid-attribute` | `/services/general-dentistry` | A button uses the misspelt, non-existent ARIA attribute aria-expandd. | <button … aria-expandd="false"> | [link](https://dequeuniversity.com/rules/axe/4.10/aria-valid-attr) |
| GT-067 | `link-missing-name` | `/team` | A link contains only an aria-hidden SVG icon and has no accessible name. | <a href="/book" class="icon-link"><svg aria-hidden="true" …></svg></a> | [link](https://dequeuniversity.com/rules/axe/4.10/link-name) |
| GT-068 | `img-missing-alt` | `/team/dr-amelia-hart` | Portrait image has no alt attribute. | <img src="/images/team/dr-amelia-hart.jpg" width="300" height="300"> with no alt. | [link](https://dequeuniversity.com/rules/axe/4.10/image-alt) |
| GT-069 | `html-lang-invalid` | `/team/dr-sophie-lang` | The html lang attribute is not a valid BCP 47 language tag. | <html lang="english"> | [link](https://dequeuniversity.com/rules/axe/4.10/html-lang-valid) |
| GT-070 | `viewport-blocks-zoom` | `/locations/bristol` | Viewport meta disables pinch zoom (user-scalable=no, maximum-scale=1). | <meta name="viewport" content="…maximum-scale=1, user-scalable=no"> | [link](https://dequeuniversity.com/rules/axe/4.10/meta-viewport) |
| GT-071 | `frame-missing-title` | `/locations/bath` | An <iframe> has no title attribute or accessible name. | <iframe src="/maps/bath.html" width="600" height="300"></iframe> | [link](https://dequeuniversity.com/rules/axe/4.10/frame-title) |
| GT-072 | `low-contrast-text` | `/blog/whitening-myths` | Body paragraph uses light grey text (#b8b8b8) on white, a contrast ratio of about 2:1 (WCAG AA needs 4.5:1). | <p style="color:#b8b8b8">Peroxide gels… | [link](https://www.w3.org/TR/WCAG22/#contrast-minimum) |
| GT-073 | `heading-order` | `/blog/what-to-expect-implants` | Heading levels skip from h2 to h4. | <h2>Before the appointment</h2> followed by <h4>During surgery</h4>. | [link](https://dequeuniversity.com/rules/axe/4.10/heading-order) |
| GT-074 | `aria-invalid-role` | `/blog/electric-vs-manual-toothbrush` | Element uses an invalid ARIA role value ("buton"). | <span role="buton" class="tag"> | [link](https://dequeuniversity.com/rules/axe/4.10/aria-roles) |
| GT-075 | `img-missing-alt` | `/blog/teeth-grinding` | Content image has no alt attribute. | <img src="/images/blog/post-06.jpg" width="800" height="450" loading="lazy"> with no alt. | [link](https://dequeuniversity.com/rules/axe/4.10/image-alt) |
| GT-076 | `html-missing-lang` | `/blog/whitening-at-home` | The <html> element has no lang attribute. | <html> without lang. | [link](https://dequeuniversity.com/rules/axe/4.10/html-has-lang) |
| GT-077 | `missing-main-landmark` | `/blog/category/news` | Page has no <main> element or role="main" landmark. | Main content wrapped in <div id="main">; no <main>. | [link](https://dequeuniversity.com/rules/axe/4.10/landmark-one-main) |
| GT-078 | `form-input-missing-label` | `/contact` | The email input has no associated <label>, aria-label or title; the visible text is not linked to it. | <p>Email address<br><input name="email" type="email" required></p> | [link](https://dequeuniversity.com/rules/axe/4.10/label) |
| GT-079 | `tabindex-positive` | `/contact` | An input has tabindex="3", which overrides the natural focus order. | <input id="c-phone" … tabindex="3"> | [link](https://dequeuniversity.com/rules/axe/4.10/tabindex) |
| GT-080 | `aria-hidden-focusable` | `/pricing` | A focusable link sits inside an aria-hidden="true" container, so it is reachable by keyboard but hidden from assistive technology and agents. | <div aria-hidden="true" class="promo">…<a href="/finance"> | [link](https://dequeuniversity.com/rules/axe/4.10/aria-hidden-focus) |
| GT-081 | `button-missing-name` | `/book` | Icon-only button has no accessible name (no text, aria-label or title). | <button type="button" class="icon-btn" data-cal><svg aria-hidden="true" …></svg></button> | [link](https://dequeuniversity.com/rules/axe/4.10/button-name) |

## AI crawler access

| ID | Type | URL | What is wrong | Evidence | Source |
| --- | --- | --- | --- | --- | --- |
| GT-082 | `nosnippet-key-page` | `/locations/leeds` | Clinic page uses robots nosnippet, which stops search engines (including Google AI Overviews / AI Mode) from quoting any of its text. | <meta name="robots" content="nosnippet"> | [link](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag) |
| GT-083 | `markdown-alternate-broken` | `/about` | Page advertises a Markdown version for AI agents via <link rel="alternate" type="text/markdown"> but that URL returns 404. | <link rel="alternate" type="text/markdown" href="{{ORIGIN}}/about.md"> → 404. | [link](https://llmstxt.org/) |
| GT-084 | `nosnippet-key-page` | `/faq` | FAQ page sets max-snippet:0, which forbids search engines (including Google AI features) from showing any text from it, the page most useful for answers. | <meta name="robots" content="max-snippet:0"> | [link](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag) |
| GT-085 | `client-side-rendered-content` | `/pricing` | The price list, the main content of the page, is only loaded by JavaScript from /api/prices.json; the HTML response contains "Loading prices…" and no prices. | <div id="price-table" data-src="/api/prices.json"><p>Loading prices…</p></div> | [link](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) |
| GT-086 | `client-side-rendered-content` | `/patient-stories` | All main content, including the H1, is rendered in the browser from /data/stories.json; the HTML response contains only an empty <div id="app"> and a "please enable JavaScript" message. AI crawlers that do not run JavaScript see nothing. | <main id="main"><div id="app" aria-live="polite"></div><noscript>… | [link](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) |
| GT-087 | `robots-blocks-ai-training-bot` | `/robots.txt` | GPTBot is disallowed from the whole site, although llms.txt says the practice welcomes AI assistants using its content. | User-agent: GPTBot / Disallow: / | [link](https://platform.openai.com/docs/bots) |
| GT-088 | `robots-blocks-ai-search-bot` | `/robots.txt` | PerplexityBot (the crawler that indexes pages for Perplexity answers) is disallowed from the whole site, so the practice cannot appear in Perplexity search results. | User-agent: PerplexityBot / Disallow: / | [link](https://docs.perplexity.ai/guides/bots) |
| GT-089 | `robots-blocks-ai-user-agent` | `/robots.txt` | ChatGPT-User (fetches pages when a ChatGPT user asks about them) is disallowed from the whole site. | User-agent: ChatGPT-User / Disallow: / | [link](https://platform.openai.com/docs/bots) |
| GT-090 | `robots-blocks-ai-bot-path` | `/robots.txt` | ClaudeBot is disallowed from /team/, hiding all clinician biographies (the authorship and expertise pages) from Anthropic’s crawler while the rest of the site is allowed. | User-agent: ClaudeBot / Disallow: /team/ | [link](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler) |
| GT-091 | `llms-txt-missing-h1` | `/llms.txt` | llms.txt does not start with the required H1 (the site or project name); it begins with a blockquote. | First line: "> Harbourline Dental Studio is an independent…"; no line starting "# ". | [link](https://llmstxt.org/) |
| GT-092 | `llms-txt-broken-link` | `/llms.txt` | llms.txt links to a page that returns 404. | [Teeth whitening]({{ORIGIN}}/services/teeth-whitening-old) → 404. | [link](https://llmstxt.org/) |
| GT-093 | `waf-blocks-ai-bot` | `/services/` | Every treatment page under /services/ returns 403 with a "request blocked" challenge page to AI crawler user agents (ClaudeBot, Claude-SearchBot, Claude-User, OAI-SearchBot, GPTBot, ChatGPT-User, PerplexityBot, Perplexity-User, Google-Extended, CCBot, Applebot-Extended, Bytespider, meta-externalagent), although robots.txt allows most of them there. Browsers and Googlebot get 200. | GET /services/dental-implants with User-Agent containing "ClaudeBot" → 403 "Request blocked"; same URL with a browser UA → 200. | [link](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler) |

## AEO / GEO readiness

| ID | Type | URL | What is wrong | Evidence | Source |
| --- | --- | --- | --- | --- | --- |
| GT-094 | `schema-unknown-type` | `/services/childrens-dentistry` | JSON-LD uses "@type": "DentalPractice", which is not a schema.org type. | "@type": "DentalPractice" | [link](https://schema.org/docs/full.html) |
| GT-095 | `schema-content-not-visible` | `/services/veneers` | FAQPage structured data marks up questions and answers that do not appear anywhere on the page. | JSON-LD question "Do veneers ruin your natural teeth?" is not in the visible text. | [link](https://developers.google.com/search/docs/appearance/structured-data/sd-policies) |
| GT-096 | `schema-conflicting-entity` | `/locations` | JSON-LD reuses the organisation @id from the home page but gives a different name and telephone, so the entity is described inconsistently. | @id "{{ORIGIN}}/#org" named "Harbour Line Dental Clinic Ltd", +44 20 7946 0000 here vs "Harbourline Dental Studio", +44 117 496 0123 on /. | [link](https://developers.google.com/search/docs/appearance/structured-data/sd-policies) |
| GT-097 | `self-serving-review-markup` | `/locations/bristol` | LocalBusiness (Dentist) markup carries an aggregateRating about the business itself on its own site, which Google treats as self-serving and ineligible; no reviews are shown on the page. | "aggregateRating": {"ratingValue": "4.9", "reviewCount": "312"} in the Dentist JSON-LD. | [link](https://developers.google.com/search/docs/appearance/structured-data/review-snippet) |
| GT-098 | `nap-inconsistent` | `/locations/bath` | Telephone number in LocalBusiness JSON-LD differs from the number shown on the page and in the footer. | JSON-LD "telephone": "+44 1632 960999" vs visible "01632 960 245". | [link](https://developers.google.com/search/docs/appearance/structured-data/local-business) |
| GT-099 | `missing-localbusiness-schema` | `/locations/leeds` | Clinic location page has no LocalBusiness/Dentist structured data (the other two clinic pages do). | Only BreadcrumbList JSON-LD present. | [link](https://developers.google.com/search/docs/appearance/structured-data/local-business) |
| GT-100 | `json-ld-syntax-error` | `/blog/dental-implants-cost` | JSON-LD block is not valid JSON (trailing comma, missing closing brace) so no structured data can be read. | "dateModified": "2026-03-01",\n} — trailing comma and unbalanced braces. | [link](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data) |
| GT-101 | `missing-author` | `/blog/sugar-and-teeth` | Article has no author: no byline on the page and no author in the BlogPosting JSON-LD. | BlogPosting JSON-LD without "author"; no "By …" byline. | [link](https://developers.google.com/search/docs/appearance/structured-data/article) |
| GT-102 | `missing-publish-date` | `/blog/healthy-snacks` | Article shows no publication or update date and its BlogPosting JSON-LD has no datePublished/dateModified. | No <time> element; JSON-LD lacks datePublished. | [link](https://developers.google.com/search/docs/appearance/structured-data/article) |
| GT-103 | `missing-article-schema` | `/blog/mouthwash-guide` | Blog article has no structured data at all (no Article/BlogPosting, no BreadcrumbList), unlike every other article. | No <script type="application/ld+json">. | [link](https://developers.google.com/search/docs/appearance/structured-data/article) |
| GT-104 | `schema-invalid-date` | `/blog/sensitive-teeth` | BlogPosting datePublished is free text, not an ISO 8601 date. | "datePublished": "last winter" | [link](https://developers.google.com/search/docs/appearance/structured-data/article) |
| GT-105 | `no-subheadings` | `/blog/history-of-dentistry` | Long article (about 560 words in eight paragraphs) has no subheadings at all, so it cannot be scanned or split into passages. | Zero h2–h6 in main content. | [link](https://developers.google.com/search/docs/fundamentals/creating-helpful-content) |
| GT-106 | `schema-invalid-value` | `/blog/open-evening-november` | Event structured data ends before it starts (endDate 16:00 is earlier than startDate 18:00), contradicting the visible 6pm–8pm. | "startDate": "2026-11-20T18:00:00+00:00", "endDate": "2026-11-20T16:00:00+00:00" | [link](https://developers.google.com/search/docs/appearance/structured-data/event) |
| GT-107 | `date-modified-before-published` | `/blog/root-canal-myths` | BlogPosting dateModified (2025-02-01) is earlier than datePublished (2026-08-04). | "datePublished": "2026-08-04", "dateModified": "2025-02-01" | [link](https://developers.google.com/search/docs/appearance/structured-data/article) |
| GT-108 | `schema-missing-required-property` | `/blog/how-to-brush-your-teeth` | BreadcrumbList ListItems have no "position", a required property. | ListItem objects with name and item but no position. | [link](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb) |

## Agentic web

| ID | Type | URL | What is wrong | Evidence | Source |
| --- | --- | --- | --- | --- | --- |
| GT-109 | `non-semantic-button` | `/team/tom-ellis` | A clickable "Book with Tom" control is a <div> with a script click handler: no button/link role, not focusable, no href for agents or crawlers. | <div class="btn" data-href="/book">Book with Tom</div> (click handled in /assets/js/site.js). | [link](https://www.w3.org/WAI/ARIA/apg/patterns/button/) |
| GT-110 | `layout-shift` | `/blog/clinic-refurbishment` | A script inserts a 160px notice banner above the article about 600 ms after load, pushing all content down (CLS well above 0.1). | <script src="/assets/js/notice-banner.js"> inserts a banner at the top of <main> after a timeout. | [link](https://web.dev/articles/cls) |
| GT-111 | `custom-widget-missing-roles` | `/blog/smile-makeover` | A tab widget is built from clickable <span>s with no tab/tablist/tabpanel roles, no focusability and no aria-selected, so agents and assistive tech cannot see or operate it. | <span class="tab is-active" data-tab="before">Before treatment</span> … | [link](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) |
| GT-112 | `webmcp-tool-missing-description` | `/contact` | Form is declared as a WebMCP tool (toolname="send_enquiry") but has no tooldescription, so agents are not told what the tool does. | <form … toolname="send_enquiry"> without tooldescription. | [link](https://developer.chrome.com/docs/ai/webmcp) |
| GT-113 | `webmcp-schema-invalid` | `/book` | The page registers a WebMCP tool whose inputSchema is not valid JSON Schema ("type": "objekt", property type "date", "required" as a string). | /assets/js/book-tools.js: navigator.modelContext.registerTool({ … inputSchema: { type: "objekt", … required: "date" } }) | [link](https://developer.chrome.com/docs/lighthouse/agentic-browsing/scoring) |
| GT-114 | `autocomplete-invalid` | `/new-patients` | Form fields use invalid autocomplete tokens ("e-mail", "phone"), so browsers and agents cannot identify the fields' purpose (WCAG 1.3.5). | autocomplete="e-mail" and autocomplete="phone" (valid tokens are "email" and "tel"). | [link](https://dequeuniversity.com/rules/axe/4.10/autocomplete-valid) |
| GT-115 | `a2a-card-invalid` | `/.well-known/agent-card.json` | A2A Agent Card is missing required fields "version" and "skills". | agent-card.json has protocolVersion, name, description, url, capabilities, default*Modes but no version and no skills array. | [link](https://a2a-protocol.org/latest/specification/) |
| GT-116 | `a2a-endpoint-unreachable` | `/.well-known/agent-card.json` | The A2A service endpoint advertised in the Agent Card returns 404. | "url": "{{ORIGIN}}/a2a" → GET/POST 404. | [link](https://a2a-protocol.org/latest/specification/) |
| GT-117 | `mcp-server-card-invalid` | `/.well-known/mcp/server-card.json` | MCP Server Card is not valid JSON (trailing comma in "remotes" and missing closing brace). | "remotes": [ {…}, ]  and no final } | [link](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649) |
| GT-118 | `mcp-endpoint-unreachable` | `/.well-known/mcp.json` | The streamable-HTTP MCP endpoint advertised in /.well-known/mcp.json returns 404. | "remotes": [{"type": "streamable-http", "url": "{{ORIGIN}}/mcp"}] → 404. | [link](https://modelcontextprotocol.io/seps/2127-mcp-server-cards) |
| GT-119 | `oauth-metadata-issuer-mismatch` | `/.well-known/oauth-authorization-server` | Authorization server metadata "issuer" does not match the URL the metadata was fetched from; RFC 8414 §3.3 requires clients to reject it. | "issuer": "https://auth.harbourline-dental.example" served at {{ORIGIN}}/.well-known/oauth-authorization-server. | [link](https://www.rfc-editor.org/rfc/rfc8414) |
| GT-120 | `oauth-protected-resource-invalid` | `/.well-known/oauth-protected-resource` | Protected Resource Metadata lacks the REQUIRED "resource" member. | JSON has authorization_servers, scopes_supported, bearer_methods_supported, resource_name; no "resource". | [link](https://www.rfc-editor.org/rfc/rfc9728) |
| GT-121 | `api-catalog-broken-link` | `/.well-known/api-catalog` | The api-catalog linkset’s service-desc (OpenAPI description) URL returns 404. | "service-desc": [{"href": "{{ORIGIN}}/openapi.json"}] → 404. | [link](https://www.rfc-editor.org/rfc/rfc9727) |

