/**
 * Classic technical SEO recipes: robots.txt, sitemaps, canonicals, noindex, redirects,
 * broken links, hreflang, security headers, HTTPS, performance and response codes.
 */
import { addSitemapLines, generateRobotsTxt, generateSitemapXml } from '../generate.js';
import {
  byStack,
  headersFix,
  metaFix,
  seoPluginLabel,
  staticFile,
  templateFile,
  wpPlugin,
} from '../stacks.js';
import type { Recipe, RecipeInput, StackFix } from '../types.js';
import { robotsFix } from './ai-access.js';

function urlList(input: RecipeInput, n = 10): string {
  return input.urls
    .slice(0, n)
    .map((u) => `- ${u}`)
    .join('\n');
}

const robotsMissing: Recipe = {
  id: 'robots-missing',
  patterns: [/^crawlability\.robots-txt-missing$/, /^robots\..*missing/],
  impact: 'medium',
  effort: 'minutes',
  auto: { repo: true, wordpress: true },
  build(input) {
    const robots = generateRobotsTxt('User-agent: *\nAllow: /\n', 'allow-all-ai', {
      sitemaps: [`${input.origin}/sitemap.xml`],
    });
    return { ...robotsFix(input, robots, 'allow-all-ai'), title: 'Add a robots.txt' };
  },
};

const robotsBlocksAll: Recipe = {
  id: 'robots-blocks-all',
  patterns: [/^crawlability\.robots-blocks-(all|home|linked-pages|resources)$/, /^robots\..*block/],
  impact: 'high',
  effort: 'minutes',
  build(input) {
    const current = input.result?.robots?.body ?? '';
    const evidence = input.issues
      .map((i) => i.evidence)
      .filter(Boolean)
      .slice(0, 5)
      .join('\n');
    const fixed = current
      .split('\n')
      .map((l) =>
        /^\s*disallow\s*:\s*\/\s*$/i.test(l)
          ? `# ${l.trim()}  (removed: blocked the whole site)`
          : l,
      )
      .join('\n');
    const f = robotsFix(input, fixed || 'User-agent: *\nAllow: /\n', null);
    return {
      ...f,
      title: 'Remove robots.txt rules that block public pages',
      steps: [
        `The deciding rule${evidence ? `:\n${evidence}` : ' is shown in the issue evidence'}. Remove it or narrow it to the private paths it was meant for.`,
        'If this is a staging rule that leaked to production, make it environment-specific (e.g. only output `Disallow: /` when the host is the staging domain).',
        input.def.id.endsWith('resources')
          ? 'Do not block CSS, JS or image folders: Google needs them to render the page.'
          : 'Removing the rule lets crawlers in on their next visit; request re-crawling in Search Console for key pages.',
        ...f.steps,
      ],
    };
  },
};

const robotsNoSitemap: Recipe = {
  id: 'robots-sitemap-line',
  patterns: [/^crawlability\.robots-(no-sitemap|sitemap-invalid)$/, /^sitemaps\..*robots/],
  impact: 'low',
  effort: 'minutes',
  auto: { repo: true },
  build(input) {
    const robots = addSitemapLines(input.result?.robots?.body ?? '', [
      `${input.origin}/sitemap.xml`,
    ]);
    return { ...robotsFix(input, robots, null), title: 'List your sitemap in robots.txt' };
  },
};

