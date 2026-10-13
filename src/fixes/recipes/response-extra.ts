/**
 * Response-level recipes not covered in technical.ts (status codes for bots, content type
 * and charset, soft 404s, home-page duplicates) and the AI-crawler findings about what bots
 * receive compared with a browser.
 */
import { byStack, seoPluginLabel, templateFile, wpPlugin } from '../stacks.js';
import type { Recipe, StackFix } from '../types.js';
import { recipes as aiAccess } from './ai-access.js';
import { evidenceStep, noServerAccess, serverFix, urlsBlock, verifyStep } from './common.js';
import { recipes as technical } from './technical.js';

function base(list: Recipe[], id: string): Recipe {
  const r = list.find((x) => x.id === id);
  if (!r) throw new Error(`recipe ${id} not found`);
  return r;
}

// ---------------------------------------------------------------------------
// Crawlers refused, throttled, slowed down or served less
// ---------------------------------------------------------------------------

const botAccess: Recipe = {
  id: 'bot-access',
  patterns: [
    /^response\.(forbidden|rate-limited)$/,
    /^ai-crawlers\.(slow-for-bots|sample-pages-differ)$/,
  ],
  impact: 'high',
  effort: 'hours',
  build(input) {
    const id = input.def.id;
    const fw = base(aiAccess, 'ai-firewall').build(input);
    let title = fw.title;
    let lead: string[] = [];
    if (id.endsWith('forbidden')) {
      title = 'Let crawlers fetch public pages (401/403)';
      lead = [
        'The crawler received 401 or 403 on pages a visitor can open. First check whether each URL is meant to be public:',
        '- Private (account, staging, admin): stop linking to it from public pages and leave the block.',
        '- Public: find the rule that refuses crawlers — a WAF or bot rule, HTTP basic auth left on from staging, a geo-block, or a hotlink/referrer rule.',
      ];
    } else if (id.endsWith('rate-limited')) {
      title = 'Stop rate-limiting verified crawlers (429)';
      lead = [
        'Crawlers got 429 Too Many Requests. Google and AI crawlers slow down sharply after repeated 429s, so new pages are picked up late.',
        'Raise the limit for verified bots (or exempt them), serve pages from cache so crawling costs little, and when you must limit, send `Retry-After` so bots back off politely.',
      ];
    } else if (id.endsWith('slow-for-bots')) {
      title = 'Serve AI crawlers as fast as browsers';
      lead = [
        'AI bots were answered much more slowly than a browser. Bot-management products sometimes “tarpit” suspected bots instead of blocking them; crawlers with short time budgets then give up, and user-triggered fetches (ChatGPT-User, Claude-User, Perplexity-User) time out while a person waits.',
        'Look for rules matching AI user agents with actions such as Tarpit, Delay, Managed Challenge or a low rate limit, and switch verified AI bots to Allow.',
        'Make sure bots are served from the CDN cache: rules that bypass the cache for unknown user agents or for requests without cookies make every bot request hit the origin.',
      ];
    } else {
      title = 'Give crawlers the same page as visitors';
      lead = [
        'Key pages served to AI bots are much shorter than the browser version. Usual causes: a consent or cookie wall rendered instead of the content, a metered paywall that shows bots a teaser, or a bot-specific variant from the CDN or a prerender service.',
        'Serve bots the full HTML. For paywalled content, mark the gated part with `isAccessibleForFree: false` and a `hasPart` CSS selector rather than removing it, so engines know it is a paywall and not cloaking.',
        'Consent banners should overlay the content, not replace it in the HTML.',
      ];
    }
    const wp =
      input.stack.id === 'wordpress'
        ? [
            'WordPress: check Wordfence (Firewall → Rate limiting: set “If a crawler’s page views exceed” to unlimited for verified crawlers) and any “block bad bots” option in security plugins.',
          ]
        : [];
    const retry: StackFix | null =
      id.endsWith('rate-limited') && !noServerAccess(input)
        ? serverFix(input, {
            nginx: `# allow bursts and answer 429 with Retry-After
limit_req_zone $binary_remote_addr zone=site:10m rate=20r/s;
server {
    location / {
        limit_req zone=site burst=100 nodelay;
        limit_req_status 429;
    }
    error_page 429 = @toomany;
    location @toomany { add_header Retry-After 30 always; return 429; }
}`,
            cloudflare: `Security → WAF → Rate limiting rules: exclude verified bots
  Expression: (not cf.client.bot) and (http.request.uri.path ne "/robots.txt")
  Requests: e.g. 300 per 10 seconds per IP, Action: Block (returns 429)`,
            vercel:
              'Vercel → Project → Firewall → Rules: in each rate-limit rule add the condition “Verified bot: is not” so verified crawlers are exempt.',
          })
        : null;
    return {
      title,
      steps: [
        ...lead,
        ...evidenceStep(input),
        ...fw.steps.filter((s) => !s.startsWith('robots.txt is not the problem')),
        ...wp,
        ...(retry ? retry.steps : []),
        ...urlsBlock(input),
      ],
      files: [...new Set([...fw.files, ...(retry?.files ?? [])])],
      snippet: retry?.snippet ?? fw.snippet,
      acceptance: fw.acceptance,
    };
  },
};

