/**
 * CMS-specific problems: WordPress, Shopify and generic platform defaults.
 */
import type { FetchResult, PageData, SiteContext } from '../core/types.js';
import {
  REF,
  homePage,
  htmlPages,
  indexablePages,
  isHtml200,
  isIndexable,
  list,
  pageCheck,
  pathOf,
  plural,
  safeUrl,
  siteCheck,
  truncate,
} from './_util.js';

export const THIN_ARCHIVE_WORDS = 150;
export const PLUGIN_COUNT_HIGH = 25;
export const PROBE_TIMEOUT_MS = 8000;

const T = 'technical' as const;
const C = 'content' as const;

function isWordPress(site: SiteContext): boolean {
  if (site.stack.id === 'wordpress') return true;
  const home = homePage(site);
  return !!home && /\/wp-content\/|\/wp-includes\//.test(home.html || '');
}

function isShopify(site: SiteContext): boolean {
  if (site.stack.id === 'shopify') return true;
  const home = homePage(site);
  return !!home && /cdn\.shopify\.com|Shopify\.theme/.test(home.html || '');
}

async function probe(site: SiteContext, path: string, follow = false): Promise<FetchResult | null> {
  try {
    return await site.fetcher.fetch(site.origin + path, {
      followRedirects: follow,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: 100_000,
    });
  } catch {
    return null;
  }
}

function wpPage(page: PageData): boolean {
  return (
    /\/wp-content\/|\/wp-includes\/|wp-json/.test(page.html || '') ||
    /wordpress/i.test(page.generator || '')
  );
}