const sitemaps: Recipe = {
  id: 'sitemaps',
  patterns: ['sitemaps.*'],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const xml = generateSitemapXml({
      site: input.origin,
      pages: input.pages ?? input.result?.pages,
    });
    const plugin = wpPlugin(input.stack);
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Create `app/sitemap.ts` that lists every public, indexable, canonical URL from your data source.',
        ],
        files: ['app/sitemap.ts'],
        snippet: {
          language: 'ts',
          code: `import type { MetadataRoute } from 'next';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const posts = await getPosts(); // your data
  return [
    { url: '${input.origin}/', lastModified: new Date() },
    ...posts.map((p) => ({ url: \`${input.origin}/blog/\${p.slug}\`, lastModified: p.updatedAt })),
  ];
}`,
        },
      }),
      'nextjs-pages': () => ({
        steps: [
          'Install `next-sitemap` and run it after `next build` (`postbuild` script), or write `pages/sitemap.xml.ts` with `getServerSideProps`.',
        ],
        files: ['next-sitemap.config.js', 'package.json'],
      }),
      astro: () => ({
        steps: [
          'Set `site` in `astro.config.mjs` and add the `@astrojs/sitemap` integration (`npx astro add sitemap`). It writes `sitemap-index.xml`.',
        ],
        files: ['astro.config.mjs'],
        snippet: {
          language: 'js',
          code: `import sitemap from '@astrojs/sitemap';\n\nexport default defineConfig({\n  site: '${input.origin}',\n  integrations: [sitemap()],\n});`,
        },
      }),
      nuxt: () => ({
        steps: [
          'Add `@nuxtjs/sitemap` (`npx nuxi module add sitemap`) and set `site.url` in `nuxt.config.ts`.',
        ],
        files: ['nuxt.config.ts'],
      }),
      sveltekit: () => ({
        steps: [
          'Add `src/routes/sitemap.xml/+server.ts` that returns XML for every public route (prerender it).',
        ],
        files: ['src/routes/sitemap.xml/+server.ts'],
      }),
      gatsby: () => ({
        steps: ['Add `gatsby-plugin-sitemap` and set `siteMetadata.siteUrl`.'],
        files: ['gatsby-config.js'],
      }),
      remix: () => ({
        steps: ['Add a `sitemap[.]xml.ts` resource route that returns the XML.'],
        files: ['app/routes/sitemap[.]xml.ts'],
      }),
      wordpress: () => ({
        steps: [
          plugin === 'yoast'
            ? 'Yoast SEO → Settings → Site features → XML sitemaps: on. The index is /sitemap_index.xml. Exclude noindex content types there.'
            : plugin === 'rank-math'
              ? 'Rank Math → Sitemap Settings: enable, include only indexable post types. Index: /sitemap_index.xml.'
              : plugin === 'aioseo'
                ? 'All in One SEO → Sitemaps: enable; include only indexable post types and taxonomies.'
                : 'WordPress core publishes /wp-sitemap.xml. Check Settings → Reading → "Discourage search engines" is off (it disables the sitemap).',
        ],
        files: [`WordPress: ${seoPluginLabel(input.stack)} sitemap settings`],
      }),
      shopify: () => ({
        steps: [
          'Shopify generates /sitemap.xml automatically. Fix entries by making hidden products/pages unavailable to the Online Store channel or adding `seo.hidden` metafields.',
        ],
        files: ['Shopify admin'],
      }),
      hosted: () => ({
        steps: [
          'The platform generates /sitemap.xml. Exclude pages with the page’s SEO setting "hide from search engines/sitemap", and make sure it is listed in robots.txt.',
        ],
        files: ['Page SEO settings'],
      }),
      hugo: () => ({
        steps: [
          'Hugo writes /sitemap.xml by default. Set `baseURL` correctly and exclude drafts / noindex pages with `sitemap: { disable: true }` in front matter.',
        ],
        files: ['hugo.toml'],
      }),
      jekyll: () => ({
        steps: ['Add `jekyll-sitemap` to `plugins` in `_config.yml` and set `url`.'],
        files: ['_config.yml', 'Gemfile'],
      }),
      unknown: (i) => {
        const s = staticFile(i, 'sitemap.xml', xml, 'xml');
        return {
          ...s,
          steps: [
            'The sitemap below lists the indexable pages found in this crawl. Regenerate it whenever pages change (better: generate it at build time).',
            ...s.steps,
          ],
        };
      },
    });
    return {
      ...fix,
      title: 'Fix the XML sitemap',
      steps: [
        'A sitemap should list only canonical, indexable URLs that return 200, and be referenced from robots.txt.',
        ...fix.steps,
        `Submit it in Google Search Console and Bing Webmaster Tools, then run \`avc audit --only ${input.def.id}\`.`,
      ],
    };
  },
};

