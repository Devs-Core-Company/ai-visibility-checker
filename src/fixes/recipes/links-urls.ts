/**
 * Recipes for internal and external links, URL format and parameters, internal search
 * pages and pagination.
 */
import { byStack, seoPluginLabel, templateFile, wpPlugin } from '../stacks.js';
import type { Recipe, RecipeInput, StackFix } from '../types.js';
import { evidenceStep, serverFix, urlsBlock, verifyStep } from './common.js';

// ---------------------------------------------------------------------------
// Internal link graph (content work)
// ---------------------------------------------------------------------------

function relatedLinksFix(input: RecipeInput): StackFix {
  return byStack(input, {
    'nextjs-app': () => ({
      steps: [
        'Add a server-rendered “Related” block to the article/product template that links to pages in the same topic, and link hub pages to every page they summarise.',
        'Add breadcrumbs (with BreadcrumbList JSON-LD) so every page links back up to its section.',
      ],
      files: ['app/<section>/[slug]/page.tsx', 'components/related-links.tsx'],
      snippet: {
        language: 'tsx',
        code: `// components/related-links.tsx (Server Component)
import Link from 'next/link';

export async function RelatedLinks({ topic, current }: { topic: string; current: string }) {
  const pages = (await getPagesByTopic(topic)).filter((p) => p.slug !== current).slice(0, 5);
  return (
    <nav aria-label="Related">
      <h2>Related guides</h2>
      <ul>
        {pages.map((p) => (
          <li key={p.slug}><Link href={p.url}>{p.title}</Link></li>
        ))}
      </ul>
    </nav>
  );
}`,
      },
    }),
    wordpress: () => ({
      steps: [
        'Edit related posts and add links in the body text (the block editor’s link search finds pages by title). Yoast Premium and Rank Math suggest internal links while you write; Link Whisper does it in bulk.',
        'Turn on breadcrumbs in your SEO plugin and show them in the theme, and use category pages with a written introduction as hubs.',
      ],
      files: ['WordPress editor', `${seoPluginLabel(input.stack)} breadcrumbs`],
    }),
    shopify: () => ({
      steps: [
        'Link products from collection descriptions and blog articles; add a “Related products” / “Complementary products” block (Search & Discovery app) to the product template.',
        'Use Online Store → Navigation to put important collections in the main menu, and show breadcrumbs in the theme.',
      ],
      files: ['sections/main-product.liquid', 'Navigation menus', 'collection descriptions'],
    }),
    hosted: () => ({
      steps: [
        'Add text links from related pages, a “related” section at the end of articles, and a hub page per topic in the site editor (CMS collection lists work well for this).',
      ],
      files: ['Site editor', 'CMS collection templates'],
    }),
    unknown: () => ({
      steps: [
        `Add contextual links from related pages and from a hub page per topic, plus breadcrumbs, in ${templateFile(input)}.`,
      ],
      files: [templateFile(input)],
    }),
  });
}

const linkGraph: Recipe = {
  id: 'internal-link-graph',
  patterns: [
    /^crawlability\.deep-page$/,
    /^links-internal\.(single-inlink|low-link-score|orphan|navigation-only|concentration|too-many)$/,
  ],
  impact: 'medium',
  effort: 'hours',
  tier: 'manual',
  build(input) {
    const id = input.def.id;
    const lead: Record<string, [string, string]> = {
      'crawlability.deep-page': [
        'Bring deep pages closer to the home page',
        'These pages are many clicks from the home page. Link to them from a hub, category page or the main navigation so each is within three or four clicks.',
      ],
      'links-internal.single-inlink': [
        'Add more internal links to weakly linked pages',
        'Each of these pages is reachable through a single link. Add two or three contextual links from related pages.',
      ],
      'links-internal.low-link-score': [
        'Strengthen pages with weak internal links',
        'These pages are in the bottom tenth of your internal link graph. Link to them from strong pages (home, hubs, popular articles) where it helps the reader.',
      ],
      'links-internal.orphan': [
        'Link to orphan pages (or retire them)',
        'These URLs are in the sitemap but no page links to them. For each: link to it from the right hub or related page, or — if it is obsolete — remove it from the sitemap and redirect or delete it.',
      ],
      'links-internal.navigation-only': [
        'Add contextual links, not just menu links',
        'These pages are linked only from menus and footers. Link to them from relevant paragraphs on related pages with descriptive anchor text, which tells crawlers what they are about.',
      ],
      'links-internal.concentration': [
        'Spread internal links beyond a few pages',
        'Nearly all internal links point at a small set of pages. Add links between related deep pages and from hubs to the pages they summarise.',
      ],
      'links-internal.too-many': [
        'Trim pages with hundreds of links',
        'These pages carry so many links that each passes little value and the important ones are hard to spot. Trim mega-menus and footers, group long lists onto hub pages, and keep the most important links in the main content.',
      ],
    };
    const [title, text] = lead[id] ?? [input.def.title, input.def.fix];
    const f = relatedLinksFix(input);
    return {
      ...f,
      title,
      steps: [
        text,
        ...f.steps,
        ...urlsBlock(input),
        'Re-run the audit after publishing: the internal link score and click depth are recalculated from the crawl.',
      ],
    };
  },
};

