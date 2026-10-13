/**
 * Crawlability recipes beyond the basics in technical.ts: robots.txt health and syntax,
 * AI-bot groups in robots.txt, tags that break out of <head>, conflicting robots directives,
 * snippet controls, Search Console findings and crawl-structure problems.
 */
import { FIX_AI_BOTS } from '../bots.js';
import { generateRobotsTxt } from '../generate.js';
import { byStack, metaFix, seoPluginLabel, templateFile, wpPlugin } from '../stacks.js';
import type { Recipe, RecipeInput, StackFix } from '../types.js';
import { robotsFix } from './ai-access.js';
import { evidenceStep, serverFix, urlsBlock, verifyStep } from './common.js';

function currentRobots(input: RecipeInput): string {
  return input.result?.robots?.found ? (input.result.robots.body ?? '') : '';
}

// ---------------------------------------------------------------------------
// robots.txt: the file itself does not load properly
// ---------------------------------------------------------------------------

const robotsFileHealth: Recipe = {
  id: 'robots-file-health',
  patterns: [/^crawlability\.robots-(txt-server-error|txt-unreachable|is-html)$/],
  impact: 'high',
  effort: 'hours',
  build(input) {
    const id = input.def.id;
    const html = id.endsWith('is-html');
    const test = `curl -sS -o /dev/null -w "%{http_code} %{content_type}\\n" -A "Googlebot" ${input.origin}/robots.txt`;
    const intro = [
      html
        ? '/robots.txt is answered by an HTML page (usually the 404 template or a single-page-app fallback sent with status 200). Serve a real plain-text file, or a genuine 404 if you have no rules.'
        : 'Search engines pause crawling when /robots.txt fails with a 5xx or times out, so this comes before every other fix.',
      `Test it the way a crawler does: \`${test}\`. You want \`200 text/plain\` (or \`404\`), answered in well under a second.`,
    ];
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Serve robots from `public/robots.txt` or `app/robots.ts` (not both).',
          'Check `proxy.ts` / `middleware.ts`: exclude `robots.txt` from its `matcher`, so auth, locale or bot rules never run on it.',
          html
            ? 'A catch-all route (`app/[...slug]/page.tsx`) or a rewrite to `/index.html` is answering /robots.txt. Adding the file stops that.'
            : 'If `app/robots.ts` fetches data, make it static (no fetch) so it cannot fail at runtime.',
        ],
        files: ['public/robots.txt or app/robots.ts', 'proxy.ts / middleware.ts (matcher)'],
        snippet: {
          language: 'ts',
          code: `// proxy.ts (middleware.ts on older Next.js): keep robots.txt and sitemaps out of it
export const config = {
  matcher: ['/((?!_next/|robots\\\\.txt|sitemap.*\\\\.xml|favicon\\\\.ico).*)'],
};`,
        },
      }),
      spa: () => ({
        steps: [
          'Put `robots.txt` in `public/` so the build copies it to the output root.',
          'The host’s single-page-app fallback (rewrite everything to /index.html) must only apply when no real file exists. On Netlify use `/*  /index.html  200` in `_redirects` (files win); on Vercel, rewrites run after the filesystem.',
        ],
        files: ['public/robots.txt', '_redirects / vercel.json rewrites'],
      }),
      wordpress: () => ({
        steps: [
          `WordPress generates /robots.txt through PHP, so a PHP error or a slow plugin breaks it. Upload a static \`robots.txt\` next to wp-config.php (or edit it in ${seoPluginLabel(input.stack)}) so it no longer depends on WordPress.`,
          'Check security plugins (Wordfence, iThemes/Solid, All-In-One WP Security) and the host firewall for rules that block or rate-limit crawler user agents on /robots.txt.',
          'If a caching plugin or CDN cached an error page for /robots.txt, purge it.',
        ],
        files: ['robots.txt (WordPress root)', 'security plugin / host firewall'],
      }),
      shopify: () => ({
        steps: [
          'Shopify serves /robots.txt itself. If you customised it, open `templates/robots.txt.liquid` and fix any Liquid error, or delete the template to fall back to Shopify’s default.',
          'If the domain is proxied through Cloudflare, check its WAF and Bot Fight Mode are not challenging /robots.txt.',
        ],
        files: ['templates/robots.txt.liquid'],
      }),
      hosted: () => ({
        steps: [
          'The platform serves /robots.txt. Check its SEO settings for a custom robots.txt with errors, and contact support if it keeps failing.',
          'If you proxy the domain through Cloudflare, make sure no WAF, bot or redirect rule touches /robots.txt.',
        ],
        files: ['Platform SEO settings', 'Cloudflare rules (if proxied)'],
      }),
      unknown: (i) =>
        serverFix(
          i,
          {
            nginx: `# serve robots.txt as a static plain-text file, never through the app
location = /robots.txt {
    root /var/www/site;          # folder that holds robots.txt
    default_type text/plain;
    try_files $uri =404;
    access_log off;
}`,
            apache: `# .htaccess: serve the real file, never hand /robots.txt to the app
RewriteEngine On
RewriteRule ^robots\\.txt$ - [L]
<Files "robots.txt">
  ForceType text/plain
</Files>`,
            vercel: `{
  "headers": [
    { "source": "/robots.txt", "headers": [{ "key": "Content-Type", "value": "text/plain; charset=utf-8" }] }
  ]
}`,
            netlify: `# _redirects: real files are served before this fallback
/*  /index.html  200`,
            cloudflare: `Security → WAF → Custom rules → Create rule
  If: (http.request.uri.path eq "/robots.txt")
  Then: Skip → all remaining custom rules, rate limiting and Bot Fight Mode
Caching → Cache Rules: do not cache error responses for /robots.txt`,
          },
          [
            'Make sure the web server serves the file directly; firewalls and app code should not touch it.',
          ],
        ),
    });
    return {
      ...fix,
      title: html ? 'Serve robots.txt as plain text' : 'Make robots.txt load reliably',
      steps: [...intro, ...fix.steps, verifyStep(input)],
      acceptance: [`${input.origin}/robots.txt returns 200 text/plain (or 404) quickly`],
    };
  },
};