// ---------------------------------------------------------------------------
// Content type and character encoding
// ---------------------------------------------------------------------------

const contentType: Recipe = {
  id: 'content-type',
  patterns: [/^response\.(content-type-missing|charset-missing|charset-late)$/],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    const id = input.def.id;
    const header = id.endsWith('content-type-missing');
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          header
            ? 'Next.js sends `text/html; charset=utf-8` for pages. If a route handler (`route.ts`) returns HTML, set the header yourself.'
            : 'Next.js adds `<meta charSet="utf-8">` as the first tag in `<head>`. Remove any hand-written `<head>` content in `app/layout.tsx` that comes before it, and any second charset tag.',
        ],
        files: ['app/layout.tsx', 'app/**/route.ts'],
        snippet: {
          language: 'ts',
          code: `// app/<path>/route.ts returning HTML
return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });`,
        },
      }),
      wordpress: () => ({
        steps: [
          'Your theme’s `header.php` should start `<head>` with `<meta charset="<?php bloginfo( \'charset\' ); ?>">`. Move it above every other tag, including plugin output.',
          'Settings → Reading → “Encoding for pages and feeds” should be UTF-8 (set in wp-config.php `DB_CHARSET` on older installs).',
        ],
        files: ['header.php (theme)'],
        snippet: {
          language: 'php',
          code: `<head>\n  <meta charset="<?php bloginfo( 'charset' ); ?>">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <?php wp_head(); ?>`,
        },
      }),
      shopify: () => ({
        steps: [
          'In `layout/theme.liquid`, make `<meta charset="utf-8">` the first line inside `<head>`, before any app or tracking snippet.',
        ],
        files: ['layout/theme.liquid'],
        snippet: { language: 'liquid', code: '<head>\n  <meta charset="utf-8">\n  …' },
      }),
      hosted: () => ({
        steps: [
          'The platform sets the encoding itself. If custom head code comes before it, move that code to the end of the head or the body.',
        ],
        files: ['Site settings → Custom code (head)'],
      }),
      unknown: (i) => {
        if (!header)
          return {
            steps: [
              'Make `<meta charset="utf-8">` the very first element inside `<head>` (it must be within the first 1024 bytes) and save the file as UTF-8.',
            ],
            files: [templateFile(i)],
            snippet: {
              language: 'html',
              code: '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <title>…</title>',
            },
          };
        return serverFix(i, {
          nginx: `# html files get text/html; charset=utf-8
charset utf-8;
types { text/html html htm; }`,
          apache: `# .htaccess
AddDefaultCharset UTF-8
AddType 'text/html; charset=UTF-8' .html .htm`,
          vercel: `{
  "headers": [
    { "source": "/(.*)\\\\.html", "headers": [{ "key": "Content-Type", "value": "text/html; charset=utf-8" }] }
  ]
}`,
          netlify: `[[headers]]
  for = "/*.html"
  [headers.values]
    Content-Type = "text/html; charset=utf-8"`,
        });
      },
    });
    return {
      ...fix,
      title: header
        ? 'Send HTML with Content-Type: text/html; charset=utf-8'
        : 'Declare UTF-8 at the top of <head>',
      steps: [
        ...fix.steps,
        ...urlsBlock(input),
        verifyStep(input, `Check with \`curl -sI ${input.urls[0] ?? input.origin}\`.`),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Empty responses
// ---------------------------------------------------------------------------

const emptyBody: Recipe = {
  id: 'empty-body',
  patterns: [/^response\.empty-body$/],
  impact: 'high',
  effort: 'hours',
  tier: 'manual',
  build(input) {
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Check the server logs (Vercel → Logs) for the URL. A page that throws during streaming can end with an empty or partial body; add `error.tsx` for the route and fix the thrown error.',
          'If an ISR/cached version is empty, revalidate the path (`revalidatePath`) after fixing.',
        ],
        files: ['app/<route>/page.tsx', 'app/<route>/error.tsx'],
      }),
      wordpress: () => ({
        steps: [
          'An empty 200 in WordPress is usually a fatal PHP error with display off (the “white screen”). Enable `WP_DEBUG_LOG` and read `wp-content/debug.log`, or the host’s PHP error log.',
          'Purge the page cache (caching plugin and CDN) after fixing, in case the empty page was cached.',
        ],
        files: ['wp-config.php (WP_DEBUG_LOG)', 'wp-content/debug.log'],
        snippet: {
          language: 'php',
          code: "// wp-config.php: log errors, never show them\ndefine('WP_DEBUG', true);\ndefine('WP_DEBUG_LOG', true);\ndefine('WP_DEBUG_DISPLAY', false);",
        },
      }),
      unknown: () => ({
        steps: [
          'Request the URL with and without cookies, and as a crawler (`curl -A Googlebot`), and compare. Check application and server logs for errors at that time.',
          'Purge the CDN cache for the URL in case an empty response was cached, and set the CDN not to cache empty or error responses.',
        ],
        files: ['application logs', 'CDN cache settings'],
      }),
    });
    return {
      ...fix,
      title: 'Fix pages that return an empty body',
      steps: [...fix.steps, ...urlsBlock(input), verifyStep(input)],
    };
  },
};

