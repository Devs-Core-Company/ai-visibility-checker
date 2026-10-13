/**
 * Recipes for the checks added in the feature-parity pass: AI-context descriptions,
 * doctype, consistent redirects, cannibalisation, spelling, PDFs, embeddings-based
 * duplicates, rendered image size, image sitemaps, TLS, minification, phone renders,
 * ARIA nesting, rendered contrast, deep pagination, unsafe links, GA4 AI channel,
 * gated content, first-party facts and the newer agent discovery files.
 *
 * Exact ids only, and listed first in the registry so broader patterns never take them.
 */
import { byStack, templateFile, wpPlugin } from '../stacks.js';
import type { Recipe, RecipeInput, StackFix } from '../types.js';
import { evidenceStep, serverFix, urlsBlock, verifyStep } from './common.js';

function plain(
  id: string,
  impact: Recipe['impact'],
  effort: Recipe['effort'],
  build: (input: RecipeInput) => StackFix,
  extra: Partial<Recipe> = {},
): Recipe {
  return { id, patterns: [id], impact, effort, build, ...extra };
}

const descriptionThin = plain(
  'onpage.description-thin-for-ai',
  'low',
  'minutes',
  (input) => {
    const where = byStack(input, {
      wordpress: (i) => ({
        steps: [
          wpPlugin(i.stack)
            ? `Edit each page's meta description in the ${wpPlugin(i.stack) === 'yoast' ? 'Yoast SEO' : wpPlugin(i.stack) === 'rank-math' ? 'Rank Math' : 'All in One SEO'} box below the editor.`
            : 'Install an SEO plugin (Yoast SEO, Rank Math or All in One SEO) and fill in each page’s meta description.',
          'Or let AVC write and apply them: `avc write meta <site> --apply-wordpress` (dry run first, rollback saved).',
        ],
        files: ['WordPress: SEO plugin meta box'],
      }),
      'nextjs-app': () => ({
        steps: ['Set `description` in each route’s `metadata` export (or `generateMetadata`).'],
        files: ['app/**/page.tsx'],
        snippet: {
          language: 'tsx',
          code: `export const metadata = {
  description:
    'Fixed-price websites for London small businesses: design, build and monthly care, live in four weeks.',
};`,
        },
      }),
      unknown: (i) => ({
        steps: ['Update the <meta name="description"> in the template or CMS field for each page.'],
        files: [templateFile(i)],
      }),
    });
    return {
      title: 'Write descriptions that give AI enough context',
      steps: [
        'Aim for 120–160 characters: what the page offers, who it is for, and one concrete detail (place, price, result). Avoid repeating the title.',
        'Draft them with `avc write meta <site>` (uses your AI key, or --mock), then edit for accuracy.',
        ...where.steps,
        ...urlsBlock(input),
        verifyStep(input),
      ],
      files: where.files,
      snippet: where.snippet,
    };
  },
  { auto: { wordpress: true } },
);

const titleSameAsH1 = plain('onpage.title-same-as-h1', 'low', 'hours', (input) => ({
  title: 'Write titles that do more than repeat the H1',
  steps: [
    'Keep the H1 as the page heading. Rewrite the title to lead with the same topic and add what searchers compare on: the brand, the place, the offer or a number.',
    input.stack.id === 'wordpress'
      ? 'In your SEO plugin, change the title template (e.g. "%%title%% | %%sitename%%") and override it on key pages.'
      : 'Change the title template in the shared layout so it is built from the page title plus the brand, and override it on key pages.',
    ...evidenceStep(input, 'Examples'),
    verifyStep(input),
  ],
  files: [templateFile(input)],
}));