// ---------------------------------------------------------------------------
// robots.txt: content problems
// ---------------------------------------------------------------------------

const FIELD_TYPOS: Record<string, string> = {
  dissallow: 'Disallow',
  disalow: 'Disallow',
  dissalow: 'Disallow',
  disallowed: 'Disallow',
  useragent: 'User-agent',
  'user-agents': 'User-agent',
  'user agent': 'User-agent',
  allowed: 'Allow',
  'site-map': 'Sitemap',
  sitemaps: 'Sitemap',
};

const LEGACY_TOKENS = ['anthropic-ai', 'claude-web'];

function canonicalToken(agent: string): string {
  const norm = agent.toLowerCase().replace(/[\s_-]/g, '');
  const hit = FIX_AI_BOTS.find((b) => b.token.toLowerCase().replace(/[\s_-]/g, '') === norm);
  return hit?.token ?? agent;
}

interface Group {
  agents: string[];
  lines: string[];
}

/** Merge groups that name exactly the same single agent into the first one. */
function mergeDuplicateGroups(text: string): string {
  const head: string[] = [];
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const line of text.split('\n')) {
    const m = /^\s*user-agent\s*:\s*(.+?)\s*$/i.exec(line);
    if (m) {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], lines: [] };
        groups.push(cur);
      }
      cur.agents.push(m[1]!);
      lastWasAgent = true;
      continue;
    }
    if (line.trim() && !line.trim().startsWith('#')) lastWasAgent = false;
    if (cur) cur.lines.push(line);
    else head.push(line);
  }
  const out: Group[] = [];
  for (const g of groups) {
    const same =
      g.agents.length === 1
        ? out.find(
            (o) =>
              o.agents.length === 1 && o.agents[0]!.toLowerCase() === g.agents[0]!.toLowerCase(),
          )
        : undefined;
    if (same) same.lines.push(...g.lines.filter((l) => l.trim() && !/^\s*sitemap\s*:/i.test(l)));
    else out.push({ agents: [...g.agents], lines: [...g.lines] });
  }
  return [
    ...head,
    ...out.flatMap((g) => [...g.agents.map((a) => `User-agent: ${a}`), ...g.lines]),
  ].join('\n');
}