const canonical: Recipe = {
  id: 'canonical',
  patterns: ['canonical.*', /^crawlability\.(gsc-canonical-mismatch|noindex-canonical)$/],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const f = metaFix(input, { field: 'canonical' });
    return {
      ...f,
      title: 'Fix canonical links',
      steps: [
        'Each indexable page should have one absolute `<link rel="canonical">` pointing to itself (or to the preferred duplicate), on HTTPS, returning 200, not redirecting, not noindex.',
        ...f.steps,
      ],
      acceptance: [
        'Each affected page has exactly one canonical, absolute, self-referencing unless it is a deliberate duplicate',
      ],
    };
  },
};

const noindex: Recipe = {
  id: 'noindex',
  patterns: [
    /^crawlability\.(noindex|noindex-header|noindex-linked|homepage-noindex|staging-indexable|nofollow-page|gsc-noindex-with-impressions|snippet-restricted|image-preview-restricted|unavailable-after-past)$/,
    /noindex/,
  ],
  impact: 'high',
  effort: 'minutes',
  auto: { wordpress: true },
  build(input) {
    const header = /header|x-robots/.test(input.def.id);
    if (/staging/.test(input.def.id)) {
      const f = headersFix(input, { 'X-Robots-Tag': 'noindex, nofollow' });
      return {
        ...f,
        title: 'Keep the staging site out of search',
        steps: [
          'Apply this on the staging host only (not production). Password protection is better still.',
          ...f.steps,
        ],
      };
    }
    if (/snippet|preview/.test(input.def.id)) {
      const f = metaFix(input, { field: 'robots' });
      return {
        ...f,
        title: 'Remove snippet restrictions',
        steps: [
          'Remove `nosnippet`, `max-snippet:0`, `max-image-preview:none` or `data-nosnippet` on content you want quoted: AI search answers rely on snippets.',
          ...f.steps,
        ],
      };
    }
    const f = header
      ? {
          steps: [
            'The `X-Robots-Tag: noindex` header is set by the server, CDN or framework config — search for it in vercel.json, netlify.toml, _headers, next.config, nginx/Apache config or a security plugin, and remove it for public pages.',
          ],
          files: ['vercel.json / netlify.toml / _headers / next.config / server config'],
        }
      : metaFix(input, { field: 'robots' });
    return {
      ...f,
      title: header
        ? 'Remove the noindex header from public pages'
        : 'Remove noindex from pages that should be found',
      steps: [
        'Check first that each page is meant to be public. If it is private or thin on purpose, keep noindex and remove it from the sitemap and internal links instead.',
        ...f.steps,
        `Affected pages:\n${urlList(input)}`,
      ],
    };
  },
};

function redirectSnippet(input: RecipeInput): StackFix {
  const pairs = input.issues
    .map((i) => ({
      from: i.url,
      to: (i.data?.finalUrl ?? i.data?.to ?? i.data?.target) as string | undefined,
    }))
    .filter((p): p is { from: string; to: string } => !!p.from && !!p.to)
    .slice(0, 20)
    .map((p) => ({
      from: new URL(p.from).pathname,
      to: p.to.startsWith(input.origin) ? new URL(p.to).pathname : p.to,
    }));
  const sample = pairs.length ? pairs : [{ from: '/old-path', to: '/new-path' }];
  return byStack(input, {
    nextjs: () => ({
      steps: ['Add permanent redirects in `next.config.ts` (or `vercel.json` on Vercel).'],
      files: ['next.config.ts'],
      snippet: {
        language: 'ts',
        code: `async redirects() {\n  return [\n${sample.map((p) => `    { source: '${p.from}', destination: '${p.to}', permanent: true },`).join('\n')}\n  ];\n},`,
      },
    }),
    wordpress: () => ({
      steps: [
        wpPlugin(input.stack) === 'rank-math'
          ? 'Rank Math → Redirections: edit the first hop to point straight at the final URL (301).'
          : 'Use the Redirection plugin (or Yoast Premium / AIOSEO Redirects) to point each old URL straight at the final URL (301).',
      ],
      files: ['WordPress: redirect manager'],
    }),
    shopify: () => ({
      steps: [
        'Online Store → Navigation → URL redirects: point each old path straight at the final one.',
      ],
      files: ['Shopify: URL redirects'],
    }),
    unknown: () => {
      const host = `${input.stack.host ?? ''}`.toLowerCase();
      if (host.includes('netlify'))
        return {
          steps: ['Add rules to `_redirects` (or netlify.toml).'],
          files: ['_redirects'],
          snippet: {
            language: 'text',
            code: sample.map((p) => `${p.from}  ${p.to}  301`).join('\n'),
          },
        };
      if (host.includes('vercel'))
        return {
          steps: ['Add rules to `vercel.json`.'],
          files: ['vercel.json'],
          snippet: {
            language: 'json',
            code: JSON.stringify(
              {
                redirects: sample.map((p) => ({
                  source: p.from,
                  destination: p.to,
                  permanent: true,
                })),
              },
              null,
              2,
            ),
          },
        };
      return {
        steps: [
          'Add one-hop 301 rules on the web server (nginx shown; Apache: `Redirect 301 /old /new` in .htaccess).',
        ],
        files: ['nginx / .htaccess'],
        snippet: {
          language: 'nginx',
          code: sample.map((p) => `location = ${p.from} { return 301 ${p.to}; }`).join('\n'),
        },
      };
    },
  });
}

