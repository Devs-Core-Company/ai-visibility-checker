/**
 * Recipes for AI crawler access: robots.txt rules per AI bot, Content-Signal, firewall
 * allow-listing of verified bots, llms.txt and the JavaScript rendering gap.
 */
import { FIX_AI_BOTS } from '../bots.js';
import {
  blockedAiTokens,
  generateLlmsTxt,
  generateRobotsTxt,
  type RobotsPolicy,
} from '../generate.js';
import { byStack, seoPluginLabel, staticFile, tsString, wpPlugin } from '../stacks.js';
import type { Recipe, RecipeInput, StackFix } from '../types.js';

/** Keep a deliberate training opt-out; otherwise allow every AI crawler. */
export function defaultPolicy(currentRobots: string): RobotsPolicy {
  const blocked = blockedAiTokens(currentRobots);
  const training = FIX_AI_BOTS.filter((b) => b.purpose === 'training').map((b) =>
    b.token.toLowerCase(),
  );
  return blocked.some((t) => training.includes(t.toLowerCase()))
    ? 'allow-search-block-training'
    : 'allow-all-ai';
}

function currentRobots(input: RecipeInput): string {
  return input.result?.robots?.found ? input.result.robots.body : '';
}

function sitemapUrls(input: RecipeInput): string[] {
  const found = input.result?.sitemaps?.filter((s) => s.found).map((s) => s.url) ?? [];
  return found.length ? found.slice(0, 5) : [`${input.origin}/sitemap.xml`];
}

/** Next.js app/robots.ts that expresses the same policy. */
export function nextRobotsTs(sitemap: string, policy: RobotsPolicy): string {
  const allow = FIX_AI_BOTS.filter(
    (b) => policy === 'allow-all-ai' || b.purpose !== 'training',
  ).map((b) => b.token);
  const block =
    policy === 'allow-all-ai'
      ? []
      : FIX_AI_BOTS.filter((b) => b.purpose === 'training').map((b) => b.token);
  return `// app/robots.ts — Next.js generates /robots.txt from this file
import type { MetadataRoute } from 'next';

const PRIVATE = ['/api/', '/admin/']; // keep your existing private paths here

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: PRIVATE },
      // AI search and assistant crawlers: allowed, so answers can cite you
      { userAgent: ${JSON.stringify(allow)}, allow: '/', disallow: PRIVATE },${
        block.length
          ? `\n      // training-only crawlers: opted out\n      { userAgent: ${JSON.stringify(block)}, disallow: '/' },`
          : ''
      }
    ],
    sitemap: ${JSON.stringify(sitemap)},
  };
}`;
}

export function robotsFix(
  input: RecipeInput,
  robots: string,
  policy: RobotsPolicy | null,
): StackFix {
  const verify = `Check ${input.origin}/robots.txt, then run \`avc audit --only ${input.def.id}\`.`;
  const plugin = wpPlugin(input.stack);
  return byStack(input, {
    'nextjs-app': (i) => ({
      steps: [
        'If the project has `public/robots.txt`, replace its content with the file below. Otherwise create `app/robots.ts` (second option) — do not keep both, `public/robots.txt` wins.',
        verify,
      ],
      files: ['public/robots.txt', 'app/robots.ts'],
      snippet: policy
        ? {
            language: 'ts',
            code:
              nextRobotsTs(sitemapUrls(i)[0], policy) + `\n\n/* or public/robots.txt:\n${robots}*/`,
          }
        : { language: 'text', code: robots },
    }),
    wordpress: () => ({
      steps: [
        plugin === 'yoast'
          ? 'Yoast SEO → Tools → File editor → robots.txt: replace the content with the file below and save.'
          : plugin === 'rank-math'
            ? 'Rank Math → General Settings → Edit robots.txt: replace the content and save (needs no physical robots.txt in the WordPress root).'
            : plugin === 'aioseo'
              ? 'All in One SEO → Tools → Robots.txt Editor: enable the custom robots.txt and add the rules below.'
              : 'Upload the file below as `robots.txt` to the WordPress root, or install the AVC helper (`avc fix --wp-helper`).',
        'Or apply it with a rollback file: `avc fix --apply --target wordpress` (needs the AVC helper).',
        'Also check Settings → Reading → "Discourage search engines" is unticked: it changes robots output.',
        verify,
      ],
      files: [`WordPress: ${seoPluginLabel(input.stack)} robots.txt editor`],
      snippet: { language: 'text', code: robots },
    }),
    shopify: () => ({
      steps: [
        'Online Store → Themes → Edit code → Add a new template → `robots.txt` (creates `templates/robots.txt.liquid`).',
        'Keep Shopify’s default groups (the Liquid loop below) and add the AI crawler groups after them.',
        verify,
      ],
      files: ['templates/robots.txt.liquid'],
      snippet: {
        language: 'liquid',
        code: `{% for group in robots.default_groups %}
  {{- group.user_agent }}
  {%- for rule in group.rules %}
    {{ rule }}
  {%- endfor %}
  {%- if group.sitemap != blank %}
    {{ group.sitemap }}
  {%- endif %}
{% endfor %}

${robots
  .split('\n')
  .filter((l) => !/^sitemap:/i.test(l))
  .join('\n')}`,
      },
    }),
    webflow: () => ({
      steps: [
        'Site settings → SEO → Indexing → robots.txt: paste the rules below, save and publish.',
        verify,
      ],
      files: ['Webflow: Site settings → SEO → robots.txt'],
      snippet: { language: 'text', code: robots },
    }),
    wix: () => ({
      steps: [
        'Marketing & SEO → SEO → Robots.txt Editor (under Tools and settings): paste the rules and save.',
        verify,
      ],
      files: ['Wix: Robots.txt Editor'],
      snippet: { language: 'text', code: robots },
    }),
    squarespace: () => ({
      steps: [
        'Squarespace does not let you edit robots.txt. Its only AI control is Settings → Crawlers → "Block known artificial intelligence crawlers": switch it off if you want AI search engines to read and cite the site.',
        verify,
      ],
      files: ['Squarespace: Settings → Crawlers'],
    }),
    hubspot: () => ({
      steps: [
        'Settings → Content → Pages → SEO & Crawlers → Robots.txt: paste the rules for your domain.',
        verify,
      ],
      files: ['HubSpot: SEO & Crawlers → robots.txt'],
      snippet: { language: 'text', code: robots },
    }),
    unknown: (i) => {
      const f = staticFile(i, 'robots.txt', robots, 'text');
      return {
        ...f,
        steps: [
          'Replace robots.txt with the content below (existing rules are kept; only AI crawler groups change).',
          ...f.steps,
        ],
      };
    },
  });
}