const faviconBroken = plain('onpage.favicon-broken', 'low', 'minutes', (input) =>
  byStack(input, {
    wordpress: () => ({
      steps: [
        'Appearance → Customize → Site Identity → Site Icon: upload a square PNG of at least 512×512.',
        'Remove any hard-coded <link rel="icon"> in the theme header that points at a missing file.',
        verifyStep(input),
      ],
      files: ['WordPress: Customizer → Site Identity'],
    }),
    'nextjs-app': () => ({
      steps: [
        'Put `icon.png` (or `favicon.ico`) in the `app/` folder; Next.js serves it and adds the link tag.',
        verifyStep(input),
      ],
      files: ['app/icon.png', 'app/favicon.ico'],
    }),
    unknown: (i) => ({
      steps: [
        'Upload the icon file to the path in the <link rel="icon"> tag (or change the tag to the file you have) and make sure it returns 200 with an image content type.',
        ...evidenceStep(i, 'Declared favicon'),
        verifyStep(i),
      ],
      files: [templateFile(i)],
      snippet: {
        language: 'html',
        code: '<link rel="icon" href="/favicon.png" type="image/png" sizes="48x48">',
      },
    }),
  }),
);

const noindexNofollow = plain('crawlability.noindex-nofollow', 'low', 'minutes', (input) => ({
  title: 'Let crawlers follow links on noindex pages',
  steps: [
    'Change the robots directive on these pages from "noindex, nofollow" to "noindex, follow".',
    input.stack.id === 'wordpress'
      ? 'In Yoast or Rank Math, open the page’s Advanced settings and set "Should search engines follow links on this page?" to Yes.'
      : 'Update the template or header rule that sets the robots meta tag or X-Robots-Tag.',
    ...urlsBlock(input),
    verifyStep(input),
  ],
  files: [templateFile(input)],
  snippet: { language: 'html', code: '<meta name="robots" content="noindex, follow">' },
}));

const doctype = plain('response.doctype-missing', 'low', 'minutes', (input) => ({
  title: 'Start every page with <!DOCTYPE html>',
  steps: [
    'Make `<!DOCTYPE html>` the first line of the document in the base template, with nothing before it (no whitespace output, BOM or plugin comments).',
    input.stack.id === 'wordpress'
      ? 'Check header.php in the active theme; a plugin printing output before the theme can also push the doctype down.'
      : 'Check the root layout or server template; output from includes or middleware before the template can push it down.',
    ...urlsBlock(input),
    verifyStep(input),
  ],
  files: [
    input.stack.id === 'wordpress' ? 'wp-content/themes/<theme>/header.php' : templateFile(input),
  ],
  snippet: { language: 'html', code: '<!DOCTYPE html>\n<html lang="en">' },
}));

const mixedRedirects = plain('redirects.mixed-status', 'medium', 'hours', (input) => {
  const server = serverFix(input, {
    nginx: 'location ~ ^/old-section/(.*)$ { return 301 /new-section/$1; }',
    apache: 'RedirectMatch 301 ^/old-section/(.*)$ /new-section/$1',
    vercel:
      '{ "redirects": [{ "source": "/old-section/:path*", "destination": "/new-section/:path*", "permanent": true }] }',
    netlify:
      '[[redirects]]\n  from = "/old-section/*"\n  to = "/new-section/:splat"\n  status = 301',
  });
  return {
    title: 'Use one permanent rule for each moved section',
    steps: [
      'List where the temporary redirects come from (a redirect plugin, server config, CDN rules, application code). Usually one leftover rule makes the 302s.',
      'Replace it with a single 301 rule for the section, and remove duplicates so one place owns the mapping.',
      ...evidenceStep(input, 'Temporary redirects'),
      ...server.steps,
      verifyStep(input),
    ],
    files: server.files,
    snippet: server.snippet,
  };
});

const cannibalisation = plain(
  'content.cannibalisation',
  'medium',
  'days',
  (input) => ({
    title: 'Give each topic one page',
    steps: [
      'For each group, pick the page that should rank: usually the one with the most links, traffic or the best content (check Search Console).',
      'If the others cover the same need, merge their useful parts into it and 301-redirect them to it.',
      'If they serve different needs, make that visible: rewrite the title and H1 of each around its own angle (audience, location, product, question) and link between them.',
      ...evidenceStep(input, 'Competing pages'),
      verifyStep(input),
    ],
    files: [],
  }),
  { tier: 'manual' },
);

const repeatedWords = plain('content.repeated-words', 'low', 'minutes', (input) => ({
  title: 'Remove doubled words',
  steps: [
    'Edit each sentence below in the CMS and remove the repeated word.',
    ...evidenceStep(input, 'Sentences'),
    'Run a spelling and grammar check across the site to catch other slips: `avc connect spelling`.',
    verifyStep(input),
  ],
  files: [],
}));