const redirects: Recipe = {
  id: 'redirects',
  patterns: ['redirects.*', /^links-internal\..*redirect/],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const r = redirectSnippet(input);
    return {
      ...r,
      title: 'Shorten redirects to a single permanent hop',
      steps: [
        'Update internal links, canonicals, hreflang and sitemap entries to point at the final URL directly — that removes most chains without touching server config.',
        'For external links you cannot change, make the first URL redirect straight to the final one with a 301/308 (not 302, not a chain).',
        ...r.steps,
      ],
    };
  },
};

const brokenLinks: Recipe = {
  id: 'broken-links',
  patterns: [
    /^links-(internal|external)\..*(broken|4\d\d|5\d\d|404|dead|error)/,
    /^response\..*(4xx|404|not-found)/,
  ],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const sources = input.issues
      .flatMap((i) =>
        Array.isArray(i.data?.sources)
          ? (i.data!.sources as string[])
          : i.data?.source
            ? [String(i.data.source)]
            : [],
      )
      .slice(0, 10);
    return {
      title: 'Fix broken links',
      steps: [
        'For each broken target: if the content moved, 301-redirect the old URL to the new one; if it is gone for good, update or remove the links pointing at it.',
        'Fix the link in the source (template, menu or content), not only the redirect — redirects slow crawlers and AI fetchers down.',
        ...(sources.length
          ? [`Pages that link to broken URLs include:\n${sources.map((s) => `- ${s}`).join('\n')}`]
          : []),
        `Broken URLs:\n${urlList(input)}`,
      ],
      files: [templateFile(input), 'navigation / footer components'],
    };
  },
};

const hreflang: Recipe = {
  id: 'hreflang',
  patterns: ['hreflang.*'],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: ['Set `alternates.languages` in each page’s metadata, including `x-default`.'],
        files: ['app/[lang]/<route>/page.tsx'],
        snippet: {
          language: 'ts',
          code: `alternates: {\n  canonical: '/en/pricing',\n  languages: { en: '/en/pricing', de: '/de/preise', 'x-default': '/en/pricing' },\n},`,
        },
      }),
      astro: () => ({
        steps: [
          'Configure `i18n` in astro.config and print `<link rel="alternate" hreflang>` for each locale in the layout (or use @astrojs/sitemap i18n option).',
        ],
        files: ['astro.config.mjs', 'src/layouts/Layout.astro'],
      }),
      nuxt: () => ({
        steps: [
          'Use `@nuxtjs/i18n` with `baseUrl` set; call `useLocaleHead()` and pass its links to `useHead`.',
        ],
        files: ['nuxt.config.ts', 'app.vue'],
      }),
      wordpress: () => ({
        steps: [
          'Let your multilingual plugin (WPML, Polylang, TranslatePress) output hreflang; link every translation to each other in the plugin, and check x-default.',
        ],
        files: ['WordPress: multilingual plugin'],
      }),
      shopify: () => ({
        steps: [
          'Shopify Markets outputs hreflang for published languages and markets: Settings → Markets / Languages. Remove theme code that adds its own alternates.',
        ],
        files: ['Shopify: Markets'],
      }),
      unknown: () => ({
        steps: [
          'Each language version lists all versions (including itself) and `x-default`, with absolute URLs that return 200 and are canonical.',
        ],
        files: ['<head> of each language version'],
        snippet: {
          language: 'html',
          code: `<link rel="alternate" hreflang="en" href="${input.origin}/en/" />\n<link rel="alternate" hreflang="de" href="${input.origin}/de/" />\n<link rel="alternate" hreflang="x-default" href="${input.origin}/en/" />`,
        },
      }),
    });
    return {
      ...fix,
      title: 'Fix hreflang annotations',
      steps: [
        'hreflang links must be reciprocal: if A points to B, B must point back to A.',
        ...fix.steps,
      ],
    };
  },
};

