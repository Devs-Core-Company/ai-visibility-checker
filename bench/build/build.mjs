// Builds bench/site/, bench/ground-truth.json and bench/GROUND_TRUTH.md.
// Usage: node build.mjs <benchDir>
import fs from 'node:fs';
import path from 'node:path';
import { services, team, locations } from './content-pages.mjs';
import { posts } from './content-blog.mjs';
import { serviceExtra, teamExtra, locationExtra, pageExtra, archiveExtra } from './extras.mjs';

const BENCH = path.resolve(process.argv[2]);
const SITE = path.join(BENCH, 'site');
const O = '{{ORIGIN}}';
const BRAND = 'Harbourline Dental Studio';

const files = new Map(); // relpath -> content
const put = (rel, content) => files.set(rel, content);
const defects = [];
const controls = [];
const def = (d) => defects.push(d);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const teamBy = Object.fromEntries(team.map((t) => [t.slug, t]));
const svcBy = Object.fromEntries(services.map((s) => [s.slug, s]));
const fmtDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// ---------------------------------------------------------------- sources
const S = {
  title: 'https://developers.google.com/search/docs/appearance/title-link',
  lhTitle: 'https://dequeuniversity.com/rules/axe/4.10/document-title',
  snippet: 'https://developers.google.com/search/docs/appearance/snippet',
  lhMeta: 'https://developer.chrome.com/docs/lighthouse/seo/meta-description',
  canonical: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls',
  lhCanonical: 'https://developer.chrome.com/docs/lighthouse/seo/canonical',
  redirects: 'https://developers.google.com/search/docs/crawling-indexing/301-redirects',
  httpStatus: 'https://developers.google.com/search/docs/crawling-indexing/http-network-errors',
  softhttp: 'https://developers.google.com/search/docs/crawling-indexing/http-network-errors#soft-404-errors',
  robotsMeta: 'https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag',
  sitemapsOrg: 'https://www.sitemaps.org/protocol.html',
  sitemapG: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap',
  hreflang: 'https://developers.google.com/search/docs/specialty/international/localized-versions',
  lhHreflang: 'https://developer.chrome.com/docs/lighthouse/seo/hreflang',
  pagination: 'https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading',
  urlStructure: 'https://developers.google.com/search/docs/crawling-indexing/url-structure',
  links: 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable',
  lhLinkText: 'https://developer.chrome.com/docs/lighthouse/seo/link-text',
  lhCrawlableAnchors: 'https://developer.chrome.com/docs/lighthouse/seo/crawlable-anchors',
  qualifyLinks: 'https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links',
  jsSeo: 'https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics',
  robotsIntro: 'https://developers.google.com/search/docs/crawling-indexing/robots/intro',
  rfc9309: 'https://www.rfc-editor.org/rfc/rfc9309',
  sdPolicies: 'https://developers.google.com/search/docs/appearance/structured-data/sd-policies',
  sdIntro: 'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data',
  review: 'https://developers.google.com/search/docs/appearance/structured-data/review-snippet',
  breadcrumb: 'https://developers.google.com/search/docs/appearance/structured-data/breadcrumb',
  localBusiness: 'https://developers.google.com/search/docs/appearance/structured-data/local-business',
  article: 'https://developers.google.com/search/docs/appearance/structured-data/article',
  event: 'https://developers.google.com/search/docs/appearance/structured-data/event',
  schemaOrg: 'https://schema.org/docs/full.html',
  helpful: 'https://developers.google.com/search/docs/fundamentals/creating-helpful-content',
  aiFeatures: 'https://developers.google.com/search/docs/appearance/ai-features',
  images: 'https://developers.google.com/search/docs/appearance/google-images',
  lhDoctype: 'https://developer.chrome.com/docs/lighthouse/best-practices/doctype',
  lhCharset: 'https://developer.chrome.com/docs/lighthouse/best-practices/charset',
  lhConsole: 'https://developer.chrome.com/docs/lighthouse/best-practices/errors-in-console',
  lhCompression: 'https://developer.chrome.com/docs/lighthouse/performance/uses-text-compression',
  lhTtfb: 'https://developer.chrome.com/docs/lighthouse/performance/server-response-time',
  lhUnsized: 'https://developer.chrome.com/docs/lighthouse/performance/unsized-images',
  lhDom: 'https://developer.chrome.com/docs/lighthouse/performance/dom-size',
  lhOptImages: 'https://developer.chrome.com/docs/lighthouse/performance/uses-optimized-images',
  lhViewport: 'https://developer.chrome.com/docs/lighthouse/pwa/viewport',
  cls: 'https://web.dev/articles/cls',
  owaspHeaders: 'https://owasp.org/www-project-secure-headers/',
  owaspFingerprint: 'https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/02-Fingerprint_Web_Server',
  rfc9116: 'https://www.rfc-editor.org/rfc/rfc9116',
  wcag: (anchor) => `https://www.w3.org/TR/WCAG22/#${anchor}`,
  axe: (rule) => `https://dequeuniversity.com/rules/axe/4.10/${rule}`,
  llms: 'https://llmstxt.org/',
  openaiBots: 'https://platform.openai.com/docs/bots',
  perplexityBots: 'https://docs.perplexity.ai/guides/bots',
  anthropicBots: 'https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler',
  a2a: 'https://a2a-protocol.org/latest/specification/',
  mcpCard: 'https://modelcontextprotocol.io/seps/2127-mcp-server-cards',
  mcpCard1649: 'https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649',
  rfc8414: 'https://www.rfc-editor.org/rfc/rfc8414',
  rfc9728: 'https://www.rfc-editor.org/rfc/rfc9728',
  rfc9727: 'https://www.rfc-editor.org/rfc/rfc9727',
  webmcp: 'https://developer.chrome.com/docs/ai/webmcp',
  lhAgentic: 'https://developer.chrome.com/docs/lighthouse/agentic-browsing/scoring',
  jsonSchema: 'https://json-schema.org/draft/2020-12/json-schema-validation',
  htmlAutofill: 'https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofilling-form-controls:-the-autocomplete-attribute',
  ariaButton: 'https://www.w3.org/WAI/ARIA/apg/patterns/button/',
  ariaTabs: 'https://www.w3.org/WAI/ARIA/apg/patterns/tabs/',
  rfc7231alt: 'https://html.spec.whatwg.org/multipage/links.html#rel-alternate',
};

// ---------------------------------------------------------------- layout
const NAV = [
  ['/', 'Home'], ['/services', 'Treatments'], ['/team', 'Our team'], ['/locations', 'Clinics'],
  ['/pricing', 'Prices'], ['/blog', 'Advice'], ['/faq', 'FAQ'], ['/contact', 'Contact'],
];
const FOOT = [
  ['/about', 'About Harbourline'], ['/new-patients', 'New patients'], ['/finance', 'Paying for treatment'],
  ['/careers', 'Careers'], ['/referrals', 'Referrals for dentists'], ['/developers', 'Developers'],
  ['/legal/privacy', 'Privacy notice'], ['/legal/cookies', 'Cookie policy'], ['/legal/terms', 'Terms of treatment'],
  ['/legal/complaints', 'Complaints procedure'], ['/legal/accessibility', 'Accessibility statement'],
];

function header(currentPath) {
  return `<a class="skip" href="#main">Skip to main content</a>
<header class="site-header">
  <a href="/" class="logo"><img src="/images/logo.png" alt="${BRAND} home" width="240" height="60"></a>
  <nav aria-label="Main">
    <ul>
${NAV.map(([h, t]) => `      <li><a href="${h}"${h === currentPath ? ' aria-current="page"' : ''}>${t}</a></li>`).join('\n')}
      <li><a class="nav-cta" href="/book">Book an appointment</a></li>
    </ul>
  </nav>
</header>`;
}
function footer() {
  return `<footer class="site-footer">
  <div class="footer-grid">
    <section aria-labelledby="ft-clinics">
      <h2 id="ft-clinics">Our clinics</h2>
${locations.map((l) => `      <p><a href="/locations/${l.slug}">${BRAND} ${l.city}</a><br>${l.street}, ${l.city} ${l.postcode}<br>Telephone ${l.phone}</p>`).join('\n')}
    </section>
    <section aria-labelledby="ft-info">
      <h2 id="ft-info">Information</h2>
      <ul>
${FOOT.map(([h, t]) => `        <li><a href="${h}">${t}</a></li>`).join('\n')}
      </ul>
    </section>
  </div>
  <p class="small">${BRAND} is a fictional dental practice used as a test website. All names, addresses and telephone numbers are fictitious.</p>
</footer>`;
}
function crumbsHtml(crumbs) {
  if (!crumbs) return '';
  return `<nav aria-label="Breadcrumb" class="crumbs"><ol>${crumbs.map(([h, t], i) => (i === crumbs.length - 1 ? `<li><span aria-current="page">${esc(t)}</span></li>` : `<li><a href="${h}">${esc(t)}</a></li>`)).join('')}</ol></nav>`;
}
function crumbsLd(crumbs, { noPosition = false } = {}) {
  return {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: crumbs.map(([h, t], i) => {
      const o = { '@type': 'ListItem' };
      if (!noPosition) o.position = i + 1;
      o.name = t;
      o.item = O + h;
      return o;
    }),
  };
}
const ld = (obj) => `<script type="application/ld+json">\n${typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)}\n</script>`;

/**
 * page(opts) -> html string
 * opts: path, title, titles[], desc, descs[], canonical (string|array|false), lang (string|null), viewport (string|null),
 *       doctype(bool), charset(bool), robots, og(bool), head (extra), schema [], hreflang [[code, href]],
 *       crumbs, main (html), mainTag ('main'|'div'), scripts [], image (og image)
 */