const spelling = plain(
  'content.spelling',
  'low',
  'hours',
  (input) => ({
    title: 'Correct spelling and grammar',
    steps: [
      'Fix the listed mistakes in the CMS. LanguageTool can suggest the correction for each one.',
      'Add brand, product and people names to the LanguageTool dictionary (or AVC_LANGUAGETOOL_IGNORE) so they are not flagged again.',
      ...evidenceStep(input, 'Examples'),
      ...urlsBlock(input),
      verifyStep(input),
    ],
    files: [],
  }),
  { tier: 'manual' },
);

const pdfTitle = plain('content.pdf-title-missing', 'low', 'minutes', (input) => ({
  title: 'Give PDFs a real title',
  steps: [
    'Open the source document and set its title: Word → File → Info → Properties → Title; Acrobat → File → Properties → Description → Title.',
    'In Acrobat, set Initial View → Show: Document Title so viewers see it too.',
    'Re-export and upload the PDF at the same URL (so links keep working).',
    ...urlsBlock(input, 10, 'PDFs'),
    verifyStep(input),
  ],
  files: [],
}));

const semanticDupes = plain(
  'duplicates.semantic',
  'low',
  'days',
  (input) => ({
    title: 'Merge or differentiate pages with the same meaning',
    steps: [
      'Read each pair side by side. If they answer the same need, keep the stronger page, move anything unique from the other into it, and 301 the weaker one.',
      'If both are needed, give each its own focus (audience, location, use case) and make the first paragraph say so.',
      ...evidenceStep(input, 'Pairs'),
      verifyStep(input),
    ],
    files: [],
  }),
  { tier: 'manual' },
);

const offTopic = plain(
  'content.off-topic',
  'low',
  'hours',
  (input) => ({
    title: 'Connect or retire off-topic pages',
    steps: [
      'For each page: if it supports your core topics, add context and links that tie it to them; if it is useful but unrelated, consider a separate section or site; if it serves no purpose, noindex or remove it.',
      ...urlsBlock(input),
      verifyStep(input),
    ],
    files: [],
  }),
  { tier: 'manual' },
);

const oversized = plain('images.oversized-rendered', 'medium', 'hours', (input) => {
  const s = byStack(input, {
    wordpress: () => ({
      steps: [
        'Insert images at the size they are shown (Large or Medium rather than Full size) and keep WordPress’s automatic srcset (do not strip it in the theme).',
        'An image optimisation plugin (or your host’s image CDN) can serve resized WebP/AVIF automatically.',
      ],
      files: ['WordPress: Media settings', 'image optimisation plugin'],
    }),
    'nextjs-app': () => ({
      steps: [
        'Use next/image with `sizes` so the browser downloads a file close to the displayed width.',
      ],
      files: ['components using <img>'],
      snippet: {
        language: 'tsx',
        code: `import Image from 'next/image';

<Image src="/team.jpg" alt="Our team" width={1600} height={900} sizes="(max-width: 768px) 100vw, 400px" />`,
      },
    }),
    unknown: (i) => ({
      steps: [
        'Add srcset and sizes so smaller screens get smaller files, and resize the source to at most twice its largest displayed width.',
      ],
      files: [templateFile(i)],
      snippet: {
        language: 'html',
        code: '<img src="/team-800.jpg" srcset="/team-400.jpg 400w, /team-800.jpg 800w, /team-1600.jpg 1600w" sizes="(max-width: 768px) 100vw, 400px" width="800" height="450" alt="Our team">',
      },
    }),
  });
  return {
    title: 'Serve images at the size they are displayed',
    steps: [
      ...s.steps,
      ...evidenceStep(input, 'Images'),
      verifyStep(input, 'Render again (--render) and'),
    ],
    files: s.files,
    snippet: s.snippet,
  };
});