const anchors: Recipe = {
  id: 'anchor-text',
  patterns: [/^links-internal\.(generic-anchors|long-anchor)$/],
  impact: 'low',
  effort: 'hours',
  tier: 'manual',
  build(input) {
    const long = input.def.id.endsWith('long-anchor');
    const where = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          long
            ? 'For card components, link the title only (and make the whole card clickable with CSS: a `::after` pseudo-element on the link stretched over the card).'
            : 'In card and CTA components, use the item title as the link text, or keep “Read more” visible and add the title for screen readers.',
        ],
        files: ['components/card.tsx', 'components/cta.tsx'],
        snippet: {
          language: 'tsx',
          code: long
            ? `<article className="relative">
  <h3><Link href={post.url} className="after:absolute after:inset-0">{post.title}</Link></h3>
  <p>{post.excerpt}</p>
</article>`
            : `<Link href={post.url}>
  Read more<span className="sr-only"> about {post.title}</span>
</Link>`,
        },
      }),
      wordpress: () => ({
        steps: [
          'Edit the links in the block editor. For theme “Read more” links, change the excerpt link via the `excerpt_more` filter so it includes the post title.',
        ],
        files: ['WordPress editor', 'functions.php (child theme)'],
        snippet: {
          language: 'php',
          code: `add_filter('excerpt_more', function () {
  return sprintf(' <a href="%s">Read more<span class="screen-reader-text"> about %s</span></a>',
    esc_url(get_permalink()), esc_html(get_the_title()));
});`,
        },
      }),
      shopify: () => ({
        steps: [
          'Edit link text in pages, articles and collection descriptions; in theme sections, use the product or article title as the link text instead of a static “Shop now”.',
        ],
        files: ['sections/*.liquid', 'content editor'],
      }),
      unknown: () => ({
        steps: [
          long
            ? 'Wrap only the title in the link, not the whole card or paragraph.'
            : 'Rewrite each link so its text names the destination, e.g. “pricing for small teams” instead of “click here”.',
        ],
        files: [templateFile(input)],
      }),
    });
    return {
      ...where,
      title: long ? 'Shorten very long anchor text' : 'Replace generic anchor text',
      steps: [
        long
          ? 'Anchors that wrap whole paragraphs or cards dilute what the link is about and are tiring for screen-reader users. Keep anchor text under about 120 characters.'
          : 'Anchors such as “click here”, “read more” or “learn more” tell crawlers and screen-reader users nothing about the target.',
        ...evidenceStep(input),
        ...where.steps,
        ...urlsBlock(input),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Link targets that need replacing (search and replace work)
// ---------------------------------------------------------------------------

function searchReplaceFix(input: RecipeInput, from: string, to: string): StackFix {
  return byStack(input, {
    wordpress: () => ({
      steps: [
        'Back up the database, then run a search-and-replace across posts, meta and options with WP-CLI (below) or the Better Search Replace plugin (dry run first).',
        'Check menus (Appearance → Menus), widgets and page-builder templates, which store links separately.',
      ],
      files: ['WordPress database (WP-CLI / Better Search Replace)', 'Appearance → Menus'],
      snippet: {
        language: 'bash',
        code: `wp search-replace '${from}' '${to}' --all-tables --precise --dry-run\n# then without --dry-run`,
      },
    }),
    shopify: () => ({
      steps: [
        'Search the theme code (Online Store → Themes → Edit code, search box) and fix hard-coded links; use `{{ routes.* }}` and `{{ product.url }}` rather than full URLs.',
        'Check navigation menus, pages, blog articles and product descriptions in the admin.',
      ],
      files: ['theme code', 'Online Store → Navigation', 'pages / articles / products'],
    }),
    hosted: () => ({
      steps: [
        'Update the links in the site editor and CMS items; check the navigation, footer and buttons, which hold links separately from text.',
      ],
      files: ['Site editor', 'CMS items'],
    }),
    unknown: () => ({
      steps: [
        'Search the code and content files for the old form and replace it (below). For content stored in a CMS or database, use its search-and-replace.',
      ],
      files: [templateFile(input), 'content files / CMS'],
      snippet: {
        language: 'bash',
        code: `grep -rn '${from}' src content public --include='*.{html,md,mdx,tsx,jsx,astro,vue,svelte,liquid,njk}'\n# review, then replace, e.g.\ngrep -rl '${from}' src content | xargs sed -i 's#${from}#${to}#g'`,
      },
    }),
  });
}

const linkTargets: Recipe = {
  id: 'link-targets',
  patterns: [
    /^links-internal\.(to-canonicalised|insecure|missing-protocol)$/,
    /^links-external\.(redirecting|insecure|dev-host)$/,
    /^cms\.platform-subdomain-links$/,
  ],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const id = input.def.id;
    const host = input.host;
    let title = input.def.title;
    let lead = input.def.fix;
    let from = 'http://' + host;
    let to = 'https://' + host;
    if (id === 'links-internal.insecure') {
      title = 'Link to https:// (or root-relative) URLs';
      lead =
        'Internal links use http://, so every click goes through a redirect. Change them to https:// or to root-relative paths (`/page`).';
    } else if (id === 'links-internal.missing-protocol') {
      title = 'Add https:// to links written without it';
      lead =
        'Links such as `href="www.example.com"` have no protocol, so browsers treat them as paths on your own site and they break. Add `https://` to each.';
      from = 'href="www.';
      to = 'href="https://www.';
    } else if (id === 'links-internal.to-canonicalised') {
      title = 'Link to canonical URLs';
      lead =
        'These links point at URLs whose canonical is a different URL (often a trailing-slash, case or parameter variant). Link to the canonical URL directly so links and canonicals agree.';
      from = '<non-canonical URL>';
      to = '<canonical URL>';
    } else if (id === 'links-external.redirecting') {
      title = 'Update outbound links that redirect';
      lead =
        'These outbound links redirect, often because the page moved. Update each to its final URL, and check it still says what you meant to cite.';
      from = '<old URL>';
      to = '<final URL>';
    } else if (id === 'links-external.insecure') {
      title = 'Switch outbound links to https://';
      lead =
        'Open each http:// link with https:// instead; if it loads the same page, update the link. If the site has no HTTPS, consider whether the link is still worth keeping.';
      from = 'http://';
      to = 'https://';
    } else if (id === 'links-external.dev-host') {
      title = 'Replace localhost and private-network links';
      lead =
        'Links to localhost, private IPs or .local hosts are leftovers from development and broken for everyone else. Replace them with the live URLs — usually one search-and-replace.';
      from = 'http://localhost:3000';
      to = input.origin;
    } else if (id === 'cms.platform-subdomain-links') {
      title = 'Use your own domain, not the platform’s build domain';
      lead = `Links or canonicals point at the platform’s default domain (*.myshopify.com, *.webflow.io, *.wixsite.com, *.vercel.app…). Replace them with ${input.origin}, and make the platform domain redirect to yours.`;
      from = '<platform-domain>';
      to = input.origin;
    }
    const f = searchReplaceFix(input, from, to);
    const platform =
      id === 'cms.platform-subdomain-links'
        ? byStack(input, {
            shopify: () => ({
              steps: [
                'Settings → Domains: set your own domain as primary, so the myshopify.com address redirects to it.',
              ],
              files: ['Shopify: Settings → Domains'],
            }),
            webflow: () => ({
              steps: [
                'Site settings → Publishing: set your custom domain as default (the webflow.io subdomain then redirects), or disable the webflow.io subdomain.',
              ],
              files: ['Webflow: Site settings → Publishing'],
            }),
            nextjs: () => ({
              steps: [
                'Vercel: Settings → Domains → add a redirect from the `*.vercel.app` production domain to your domain, and set `metadataBase` to your domain so canonicals use it.',
              ],
              files: ['Vercel: Settings → Domains', 'app/layout.tsx (metadataBase)'],
            }),
            unknown: () => ({
              steps: [
                'In the platform’s domain settings make your domain primary so the default domain redirects to it, and make canonicals and sitemaps use your domain.',
              ],
              files: ['Platform domain settings'],
            }),
          })
        : null;
    return {
      ...f,
      title,
      steps: [
        lead,
        ...evidenceStep(input),
        ...(platform?.steps ?? []),
        ...f.steps,
        ...urlsBlock(input, 10, 'Pages with these links'),
        verifyStep(input),
      ],
      files: [...new Set([...(platform?.files ?? []), ...f.files])],
    };
  },
};

// ---------------------------------------------------------------------------
// rel attributes on links
// ---------------------------------------------------------------------------

const linkRel: Recipe = {
  id: 'link-rel',
  patterns: [
    /^links-internal\.nofollow$/,
    /^links-external\.(sponsored-unqualified|noopener|too-many)$/,
  ],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    const id = input.def.id;
    const kind = id.endsWith('nofollow')
      ? 'nofollow'
      : id.endsWith('sponsored-unqualified')
        ? 'sponsored'
        : id.endsWith('noopener')
          ? 'noopener'
          : 'too-many';
    const plugin = wpPlugin(input.stack);
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          kind === 'nofollow'
            ? 'Remove `rel="nofollow"` from internal `<Link>`s (search the components for `nofollow`).'
            : 'Use one link component for outbound links that sets `rel` correctly, and use it in MDX/CMS rendering too.',
        ],
        files: ['components/external-link.tsx', 'mdx-components.tsx'],
        snippet: {
          language: 'tsx',
          code: `// components/external-link.tsx
export function ExternalLink({ href, sponsored, newTab, children }: {
  href: string; sponsored?: boolean; newTab?: boolean; children: React.ReactNode;
}) {
  const rel = [sponsored && 'sponsored', newTab && 'noopener noreferrer'].filter(Boolean).join(' ');
  return (
    <a href={href} rel={rel || undefined} target={newTab ? '_blank' : undefined}>
      {children}
    </a>
  );
}`,
        },
      }),
      wordpress: () => ({
        steps: [
          kind === 'nofollow'
            ? 'Find what adds nofollow to your own links: an SEO plugin option (“nofollow internal links”), a page builder setting, or links pasted with rel attributes. Remove it.'
            : kind === 'sponsored'
              ? plugin === 'rank-math' || plugin === 'aioseo'
                ? `In the block editor link popover, ${seoPluginLabel(input.stack)} adds a “Sponsored” toggle: switch it on for each affiliate link. Affiliate plugins (ThirstyAffiliates, Pretty Links) can add rel="sponsored" to all their links globally.`
                : 'Use an affiliate link plugin (ThirstyAffiliates, Pretty Links) set to add rel="sponsored" globally, or edit each link’s HTML (Edit as HTML) to add it.'
              : kind === 'noopener'
                ? 'WordPress adds rel="noopener" to target="_blank" links saved in the editor since 5.1. Links in widgets, page-builder modules or theme templates may lack it: fix them there, or use the filter below.'
                : 'Edit the page and keep only outbound links that support the content.',
        ],
        files: ['WordPress editor', 'functions.php (child theme)'],
        snippet:
          kind === 'noopener' || kind === 'sponsored'
            ? {
                language: 'php',
                code: `// functions.php: add rel to target="_blank" links in post content
add_filter('the_content', function ($html) {
  return preg_replace_callback('/<a\\s[^>]*target="_blank"[^>]*>/i', function ($m) {
    $tag = $m[0];
    if (stripos($tag, 'rel=') === false) return str_replace('<a ', '<a rel="noopener noreferrer" ', $tag);
    return $tag;
  }, $html);
});`,
              }
            : undefined,
      }),
      shopify: () => ({
        steps: [
          'Edit links in the rich-text editor (Insert link → “Open this link in a new window” adds target; add rel by editing the HTML with the <> button). Fix hard-coded links in theme sections.',
        ],
        files: ['content editor (HTML view)', 'sections/*.liquid'],
      }),
      unknown: () => ({
        steps: ['Update the links in templates and content:'],
        files: [templateFile(input)],
        snippet: {
          language: 'html',
          code:
            kind === 'nofollow'
              ? '<!-- internal links: no rel="nofollow" -->\n<a href="/pricing/">Pricing</a>'
              : kind === 'sponsored'
                ? '<a href="https://partner.example/?ref=you" rel="sponsored">Partner product</a>'
                : '<a href="https://example.org/" target="_blank" rel="noopener noreferrer">Source</a>',
        },
      }),
    });
    const lead = {
      nofollow:
        'rel="nofollow" on your own links stops crawlers following them and does not save link value for other pages. Remove it; if a target should stay out of search, put noindex on that page instead.',
      sponsored:
        'Affiliate and paid links must carry rel="sponsored" (or nofollow). Unmarked ones can be treated as a link scheme.',
      noopener: 'Add rel="noopener" (or "noopener noreferrer") to every link with target="_blank".',
      'too-many':
        'The page has hundreds of outbound links, which makes it look like a link directory. Keep the ones that support the content, and move long resource lists to a dedicated page.',
    }[kind];
    return {
      ...fix,
      title: {
        nofollow: 'Remove nofollow from internal links',
        sponsored: 'Mark affiliate links rel="sponsored"',
        noopener: 'Add rel="noopener" to new-tab links',
        'too-many': 'Cut back outbound links',
      }[kind],
      steps: [lead, ...evidenceStep(input), ...fix.steps, ...urlsBlock(input), verifyStep(input)],
    };
  },
};