/** Rewrite robots.txt for the given check: fix typos, drop unsupported or delaying lines. */
export function cleanRobots(body: string, checkId: string): string {
  const dropDelay = /crawl-delay/.test(checkId);
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const fixed = lines.map((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return raw;
    const code = line.replace(/\s+#.*$/, '');
    const m = /^([A-Za-z][A-Za-z -]*?)\s*:\s*(.*)$/.exec(code);
    if (!m) return `# ${line}   (removed: not a "Field: value" line)`;
    let field = m[1]!;
    let value = m[2]!.trim();
    const lower = field.toLowerCase();
    if (FIELD_TYPOS[lower]) field = FIELD_TYPOS[lower];
    const f = field.toLowerCase();
    if (/^(noindex|nofollow|host|clean-param|request-rate|visit-time)$/.test(f))
      return `# ${line}   (removed: not supported by Google; use a robots meta tag, X-Robots-Tag or a redirect)`;
    if (f === 'crawl-delay' && dropDelay)
      return `# ${line}   (removed: slows crawlers that honour it; fix server capacity instead)`;
    if (f === 'user-agent') value = canonicalToken(value);
    if ((f === 'allow' || f === 'disallow') && value && !/^[/*]/.test(value)) value = `/${value}`;
    const known =
      /^(user-agent|allow|disallow|sitemap|crawl-delay|content-signal|content-usage)$/.test(f);
    if (!known) return `# ${line}   (removed: unknown field)`;
    const name =
      f === 'user-agent'
        ? 'User-agent'
        : f === 'crawl-delay'
          ? 'Crawl-delay'
          : f === 'content-signal'
            ? 'Content-Signal'
            : f === 'content-usage'
              ? 'Content-Usage'
              : f.charAt(0).toUpperCase() + f.slice(1);
    return `${name}: ${value}`;
  });
  return mergeDuplicateGroups(fixed.join('\n'));
}

const robotsContent: Recipe = {
  id: 'robots-content',
  patterns: [
    /^crawlability\.robots-(syntax|unsupported-rules|too-large|crawl-delay)$/,
    /^ai-crawlers\.(duplicate-groups|misspelt-tokens|legacy-tokens-only|backwards-policy|crawl-delay-high)$/,
  ],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    const id = input.def.id;
    const body = currentRobots(input) || 'User-agent: *\nAllow: /\n';
    let robots = cleanRobots(body, id);
    const lead: string[] = [];
    let title = 'Correct robots.txt';
    if (id.endsWith('backwards-policy')) {
      robots = generateRobotsTxt(robots, 'allow-search-block-training', {});
      title = 'Allow AI search bots; block only training bots';
      lead.push(
        'Today the training crawler is allowed but the search/assistant crawler of the same company is blocked, so it can train on you but not cite you. The file below flips that: search and user-triggered bots (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot) are allowed and training bots are opted out.',
        'If you are happy for your content to be used for training too, remove the training groups from the managed block as well.',
      );
    } else if (id.endsWith('legacy-tokens-only')) {
      robots = `${robots.trimEnd()}\n\n# Anthropic's current training crawler (anthropic-ai and Claude-Web are retired)\nUser-agent: ClaudeBot\nDisallow: /\n`;
      title = 'Use Anthropic’s current crawler token';
      lead.push(
        'The rules name only `anthropic-ai` / `Claude-Web`, which Anthropic no longer uses. Decide what you meant:',
        '- To block Anthropic training: add the `ClaudeBot` group (included below). Keep `Claude-SearchBot` and `Claude-User` allowed so Claude can still cite and link to you.',
        '- To allow Anthropic: delete the legacy groups and do not add the ClaudeBot block.',
      );
    } else if (id.endsWith('duplicate-groups')) {
      title = 'Merge duplicate robots.txt groups';
      lead.push(
        'Each bot should appear in exactly one `User-agent` group; some crawlers only read the first group they match. The file below merges single-bot groups. Groups that list several bots together must be merged by hand.',
      );
    } else if (id.endsWith('misspelt-tokens')) {
      title = 'Correct misspelt AI bot names in robots.txt';
      lead.push(
        'Bot names must match the operator’s published token exactly (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, PerplexityBot, Google-Extended, Applebot-Extended, CCBot). Matching is case-insensitive but hyphens and spaces matter.',
      );
    } else if (/crawl-delay/.test(id)) {
      title = 'Remove the high Crawl-delay';
      lead.push(
        'Google ignores Crawl-delay; Bing and several AI crawlers honour it, so at 10+ seconds they can fetch only a few thousand pages a day. The file below removes it.',
        'If the server really struggles under crawling, fix that with caching (CDN or page cache) or a rate limit at the edge that returns 429 with Retry-After, not with a site-wide delay.',
      );
    } else if (id.endsWith('unsupported-rules')) {
      title = 'Replace unsupported robots.txt rules';
      lead.push(
        'Google ignores `Noindex:`, `Nofollow:` and `Host:` in robots.txt. They are commented out below. To keep pages out of search use a `<meta name="robots" content="noindex">` tag or an `X-Robots-Tag: noindex` header (and let the page be crawled so the tag is seen). For the preferred host, use 301 redirects and canonicals.',
      );
    } else if (id.endsWith('too-large')) {
      title = 'Shrink robots.txt below 500 KiB';
      lead.push(
        'Google stops reading after 500 KiB, so the rules at the end are ignored. Usually the file lists thousands of individual URLs: replace them with a few pattern rules (`*` wildcards and `$` for end of URL), and use noindex or remove the pages rather than listing each one.',
        'Example: replace hundreds of `Disallow: /search?q=…` lines with `Disallow: /search` and hundreds of `Disallow: /tag/…` lines with `Disallow: /tag/`.',
      );
    } else {
      title = 'Fix robots.txt syntax';
      lead.push(
        'Each rule must be `Field: value` on its own line, using User-agent, Allow, Disallow, Sitemap or Crawl-delay, with paths starting with `/` or `*`. The file below corrects common typos and comments out lines crawlers would skip.',
      );
    }
    const f: StackFix = robotsFix(input, robots, null);
    return {
      ...f,
      title,
      steps: [
        ...lead,
        ...evidenceStep(input),
        'Check the result in Search Console → Settings → robots.txt report (and Bing Webmaster Tools → robots.txt tester) after deploying.',
        ...f.steps,
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Elements that break <head>, and robots meta in the wrong place
// ---------------------------------------------------------------------------

const headPlacement: Recipe = {
  id: 'head-placement',
  patterns: [
    /^crawlability\.(head-broken|robots-meta-in-body)$/,
    /^analytics\.gtm-noscript-misplaced$/,
  ],
  impact: 'high',
  effort: 'minutes',
  build(input) {
    const id = input.def.id;
    const gtm = id.startsWith('analytics.');
    const metaInBody = id.endsWith('robots-meta-in-body');
    const gtmId =
      input.issues
        .map((i) => /GTM-[A-Z0-9]+/.exec(`${i.evidence ?? ''} ${i.message}`)?.[0])
        .find(Boolean) ?? 'GTM-XXXXXXX';
    const noscript = `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${gtmId}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`;
    const lead = metaInBody
      ? 'The `<meta name="robots">` tag is rendered inside `<body>`. Some crawlers only read it in `<head>`, so print it from the page’s head (metadata API, SEO plugin or layout), not from the content area.'
      : 'Browsers and Google end `<head>` at the first element that belongs in `<body>` (`<img>`, `<iframe>`, `<div>`, `<noscript>` with an iframe, text). Every tag after it — canonical, robots, hreflang, Open Graph — is then treated as body content and ignored.';
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          metaInBody
            ? 'Delete the hand-written `<meta name="robots">` from the component and set `robots` in the route’s `metadata` / `generateMetadata` instead; Next.js puts it in `<head>`.'
            : 'In `app/layout.tsx`, nothing but metadata, `<link>`, `<script>` and `<style>` may go in `<head>`. Load scripts with `next/script`, and render tracking `<noscript>`/pixel `<img>` fallbacks as the first child of `<body>`.',
          'For Google Tag Manager, `@next/third-parties/google` (`<GoogleTagManager gtmId="…" />`) places both parts correctly.',
        ],
        files: ['app/layout.tsx', 'app/<route>/page.tsx (metadata)'],
        snippet: {
          language: 'tsx',
          code: metaInBody
            ? `// app/<route>/page.tsx
export const metadata: Metadata = { robots: { index: false, follow: true } };`
            : `// app/layout.tsx
import { GoogleTagManager } from '@next/third-parties/google';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <GoogleTagManager gtmId="${gtmId}" />
      <body>
        {/* pixels, noscript fallbacks and widgets go here, never in <head> */}
        {children}
      </body>
    </html>
  );
}`,
        },
      }),
      'nextjs-pages': () => ({
        steps: [
          'Only `<title>`, `<meta>`, `<link>`, `<script>` and `<style>` may go inside `next/head` or `_document`’s `<Head>`. Move `<noscript><iframe>` and tracking `<img>` tags to the top of `<body>` in `pages/_document.tsx`.',
        ],
        files: ['pages/_document.tsx', 'components/seo.tsx'],
        snippet: {
          language: 'tsx',
          code: `// pages/_document.tsx
<Html>
  <Head>{/* meta, link, script only */}</Head>
  <body>
    ${noscript}
    <Main />
    <NextScript />
  </body>
</Html>`,
        },
      }),
      wordpress: () => ({
        steps: [
          'Find what prints the stray element in `wp_head`: view the page source, look at the line just before the first ignored tag, and match it to a plugin or the theme’s `header.php`.',
          'Body-only output (GTM noscript, Meta/LinkedIn pixel `<img>`, chat widget markup) must use the `wp_body_open` hook. Most tag plugins (Site Kit, GTM4WP) have a setting for this; GTM4WP: “Container code placement → Codeless injection” or “Footer”.',
          metaInBody
            ? `Let ${seoPluginLabel(input.stack)} output the robots tag and remove any hard-coded robots meta in theme templates or page-builder HTML widgets.`
            : 'Move SEO output higher: SEO plugins hook early in `wp_head`, so the usual fix is moving the other plugin’s output, not the SEO tags.',
        ],
        files: ['functions.php (child theme)', 'header.php', 'tag-manager plugin settings'],
        snippet: {
          language: 'php',
          code: `// functions.php (child theme): print the GTM noscript right after <body>
add_action('wp_body_open', function () {
  echo '${noscript}';
});`,
        },
      }),
      shopify: () => ({
        steps: [
          'Open Online Store → Themes → Edit code → `layout/theme.liquid`. Everything between `<head>` and `{{ content_for_header }}` must be meta, link, script or style.',
          'Move `<noscript>`, pixel `<img>` and app snippets that render markup to just after the opening `<body>` tag. Check apps under Online Store → Themes → Customize → App embeds too.',
        ],
        files: ['layout/theme.liquid'],
        snippet: { language: 'liquid', code: `<body>\n  ${noscript}\n  …` },
      }),
      hosted: () => ({
        steps: [
          'Custom code added to the “head” code injection area must contain only `<meta>`, `<link>`, `<script>` and `<style>`. Move `<noscript>`, `<iframe>` and `<img>` pixels to the “body start” / “footer” code injection area.',
        ],
        files: ['Site settings → Custom code (head / body)'],
      }),
      unknown: () => ({
        steps: [
          'In the shared layout, keep only `<meta>`, `<title>`, `<link>`, `<script>`, `<style>` and `<base>` inside `<head>`, with `<meta charset>`, title, canonical and robots near the top.',
          'Put `<noscript>` iframes, tracking pixels and widget markup immediately after `<body>`.',
        ],
        files: [templateFile(input)],
        snippet: {
          language: 'html',
          code: `<head>
  <meta charset="utf-8" />
  <title>…</title>
  <link rel="canonical" href="${input.urls[0] ?? input.origin + '/'}" />
  <meta name="robots" content="index, follow" />
  <!-- scripts and styles -->
</head>
<body>
  ${noscript}
  …`,
        },
      }),
    });
    return {
      ...fix,
      title: gtm
        ? 'Move the Tag Manager noscript into <body>'
        : metaInBody
          ? 'Put the robots meta tag in <head>'
          : 'Remove body elements from <head>',
      steps: [
        gtm
          ? 'Google Tag Manager has two parts: the `<script>` goes in `<head>`, the `<noscript><iframe>` goes immediately after `<body>`. In `<head>` the iframe ends the head early, so canonical, hreflang and robots tags after it are ignored.'
          : lead,
        ...evidenceStep(input),
        ...fix.steps,
        ...urlsBlock(input, 5),
        verifyStep(
          input,
          'Check the result in Search Console URL Inspection → View crawled page: the canonical and robots tags must appear inside <head>.',
        ),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Conflicting or bot-specific robots directives
// ---------------------------------------------------------------------------

const robotsDirectives: Recipe = {
  id: 'robots-directives',
  patterns: [/^crawlability\.robots-conflict$/, /^ai-crawlers\.bot-specific-meta$/],
  impact: 'high',
  effort: 'minutes',
  build(input) {
    const bot = input.def.id.startsWith('ai-crawlers.');
    const f = metaFix(input, { field: 'robots' });
    const plugin = wpPlugin(input.stack);
    const where = byStack(input, {
      wordpress: () => ({
        steps: [
          plugin
            ? `${seoPluginLabel(input.stack)} sets the robots tag per page (Advanced tab of the post’s SEO panel). Clear any extra robots or bot-specific meta added by another plugin, a theme option or an HTML block.`
            : 'Install one SEO plugin to manage robots tags, then remove hand-written robots meta from theme templates and HTML blocks.',
          'An `X-Robots-Tag` header usually comes from a security or caching plugin, or the host config.',
        ],
        files: ['WordPress: post SEO panel', 'security / caching plugin', '.htaccess'],
      }),
      shopify: () => ({
        steps: [
          'Search `layout/theme.liquid` and `snippets/` for `name="robots"` and bot names (GPTBot, googlebot); apps can inject them too (check App embeds).',
        ],
        files: ['layout/theme.liquid', 'snippets/*.liquid'],
      }),
      unknown: () => ({
        steps: [
          'Search the codebase, server config and CDN rules for `robots`, `googlebot`, `X-Robots-Tag` and AI bot names; keep exactly one robots meta tag per page and no contradicting header.',
        ],
        files: [templateFile(input), 'vercel.json / netlify.toml / _headers / nginx / .htaccess'],
      }),
    });
    return {
      ...f,
      title: bot ? 'Remove bot-specific robots meta tags' : 'Use one robots directive per page',
      steps: [
        bot
          ? 'A `<meta name="GPTBot">` (or ClaudeBot, PerplexityBot…) tag removes the page from that one assistant. Unless that is deliberate, delete it. If you do want to exclude a bot, do it in robots.txt so the policy lives in one place.'
          : 'The page sends contradicting signals (for example `index` in the robots meta, `noindex` in `googlebot` meta or the `X-Robots-Tag` header). Google applies the most restrictive. Decide what the page should do and express it once.',
        ...evidenceStep(input),
        ...where.steps,
        ...f.steps,
        ...urlsBlock(input),
        verifyStep(input, `Check headers with \`curl -sI ${input.urls[0] ?? input.origin}\`.`),
      ],
      files: [...new Set([...where.files, ...f.files])],
    };
  },
};