const aiRobots: Recipe = {
  id: 'ai-robots',
  patterns: [
    /^ai-crawlers\..*(block|disallow|robots|denied|opt-?out|missing-rule|no-rule|wildcard)/,
    /^robots\..*\bai\b/,
    /^robots\..*(gptbot|claude|perplexity|google-extended|ai-)/,
  ],
  impact: 'high',
  effort: 'minutes',
  auto: { wordpress: true, repo: true },
  build(input) {
    const current = currentRobots(input);
    const policy = defaultPolicy(current);
    const robots = generateRobotsTxt(current, policy, { sitemaps: sitemapUrls(input) });
    const fix = robotsFix(input, robots, policy);
    return {
      ...fix,
      title: 'Let AI search and assistant crawlers read the site',
      steps: [
        policy === 'allow-all-ai'
          ? 'The rules below allow every major AI crawler (search, assistant and training) while keeping your private paths blocked.'
          : 'The rules below keep your training opt-out but allow AI search and assistant crawlers (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot…), which decide whether answers can cite you.',
        ...fix.steps,
      ],
      acceptance: [
        'robots.txt allows OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User and PerplexityBot on public pages',
        'Paths that were private for `User-agent: *` stay disallowed for the AI groups',
      ],
    };
  },
};

const contentSignal: Recipe = {
  id: 'content-signal',
  patterns: [/content-signal/],
  impact: 'low',
  effort: 'minutes',
  auto: { repo: true, wordpress: true },
  build(input) {
    const current = currentRobots(input);
    const policy = defaultPolicy(current);
    const robots = generateRobotsTxt(current, policy, {
      sitemaps: sitemapUrls(input),
      contentSignal: {
        search: 'yes',
        'ai-input': 'yes',
        'ai-train': policy === 'allow-all-ai' ? 'yes' : 'no',
      },
    });
    const fix = robotsFix(input, robots, null);
    return {
      ...fix,
      title: 'Declare how your content may be used (Content-Signal)',
      steps: [
        'Content-Signal is a robots.txt line (Cloudflare’s Content Signals Policy) that states whether content may be used for search, as AI answer input, and for AI training. Set the values to match your decision.',
        ...(input.stack.cdn?.toLowerCase().includes('cloudflare') ||
        input.stack.host?.toLowerCase().includes('cloudflare')
          ? [
              'On Cloudflare you can also turn on the managed robots.txt with content signals in the dashboard (AI Crawl Control).',
            ]
          : []),
        ...fix.steps,
      ],
    };
  },
};