/** Security header values we are willing to recommend by default. */
export const SECURITY_HEADERS: Record<string, { header: string; value: string; re: RegExp }> = {
  hsts: {
    header: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
    re: /hsts|strict-transport/,
  },
  nosniff: {
    header: 'X-Content-Type-Options',
    value: 'nosniff',
    re: /nosniff|content-type-options/,
  },
  frame: { header: 'X-Frame-Options', value: 'SAMEORIGIN', re: /frame|clickjack/ },
  referrer: { header: 'Referrer-Policy', value: 'strict-origin-when-cross-origin', re: /referrer/ },
  permissions: {
    header: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
    re: /permissions-policy|feature-policy/,
  },
};

export function headersForCheck(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of Object.values(SECURITY_HEADERS)) if (h.re.test(id)) out[h.header] = h.value;
  if (!Object.keys(out).length && /headers?/.test(id))
    for (const h of Object.values(SECURITY_HEADERS)) out[h.header] = h.value;
  return out;
}

const securityHeaders: Recipe = {
  id: 'security-headers',
  patterns: [
    /^security\..*(hsts|strict-transport|nosniff|content-type-options|frame|clickjack|referrer|permissions-policy|headers?)/,
  ],
  impact: 'low',
  effort: 'minutes',
  auto: { repo: true },
  build(input) {
    const headers = headersForCheck(input.def.id);
    const f = headersFix(input, headers);
    return {
      ...f,
      title: 'Add security headers',
      steps: [
        ...(headers['Strict-Transport-Security']
          ? ['HSTS: start with this value; only add `preload` once every subdomain serves HTTPS.']
          : []),
        ...f.steps,
      ],
    };
  },
};

const csp: Recipe = {
  id: 'csp',
  patterns: [/^security\..*(csp|content-security)/],
  impact: 'low',
  effort: 'days',
  build(input) {
    const f = headersFix(input, {
      'Content-Security-Policy-Report-Only':
        "default-src 'self'; img-src 'self' data: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'",
    });
    return {
      ...f,
      title: 'Add a Content Security Policy (report-only first)',
      steps: [
        'Start in report-only mode, watch the browser console and reports for a week, add the sources you really use, then switch to `Content-Security-Policy`.',
        ...f.steps,
      ],
    };
  },
};

const https: Recipe = {
  id: 'https',
  patterns: [/^security\..*(https|http-|mixed|insecure|tls|ssl|certificate)/],
  impact: 'high',
  effort: 'hours',
  build(input) {
    return {
      title: 'Serve everything over HTTPS',
      steps: [
        'Redirect every http:// URL to https:// with one 301 at the server/CDN.',
        'Replace hard-coded http:// asset and link URLs in templates and content (mixed content).',
        input.stack.id === 'wordpress'
          ? 'WordPress: set both addresses to https in Settings → General, then search-replace old http URLs in the database (`wp search-replace "http://example.com" "https://example.com" --dry-run`).'
          : 'Search the codebase and CMS content for `http://` + your domain.',
        `Affected:\n${urlList(input)}`,
      ],
      files: [templateFile(input), 'server / CDN redirect settings'],
    };
  },
};