// ---------------------------------------------------------------------------
// Snippet and AI-use restrictions on a page
// ---------------------------------------------------------------------------

const snippetControls: Recipe = {
  id: 'ai-snippet-controls',
  patterns: [/^ai-crawlers\.(page-noai|page-nosnippet|page-max-snippet-low|data-nosnippet-main)$/],
  impact: 'high',
  effort: 'minutes',
  build(input) {
    const id = input.def.id;
    const dataNs = id.endsWith('data-nosnippet-main');
    const lead = dataNs
      ? 'Most of the main content sits inside elements marked `data-nosnippet`, so Google cannot quote it in results, AI Overviews or AI Mode. Remove the attribute from the article wrapper and keep it only on the specific passages you need to protect (for example a price that changes daily or a members-only excerpt).'
      : id.endsWith('noai')
        ? '`noai` / `noimageai` are non-standard values that some tools honour to exclude the page from AI use. They are often switched on by a plugin or theme default. Remove them unless the opt-out is a deliberate choice for this page.'
        : id.endsWith('nosnippet')
          ? '`nosnippet` (or `max-snippet:0`) also opts the page out of AI Overviews and AI Mode, and other engines read it the same way. Remove it unless the page must never be quoted; to protect one passage, wrap only that passage in `<span data-nosnippet>`.'
          : '`max-snippet` below roughly 160 characters is shorter than an answer sentence. Remove it or set `max-snippet:-1` (no limit).';
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          dataNs
            ? 'Remove `data-nosnippet` from the layout or article component that wraps the content.'
            : 'Set the robots metadata once in `app/layout.tsx` and override it only where needed. Remove custom `other: { robots: "noai" }` entries.',
        ],
        files: dataNs ? ['app/<route>/page.tsx', 'components/*'] : ['app/layout.tsx'],
        snippet: dataNs
          ? {
              language: 'tsx',
              code: `<article>\n  {/* no data-nosnippet here */}\n  <p>…</p>\n  <p><span data-nosnippet>Members-only detail</span></p>\n</article>`,
            }
          : {
              language: 'ts',
              code: `export const metadata: Metadata = {
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-snippet': -1, 'max-image-preview': 'large' },
  },
};`,
            },
      }),
      wordpress: () => ({
        steps: [
          dataNs
            ? 'Search the theme templates and page-builder settings for `data-nosnippet` and remove it from the content wrapper.'
            : `In ${seoPluginLabel(input.stack)}, check the global and per-post “advanced robots” settings: snippet length should be unlimited (-1) and image preview “large”. Deactivate “block AI” plugins or turn off their noai output if you want to be cited.`,
        ],
        files: ['WordPress: SEO plugin advanced robots settings', 'AI-blocking plugins'],
      }),
      shopify: () => ({
        steps: [
          'Search `layout/theme.liquid` and `snippets/` for `noai`, `nosnippet`, `max-snippet` and `data-nosnippet`; check App embeds for apps that add them.',
        ],
        files: ['layout/theme.liquid', 'snippets/*.liquid'],
      }),
      hosted: () => ({
        steps: [
          'Check the page’s SEO settings and any custom code in the head for these values, and remove them.',
        ],
        files: ['Page SEO settings', 'Custom code (head)'],
      }),
      unknown: () => ({
        steps: ['Edit the robots meta tag (or `X-Robots-Tag` header) in the shared layout:'],
        files: [templateFile(input)],
        snippet: {
          language: 'html',
          code: dataNs
            ? '<main>\n  <p>Main content, quotable.</p>\n  <p><span data-nosnippet>Only this passage is protected.</span></p>\n</main>'
            : '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large" />',
        },
      }),
    });
    return {
      ...fix,
      title: dataNs ? 'Narrow data-nosnippet to specific passages' : 'Let engines quote this page',
      steps: [
        lead,
        ...evidenceStep(input),
        ...fix.steps,
        'If the value comes from an `X-Robots-Tag` header, change it in the server or CDN config as well.',
        ...urlsBlock(input),
        verifyStep(input),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Search Console findings
// ---------------------------------------------------------------------------

function internalLinkHint(input: RecipeInput): string {
  return byStack(input, {
    wordpress: () => ({
      steps: [
        'In WordPress, add links in the body of related posts (the block editor’s link search finds the page), and to category or hub pages. Plugins such as Yoast’s internal-linking suggestions or Link Whisper list candidates.',
      ],
      files: [],
    }),
    shopify: () => ({
      steps: [
        'In Shopify, link from collection descriptions, related blog articles and Online Store → Navigation menus.',
      ],
      files: [],
    }),
    hosted: () => ({
      steps: ['Add text links from related pages and from a hub page in the site editor.'],
      files: [],
    }),
    unknown: () => ({
      steps: [
        `Add contextual links in the content of related pages and from a hub or category page (${templateFile(input)}).`,
      ],
      files: [],
    }),
  }).steps[0]!;
}

function sitemapHint(input: RecipeInput): string {
  return byStack(input, {
    'nextjs-app': () => ({
      steps: [
        'Make sure `app/sitemap.ts` includes the URL with `lastModified` set from the content’s real update date (not `new Date()` on every build).',
      ],
      files: [],
    }),
    wordpress: () => ({
      steps: [
        `Make sure ${seoPluginLabel(input.stack)}’s sitemap includes the post type; lastmod updates automatically when you edit the post.`,
      ],
      files: [],
    }),
    shopify: () => ({
      steps: [
        'Shopify’s /sitemap.xml includes published, visible products, collections, pages and articles.',
      ],
      files: [],
    }),
    unknown: () => ({
      steps: [
        'Keep the URL in the XML sitemap with an accurate `<lastmod>` (the date the content really changed).',
      ],
      files: [],
    }),
  }).steps[0]!;
}

const GSC_FILES = [
  'Google Search Console → URL Inspection',
  'Search Console → Indexing → Pages',
  'Search Console → Performance → Search results',
];

const searchConsole: Recipe = {
  id: 'search-console',
  patterns: [
    /^crawlability\.gsc-(impressions-not-crawled|not-indexed|crawled-not-indexed|discovered-not-indexed|low-ctr|striking-distance|stale-crawl|no-impressions)$/,
  ],
  impact: 'high',
  effort: 'hours',
  tier: 'manual',
  build(input) {
    const id = input.def.id.replace('crawlability.gsc-', '');
    const inspect =
      'Open each URL in Search Console → URL Inspection (paste it in the top bar) and read “Page indexing”: the reason, the Google-selected canonical, the last crawl date and whether crawling or indexing is allowed.';
    const request =
      'After fixing, click “Test live URL” and then “Request indexing” (about 10 URLs a day are allowed, so start with the most important).';
    const links = internalLinkHint(input);
    const sitemap = sitemapHint(input);
    let title = input.def.title;
    let steps: string[] = [];
    let files = GSC_FILES;
    let snippet: StackFix['snippet'];
    switch (id) {
      case 'not-indexed':
        title = 'Get these pages indexed';
        steps = [
          inspect,
          'Fix by reason: “Excluded by noindex” → remove noindex; “Blocked by robots.txt” → allow the path; “Alternate page with proper canonical” → link to the canonical instead; “Soft 404” / “Not found” → return real content or a 404 and drop the URL from the sitemap; “Duplicate, Google chose different canonical” → merge or make the page distinct.',
          links,
          sitemap,
          request,
        ];
        break;
      case 'crawled-not-indexed':
        title = 'Make crawled-but-not-indexed pages worth indexing';
        steps = [
          'Google fetched these pages and decided not to index them. This is a quality or duplication judgement, so re-submitting alone rarely helps.',
          'For each page, search Google for its main topic plus `site:` your domain: if another page of yours covers the same thing, merge the two and 301 the weaker one.',
          'Otherwise make it distinct: answer the main question in the first paragraph, add original detail (prices, steps, examples, photos, data you hold), and remove boilerplate that repeats across pages.',
          links,
          'Wait for a recrawl, then use URL Inspection → Request indexing. Pages that still do not get indexed after a real improvement are candidates to noindex or retire.',
        ];
        break;
      case 'discovered-not-indexed':
        title = 'Help Google crawl discovered pages';
        steps = [
          'Google knows these URLs but has not fetched them yet, usually because they have weak internal links or the site spends crawl budget on low-value URLs.',
          links,
          sitemap,
          'Reduce crawl waste: stop linking to filter, sort, tag and search-result URLs; fix redirect chains and 404s in internal links (see the related findings in this report).',
          'Check Settings → Crawl stats in Search Console for slow responses or host errors; a slow server makes Google crawl less.',
          request,
        ];
        break;
      case 'impressions-not-crawled':
        title = 'Link to pages Google shows but your site does not link to';
        steps = [
          'These URLs earn impressions in Google, but a crawl that follows your links never reached them: they are probably orphans.',
          'For pages that are still current: link to them from the relevant hub, category or navigation, so they receive internal link value.',
          'For outdated ones: 301-redirect them to the closest current page and remove them from the sitemap.',
          links,
        ];
        break;
      case 'low-ctr': {
        title = 'Rewrite titles and descriptions to earn the click';
        const meta = metaFix(input, { field: 'title' });
        files = [...meta.files, 'Search Console → Performance (filter by page → Queries)'];
        snippet = meta.snippet;
        steps = [
          'In Search Console → Performance, filter by each page and open the Queries tab to see what people actually searched for.',
          'Rewrite the title around the main query (about 50–60 characters, the query near the start, a concrete benefit or number you can stand behind) and the meta description as a direct answer with a reason to click.',
          'Check whether competitors have rich results (FAQ, reviews, product price) and add the matching structured data if it truthfully applies.',
          ...meta.steps,
          'Compare CTR for the same queries over the 28 days after the change.',
        ];
        break;
      }
      case 'striking-distance':
        title = 'Push pages ranking 8–20 onto page one';
        steps = [
          'In Search Console → Performance, filter by each page and sort Queries by impressions; note the queries with an average position between 8 and 20.',
          'Answer the top query in the first paragraph, use its wording in the H1 or a subheading, and add the subtopics the current top results cover and you do not.',
          'Add 3–5 internal links to the page from related, well-linked pages using descriptive anchor text close to the query.',
          links,
          'Update the visible “last updated” date and `dateModified` only when the content really changed, then request indexing in URL Inspection.',
        ];
        break;
      case 'stale-crawl':
        title = 'Get stale pages recrawled';
        steps = [
          inspect,
          'Make sure the URL returns 200 quickly and is not redirected or canonicalised elsewhere.',
          links,
          sitemap,
          request,
        ];
        break;
      default:
        title = 'Review indexable pages with no impressions';
        steps = [
          'These pages are indexable but never appear in Search Console data. Sort them into three groups:',
          '- Should rank: check URL Inspection (is it indexed?), then improve the content around one clear query and link to it.',
          '- Overlaps another page: merge them and 301 the weaker URL.',
          '- No search value (thank-you pages, thin tags, old promotions): noindex or remove them and drop them from the sitemap.',
          links,
        ];
    }
    return {
      title,
      steps: [...steps, ...urlsBlock(input)],
      files,
      ...(snippet ? { snippet } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// Crawl structure
// ---------------------------------------------------------------------------

const crawlIncomplete: Recipe = {
  id: 'crawl-incomplete',
  patterns: [/^crawlability\.crawl-incomplete$/],
  impact: 'low',
  effort: 'minutes',
  tier: 'manual',
  build(input) {
    return {
      title: 'Crawl the whole site',
      steps: [
        'The audit stopped at its page limit, so site-wide findings (orphans, duplicates, sitemap gaps) only cover the pages it reached.',
        'Run it again with a higher limit, or crawl large sections one at a time with include patterns.',
        'If the crawl keeps growing far beyond your real page count, it is probably following parameter or calendar URLs: see the parameter and URL findings in this report.',
      ],
      files: ['avc command line'],
      snippet: {
        language: 'bash',
        code: `avc audit ${input.origin} --max-pages 5000\n# or one section at a time\navc audit ${input.origin} --include '^${input.origin}/blog/' --max-pages 2000`,
      },
    };
  },
};

const singlePage: Recipe = {
  id: 'single-page-found',
  patterns: [/^crawlability\.single-page-found$/],
  impact: 'high',
  effort: 'days',
  build(input) {
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Use `<Link href="/path">` (it renders a real `<a href>`) for navigation, never `router.push` in an `onClick` on a div or button.',
          'Render the header and footer navigation in Server Components so the links are in the HTML.',
        ],
        files: ['components/header.tsx', 'components/footer.tsx', 'app/layout.tsx'],
        snippet: {
          language: 'tsx',
          code: `import Link from 'next/link';\n\n<nav>\n  <Link href="/services">Services</Link>\n  <Link href="/pricing">Pricing</Link>\n</nav>`,
        },
      }),
      spa: () => ({
        steps: [
          'This is a client-side app, so the HTML crawlers receive contains no links. Prerender each route (Angular SSR/prerender, Vike, react-snap) or move to a server-rendering framework.',
          'Use the router’s link component (`<Link>`, `<RouterLink>`, `routerLink`) so each link is an `<a href>`, and history-mode routing, not `#/` routes.',
        ],
        files: ['router config', 'navigation components'],
      }),
      wordpress: () => ({
        steps: [
          'Check the menu is a normal WordPress menu (Appearance → Menus / Site Editor → Navigation). Page-builder menus that load by JavaScript or AJAX hide the links from crawlers.',
          'Check the site is not behind a “coming soon” or maintenance plugin and that a security plugin is not blocking crawler user agents.',
        ],
        files: ['Appearance → Menus', 'page-builder header template'],
      }),
      unknown: () => ({
        steps: [
          'Make sure the navigation in the server HTML uses `<a href="/real-path">` links. Test: `curl -s <home URL> | grep -o \'<a [^>]*href="[^"]*"\' | head`.',
          'Replace `onclick` navigation, `javascript:` links and links injected after load with plain anchors.',
        ],
        files: [templateFile(input), 'navigation markup'],
        snippet: {
          language: 'html',
          code: '<nav>\n  <a href="/services/">Services</a>\n  <a href="/about/">About</a>\n  <a href="/contact/">Contact</a>\n</nav>',
        },
      }),
    });
    return {
      ...fix,
      title: 'Put crawlable links in the server HTML',
      steps: [
        'A crawler following plain HTML links found only the start page. Search and AI crawlers that do not run JavaScript cannot find the rest of the site either.',
        'First rule out blocks: robots.txt, a login or consent wall, or a firewall rule that serves bots a different page.',
        ...fix.steps,
        verifyStep(input),
      ],
    };
  },
};

const blockedLinked: Recipe = {
  id: 'blocked-but-linked',
  patterns: [/^crawlability\.blocked-but-linked$/, /^links-internal\.to-blocked$/],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const f = robotsFix(input, currentRobots(input) || 'User-agent: *\nAllow: /\n', null);
    return {
      title: 'Stop linking to URLs blocked by robots.txt',
      steps: [
        'For each blocked URL decide which case applies:',
        '- Users need the link but search does not (cart, account, filters): keep the block, and add `rel="nofollow"` only if the link is generated in bulk. Better, use a `<button>` or form for actions.',
        '- The page should be findable: remove or narrow the `Disallow` rule (robots.txt below), and use `noindex` if it should stay out of results — Google can only see a noindex on a page it may crawl.',
        '- The link is a leftover: remove it from the template, menu or content.',
        ...evidenceStep(input),
        ...urlsBlock(input, 10, 'Pages with the links'),
        ...f.steps,
      ],
      files: [templateFile(input), ...f.files],
      snippet: f.snippet,
    };
  },
};