const CF_EXPRESSION = `(cf.verified_bot_category in {"AI Crawler" "AI Search" "AI Assistant" "Search Engine Crawler"})`;

const firewall: Recipe = {
  id: 'ai-firewall',
  patterns: [
    /^ai-crawlers\.(?!.*robots).*(firewall|challenge|waf|captcha|403|forbidden|live|fetch|bot-protection|cdn|differs|cloaking)/,
    /^ai-crawlers\..*-challenged$/,
  ],
  impact: 'high',
  effort: 'hours',
  build(input) {
    const cdn = `${input.stack.cdn ?? ''} ${input.stack.host ?? ''}`.toLowerCase();
    const cf = [
      'Cloudflare: Security → Bots: keep "Allow verified bots" on (Super Bot Fight Mode → Verified bots: Allow).',
      'Cloudflare: AI Crawl Control → set the AI search and assistant crawlers you want to Allow (blocking there overrides robots.txt).',
      `Cloudflare: Security → WAF → Custom rules → create a rule with the expression below and action **Skip** (skip Super Bot Fight Mode, managed rules and rate limiting), placed first.`,
    ];
    const vercel = [
      'Vercel: Project → Firewall → turn off Attack Challenge Mode when you are not under attack (it challenges crawlers too).',
      'Vercel: Firewall → Bot Management: keep verified bots allowed; if you added a custom rule that challenges or denies by user agent, add an exception for verified AI bots above it.',
    ];
    const akamai = [
      'Akamai: Bot Manager → Bot Categories → set the AI crawler / AI search categories to Allow or Monitor, not Deny or Tarpit; keep the "verified" (Akamai-categorised) bots allowed.',
    ];
    const generic = [
      'Other WAFs (Sucuri, Wordfence, Imperva, DataDome, server rules): allow the AI crawlers by verified IP range, not by user agent alone — user agents are easy to fake.',
      `IP ranges are published by OpenAI (${FIX_AI_BOTS.filter(
        (b) => b.verify && b.operator === 'OpenAI',
      )
        .map((b) => b.verify)
        .join(
          ', ',
        )}) and Perplexity (https://www.perplexity.ai/perplexitybot.json); Anthropic and Google publish verification guidance in their crawler docs.`,
    ];
    const ordered = cdn.includes('cloudflare')
      ? [...cf, ...generic]
      : cdn.includes('vercel')
        ? [...vercel, ...cf, ...generic]
        : cdn.includes('akamai')
          ? [...akamai, ...generic]
          : [...cf, ...vercel, ...akamai, ...generic];
    return {
      title: 'Stop the firewall or CDN blocking AI crawlers',
      steps: [
        'robots.txt is not the problem here: the AI crawler got a challenge or error page while a browser got the real page.',
        ...ordered,
        ...(input.stack.id === 'wordpress'
          ? [
              'WordPress security plugins (Wordfence, iThemes/Solid Security) can block "fake" bots: check their blocking logs for GPTBot/ClaudeBot/PerplexityBot hits.',
            ]
          : []),
        `Re-test with \`avc audit --only ${input.def.id}\` — it fetches the home page as each AI crawler.`,
      ],
      files: [
        cdn.includes('vercel') ? 'Vercel: Firewall' : 'Cloudflare: Security → WAF → Custom rules',
        'CDN / WAF bot settings',
      ],
      snippet: {
        language: 'text',
        code: `${CF_EXPRESSION}\n\nAction: Skip → All Super Bot Fight Mode rules, All managed rules, Rate limiting rules`,
      },
      acceptance: [
        'Fetching the home page with the GPTBot, ClaudeBot and PerplexityBot user agents from their published IPs returns 200 and the same content as a browser',
      ],
    };
  },
};