export const checks = [
  // -------------------------------------------------------------------------
  // WordPress
  // -------------------------------------------------------------------------
  siteCheck(
    {
      id: 'cms.wp-version-exposed',
      category: 'cms',
      pillar: T,
      title: 'WordPress version is published',
      why: 'The generator tag and ?ver= query strings tell anyone exactly which WordPress version you run, which makes targeting known vulnerabilities easy.',
      severity: 'low',
      fixTier: 'auto',
      fix: "Remove the generator meta tag (remove_action('wp_head', 'wp_generator') or your security plugin) and keep WordPress updated.",
      refs: ['https://developer.wordpress.org/advanced-administration/security/hardening/'],
    },
    (site) => {
      const home = homePage(site);
      if (!home || !isWordPress(site)) return null;
      const m =
        /<meta[^>]+name=["']?generator["']?[^>]+content=["']WordPress\s*([\d.]+)/i.exec(
          home.html || '',
        ) ?? (/^WordPress\s*([\d.]+)/i.exec(home.generator || '') as RegExpExecArray | null);
      return m
        ? {
            checkId: 'cms.wp-version-exposed',
            url: home.url,
            message: `Generator tag shows WordPress ${m[1]}`,
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'cms.wp-readme-exposed',
      category: 'cms',
      pillar: T,
      title: 'WordPress readme.html is public',
      why: 'The default readme.html confirms the site runs WordPress and, in older versions, its version number.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Delete readme.html and license.txt from the web root (they return after updates; block them at the server instead).',
    },
    async (site) => {
      if (!isWordPress(site)) return null;
      const r = await probe(site, '/readme.html');
      return r && r.status === 200 && /wordpress/i.test(r.body)
        ? { checkId: 'cms.wp-readme-exposed', message: '/readme.html is reachable' }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'cms.wp-xmlrpc-enabled',
      category: 'cms',
      pillar: T,
      title: 'XML-RPC endpoint is enabled',
      why: 'xmlrpc.php is a common target for password-guessing and DDoS amplification. Few sites still need it.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Disable XML-RPC (security plugin or a server rule denying /xmlrpc.php) unless Jetpack or the mobile app needs it.',
      refs: ['https://developer.wordpress.org/advanced-administration/security/hardening/'],
    },
    async (site) => {
      if (!isWordPress(site)) return null;
      const r = await probe(site, '/xmlrpc.php');
      return r &&
        (r.status === 405 || r.status === 200) &&
        /XML-RPC server accepts POST requests only/i.test(r.body)
        ? { checkId: 'cms.wp-xmlrpc-enabled', message: '/xmlrpc.php responds' }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'cms.wp-user-enumeration',
      category: 'cms',
      pillar: T,
      title: 'Usernames can be listed through ?author=',
      why: 'Requesting /?author=1 redirects to /author/<username>/, giving attackers half of a login.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Block ?author= requests for visitors who are not logged in (most security plugins have a switch), and use display names that differ from usernames.',
    },
    async (site) => {
      if (!isWordPress(site)) return null;
      const r = await probe(site, '/?author=1');
      const loc = r?.headers['location'] || '';
      const m = /\/author\/([^/?#]+)/i.exec(loc);
      return r && r.status >= 300 && r.status < 400 && m
        ? {
            checkId: 'cms.wp-user-enumeration',
            message: `/?author=1 redirects to the author archive for "${decodeURIComponent(m[1])}"`,
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'cms.wp-rest-users-exposed',
      category: 'cms',
      pillar: T,
      title: 'REST API lists user accounts',
      why: '/wp-json/wp/v2/users returns usernames (slugs) of everyone who has published, which helps attackers guess logins.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Restrict the users endpoint to authenticated requests (security plugin or a rest_endpoints filter).',
    },
    async (site) => {
      if (!isWordPress(site)) return null;
      const r = await probe(site, '/wp-json/wp/v2/users', true);
      if (!r || r.status !== 200) return null;
      try {
        const users = JSON.parse(r.body) as { slug?: string }[];
        if (!Array.isArray(users) || !users.length || !users[0]?.slug) return null;
        return {
          checkId: 'cms.wp-rest-users-exposed',
          message: `${plural(users.length, 'user')} listed`,
          evidence: list(
            users.map((u) => u.slug || ''),
            4,
          ),
        };
      } catch {
        return null;
      }
    },
  ),
  pageCheck(
    {
      id: 'cms.wp-attachment-page',
      category: 'cms',
      pillar: C,
      title: 'Media attachment pages are indexable',
      why: 'WordPress creates a thin page for every uploaded image. Indexed, they flood the index with near-empty pages.',
      severity: 'medium',
      fixTier: 'auto',
      fix: 'Redirect attachment URLs to the file or parent post (Yoast and Rank Math have a setting; WordPress 6.4+ disables them on new sites).',
    },
    (page) => {
      if (!isIndexable(page) || !wpPage(page)) return null;
      const u = safeUrl(page.url);
      const isAttach =
        u?.searchParams.has('attachment_id') ||
        /\/attachment\//i.test(page.url) ||
        /<body[^>]+class=["'][^"']*\battachment\b/i.test(page.html || '');
      return isAttach
        ? { checkId: 'cms.wp-attachment-page', message: 'Attachment page is indexable' }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'cms.wp-thin-archive',
      category: 'cms',
      pillar: C,
      title: 'Thin tag, author or date archive is indexable',
      why: 'Archives with a handful of excerpts duplicate posts and dilute the site. Tags used once or twice are the worst offenders.',
      severity: 'low',
      fixTier: 'auto',
      fix: 'Noindex tag, date and single-author archives in your SEO plugin, or add a unique introduction to archives you want to rank.',
    },
    (page) => {
      if (!isIndexable(page) || !wpPage(page)) return null;
      const p = pathOf(page.url);
      const type = /\/tag\//.test(p)
        ? 'Tag'
        : /\/author\//.test(p)
          ? 'Author'
          : /^\/\d{4}\/(\d{2}\/)?(\d{2}\/)?$/.test(p)
            ? 'Date'
            : /\/category\//.test(p)
              ? 'Category'
              : null;
      if (!type) return null;
      const words = page.mainText ? page.mainText.split(/\s+/).length : page.wordCount;
      return words < THIN_ARCHIVE_WORDS
        ? {
            checkId: 'cms.wp-thin-archive',
            message: `${type} archive with about ${words} words of content`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'cms.wp-uncategorized',
      category: 'cms',
      pillar: C,
      title: 'Default "Uncategorized" category is in use',
      why: 'Posts left in "Uncategorized" show sloppy structure in URLs, breadcrumbs and archives, and the archive itself is a low-value page.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Rename the default category to something meaningful, or move posts into proper categories and noindex the empty archive.',
    },
    (page) =>
      isIndexable(page) && /\/(category\/)?uncategori[sz]ed\//i.test(page.url)
        ? {
            checkId: 'cms.wp-uncategorized',
            message: 'Uncategorized archive or post URL is indexable',
          }
        : null,
  ),
  pageCheck(
    {
      id: 'cms.wp-default-content',
      category: 'cms',
      pillar: C,
      title: 'WordPress sample content still published',
      why: 'The default "Hello world!" post, "Sample Page" and "Just another WordPress site" tagline make the site look unfinished to people and to quality systems.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Delete the sample post and page and set a real site tagline under Settings → General.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const t = `${page.title || ''} ${page.headings.find((h) => h.level === 1)?.text || ''}`;
      if (/hello world!?/i.test(t) || /\/hello-world\/?$/.test(page.url))
        return {
          checkId: 'cms.wp-default-content',
          message: 'Default "Hello world!" post is live',
        };
      if (/^sample page\b/i.test(page.title || '') || /\/sample-page\/?$/.test(page.url))
        return { checkId: 'cms.wp-default-content', message: 'Default "Sample Page" is live' };
      if (
        /just another wordpress site/i.test(
          `${page.title} ${page.metaDescription} ${page.og['og:description'] || ''}`,
        )
      )
        return {
          checkId: 'cms.wp-default-content',
          message: 'Default tagline "Just another WordPress site" is in use',
        };
      return null;
    },
  ),
  pageCheck(
    {
      id: 'cms.wp-seo-plugin-conflict',
      category: 'cms',
      pillar: T,
      title: 'Two SEO plugins output tags on the same page',
      why: 'When Yoast, Rank Math, All in One SEO or SEOPress run together, pages get duplicate titles, canonicals and schema that contradict each other.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Keep one SEO plugin. Import its settings into the one you keep, then deactivate the other.',
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const found = [
        /yoast seo plugin|yoast-schema-graph/i.test(page.html) && 'Yoast',
        /rank math|rank-math-schema/i.test(page.html) && 'Rank Math',
        /all in one seo|aioseo/i.test(page.html) && 'All in One SEO',
        /seopress/i.test(page.html) && 'SEOPress',
        /the seo framework/i.test(page.html) && 'The SEO Framework',
      ].filter(Boolean) as string[];
      return found.length > 1
        ? { checkId: 'cms.wp-seo-plugin-conflict', message: `${list(found)} both output tags` }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'cms.wp-replytocom',
      category: 'cms',
      pillar: T,
      title: 'Comment reply links create duplicate URLs',
      why: 'Every ?replytocom= link is a crawlable copy of the post. Large comment threads can create thousands of duplicates.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Turn off threaded-comment reply links without JavaScript, or let your SEO plugin strip replytocom.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const n = page.links.filter(
        (l) => l.internal && /[?&]replytocom=/.test(l.href) && !l.rel.includes('nofollow'),
      ).length;
      return n
        ? { checkId: 'cms.wp-replytocom', message: `${plural(n, 'followed replytocom link')}` }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'cms.wp-comment-pages',
      category: 'cms',
      pillar: C,
      title: 'Paginated comment pages are indexable',
      why: '/comment-page-2/ URLs repeat the post with a different slice of comments: duplicate content with little value.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Disable comment pagination (Settings → Discussion) or make sure those URLs canonicalise to the post.',
    },
    (page) =>
      isIndexable(page) && /\/comment-page-\d+\/?/.test(page.url)
        ? { checkId: 'cms.wp-comment-pages', message: 'Comment page is indexable' }
        : null,
  ),
  pageCheck(
    {
      id: 'cms.wp-emoji-script',
      category: 'cms',
      pillar: T,
      title: 'WordPress emoji script is loaded',
      why: 'wp-emoji-release.min.js adds an inline script and request on every page to support emoji in very old browsers.',
      severity: 'info',
      fixTier: 'auto',
      fix: 'Disable it with a performance plugin or by removing the print_emoji_detection_script action.',
    },
    (page) =>
      isHtml200(page) && /wp-emoji-release\.min\.js|_wpemojiSettings/.test(page.html || '')
        ? { checkId: 'cms.wp-emoji-script', message: 'Emoji detection script present' }
        : null,
  ),
  pageCheck(
    {
      id: 'cms.wp-many-plugins',
      category: 'cms',
      pillar: T,
      title: 'Many plugins load assets on the page',
      why: `Assets from more than ${PLUGIN_COUNT_HIGH} plugins on one page usually mean scripts and styles loading where they are not needed, slowing every page.`,
      severity: 'low',
      fixTier: 'manual',
      fix: 'Remove unused plugins and load plugin assets only on the pages that use them (asset manager plugins can do this).',
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const plugins = new Set(
        [...page.html.matchAll(/\/wp-content\/plugins\/([a-z0-9_-]+)\//gi)].map((m) =>
          m[1].toLowerCase(),
        ),
      );
      return plugins.size > PLUGIN_COUNT_HIGH
        ? {
            checkId: 'cms.wp-many-plugins',
            message: `Assets from ${plugins.size} plugins`,
            evidence: list([...plugins], 8),
          }
        : null;
    },
  ),

  // -------------------------------------------------------------------------
  // Shopify
  // -------------------------------------------------------------------------
  siteCheck(
    {
      id: 'cms.shopify-collection-product-urls',
      category: 'cms',
      pillar: T,
      title: 'Product links go through /collections/…/products/',
      why: 'Shopify themes often link to products inside a collection path. Every collection then creates another URL for the same product, canonicalised away, so internal links point at non-canonical URLs.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'In the theme, link products with {{ product.url }} instead of {{ product.url | within: collection }}.',
      refs: [REF.canonical],
    },
    (site) => {
      if (!isShopify(site)) return null;
      const hits = new Set<string>();
      for (const p of htmlPages(site))
        for (const l of p.links)
          if (l.internal && /\/collections\/[^/]+\/products\//.test(l.href)) hits.add(l.href);
      return hits.size
        ? {
            checkId: 'cms.shopify-collection-product-urls',
            message: `${plural(hits.size, 'internal link')} to collection-scoped product URLs`,
            evidence: list([...hits].map(pathOf), 3),
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'cms.shopify-tracking-params',
      category: 'cms',
      pillar: T,
      title: 'Shopify recommendation tracking parameters in links',
      why: 'Links with _pos, _sid, _ss or _psq parameters (from search and recommendations) create crawlable duplicates of product pages.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Make sure these URLs canonicalise to the clean product URL and avoid them in links you control.',
    },
    (site) => {
      if (!isShopify(site)) return null;
      const hits = new Set<string>();
      for (const p of htmlPages(site))
        for (const l of p.links)
          if (l.internal && /[?&](_pos|_sid|_ss|_psq|_fid)=/.test(l.href)) hits.add(l.href);
      return hits.size
        ? {
            checkId: 'cms.shopify-tracking-params',
            message: `${plural(hits.size, 'link')} with Shopify tracking parameters`,
            evidence: list([...hits], 2),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'cms.shopify-vendor-type-pages',
      category: 'cms',
      pillar: C,
      title: 'Automatic vendor or type collection pages are indexable',
      why: '/collections/vendors?q= and /collections/types?q= pages are generated automatically, thin and duplicate.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add a noindex rule for these templates in theme.liquid, or build proper collections instead.',
    },
    (page) =>
      isIndexable(page) && /\/collections\/(vendors|types)\?q=/.test(page.url)
        ? {
            checkId: 'cms.shopify-vendor-type-pages',
            message: 'Automatic vendor/type collection is indexable',
          }
        : null,
  ),

  // -------------------------------------------------------------------------
  // Generic platforms
  // -------------------------------------------------------------------------
  pageCheck(
    {
      id: 'cms.platform-subdomain-links',
      category: 'cms',
      pillar: T,
      title: 'Links or canonicals point to the platform’s default domain',
      why: 'References to *.myshopify.com, *.webflow.io, *.wixsite.com, *.vercel.app and similar build domains send visitors and link signals to a duplicate of your site.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Replace these URLs with your own domain, and make the platform domain redirect to it.',
      refs: [REF.canonical],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const re =
        /(^|\.)(myshopify\.com|webflow\.io|wixsite\.com|squarespace\.com|framer\.(app|website)|vercel\.app|netlify\.app|pages\.dev|herokuapp\.com|wpengine\.com|wpenginepowered\.com|kinsta\.cloud|github\.io|hubspotpagebuilder\.com|carrd\.co)$/i;
      if (re.test(site.host)) return null; // the site itself lives there
      const refs = [page.canonical, page.og['og:url'], ...page.links.map((l) => l.href)].filter(
        (u): u is string => !!u && re.test(safeUrl(u)?.hostname || ''),
      );
      return refs.length
        ? {
            checkId: 'cms.platform-subdomain-links',
            message: `${plural(new Set(refs).size, 'reference')} to a platform default domain`,
            evidence: list([...new Set(refs)], 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'cms.default-title',
      category: 'cms',
      pillar: C,
      title: 'Platform default title or site name',
      why: 'Titles like "My WordPress Website", "My Store", "My Site" or "Squarespace" are platform defaults that were never changed.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Set your real site name in the platform’s general or SEO settings.',
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const t = `${page.title || ''} | ${page.og['og:site_name'] || ''}`;
      const m =
        /\b(my wordpress (website|blog|site)|my store|my site|my website|my blog|site title|welcome to (wix|squarespace|my)|untitled site|new website|wix\.com website builder|powered by squarespace)\b/i.exec(
          t,
        );
      return m
        ? {
            checkId: 'cms.default-title',
            message: `Default site name "${m[0]}"`,
            evidence: truncate(t, 120),
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'cms.search-results-crawlable',
      category: 'cms',
      pillar: T,
      title: 'Internal search pages are linked and crawlable',
      why: 'Links to search result URLs let crawlers generate endless thin pages and can be abused to inject spam text into your domain.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Disallow the search path in robots.txt (for example "Disallow: /?s=" or "Disallow: /search") and add noindex to the search template.',
      refs: [REF.spam],
    },
    (site) => {
      const hits = [...site.pages.values()].filter((p) => {
        const u = safeUrl(p.url);
        return (
          u &&
          (u.searchParams.has('s') || /\/search\b/.test(u.pathname)) &&
          !p.blockedByRobots &&
          p.status === 200
        );
      });
      return hits.length
        ? {
            checkId: 'cms.search-results-crawlable',
            message: `${plural(hits.length, 'search result URL')} crawled`,
            evidence: list(
              hits.map((p) => p.url),
              3,
            ),
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'cms.thin-taxonomy-share',
      category: 'cms',
      pillar: C,
      title: 'Tag and category archives make up much of the index',
      why: 'When indexable archives outnumber real content, the site looks thin overall and crawlers spend their time on lists instead of articles.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Noindex tag archives, merge rarely used tags, and keep only category archives with a written introduction.',
    },
    (site) => {
      const idx = indexablePages(site);
      if (idx.length < 30) return null;
      const arch = idx.filter((p) =>
        /\/(tag|tags|category|categories|topics?)\//.test(pathOf(p.url)),
      );
      return arch.length / idx.length > 0.3
        ? {
            checkId: 'cms.thin-taxonomy-share',
            message: `${arch.length} of ${idx.length} indexable pages are tag or category archives`,
          }
        : null;
    },
  ),
];