// ---------------------------------------------------------------------------
// Links crawlers cannot follow
// ---------------------------------------------------------------------------

const crawlableLinks: Recipe = {
  id: 'crawlable-links',
  patterns: [/^links-internal\.(uncrawlable|hashbang)$/, /^pagination\.(load-more-only|fragment)$/],
  impact: 'high',
  effort: 'hours',
  build(input) {
    const id = input.def.id;
    const pagination = id.startsWith('pagination.');
    const hash = id.endsWith('hashbang') || id.endsWith('fragment');
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          pagination
            ? 'Render real page links (`<Link href="?page=2">`) under the list on the server; the “Load more” button can fetch the next page client-side and update the URL with `router.push`.'
            : 'Use `<Link href>` for navigation and `<button>` for actions. Replace `onClick={() => router.push(…)}` on divs, and `href="#"` / `javascript:` links.',
        ],
        files: ['app/<listing>/page.tsx', 'components/*'],
        snippet: {
          language: 'tsx',
          code: pagination
            ? `// app/blog/page.tsx — searchParams.page drives the server-rendered list
<nav aria-label="Pagination">
  {page > 1 && <Link href={page === 2 ? '/blog' : \`/blog?page=\${page - 1}\`}>Previous</Link>}
  {page < totalPages && <Link href={\`/blog?page=\${page + 1}\`}>Next</Link>}
</nav>`
            : `// before: <div onClick={() => router.push('/pricing')}>Pricing</div>
<Link href="/pricing">Pricing</Link>`,
        },
      }),
      spa: () => ({
        steps: [
          hash
            ? 'Switch the router to history mode: React Router `createBrowserRouter` (not `createHashRouter`), Vue Router `createWebHistory()`, Angular `provideRouter(routes)` without `withHashLocation()`. Configure the host to serve index.html for unknown paths, then prerender routes so each has its own HTML.'
            : 'Use the router’s link component (`<Link to>`, `<RouterLink to>`, `routerLink`) so every navigation is an `<a href>`.',
        ],
        files: ['router setup (main.ts / router.ts)', 'host rewrite config'],
        snippet: {
          language: 'ts',
          code: `// Vue: history mode instead of hash mode
import { createRouter, createWebHistory } from 'vue-router';
export const router = createRouter({ history: createWebHistory(), routes });`,
        },
      }),
      wordpress: () => ({
        steps: [
          pagination
            ? 'If an infinite-scroll or “load more” plugin replaced the theme’s numbered pagination, set it to keep the paginated links in the HTML (most have a “keep pagination for SEO / fallback” option) or switch back to numbered pagination.'
            : 'Find page-builder buttons or menu items set to “custom link #” with JavaScript actions and give them real URLs.',
        ],
        files: ['theme pagination / infinite-scroll plugin', 'page builder'],
      }),
      shopify: () => ({
        steps: [
          pagination
            ? 'Keep `{% paginate %}` with `{{ paginate | default_pagination }}` links in the collection template; an infinite-scroll app should enhance those links, not replace them.'
            : 'Replace `<div onclick>` and `href="#"` navigation in theme sections with `<a href="{{ … .url }}">`.',
        ],
        files: ['sections/main-collection-product-grid.liquid'],
        snippet: pagination
          ? {
              language: 'liquid',
              code: `{% paginate collection.products by 24 %}\n  …product grid…\n  {{ paginate | default_pagination }}\n{% endpaginate %}`,
            }
          : undefined,
      }),
      unknown: () => ({
        steps: [
          pagination
            ? hash
              ? 'Use query parameters (`?page=2`) or paths (`/page/2/`) for each page of the series; fragments (`#page=2`) are ignored by crawlers.'
              : 'Back the “Load more” button with real `<a href="?page=2">` links in the HTML; JavaScript can intercept the click and append items.'
            : hash
              ? 'Give every view its own path (`/products/blue-shirt`) and render it on the server; `#!/` and `#/` routes are all one URL to crawlers.'
              : 'Use `<a href="/real-url">` for navigation and `<button>` for actions.',
        ],
        files: [templateFile(input)],
        snippet: {
          language: 'html',
          code: pagination
            ? '<nav aria-label="Pagination">\n  <a href="/blog/?page=2" class="load-more">Load more</a>\n</nav>\n<script>/* intercept the click, fetch ?page=2, append the items, update the href to ?page=3 */</script>'
            : '<!-- before: <span onclick="location=\'/pricing\'">Pricing</span> -->\n<a href="/pricing/">Pricing</a>',
        },
      }),
    });
    return {
      ...fix,
      title: pagination
        ? hash
          ? 'Use real URLs for paginated pages'
          : 'Back “load more” with page links'
        : hash
          ? 'Replace #! routes with real paths'
          : 'Make navigation crawlable <a href> links',
      steps: [
        'Google, Bing and AI crawlers only follow `<a>` elements with a real href, and ignore everything after `#`.',
        ...evidenceStep(input),
        ...fix.steps,
        ...urlsBlock(input),
        verifyStep(input),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// URL format
// ---------------------------------------------------------------------------

const URL_TITLES: Record<string, string> = {
  uppercase: 'Use lower-case URLs',
  'case-duplicates': 'Redirect mixed-case URL duplicates',
  underscores: 'Use hyphens, not underscores, in URLs',
  'too-long': 'Keep URLs short',
  'unsafe-characters': 'Remove spaces and unsafe characters from URLs',
  'double-slash': 'Fix double slashes in URLs',
  'repeated-segment': 'Fix relative links that repeat folders',
  'deep-path': 'Flatten deeply nested URLs',
  'non-descriptive': 'Use readable URL slugs',
  'trailing-slash-mixed': 'Use one trailing-slash convention',
};

const urlFormat: Recipe = {
  id: 'url-format',
  patterns: [
    /^urls\.(uppercase|underscores|too-long|unsafe-characters|double-slash|repeated-segment|deep-path|non-descriptive|case-duplicates|trailing-slash-mixed)$/,
  ],
  impact: 'low',
  effort: 'hours',
  build(input) {
    const id = input.def.id.replace('urls.', '');
    const caseRule = id === 'uppercase' || id === 'case-duplicates';
    const lead: Record<string, string> = {
      uppercase:
        'Use lower-case URLs and 301-redirect upper-case variants to them, so links in any case end up on one URL.',
      'case-duplicates':
        'Two URLs differ only by letter case. 301-redirect the mixed-case one to the lower-case one and correct the links that produced it.',
      underscores:
        'Use hyphens between words in new URLs. Changing existing URLs costs a redirect each; do it only for important pages, or when you are restructuring anyway.',
      'too-long':
        'Keep new URLs short and readable (under about 115 characters): drop stop words, dates and repeated words from slugs.',
      'unsafe-characters':
        'Use only lower-case letters, numbers and hyphens in paths. Rename slugs with spaces, commas, quotes or brackets and 301 the old URLs.',
      'double-slash':
        'A `//` in the path usually comes from joining a base URL ending in `/` with a path starting with `/`. Fix the link template and redirect `//` URLs to the single-slash version.',
      'repeated-segment':
        'Paths like /blog/blog/ come from relative links (`href="blog/post"`) resolving against the current folder. Use root-relative (`/blog/post`) or absolute links in templates.',
      'deep-path':
        'Keep new URLs within about five folder levels. Existing deep URLs are fine to keep unless you are restructuring.',
      'non-descriptive':
        'Use readable slugs (for example /services/seo-audit/) and 301 the ID URLs (?p=123, /node/456) to them.',
      'trailing-slash-mixed':
        'Pick one convention for page URLs (with or without the trailing slash), enforce it with 301 redirects, and make links, canonicals and the sitemap use it.',
    };
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          id === 'trailing-slash-mixed'
            ? 'Set `trailingSlash` in `next.config.ts` (true or false) — Next.js then 308-redirects the other form — and make internal links match.'
            : caseRule || id === 'double-slash'
              ? 'Normalise URLs in `proxy.ts` (`middleware.ts` before Next.js 16) with a permanent redirect.'
              : 'Change the slug in your content source and add a permanent redirect from the old path in `next.config.ts`.',
        ],
        files: ['next.config.ts', 'proxy.ts'],
        snippet: {
          language: 'ts',
          code:
            id === 'trailing-slash-mixed'
              ? `// next.config.ts\nconst nextConfig: NextConfig = { trailingSlash: false };`
              : caseRule || id === 'double-slash'
                ? `// proxy.ts
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const clean = pathname.replace(/\\/{2,}/g, '/').toLowerCase();
  if (clean !== pathname) {
    const url = req.nextUrl.clone();
    url.pathname = clean;
    return NextResponse.redirect(url, 308);
  }
}

export const config = { matcher: ['/((?!_next/|api/).*)'] };`
                : `// next.config.ts
async redirects() {
  return [{ source: '/Old_Path', destination: '/old-path', permanent: true }];
},`,
        },
      }),
      wordpress: () => ({
        steps: [
          id === 'non-descriptive'
            ? 'Settings → Permalinks: choose “Post name” (`/%postname%/`). WordPress redirects the old ?p= URLs itself.'
            : id === 'trailing-slash-mixed'
              ? 'Settings → Permalinks: the structure decides the trailing slash (ending in `/` adds it). WordPress redirects the other form; fix hard-coded links that use the wrong one.'
              : 'Edit the slug in the post’s settings (URL / Permalink field). WordPress keeps a redirect from the old slug for posts; add one in your redirect manager for pages.',
          caseRule
            ? 'WordPress lower-cases slugs, so upper-case URLs come from links: fix them, and add a lower-case redirect at the server (below) if needed.'
            : `Add 301s for renamed URLs in ${wpPlugin(input.stack) === 'rank-math' ? 'Rank Math → Redirections' : 'the Redirection plugin'}.`,
        ],
        files: ['Settings → Permalinks', 'post slug', 'redirect manager'],
      }),
      shopify: () => ({
        steps: [
          'Edit the URL handle in the product, collection or page “Search engine listing” section and keep “Create a URL redirect” ticked.',
          'Shopify fixes the folder structure (/products/, /collections/, /pages/), so depth and trailing slashes are not configurable.',
        ],
        files: ['Shopify admin: Search engine listing → URL handle'],
      }),
      hosted: () => ({
        steps: [
          'Change the page slug in its SEO / page settings and add a 301 from the old URL in the redirects settings.',
        ],
        files: ['Page settings → slug', 'Site settings → Redirects'],
      }),
      unknown: (i) =>
        caseRule || id === 'double-slash' || id === 'trailing-slash-mixed'
          ? serverFix(i, {
              nginx:
                id === 'trailing-slash-mixed'
                  ? `# remove the trailing slash from page URLs (not from /)
rewrite ^/(.+)/$ /$1 permanent;`
                  : id === 'double-slash'
                    ? `# collapse repeated slashes (merge_slashes is on by default; redirect instead of silently merging)
merge_slashes off;
if ($request_uri ~ "//") { rewrite ^(.*)$ $1 permanent; }`
                    : `# nginx has no built-in lower-casing; with the perl module (http block):
perl_set $uri_lowercase 'sub { my $r = shift; return lc($r->uri); }';

# server block
location ~ [A-Z] {
    return 301 $scheme://$host$uri_lowercase$is_args$args;
}`,
              apache:
                id === 'trailing-slash-mixed'
                  ? `# .htaccess: remove the trailing slash from non-folders
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule ^(.+)/$ /$1 [R=301,L]`
                  : id === 'double-slash'
                    ? `# .htaccess
RewriteEngine On
RewriteCond %{THE_REQUEST} \\s[^?]*//
RewriteRule ^(.*)$ /$1 [R=301,L,NE]`
                    : `# vhost config (RewriteMap is not allowed in .htaccess)
RewriteMap lc int:tolower
RewriteCond %{REQUEST_URI} [A-Z]
RewriteRule (.*) \${lc:$1} [R=301,L]`,
              vercel:
                id === 'trailing-slash-mixed'
                  ? '{ "trailingSlash": false }'
                  : `{
  "redirects": [{ "source": "/Old-Path", "destination": "/old-path", "permanent": true }]
}`,
              netlify:
                id === 'trailing-slash-mixed'
                  ? '# Netlify: Site configuration → Build & deploy → Post processing → Pretty URLs controls the trailing slash'
                  : '# _redirects\n/Old-Path  /old-path  301!',
              cloudflare: `Rules → Redirect Rules → Create rule (dynamic)
  If: ${
    id === 'trailing-slash-mixed'
      ? '(ends_with(http.request.uri.path, "/") and http.request.uri.path ne "/")'
      : id === 'double-slash'
        ? '(http.request.uri.path contains "//")'
        : '(lower(http.request.uri.path) ne http.request.uri.path)'
  }
  URL: ${
    id === 'trailing-slash-mixed'
      ? 'regex_replace(http.request.uri.path, "/$", "")'
      : id === 'double-slash'
        ? 'regex_replace(http.request.uri.path, "/{2,}", "/")'
        : 'lower(http.request.uri.path)'
  } → 301, preserve query string`,
            })
          : {
              steps: [
                'Rename the file or route, update every link to it, and add a 301 from the old URL on the server or host (`Redirect 301 /Old_Path /old-path` in .htaccess, `location = /Old_Path { return 301 /old-path; }` in nginx).',
              ],
              files: [templateFile(i), '.htaccess / nginx / _redirects / vercel.json'],
            },
    });
    return {
      ...fix,
      title: URL_TITLES[id] ?? input.def.title,
      steps: [
        lead[id] ?? input.def.fix,
        ...evidenceStep(input),
        ...fix.steps,
        'Update internal links, canonicals and the sitemap to the new form so they do not rely on the redirect.',
        ...urlsBlock(input),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Parameters: tracking, sessions, filters
// ---------------------------------------------------------------------------

const urlParams: Recipe = {
  id: 'url-parameters',
  patterns: [
    /^urls\.(session-id|tracking-parameters|many-parameters)$/,
    /^links-internal\.tracking-parameters$/,
    /^cms\.shopify-tracking-params$/,
  ],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const id = input.def.id;
    const linkSide = id.startsWith('links-internal.');
    const session = id.endsWith('session-id');
    const filters = id.endsWith('many-parameters');
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Set a canonical without query parameters in `generateMetadata` for every page, so `?utm_…`, `?gclid=` and filter variants point at the clean URL.',
          session
            ? 'Keep session state in cookies (`cookies()` from `next/headers`), never in the URL.'
            : 'Remove tracking parameters from internal `<Link>`s; track internal campaigns with analytics events instead.',
        ],
        files: ['app/<route>/page.tsx (metadata)', 'components/*'],
        snippet: {
          language: 'ts',
          code: `export async function generateMetadata({ params }): Promise<Metadata> {
  const { slug } = await params;
  return { alternates: { canonical: \`/products/\${slug}\` } }; // no query string
}`,
        },
      }),
      wordpress: () => ({
        steps: [
          `${seoPluginLabel(input.stack)} outputs canonicals without query parameters, so check pages have a self-referencing canonical.`,
          'Yoast: Settings → Advanced → Crawl optimisation → “Remove unregistered URL parameters” redirects away unknown parameters (keep utm_ allowed if your campaigns need them).',
          filters
            ? 'For WooCommerce layered navigation / filter plugins, enable their noindex option for filtered views and render filters as a form rather than crawlable links.'
            : 'Remove utm_ parameters from menu items and internal links.',
        ],
        files: ['WordPress: SEO plugin crawl settings', 'Appearance → Menus'],
      }),
      shopify: () => ({
        steps: [
          id.startsWith('cms.')
            ? 'The `_pos`, `_sid`, `_ss` and `_psq` parameters come from Shopify search and product recommendations. Keep `<link rel="canonical" href="{{ canonical_url }}">` in theme.liquid so they canonicalise to the product, and add the Disallow lines below to `templates/robots.txt.liquid`.'
            : 'Keep `{{ canonical_url }}` as the canonical in theme.liquid (it drops query strings) and remove tracking parameters from links you control in menus and sections.',
        ],
        files: ['layout/theme.liquid', 'templates/robots.txt.liquid'],
        snippet: {
          language: 'text',
          code: '# templates/robots.txt.liquid (inside the User-agent: * group)\nDisallow: /*?*_pos=\nDisallow: /*?*_sid=\nDisallow: /*?*_ss=\nDisallow: /*?*_psq=',
        },
      }),
      unknown: () => ({
        steps: [
          'Print a canonical with the clean URL (no query string) on every page, and strip tracking parameters from internal links.',
          session
            ? 'Turn off URL-based sessions (PHP: `session.use_trans_sid = 0`, `session.use_only_cookies = 1`; Java: `tracking-mode COOKIE`).'
            : 'Optionally block pure-filter parameters in robots.txt (below); do not block parameters on URLs that carry canonical or noindex tags you need crawlers to see.',
        ],
        files: [templateFile(input), 'robots.txt'],
        snippet: {
          language: session ? 'ini' : 'text',
          code: session
            ? '; php.ini\nsession.use_trans_sid = 0\nsession.use_only_cookies = 1'
            : `<link rel="canonical" href="${input.origin}/clean-path/" />\n\n# robots.txt\nUser-agent: *\nDisallow: /*?*sessionid=\nDisallow: /*?*sort=`,
        },
      }),
    });
    return {
      ...fix,
      title: session
        ? 'Keep session IDs out of URLs'
        : filters
          ? 'Canonicalise filter-parameter URLs'
          : linkSide
            ? 'Remove tracking parameters from internal links'
            : 'Canonicalise tracking-parameter URLs to the clean URL',
      steps: [
        session
          ? 'Session IDs in URLs give every visit a new URL: crawlers see endless duplicates and shared links can leak sessions.'
          : linkSide
            ? 'utm_ and similar parameters on internal links create duplicate URLs and overwrite the real traffic source in analytics. Use analytics events for internal promotions.'
            : 'Parameter URLs that are indexable and self-canonical become duplicates of the clean page. Point their canonical at the clean URL and stop linking to them.',
        ...evidenceStep(input),
        ...fix.steps,
        ...urlsBlock(input),
        verifyStep(input),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Internal search results
// ---------------------------------------------------------------------------

const internalSearch: Recipe = {
  id: 'internal-search',
  patterns: [/^urls\.internal-search-indexable$/, /^cms\.search-results-crawlable$/],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'In `app/search/page.tsx`, export `metadata` with `robots: { index: false, follow: true }`, and add `Disallow: /search` to `app/robots.ts` once the noindex has been seen.',
          'Do not link to search result URLs (“popular searches”, tag clouds built from searches).',
        ],
        files: ['app/search/page.tsx', 'app/robots.ts'],
        snippet: {
          language: 'ts',
          code: `// app/search/page.tsx\nexport const metadata: Metadata = { robots: { index: false, follow: true } };`,
        },
      }),
      wordpress: () => ({
        steps: [
          `${seoPluginLabel(input.stack)} noindexes search results by default (Yoast and Rank Math do); check it has not been changed.`,
          'Add `Disallow: /?s=` and `Disallow: /search/` to robots.txt, and remove links to `?s=` URLs from widgets and menus.',
        ],
        files: ['WordPress: SEO plugin settings', 'robots.txt'],
        snippet: { language: 'text', code: 'User-agent: *\nDisallow: /?s=\nDisallow: /search/' },
      }),
      shopify: () => ({
        steps: [
          'Shopify’s default robots.txt already disallows /search. Add noindex to the search template in `layout/theme.liquid` and remove links to /search?q= URLs from the theme.',
        ],
        files: ['layout/theme.liquid'],
        snippet: {
          language: 'liquid',
          code: `{% if template contains 'search' %}\n  <meta name="robots" content="noindex, follow">\n{% endif %}`,
        },
      }),
      hosted: () => ({
        steps: [
          'Set the search results page to “hide from search engines” in its SEO settings, and add `Disallow: /search` to robots.txt where the platform allows it.',
        ],
        files: ['Search page → SEO settings', 'robots.txt settings'],
      }),
      unknown: () => ({
        steps: [
          'Add `<meta name="robots" content="noindex, follow">` to the search results template and stop linking to result URLs. Once dropped from the index, disallow the search path in robots.txt.',
        ],
        files: ['search results template', 'robots.txt'],
        snippet: {
          language: 'html',
          code: '<meta name="robots" content="noindex, follow" />\n\n# robots.txt (after the pages have dropped out)\nUser-agent: *\nDisallow: /search',
        },
      }),
    });
    return {
      ...fix,
      title: 'Keep internal search results out of the index',
      steps: [
        'Search result pages are endless, thin and can be abused to put spam text on your domain. Noindex them first; block the path in robots.txt afterwards (a blocked page cannot show its noindex).',
        ...evidenceStep(input),
        ...fix.steps,
        ...urlsBlock(input),
        verifyStep(input),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Pagination markup
// ---------------------------------------------------------------------------

const pagination: Recipe = {
  id: 'pagination',
  patterns: [
    /^pagination\.(canonical-to-first|next-broken|sequence-mismatch|multiple-rel|page-one-duplicate)$/,
  ],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const id = input.def.id.replace('pagination.', '');
    const lead: Record<string, string> = {
      'canonical-to-first':
        'Pages 2, 3… list different items, so each needs a self-referencing canonical. Canonicalising them to page 1 tells search engines to ignore the items further down.',
      'next-broken':
        'rel="next"/"prev" point at pages that error. Generate them from the real page count and omit rel="next" on the last page and rel="prev" on the first.',
      'sequence-mismatch':
        'Each page’s rel="next" target must name it back as rel="prev". Generate both from the same page number.',
      'multiple-rel':
        'Output one rel="next" and one rel="prev" per page; two sources (theme and SEO plugin, or layout and page) are printing them.',
      'page-one-duplicate':
        'Link to the clean URL for page 1 (`/blog/`, not `/blog/?page=1` or `/blog/page/1/`) and 301 those variants to it.',
    };
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Compute the canonical and pagination links from the page number in `generateMetadata`; Next.js does not add rel next/prev itself, so render them with `<link>` in the page if you want them.',
        ],
        files: ['app/<listing>/page.tsx'],
        snippet: {
          language: 'tsx',
          code: `export async function generateMetadata({ searchParams }): Promise<Metadata> {
  const page = Number((await searchParams).page ?? 1);
  return { alternates: { canonical: page > 1 ? \`/blog?page=\${page}\` : '/blog' } };
}

// links in the list: page 1 is always the clean URL
const href = (n: number) => (n === 1 ? '/blog' : \`/blog?page=\${n}\`);`,
        },
      }),
      wordpress: () => ({
        steps: [
          `${seoPluginLabel(input.stack)} outputs self-referencing canonicals and rel next/prev on archives. Remove duplicates added by the theme (search \`rel="next"\` in theme files) and any custom canonical override that points paginated pages to page 1.`,
          'WordPress redirects `/page/1/` to the archive root itself; links to it usually come from a custom pagination function — use `paginate_links()`.',
        ],
        files: ['theme: archive.php / pagination function', 'WordPress: SEO plugin'],
      }),
      shopify: () => ({
        steps: [
          'Use `{{ canonical_url }}` (it includes `?page=N`) and `{{ paginate | default_pagination }}`. Remove theme code that hard-codes the collection URL as canonical or prints extra rel next/prev tags.',
        ],
        files: ['layout/theme.liquid', 'sections/main-collection-product-grid.liquid'],
      }),
      unknown: () => ({
        steps: [
          'Generate canonical and rel next/prev from the page number in the listing template:',
        ],
        files: ['listing / archive template'],
        snippet: {
          language: 'html',
          code: `<!-- page 2 of 5 -->
<link rel="canonical" href="${input.origin}/blog/?page=2" />
<link rel="prev" href="${input.origin}/blog/" />
<link rel="next" href="${input.origin}/blog/?page=3" />`,
        },
      }),
    });
    return {
      ...fix,
      title: input.def.title.startsWith('Page 2')
        ? 'Give paginated pages self-referencing canonicals'
        : 'Fix pagination links',
      steps: [lead[id] ?? input.def.fix, ...evidenceStep(input), ...fix.steps, ...urlsBlock(input)],
    };
  },
};