const imageSitemap = plain('sitemaps.no-image-entries', 'low', 'minutes', (input) =>
  byStack(input, {
    wordpress: () => ({
      steps: [
        'Yoast SEO and Rank Math add the images in each post to the sitemap automatically; make sure the sitemap module is on and the images are in the content (not only in CSS).',
        verifyStep(input),
      ],
      files: ['WordPress: SEO plugin → Sitemap settings'],
    }),
    shopify: () => ({
      steps: [
        'Shopify adds product images to its sitemap; if they are missing, check that products have images and are published to the Online Store.',
        verifyStep(input),
      ],
      files: ['Shopify admin → Products'],
    }),
    unknown: (i) => ({
      steps: [
        'Add <image:image> entries for each page’s main images to the sitemap generator.',
        verifyStep(i),
      ],
      files: ['sitemap generator', 'sitemap.xml'],
      snippet: {
        language: 'xml',
        code: `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>${i.origin}/projects/kitchen</loc>
    <image:image><image:loc>${i.origin}/images/kitchen.jpg</image:loc></image:image>
  </url>
</urlset>`,
      },
    }),
  }),
);

function tlsFix(input: RecipeInput, title: string, first: string[]): StackFix {
  const hosted = byStack(input, {
    hosted: () => ({
      steps: [
        'Your platform manages the certificate: check the custom-domain settings (DNS records must point at the platform) and contact support if it does not renew.',
      ],
      files: ['Platform → Domains'],
    }),
    unknown: () => ({ steps: [], files: [] }),
  });
  return {
    title,
    steps: [
      ...first,
      ...hosted.steps,
      'On your own server with Let’s Encrypt: run `sudo certbot renew --dry-run`, fix what it reports, then `sudo certbot renew` and reload the web server.',
      'Behind a CDN (Cloudflare, Fastly, CloudFront): check the edge certificate and the origin certificate separately.',
      'Add certificate-expiry monitoring (AVC alerts on this check when scheduled: `avc schedule`).',
      ...evidenceStep(input),
      verifyStep(input),
    ],
    files: [...hosted.files, 'web server TLS config', 'CDN dashboard'],
  };
}

const tlsExpired = plain('security.tls-expired', 'high', 'minutes', (input) =>
  tlsFix(input, 'Renew the expired certificate', [
    'Renew the certificate now: visitors see a full-page warning until you do.',
  ]),
);
const tlsExpiring = plain('security.tls-expiring', 'high', 'minutes', (input) =>
  tlsFix(input, 'Renew the certificate before it expires', [
    'Renew now and find out why automatic renewal did not happen ~30 days before expiry.',
  ]),
);
const tlsInvalid = plain('security.tls-invalid', 'high', 'hours', (input) =>
  tlsFix(input, 'Install a certificate browsers trust', [
    'Make sure the certificate covers this exact host name (and www / apex if both are used) and that the server sends the full chain (fullchain.pem, not cert.pem).',
    'Test with https://www.ssllabs.com/ssltest/ after the change.',
  ]),
);

const minify = plain('performance.unminified-assets', 'low', 'hours', (input) => {
  const s = byStack(input, {
    wordpress: () => ({
      steps: [
        'Turn on CSS and JS minification in your cache or performance plugin (or your host’s optimisation settings), then clear the cache.',
      ],
      files: ['WordPress: cache / performance plugin'],
    }),
    nextjs: () => ({
      steps: [
        'Next.js minifies in production builds: make sure the site runs `next build` output, not `next dev`, and that files in /public are minified before copying.',
      ],
      files: ['next.config.js', 'public/'],
    }),
    hosted: () => ({
      steps: [
        'Hosted builders minify their own files; custom code you paste in can be minified before adding it.',
      ],
      files: ['Site settings → Custom code'],
    }),
    unknown: () => ({
      steps: [
        'Run your bundler in production mode (Vite, webpack, esbuild all minify), or enable minification at the CDN (e.g. Cloudflare Auto Minify successors / build-time tools).',
      ],
      files: ['build config'],
    }),
  });
  return {
    title: 'Minify CSS and JavaScript',
    steps: [...s.steps, ...evidenceStep(input, 'Files'), verifyStep(input)],
    files: s.files,
  };
});