function page(o) {
  const p = o.path;
  const out = [];
  if (o.doctype !== false) out.push('<!doctype html>');
  out.push(o.lang === null ? '<html>' : `<html lang="${o.lang || 'en-GB'}">`);
  out.push('<head>');
  if (o.charset !== false) out.push('<meta charset="utf-8">');
  if (o.viewport !== null) out.push(`<meta name="viewport" content="${o.viewport || 'width=device-width, initial-scale=1'}">`);
  const titles = o.titles || (o.title === null ? [] : [o.title]);
  for (const t of titles) out.push(`<title>${esc(t)}</title>`);
  const descs = o.descs || (o.desc == null ? [] : [o.desc]);
  for (const d of descs) out.push(`<meta name="description" content="${esc(d)}">`);
  if (o.robots) out.push(`<meta name="robots" content="${o.robots}">`);
  const canon = o.canonical === undefined ? O + p : o.canonical;
  if (canon) for (const c of [].concat(canon)) out.push(`<link rel="canonical" href="${c}">`);
  for (const [code, href] of o.hreflang || []) out.push(`<link rel="alternate" hreflang="${code}" href="${O}${href}">`);
  if (o.head) out.push(o.head);
  out.push('<link rel="icon" href="/favicon.png" type="image/png">');
  out.push('<link rel="stylesheet" href="/assets/css/site.css">');
  if (o.og !== false && titles.length) {
    const t = titles[0];
    out.push(`<meta property="og:type" content="${o.ogType || 'website'}">`);
    out.push(`<meta property="og:site_name" content="${BRAND}">`);
    out.push(`<meta property="og:title" content="${esc(t.replace(/ \| .*$/, ''))}">`);
    if (descs[0]) out.push(`<meta property="og:description" content="${esc(descs[0])}">`);
    out.push(`<meta property="og:url" content="${O}${p}">`);
    out.push(`<meta property="og:image" content="${O}${o.image || '/images/og-default.jpg'}">`);
    out.push('<meta name="twitter:card" content="summary_large_image">');
  }
  for (const s of o.schema || []) out.push(ld(s));
  out.push('<script src="/assets/js/site.js" defer></script>');
  for (const s of o.scripts || []) out.push(`<script src="${s}" defer></script>`);
  out.push('</head>');
  out.push('<body>');
  out.push(header(p));
  out.push(crumbsHtml(o.crumbs));
  const mt = o.mainTag || 'main';
  out.push(`<${mt} id="main">`);
  out.push(o.main);
  out.push(`</${mt}>`);
  out.push(footer());
  out.push('</body>');
  out.push('</html>');
  return out.join('\n') + '\n';
}
const fileFor = (p) => (p === '/' ? 'index.html' : p.replace(/^\//, '') + '.html');
const addPage = (o) => { if (pageExtra[o.path]) o.main += '\n' + pageExtra[o.path]; put(fileFor(o.path), page(o)); pagesMeta.push(o); };
const pagesMeta = [];
const sec = (h, paras, lvl = 2) => `${h ? `<h${lvl}>${esc(h)}</h${lvl}>\n` : ''}${paras.map((x) => `<p>${x}</p>`).join('\n')}`;
const fig = (src, alt, w, h, { lazy = true, priority = false, extra = '' } = {}) =>
  `<img src="${src}"${alt === undefined ? '' : ` alt="${esc(alt)}"`}${w ? ` width="${w}" height="${h}"` : ''}${lazy ? ' loading="lazy"' : ''}${priority ? ' fetchpriority="high"' : ''}${extra}>`;

const ORG_ID = `${O}/#org`;
const orgRef = { '@id': ORG_ID };
const webPage = (p, name, desc) => ({ '@context': 'https://schema.org', '@type': 'WebPage', '@id': `${O}${p}#webpage`, url: O + p, name, description: desc, isPartOf: { '@id': `${O}/#website` }, publisher: orgRef });

// ================================================================ HOME (control)
{
  const featured = ['general-dentistry', 'dental-implants', 'teeth-whitening', 'emergency-dentist', 'hygiene', 'childrens-dentistry'];
  addPage({
    path: '/', title: 'Harbourline Dental Studio | Dentists in Bristol, Bath, Leeds',
    desc: 'Independent dental practice with clinics in Bristol, Bath and Leeds. Check-ups, hygiene, implants, aligners and same-day emergency appointments.',
    schema: [
      { '@context': 'https://schema.org', '@type': 'Dentist', '@id': ORG_ID, name: BRAND, url: O + '/', logo: O + '/images/logo.png', image: O + '/images/hero-harbourline.jpg', telephone: '+44 117 496 0123', email: 'hello@harbourline.example', priceRange: '££', address: { '@type': 'PostalAddress', streetAddress: '14 Quay Street', addressLocality: 'Bristol', postalCode: 'BS1 4DB', addressCountry: 'GB' }, openingHours: 'Mo-Fr 08:00-19:00 Sa 09:00-14:00', foundingDate: '2012', department: locations.map((l) => ({ '@id': `${O}/locations/${l.slug}#clinic` })) },
      { '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${O}/#website`, url: O + '/', name: BRAND, publisher: orgRef, inLanguage: 'en-GB' },
    ],
    main: `<section class="hero">
<h1>Friendly, unhurried dental care in Bristol, Bath and Leeds</h1>
<p class="lead">${BRAND} is an independent practice founded in 2012 by Dr Amelia Hart. We look after around nine thousand patients across three clinics, from first baby teeth to implants, and we keep appointments to time.</p>
<p><a class="btn" href="/book">Book an appointment</a> <a class="btn btn-secondary" href="/new-patients">Information for new patients</a></p>
${fig('/images/hero-harbourline.jpg', 'Reception area at Harbourline Dental Studio in Bristol', 800, 500, { lazy: false, priority: true })}
</section>
<section aria-labelledby="h-treat">
<h2 id="h-treat">Popular treatments</h2>
<ul class="cards">
${featured.map((s) => `<li><a href="/services/${s}">${fig(`/images/services/${s}.jpg`, `${svcBy[s].name} at Harbourline`, 400, 250)}<span>${svcBy[s].name}</span></a></li>`).join('\n')}
</ul>
<p>See <a href="/services">all treatments and how they work</a>, or check <a href="/pricing">our current prices</a>.</p>
</section>
<section aria-labelledby="h-why">
<h2 id="h-why">Why patients choose Harbourline</h2>
<p>Every new patient has a forty-minute first appointment with a dentist. We use that time to understand what matters to you, check your teeth and gums thoroughly and explain what we find in plain language before anything is booked.</p>
<p>Each treatment plan is written down with the fee for every item. You can take it away, think it over and ask questions by email or phone. We never ask for a decision in the chair.</p>
<p>Our clinics hold emergency appointments every weekday morning, so existing patients in pain are seen the same day. Evening appointments run until 7pm in Bristol, and Bath opens at 7.30am on Tuesdays.</p>
</section>
<section aria-labelledby="h-clinics">
<h2 id="h-clinics">Three clinics</h2>
<p>Our <a href="/locations/bristol">Bristol clinic on Quay Street</a> is the largest and hosts the implant service. The <a href="/locations/bath">Bath clinic at Abbey Green</a> focuses on aligners and cosmetic dentistry. Our <a href="/locations/leeds">Leeds clinic at Granary Wharf</a> leads our gum health work.</p>
</section>
<section aria-labelledby="h-advice">
<h2 id="h-advice">Recent advice from our team</h2>
<ul>
<li><a href="/blog/choosing-a-toothpaste">How to choose a toothpaste that works</a></li>
<li><a href="/blog/wisdom-teeth">When wisdom teeth need removing</a></li>
<li><a href="/blog/dental-checkups-how-often">How often you need a check-up</a></li>
</ul>
</section>`,
  });
  controls.push('/');
}

// ================================================================ SERVICES
{
  // services index: list with invalid child (A) + link to soft 404
  addPage({
    path: '/services', title: 'Dental Treatments at Harbourline Dental Studio',
    desc: 'All treatments offered at Harbourline: general dentistry, hygiene, implants, whitening, aligners, veneers, children’s care and emergencies.',
    crumbs: [['/', 'Home'], ['/services', 'Treatments']],
    schema: [crumbsLd([['/', 'Home'], ['/services', 'Treatments']])],
    main: `<h1>Our dental treatments</h1>
<p class="lead">We offer routine and specialist dental care at all three clinics. Some treatments, such as implants and clear aligners, are based at one clinic, and we will book you there.</p>
<ul class="service-list">
<div class="list-intro">Routine care</div>
${services.map((s) => `<li><a href="/services/${s.slug}">${s.name}</a>: ${esc(s.desc.split('.')[0])}.</li>`).join('\n')}
</ul>
<h2>Nervous about treatment?</h2>
<p>Read about <a href="/services/sedation">sedation for nervous patients</a> or our article on <a href="/blog/nervous-patients">how we help anxious patients</a>.</p>
<h2>How treatment is planned</h2>
<p>Every course of treatment starts with an examination. Your dentist explains the options, including doing nothing, and gives you a written plan with fees. Larger plans are discussed at a separate consultation so there is time for questions.</p>
<p>Where treatment needs skills we do not offer in-house, such as complex oral surgery, we refer you to trusted specialists in Bristol, Bath or Leeds and explain the likely costs before referral.</p>
<h2>Children and young people</h2>
<p>Children are welcome at every clinic. Our dental therapists provide much of their preventive care, including fluoride varnish and sealants, and children’s check-ups are free when a parent is a registered patient.</p>`,
  });
  def({ area: 'accessibility', type: 'list-invalid-children', scope: 'page', url: '/services', description: 'A <ul> contains a <div> as a direct child; lists may only contain <li>, <script> or <template>.', source: S.axe('list'), evidence: '<ul class="service-list"><div class="list-intro">Routine care</div>…', verify: [{ html: '<ul class="service-list">\\s*<div' }] });
  def({ area: 'technical', type: 'soft-404', scope: 'page', url: '/services/sedation', found_on: '/services', description: 'URL returns 200 OK but the page says the content cannot be found.', source: S.softhttp, evidence: 'HTTP 200 with <title>Page not found…</title> and "we can’t find that page".', alt_types: ['thin-content'], verify: [{ status: 200 }, { html: 'Page not found' }] });

  // soft 404 page
  put('services/sedation.html', page({
    path: '/services/sedation', title: 'Page not found | Harbourline Dental Studio', desc: 'Sorry, we could not find the page you were looking for.',
    main: `<h1>Sorry, we can’t find that page</h1>
<p>The page you asked for may have moved or no longer exists. Try our <a href="/services">list of treatments</a> or <a href="/">return to the home page</a>.</p>`,
  }));

  for (const s of services) {
    const p = `/services/${s.slug}`;
    const crumbs = [['/', 'Home'], ['/services', 'Treatments'], [p, s.name]];
    const o = { path: p, title: s.title, desc: s.desc, crumbs, image: `/images/services/${s.slug}.jpg` };
    const svcLd = { '@context': 'https://schema.org', '@type': 'Service', '@id': `${O}${p}#service`, name: s.name, description: s.desc, provider: orgRef, areaServed: ['Bristol', 'Bath', 'Leeds'], url: O + p };
    o.schema = [crumbsLd(crumbs), svcLd];
    let extraTop = '';
    let imgAlt = `${s.name} treatment room at Harbourline`;
    let body = s.sections.map(([h, ps]) => sec(h, ps)).join('\n');
    let h1 = `<h1>${esc(s.h1)}</h1>`;
    const feesPara = `<h2>Fees and booking</h2>\n<p>The current fee for ${s.name.toLowerCase()} is listed on our <a href="/pricing">prices page</a>, and your dentist will confirm it in writing before treatment. You can <a href="/book">book online</a> or call any of our clinics.</p>`;

    if (s.slug === 'general-dentistry') {
      extraTop = `<p><button type="button" class="toggle" aria-expandd="false" aria-controls="gd-more">Show opening times for check-ups</button></p>
<div id="gd-more"><p>Check-ups are available at all three clinics during normal opening hours. Early and late slots are popular, so book a few weeks ahead if you need one.</p></div>`;
      def({ area: 'accessibility', type: 'aria-invalid-attribute', scope: 'page', url: p, description: 'A button uses the misspelt, non-existent ARIA attribute aria-expandd.', source: S.axe('aria-valid-attr'), evidence: '<button … aria-expandd="false">', verify: [{ html: 'aria-expandd=' }] });
    }
    if (s.slug === 'dental-implants') {
      imgAlt = 'dental implants Bristol best dental implants Bristol cheap dental implants Bristol implant dentist Bristol teeth implants Bristol affordable dental implants near me Bristol';
      def({ area: 'content', type: 'img-alt-keyword-stuffed', scope: 'page', url: p, description: 'Image alt text is a string of repeated keywords rather than a description of the image.', source: S.images, evidence: 'alt="dental implants Bristol best dental implants Bristol cheap dental implants…" (160+ characters, keyword repeated).', verify: [{ html: 'alt="dental implants Bristol best dental implants Bristol cheap' }] });
    }
    if (s.slug === 'teeth-whitening') {
      body = body.replace('<h2>Sensitivity and safety</h2>', '<h1>Sensitivity and safety</h1>');
      def({ area: 'content', type: 'multiple-h1', scope: 'page', url: p, description: 'Page has two <h1> elements.', source: S.title, evidence: '<h1>Professional teeth whitening</h1> and <h1>Sensitivity and safety</h1>.', verify: [{ count: '<h1', equals: 2 }] });
    }
    if (s.slug === 'invisalign') {
      o.robots = 'noindex, follow';
      def({ area: 'technical', type: 'sitemap-contains-noindex', scope: 'page', url: p, description: 'Key treatment page carries meta robots noindex while being listed in the XML sitemap and linked from the treatments list: contradictory indexing signals.', source: S.sitemapG, evidence: '<meta name="robots" content="noindex, follow"> and <loc>…/services/invisalign</loc> in sitemap-pages.xml.', alt_types: ['noindex-page', 'noindex-page-linked'], verify: [{ html: '<meta name="robots" content="noindex' }, { url: '/sitemaps/sitemap-pages.xml', html: '/services/invisalign<' }] });
    }
    if (s.slug === 'emergency-dentist') {
      body = `<p>Existing and new patients can <a href="/book-now">book an emergency appointment</a> online or by phone.</p>`;
      def({ area: 'content', type: 'thin-content', scope: 'page', url: p, description: 'Service page has under 60 words of main content.', source: S.helpful, evidence: 'Main content is one lead paragraph and one sentence.', verify: [{ mainWordsMax: 80 }] });
      def({ area: 'technical', type: 'redirect-chain', scope: 'page', url: '/book-now', found_on: p, description: 'Internal link points to a URL that redirects twice (301 → 301) before reaching the final page.', source: S.redirects, evidence: '/book-now → 301 /booking → 301 /book → 200.', alt_types: ['internal-link-to-redirect'], verify: [{ redirect: { status: 301, location: '/booking' } }, { url: '/booking', redirect: { status: 301, location: '/book' } }, { url: p, html: 'href="/book-now"' }] });
    }
    if (s.slug === 'hygiene') {
      // duplicate pair with the blog post scale-and-polish-explained
    }
    if (s.slug === 'childrens-dentistry') {
      svcLd['@type'] = 'DentalPractice';
      def({ area: 'content', type: 'title-too-long', scope: 'page', url: p, description: 'Title is far longer than search results display (over 150 characters).', source: S.title, evidence: `<title>${s.title}</title> (${s.title.length} characters).`, verify: [{ titleLenMin: 100 }] });
      def({ area: 'geo', type: 'schema-unknown-type', scope: 'page', url: p, description: 'JSON-LD uses "@type": "DentalPractice", which is not a schema.org type.', source: S.schemaOrg, evidence: '"@type": "DentalPractice"', verify: [{ html: '"@type": "DentalPractice"' }] });
    }
    if (s.slug === 'veneers') {
      o.canonical = [O + p, O + '/services/teeth-whitening'];
      o.schema.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [
        { '@type': 'Question', name: 'Do veneers ruin your natural teeth?', acceptedAnswer: { '@type': 'Answer', text: 'No. Composite veneers need little or no preparation of the tooth.' } },
        { '@type': 'Question', name: 'How long do porcelain veneers last?', acceptedAnswer: { '@type': 'Answer', text: 'Porcelain veneers typically last ten to fifteen years.' } },
      ] });
      def({ area: 'technical', type: 'multiple-canonicals', scope: 'page', url: p, description: 'Page declares two different rel=canonical URLs.', source: S.lhCanonical, evidence: 'Two <link rel="canonical"> tags: /services/veneers and /services/teeth-whitening.', verify: [{ count: 'rel="canonical"', equals: 2 }] });
      def({ area: 'geo', type: 'schema-content-not-visible', scope: 'page', url: p, description: 'FAQPage structured data marks up questions and answers that do not appear anywhere on the page.', source: S.sdPolicies, evidence: 'JSON-LD question "Do veneers ruin your natural teeth?" is not in the visible text.', verify: [{ html: 'Do veneers ruin your natural teeth' }, { visibleTextNot: 'Do veneers ruin your natural teeth' }] });
    }
    o.main = `${h1}
<p class="lead">${esc(s.lead)}</p>
${fig(`/images/services/${s.slug}.jpg`, imgAlt, 800, 500, { lazy: false, priority: true })}
${extraTop}
${body}
${s.slug === 'emergency-dentist' ? '' : serviceExtra(s) + '\n' + feesPara}`;
    if (s.slug === 'hygiene') o.main += `\n<p>Read more in our article on <a href="/blog/how-to-floss-properly">how to floss properly</a>.</p>`;
    addPage(o);
  }
}

// ================================================================ TEAM
{
  const crumbs = [['/', 'Home'], ['/team', 'Our team']];
  addPage({
    path: '/team', title: 'Meet Our Dentists and Hygienists | Harbourline',
    desc: 'Meet the dentists, hygienists and therapists at Harbourline Dental Studio, with their qualifications, interests and clinic days.',
    crumbs, schema: [crumbsLd(crumbs)],
    main: `<h1>Our dental team</h1>
<p class="lead">Harbourline has twenty-two staff across three clinics. These are the clinicians you are most likely to see.</p>
<ul class="cards">
${team.map((t) => `<li><a href="/team/${t.slug}">${t.slug === 'priya-shah' ? '' : fig(`/images/team/${t.slug}.jpg`, `Portrait of ${t.name}`, 300, 300)}<span>${t.name}, ${t.role}</span></a></li>`).join('\n')}
</ul>
<p>Want to book with one of the team? <a href="/book" class="icon-link"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20"><path d="M3 4h14v13H3z" fill="none" stroke="currentColor"/></svg></a></p>
<h2>Registration and training</h2>
<p>All our dentists, hygienists and therapists are registered with the General Dental Council. Each completes at least fifty hours of verifiable professional development every five years for dentists and seventy-five for hygienists and therapists, as the GDC requires, and many do considerably more.</p>
<p>We hold team training days twice a year on medical emergencies, safeguarding and infection control, and all clinical staff renew their life support training annually.</p>
<h2>Joining the team</h2>
<p>We are often looking for experienced dental nurses and receptionists. See our <a href="/careers">careers page</a> for current roles.</p>`,
  });
  def({ area: 'accessibility', type: 'link-missing-name', scope: 'page', url: '/team', description: 'A link contains only an aria-hidden SVG icon and has no accessible name.', source: S.axe('link-name'), evidence: '<a href="/book" class="icon-link"><svg aria-hidden="true" …></svg></a>', verify: [{ html: 'class="icon-link"><svg aria-hidden="true"' }] });
  def({ area: 'technical', type: 'slow-server-response', scope: 'page', url: '/team', description: 'Server takes about 2.5 seconds before sending the first byte.', source: S.lhTtfb, evidence: 'TTFB ≈ 2,500 ms (all other pages < 50 ms).', verify: [{ minMs: 2000 }] });

  for (const t of team) {
    const p = `/team/${t.slug}`;
    const tc = [...crumbs, [p, t.name]];
    const o = { path: p, title: t.title, desc: t.desc, crumbs: tc, image: `/images/team/${t.slug}.jpg`, ogType: 'profile',
      schema: [crumbsLd(tc), { '@context': 'https://schema.org', '@type': 'Person', '@id': `${O}${p}#person`, name: t.name, jobTitle: t.role, worksFor: orgRef, url: O + p, image: `${O}/images/team/${t.slug}.jpg` }] };
    let img = fig(`/images/team/${t.slug}.jpg`, `Portrait of ${t.name}`, 300, 300, { lazy: false });
    let extra = '';
    if (t.slug === 'dr-amelia-hart') {
      img = fig(`/images/team/${t.slug}.jpg`, undefined, 300, 300, { lazy: false });
      def({ area: 'accessibility', type: 'img-missing-alt', scope: 'page', url: p, description: 'Portrait image has no alt attribute.', source: S.axe('image-alt'), evidence: '<img src="/images/team/dr-amelia-hart.jpg" width="300" height="300"> with no alt.', verify: [{ html: '<img src="/images/team/dr-amelia-hart.jpg" width' }] });
    }
    if (t.slug === 'dr-rohan-mehta') {
      o.title = null;
      def({ area: 'content', type: 'missing-title', scope: 'page', url: p, description: 'Page has no <title> element.', source: S.lhTitle, evidence: 'No <title> in <head>.', verify: [{ count: '<title', equals: 0 }] });
    }
    if (t.slug === 'dr-sophie-lang') {
      o.lang = 'english';
      def({ area: 'accessibility', type: 'html-lang-invalid', scope: 'page', url: p, description: 'The html lang attribute is not a valid BCP 47 language tag.', source: S.axe('html-lang-valid'), evidence: '<html lang="english">', verify: [{ html: '<html lang="english">' }] });
      def({ area: 'content', type: 'meta-description-too-short', scope: 'page', url: p, description: 'Meta description is a single word (8 characters).', source: S.snippet, evidence: '<meta name="description" content="Dentist.">', verify: [{ html: 'name="description" content="Dentist\\."' }] });
    }
    if (t.slug === 'priya-shah') {
      img = fig('/images/team/priya-shah.jpg', 'Portrait of Priya Shah', 300, 300, { lazy: false });
      def({ area: 'technical', type: 'broken-image', scope: 'page', url: p, description: 'Image source returns 404.', source: S.httpStatus, evidence: '<img src="/images/team/priya-shah.jpg"> → 404.', related_url: '/images/team/priya-shah.jpg', verify: [{ url: '/images/team/priya-shah.jpg', status: 404 }, { html: 'src="/images/team/priya-shah.jpg"' }] });
    }
    if (t.slug === 'tom-ellis') {
      extra = '<div class="btn" data-href="/book">Book with Tom</div>';
      def({ area: 'content', type: 'placeholder-text', scope: 'page', url: p, description: 'Biography contains Lorem ipsum placeholder text.', source: S.helpful, evidence: '"Lorem ipsum dolor sit amet, consectetur adipiscing elit…"', verify: [{ html: 'Lorem ipsum dolor sit amet' }] });
      def({ area: 'agentic', type: 'non-semantic-button', scope: 'page', url: p, description: 'A clickable "Book with Tom" control is a <div> with a script click handler: no button/link role, not focusable, no href for agents or crawlers.', source: S.ariaButton, evidence: '<div class="btn" data-href="/book">Book with Tom</div> (click handled in /assets/js/site.js).', verify: [{ html: '<div class="btn" data-href="/book">' }] });
    }
    o.main = `<h1>${esc(t.h1)}</h1>
<p class="lead">${esc(t.role)}</p>
${img}
${t.paras.map((x) => `<p>${esc(x)}</p>`).join('\n')}
<h2>Booking an appointment</h2>
<p>You can request ${esc(t.name)} when you <a href="/book">book online</a>. If you are a new patient, read our <a href="/new-patients">guide for new patients</a> first.</p>
${teamExtra(t)}
${extra}`;
    addPage(o);
  }
  // redirect alias for Amelia (302 used for a permanent move)
  def({ area: 'technical', type: 'temporary-redirect', scope: 'page', url: '/team/dr-hart', found_on: '/about', description: 'Old profile URL is moved permanently but uses a 302 (temporary) redirect.', source: S.redirects, evidence: '/team/dr-hart → 302 → /team/dr-amelia-hart; linked from /about.', alt_types: ['internal-link-to-redirect'], verify: [{ redirect: { status: 302, location: '/team/dr-amelia-hart' } }, { url: '/about', html: 'href="/team/dr-hart"' }] });
}

// ================================================================ LOCATIONS
{
  const crumbs = [['/', 'Home'], ['/locations', 'Clinics']];
  addPage({
    path: '/locations', title: 'Our Dental Clinics in Bristol, Bath and Leeds | Harbourline',
    desc: 'Addresses, opening hours, parking and travel information for Harbourline Dental Studio clinics in Bristol, Bath and Leeds.',
    crumbs,
    schema: [crumbsLd(crumbs), { '@context': 'https://schema.org', '@type': 'Organization', '@id': ORG_ID, name: 'Harbour Line Dental Clinic Ltd', telephone: '+44 20 7946 0000', url: O + '/locations' }],
    main: `<h1>Find a Harbourline clinic</h1>
<p class="lead">We have three clinics. You can be seen at any of them, and your records are shared securely between sites.</p>
<ul class="cards">
<li><a href="/locations/bristol-clinic">${fig('/images/locations/bristol.jpg', 'Harbourline Bristol on Quay Street', 400, 250)}<span>Bristol, Quay Street</span></a></li>
<li><a href="/locations/bath">${fig('/images/locations/bath.jpg', 'Harbourline Bath at Abbey Green', 400, 250)}<span>Bath, Abbey Green</span></a></li>
<li><a href="/locations/leeds">${fig('/images/locations/leeds.jpg', 'Harbourline Leeds at Granary Wharf', 400, 250)}<span>Leeds, Granary Wharf</span></a></li>
</ul>
<h2>Which clinic should I choose?</h2>
<p>Most people choose the clinic nearest home or work. Implant surgery takes place in Bristol, and clear aligner treatment is based in Bath, but check-ups and hygiene visits for those patients can happen at any site.</p>
<h2>Accessibility</h2>
<p>Bristol and Leeds have step-free access to every room. Bath is in a listed building; treatment rooms are on the first floor and reached by a lift. Please tell us when you book if you need extra time or help.</p>
<h2>Moving between clinics</h2>
<p>Your dental records, X-rays and treatment plans are held on one secure system, so you can switch clinic at any time without repeating tests. Just tell reception which site you would prefer for future visits.</p>`,
  });
  def({ area: 'content', type: 'internal-link-to-redirect', scope: 'page', url: '/locations', related_url: '/locations/bristol-clinic', description: 'Internal link points to a URL that 301-redirects instead of linking the final URL.', source: S.redirects, evidence: '<a href="/locations/bristol-clinic"> → 301 → /locations/bristol.', verify: [{ html: 'href="/locations/bristol-clinic"' }, { url: '/locations/bristol-clinic', redirect: { status: 301, location: '/locations/bristol' } }] });
  def({ area: 'geo', type: 'schema-conflicting-entity', scope: 'page', url: '/locations', description: 'JSON-LD reuses the organisation @id from the home page but gives a different name and telephone, so the entity is described inconsistently.', source: S.sdPolicies, evidence: '@id "{{ORIGIN}}/#org" named "Harbour Line Dental Clinic Ltd", +44 20 7946 0000 here vs "Harbourline Dental Studio", +44 117 496 0123 on /.', verify: [{ html: 'Harbour Line Dental Clinic Ltd' }] });

  for (const l of locations) {
    const p = `/locations/${l.slug}`;
    const lc = [...crumbs, [p, l.city]];
    const clinicLd = { '@context': 'https://schema.org', '@type': 'Dentist', '@id': `${O}${p}#clinic`, name: `${BRAND} ${l.city}`, parentOrganization: orgRef, url: O + p, telephone: l.tel, image: `${O}/images/locations/${l.slug}.jpg`, address: { '@type': 'PostalAddress', streetAddress: l.street, addressLocality: l.city, postalCode: l.postcode, addressCountry: 'GB' }, openingHours: l.hours };
    const o = { path: p, title: l.title, desc: l.desc, crumbs: lc, image: `/images/locations/${l.slug}.jpg`, schema: [crumbsLd(lc), clinicLd] };
    let extra = `<h2>Find us on the map</h2>
<p>${BRAND} ${l.city}, ${l.street}, ${l.city} ${l.postcode}. Telephone <a href="tel:${l.tel.replace(/ /g, '')}">${l.phone}</a>.</p>`;
    if (l.slug === 'bristol') {
      o.viewport = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
      clinicLd.aggregateRating = { '@type': 'AggregateRating', ratingValue: '4.9', reviewCount: '312' };
      def({ area: 'accessibility', type: 'viewport-blocks-zoom', scope: 'page', url: p, description: 'Viewport meta disables pinch zoom (user-scalable=no, maximum-scale=1).', source: S.axe('meta-viewport'), evidence: '<meta name="viewport" content="…maximum-scale=1, user-scalable=no">', verify: [{ html: 'user-scalable=no' }] });
      def({ area: 'geo', type: 'self-serving-review-markup', scope: 'page', url: p, description: 'LocalBusiness (Dentist) markup carries an aggregateRating about the business itself on its own site, which Google treats as self-serving and ineligible; no reviews are shown on the page.', source: S.review, evidence: '"aggregateRating": {"ratingValue": "4.9", "reviewCount": "312"} in the Dentist JSON-LD.', verify: [{ html: '"aggregateRating"' }] });
    }
    if (l.slug === 'bath') {
      clinicLd.telephone = '+44 1632 960999';
      extra += `\n<iframe src="/maps/bath.html" width="600" height="300"></iframe>`;
      def({ area: 'content', type: 'title-too-short', scope: 'page', url: p, description: 'Title is a single four-letter word.', source: S.title, evidence: '<title>Bath</title>', verify: [{ html: '<title>Bath</title>' }] });
      def({ area: 'accessibility', type: 'frame-missing-title', scope: 'page', url: p, description: 'An <iframe> has no title attribute or accessible name.', source: S.axe('frame-title'), evidence: '<iframe src="/maps/bath.html" width="600" height="300"></iframe>', verify: [{ html: '<iframe src="/maps/bath.html" width="600" height="300"></iframe>' }] });
      def({ area: 'geo', type: 'nap-inconsistent', scope: 'page', url: p, description: 'Telephone number in LocalBusiness JSON-LD differs from the number shown on the page and in the footer.', source: S.localBusiness, evidence: 'JSON-LD "telephone": "+44 1632 960999" vs visible "01632 960 245".', verify: [{ html: '"telephone": "\\+44 1632 960999"' }, { html: '01632 960 245' }] });
    }
    if (l.slug === 'leeds') {
      o.robots = 'nosnippet';
      o.schema = [crumbsLd(lc)];
      def({ area: 'ai-access', type: 'nosnippet-key-page', scope: 'page', url: p, description: 'Clinic page uses robots nosnippet, which stops search engines (including Google AI Overviews / AI Mode) from quoting any of its text.', source: S.robotsMeta, evidence: '<meta name="robots" content="nosnippet">', verify: [{ html: '<meta name="robots" content="nosnippet">' }] });
      def({ area: 'geo', type: 'missing-localbusiness-schema', scope: 'page', url: p, description: 'Clinic location page has no LocalBusiness/Dentist structured data (the other two clinic pages do).', source: S.localBusiness, evidence: 'Only BreadcrumbList JSON-LD present.', verify: [{ htmlNot: '"@type": "Dentist"' }] });
    }
    o.main = `<h1>${esc(l.h1)}</h1>
${fig(`/images/locations/${l.slug}.jpg`, `Outside ${BRAND} ${l.city}`, 800, 500, { lazy: false, priority: true })}
${l.paras.map((x) => `<p>${esc(x)}</p>`).join('\n')}
<h2>Treatments at this clinic</h2>
<p>All clinics offer <a href="/services/general-dentistry">check-ups and general dentistry</a>, <a href="/services/hygiene">hygiene appointments</a> and <a href="/services/emergency-dentist">emergency care</a>. ${l.slug === 'bristol' ? 'Bristol is also home to our implant service.' : l.slug === 'bath' ? 'Bath also provides clear aligners and veneers.' : 'Leeds also runs our gum health clinic.'}</p>
${locationExtra(l)}
${extra}`;
    addPage(o);
  }
  put('maps/bath.html', `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Map of the Harbourline Bath clinic at Abbey Green</title><meta name="description" content="Location map for the Harbourline Dental Studio clinic at 3 Abbey Green Lane, Bath, five minutes on foot from Bath Abbey."><link rel="stylesheet" href="/assets/css/site.css"></head>
<body><main><p>Map: Harbourline Bath, 3 Abbey Green Lane, Bath BA1 1NW. Five minutes on foot from Bath Abbey.</p></main></body></html>
`);
}

// ================================================================ BLOG
const postPath = (s) => `/blog/${s}`;
const catNames = { 'oral-health': 'Oral health', cosmetic: 'Cosmetic dentistry', news: 'Practice news' };
const tagNames = { whitening: 'Whitening', kids: 'Children' };
const relatedSvc = { 'oral-health': 'general-dentistry', cosmetic: 'teeth-whitening', news: 'general-dentistry' };
const blogImgAlt = (post) => `Illustration for the article: ${post.h1}`;
{
  for (const post of posts) {
    const p = postPath(post.slug);
    const crumbs = [['/', 'Home'], ['/blog', 'Advice'], [`/blog/category/${post.cat}`, catNames[post.cat]], [p, post.h1]];
    const author = post.author ? teamBy[post.author] : null;
    const article = { '@context': 'https://schema.org', '@type': 'BlogPosting', '@id': `${O}${p}#article`, headline: post.h1, description: post.desc || undefined, image: `${O}/images/blog/post-${String(post.img).padStart(2, '0')}.jpg`, mainEntityOfPage: O + p, publisher: orgRef, inLanguage: 'en-GB' };
    if (author) article.author = { '@type': 'Person', name: author.name, url: `${O}/team/${author.slug}`, jobTitle: author.role };
    if (post.pub) article.datePublished = post.pub;
    if (post.mod) article.dateModified = post.mod;
    const o = { path: p, title: post.title, desc: post.desc, crumbs, ogType: 'article', image: `/images/blog/post-${String(post.img).padStart(2, '0')}.jpg` };
    o.schema = [crumbsLd(crumbs, { noPosition: !!post.badCrumbs }), article];
    const byline = `<p class="byline">${author ? `By <a href="/team/${author.slug}">${author.name}</a>, ${author.role}` : ''}${post.pub ? `${author ? ' · ' : ''}Published <time datetime="${post.pub}">${fmtDate(post.pub)}</time>` : ''}${post.mod && post.mod !== post.pub && post.mod > (post.pub || '') ? ` · Updated <time datetime="${post.mod}">${fmtDate(post.mod)}</time>` : ''}</p>`;
    let imgTag = fig(o.image, blogImgAlt(post), 800, 450, { lazy: false, priority: true });
    let bodyHtml = post.secs.map(([h, ps]) => sec(h, ps.map(esc))).join('\n');
    let afterBody = '';
    let h1 = `<h1>${esc(post.h1)}</h1>`;

    // --- defects on posts
    const slug = post.slug;
    if (slug === 'how-to-floss-properly') {
      bodyHtml = bodyHtml.replace('ask at your next visit to our team.', 'ask at your next visit to our team, or read about our <a href="/services/gum-treatment">gum treatment service</a>.');
      def({ area: 'technical', type: 'http-404', scope: 'page', url: '/services/gum-treatment', found_on: p, description: 'Internal link points to a page that returns 404 Not Found.', source: S.httpStatus, evidence: '<a href="/services/gum-treatment"> → 404.', alt_types: ['broken-internal-link'], verify: [{ status: 404 }, { url: p, html: 'href="/services/gum-treatment"' }] });
    }
    if (slug === 'nervous-patients') {
      o.canonical = `${O}/blog/nervous-patients-guide`;
      def({ area: 'technical', type: 'canonical-to-redirect', scope: 'page', url: p, related_url: '/blog/nervous-patients-guide', description: 'rel=canonical points to a URL that 301-redirects (back to this page).', source: S.canonical, evidence: 'canonical {{ORIGIN}}/blog/nervous-patients-guide → 301 → /blog/nervous-patients.', alt_types: ['canonical-mismatch', 'sitemap-contains-non-canonical'], verify: [{ html: 'rel="canonical" href="[^"]*/blog/nervous-patients-guide"' }, { url: '/blog/nervous-patients-guide', redirect: { status: 301, location: '/blog/nervous-patients' } }] });
    }
    if (slug === 'whitening-myths') {
      o.canonical = `${O}/blog/whitening-myths-old`;
      bodyHtml = bodyHtml.replace('<p>Peroxide gels', '<p style="color:#b8b8b8">Peroxide gels');
      def({ area: 'technical', type: 'canonical-to-4xx', scope: 'page', url: p, related_url: '/blog/whitening-myths-old', description: 'rel=canonical points to a URL that returns 404.', source: S.lhCanonical, evidence: 'canonical {{ORIGIN}}/blog/whitening-myths-old → 404.', alt_types: ['canonical-mismatch', 'sitemap-contains-non-canonical'], verify: [{ html: 'rel="canonical" href="[^"]*/blog/whitening-myths-old"' }, { url: '/blog/whitening-myths-old', status: 404 }] });
      def({ area: 'accessibility', type: 'low-contrast-text', scope: 'page', url: p, description: 'Body paragraph uses light grey text (#b8b8b8) on white, a contrast ratio of about 2:1 (WCAG AA needs 4.5:1).', source: S.wcag('contrast-minimum'), evidence: '<p style="color:#b8b8b8">Peroxide gels…', verify: [{ html: 'style="color:#b8b8b8"' }] });
    }
    if (slug === 'what-to-expect-implants') {
      bodyHtml = bodyHtml.replace('<h2>During surgery</h2>', '<h4>During surgery</h4>');
      imgTag = `<img src="${o.image}" alt="${esc(blogImgAlt(post))}" fetchpriority="high">`;
      def({ area: 'accessibility', type: 'heading-order', scope: 'page', url: p, description: 'Heading levels skip from h2 to h4.', source: S.axe('heading-order'), evidence: '<h2>Before the appointment</h2> followed by <h4>During surgery</h4>.', verify: [{ html: '<h4>During surgery</h4>' }] });
      def({ area: 'technical', type: 'image-missing-dimensions', scope: 'page', url: p, description: 'Above-the-fold image has no width/height attributes, causing layout shift as it loads.', source: S.lhUnsized, evidence: `<img src="${o.image}" … fetchpriority="high"> without width or height.`, verify: [{ html: `<img src="${o.image}" alt="[^"]*" fetchpriority="high">` }] });
    }
    if (slug === 'dental-implants-cost') {
      o.schema = [crumbsLd(crumbs), `{
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  "headline": "How much do dental implants cost?",
  "author": {"@type": "Person", "name": "Dr Rohan Mehta"},
  "datePublished": "2026-02-09",
  "dateModified": "2026-03-01",
}`];
      bodyHtml = bodyHtml.replace('Details are on our finance page', 'Details are on our finance page, and our <a href="/old-prices">2023 price list</a> shows how fees have changed');
      def({ area: 'geo', type: 'json-ld-syntax-error', scope: 'page', url: p, description: 'JSON-LD block is not valid JSON (trailing comma, missing closing brace) so no structured data can be read.', source: S.sdIntro, evidence: '"dateModified": "2026-03-01",\\n} — trailing comma and unbalanced braces.', verify: [{ jsonLdInvalid: true }] });
      def({ area: 'technical', type: 'redirect-to-4xx', scope: 'page', url: '/old-prices', found_on: p, description: 'Internal link points to a redirect whose target returns 404.', source: S.redirects, evidence: '/old-prices → 301 → /prices-2023 → 404.', alt_types: ['broken-internal-link', 'internal-link-to-redirect'], verify: [{ redirect: { status: 301, location: '/prices-2023' } }, { url: '/prices-2023', status: 404 }] });
    }
    if (slug === 'fluoride-facts') {
      def({ area: 'technical', type: 'x-robots-noindex', scope: 'page', url: p, description: 'Article is sent with an X-Robots-Tag: noindex HTTP header although it is linked internally and listed in the sitemap.', source: S.robotsMeta, evidence: 'Response header X-Robots-Tag: noindex; <loc> in sitemap-blog.xml.', alt_types: ['sitemap-contains-noindex', 'noindex-page', 'noindex-page-linked'], verify: [{ header: 'x-robots-tag', match: 'noindex' }] });
    }
    if (slug === 'Top-10-Brushing-Mistakes') {
      def({ area: 'technical', type: 'url-uppercase', scope: 'page', url: p, description: 'URL path contains uppercase letters; the lowercase form returns 404.', source: S.urlStructure, evidence: '/blog/Top-10-Brushing-Mistakes is 200; /blog/top-10-brushing-mistakes is 404.', verify: [{ status: 200 }, { url: '/blog/top-10-brushing-mistakes', status: 404 }] });
    }
    if (slug === 'gum_disease_signs') {
      def({ area: 'technical', type: 'url-underscores', scope: 'page', url: p, description: 'URL uses underscores instead of hyphens to separate words.', source: S.urlStructure, evidence: '/blog/gum_disease_signs', verify: [{ status: 200 }] });
    }
    if (slug === 'sugar-and-teeth') {
      def({ area: 'content', type: 'duplicate-title', scope: 'page', url: '/blog/healthy-snacks', urls: ['/blog/sugar-and-teeth', '/blog/healthy-snacks'], description: 'Two different articles share the same <title>.', source: S.title, evidence: 'Both use <title>Healthy Eating for Healthy Teeth | Harbourline Dental Studio</title>.', verify: [{ html: '<title>Healthy Eating for Healthy Teeth' }, { url: '/blog/sugar-and-teeth', html: '<title>Healthy Eating for Healthy Teeth' }] });
      def({ area: 'geo', type: 'missing-author', scope: 'page', url: p, description: 'Article has no author: no byline on the page and no author in the BlogPosting JSON-LD.', source: S.article, evidence: 'BlogPosting JSON-LD without "author"; no "By …" byline.', verify: [{ htmlNot: '"author"' }, { htmlNot: 'class="byline">By' }] });
    }
    if (slug === 'healthy-snacks') {
      def({ area: 'geo', type: 'missing-publish-date', scope: 'page', url: p, description: 'Article shows no publication or update date and its BlogPosting JSON-LD has no datePublished/dateModified.', source: S.article, evidence: 'No <time> element; JSON-LD lacks datePublished.', verify: [{ htmlNot: 'datePublished' }, { htmlNot: '<time' }] });
    }
    if (slug === 'electric-vs-manual-toothbrush') {
      o.titles = [post.title, 'Toothbrush Buying Guide | Harbourline'];
      afterBody += '\n<p><span role="buton" class="tag">Compare brushes</span> using the points above.</p>';
      def({ area: 'content', type: 'multiple-titles', scope: 'page', url: p, description: 'Page has two <title> elements.', source: S.title, evidence: '<title>Electric or Manual Toothbrush…</title> and <title>Toothbrush Buying Guide | Harbourline</title>.', verify: [{ count: '<title', equals: 2 }] });
      def({ area: 'accessibility', type: 'aria-invalid-role', scope: 'page', url: p, description: 'Element uses an invalid ARIA role value ("buton").', source: S.axe('aria-roles'), evidence: '<span role="buton" class="tag">', verify: [{ html: 'role="buton"' }] });
    }
    if (slug === 'mouthwash-guide') {
      o.schema = [];
      def({ area: 'content', type: 'missing-meta-description', scope: 'page', url: p, description: 'Page has no meta description.', source: S.lhMeta, evidence: 'No <meta name="description">.', verify: [{ htmlNot: 'name="description"' }] });
      def({ area: 'geo', type: 'missing-article-schema', scope: 'page', url: p, description: 'Blog article has no structured data at all (no Article/BlogPosting, no BreadcrumbList), unlike every other article.', source: S.article, evidence: 'No <script type="application/ld+json">.', verify: [{ htmlNot: 'application/ld\\+json' }] });
    }
    if (slug === 'bad-breath-causes') {
      def({ area: 'content', type: 'duplicate-meta-description', scope: 'page', url: '/blog/dry-mouth', urls: ['/blog/bad-breath-causes', '/blog/dry-mouth'], description: 'Two articles use the identical meta description.', source: S.snippet, evidence: 'Both: "Common causes of bad breath and dry mouth, and practical steps that help…"', verify: [{ html: 'content="Common causes of bad breath and dry mouth' }, { url: '/blog/bad-breath-causes', html: 'content="Common causes of bad breath and dry mouth' }] });
    }
    if (slug === 'sensitive-teeth') {
      o.descs = [post.desc, 'Sensitive teeth advice from Harbourline Dental Studio.'];
      article.datePublished = 'last winter';
      def({ area: 'content', type: 'multiple-meta-descriptions', scope: 'page', url: p, description: 'Page has two meta description tags with different content.', source: S.snippet, evidence: 'Two <meta name="description"> elements.', verify: [{ count: 'name="description"', equals: 2 }] });
      def({ area: 'geo', type: 'schema-invalid-date', scope: 'page', url: p, description: 'BlogPosting datePublished is free text, not an ISO 8601 date.', source: S.article, evidence: '"datePublished": "last winter"', verify: [{ html: '"datePublished": "last winter"' }] });
    }
    if (slug === 'kids-first-visit') {
      h1 = `<p class="h1-style">${esc(post.h1)}</p>`;
      def({ area: 'content', type: 'missing-h1', scope: 'page', url: p, description: 'Page has no <h1>; the headline is a styled paragraph.', source: S.lhTitle.replace('document-title', 'page-has-heading-one'), evidence: '<p class="h1-style">Your child’s first dental visit</p>; zero <h1>.', verify: [{ count: '<h1', equals: 0 }] });
    }
    if (slug === 'teeth-grinding') {
      afterBody += `\n${fig('/images/blog/post-06.jpg', undefined, 800, 450)}\n<h2></h2>\n<p>Our dentists can fit a night guard at any clinic.</p>`;
      def({ area: 'accessibility', type: 'img-missing-alt', scope: 'page', url: p, description: 'Content image has no alt attribute.', source: S.axe('image-alt'), evidence: '<img src="/images/blog/post-06.jpg" width="800" height="450" loading="lazy"> with no alt.', verify: [{ html: '<img src="/images/blog/post-06.jpg" width' }] });
      def({ area: 'content', type: 'empty-heading', scope: 'page', url: p, description: 'Page contains an empty <h2></h2>.', source: S.axe('empty-heading'), evidence: '<h2></h2>', verify: [{ html: '<h2></h2>' }] });
    }
    if (slug === 'new-parking-at-bristol') {
      def({ area: 'content', type: 'thin-content', scope: 'page', url: p, description: 'Article body is a single 30-word paragraph.', source: S.helpful, evidence: 'Main content ≈ 30 words.', verify: [{ mainWordsMax: 80 }] });
    }
    if (slug === 'scale-and-polish-explained') {
      const hy = svcBy.hygiene;
      bodyHtml = `<p class="lead">${esc(hy.lead)}</p>\n` + hy.sections.map(([h, ps]) => sec(h, ps.map(esc))).join('\n');
      def({ area: 'content', type: 'duplicate-content', scope: 'page', url: p, urls: ['/blog/scale-and-polish-explained', '/services/hygiene'], description: 'Article body is copied word for word from the hygiene service page; neither page canonicalises to the other.', source: S.canonical, evidence: 'Identical paragraphs ("A hygiene appointment removes the hard tartar…") on both URLs, each with a self canonical.', verify: [{ html: 'A hygiene appointment removes the hard tartar' }, { url: '/services/hygiene', html: 'A hygiene appointment removes the hard tartar' }] });
    }
    if (slug === 'invisalign-vs-braces') {
      o.og = false;
      afterBody += `\n<p>Find out more about <a href="/services/invisalign" rel="nofollow">clear aligner treatment at our Bath clinic</a>.</p>`;
      def({ area: 'content', type: 'missing-open-graph', scope: 'page', url: p, description: 'Page has no Open Graph or Twitter Card tags (every other article has them).', source: 'https://ogp.me/', evidence: 'No og:title, og:description, og:image or twitter:card.', verify: [{ htmlNot: 'property="og:' }] });
      def({ area: 'content', type: 'nofollow-internal-link', scope: 'page', url: p, related_url: '/services/invisalign', description: 'Internal link to a treatment page carries rel="nofollow".', source: S.qualifyLinks, evidence: '<a href="/services/invisalign" rel="nofollow">', verify: [{ html: 'href="/services/invisalign" rel="nofollow"' }] });
    }
    if (slug === 'whitening-at-home') {
      o.lang = null;
      afterBody += `\n<p>Thinking about a first course of whitening? <a href="/services/teeth-whitening">Click here</a>. For fees, <a href="/pricing">read more</a>.</p>`;
      def({ area: 'accessibility', type: 'html-missing-lang', scope: 'page', url: p, description: 'The <html> element has no lang attribute.', source: S.axe('html-has-lang'), evidence: '<html> without lang.', verify: [{ html: '<html>' }] });
      def({ area: 'content', type: 'non-descriptive-link-text', scope: 'page', url: p, description: 'Links use generic anchor text ("Click here", "read more").', source: S.lhLinkText, evidence: '<a href="/services/teeth-whitening">Click here</a>, <a href="/pricing">read more</a>', verify: [{ html: '>Click here</a>' }] });
    }
    if (slug === 'retainer-care') {
      def({ area: 'technical', type: 'orphan-page', scope: 'page', url: p, description: 'Article is listed in the XML sitemap but no page on the site links to it.', source: S.links, evidence: 'Present in sitemap-blog.xml; zero internal inlinks.', verify: [{ status: 200 }, { url: '/sitemaps/sitemap-blog.xml', html: '/blog/retainer-care<' }] });
    }
    if (slug === 'history-of-dentistry') {
      bodyHtml = post.wallText.map((x) => `<p>${esc(x)}</p>`).join('\n');
      def({ area: 'geo', type: 'no-subheadings', scope: 'page', url: p, description: 'Long article (about 560 words in eight paragraphs) has no subheadings at all, so it cannot be scanned or split into passages.', source: S.helpful, evidence: 'Zero h2–h6 in main content.', verify: [{ mainHeadingsMax: 0 }, { mainWordsMin: 500 }] });
    }
    if (slug === 'open-evening-november') {
      o.schema.push({ '@context': 'https://schema.org', '@type': 'Event', name: 'Implant open evening', startDate: '2026-11-20T18:00:00+00:00', endDate: '2026-11-20T16:00:00+00:00', eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode', location: { '@type': 'Place', name: 'Harbourline Bristol', address: { '@type': 'PostalAddress', streetAddress: '14 Quay Street', addressLocality: 'Bristol', postalCode: 'BS1 4DB', addressCountry: 'GB' } }, organizer: orgRef });
      def({ area: 'geo', type: 'schema-invalid-value', scope: 'page', url: p, description: 'Event structured data ends before it starts (endDate 16:00 is earlier than startDate 18:00), contradicting the visible 6pm–8pm.', source: S.event, evidence: '"startDate": "2026-11-20T18:00:00+00:00", "endDate": "2026-11-20T16:00:00+00:00"', verify: [{ html: '"endDate": "2026-11-20T16:00' }] });
    }
    if (slug === 'root-canal-myths') {
      def({ area: 'geo', type: 'date-modified-before-published', scope: 'page', url: p, description: 'BlogPosting dateModified (2025-02-01) is earlier than datePublished (2026-08-04).', source: S.article, evidence: '"datePublished": "2026-08-04", "dateModified": "2025-02-01"', verify: [{ html: '"dateModified": "2025-02-01"' }] });
    }
    if (slug === 'clinic-refurbishment') {
      o.scripts = ['/assets/js/notice-banner.js'];
      def({ area: 'agentic', type: 'layout-shift', scope: 'page', url: p, description: 'A script inserts a 160px notice banner above the article about 600 ms after load, pushing all content down (CLS well above 0.1).', source: S.cls, evidence: '<script src="/assets/js/notice-banner.js"> inserts a banner at the top of <main> after a timeout.', verify: [{ html: 'notice-banner.js' }, { url: '/assets/js/notice-banner.js', html: 'setTimeout' }] });
    }
    if (slug === 'smile-makeover') {
      afterBody += `\n<div class="tabs" data-tabs>
<div class="tab-list"><span class="tab is-active" data-tab="before">Before treatment</span> <span class="tab" data-tab="after">After treatment</span></div>
<div class="tab-panel" data-panel="before"><p>Before: crowded lower teeth, worn edges on the upper front teeth and yellow staining.</p></div>
<div class="tab-panel" data-panel="after" hidden><p>After: aligners for eight months, home whitening for two weeks and composite bonding on four upper teeth.</p></div>
</div>`;
      def({ area: 'agentic', type: 'custom-widget-missing-roles', scope: 'page', url: p, description: 'A tab widget is built from clickable <span>s with no tab/tablist/tabpanel roles, no focusability and no aria-selected, so agents and assistive tech cannot see or operate it.', source: S.ariaTabs, evidence: '<span class="tab is-active" data-tab="before">Before treatment</span> …', verify: [{ html: '<span class="tab is-active" data-tab="before">' }] });
    }
    if (slug === 'how-to-brush-your-teeth') {
      def({ area: 'geo', type: 'schema-missing-required-property', scope: 'page', url: p, description: 'BreadcrumbList ListItems have no "position", a required property.', source: S.breadcrumb, evidence: 'ListItem objects with name and item but no position.', verify: [{ htmlNot: '"position"' }, { html: '"BreadcrumbList"' }] });
    }
    if (post.control) controls.push(p);

    // Key points box, author box, next steps (page-specific text)
    const keyPoints = post.secs.filter(([h]) => h).map(([h, ps]) => `<li><strong>${esc(h)}:</strong> ${esc(ps[0].split(/(?<=\.) /)[0])}</li>`).join('\n');
    const svc = post.related || relatedSvc[post.cat];
    const authorBox = author ? `<aside class="author-box" aria-label="About the author"><p><strong>About the author.</strong> <a href="/team/${author.slug}">${author.name}</a> is ${/^[AEIOU]/.test(author.role) ? 'an' : 'a'} ${author.role.toLowerCase()} at ${BRAND}. ${esc(author.paras[0].split(/(?<=\.) /)[0])}</p></aside>` : '';
    o.main = `<article>
${h1}
${byline}
${imgTag}
${post.wall || post.thin || slug === 'scale-and-polish-explained' ? '' : `<div class="key-points"><p><strong>Key points from this article</strong></p><ul>\n${keyPoints}\n</ul></div>`}
${bodyHtml}
${afterBody}
${post.thin ? '' : `<p class="next-step">If you have questions about anything in this article, our team can help at your next appointment. Read about <a href="/services/${svc}">${svcBy[svc].name.toLowerCase()} at Harbourline</a> or <a href="/book">book a visit online</a>.</p>`}
${post.thin ? '' : authorBox}
</article>`;
    addPage(o);
  }

  // listing pages
  const listed = posts.filter((x) => !x.orphan);
  const sorted = [...listed].sort((a, b) => (b.pub || '0') .localeCompare(a.pub || '0'));
  const perPage = 12;
  const pagesN = Math.ceil(sorted.length / perPage);
  const card = (x) => `<li><a href="${postPath(x.slug)}">${esc(x.h1)}</a>${x.pub ? ` <span class="small">(${fmtDate(x.pub)})</span>` : ''}<br><span class="small">${esc(x.desc || '')}</span></li>`;
  for (let n = 1; n <= pagesN; n++) {
    const p = n === 1 ? '/blog' : `/blog/page/${n}`;
    const items = sorted.slice((n - 1) * perPage, n * perPage);
    const crumbs = n === 1 ? [['/', 'Home'], ['/blog', 'Advice']] : [['/', 'Home'], ['/blog', 'Advice'], [p, `Page ${n}`]];
    const o = {
      path: p, crumbs,
      title: n === 1 ? 'Dental Advice and Practice News | Harbourline Dental Studio' : `Dental Advice and News, Page ${n} | Harbourline Dental`,
      desc: n === 1 ? 'Practical advice on looking after your teeth and gums from the Harbourline team, plus news from our Bristol, Bath and Leeds clinics.' : `Older dental advice articles and practice news from Harbourline Dental Studio, page ${n} of ${pagesN}.`,
      schema: [crumbsLd(crumbs)],
      head: [n > 1 ? `<link rel="prev" href="${O}${n === 2 ? '/blog' : `/blog/page/${n - 1}`}">` : '', n < pagesN ? `<link rel="next" href="${O}/blog/page/${n + 1}">` : ''].filter(Boolean).join('\n'),
    };
    let extra = '';
    if (n === 2) {
      o.canonical = `${O}/blog`;
      extra = '<p class="small">Looking for current offers? See <a href="/offers">this month’s patient offers</a>.</p>';
      def({ area: 'technical', type: 'pagination-canonical-to-first-page', scope: 'page', url: p, found_on: '/blog', description: 'Paginated page 2 sets rel=canonical to page 1, telling search engines to ignore the articles listed only here.', source: S.pagination, evidence: '/blog/page/2 has <link rel="canonical" href="{{ORIGIN}}/blog">.', alt_types: ['canonical-mismatch', 'internal-link-to-non-canonical'], verify: [{ html: 'rel="canonical" href="[^"]*/blog"' }] });
      def({ area: 'technical', type: 'http-5xx', scope: 'page', url: '/offers', found_on: p, description: 'Internal link points to a URL that returns 500 Internal Server Error.', source: S.httpStatus, evidence: '/offers → 500.', alt_types: ['broken-internal-link'], verify: [{ status: 500 }, { url: p, html: 'href="/offers"' }] });
    }
    if (n === 3) {
      o.canonical = false;
      o.charset = false;
      def({ area: 'technical', type: 'missing-canonical', scope: 'page', url: p, description: 'Page has no rel=canonical (all other pages declare one).', source: S.canonical, evidence: 'No <link rel="canonical">.', verify: [{ htmlNot: 'rel="canonical"' }] });
      def({ area: 'technical', type: 'missing-charset', scope: 'page', url: p, description: 'Character encoding is declared neither in the Content-Type header nor in a <meta charset> (page contains non-ASCII characters).', source: S.lhCharset, evidence: 'Content-Type: text/html (no charset); no <meta charset>.', verify: [{ header: 'content-type', match: '^text/html$' }, { htmlNot: '<meta charset' }] });
    }
    o.main = `<h1>${n === 1 ? 'Dental advice from our team' : `Dental advice, page ${n}`}</h1>
${n === 1 ? '<p class="lead">Our dentists and hygienists write about the questions patients ask most often. Every article is checked by a second clinician before it is published, and we update older articles when guidance changes.</p>' : `<p class="lead">Older articles from our dental advice library, page ${n} of ${pagesN}.</p>`}
<ul class="post-list">
${items.map(card).join('\n')}
</ul>
<nav aria-label="Pagination" class="pager"><ul>
${Array.from({ length: pagesN }, (_, i) => i + 1).map((k) => `<li>${k === n ? `<span aria-current="page">Page ${k}</span>` : `<a href="${k === 1 ? '/blog' : `/blog/page/${k}`}">Page ${k}</a>`}</li>`).join('\n')}
</ul></nav>
<h2>Browse by topic</h2>
<ul>
${Object.entries(catNames).map(([k, v]) => `<li><a href="/blog/category/${k}">${v}</a></li>`).join('\n')}
${Object.entries(tagNames).map(([k, v]) => `<li><a href="/blog/tag/${k}">Articles tagged ${v.toLowerCase()}</a></li>`).join('\n')}
</ul>
${extra}`;
    addPage(o);
    if (n === 1) controls.push(p);
  }

  // categories and tags
  const archive = (kind, key, label) => {
    const p = `/blog/${kind}/${key}`;
    const items = listed.filter((x) => (kind === 'category' ? x.cat === key : (x.tags || []).includes(key)));
    const crumbs = [['/', 'Home'], ['/blog', 'Advice'], [p, label]];
    const intro = {
      'oral-health': 'Everyday advice on brushing, cleaning between the teeth, diet and the common problems we see at check-ups. These articles are written by our dentists, hygienists and therapists and reviewed every year.',
      cosmetic: 'Articles about whitening, aligners, veneers and planning cosmetic treatment. We explain what each option can and cannot do, what it costs and how long results last.',
      news: 'News from our three clinics: new services, changes to opening hours, events and improvements to our buildings. We also publish occasional longer pieces about the practice and about dentistry in general. For changes that affect a booked appointment we always contact you directly by text or email, so you do not need to check this page before a visit.',
      whitening: 'Everything we have written about teeth whitening. Professional whitening is one of the most requested cosmetic treatments at our Bath and Bristol clinics, and also one of the most misunderstood. These articles look at what the evidence says about safety and sensitivity, why salon and online kits are risky, and how to keep a whitening result for years with occasional top-ups rather than repeat courses. If you are considering whitening for the first time, start with the article on common myths, then read about aftercare.',
      kids: 'Advice for parents and carers on looking after children’s teeth, from the first tooth to the teenage years. Tooth decay is the most common reason for young children to be admitted to hospital in England, and almost all of it is preventable. Our dental therapists and dentists write about first visits, brushing routines, snacks and drinks, and the preventive treatments such as fluoride varnish and fissure sealants that we offer at every clinic. Children are seen free when a parent is a registered patient.',
    }[key];
    const o = { path: p, crumbs, schema: [crumbsLd(crumbs)],
      title: kind === 'category' ? `${label} Articles | Harbourline Dental Studio` : `Articles Tagged ${label} | Harbourline Dental`,
      desc: { 'oral-health': 'Harbourline articles on brushing, cleaning between teeth, diet and the common problems our dentists and hygienists see at check-ups.', cosmetic: 'Harbourline articles on teeth whitening, clear aligners, veneers and planning cosmetic dental treatment, with realistic costs and results.', news: 'News from Harbourline Dental Studio clinics in Bristol, Bath and Leeds: new services, opening hours, events and building improvements.', whitening: 'Every Harbourline article about teeth whitening: safety and sensitivity, the risks of salon kits, and how to keep your results for longer.', kids: 'Harbourline advice for parents on children’s teeth: first visits, brushing routines, tooth-friendly snacks and preventive treatments.' }[key] };
    let h1 = kind === 'category' ? `${label} articles` : `Articles tagged ${label.toLowerCase()}`;
    let extra = '';
    if (key === 'oral-health') {
      extra = '<p><a href="javascript:void(0)" data-href="/blog/page/2">See older oral health articles</a></p>';
      def({ area: 'content', type: 'uncrawlable-link', scope: 'page', url: p, description: 'Navigation link uses href="javascript:void(0)" and relies on a script to navigate; crawlers cannot follow it.', source: S.lhCrawlableAnchors, evidence: '<a href="javascript:void(0)" data-href="/blog/page/2">', verify: [{ html: 'href="javascript:void\\(0\\)"' }] });
      def({ area: 'technical', type: 'no-text-compression', scope: 'page', url: p, description: 'HTML is served uncompressed even when the client sends Accept-Encoding: gzip (all other pages are gzip-compressed).', source: S.lhCompression, evidence: 'No Content-Encoding header in response to Accept-Encoding: gzip, br.', verify: [{ noContentEncoding: true }] });
    }
    if (key === 'cosmetic') {
      h1 = 'Cosmetic dentistry';
      o.scripts = ['/assets/js/gallery.js'];
      def({ area: 'technical', type: 'console-error', scope: 'page', url: p, description: 'A page script throws an uncaught ReferenceError on load.', source: S.lhConsole, evidence: '/assets/js/gallery.js calls initLightbox(), which is not defined.', verify: [{ html: '/assets/js/gallery.js' }, { url: '/assets/js/gallery.js', html: 'initLightbox\\(' }] });
    }
    if (key === 'whitening') {
      h1 = 'Cosmetic dentistry';
      extra = '<p>Current promotions: <a href="/special-offer">whitening special offer</a> and <a href="/whitening-offer">summer whitening offer</a>.</p>';
      def({ area: 'content', type: 'duplicate-h1', scope: 'page', url: p, urls: ['/blog/category/cosmetic', '/blog/tag/whitening'], description: 'Two different archive pages use the same H1 "Cosmetic dentistry".', source: S.title, evidence: '<h1>Cosmetic dentistry</h1> on both pages.', verify: [{ html: '<h1>Cosmetic dentistry</h1>' }, { url: '/blog/category/cosmetic', html: '<h1>Cosmetic dentistry</h1>' }] });
      def({ area: 'technical', type: 'redirect-loop', scope: 'page', url: '/special-offer', found_on: p, description: 'Internal link leads into a redirect loop.', source: S.redirects, evidence: '/special-offer → 301 /special-offer-2024 → 301 /special-offer.', alt_types: ['internal-link-to-redirect'], verify: [{ redirect: { status: 301, location: '/special-offer-2024' } }, { url: '/special-offer-2024', redirect: { status: 301, location: '/special-offer' } }] });
      def({ area: 'technical', type: 'meta-refresh-redirect', scope: 'page', url: '/whitening-offer', found_on: p, description: 'Page redirects with an HTML meta refresh instead of an HTTP redirect.', source: S.redirects, evidence: '<meta http-equiv="refresh" content="0; url=/services/teeth-whitening">', alt_types: ['thin-content'], verify: [{ status: 200 }, { html: 'http-equiv="refresh"' }] });
    }
    if (key === 'news') {
      o.mainTag = 'div';
      extra = '<p>From the archive: <a href="/blog/open-day-2019">our 2019 open day</a>.</p>';
      def({ area: 'accessibility', type: 'missing-main-landmark', scope: 'page', url: p, description: 'Page has no <main> element or role="main" landmark.', source: S.axe('landmark-one-main'), evidence: 'Main content wrapped in <div id="main">; no <main>.', verify: [{ htmlNot: '<main' }] });
      def({ area: 'technical', type: 'http-410', scope: 'page', url: '/blog/open-day-2019', found_on: p, description: 'Internal link points to a page that returns 410 Gone.', source: S.httpStatus, evidence: '/blog/open-day-2019 → 410.', alt_types: ['broken-internal-link', 'http-4xx'], verify: [{ status: 410 }, { url: p, html: 'href="/blog/open-day-2019"' }] });
    }
    if (key === 'kids') {
      o.doctype = false;
      def({ area: 'technical', type: 'missing-doctype', scope: 'page', url: p, description: 'Page has no <!doctype html> and renders in quirks mode.', source: S.lhDoctype, evidence: 'Document starts with <html lang="en-GB">.', verify: [{ htmlNot: '<!doctype' }] });
    }
    o.main = `<h1>${esc(h1)}</h1>
<p class="lead">${esc(intro)}</p>
<ul class="post-list">
${items.map(card).join('\n')}
</ul>
${archiveExtra[key]}
${extra}`;
    addPage(o);
  };
  for (const [k, v] of Object.entries(catNames)) archive('category', k, v);
  for (const [k, v] of Object.entries(tagNames)) archive('tag', k, v);

  // meta refresh page
  put('whitening-offer.html', page({ path: '/whitening-offer', title: 'Summer Whitening Offer | Harbourline Dental Studio', desc: 'Our summer whitening offer has moved to the teeth whitening page.', head: '<meta http-equiv="refresh" content="0; url=/services/teeth-whitening">', main: '<h1>Summer whitening offer</h1>\n<p>This offer has moved to our <a href="/services/teeth-whitening">teeth whitening page</a>.</p>' }));
}

// ================================================================ OTHER PAGES
{
  const simple = (path, title, desc, h1, html, extra = {}) => {
    const crumbs = extra.crumbs || [['/', 'Home'], [path, h1]];
    addPage({ path, title, desc, crumbs, schema: [crumbsLd(crumbs), webPage(path, title.replace(/ \| .*$/, ''), desc), ...(extra.schema || [])], main: `<h1>${esc(h1)}</h1>\n${html}`, ...extra.o });
  };

  // ABOUT
  simple('/about', 'About Harbourline Dental Studio: Our Story', 'How Harbourline Dental Studio started in 2012, how we work, and what patients can expect from our dentists and staff.', 'About Harbourline',
    `<p class="lead">Dr Amelia Hart opened Harbourline on Quay Street in Bristol in 2012 with two surgeries, one hygienist and a receptionist who still works with us today.</p>
${fig('/images/clinic-panorama.jpg', 'Panoramic view of the Bristol clinic waiting area', 1200, 500, { lazy: false })}
<h2>How we work</h2>
<p>We are an independent, privately owned practice. That means decisions about appointment lengths, equipment and training are made by the clinicians who see patients, not by a corporate group. We keep appointments long enough to do the job properly and to answer questions.</p>
<p>We added the Bath clinic in 2016 and Leeds in 2021. Each clinic has its own lead dentist, and patients can move between sites without repeating tests because records are shared securely.</p>
<h2>Our principal dentist</h2>
<p><a href="/team/dr-hart">Meet Dr Amelia Hart</a>, who founded the practice and still sees patients three days a week. You can also meet <a href="/team">the rest of our team</a>.</p>
<h2>Our commitments</h2>
<p>Every treatment plan is written down with fees before treatment starts. We publish our prices online, we answer complaints within two working days, and we take part in the Dental Complaints Service scheme for private patients.</p>
<p>We are inspected by the Care Quality Commission like every dental practice in England, and the inspection reports for each clinic are available from the CQC website.</p>`,
    { o: { head: `<link rel="alternate" type="text/markdown" href="${O}/about.md">` } });
  def({ area: 'technical', type: 'image-oversized-file', scope: 'page', url: '/about', related_url: '/images/clinic-panorama.jpg', description: 'A single JPEG of about 600 KB is served for an image displayed at 1200×500.', source: S.lhOptImages, evidence: '/images/clinic-panorama.jpg is ~590 KB (2400×1000).', verify: [{ url: '/images/clinic-panorama.jpg', sizeMin: 500000 }, { html: 'clinic-panorama.jpg' }] });
  def({ area: 'ai-access', type: 'markdown-alternate-broken', scope: 'page', url: '/about', related_url: '/about.md', description: 'Page advertises a Markdown version for AI agents via <link rel="alternate" type="text/markdown"> but that URL returns 404.', source: S.llms, evidence: '<link rel="alternate" type="text/markdown" href="{{ORIGIN}}/about.md"> → 404.', verify: [{ html: 'type="text/markdown" href="[^"]*/about.md"' }, { url: '/about.md', status: 404 }] });

  // CONTACT
  simple('/contact', 'Contact Harbourline Dental Studio | Phone and Email', 'Telephone numbers, email and addresses for Harbourline clinics in Bristol, Bath and Leeds, plus an enquiry form for non-urgent questions.', 'Contact us',
    `<p class="lead">For appointments, call the clinic you want to visit. For anything else, email hello@harbourline.example or use the form below and we will reply within one working day.</p>
<h2>Telephone</h2>
<ul>
${locations.map((l) => `<li>${l.city}: <a href="tel:${l.tel.replace(/ /g, '')}">${l.phone}</a></li>`).join('\n')}
</ul>
<p>Phone lines open at 8am on weekdays. If you are in severe pain, call as early as you can so we can offer an emergency slot the same day. Out of hours, call NHS 111 for urgent dental advice.</p>
<h2>Send us a message</h2>
<form action="/contact" method="post" class="form" toolname="send_enquiry">
<p><label for="c-name">Your name</label><br><input id="c-name" name="name" type="text" autocomplete="name" required></p>
<p>Email address<br><input name="email" type="email" required></p>
<p><label for="c-phone">Phone number (optional)</label><br><input id="c-phone" name="phone" type="tel" autocomplete="tel" tabindex="3"></p>
<p><label for="c-msg">Your message</label><br><textarea id="c-msg" name="message" rows="6" required></textarea></p>
<p><button type="submit">Send message</button></p>
</form>
<h2>What not to send by email</h2>
<p>Please do not send photographs of your mouth or detailed medical information through the form. If we need them, we will send you a secure link. Messages are read by our reception team during opening hours.</p>`);
  def({ area: 'accessibility', type: 'form-input-missing-label', scope: 'page', url: '/contact', description: 'The email input has no associated <label>, aria-label or title; the visible text is not linked to it.', source: S.axe('label'), evidence: '<p>Email address<br><input name="email" type="email" required></p>', verify: [{ html: '<input name="email" type="email" required>' }] });
  def({ area: 'accessibility', type: 'tabindex-positive', scope: 'page', url: '/contact', description: 'An input has tabindex="3", which overrides the natural focus order.', source: S.axe('tabindex'), evidence: '<input id="c-phone" … tabindex="3">', verify: [{ html: 'tabindex="3"' }] });
  def({ area: 'agentic', type: 'webmcp-tool-missing-description', scope: 'page', url: '/contact', description: 'Form is declared as a WebMCP tool (toolname="send_enquiry") but has no tooldescription, so agents are not told what the tool does.', source: S.webmcp, evidence: '<form … toolname="send_enquiry"> without tooldescription.', verify: [{ html: 'toolname="send_enquiry">' }, { htmlNot: 'tooldescription' }] });

  // FAQ (max-snippet:0; also serves markdown on Accept: text/markdown)
  const faqs = [
    ['Are you accepting new patients?', 'Yes. All three clinics are accepting new private patients. New patient appointments last forty minutes and cost £75, including any X-rays needed.'],
    ['Do you offer NHS treatment?', 'No. Harbourline is a private practice. We do not hold an NHS contract, but we keep our fees published and offer interest-free finance on larger treatments.'],
    ['How much is a check-up?', 'A routine check-up with a dentist costs £55. A hygiene appointment costs £70 for thirty minutes or £95 for forty-five minutes.'],
    ['Can I be seen today if I am in pain?', 'Usually, yes. We hold emergency appointments every weekday morning. Call the clinic from 8am. An emergency appointment costs £85 plus any treatment.'],
    ['Do you see children?', 'Yes, from their first tooth. Check-ups for children under eighteen are free when a parent or guardian is a registered patient.'],
    ['Is there parking?', 'Bristol patients can park free for two hours at Trenchard Street car park. Bath has no parking; Southgate car park is closest. Leeds is a short walk from the railway station.'],
    ['How do I pay?', 'We accept debit and credit cards and Apple Pay. Payment is due at each appointment. Treatment over £1,000 can be spread over twelve months interest-free, subject to status.'],
    ['What is your cancellation policy?', 'Please give us at least two working days’ notice. Appointments missed or cancelled with less notice may be charged at half the appointment fee.'],
  ];
  simple('/faq', 'Frequently Asked Questions | Harbourline Dental Studio', 'Answers to common questions about new patient appointments, fees, emergency care, children’s check-ups, parking and paying for treatment.', 'Frequently asked questions',
    `<p class="lead">Quick answers to the questions our receptionists hear most often. If your question is not here, please <a href="/contact">contact us</a>.</p>
${faqs.map(([q, a]) => `<h2>${esc(q)}</h2>\n<p>${esc(a)}</p>`).join('\n')}`,
    { o: { robots: 'max-snippet:0' }, schema: [{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }] });
  put('faq.md', `# Frequently asked questions\n\nHarbourline Dental Studio, Bristol, Bath and Leeds.\n\n${faqs.map(([q, a]) => `## ${q}\n\n${a}\n`).join('\n')}`);
  def({ area: 'ai-access', type: 'nosnippet-key-page', scope: 'page', url: '/faq', description: 'FAQ page sets max-snippet:0, which forbids search engines (including Google AI features) from showing any text from it, the page most useful for answers.', source: S.robotsMeta, evidence: '<meta name="robots" content="max-snippet:0">', verify: [{ html: 'content="max-snippet:0"' }] });

  // PRICING (no security headers; prices only via JS; aria-hidden focusable)
  simple('/pricing', 'Dental Treatment Prices and Fees | Harbourline Dental Studio', 'Current fees for check-ups, hygiene, fillings, crowns, implants, whitening and aligners at Harbourline Dental Studio clinics.', 'Our prices',
    `<p class="lead">We publish all our fees. Your dentist will give you a written plan with the exact cost before any treatment begins.</p>
<div id="price-table" data-src="/api/prices.json"><p>Loading prices…</p></div>
<div aria-hidden="true" class="promo"><p>Need to spread the cost? <a href="/finance">See interest-free finance</a></p></div>
<h2>What is included</h2>
<p>Examination fees include any routine X-rays and a written treatment plan. Treatment fees include local anaesthetic and a review appointment where needed. Laboratory fees for crowns, veneers and dentures are included in the prices shown.</p>
<h2>Paying for treatment</h2>
<p>Payment is due at each appointment. For courses of treatment over £1,000 you can pay a deposit and spread the rest over twelve months interest-free, subject to status. Read more on our finance page.</p>
<h2>Dental insurance</h2>
<p>We provide itemised receipts for insurance claims. We do not claim directly from insurers, so you pay us and then claim back from your provider.</p>`,
    { o: { scripts: ['/assets/js/pricing.js'] } });
  def({ area: 'technical', type: 'missing-security-headers', scope: 'page', url: '/pricing', description: 'Response omits Content-Security-Policy, X-Content-Type-Options, X-Frame-Options/frame-ancestors, Referrer-Policy and Strict-Transport-Security, which every other page sends.', source: S.owaspHeaders, evidence: 'No CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy or HSTS headers on /pricing.', verify: [{ headerAbsent: 'content-security-policy' }, { headerAbsent: 'x-content-type-options' }, { headerAbsent: 'x-frame-options' }] });
  def({ area: 'ai-access', type: 'client-side-rendered-content', scope: 'page', url: '/pricing', description: 'The price list, the main content of the page, is only loaded by JavaScript from /api/prices.json; the HTML response contains "Loading prices…" and no prices.', source: S.jsSeo, evidence: '<div id="price-table" data-src="/api/prices.json"><p>Loading prices…</p></div>', verify: [{ html: 'Loading prices' }, { htmlNot: '£55' }] });
  def({ area: 'accessibility', type: 'aria-hidden-focusable', scope: 'page', url: '/pricing', description: 'A focusable link sits inside an aria-hidden="true" container, so it is reachable by keyboard but hidden from assistive technology and agents.', source: S.axe('aria-hidden-focus'), evidence: '<div aria-hidden="true" class="promo">…<a href="/finance">', verify: [{ html: '<div aria-hidden="true" class="promo"><p>Need to spread the cost\\? <a href' }] });

  // BOOK (button without name; WebMCP invalid schema)
  simple('/book', 'Book a Dental Appointment Online | Harbourline', 'Request a check-up, hygiene visit or consultation at our Bristol, Bath or Leeds clinic. We confirm every request by phone or email.', 'Book an appointment',
    `<p class="lead">Choose a clinic, a reason for your visit and a preferred date. We will confirm a time within one working day. If you are in pain, please phone instead.</p>
<form action="/book" method="post" class="form">
<p><label for="b-name">Full name</label><br><input id="b-name" name="name" type="text" autocomplete="name" required></p>
<p><label for="b-email">Email</label><br><input id="b-email" name="email" type="email" autocomplete="email" required></p>
<p><label for="b-tel">Phone</label><br><input id="b-tel" name="tel" type="tel" autocomplete="tel" required></p>
<p><label for="b-clinic">Clinic</label><br><select id="b-clinic" name="clinic">${locations.map((l) => `<option>${l.city}</option>`).join('')}</select></p>
<p><label for="b-reason">Reason for visit</label><br><select id="b-reason" name="reason"><option>Check-up</option><option>Hygiene</option><option>Consultation</option><option>Open evening</option></select></p>
<p><label for="b-date">Preferred date</label><br><input id="b-date" name="date" type="date"> <button type="button" class="icon-btn" data-cal><svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18"><rect x="2" y="3" width="14" height="13" fill="none" stroke="currentColor"/></svg></button></p>
<p><button type="submit">Request appointment</button></p>
</form>
<h2>What happens next</h2>
<p>A receptionist checks the diary and contacts you with the nearest available time. New patients receive a medical history form by email to complete before the visit. If you need to change the time, reply to the confirmation email or call the clinic.</p>`,
    { o: { scripts: ['/assets/js/book-tools.js'] } });
  def({ area: 'accessibility', type: 'button-missing-name', scope: 'page', url: '/book', description: 'Icon-only button has no accessible name (no text, aria-label or title).', source: S.axe('button-name'), evidence: '<button type="button" class="icon-btn" data-cal><svg aria-hidden="true" …></svg></button>', verify: [{ html: 'class="icon-btn" data-cal><svg aria-hidden="true"' }] });
  def({ area: 'agentic', type: 'webmcp-schema-invalid', scope: 'page', url: '/book', description: 'The page registers a WebMCP tool whose inputSchema is not valid JSON Schema ("type": "objekt", property type "date", "required" as a string).', source: S.lhAgentic, evidence: '/assets/js/book-tools.js: navigator.modelContext.registerTool({ … inputSchema: { type: "objekt", … required: "date" } })', verify: [{ html: '/assets/js/book-tools.js' }, { url: '/assets/js/book-tools.js', html: "type: 'objekt'" }] });

  // NEW PATIENTS (hreflang invalid code, autocomplete invalid)
  addPage({
    path: '/new-patients', title: 'Information for New Patients | Harbourline Dental Studio', desc: 'Joining Harbourline: what your first appointment involves, what it costs, what to bring and how to register online before you arrive.',
    crumbs: [['/', 'Home'], ['/new-patients', 'New patients']],
    hreflang: [['en-uk', '/new-patients'], ['en-us', '/us/new-patients'], ['x-default', '/new-patients']],
    schema: [crumbsLd([['/', 'Home'], ['/new-patients', 'New patients']])],
    main: `<h1>Joining Harbourline as a new patient</h1>
<p class="lead">We are accepting new patients at all three clinics. Your first appointment is with a dentist and lasts forty minutes.</p>
<h2>Your first appointment</h2>
<p>We start with your medical history and any concerns, then examine your teeth, gums and mouth and take X-rays if needed. Your dentist explains what they find and gives you a written plan with any treatment and fees. The appointment costs £75.</p>
<h2>What to bring</h2>
<p>Bring a list of any medicines you take and details of any recent hospital treatment. If you have had treatment elsewhere recently, the name of your previous practice helps us request records.</p>
<h2>Register online</h2>
<form action="/book" method="post" class="form">
<p><label for="np-name">Full name</label><br><input id="np-name" name="name" type="text" autocomplete="name"></p>
<p><label for="np-email">Email</label><br><input id="np-email" name="email" type="email" autocomplete="e-mail"></p>
<p><label for="np-tel">Mobile phone</label><br><input id="np-tel" name="tel" type="tel" autocomplete="phone"></p>
<p><button type="submit">Register</button></p>
</form>
<p>Visiting from the United States? Read our <a href="/us/new-patients">information for US visitors</a>.</p>`,
  });
  def({ area: 'technical', type: 'hreflang-invalid-code', scope: 'page', url: '/new-patients', description: 'hreflang uses "en-uk", which is not a valid language-region code (the UK region code is GB).', source: S.hreflang, evidence: '<link rel="alternate" hreflang="en-uk" href="{{ORIGIN}}/new-patients">', verify: [{ html: 'hreflang="en-uk"' }] });
  def({ area: 'agentic', type: 'autocomplete-invalid', scope: 'page', url: '/new-patients', description: 'Form fields use invalid autocomplete tokens ("e-mail", "phone"), so browsers and agents cannot identify the fields\' purpose (WCAG 1.3.5).', source: S.axe('autocomplete-valid'), evidence: 'autocomplete="e-mail" and autocomplete="phone" (valid tokens are "email" and "tel").', verify: [{ html: 'autocomplete="e-mail"' }] });

  addPage({
    path: '/us/new-patients', lang: 'en-US', title: 'New Patients Visiting from the US | Harbourline Dental', desc: 'Visiting the UK from the United States? How American visitors can see a Harbourline dentist, pay for care and claim on US dental insurance.',
    crumbs: [['/', 'Home'], ['/us/new-patients', 'US visitors']],
    hreflang: [['en-us', '/us/new-patients'], ['en-gb', '/new-patients'], ['x-default', '/new-patients']],
    schema: [crumbsLd([['/', 'Home'], ['/us/new-patients', 'US visitors']])],
    main: `<h1>Dental care for visitors from the United States</h1>
<p class="lead">Many of our Bath patients are visiting from the US for work or study. You do not need to be a UK resident to be seen.</p>
<h2>Booking as a visitor</h2>
<p>Call the clinic or book online and mention that you are visiting. Bring your passport or another photo ID and a list of your medications, including their US brand names, which can differ from UK names.</p>
<h2>Paying and insurance</h2>
<p>We charge in pounds sterling and take US credit cards. We do not bill American insurers directly. We will give you an itemized receipt with treatment codes your insurer can use, and many US plans reimburse emergency care abroad.</p>
<h2>Emergencies</h2>
<p>If you have a dental emergency while traveling, call the nearest clinic from 8am. Outside our hours, dial 111 for urgent advice; 911 does not work in the UK, so use 999 for life-threatening emergencies.</p>
<h2>Continuing care at home</h2>
<p>We can email your X-rays and a treatment summary to your dentist in the US so they can continue your care after you return.</p>`,
  });

  // INVISALIGN GUIDE hreflang pair (missing return link on US page)
  addPage({
    path: '/invisalign-guide', title: 'A Patient Guide to Clear Aligner Treatment | Harbourline', desc: 'Our patient guide to clear aligners: suitability, wearing time, attachments, cost in pounds and retainers after treatment.',
    crumbs: [['/', 'Home'], ['/invisalign-guide', 'Aligner guide']],
    hreflang: [['en-gb', '/invisalign-guide'], ['en-us', '/us/invisalign-guide'], ['x-default', '/invisalign-guide']],
    schema: [crumbsLd([['/', 'Home'], ['/invisalign-guide', 'Aligner guide']])],
    main: `<h1>Your guide to clear aligner treatment</h1>
<p class="lead">This guide answers the questions we hear at aligner consultations in our Bath clinic, from how many hours a day you wear the trays to what happens after treatment ends.</p>
<h2>Wearing your aligners</h2>
<p>Aligners only move teeth while they are in. Wear them for twenty to twenty-two hours a day and take them out only to eat, drink anything other than cold water, and clean your teeth. Most people find the first two days of each new set feel tight.</p>
<h2>Attachments and refinements</h2>
<p>Small tooth-coloured bumps called attachments are bonded to some teeth so the aligners can grip them. Towards the end, a fresh scan often leads to a short series of refinement aligners to perfect the result. These are included in our fee.</p>
<h2>Cost in the UK</h2>
<p>Treatment starts at £2,900 for mild cases and £3,900 for comprehensive treatment, including retainers and all reviews. Interest-free finance over twelve months is available, subject to status.</p>
<h2>After treatment</h2>
<p>Teeth tend to drift back. We fit a bonded wire retainer behind the front teeth and a clear removable retainer for night-time wear, which you should keep using indefinitely.</p>
<p>Reading from the US? See the <a href="/us/invisalign-guide">US edition of this guide</a>.</p>`,
  });
  addPage({
    path: '/us/invisalign-guide', lang: 'en-US', title: 'Clear Aligners in the UK for US Patients | Harbourline', desc: 'Starting or continuing clear aligner treatment in the UK as a US patient: transferring a case, costs in dollars, and checkups.',
    crumbs: [['/', 'Home'], ['/us/invisalign-guide', 'Aligner guide (US)']],
    hreflang: [['en-us', '/us/invisalign-guide']],
    schema: [crumbsLd([['/', 'Home'], ['/us/invisalign-guide', 'Aligner guide (US)']])],
    main: `<h1>Clear aligners in the UK for American patients</h1>
<p class="lead">If you started aligner treatment with an orthodontist in the US and are spending a semester or a work posting in England, we can help you keep it on track.</p>
<h2>Transferring an existing case</h2>
<p>Ask your US provider to transfer your case to our Bath office through the aligner manufacturer's portal. We will review your progress, check how your trays fit, and order any additional aligners you need.</p>
<h2>What it costs</h2>
<p>A transfer review costs about $120 at current exchange rates. Comprehensive treatment started here costs roughly $3,700 to $5,000, billed in pounds. US orthodontic insurance rarely covers care abroad, so check your plan before you start.</p>
<h2>Checkups and emergencies</h2>
<p>We see aligner patients every six to eight weeks. If an attachment comes off or a tray cracks, call the office and we will usually see you within a few days.</p>
<h2>Going home</h2>
<p>When you head back to the States, we send your scans and records to your orthodontist so treatment continues without interruption.</p>`,
  });
  def({ area: 'technical', type: 'hreflang-missing-return-link', scope: 'page', url: '/us/invisalign-guide', related_url: '/invisalign-guide', description: '/invisalign-guide declares /us/invisalign-guide as its en-us alternate, but the US page does not link back with an en-gb (or x-default) hreflang.', source: S.hreflang, evidence: '/us/invisalign-guide has only <link rel="alternate" hreflang="en-us" …> (self).', verify: [{ html: 'hreflang="en-us"' }, { htmlNot: 'hreflang="en-gb"' }, { url: '/invisalign-guide', html: 'hreflang="en-us" href="[^"]*/us/invisalign-guide"' }] });

  // PATIENT STORIES — client-side rendered only
  put('patient-stories.html', `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Patient Stories | Harbourline Dental Studio</title>
<meta name="description" content="Real treatment journeys from Harbourline patients, in their own words: implants, aligners, nervous patients and children’s care.">
<link rel="canonical" href="${O}/patient-stories">
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="stylesheet" href="/assets/css/site.css">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:title" content="Patient Stories">
<meta property="og:description" content="Real treatment journeys from Harbourline patients, in their own words.">
<meta property="og:url" content="${O}/patient-stories">
<meta property="og:image" content="${O}/images/og-default.jpg">
<meta name="twitter:card" content="summary_large_image">
<script src="/assets/js/site.js" defer></script>
<script src="/assets/js/patient-stories.js" defer></script>
</head>
<body>
${header('/patient-stories')}
<main id="main"><div id="app" aria-live="polite"></div>
<noscript><p>Please enable JavaScript to read our patient stories.</p></noscript></main>
${footer()}
</body>
</html>
`);
  pagesMeta.push({ path: '/patient-stories', title: 'Patient Stories | Harbourline Dental Studio' });
  def({ area: 'ai-access', type: 'client-side-rendered-content', scope: 'page', url: '/patient-stories', description: 'All main content, including the H1, is rendered in the browser from /data/stories.json; the HTML response contains only an empty <div id="app"> and a "please enable JavaScript" message. AI crawlers that do not run JavaScript see nothing.', source: S.jsSeo, evidence: '<main id="main"><div id="app" aria-live="polite"></div><noscript>…', alt_types: ['missing-h1', 'thin-content'], verify: [{ html: '<div id="app" aria-live="polite"></div>' }, { count: '<h1', equals: 0 }] });

  // LEGAL
  const legalCrumb = (p, t) => [['/', 'Home'], [p, t]];
  // privacy — huge DOM
  {
    const rows = [];
    const purposes = ['Appointment booking', 'Clinical records', 'Payment processing', 'Recall reminders', 'Insurance receipts', 'Referral letters', 'Laboratory orders', 'Complaints handling'];
    const bases = ['Contract', 'Legal obligation', 'Legitimate interests', 'Health care (Art. 9(2)(h))'];
    const keep = ['11 years after last visit', '7 years', '2 years', 'Until age 25 or 11 years, whichever is longer'];
    for (let i = 1; i <= 420; i++) rows.push(`<tr><td>PR-${String(i).padStart(4, '0')}</td><td>${purposes[i % 8]}</td><td>${bases[i % 4]}</td><td>${['Patients', 'Staff', 'Referrers', 'Suppliers'][i % 4]}</td><td>${keep[i % 4]}</td><td><span>${['Bristol', 'Bath', 'Leeds'][i % 3]}</span></td></tr>`);
    simple('/legal/privacy', 'Privacy Notice for Patients | Harbourline Dental Studio', 'How Harbourline Dental Studio collects, uses, stores and shares personal and health information, and your rights under UK GDPR.', 'Privacy notice',
      `<p class="lead">This notice explains how we use your personal information when you are a patient, when you contact us, and when you visit this website.</p>
<h2>Who we are</h2>
<p>${BRAND} Ltd is the data controller for patient information held at our Bristol, Bath and Leeds clinics. Our data protection lead is the practice manager, who can be contacted at privacy@harbourline.example.</p>
<h2>What we collect and why</h2>
<p>We hold your contact details, medical history, dental records, X-rays, photographs and payment records so that we can provide safe dental care, keep accurate records as the law requires, and take payment. Health information is special category data, which we process for the purposes of providing health care.</p>
<h2>Your rights</h2>
<p>You can ask for a copy of your records, ask us to correct them, and in some cases object to processing or ask for deletion. Clinical records must be kept for set periods and cannot normally be deleted early. You can complain to the Information Commissioner’s Office if you are unhappy with how we handle your data.</p>
<h2>Register of processing activities</h2>
<table class="register"><thead><tr><th>Ref</th><th>Purpose</th><th>Lawful basis</th><th>Data subjects</th><th>Retention</th><th>Site</th></tr></thead><tbody>
${rows.join('\n')}
</tbody></table>`, { crumbs: legalCrumb('/legal/privacy', 'Privacy notice') });
    def({ area: 'technical', type: 'excessive-dom-size', scope: 'page', url: '/legal/privacy', description: 'Page has over 3,000 DOM elements (a 420-row table), well above Lighthouse’s 1,400-element warning level.', source: S.lhDom, evidence: '<table class="register"> with 420 rows × 6 cells.', verify: [{ count: '<tr>', min: 400 }] });
  }
  simple('/legal/cookies', 'Cookie Policy | Harbourline Dental Studio', 'The cookies used on the Harbourline Dental Studio website, what each one does, how long it lasts and how to control them.', 'Cookie policy',
    `<p class="lead">This website uses a small number of cookies. We do not use advertising or cross-site tracking cookies.</p>
<h2>Cookies we use</h2>
<table><thead><tr><th>Name</th><th>Purpose</th><th>Duration</th></tr></thead><tbody>
<tr><td>hl_session</td><td>Keeps the booking form working as you move between steps</td><td>Session</td></tr>
<tr><td>hl_consent</td><td>Remembers your cookie choices</td><td>12 months</td></tr>
<tr><td>hl_stats</td><td>Counts visits to each page without identifying you</td><td>30 days</td></tr>
</tbody></table>
<h2>Controlling cookies</h2>
<p>You can change your cookie choices at any time from the link in the footer, or block cookies in your browser settings. Blocking the session cookie stops the online booking form from working, but you can still book by phone.</p>
<h2>Changes to this policy</h2>
<p>We review this policy whenever we add or remove a cookie, and at least once a year. The date of the last review is shown at the bottom of this page.</p>
<h2>Analytics without tracking</h2>
<p>Our visit counter is hosted by us, stores no personal information and does not share data with third parties. It tells us which advice articles are read most so we can keep them up to date.</p>
<p>Last reviewed: 1 September 2026.</p>`, { crumbs: legalCrumb('/legal/cookies', 'Cookie policy') });
  def({ area: 'technical', type: 'server-version-disclosure', scope: 'page', url: '/legal/cookies', description: 'Response headers disclose server software and versions.', source: S.owaspFingerprint, evidence: 'Server: Apache/2.4.29 (Ubuntu); X-Powered-By: PHP/7.2.24', verify: [{ header: 'server', match: 'Apache/2\\.4\\.29' }, { header: 'x-powered-by', match: 'PHP/7' }] });

  const termsDesc = 'These terms of treatment explain how Harbourline Dental Studio books appointments, sets and quotes fees, takes deposits and payments, handles cancellations and missed appointments, offers guarantees on crowns, bridges, implants and veneers, manages refunds and remakes, and resolves complaints at our Bristol, Bath and Leeds clinics.';
  addPage({
    path: '/legal/terms', title: 'Terms of Treatment | Harbourline Dental Studio', desc: termsDesc, canonical: '/legal/terms',
    crumbs: legalCrumb('/legal/terms', 'Terms of treatment'), schema: [crumbsLd(legalCrumb('/legal/terms', 'Terms of treatment'))],
    main: `<h1>Terms of treatment</h1>
<p class="lead">These terms apply to all private treatment at Harbourline clinics. Please read them before your first appointment.</p>
<h2>Fees and estimates</h2>
<p>We give you a written treatment plan with fees before any course of treatment. If the plan needs to change during treatment, we explain why and confirm the new fee before continuing.</p>
<h2>Deposits and payment</h2>
<p>Laboratory work such as crowns and veneers requires a deposit of fifty per cent when impressions or scans are taken. The balance is due when the work is fitted. Other treatment is paid for at each appointment.</p>
<h2>Cancellations</h2>
<p>Please give at least two working days’ notice. Appointments cancelled with less notice, or missed, may be charged at half the fee. We waive this charge for genuine emergencies.</p>
<h2>Guarantees</h2>
<p>Crowns, bridges, veneers and implant restorations are guaranteed for two years against failure in normal use, provided you attend check-ups and hygiene visits as recommended. The guarantee does not cover damage from accidents or sport without a mouthguard.</p>
<h2>Complaints</h2>
<p>If you are unhappy with any part of your care, please see our <a href="/legal/complaints">complaints procedure</a>.</p>`,
  });
  def({ area: 'technical', type: 'canonical-relative-url', scope: 'page', url: '/legal/terms', description: 'rel=canonical uses a relative URL; it should be absolute.', source: S.lhCanonical, evidence: '<link rel="canonical" href="/legal/terms">', verify: [{ html: 'rel="canonical" href="/legal/terms"' }] });
  def({ area: 'content', type: 'meta-description-too-long', scope: 'page', url: '/legal/terms', description: `Meta description is ${termsDesc.length} characters, far beyond what search results display (~155–160).`, source: S.snippet, evidence: `${termsDesc.length}-character meta description.`, verify: [{ descLenMin: 250 }] });

  simple('/legal/complaints', 'Complaints Procedure | Harbourline Dental Studio', 'How to raise a concern or complaint about treatment at Harbourline, how quickly we respond and where to go if you are not satisfied.', 'Complaints procedure',
    `<p class="lead">We want to hear when something has gone wrong so that we can put it right and learn from it.</p>
<h2>How to complain</h2>
<p>Speak to any member of the team, phone the practice manager, or write to complaints@harbourline.example. You can complain on behalf of someone else with their permission.</p>
<h2>What happens next</h2>
<p>We acknowledge every complaint within two working days and aim to give a full response within twenty working days. If the investigation takes longer, we will tell you why and keep you updated.</p>
<h2>If you are not satisfied</h2>
<p>Private patients can contact the Dental Complaints Service, an independent service funded by the General Dental Council. Concerns about a dental professional’s fitness to practise can be raised directly with the General Dental Council.</p>
<h2>Learning from complaints</h2>
<p>We review every complaint at our monthly clinical governance meeting and share anonymised lessons with the whole team. A summary of the changes we have made is included in our annual practice report.</p>`,
    { crumbs: legalCrumb('/legal/complaints', 'Complaints procedure'), o: { viewport: null } });
  def({ area: 'technical', type: 'missing-viewport', scope: 'page', url: '/legal/complaints', description: 'Page has no <meta name="viewport">, so mobile browsers render it at desktop width.', source: S.lhViewport, evidence: 'No viewport meta tag.', verify: [{ htmlNot: 'name="viewport"' }] });

  // CONTROLS: accessibility, careers, finance, referrals, developers
  simple('/legal/accessibility', 'Website Accessibility Statement | Harbourline Dental', 'How accessible the Harbourline Dental Studio website is, the standard we aim for, known limitations and how to ask for information in another format.', 'Accessibility statement',
    `<p class="lead">We want everyone to be able to use this website and our clinics. This statement covers the website at this address.</p>
<h2>Our standard</h2>
<p>We aim to meet the Web Content Accessibility Guidelines version 2.2 at level AA. Pages use proper headings, every image has a text alternative, and the site can be used with a keyboard alone and with screen readers such as NVDA and VoiceOver.</p>
<h2>Requesting another format</h2>
<p>If you need information from this site in large print, easy read or audio, email hello@harbourline.example or phone your clinic. We aim to respond within five working days.</p>
<h2>Accessibility in our clinics</h2>
<p>Our Bristol and Leeds clinics have step-free access throughout. In Bath, treatment rooms are on the first floor and served by a lift. Hearing loops are fitted at every reception desk, and assistance dogs are welcome.</p>
<h2>Reporting a problem</h2>
<p>If you find a part of the website that is difficult to use, please tell us which page and what went wrong. We record every report and aim to fix problems within one month, and we review the whole site twice a year.</p>`,
    { crumbs: legalCrumb('/legal/accessibility', 'Accessibility statement') });
  controls.push('/legal/accessibility');

  simple('/careers', 'Careers in Dentistry at Harbourline Dental Studio', 'Work at Harbourline: current vacancies for dental nurses, receptionists and hygienists, plus training, pay and what it is like to work here.', 'Working at Harbourline',
    `<p class="lead">We employ twenty-two people across three clinics. Most of our team have been with us for more than five years.</p>
<h2>Current vacancies</h2>
<p>We are recruiting a qualified dental nurse for our Leeds clinic, four days a week, and a part-time receptionist for Bath covering Tuesday and Thursday mornings. Both roles are permanent.</p>
<h2>Pay and benefits</h2>
<p>We pay above the local average for each role and review pay every April. Benefits include free dental treatment for staff and their children, a paid birthday day off, thirty-three days of annual leave including bank holidays, and a contribution to professional registration fees.</p>
<h2>Training</h2>
<p>Every team member has a personal training budget each year and protected time to use it. Trainee dental nurses are supported through their qualification, and several of our nurses have gone on to train as hygienists and therapists with our help.</p>
<h2>How to apply</h2>
<p>Send a short covering letter and your CV to careers@harbourline.example, saying which role and clinic you are interested in. We reply to every application within ten working days and interview at the clinic where the role is based.</p>`);
  controls.push('/careers');

  simple('/finance', 'Paying for Dental Treatment and Finance | Harbourline', 'Ways to pay at Harbourline: card payments, deposits for laboratory work, interest-free finance over twelve months and itemised receipts for insurers.', 'Paying for your treatment',
    `<p class="lead">You pay for treatment as it happens, and larger courses of treatment can be spread over twelve months without interest.</p>
<h2>Paying at each visit</h2>
<p>We take debit cards, credit cards and Apple Pay at reception. We do not accept cheques. You receive an itemised receipt by email after every payment.</p>
<h2>Interest-free finance</h2>
<p>For treatment plans over £1,000 you can pay a ten per cent deposit and spread the remaining cost over up to twelve monthly payments with no interest. Finance is provided by a regulated lender and is subject to a credit check. Your treatment coordinator will help you apply online in about ten minutes.</p>
<h2>Example</h2>
<p>For a single implant costing £2,650, you would pay a deposit of £265 and then twelve monthly payments of about £198.75. The total amount repayable is £2,650.</p>
<h2>Dental insurance and cash plans</h2>
<p>Many insurance and cash plans contribute towards check-ups and treatment. We provide the itemised receipts and treatment codes your provider needs, and you claim directly from them.</p>`);
  controls.push('/finance');

  simple('/referrals', 'Referrals for Dentists: Implants and Aligners | Harbourline', 'Information for referring dentists: how to refer patients for implants, clear aligners or gum treatment, what we send back and typical waiting times.', 'Referring a patient to Harbourline',
    `<p class="lead">We accept referrals from other dental practices for implants, clear aligners and gum treatment. Patients return to you for routine care when treatment is finished.</p>
<h2>What we accept</h2>
<p>Implant referrals go to Dr Rohan Mehta in Bristol. Aligner referrals go to Dr Sophie Lang in Bath. Gum disease referrals for patients with pockets of six millimetres or more go to our Leeds hygiene team, with dentist oversight.</p>
<h2>How to refer</h2>
<p>Email a referral letter with the patient’s contact details, medical history, the reason for referral and recent radiographs to referrals@harbourline.example. We acknowledge every referral within two working days.</p>
<h2>What you receive</h2>
<p>You receive a copy of our assessment and treatment plan, a letter when treatment starts and a full report at the end, including maintenance advice and any review we recommend.</p>
<h2>Waiting times</h2>
<p>Implant consultations are usually available within three weeks. Aligner consultations in Bath are typically available within two weeks. Urgent gum referrals are seen within ten working days.</p>`);
  controls.push('/referrals');

  simple('/developers', 'Developer Information and Booking API | Harbourline', 'How software and AI agents can find Harbourline Dental Studio’s booking API, its machine-readable catalogue and the agent discovery files we publish.', 'Information for developers',
    `<p class="lead">We are piloting a small booking availability API for partner apps and AI assistants. This page explains what is published and how to request access.</p>
<h2>What is available</h2>
<p>The pilot API returns free appointment slots by clinic and appointment type. It does not return any patient information, and making a booking still requires the patient to confirm by phone or email.</p>
<h2>Discovery files</h2>
<p>Our API catalogue is published at <a href="/.well-known/api-catalog">/.well-known/api-catalog</a> in the linkset format. A plain-language summary of the website for AI assistants is published at <a href="/llms.txt">/llms.txt</a>.</p>
<h2>Requesting access</h2>
<p>Email developers@harbourline.example with the name of your application, how you will use the data and an expected request volume. Access is free during the pilot. We review requests within ten working days.</p>
<h2>Fair use</h2>
<p>Please cache availability for at least five minutes and do not make more than one request per second. We may suspend keys that exceed these limits without notice.</p>`);
  controls.push('/developers');

  // utility pages (not linked, not in sitemap)
  put('thank-you.html', page({ path: '/thank-you', title: 'Thank You | Harbourline Dental Studio', desc: 'Thank you for contacting Harbourline Dental Studio. We will reply within one working day.', robots: 'noindex', main: '<h1>Thank you</h1>\n<p>We have received your message and will reply within one working day.</p>\n<p><a href="/">Return to the home page</a></p>' }));
  put('404.html', page({ path: '/404', canonical: false, title: 'Page Not Found | Harbourline Dental Studio', desc: 'The page you asked for could not be found.', robots: 'noindex', main: '<h1>Page not found</h1>\n<p>Sorry, we cannot find that page. Try the <a href="/">home page</a>, our <a href="/services">treatments</a> or <a href="/blog">dental advice articles</a>.</p>' }));
  put('410.html', page({ path: '/410', canonical: false, title: 'Page Removed | Harbourline Dental Studio', desc: 'This page has been permanently removed.', robots: 'noindex', main: '<h1>This page has been removed</h1>\n<p>The page you asked for has been permanently removed. Browse our <a href="/blog">latest advice</a>.</p>' }));
}

// ================================================================ ROBOTS / SITEMAPS / LLMS / WELL-KNOWN
put('robots.txt', `# robots.txt for Harbourline Dental Studio
User-agent: *
Disallow: /assets/js/
Disallow: /search
Disallow: /thank-you

User-agent: GPTBot
Disallow: /

User-agent: PerplexityBot
Disallow: /

User-agent: ChatGPT-User
Disallow: /

User-agent: ClaudeBot
Disallow: /team/

Sitemap: ${O}/sitemap.xml
`);
def({ area: 'technical', type: 'robots-blocks-resources', scope: 'site', url: '/robots.txt', description: 'robots.txt disallows /assets/js/ for all crawlers, blocking the scripts search engines need to render pages (including the client-side rendered /patient-stories and /pricing).', source: S.robotsIntro, evidence: 'User-agent: * / Disallow: /assets/js/', verify: [{ html: 'Disallow: /assets/js/' }] });
def({ area: 'ai-access', type: 'robots-blocks-ai-training-bot', scope: 'site', url: '/robots.txt', description: 'GPTBot is disallowed from the whole site, although llms.txt says the practice welcomes AI assistants using its content.', source: S.openaiBots, evidence: 'User-agent: GPTBot / Disallow: /', verify: [{ html: 'User-agent: GPTBot\\nDisallow: /\\n' }] });
def({ area: 'ai-access', type: 'robots-blocks-ai-search-bot', scope: 'site', url: '/robots.txt', description: 'PerplexityBot (the crawler that indexes pages for Perplexity answers) is disallowed from the whole site, so the practice cannot appear in Perplexity search results.', source: S.perplexityBots, evidence: 'User-agent: PerplexityBot / Disallow: /', verify: [{ html: 'User-agent: PerplexityBot\\nDisallow: /\\n' }] });
def({ area: 'ai-access', type: 'robots-blocks-ai-user-agent', scope: 'site', url: '/robots.txt', description: 'ChatGPT-User (fetches pages when a ChatGPT user asks about them) is disallowed from the whole site.', source: S.openaiBots, evidence: 'User-agent: ChatGPT-User / Disallow: /', verify: [{ html: 'User-agent: ChatGPT-User\\nDisallow: /\\n' }] });
def({ area: 'ai-access', type: 'robots-blocks-ai-bot-path', scope: 'site', url: '/robots.txt', related_url: '/team/', description: 'ClaudeBot is disallowed from /team/, hiding all clinician biographies (the authorship and expertise pages) from Anthropic’s crawler while the rest of the site is allowed.', source: S.anthropicBots, evidence: 'User-agent: ClaudeBot / Disallow: /team/', verify: [{ html: 'User-agent: ClaudeBot\\nDisallow: /team/' }] });

// sitemaps
{
  const indexable = pagesMeta.map((x) => x.path).filter((p) => !['/blog/page/2', '/blog/page/3'].includes(p));
  const blogUrls = indexable.filter((p) => p.startsWith('/blog/') && !p.startsWith('/blog/category') && !p.startsWith('/blog/tag'));
  const pageUrls = indexable.filter((p) => !blogUrls.includes(p));
  pageUrls.push('/services/root-canal'); // 404 in sitemap
  blogUrls.push('/blog/retainer-care'.toString());
  blogUrls.push('/blog/tooth-brushing-guide'); // redirect in sitemap
  const uniq = (a) => [...new Set(a)];
  const lastmodFor = (p) => {
    const post = posts.find((x) => postPath(x.slug) === p);
    if (p === '/blog/healthy-snacks') return '13/05/2024';
    if (post && post.mod) return post.mod;
    return '2026-09-01';
  };
  const urlset = (urls) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${uniq(urls).map((p) => `  <url>\n    <loc>${O}${p}</loc>\n    <lastmod>${lastmodFor(p)}</lastmod>\n  </url>`).join('\n')}
</urlset>
`;
  put('sitemaps/sitemap-pages.xml', urlset(pageUrls));
  put('sitemaps/sitemap-blog.xml', urlset(blogUrls));
  put('sitemaps/sitemap-images.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>${O}/</loc>
    <image:image><image:loc>${O}/images/hero-harbourline.jpg</image:loc></image:image>
  </url>
  <url>
    <loc>${O}/about</loc>
    <image:image><image:loc>${O}/images/clinic-panorama.jpg</image:loc>
  </url>
</urlset>
`);
  put('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${O}/sitemaps/sitemap-pages.xml</loc><lastmod>2026-09-01</lastmod></sitemap>
  <sitemap><loc>${O}/sitemaps/sitemap-blog.xml</loc><lastmod>2026-09-20</lastmod></sitemap>
  <sitemap><loc>${O}/sitemaps/sitemap-images.xml</loc><lastmod>2026-09-01</lastmod></sitemap>
</sitemapindex>
`);
  def({ area: 'technical', type: 'sitemap-contains-4xx', scope: 'page', url: '/services/root-canal', description: 'XML sitemap lists a URL that returns 404.', source: S.sitemapG, evidence: '<loc>{{ORIGIN}}/services/root-canal</loc> in sitemap-pages.xml → 404.', alt_types: ['http-404'], verify: [{ status: 404 }, { url: '/sitemaps/sitemap-pages.xml', html: '/services/root-canal<' }] });
  def({ area: 'technical', type: 'sitemap-contains-redirect', scope: 'page', url: '/blog/tooth-brushing-guide', description: 'XML sitemap lists a URL that 301-redirects.', source: S.sitemapG, evidence: '<loc>{{ORIGIN}}/blog/tooth-brushing-guide</loc> → 301 → /blog/how-to-brush-your-teeth.', verify: [{ redirect: { status: 301, location: '/blog/how-to-brush-your-teeth' } }, { url: '/sitemaps/sitemap-blog.xml', html: '/blog/tooth-brushing-guide<' }] });
  def({ area: 'technical', type: 'sitemap-invalid-xml', scope: 'site', url: '/sitemaps/sitemap-images.xml', description: 'Child sitemap referenced from the sitemap index is not well-formed XML (an <image:image> element is never closed).', source: S.sitemapsOrg, evidence: '<image:image><image:loc>…clinic-panorama.jpg</image:loc>\\n  </url> — missing </image:image>.', verify: [{ xmlInvalid: true }] });
  def({ area: 'technical', type: 'sitemap-invalid-lastmod', scope: 'site', url: '/sitemaps/sitemap-blog.xml', related_url: '/blog/healthy-snacks', description: 'A <lastmod> value is not in W3C Datetime format.', source: S.sitemapsOrg, evidence: '<lastmod>13/05/2024</lastmod> for /blog/healthy-snacks.', verify: [{ html: '<lastmod>13/05/2024</lastmod>' }] });
}

// llms.txt — no H1, one broken link
put('llms.txt', `> Harbourline Dental Studio is an independent dental practice with clinics in Bristol, Bath and Leeds (UK). We welcome AI assistants and AI search tools reading and citing this site to answer questions about our treatments, prices and clinics.

Prices on this site are in pounds sterling and include VAT where it applies. Appointments can be requested online; urgent cases should phone the clinic.

## Treatments

- [General dentistry](${O}/services/general-dentistry): check-ups, fillings, crowns and root canal treatment
- [Teeth whitening](${O}/services/teeth-whitening-old): dentist-supervised home whitening
- [Dental implants](${O}/services/dental-implants): single implants, bridges and implant dentures
- [Emergency appointments](${O}/services/emergency-dentist): same-day appointments for pain and swelling

## Practical information

- [Prices](${O}/pricing): current fees
- [Clinics](${O}/locations): addresses, opening hours and parking
- [FAQ](${O}/faq): common questions about fees, parking and payment
- [Book an appointment](${O}/book): online appointment requests

## Optional

- [Dental advice articles](${O}/blog): articles written by our dentists and hygienists
`);
def({ area: 'ai-access', type: 'llms-txt-missing-h1', scope: 'site', url: '/llms.txt', description: 'llms.txt does not start with the required H1 (the site or project name); it begins with a blockquote.', source: S.llms, evidence: 'First line: "> Harbourline Dental Studio is an independent…"; no line starting "# ".', verify: [{ htmlNot: '^# ' }] });
def({ area: 'ai-access', type: 'llms-txt-broken-link', scope: 'site', url: '/llms.txt', related_url: '/services/teeth-whitening-old', description: 'llms.txt links to a page that returns 404.', source: S.llms, evidence: '[Teeth whitening]({{ORIGIN}}/services/teeth-whitening-old) → 404.', verify: [{ html: '/services/teeth-whitening-old' }, { url: '/services/teeth-whitening-old', status: 404 }] });

// firewall (implemented in serve.mjs)
def({ area: 'ai-access', type: 'waf-blocks-ai-bot', scope: 'site', url: '/services/', url_prefix: '/services/', description: 'Every treatment page under /services/ returns 403 with a "request blocked" challenge page to AI crawler user agents (ClaudeBot, Claude-SearchBot, Claude-User, OAI-SearchBot, GPTBot, ChatGPT-User, PerplexityBot, Perplexity-User, Google-Extended, CCBot, Applebot-Extended, Bytespider, meta-externalagent), although robots.txt allows most of them there. Browsers and Googlebot get 200.', source: S.anthropicBots, evidence: 'GET /services/dental-implants with User-Agent containing "ClaudeBot" → 403 "Request blocked"; same URL with a browser UA → 200.', verify: [{ url: '/services/dental-implants', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', status: 403 }, { url: '/services/dental-implants', ua: 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)', status: 403 }, { url: '/services/dental-implants', status: 200 }] });

// well-known
put('.well-known/security.txt', `Contact: mailto:security@harbourline.example
Preferred-Languages: en
Canonical: ${O}/.well-known/security.txt
`);
def({ area: 'technical', type: 'security-txt-invalid', scope: 'site', url: '/.well-known/security.txt', description: 'security.txt is missing the required Expires field.', source: S.rfc9116, evidence: 'Fields present: Contact, Preferred-Languages, Canonical. No Expires.', verify: [{ status: 200 }, { htmlNot: 'Expires:' }] });

put('.well-known/agent-card.json', JSON.stringify({
  protocolVersion: '0.3.0', name: 'Harbourline booking assistant', description: 'Answers questions about Harbourline Dental Studio treatments and requests appointments.',
  url: `${O}/a2a`, preferredTransport: 'JSONRPC', provider: { organization: BRAND, url: O + '/' },
  capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
}, null, 2) + '\n');
def({ area: 'agentic', type: 'a2a-card-invalid', scope: 'site', url: '/.well-known/agent-card.json', description: 'A2A Agent Card is missing required fields "version" and "skills".', source: S.a2a, evidence: 'agent-card.json has protocolVersion, name, description, url, capabilities, default*Modes but no version and no skills array.', verify: [{ jsonMissing: ['version', 'skills'] }] });
def({ area: 'agentic', type: 'a2a-endpoint-unreachable', scope: 'site', url: '/.well-known/agent-card.json', related_url: '/a2a', description: 'The A2A service endpoint advertised in the Agent Card returns 404.', source: S.a2a, evidence: '"url": "{{ORIGIN}}/a2a" → GET/POST 404.', verify: [{ url: '/a2a', status: 404 }] });

put('.well-known/mcp/server-card.json', `{
  "$schema": "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
  "name": "harbourline-availability",
  "version": "0.3.1",
  "description": "Free appointment slots at Harbourline Dental Studio clinics",
  "remotes": [
    { "type": "streamable-http", "url": "${O}/mcp" },
  ]
`);
def({ area: 'agentic', type: 'mcp-server-card-invalid', scope: 'site', url: '/.well-known/mcp/server-card.json', description: 'MCP Server Card is not valid JSON (trailing comma in "remotes" and missing closing brace).', source: S.mcpCard1649, evidence: '"remotes": [ {…}, ]  and no final }', verify: [{ jsonInvalid: true }] });
put('.well-known/mcp.json', JSON.stringify({
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-10-17/server.schema.json',
  name: 'example.harbourline/availability', description: 'Free appointment slots at Harbourline Dental Studio clinics', version: '0.3.1',
  remotes: [{ type: 'streamable-http', url: `${O}/mcp` }],
}, null, 2) + '\n');
def({ area: 'agentic', type: 'mcp-endpoint-unreachable', scope: 'site', url: '/.well-known/mcp.json', related_url: '/mcp', description: 'The streamable-HTTP MCP endpoint advertised in /.well-known/mcp.json returns 404.', source: S.mcpCard, evidence: '"remotes": [{"type": "streamable-http", "url": "{{ORIGIN}}/mcp"}] → 404.', verify: [{ url: '/mcp', status: 404 }, { html: '/mcp"' }] });

put('.well-known/oauth-authorization-server', JSON.stringify({
  issuer: 'https://auth.harbourline-dental.example', authorization_endpoint: `${O}/oauth/authorize`, token_endpoint: `${O}/oauth/token`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['availability:read'],
}, null, 2) + '\n');
def({ area: 'agentic', type: 'oauth-metadata-issuer-mismatch', scope: 'site', url: '/.well-known/oauth-authorization-server', description: 'Authorization server metadata "issuer" does not match the URL the metadata was fetched from; RFC 8414 §3.3 requires clients to reject it.', source: S.rfc8414, evidence: '"issuer": "https://auth.harbourline-dental.example" served at {{ORIGIN}}/.well-known/oauth-authorization-server.', verify: [{ html: '"issuer": "https://auth.harbourline-dental.example"' }] });

put('.well-known/oauth-protected-resource', JSON.stringify({
  authorization_servers: [O], scopes_supported: ['availability:read'], bearer_methods_supported: ['header'], resource_name: 'Harbourline availability API',
}, null, 2) + '\n');
def({ area: 'agentic', type: 'oauth-protected-resource-invalid', scope: 'site', url: '/.well-known/oauth-protected-resource', description: 'Protected Resource Metadata lacks the REQUIRED "resource" member.', source: S.rfc9728, evidence: 'JSON has authorization_servers, scopes_supported, bearer_methods_supported, resource_name; no "resource".', verify: [{ jsonMissing: ['resource'] }] });

put('.well-known/api-catalog', JSON.stringify({
  linkset: [{ anchor: `${O}/api/`, 'service-desc': [{ href: `${O}/openapi.json`, type: 'application/vnd.oai.openapi+json' }], 'service-doc': [{ href: `${O}/developers`, type: 'text/html' }] }],
}, null, 2) + '\n');
def({ area: 'agentic', type: 'api-catalog-broken-link', scope: 'site', url: '/.well-known/api-catalog', related_url: '/openapi.json', description: 'The api-catalog linkset’s service-desc (OpenAPI description) URL returns 404.', source: S.rfc9727, evidence: '"service-desc": [{"href": "{{ORIGIN}}/openapi.json"}] → 404.', verify: [{ html: '/openapi.json' }, { url: '/openapi.json', status: 404 }] });

// ================================================================ ASSETS
put('api/prices.json', JSON.stringify({ currency: 'GBP', updated: '2026-09-01', items: [
  ['New patient examination', 75], ['Check-up', 55], ['Hygiene, 30 minutes', 70], ['Hygiene, 45 minutes', 95], ['Emergency appointment', 85],
  ['White filling (small)', 120], ['Crown (porcelain)', 695], ['Root canal treatment (front tooth)', 450], ['Single implant with crown', 2650],
  ['Home whitening', 350], ['Clear aligners (from)', 2900], ['Composite veneer (per tooth)', 280], ['Porcelain veneer (per tooth)', 750],
].map(([name, price]) => ({ name, price })) }, null, 2) + '\n');
put('data/stories.json', JSON.stringify({ title: 'Patient stories', intro: 'Real treatment journeys from Harbourline patients, shared with their permission and in their own words.', stories: [
  { name: 'Margaret, 67, Bristol', treatment: 'Implant-retained denture', text: 'I had worn a lower denture for twenty years and it never stayed put. Two implants changed that. I can eat an apple again, and I stopped worrying about it moving when I talk. Dr Mehta explained every step and the whole thing took about four months.' },
  { name: 'James, 34, Bath', treatment: 'Clear aligners', text: 'My front teeth had crowded again since my braces as a teenager. Eight months of aligners and they are straight. The hardest part was remembering to put them back in after lunch. Dr Lang was honest that I would need to wear a retainer for good.' },
  { name: 'Aisha, 29, Leeds', treatment: 'Gum treatment', text: 'I had not been to a dentist for nine years because I was embarrassed. Priya never made me feel judged. My gums bled every time I brushed; after three cleaning sessions and a lot of practice with interdental brushes, they do not bleed at all.' },
  { name: 'The Okafor family, Bristol', treatment: 'Children’s dentistry', text: 'Both our children have been coming since they were babies. Tom makes the visits feel like a game, and neither of them has needed a filling. They actually ask when the next visit is.' },
] }, null, 2) + '\n');

put('assets/css/site.css', `:root{--ink:#1d2a33;--bg:#ffffff;--brand:#0b5f73;--brand-dark:#073f4d;--muted:#4a5a64;--line:#d5dde2;--foot:#10232e}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);background:var(--bg)}
a{color:var(--brand);text-decoration:underline}a:hover{color:var(--brand-dark)}
img{max-width:100%;height:auto;display:block}
.skip{position:absolute;left:-9999px;top:0;background:#fff;padding:8px 12px}.skip:focus{left:8px;z-index:10}
.site-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;background:var(--brand);color:#fff}
.site-header a{color:#fff}.site-header ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px 16px}
.site-header li a{display:inline-block;padding:10px 4px}.nav-cta{font-weight:600}
.logo img{width:240px;height:60px}
.crumbs{max-width:960px;margin:12px auto 0;padding:0 20px;font-size:15px}.crumbs ol{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.crumbs li+li::before{content:"/";margin-right:6px;color:var(--muted)}
main,#main{display:block;max-width:960px;margin:0 auto;padding:16px 20px 48px}
h1{font-size:2rem;line-height:1.2;margin:.5em 0}h2{font-size:1.4rem;margin:1.6em 0 .4em}
.lead{font-size:1.15rem;color:var(--muted)}
.btn{display:inline-block;background:var(--brand);color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;margin:4px 8px 4px 0;cursor:pointer}
.btn:hover{background:var(--brand-dark);color:#fff}.btn-secondary{background:#fff;color:var(--brand);border:2px solid var(--brand)}
.cards{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
.cards a{display:block;text-decoration:none;color:var(--ink);border:1px solid var(--line);border-radius:8px;overflow:hidden}.cards span{display:block;padding:10px 12px;font-weight:600}
.post-list li{margin:.6em 0}.small{font-size:15px;color:var(--muted)}
.key-points{border-left:4px solid var(--brand);padding:4px 16px;margin:16px 0;background:#f2f7f8}
.author-box{border-top:1px solid var(--line);margin-top:32px;padding-top:12px}
.byline{color:var(--muted);font-size:15px}
.form input,.form select,.form textarea{font:inherit;padding:8px;border:1px solid #6b7a83;border-radius:4px;max-width:100%}
.form button{font:inherit;padding:10px 16px;background:var(--brand);color:#fff;border:0;border-radius:6px;cursor:pointer}
.icon-btn{background:#fff!important;color:var(--brand)!important;border:1px solid var(--brand)!important;padding:6px!important}
.register{border-collapse:collapse;font-size:14px}.register td,.register th{border:1px solid var(--line);padding:2px 6px}
table{border-collapse:collapse}td,th{border:1px solid var(--line);padding:6px 8px;text-align:left}
.tab{display:inline-block;padding:6px 12px;border:1px solid var(--line);cursor:pointer}.tab.is-active{background:#f2f7f8}
.notice-banner{background:#fff4d6;border:1px solid #c99a1d;padding:16px;height:160px}
.h1-style{font-size:2rem;font-weight:700;line-height:1.2}
.site-footer{background:var(--foot);color:#fff;padding:24px 20px}.site-footer a{color:#cfe8ee}
.site-footer h2{font-size:1.1rem;color:#fff}.site-footer .small{color:#cfd8dc}
.footer-grid{max-width:960px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px}
.site-footer ul{list-style:none;padding:0}.site-footer li{margin:6px 0}
`);
put('assets/js/site.js', `// Small progressive enhancements.
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-href]');
  if (el) { window.location.href = el.getAttribute('data-href'); }
  var tab = e.target.closest('[data-tab]');
  if (tab) {
    var root = tab.closest('[data-tabs]');
    root.querySelectorAll('[data-tab]').forEach(function (t) { t.classList.toggle('is-active', t === tab); });
    root.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== tab.getAttribute('data-tab'); });
  }
});
`);
put('assets/js/patient-stories.js', `// Renders the patient stories page entirely on the client.
fetch('/data/stories.json').then(function (r) { return r.json(); }).then(function (d) {
  var app = document.getElementById('app');
  var html = '<h1>' + d.title + '</h1><p class="lead">' + d.intro + '</p>';
  d.stories.forEach(function (s) { html += '<h2>' + s.name + '</h2><p><strong>' + s.treatment + '.</strong> ' + s.text + '</p>'; });
  app.innerHTML = html;
});
`);
put('assets/js/pricing.js', `// Loads the price table from the API.
(function () {
  var box = document.getElementById('price-table');
  fetch(box.getAttribute('data-src')).then(function (r) { return r.json(); }).then(function (d) {
    var rows = d.items.map(function (i) { return '<tr><td>' + i.name + '</td><td>£' + i.price.toLocaleString('en-GB') + '</td></tr>'; }).join('');
    box.innerHTML = '<table><thead><tr><th>Treatment</th><th>Fee</th></tr></thead><tbody>' + rows + '</tbody></table>';
  });
})();
`);
put('assets/js/gallery.js', `// Before-and-after gallery.
document.addEventListener('DOMContentLoaded', function () {
  initLightbox(document.querySelectorAll('.post-list a'));
});
`);
put('assets/js/notice-banner.js', `// Shows a notice above the article shortly after load.
window.addEventListener('load', function () {
  setTimeout(function () {
    var main = document.getElementById('main');
    var b = document.createElement('div');
    b.className = 'notice-banner';
    b.textContent = 'Surgery two is closed on Friday afternoon for equipment servicing. Please call to rearrange if your appointment is affected.';
    main.insertBefore(b, main.firstChild);
  }, 600);
});
`);
put('assets/js/book-tools.js', `// Exposes appointment booking to in-browser AI agents (WebMCP).
if (navigator.modelContext && navigator.modelContext.registerTool) {
  navigator.modelContext.registerTool({
    name: 'request_appointment',
    description: 'Request a dental appointment at a Harbourline clinic',
    inputSchema: {
      type: 'objekt',
      properties: {
        clinic: { type: 'string', enum: ['Bristol', 'Bath', 'Leeds'] },
        date: { type: 'date' },
      },
      required: 'date',
    },
    execute: async function (input) {
      document.getElementById('b-clinic').value = input.clinic;
      document.getElementById('b-date').value = input.date;
      return { content: [{ type: 'text', text: 'Form filled; press Request appointment to send.' }] };
    },
  });
}
`);

// ================================================================ WRITE
// keep images and favicons (generated separately by images.py)
if (fs.existsSync(SITE)) for (const e of fs.readdirSync(SITE)) if (!['images', 'favicon.png', 'favicon.ico'].includes(e)) fs.rmSync(path.join(SITE, e), { recursive: true, force: true });
for (const [rel, content] of files) {
  const f = path.join(SITE, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

// ids + area order
const areaOrder = ['technical', 'content', 'accessibility', 'ai-access', 'geo', 'agentic'];
defects.sort((a, b) => areaOrder.indexOf(a.area) - areaOrder.indexOf(b.area));
defects.forEach((d, i) => { d.id = `GT-${String(i + 1).padStart(3, '0')}`; });
const ordered = defects.map(({ id, area, type, scope, url, url_prefix, urls, found_on, related_url, description, source, evidence, alt_types, verify }) =>
  Object.fromEntries(Object.entries({ id, area, type, scope, url, url_prefix, urls, found_on, related_url, description, source, evidence, alt_types, verify }).filter(([, v]) => v !== undefined)));
const gt = {
  version: '1.0.0',
  site: 'Harbourline Dental Studio (fictional)',
  origin_placeholder: O,
  notes: [
    'URLs are paths relative to the origin the site is served from (node bench/serve.mjs).',
    'A control page has no page-scope defect. Site-scope defects (robots.txt, llms.txt, sitemaps, /.well-known files, the /services/ firewall rule) apply to the whole origin and are not counted against controls.',
    'found_on is the page that links to the defective URL; tools may legitimately report the defect at either url or found_on. alt_types lists other reasonable names for the same planted problem (or its direct consequence) that should match this defect rather than count as false positives.',
    'The site is served over plain HTTP on localhost. HTTPS, HSTS-over-HTTP and mixed-content findings are environmental and are not planted defects.',
    'verify holds machine-checkable assertions used by bench/verify-ground-truth.mjs.',
  ],
  counts: Object.fromEntries(areaOrder.map((a) => [a, ordered.filter((d) => d.area === a).length])),
  controls,
  defects: ordered,
};
gt.counts.total = ordered.length;
fs.writeFileSync(path.join(BENCH, 'ground-truth.json'), JSON.stringify(gt, null, 2) + '\n');

// GROUND_TRUTH.md
const areaTitle = { technical: 'Technical SEO', content: 'Content and on-page', accessibility: 'Accessibility', 'ai-access': 'AI crawler access', geo: 'AEO / GEO readiness', agentic: 'Agentic web' };
const mdEsc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
let md = `# Ground truth: Harbourline Dental Studio test site

This is the human-readable form of \`bench/ground-truth.json\` (generated from the same source; the JSON is authoritative).

The site at \`bench/site/\` is a fictional UK dental practice served by \`node bench/serve.mjs\`. It has ${pagesMeta.length} HTML pages and **${ordered.length} planted defects**, each defined by a public source. Every defect is placed once. Pages listed under *Controls* carry no page-level defect.

| Area | Defects |
| --- | --- |
${areaOrder.map((a) => `| ${areaTitle[a]} | ${gt.counts[a]} |`).join('\n')}
| **Total** | **${ordered.length}** |

## How matching works

- \`url\` is where the defect is. \`found_on\` (if present) is the page that links to it; a report at either URL counts.
- \`scope: site\` defects live in site-wide files (robots.txt, llms.txt, sitemaps, \`/.well-known/\`) or a site-wide rule (the \`/services/\` firewall rule, \`url_prefix\`).
- \`alt_types\` are other names for the same problem or its direct consequence.
- The site is served over plain HTTP on localhost, so HTTPS/HSTS/mixed-content findings are not planted defects.
- Run \`node bench/verify-ground-truth.mjs\` to check that every defect still manifests.

## Controls

${controls.map((c) => `- \`${c}\``).join('\n')}

`;
for (const a of areaOrder) {
  md += `## ${areaTitle[a]}\n\n| ID | Type | URL | What is wrong | Evidence | Source |\n| --- | --- | --- | --- | --- | --- |\n`;
  for (const d of ordered.filter((x) => x.area === a)) {
    const u = d.urls ? d.urls.map((x) => `\`${x}\``).join(', ') : `\`${d.url}\``;
    const fo = d.found_on ? ` (linked from \`${d.found_on}\`)` : '';
    md += `| ${d.id} | \`${d.type}\` | ${u}${fo} | ${mdEsc(d.description)} | ${mdEsc(d.evidence)} | [link](${d.source}) |\n`;
  }
  md += '\n';
}
fs.writeFileSync(path.join(BENCH, 'GROUND_TRUTH.md'), md);

// QA: titles, descriptions, word counts (pages without a planted defect of that kind should be in range)
const qa = [];
for (const [rel, html] of files) {
  if (!rel.endsWith('.html')) continue;
  const t = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const d = [...html.matchAll(/name="description" content="([^"]*)"/g)].map((m) => m[1]);
  const m = html.match(/<(main|div) id="main">([\s\S]*?)<\/(main|div)>\n<footer/);
  const words = m ? m[2].replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length : -1;
  const flags = [];
  if (t.length !== 1 || t[0].length > 60 || t[0].length < 30) flags.push(`title(${t.map((x) => x.length)})`);
  if (d.length !== 1 || d[0].length > 160 || d[0].length < 70) flags.push(`desc(${d.map((x) => x.length)})`);
  if (words < 300) flags.push(`words(${words})`);
  if (flags.length) qa.push(`${rel}: ${flags.join(' ')}`);
}
console.log(qa.join('\n'));
// report
console.log('pages', pagesMeta.length, 'defects', ordered.length, gt.counts, 'controls', controls.length);