// ---------------------------------------------------------------------------
// Unknown URLs: real 404s, not 200s or redirects
// ---------------------------------------------------------------------------

const notFound: Recipe = {
  id: 'not-found-status',
  patterns: [/^response\.missing-page-(returns-200|redirects)$/, /^pagination\.out-of-range-200$/],
  impact: 'high',
  effort: 'hours',
  build(input) {
    const id = input.def.id;
    const redirects = id.endsWith('redirects');
    const pagination = id.startsWith('pagination.');
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          pagination
            ? 'In the listing page, call `notFound()` when the requested page number is beyond the last page.'
            : 'In dynamic routes, call `notFound()` from `next/navigation` when the item does not exist, and add `app/not-found.tsx`. Next.js then answers with status 404.',
          'Check catch-all routes (`[...slug]`) and rewrites in `next.config.ts` / `vercel.json`: a rewrite of everything to `/` makes every URL return 200.',
        ],
        files: ['app/<route>/page.tsx', 'app/not-found.tsx', 'next.config.ts'],
        snippet: {
          language: 'tsx',
          code: pagination
            ? `import { notFound } from 'next/navigation';

export default async function Page({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const page = Number((await searchParams).page ?? 1);
  const { items, totalPages } = await getItems(page);
  if (!Number.isInteger(page) || page < 1 || page > totalPages) notFound();
  // …
}`
            : `import { notFound } from 'next/navigation';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const item = await getItem((await params).slug);
  if (!item) notFound(); // responds 404 and renders app/not-found.tsx
  return <article>…</article>;
}`,
        },
      }),
      'nextjs-pages': () => ({
        steps: [
          'Return `{ notFound: true }` from `getStaticProps` / `getServerSideProps` when the item (or page number) does not exist, and set `fallback: "blocking"` rather than rendering an empty page.',
        ],
        files: ['pages/<route>.tsx', 'pages/404.tsx'],
      }),
      spa: () => ({
        steps: [
          'A single-page app answers every path with index.html and status 200. Only a server or prerender step can send 404: list your real routes at build time and make the host return 404 for everything else.',
          'Netlify: prerender the routes and drop the blanket `/* /index.html 200` rule (or keep it, but add a `404.html`). Vercel: replace the catch-all rewrite with one per route pattern. Angular SSR / Vike: set the response status in the not-found route.',
          'Until then, add `<meta name="robots" content="noindex">` to the client-side not-found view.',
        ],
        files: ['vercel.json / _redirects', 'router config (not-found route)'],
      }),
      wordpress: () => ({
        steps: pagination
          ? [
              'WordPress returns 404 for out-of-range `/page/N/` by default. If it does not, a theme or plugin is overriding `pre_handle_404` or the main query; disable plugins one by one to find it.',
            ]
          : [
              redirects
                ? 'A plugin is redirecting all 404s (often “All 404 Redirect to Homepage”, a redirect plugin’s “redirect 404s” option, or an SEO plugin setting). Turn it off and handle genuinely moved URLs with individual 301s.'
                : 'Check that the theme has a `404.php` template and that no plugin catches 404s and renders a page with status 200.',
              `Keep a 404 log (Redirection plugin or ${seoPluginLabel(input.stack)}) and add 301s only for URLs that have a real replacement.`,
            ],
        files: ['404.php (theme)', 'redirect / 404 plugins'],
      }),
      shopify: () => ({
        steps: [
          'Shopify returns 404 for unknown URLs by default. Check Online Store → Navigation → URL redirects and apps for a wildcard that sends every unknown URL to the home page.',
          'Edit `templates/404.json` / `sections/main-404.liquid` so the error page is helpful (search box, popular collections).',
        ],
        files: ['templates/404.json', 'URL redirects / redirect apps'],
      }),
      hosted: () => ({
        steps: [
          'Check the redirects settings for a wildcard rule (for example `/*` → `/`) and remove it. Design the platform’s 404 page so visitors can find their way.',
        ],
        files: ['Site settings → Redirects', '404 page'],
      }),
      unknown: (i) =>
        serverFix(
          i,
          {
            nginx: `# serve existing files, otherwise a real 404
location / {
    try_files $uri $uri/ =404;
}
error_page 404 /404.html;`,
            apache: `# .htaccess
ErrorDocument 404 /404.html
# remove catch-all rules such as:  RewriteRule ^ / [R=301,L]`,
            vercel: `// vercel.json: remove catch-all rewrites such as
// { "source": "/(.*)", "destination": "/" }
// and add a 404.html at the output root (Vercel serves it with status 404)`,
            netlify: `# _redirects: a 404.html at the publish root is served with status 404.
# Remove catch-alls such as:  /*  /  301`,
            cloudflare: `Cloudflare Pages: add 404.html to the build output (otherwise Pages treats the site as a single-page app and returns the home page with 200).
Rules → Redirect Rules: remove wildcard rules that send every path to /.`,
          },
          [
            'Make the server answer unknown URLs with status 404 and a helpful error page (search, main sections).',
          ],
        ),
    });
    const probe = `${input.origin}/avc-made-up-url-404-test`;
    return {
      ...fix,
      title: pagination
        ? 'Return 404 for page numbers past the end'
        : redirects
          ? 'Stop redirecting unknown URLs'
          : 'Return 404 for pages that do not exist',
      steps: [
        redirects
          ? 'Redirecting every unknown URL (often to the home page) is treated as a soft 404 and hides real broken links. Let unknown URLs return 404, and redirect only URLs that have a genuine replacement.'
          : pagination
            ? 'Out-of-range page numbers return an empty listing with status 200, so crawlers can generate endless empty pages.'
            : 'Made-up URLs return 200, so every broken link becomes an indexable duplicate and crawlers cannot tell real pages from errors.',
        ...evidenceStep(input),
        ...fix.steps,
        verifyStep(
          input,
          `Test: \`curl -s -o /dev/null -w "%{http_code}" ${probe}\` should print 404.`,
        ),
      ],
      acceptance: ['A made-up URL returns status 404 (not 200, not a redirect)'],
    };
  },
};