function mobileRecipe(
  id: string,
  title: string,
  steps: string[],
  snippet?: StackFix['snippet'],
): Recipe {
  return plain(id, id === 'mobile.content-parity' ? 'high' : 'medium', 'hours', (input) => ({
    title,
    steps: [
      ...steps,
      ...evidenceStep(input),
      ...urlsBlock(input),
      verifyStep(input, 'Render again (--render) and'),
    ],
    files: [templateFile(input), 'stylesheets'],
    snippet,
  }));
}

const mobileRecipes = [
  mobileRecipe(
    'mobile.horizontal-scroll',
    'Make the page fit a phone screen',
    [
      'Open the page in Chrome DevTools device mode and scroll right to find the element that overflows.',
      'Common fixes: max-width: 100% on images and embeds, overflow-x: auto on wide tables and code blocks, overflow-wrap: anywhere on long URLs, and no fixed widths above ~360px.',
    ],
    {
      language: 'css',
      code: 'img, video, iframe { max-width: 100%; height: auto; }\ntable { display: block; overflow-x: auto; }\n.content { overflow-wrap: anywhere; }',
    },
  ),
  mobileRecipe(
    'mobile.tap-targets',
    'Make buttons and links big enough to tap',
    [
      'Give icon buttons, pagination links and small nav links at least 24×24px of tappable area; padding counts, so the icon itself can stay small.',
    ],
    {
      language: 'css',
      code: '.icon-button, .pagination a, nav a { min-width: 24px; min-height: 24px; padding: 8px; }',
    },
  ),
  mobileRecipe('mobile.content-parity', 'Give phones the same content as desktops', [
    'Compare the page in desktop and phone views. Content hidden with display:none on small screens, or left out of a mobile template, is not indexed.',
    'Collapse long sections behind accessible toggles (the text stays in the HTML) instead of removing them on phones.',
  ]),
  mobileRecipe('mobile.interstitial', 'Tone down pop-ups on phones', [
    'Delay newsletter or offer pop-ups until the visitor scrolls or is about to leave, and show them as a small banner on phones.',
    'Keep cookie notices and age gates compact (a bottom bar rather than a full-screen layer).',
  ]),
  mobileRecipe('mobile.blocked-resources', 'Stop resources failing for phones', [
    'Request each listed URL with a mobile user agent (curl -A "<phone UA>") and compare with desktop.',
    'Remove device-specific CDN, firewall or redirect rules that break them, and serve the same assets to every device.',
  ]),
  mobileRecipe(
    'mobile.rendered-small-text',
    'Raise the smallest text size on phones',
    [
      'Set body text to 16px and secondary text to at least 12px in the mobile breakpoint; check footer, captions and form hints.',
    ],
    {
      language: 'css',
      code: 'body { font-size: 16px; }\nsmall, .caption, footer { font-size: max(12px, 0.8rem); }',
    },
  ),
];

const roleNesting = plain('accessibility.role-nesting', 'low', 'hours', (input) => ({
  title: 'Put ARIA roles inside their containers',
  steps: [
    'Wrap tabs in role="tablist", options in role="listbox", menu items in role="menu", and rows in a table or grid.',
    'If an element is not really that kind of control, remove the role and use plain HTML (a button or a link).',
    ...evidenceStep(input),
    verifyStep(input),
  ],
  files: [templateFile(input), 'components'],
  snippet: {
    language: 'html',
    code: '<div role="tablist" aria-label="Plans">\n  <button role="tab" aria-selected="true" aria-controls="p1">Monthly</button>\n  <button role="tab" aria-selected="false" aria-controls="p2">Yearly</button>\n</div>',
  },
}));

const contrastRendered = plain('accessibility.low-contrast-rendered', 'low', 'hours', (input) => ({
  title: 'Raise text contrast',
  steps: [
    'Darken the text colour (or lighten the background) in the stylesheet until each sample reaches 4.5:1, or 3:1 for large text. Light grey on white is the usual culprit.',
    'Update the design tokens or theme colours so every page benefits.',
    ...evidenceStep(input, 'Samples'),
    verifyStep(input, 'Render again (--render) and'),
  ],
  files: ['stylesheets / theme colours'],
}));