const parameterWaste: Recipe = {
  id: 'parameter-waste',
  patterns: [/^crawlability\.parameter-waste$/],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Give filtered and sorted views a canonical to the clean URL: in `generateMetadata`, set `alternates.canonical` to the path without query parameters.',
          'Render sort and filter controls as a form or buttons that update `searchParams`, not as hundreds of plain links.',
        ],
        files: ['app/<listing>/page.tsx'],
        snippet: {
          language: 'ts',
          code: `export async function generateMetadata(): Promise<Metadata> {
  // canonical ignores ?sort=, ?filter=, ?view= …
  return { alternates: { canonical: '/products' } };
}`,
        },
      }),
      wordpress: () => ({
        steps: [
          `${seoPluginLabel(input.stack)} adds self-referencing canonicals without parameters on most templates. For WooCommerce filter plugins, enable their “noindex filtered pages” option and make filter links use JavaScript/forms instead of crawlable links.`,
          'Yoast: Settings → Advanced → Crawl optimisation → “Remove unregistered URL parameters” can strip unknown parameters by redirect.',
        ],
        files: ['WordPress: SEO plugin crawl settings', 'filter plugin settings'],
      }),
      shopify: () => ({
        steps: [
          'Shopify canonicalises `?sort_by=` and filter parameters to the collection. Keep `{{ canonical_url }}` in theme.liquid, and add the Disallow lines below to `robots.txt.liquid` for filter parameters you do not want crawled.',
        ],
        files: ['layout/theme.liquid', 'templates/robots.txt.liquid'],
      }),
      unknown: () => ({
        steps: [
          'Canonicalise parameter variants to the clean URL, stop linking to sort/filter variants with plain links, and disallow pure-filter parameters in robots.txt.',
        ],
        files: [templateFile(input), 'robots.txt'],
      }),
    });
    return {
      ...fix,
      title: 'Cut crawl waste from parameter URLs',
      snippet: fix.snippet ?? {
        language: 'text',
        code: '# robots.txt: block parameters that only sort or filter (keep ?page=)\nUser-agent: *\nDisallow: /*?*sort=\nDisallow: /*?*filter=\nDisallow: /*?*view=',
      },
      steps: [
        'Many crawlable URLs differ only in query parameters (sort, filter, view, session). Pick the clean URL for each listing and point everything at it.',
        ...evidenceStep(input),
        ...fix.steps,
        'Do not block `?page=` pagination parameters: crawlers need them to reach items further down the list.',
        verifyStep(input),
      ],
    };
  },
};