// ---------------------------------------------------------------------------
// Home page reachable at several URLs
// ---------------------------------------------------------------------------

const homepageDuplicates: Recipe = {
  id: 'homepage-duplicates',
  patterns: [/^response\.homepage-duplicates$/, /^urls\.index-file$/],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    const index = input.def.id === 'urls.index-file';
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Add permanent redirects for the variants in `next.config.ts` and link to `/` (or the folder URL) everywhere.',
        ],
        files: ['next.config.ts'],
        snippet: {
          language: 'ts',
          code: `async redirects() {
  return [
    { source: '/index', destination: '/', permanent: true },
    { source: '/home', destination: '/', permanent: true },
    { source: '/:path*/index.html', destination: '/:path*', permanent: true },
  ];
},`,
        },
      }),
      wordpress: () => ({
        steps: [
          'WordPress redirects `/index.php` to `/` itself. For other variants (`/home/`, a page set as the front page that is also reachable at its own slug), set Settings → Reading → “Your homepage displays” to that page — WordPress then redirects its slug to `/`.',
          'Add any remaining variants in the Redirection plugin (or Rank Math / Yoast Premium redirects).',
        ],
        files: ['Settings → Reading', 'WordPress: redirect manager'],
      }),
      shopify: () => ({
        steps: [
          'Add the variants in Online Store → Navigation → URL redirects (pointing to `/`) and update theme links to `{{ routes.root_url }}`.',
        ],
        files: ['Shopify: URL redirects', 'sections/header.liquid'],
      }),
      hosted: () => ({
        steps: [
          'Add 301 redirects for the variants in the platform’s redirects settings, and link the logo and menu to `/`.',
        ],
        files: ['Site settings → Redirects'],
      }),
      unknown: (i) =>
        serverFix(i, {
          nginx: `# redirect /index.html, /index.php and /home to the folder URL
rewrite ^(.*/)index\\.(html|php)$ $1 permanent;
location = /home { return 301 /; }`,
          apache: `# .htaccess
RewriteEngine On
RewriteCond %{THE_REQUEST} \\s/+(.*/)?index\\.(html|php)[\\s?] [NC]
RewriteRule ^ /%1 [R=301,L]
Redirect 301 /home /`,
          vercel: `{
  "redirects": [
    { "source": "/index.html", "destination": "/", "permanent": true },
    { "source": "/:path*/index.html", "destination": "/:path*/", "permanent": true },
    { "source": "/home", "destination": "/", "permanent": true }
  ]
}`,
          netlify: `# _redirects
/index.html   /   301!
/home         /   301!`,
          cloudflare: `Rules → Redirect Rules → Create rule
  If: (http.request.uri.path matches "^/(index\\.(html|php)|home)$")
  Then: Static redirect → URL ${input.origin}/ → 301`,
        }),
    });
    return {
      ...fix,
      title: index ? 'Link to folder URLs, not index files' : 'Redirect home-page variants to /',
      steps: [
        index
          ? 'Change links that end in `index.html` / `index.php` to the folder URL (`/about/`), then 301 the index-file URL to it.'
          : 'The home page also answers at other URLs (such as /index.html, /index.php or /home). 301-redirect each variant to the root URL; a canonical alone is weaker.',
        ...evidenceStep(input),
        ...fix.steps,
        ...urlsBlock(input),
        verifyStep(input),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// What AI crawlers see: shells, hidden content, iframes, missing schema
// ---------------------------------------------------------------------------

const emptyShell: Recipe = {
  id: 'empty-shell',
  patterns: [/^ai-crawlers\.empty-shell$/],
  impact: 'high',
  effort: 'days',
  build(input) {
    const f = base(aiAccess, 'js-rendering').build(input);
    return {
      ...f,
      title: 'Render the page on the server, not in an empty app shell',
      steps: [
        'The HTML for these pages is an empty root element (`<div id="root"></div>`) filled by JavaScript. GPTBot, ClaudeBot, PerplexityBot and most AI crawlers do not run JavaScript, so they see a blank page.',
        ...f.steps,
        ...urlsBlock(input),
      ],
    };
  },
};

const botSchema: Recipe = {
  id: 'bot-missing-schema',
  patterns: [/^ai-crawlers\.bot-missing-schema$/],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const plugin = wpPlugin(input.stack);
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Render JSON-LD in a Server Component with a plain `<script type="application/ld+json">`, not through `next/script`, Google Tag Manager or a `useEffect`.',
        ],
        files: ['app/layout.tsx', 'app/<route>/page.tsx'],
        snippet: {
          language: 'tsx',
          code: `export default async function Page() {
  const jsonLd = { '@context': 'https://schema.org', '@type': 'Organization', name: '…', url: '${input.origin}' };
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\\\u003c') }}
      />
      {/* page */}
    </>
  );
}`,
        },
      }),
      wordpress: () => ({
        steps: [
          plugin
            ? `Let ${seoPluginLabel(input.stack)} output the schema (it prints it in the server HTML), and remove the copy added through Google Tag Manager or a JavaScript plugin.`
            : 'Use an SEO plugin (Yoast, Rank Math) or a server-side schema plugin instead of injecting JSON-LD through Google Tag Manager.',
        ],
        files: [`WordPress: ${seoPluginLabel(input.stack)} schema settings`, 'Google Tag Manager'],
      }),
      shopify: () => ({
        steps: [
          'Print JSON-LD in Liquid (`layout/theme.liquid` or the product section) with `{{ product | structured_data }}` or a hand-written block, not with an app that injects it by script.',
        ],
        files: ['sections/main-product.liquid', 'layout/theme.liquid'],
        snippet: {
          language: 'liquid',
          code: `<script type="application/ld+json">\n  {{ product | structured_data }}\n</script>`,
        },
      }),
      hosted: () => ({
        steps: [
          'Paste the JSON-LD into the page’s custom head code (rendered on the server) rather than adding it through Google Tag Manager.',
        ],
        files: ['Page settings → Custom code (head)'],
      }),
      unknown: () => ({
        steps: [
          'Move the JSON-LD from Google Tag Manager or client-side script into the server-rendered template.',
        ],
        files: [templateFile(input)],
      }),
    });
    return {
      ...fix,
      title: 'Put structured data in the server HTML',
      steps: [
        'A browser sees JSON-LD on these pages but the HTML sent to AI bots has none: it is injected by a tag manager or client-side script, and most AI crawlers do not run JavaScript.',
        ...fix.steps,
        `Check: \`curl -s -A GPTBot ${input.urls[0] ?? input.origin} | grep -c 'application/ld+json'\` should print 1 or more.`,
        verifyStep(input),
      ],
    };
  },
};