const performance: Recipe = {
  id: 'performance',
  patterns: ['performance.*', /^response\..*(slow|ttfb|size|compress|cache)/],
  impact: 'medium',
  effort: 'days',
  build(input) {
    const id = input.def.id;
    const stackTips = byStack(input, {
      nextjs: () => ({
        steps: [
          'Use `next/image` for images, `next/font` for fonts, and keep heavy client components out of the initial bundle (`dynamic()` import).',
        ],
        files: ['app/**', 'next.config.ts'],
      }),
      astro: () => ({
        steps: [
          'Use `astro:assets` `<Image>`; ship less JS (avoid `client:load` where `client:visible` or none works).',
        ],
        files: ['src/components/*'],
      }),
      nuxt: () => ({
        steps: [
          'Use `@nuxt/image` `<NuxtImg>`, prerender static routes, lazy-hydrate below-the-fold components.',
        ],
        files: ['nuxt.config.ts'],
      }),
      wordpress: () => ({
        steps: [
          'Use a page cache (host cache, WP Rocket, LiteSpeed Cache), serve images as WebP/AVIF, and remove unused plugins that add scripts to every page.',
        ],
        files: ['WordPress: caching plugin'],
      }),
      shopify: () => ({
        steps: [
          'Remove unused apps (they inject scripts), use `image_url` with `width` and `image_tag` with `loading: lazy` below the fold.',
        ],
        files: ['layout/theme.liquid', 'sections/*'],
      }),
      unknown: () => ({
        steps: [
          'Compress text responses (Brotli/gzip), cache static assets for a year with hashed file names, serve modern image formats, and defer non-critical scripts.',
        ],
        files: ['server / CDN config'],
      }),
    });
    const lead = /ttfb|server|slow/.test(id)
      ? [
          'Slow server responses also time out AI fetchers: cache HTML at a CDN or server, and check slow database queries.',
        ]
      : /compress/.test(id)
        ? ['Turn on Brotli or gzip for HTML, CSS, JS, JSON and SVG at the server or CDN.']
        : /cache/.test(id)
          ? [
              'Send `Cache-Control: public, max-age=31536000, immutable` for fingerprinted static assets, and a short max-age or revalidation for HTML.',
            ]
          : [];
    return {
      ...stackTips,
      title: input.def.title,
      steps: [
        ...lead,
        ...stackTips.steps,
        `Re-measure with PageSpeed Insights, then \`avc audit --only ${id}\`.`,
      ],
    };
  },
};

const viewport: Recipe = {
  id: 'viewport',
  patterns: [/^mobile\..*viewport/],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    return {
      title: 'Add a responsive viewport tag',
      steps: [
        input.stack.id === 'nextjs'
          ? 'Next.js adds the viewport tag by default; remove any custom `<meta name="viewport">` that disables scaling, or export `viewport` from `app/layout.tsx`.'
          : 'Add the tag below to the shared `<head>`.',
      ],
      files: [input.stack.id === 'nextjs' ? 'app/layout.tsx' : 'shared <head> template'],
      snippet: {
        language: 'html',
        code: '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      },
    };
  },
};

const serverErrors: Recipe = {
  id: 'server-errors',
  patterns: [/^response\..*(5xx|server-error|error|timeout)/],
  impact: 'high',
  effort: 'hours',
  build(input) {
    return {
      title: 'Fix pages that return server errors',
      steps: [
        'Open each URL and check the server or hosting logs at the time of the crawl.',
        'Errors served to crawlers (including AI crawlers) make engines drop or skip the page.',
        `Affected:\n${urlList(input)}`,
      ],
      files: ['server logs', templateFile(input)],
    };
  },
};

export const recipes: Recipe[] = [
  robotsMissing,
  robotsNoSitemap,
  robotsBlocksAll,
  sitemaps,
  noindex,
  canonical,
  redirects,
  brokenLinks,
  hreflang,
  csp,
  https,
  securityHeaders,
  performance,
  viewport,
  serverErrors,
];