const llmsTxt: Recipe = {
  id: 'llms-txt',
  patterns: ['llms-txt.*'],
  impact: 'medium',
  effort: 'minutes',
  auto: { wordpress: true, repo: true },
  build(input) {
    const content = generateLlmsTxt(
      { site: input.origin, pages: input.pages ?? input.result?.pages },
      {
        name: input.brand?.name,
        summary: input.brand?.description,
      },
    );
    const intro =
      'The file below was generated from this crawl: name, a one-line summary, then your main pages grouped by section with their descriptions. Edit the summary and drop anything you do not want to point AI tools at.';
    const plugin = wpPlugin(input.stack);
    const route =
      (file: string, code: string) =>
      (i: RecipeInput): StackFix => {
        const s = staticFile(i, 'llms.txt', content);
        return {
          steps: [
            intro,
            `Simplest: ${s.steps[0]}`,
            `Or serve it from a route so it can be rebuilt from your content: \`${file}\` (below).`,
            ...s.steps.slice(2),
          ],
          files: [s.files[0], file],
          snippet: { language: 'ts', code },
        };
      };
    const body = tsString(content);
    return {
      title: 'Publish an llms.txt generated from your pages',
      ...byStack(input, {
        'nextjs-app': route(
          'app/llms.txt/route.ts',
          `// app/llms.txt/route.ts\nexport const dynamic = 'force-static';\n\nconst BODY = ${body};\n\nexport function GET() {\n  return new Response(BODY, { headers: { 'content-type': 'text/plain; charset=utf-8' } });\n}`,
        ),
        astro: route(
          'src/pages/llms.txt.ts',
          `// src/pages/llms.txt.ts\nimport type { APIRoute } from 'astro';\n\nconst BODY = ${body};\n\nexport const GET: APIRoute = () =>\n  new Response(BODY, { headers: { 'content-type': 'text/plain; charset=utf-8' } });`,
        ),
        nuxt: route(
          'server/routes/llms.txt.ts',
          `// server/routes/llms.txt.ts\nconst BODY = ${body};\n\nexport default defineEventHandler((event) => {\n  setHeader(event, 'content-type', 'text/plain; charset=utf-8');\n  return BODY;\n});`,
        ),
        sveltekit: route(
          'src/routes/llms.txt/+server.ts',
          `// src/routes/llms.txt/+server.ts\nexport const prerender = true;\n\nconst BODY = ${body};\n\nexport function GET() {\n  return new Response(BODY, { headers: { 'content-type': 'text/plain; charset=utf-8' } });\n}`,
        ),
        remix: route(
          'app/routes/llms[.]txt.ts',
          `// app/routes/llms[.]txt.ts\nconst BODY = ${body};\n\nexport const loader = () =>\n  new Response(BODY, { headers: { 'content-type': 'text/plain; charset=utf-8' } });`,
        ),
        wordpress: (i) => {
          const s = staticFile(i, 'llms.txt', content);
          return {
            steps: [
              intro,
              plugin
                ? `Recent versions of ${seoPluginLabel(i.stack)} can generate llms.txt themselves: look for the llms.txt option in the plugin settings and turn it on. Compare its output with the file below.`
                : 'No SEO plugin with llms.txt support was detected.',
              ...s.steps,
            ],
            files: s.files,
            snippet: s.snippet,
          };
        },
        unknown: (i) => {
          const s = staticFile(i, 'llms.txt', content);
          return { ...s, steps: [intro, ...s.steps] };
        },
      }),
      acceptance: [
        `${input.origin}/llms.txt returns 200 with content-type text/plain or text/markdown`,
        'Starts with `# <name>`, then a `> summary` line, then `##` sections of markdown links',
        'Every link in it returns 200',
      ],
    };
  },
};