const hiddenContent: Recipe = {
  id: 'hidden-content',
  patterns: [/^ai-crawlers\.(hidden-content|iframe-content)$/],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const iframe = input.def.id.endsWith('iframe-content');
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: iframe
          ? [
              'Render the content in the page component itself (fetch it on the server) instead of embedding another URL in an `<iframe>`.',
            ]
          : [
              'Render tab and accordion panels in the HTML and keep the main answer outside them. Prefer `<details>`/`<summary>` for secondary content; avoid rendering panel content only when it is opened.',
            ],
        files: ['app/<route>/page.tsx', 'components/tabs.tsx / accordion.tsx'],
      }),
      wordpress: () => ({
        steps: iframe
          ? [
              'Replace iframe embeds of your own content (forms, tables, other pages) with blocks or shortcodes that output HTML in the page.',
            ]
          : [
              'In the page builder, move the key answer out of tabs/toggles into a normal text block at the top. Use the core Details block for FAQs; avoid widgets that load panel text by AJAX.',
            ],
        files: ['WordPress editor / page builder'],
      }),
      shopify: () => ({
        steps: iframe
          ? ['Replace iframes of your own content with sections that render the content in Liquid.']
          : [
              'Show the product description and key details by default; keep collapsible rows for secondary detail (shipping, care). Theme “collapsible tab” blocks keep their text in the HTML — check yours does.',
            ],
        files: ['sections/main-product.liquid'],
      }),
      unknown: () => ({
        steps: iframe
          ? [
              'Put the content directly into the page HTML. Keep iframes for third-party embeds such as maps and video, and describe what the embed shows in text next to it.',
            ]
          : [
              'Keep the answer to the page’s main question visible by default. For secondary content use `<details>`/`<summary>` rather than `hidden` or `display:none` panels.',
            ],
        files: [templateFile(input)],
        snippet: iframe
          ? undefined
          : {
              language: 'html',
              code: '<p>Direct answer to the page’s main question, visible by default.</p>\n\n<details>\n  <summary>Delivery and returns</summary>\n  <p>Secondary detail…</p>\n</details>',
            },
      }),
    });
    return {
      ...fix,
      title: iframe
        ? 'Move the main content out of the iframe'
        : 'Keep the main answer visible, not in collapsed panels',
      steps: [
        iframe
          ? 'The main content is loaded from another URL in an `<iframe>`. Crawlers credit it to that URL (or skip it), so this page looks empty.'
          : 'Much of the text sits in hidden tabs or collapsed panels. Most crawlers still read it, but extractors that drop hidden elements can miss it and engines may weight it less.',
        ...fix.steps,
        ...urlsBlock(input),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Off-site presence for AI: sitemap, Common Crawl, Bing
// ---------------------------------------------------------------------------

const aiSitemap: Recipe = {
  id: 'ai-sitemap',
  patterns: [/^ai-crawlers\.sitemap-not-found$/],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const f = base(technical, 'sitemaps').build(input);
    return {
      ...f,
      title: 'Publish an XML sitemap',
      steps: [
        ...f.steps,
        `Add \`Sitemap: ${input.origin}/sitemap.xml\` to robots.txt and submit it in Google Search Console and Bing Webmaster Tools.`,
      ],
    };
  },
};

const commonCrawl: Recipe = {
  id: 'common-crawl',
  patterns: [/^ai-crawlers\.common-crawl$/],
  impact: 'low',
  effort: 'minutes',
  tier: 'manual',
  build(input) {
    return {
      title: 'Let Common Crawl include the site',
      steps: [
        'Check robots.txt does not block `CCBot` (or block everything for unknown bots). Allow it if you are content for your pages to be in the open web archive many AI datasets start from.',
        'Check the firewall or bot protection does not challenge CCBot (Cloudflare: AI Crawl Control lists it separately).',
        'Make sure important pages are linked from other sites and listed in your sitemap: Common Crawl samples the web, so well-linked sites are more likely to be included.',
        `Look the domain up at https://index.commoncrawl.org/ (pick the latest crawl, search \`${input.host}/*\`) after the next monthly crawl.`,
      ],
      files: ['robots.txt', 'CDN / WAF bot settings'],
      snippet: { language: 'text', code: 'User-agent: CCBot\nAllow: /' },
    };
  },
};

const bingWebmaster: Recipe = {
  id: 'bing-webmaster',
  patterns: [/^ai-crawlers\.bing-webmaster$/, /^analytics\.verification-missing$/],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    const both = input.def.id.startsWith('analytics.');
    const plugin = wpPlugin(input.stack);
    const where = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Meta-tag verification: add the codes to `metadata.verification` in `app/layout.tsx`.',
        ],
        files: ['app/layout.tsx'],
        snippet: {
          language: 'ts',
          code: `export const metadata: Metadata = {
  verification: {
    google: 'google-site-verification-code',
    other: { 'msvalidate.01': 'BING-CODE' },
  },
};`,
        },
      }),
      wordpress: () => ({
        steps: [
          plugin === 'yoast'
            ? 'Yoast SEO → Settings → Site connections: paste the Google and Bing verification codes.'
            : plugin === 'rank-math'
              ? 'Rank Math → General Settings → Webmaster Tools: paste the codes.'
              : plugin === 'aioseo'
                ? 'All in One SEO → General Settings → Webmaster Tools: paste the codes.'
                : 'Site Kit by Google verifies Search Console; for Bing, paste the meta tag with an SEO plugin or verify by DNS.',
          'For IndexNow, Rank Math and AIOSEO have it built in; otherwise use the IndexNow plugin.',
        ],
        files: [`WordPress: ${seoPluginLabel(input.stack)} webmaster tools`],
      }),
      shopify: () => ({
        steps: [
          'Paste the verification `<meta>` tags into `layout/theme.liquid` inside `<head>`, or verify by DNS in your domain provider.',
        ],
        files: ['layout/theme.liquid'],
      }),
      hosted: () => ({
        steps: [
          'Use the platform’s Search Console / site verification field (SEO settings), or paste the meta tag into custom head code. DNS verification also works.',
        ],
        files: ['Site settings → SEO / Custom code'],
      }),
      unknown: () => ({
        steps: ['Add the verification meta tags to the `<head>` of the home page template:'],
        files: [templateFile(input)],
        snippet: {
          language: 'html',
          code: '<meta name="google-site-verification" content="…" />\n<meta name="msvalidate.01" content="…" />',
        },
      }),
    });
    return {
      ...where,
      title: both
        ? 'Verify the site in Google Search Console and Bing Webmaster Tools'
        : 'Verify the site in Bing Webmaster Tools',
      steps: [
        ...(both
          ? [
              'Google Search Console: add a Domain property (DNS TXT record, covers every subdomain and protocol) at https://search.google.com/search-console.',
            ]
          : []),
        'Bing Webmaster Tools: sign in at https://www.bing.com/webmasters and choose “Import from Google Search Console” — the quickest route, it copies the verified sites and sitemaps. Copilot answers are grounded in Bing’s index.',
        'Otherwise verify by DNS (CNAME/TXT) or with the meta tag below.',
        ...where.steps,
        `Submit ${input.origin}/sitemap.xml in both tools, and turn on IndexNow if your CMS or CDN supports it (Cloudflare: Caching → Configuration → Crawler Hints).`,
        'If you already verified by DNS, this finding can be ignored: DNS verification is not visible in the HTML.',
      ],
    };
  },
};

export const recipes: Recipe[] = [
  botAccess,
  contentType,
  emptyBody,
  notFound,
  homepageDuplicates,
  emptyShell,
  botSchema,
  hiddenContent,
  aiSitemap,
  commonCrawl,
  bingWebmaster,
];