const deepSeries = plain('pagination.deep-series', 'low', 'hours', (input) => ({
  title: 'Shorten the path to deep list pages',
  steps: [
    'Show more page links on each list page (1 2 3 … 10 … last) rather than only next/previous.',
    'Split long lists into sub-categories or crawlable filter pages, and link the best items from elsewhere.',
    'For lists that load quickly, add a view-all page and link to it.',
    ...urlsBlock(input, 10, 'Series'),
    verifyStep(input),
  ],
  files: [templateFile(input)],
}));

const unsafeLinks = plain(
  'links-external.unsafe',
  'high',
  'minutes',
  (input) => ({
    title: 'Remove links to flagged sites',
    steps: [
      'Remove or replace each flagged link today.',
      'If you did not add the link, treat the page as possibly hacked: check recent edits, injected scripts and user accounts, and change passwords.',
      'Moderate comments and user content so spam links do not come back (rel="ugc nofollow" on user links).',
      ...evidenceStep(input),
      verifyStep(input),
    ],
    files: [],
  }),
  { tier: 'manual' },
);

const aiReferrals = plain('analytics.no-ai-referrals', 'low', 'minutes', (input) => ({
  title: 'Track AI assistant visits in GA4',
  steps: [
    'GA4 → Admin → Data display → Channel groups → Create new channel group.',
    'Add a channel "AI assistants" with the condition Source matches regex (below), and move it above Referral.',
    'Use the new channel group in Acquisition reports; compare it with `avc visibility` runs to see whether being named turns into visits.',
    verifyStep(input),
  ],
  files: ['GA4 → Admin → Channel groups'],
  snippet: {
    language: 'text',
    code: '^(chatgpt\\.com|chat\\.openai\\.com|perplexity\\.ai|gemini\\.google\\.com|claude\\.ai|copilot\\.microsoft\\.com|.*\\.perplexity\\.ai)$|chatgpt|perplexity',
  },
}));

const gated = plain(
  'geo-content.gated-content',
  'medium',
  'hours',
  (input) => ({
    title: 'Keep part of gated pages public, and mark paywalls up',
    steps: [
      'Make a meaningful part of each page public: a summary, the first section and the key facts, so AI systems can understand and cite it.',
      'For a paywall, add isAccessibleForFree: false and a hasPart with a cssSelector that marks the hidden section (Google’s paywalled content markup).',
      ...evidenceStep(input),
      ...urlsBlock(input),
      verifyStep(input),
    ],
    files: [templateFile(input)],
    snippet: {
      language: 'json',
      code: `{
  "@context": "https://schema.org",
  "@type": "Article",
  "isAccessibleForFree": false,
  "hasPart": { "@type": "WebPageElement", "isAccessibleForFree": false, "cssSelector": ".paywalled" }
}`,
    },
  }),
  { tier: 'manual' },
);

const firstPartyFacts = plain(
  'geo-content.no-first-party-facts',
  'medium',
  'days',
  (input) => ({
    title: 'Publish the facts customers ask AI about',
    steps: [
      'List the questions prospects ask before buying (price, what is included, how long, delivery, returns, guarantees).',
      'Answer them on your own site: a pricing or plans page, an FAQ page and short policy pages, in plain text that can be quoted.',
      'Mark them up: FAQPage for the FAQ, Product/Offer or Service with price details, and link them from the main navigation or footer.',
      verifyStep(input),
    ],
    files: [],
  }),
  { tier: 'manual' },
);

const linkHeader = plain('agentic.link-header-missing', 'low', 'minutes', (input) => {
  const header =
    'Link: </.well-known/api-catalog>; rel="api-catalog", </.well-known/mcp/server-card.json>; rel="describedby"';
  const s = serverFix(input, {
    nginx: `location = / {\n  add_header ${header.replace(': ', " '")}';\n}`,
    apache: `<Location "/">\n  Header add ${header.replace(': ', " '")}'\n</Location>`,
    vercel: `{ "headers": [{ "source": "/", "headers": [{ "key": "Link", "value": "${header.slice(6).replace(/"/g, '\\"')}" }] }] }`,
    netlify: `[[headers]]\n  for = "/"\n  [headers.values]\n    Link = '''${header.slice(6)}'''`,
  });
  return {
    title: 'Advertise discovery documents in a Link header',
    steps: [
      'Add a Link header to the home page response pointing at each discovery document.',
      ...evidenceStep(input, 'Documents'),
      ...s.steps,
      verifyStep(input),
    ],
    files: s.files,
    snippet: s.snippet,
  };
});