const jsRendering: Recipe = {
  id: 'js-rendering',
  patterns: [
    'js-rendering.*',
    /^ai-crawlers\..*(render|javascript|js-)/,
    /^geo-content\..*(render|javascript)/,
  ],
  impact: 'high',
  effort: 'days',
  build(input) {
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Move data fetching for the main content into Server Components (async `page.tsx`), not `useEffect` in a `"use client"` component.',
          'Keep `"use client"` for interactive leaves only (menus, forms); the text, headings and links must be in the server HTML.',
          'Use `generateStaticParams` for content routes so they are built as static HTML.',
        ],
        files: ['app/<route>/page.tsx', 'components/* ("use client" files)'],
        snippet: {
          language: 'tsx',
          code: `// app/blog/[slug]/page.tsx — rendered on the server
export async function generateStaticParams() {
  return (await getPosts()).map((p) => ({ slug: p.slug }));
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const post = await getPost((await params).slug);
  return <article><h1>{post.title}</h1><div>{post.body}</div></article>;
}`,
        },
      }),
      'nextjs-pages': () => ({
        steps: [
          'Fetch the main content in `getStaticProps` (with `getStaticPaths`) or `getServerSideProps`, not in `useEffect`.',
          'Check `next/dynamic` imports of content components do not use `ssr: false`.',
        ],
        files: ['pages/<route>.tsx'],
        snippet: {
          language: 'tsx',
          code: `export async function getStaticProps({ params }) {
  return { props: { post: await getPost(params.slug) }, revalidate: 3600 };
}`,
        },
      }),
      astro: () => ({
        steps: [
          'Render content in `.astro` components (server-rendered by default). Framework components with `client:only` render nothing on the server: use `client:load`/`client:visible` so their HTML is pre-rendered, or move the content out of them.',
        ],
        files: ['src/pages/*.astro', 'components using client:only'],
      }),
      nuxt: () => ({
        steps: [
          'Keep `ssr: true` (default) in `nuxt.config.ts`; fetch content with `useAsyncData`/`useFetch` (run on the server), not in `onMounted`.',
          'Remove `<ClientOnly>` wrappers around real content; use `routeRules: { "/blog/**": { prerender: true } }` for static content.',
        ],
        files: ['nuxt.config.ts', 'pages/*.vue'],
      }),
      sveltekit: () => ({
        steps: [
          'Load content in `+page.server.ts`/`+page.ts` `load` functions and keep `export const ssr = true` (default). Add `export const prerender = true` for static pages.',
          'Remove `export const ssr = false` from content routes.',
        ],
        files: ['src/routes/**/+page.ts', 'src/routes/+layout.ts'],
      }),
      gatsby: () => ({
        steps: [
          'Query content with page queries / `createPages` so it is in the built HTML; avoid fetching main content client-side in `useEffect`.',
        ],
        files: ['gatsby-node.js', 'src/templates/*'],
      }),
      remix: () => ({
        steps: [
          'Load content in the route `loader` so it is server-rendered; avoid `clientLoader` for primary content.',
        ],
        files: ['app/routes/*.tsx'],
      }),
      spa: () => ({
        steps: [
          'This is a client-side app: AI crawlers (GPTBot, ClaudeBot, PerplexityBot) do not run JavaScript, so they see an almost empty page.',
          'Best: move to a framework that renders on the server (Next.js, Nuxt, Angular SSR, Astro).',
          'Quicker: prerender every public route at build time (e.g. `vite-plugin-ssr`/Vike, `react-snap`, Angular `ng add @angular/ssr` with prerender) so each URL has its own HTML.',
        ],
        files: ['vite.config.ts / angular.json', 'routes list'],
      }),
      wordpress: () => ({
        steps: [
          'Content added by JavaScript (page builders’ dynamic widgets, tabs loaded by AJAX, JS-rendered reviews) is invisible to AI crawlers. Use blocks that output HTML on the server, and avoid lazy-loading text.',
        ],
        files: ['WordPress: page builder widgets'],
      }),
      unknown: () => ({
        steps: [
          'Make sure the main text, headings, links and JSON-LD are in the HTML the server sends, before any JavaScript runs.',
          'Test with `curl -A GPTBot <url>`: if the text is missing there, AI crawlers do not see it.',
        ],
        files: ['page templates'],
      }),
    });
    return {
      ...fix,
      title: 'Put the main content in the server HTML',
      acceptance: [
        '`curl` of each affected URL (no JavaScript) returns the main text, H1 and internal links',
      ],
    };
  },
};

export const recipes: Recipe[] = [contentSignal, firewall, aiRobots, llmsTxt, jsRendering];