const lowIndexable: Recipe = {
  id: 'low-indexable-share',
  patterns: [/^crawlability\.low-indexable-share$/],
  impact: 'medium',
  effort: 'days',
  tier: 'manual',
  build(input) {
    return {
      title: 'Point internal links at indexable pages',
      steps: [
        'Most URLs reached through your links are redirects, errors, noindex or canonicalised elsewhere. Export the crawled pages (`avc audit --format csv` or the report’s Pages table) and group the non-indexable ones by reason.',
        'Redirects: update links, menus and the sitemap to the final URL.',
        'Errors (4xx/5xx): fix or remove the links.',
        'Canonicalised: link to the canonical URL instead (often a trailing-slash, case or parameter variant in a template).',
        'Noindex: if the pages are meant to be hidden (tags, filters, account), link to them less — not from every page’s footer or sidebar.',
        internalLinkHint(input),
      ],
      files: [templateFile(input), 'navigation / footer / sidebar templates', 'sitemap'],
    };
  },
};

export const recipes: Recipe[] = [
  robotsFileHealth,
  robotsContent,
  headPlacement,
  robotsDirectives,
  snippetControls,
  searchConsole,
  crawlIncomplete,
  singlePage,
  blockedLinked,
  parameterWaste,
  lowIndexable,
];
