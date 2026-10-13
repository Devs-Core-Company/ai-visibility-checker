/**
 * Detects the site's platform/framework, SEO plugin and host/CDN from markup
 * and response headers. Each rule adds weight; the highest total wins.
 */
import type { PageData, StackId, StackInfo } from '../core/types.js';

interface Rule {
  id: StackId;
  weight: number;
  signal: string;
  test: (ctx: Ctx) => boolean;
}

interface Ctx {
  html: string; // concatenated sample of raw HTML
  headers: Record<string, string>;
  generator: string; // lower-case
  cookies: string;
}

const H = (name: string, re: RegExp) => (c: Ctx) => re.test(c.headers[name] ?? '');
const M = (re: RegExp) => (c: Ctx) => re.test(c.html);
const G = (re: RegExp) => (c: Ctx) => re.test(c.generator);

const RULES: Rule[] = [
  // WordPress
  { id: 'wordpress', weight: 3, signal: 'generator meta: WordPress', test: G(/wordpress/) },
  {
    id: 'wordpress',
    weight: 2,
    signal: '/wp-content/ or /wp-includes/ assets',
    test: M(/\/wp-(content|includes)\//),
  },
  { id: 'wordpress', weight: 2, signal: 'Link header to /wp-json/', test: H('link', /wp-json/) },
  {
    id: 'wordpress',
    weight: 1,
    signal: 'wp-json API link',
    test: M(/rel=["']https:\/\/api\.w\.org\/["']/),
  },
  // Shopify
  {
    id: 'shopify',
    weight: 3,
    signal: 'cdn.shopify.com assets',
    test: M(/cdn\.shopify\.com|\/cdn\/shop\//),
  },
  {
    id: 'shopify',
    weight: 3,
    signal: 'Shopify headers',
    test: (c) =>
      Boolean(c.headers['x-shopid'] || c.headers['x-shopify-stage']) ||
      /shopify/i.test(c.headers['powered-by'] ?? ''),
  },
  {
    id: 'shopify',
    weight: 2,
    signal: 'Shopify.theme object',
    test: M(/Shopify\.theme|window\.Shopify/),
  },
  // Webflow
  { id: 'webflow', weight: 3, signal: 'generator meta: Webflow', test: G(/webflow/) },
  {
    id: 'webflow',
    weight: 2,
    signal: 'data-wf-page / data-wf-site attributes',
    test: M(/data-wf-(page|site)=/),
  },
  {
    id: 'webflow',
    weight: 1,
    signal: 'Webflow CDN assets',
    test: M(/assets\.website-files\.com|uploads-ssl\.webflow\.com|cdn\.prod\.website-files\.com/),
  },
  // Wix
  { id: 'wix', weight: 3, signal: 'generator meta: Wix', test: G(/wix\.com/) },
  {
    id: 'wix',
    weight: 2,
    signal: 'Wix static assets',
    test: M(/static\.wixstatic\.com|static\.parastorage\.com/),
  },
  {
    id: 'wix',
    weight: 2,
    signal: 'x-wix-request-id header',
    test: (c) => Boolean(c.headers['x-wix-request-id']),
  },
  // Squarespace
  {
    id: 'squarespace',
    weight: 3,
    signal: 'Squarespace assets',
    test: M(/static1\.squarespace\.com|assets\.squarespace\.com/),
  },
  {
    id: 'squarespace',
    weight: 2,
    signal: 'Squarespace context',
    test: M(/Static\.SQUARESPACE_CONTEXT|<!-- This is Squarespace\. -->/),
  },
  {
    id: 'squarespace',
    weight: 2,
    signal: 'server: Squarespace',
    test: H('server', /squarespace/i),
  },
  // Ghost
  { id: 'ghost', weight: 3, signal: 'generator meta: Ghost', test: G(/^ghost/) },
  {
    id: 'ghost',
    weight: 2,
    signal: 'Ghost portal / content API',
    test: M(/ghost-(portal|search)|\/ghost\/api\/content\//),
  },
  // Magento / Adobe Commerce
  {
    id: 'magento',
    weight: 3,
    signal: 'Magento static paths or Mage scripts',
    test: M(/\/static\/version\d+\/frontend\/|Mage\.Cookies|data-mage-init|text\/x-magento-init/),
  },
  {
    id: 'magento',
    weight: 2,
    signal: 'X-Magento headers or mage cookies',
    test: (c) =>
      Object.keys(c.headers).some((k) => k.startsWith('x-magento')) ||
      /mage-cache-/.test(c.cookies),
  },
  // Laravel
  {
    id: 'laravel',
    weight: 3,
    signal: 'laravel_session cookie',
    test: (c) => /laravel_session=/.test(c.cookies),
  },
  {
    id: 'laravel',
    weight: 1,
    signal: 'Livewire / Inertia markers',
    test: M(/wire:id=|livewire\.js|data-page="\{&quot;component|@inertia/),
  },
  // Drupal
  { id: 'drupal', weight: 3, signal: 'generator meta: Drupal', test: G(/drupal/) },
  {
    id: 'drupal',
    weight: 2,
    signal: 'x-drupal-cache / x-generator header',
    test: (c) =>
      Boolean(c.headers['x-drupal-cache'] || c.headers['x-drupal-dynamic-cache']) ||
      /drupal/i.test(c.headers['x-generator'] ?? ''),
  },
  {
    id: 'drupal',
    weight: 2,
    signal: 'Drupal settings / sites/default/files',
    test: M(/drupal-settings-json|\/sites\/default\/files\//),
  },
  // Joomla
  { id: 'joomla', weight: 3, signal: 'generator meta: Joomla', test: G(/joomla/) },
  {
    id: 'joomla',
    weight: 1,
    signal: '/media/jui/ or /components/com_ assets',
    test: M(/\/media\/(jui|system)\/js\/|\/components\/com_/),
  },
  // HubSpot
  { id: 'hubspot', weight: 3, signal: 'generator meta: HubSpot', test: G(/hubspot/) },
  {
    id: 'hubspot',
    weight: 2,
    signal: 'HubSpot CMS assets',
    test: M(/\/hs-fs\/hubfs\/|hubspot\.net\/hub\/|\/_hcms\//),
  },
  {
    id: 'hubspot',
    weight: 2,
    signal: 'x-hs-* headers',
    test: (c) => Object.keys(c.headers).some((k) => k.startsWith('x-hs-')),
  },
  // Framer
  { id: 'framer', weight: 3, signal: 'generator meta: Framer', test: G(/framer/) },
  {
    id: 'framer',
    weight: 2,
    signal: 'Framer assets',
    test: M(/framerusercontent\.com|data-framer-/),
  },
  { id: 'framer', weight: 2, signal: 'server: Framer', test: H('server', /framer/i) },
  // Next.js
  {
    id: 'nextjs',
    weight: 3,
    signal: '__NEXT_DATA__ or self.__next_f',
    test: M(/id=["']__NEXT_DATA__["']|self\.__next_f/),
  },
  { id: 'nextjs', weight: 2, signal: '/_next/static/ assets', test: M(/\/_next\/static\//) },
  {
    id: 'nextjs',
    weight: 2,
    signal: 'x-powered-by: Next.js',
    test: H('x-powered-by', /next\.js/i),
  },
  {
    id: 'nextjs',
    weight: 1,
    signal: 'x-nextjs-* header',
    test: (c) => Object.keys(c.headers).some((k) => k.startsWith('x-nextjs-')),
  },
  { id: 'nextjs', weight: 2, signal: 'generator meta: Next.js', test: G(/next\.js/) },
  // Nuxt
  {
    id: 'nuxt',
    weight: 3,
    signal: '__NUXT__ / #__nuxt',
    test: M(/window\.__NUXT__|id=["']__nuxt["']|__NUXT_DATA__/),
  },
  { id: 'nuxt', weight: 2, signal: '/_nuxt/ assets', test: M(/\/_nuxt\//) },
  { id: 'nuxt', weight: 2, signal: 'generator meta: Nuxt', test: G(/nuxt/) },
  // Gatsby
  { id: 'gatsby', weight: 3, signal: '#___gatsby root', test: M(/id=["']___gatsby["']/) },
  { id: 'gatsby', weight: 2, signal: 'generator meta: Gatsby', test: G(/gatsby/) },
  {
    id: 'gatsby',
    weight: 1,
    signal: '/page-data/ references',
    test: M(/\/page-data\/[^"']*page-data\.json/),
  },
  // Astro
  { id: 'astro', weight: 3, signal: 'generator meta: Astro', test: G(/astro/) },
  {
    id: 'astro',
    weight: 2,
    signal: 'astro-island / /_astro/ assets',
    test: M(/<astro-island|\/_astro\/|data-astro-cid-/),
  },
  // SvelteKit
  {
    id: 'sveltekit',
    weight: 3,
    signal: 'SvelteKit bootstrap',
    test: M(/__sveltekit_|data-sveltekit-/),
  },
  { id: 'sveltekit', weight: 2, signal: '/_app/immutable/ assets', test: M(/\/_app\/immutable\//) },
  // Remix / React Router
  {
    id: 'remix',
    weight: 3,
    signal: '__remixContext / __reactRouterContext',
    test: M(/__remixContext|__remixManifest|__reactRouterContext/),
  },
  // Angular
  { id: 'angular', weight: 3, signal: 'ng-version attribute', test: M(/ng-version=/) },
  { id: 'angular', weight: 1, signal: '<app-root>', test: M(/<app-root[\s>]/) },
  // Hugo / Jekyll
  { id: 'hugo', weight: 3, signal: 'generator meta: Hugo', test: G(/hugo/) },
  { id: 'jekyll', weight: 3, signal: 'generator meta: Jekyll', test: G(/jekyll/) },
  { id: 'jekyll', weight: 1, signal: 'Jekyll SEO tag comment', test: M(/Begin Jekyll SEO tag/) },
  // SPAs
  {
    id: 'react-spa',
    weight: 1,
    signal: 'empty #root / #app mount point',
    test: M(/<div id=["'](root|app)["']>\s*<\/div>/),
  },
  {
    id: 'react-spa',
    weight: 1,
    signal: 'React markers',
    test: M(/data-reactroot|react-dom|__REACT_DEVTOOLS/),
  },
  {
    id: 'vue-spa',
    weight: 2,
    signal: 'Vue markers',
    test: M(/data-v-[0-9a-f]{6,}|__VUE__|vue(\.runtime)?(\.global)?(\.prod)?\.js/),
  },
];

const SEO_PLUGINS: { id: string; test: RegExp }[] = [
  {
    id: 'yoast',
    test: /This site is optimized with the Yoast SEO|yoast-schema-graph|class=["']yoast-/i,
  },
  { id: 'rank-math', test: /Rank Math|rank-math-schema|rankmath/i },
  { id: 'aioseo', test: /All in One SEO|aioseo/i },
  { id: 'seopress', test: /SEOPress/i },
  { id: 'the-seo-framework', test: /The SEO Framework/i },
  { id: 'squirrly', test: /Squirrly SEO/i },
  { id: 'next-seo', test: /data-next-seo|next-seo/i },
  { id: 'jekyll-seo-tag', test: /Begin Jekyll SEO tag/i },
  { id: 'nuxt-seo', test: /nuxt-seo|nuxtseo/i },
];

export function detectStack(pages: PageData[], headers: Record<string, string>): StackInfo {
  const html = pages
    .filter((p) => p.isHtml && p.html)
    .slice(0, 5)
    .map((p) => p.html.slice(0, 400_000))
    .join('\n');
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const generators = pages
    .map((p) => p.generator)
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
  const ctx: Ctx = { html, headers: h, generator: generators, cookies: h['set-cookie'] ?? '' };

  const scores = new Map<StackId, { score: number; signals: string[] }>();
  for (const r of RULES) {
    let hit = false;
    try {
      hit = r.test(ctx);
    } catch {
      hit = false;
    }
    if (!hit) continue;
    const s = scores.get(r.id) ?? { score: 0, signals: [] };
    s.score += r.weight;
    s.signals.push(r.signal);
    scores.set(r.id, s);
  }
  // A framework explains React/Vue markers; do not let the SPA rules win alongside one.
  const frameworks: StackId[] = ['nextjs', 'gatsby', 'remix', 'nuxt', 'astro', 'sveltekit'];
  if (frameworks.some((f) => scores.has(f))) {
    scores.delete('react-spa');
    scores.delete('vue-spa');
  }
  // A CMS that happens to use Next/React is still the CMS for fixes (e.g. headless WP is not WP).
  let best: StackId = 'unknown';
  let bestScore = 0;
  for (const [id, s] of scores) {
    if (s.score > bestScore) {
      best = id;
      bestScore = s.score;
    }
  }
  let signals = best !== 'unknown' ? scores.get(best)!.signals : [];
  if (best === 'unknown' && html) {
    const scriptCount = (html.match(/<script\b/gi) ?? []).length;
    const words = pages.find((p) => p.isHtml)?.wordCount ?? 0;
    if (scriptCount <= 3 && words > 0) {
      best = 'static';
      bestScore = 1;
      signals = ['No framework or CMS markers; few scripts'];
    }
  }

  const info: StackInfo = {
    id: best,
    confidence: best === 'unknown' ? 0 : Math.min(1, Math.round((bestScore / 6) * 100) / 100 + 0.2),
    signals,
  };

  const version = versionFor(best, generators, h, html);
  if (version) info.version = version;
  const seo = SEO_PLUGINS.find((p) => p.test.test(html));
  if (seo) info.seoPlugin = seo.id;
  const host = detectHost(h);
  if (host.host) info.host = host.host;
  if (host.cdn) info.cdn = host.cdn;
  return info;
}

function versionFor(
  id: StackId,
  generators: string,
  h: Record<string, string>,
  html: string,
): string | undefined {
  const fromGen = (name: string) =>
    new RegExp(`${name}\\s*v?(\\d+(?:\\.\\d+){0,2})`, 'i').exec(generators)?.[1];
  switch (id) {
    case 'wordpress':
      return (
        fromGen('wordpress') ??
        /ver=(\d+\.\d+(?:\.\d+)?)/.exec(/wp-includes[^"']*ver=\d[^"']*/.exec(html)?.[0] ?? '')?.[1]
      );
    case 'drupal':
      return fromGen('drupal');
    case 'joomla':
      return fromGen('joomla');
    case 'ghost':
      return fromGen('ghost');
    case 'hugo':
      return fromGen('hugo');
    case 'jekyll':
      return fromGen('jekyll');
    case 'astro':
      return fromGen('astro');
    case 'gatsby':
      return fromGen('gatsby');
    case 'nuxt':
      return fromGen('nuxt');
    case 'angular':
      return /ng-version=["']([\d.]+)/.exec(html)?.[1];
    case 'nextjs':
      return fromGen('next\\.js') ?? /next\.js\s*([\d.]+)/i.exec(h['x-powered-by'] ?? '')?.[1];
    default:
      return undefined;
  }
}

/** Hosting platform and CDN from response headers. */
export function detectHost(h: Record<string, string>): { host?: string; cdn?: string } {
  const server = (h.server ?? '').toLowerCase();
  const via = (h.via ?? '').toLowerCase();
  let host: string | undefined;
  let cdn: string | undefined;
  if (h['x-vercel-id'] || h['x-vercel-cache'] || server === 'vercel') {
    host = 'vercel';
    cdn = 'vercel';
  } else if (h['x-nf-request-id'] || server.includes('netlify')) {
    host = 'netlify';
    cdn = 'netlify';
  } else if (h['x-github-request-id'] && server.includes('github')) host = 'github-pages';
  else if (h['fly-request-id'] || server === 'fly/') host = 'fly';
  else if (h['x-render-origin-server'] || server === 'render') host = 'render';
  else if (h['x-railway-request-id'] || server.includes('railway')) host = 'railway';
  else if (h['x-wpe-request-id'] || h['wpe-backend']) host = 'wp-engine';
  else if (h['x-kinsta-cache'] || server.includes('kinsta')) host = 'kinsta';
  else if (h['x-shopid'] || h['x-shopify-stage']) host = 'shopify';
  else if (server.includes('squarespace')) host = 'squarespace';
  else if (h['x-wix-request-id']) host = 'wix';
  else if (
    h['x-amz-cf-id'] ||
    h['x-amz-request-id'] ||
    server.includes('amazons3') ||
    server.includes('awselb')
  )
    host = 'aws';
  else if (server.includes('google frontend') || h['x-cloud-trace-context']) host = 'google-cloud';
  else if (h['x-azure-ref'] || h['x-ms-request-id']) host = 'azure';
  else if (h['cf-ray'] && (h['cf-pages'] || (server === 'cloudflare' && h['x-pages-deployment'])))
    host = 'cloudflare-pages';

  if (!cdn) {
    if (h['cf-ray'] || server === 'cloudflare') cdn = 'cloudflare';
    else if (h['x-amz-cf-id'] || h['x-amz-cf-pop'] || via.includes('cloudfront'))
      cdn = 'cloudfront';
    else if (
      h['x-fastly-request-id'] ||
      (h['x-served-by'] ?? '').includes('cache-') ||
      (via.includes('varnish') && h['x-timer'])
    )
      cdn = 'fastly';
    else if (
      h['x-akamai-transformed'] ||
      h['akamai-grn'] ||
      server.includes('akamai') ||
      h['x-akamai-request-id']
    )
      cdn = 'akamai';
    else if (h['x-azure-ref']) cdn = 'azure-front-door';
    else if (server.includes('bunnycdn') || h['cdn-pullzone']) cdn = 'bunny';
    else if (h['x-sucuri-id']) cdn = 'sucuri';
    else if (h['x-cdn'] && /stackpath|highwinds/i.test(h['x-cdn'])) cdn = 'stackpath';
  }
  return { host, cdn };
}