const dnsAid = plain('agentic.dns-aid-missing', 'low', 'minutes', (input) => ({
  title: 'Publish DNS-AID records for your agent endpoints',
  steps: [
    'At your DNS provider, add an SVCB (or HTTPS) record for each agent protocol you offer, pointing at the endpoint host.',
    'Enable DNSSEC for the zone so agents can trust the answer.',
    verifyStep(input),
  ],
  files: ['DNS provider'],
  snippet: {
    language: 'text',
    code: `_mcp._agents.${input.host.replace(/^www\./, '')}.  3600 IN SVCB 1 mcp.${input.host.replace(/^www\./, '')}. alpn="h2" port=443\n_a2a._agents.${input.host.replace(/^www\./, '')}.  3600 IN SVCB 1 ${input.host}. alpn="h2" port=443`,
  },
}));

const authMd = plain('agentic.auth-md-missing', 'low', 'minutes', (input) => ({
  title: 'Publish /auth.md for agents',
  steps: [
    'Write /auth.md in plain Markdown: how an agent registers (URL), which OAuth flows and scopes you support, and whether a human must approve access.',
    'Serve it with Content-Type: text/markdown at the site root.',
    verifyStep(input),
  ],
  files: ['public/auth.md'],
  snippet: {
    language: 'markdown',
    code: `# Agent access to ${input.host}\n\n- Register: ${input.origin}/oauth/register (OAuth 2.0 Dynamic Client Registration)\n- Authorise: authorization code with PKCE (S256)\n- Scopes: read:orders, write:bookings\n- Human approval: required for write scopes\n- Metadata: ${input.origin}/.well-known/oauth-protected-resource`,
  },
}));

const skillsIndex = plain('agentic.agent-skills-invalid', 'low', 'minutes', (input) => ({
  title: 'Complete the agent skills index',
  steps: [
    'Give every entry a name, description, url and sha256 digest, and add a $schema field.',
    ...evidenceStep(input, 'Problems'),
    verifyStep(input),
  ],
  files: ['/.well-known/agent-skills/index.json'],
  snippet: {
    language: 'json',
    code: `{
  "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  "skills": [
    {
      "name": "book-appointment",
      "type": "skill-md",
      "description": "Book, move or cancel an appointment.",
      "url": "${input.origin}/.well-known/agent-skills/book-appointment/SKILL.md",
      "sha256": "<sha256 of the file>"
    }
  ]
}`,
  },
}));

const acp = plain('agentic-commerce.acp-invalid', 'low', 'hours', (input) => ({
  title: 'Fix the ACP discovery file',
  steps: [
    'Include the fields below, following the current Agentic Commerce Protocol specification.',
    ...evidenceStep(input, 'Problems'),
    verifyStep(input),
  ],
  files: ['/.well-known/acp.json'],
  snippet: {
    language: 'json',
    code: `{
  "protocol": { "name": "acp", "version": "2026-01-30" },
  "api_base_url": "${input.origin}/acp",
  "transports": ["https"],
  "capabilities": { "services": ["checkout"] }
}`,
  },
}));

export const recipes: Recipe[] = [
  descriptionThin,
  titleSameAsH1,
  faviconBroken,
  noindexNofollow,
  doctype,
  mixedRedirects,
  cannibalisation,
  repeatedWords,
  spelling,
  pdfTitle,
  semanticDupes,
  offTopic,
  oversized,
  imageSitemap,
  tlsExpired,
  tlsExpiring,
  tlsInvalid,
  minify,
  ...mobileRecipes,
  roleNesting,
  contrastRendered,
  deepSeries,
  unsafeLinks,
  aiReferrals,
  gated,
  firstPartyFacts,
  linkHeader,
  dnsAid,
  authMd,
  skillsIndex,
  acp,
];