// ---------------------------------------------------------------------------
// Shopify product links inside collections
// ---------------------------------------------------------------------------

const shopifyProductUrls: Recipe = {
  id: 'shopify-product-urls',
  patterns: [/^cms\.shopify-collection-product-urls$/],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    return {
      title: 'Link products by their canonical /products/ URL',
      steps: [
        'Product cards link to `/collections/<collection>/products/<handle>`, which canonicalises to `/products/<handle>`. Every internal link then points at a non-canonical URL.',
        'Online Store → Themes → Edit code: search for `within: collection` (usually in `snippets/card-product.liquid` or `product-grid-item.liquid`) and remove the filter.',
        'Check the same in “related products” and search result snippets.',
        verifyStep(input),
      ],
      files: ['snippets/card-product.liquid', 'snippets/product-grid-item.liquid'],
      snippet: {
        language: 'liquid',
        code: `{%- comment -%} before {%- endcomment -%}\n<a href="{{ product.url | within: collection }}">\n{%- comment -%} after {%- endcomment -%}\n<a href="{{ product.url }}">`,
      },
    };
  },
};

export const recipes: Recipe[] = [
  linkGraph,
  anchors,
  linkTargets,
  linkRel,
  crawlableLinks,
  urlFormat,
  urlParams,
  internalSearch,
  pagination,
  shopifyProductUrls,
];
