/**
 * Stack knowledge shared by every recipe: where static files live, where site-wide <head>
 * markup goes, how per-page metadata is set, and how to add response headers on each host.
 */
import type { StackId, StackInfo } from '../core/types.js';
import type { NextRouter, RecipeInput, StackFix } from './types.js';

export type StackKey = StackId | 'nextjs-app' | 'nextjs-pages' | 'spa' | 'hosted' | 'server';

const LABELS: Record<StackId, string> = {
  nextjs: 'Next.js',
  nuxt: 'Nuxt',
  gatsby: 'Gatsby',
  astro: 'Astro',
  sveltekit: 'SvelteKit',
  remix: 'Remix / React Router',
  angular: 'Angular',
  'react-spa': 'React (client-side app)',
  'vue-spa': 'Vue (client-side app)',
  wordpress: 'WordPress',
  shopify: 'Shopify',
  webflow: 'Webflow',
  wix: 'Wix',
  squarespace: 'Squarespace',
  ghost: 'Ghost',
  drupal: 'Drupal',
  joomla: 'Joomla',
  hubspot: 'HubSpot CMS',
  framer: 'Framer',
  hugo: 'Hugo',
  jekyll: 'Jekyll',
  static: 'static HTML',
  unknown: 'an undetected stack',
};

const HOSTED: StackId[] = ['webflow', 'wix', 'squarespace', 'framer', 'hubspot'];
const SPA: StackId[] = ['react-spa', 'vue-spa', 'angular'];
/** Stacks where the site owner edits source files in a repository. */
export const CODE_STACKS: StackId[] = [
  'nextjs',
  'nuxt',
  'gatsby',
  'astro',
  'sveltekit',
  'remix',
  'angular',
  'react-spa',
  'vue-spa',
  'hugo',
  'jekyll',
  'static',
];

export function isHosted(id: StackId): boolean {
  return HOSTED.includes(id);
}

export function nextRouterFromSignals(stack: StackInfo): NextRouter {
  if (stack.id !== 'nextjs') return null;
  const s = stack.signals.join(' ').toLowerCase();
  if (/app[ -]?router|__next_f|rsc|react server/.test(s)) return 'app';
  if (/pages[ -]?router|__next_data__/.test(s)) return 'pages';
  return null;
}

export function stackLabel(stack: StackInfo, router: NextRouter = null): string {
  const base = LABELS[stack.id] ?? stack.id;
  if (stack.id === 'nextjs')
    return router === 'pages'
      ? 'Next.js (Pages Router)'
      : router === 'app'
        ? 'Next.js (App Router)'
        : 'Next.js';
  if (stack.id === 'wordpress' && stack.seoPlugin) return `WordPress + ${seoPluginLabel(stack)}`;
  return base;
}

export function seoPluginLabel(stack: StackInfo): string {
  const p = (stack.seoPlugin ?? '').toLowerCase();
  if (p.includes('yoast')) return 'Yoast SEO';
  if (p.includes('rank')) return 'Rank Math';
  if (p.includes('aioseo') || p.includes('all in one')) return 'All in One SEO';
  return stack.seoPlugin ?? 'no SEO plugin';
}

export function wpPlugin(stack: StackInfo): 'yoast' | 'rank-math' | 'aioseo' | null {
  const p = (stack.seoPlugin ?? '').toLowerCase();
  if (p.includes('yoast')) return 'yoast';
  if (p.includes('rank')) return 'rank-math';
  if (p.includes('aioseo') || p.includes('all in one')) return 'aioseo';
  return null;
}

/**
 * Pick the builder for the input's stack. Lookup order: Next.js router variant, exact
 * stack id, group ('spa' / 'hosted'), then 'unknown'.
 */
export function byStack(
  input: RecipeInput,
  map: Partial<Record<StackKey, (i: RecipeInput) => StackFix>>,
): StackFix {
  const id = input.stack.id;
  const keys: StackKey[] = [];
  if (id === 'nextjs') {
    keys.push(input.router === 'pages' ? 'nextjs-pages' : 'nextjs-app');
  }
  keys.push(id);
  if (SPA.includes(id)) keys.push('spa');
  if (HOSTED.includes(id)) keys.push('hosted');
  keys.push('unknown', 'static');
  for (const k of keys) {
    const fn = map[k];
    if (fn) return fn(input);
  }
  return { steps: [], files: [] };
}

/** Escape text for a JS template literal / TS string. */
export function tsString(s: string): string {
  return '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
}

export function json(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n);
  return s
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Static files at the site root (robots.txt, llms.txt, /.well-known/*)
// ---------------------------------------------------------------------------

export function contentTypeFor(path: string): string {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.md') || path.endsWith('llms.txt') || path.endsWith('llms-full.txt'))
    return 'text/plain; charset=utf-8';
  if (path.endsWith('.xml')) return 'application/xml';
  return 'text/plain; charset=utf-8';
}

/** A Cloudflare Worker that serves one file at a path and passes everything else through. */
export function workerServeFile(path: string, content: string): string {
  return `// Cloudflare Worker: serves /${path} and passes every other request to your site.
// Workers & Pages → Create → Worker, paste this, then add a route for yourdomain.com/${path}
const BODY = ${tsString(content)};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/${path}') {
      return new Response(BODY, {
        headers: { 'content-type': '${contentTypeFor(path)}', 'cache-control': 'public, max-age=3600' },
      });
    }
    return fetch(request);
  },
};`;
}

const REDIRECT_UI: Partial<Record<StackId, string>> = {
  webflow: 'Site settings → Publishing → 301 redirects',
  wix: 'Settings → SEO → URL redirect manager',
  squarespace: 'Settings → Developer tools → URL mappings',
  framer: 'Site settings → Redirects',
  hubspot: 'Settings → Content → Domains & URLs → URL redirects',
  shopify: 'Online Store → Navigation → URL redirects',
};

/** Where to put a file so it is served at `/<relPath>`. */
export function staticFile(
  input: RecipeInput,
  relPath: string,
  content: string,
  language = 'text',
): StackFix {
  const snippet = { language, code: content };
  const dot = relPath.startsWith('.');
  const verify = `Open ${input.origin}/${relPath} in a browser and confirm it returns the file with status 200.`;
  const inFolder =
    (folder: string, note?: string) =>
    (i: RecipeInput): StackFix => ({
      steps: [
        `Create \`${folder}${relPath}\` with the content below.`,
        note ?? `${stackLabel(i.stack, i.router)} serves files in \`${folder}\` at the site root.`,
        'Deploy.',
        verify,
      ],
      files: [`${folder}${relPath}`],
      snippet,
    });
  const hosted = (i: RecipeInput): StackFix => ({
    steps: [
      `${LABELS[i.stack.id]} does not let you place your own files at the root of the domain.`,
      `Option 1: host the file elsewhere (for example a Cloudflare R2 or GitHub Pages URL) and add a 301 redirect from \`/${relPath}\` to it in ${REDIRECT_UI[i.stack.id] ?? 'the redirects settings'}. Most AI crawlers follow one redirect.`,
      `Option 2 (cleaner): if your DNS is on Cloudflare, serve the file from a Worker on the route \`${input.host}/${relPath}\` (code below).`,
      verify,
    ],
    files: [`Worker route: /${relPath}`],
    snippet: { language: 'javascript', code: workerServeFile(relPath, content) },
  });
  return byStack(input, {
    nextjs: inFolder('public/'),
    remix: inFolder('public/'),
    astro: inFolder('public/'),
    nuxt: inFolder(
      'public/',
      'Nuxt 3 serves `public/` at the site root (Nuxt 2 used `static/` instead).',
    ),
    'react-spa': inFolder('public/'),
    'vue-spa': inFolder('public/'),
    angular: inFolder(
      'public/',
      'Angular 17+ serves `public/` at the root. In older projects put it in `src/` and add it to `assets` in angular.json.',
    ),
    sveltekit: inFolder('static/'),
    gatsby: inFolder('static/'),
    hugo: inFolder('static/'),
    jekyll: (i) => ({
      steps: [
        `Create \`${relPath}\` in the site source folder with the content below.`,
        ...(dot
          ? [
              `Jekyll skips dot-folders: add \`include: [".well-known"]\` to \`_config.yml\` so \`${relPath}\` is copied to \`_site/\`.`,
            ]
          : []),
        'Build and deploy.',
        verify,
      ],
      files: [relPath, ...(dot ? ['_config.yml'] : [])],
      snippet,
    }),
    wordpress: (i) => ({
      steps: [
        `Upload \`${relPath}\` to the WordPress root (the folder that holds wp-config.php) with SFTP or your host's file manager. A real file takes precedence over anything WordPress generates.`,
        relPath === 'robots.txt' || relPath === 'llms.txt'
          ? `Or install the AVC helper (\`avc fix --wp-helper\` prints it) and run \`avc fix --apply --target wordpress\`; it stores the file in WordPress and keeps a rollback copy.`
          : 'Some hosts block dot-folders such as /.well-known; ask your host to allow the path if you get a 403.',
        verify,
      ],
      files: [`${relPath} (WordPress root, next to wp-config.php)`],
      snippet,
    }),
    shopify: (i) => ({
      steps: [
        'Shopify does not let you upload files to the root of your domain.',
        `Upload the file in Content → Files, copy its URL, then add a redirect from \`/${relPath}\` to that URL in ${REDIRECT_UI.shopify}.`,
        `If your domain is proxied through Cloudflare, a Worker on \`/${relPath}\` serves it directly instead (see the Worker pattern in the docs).`,
        verify,
      ],
      files: [`Content → Files: ${relPath.split('/').pop()}`, `URL redirect: /${relPath}`],
      snippet,
    }),
    ghost: (i) => ({
      steps: [
        relPath === 'robots.txt'
          ? 'Add `robots.txt` to the root of your theme folder, zip the theme and upload it in Settings → Design → Change theme. Ghost serves a theme robots.txt instead of its default.'
          : `Ghost only serves robots.txt from the theme. For \`/${relPath}\`, self-hosted sites can add an nginx \`location = /${relPath}\` block that serves the file; Ghost(Pro) sites need a redirect (in \`redirects.yaml\`, Settings → Labs) or a Cloudflare Worker.`,
        verify,
      ],
      files: [relPath === 'robots.txt' ? 'content/themes/<theme>/robots.txt' : `nginx: /${relPath}`],
      snippet,
    }),
    drupal: inFolder(
      'web/',
      'Composer-based Drupal serves the `web/` folder (older installs: the Drupal root).',
    ),
    hosted,
    static: inFolder('', 'Put it in the folder your web server serves as the document root.'),
    unknown: inFolder(
      '',
      'Put it in the folder your web server or framework serves at the root (often `public/` or `static/`).',
    ),
  });
}

// ---------------------------------------------------------------------------
// JSON-LD placement
// ---------------------------------------------------------------------------

/** Where to put a JSON-LD block. scope 'site' = every page (Organization/WebSite); 'page' = one template. */
export function jsonLdFix(
  input: RecipeInput,
  data: unknown,
  scope: 'site' | 'page',
  typeName: string,
): StackFix {
  const body = json(data);
  const scriptTag = `<script type="application/ld+json">\n${body}\n</script>`;
  const where = scope === 'site' ? 'every page' : 'the affected page template';
  const check = `Validate with https://validator.schema.org/ and Google's Rich Results Test on ${input.urls[0] ?? input.origin}.`;
  const plugin = wpPlugin(input.stack);
  return byStack(input, {
    'nextjs-app': () => ({
      steps: [
        `Create \`components/json-ld.tsx\` (below).`,
        scope === 'site'
          ? 'Render `<JsonLd data={organization} />` inside `<body>` in `app/layout.tsx`.'
          : `Render \`<JsonLd data={...} />\` in the \`page.tsx\` of the affected route, built from the page's data so it stays in step with the content.`,
        'The script is rendered on the server, so crawlers that do not run JavaScript still see it.',
        check,
      ],
      files: ['components/json-ld.tsx', scope === 'site' ? 'app/layout.tsx' : 'app/<route>/page.tsx'],
      snippet: {
        language: 'tsx',
        code: `// components/json-ld.tsx
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // Escape < so text in the data cannot close the script tag.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\\\u003c') }}
    />
  );
}

// ${scope === 'site' ? 'app/layout.tsx' : 'app/<route>/page.tsx'}
const ${lcFirst(typeName)} = ${indent(body, 0)};
// …inside the returned JSX:
// <JsonLd data={${lcFirst(typeName)}} />`,
      },
    }),
    'nextjs-pages': () => ({
      steps: [
        scope === 'site'
          ? 'Add the script inside `<Head>` in `pages/_app.tsx` (or in `pages/_document.tsx`).'
          : 'Add the script inside `<Head>` from `next/head` in the affected page file.',
        check,
      ],
      files: [scope === 'site' ? 'pages/_app.tsx' : 'pages/<route>.tsx'],
      snippet: {
        language: 'tsx',
        code: `import Head from 'next/head';

const ${lcFirst(typeName)} = ${body};

<Head>
  <script
    type="application/ld+json"
    dangerouslySetInnerHTML={{ __html: JSON.stringify(${lcFirst(typeName)}) }}
  />
</Head>`,
      },
    }),
    astro: () => ({
      steps: [
        scope === 'site'
          ? 'Add the script to the `<head>` of your base layout (usually `src/layouts/Layout.astro` or `BaseLayout.astro`).'
          : 'Add the script to the affected page in `src/pages/`, or pass the data to the layout as a prop.',
        check,
      ],
      files: [scope === 'site' ? 'src/layouts/Layout.astro' : 'src/pages/<route>.astro'],
      snippet: {
        language: 'astro',
        code: `---
const ${lcFirst(typeName)} = ${body};
---
<script type="application/ld+json" set:html={JSON.stringify(${lcFirst(typeName)})} />`,
      },
    }),
    nuxt: () => ({
      steps: [
        scope === 'site'
          ? 'Call `useHead` in `app.vue` (or install the `nuxt-schema-org` module for typed helpers).'
          : 'Call `useHead` in the affected page component under `pages/`.',
        check,
      ],
      files: [scope === 'site' ? 'app.vue' : 'pages/<route>.vue'],
      snippet: {
        language: 'vue',
        code: `<script setup lang="ts">
const ${lcFirst(typeName)} = ${body};
useHead({
  script: [{ type: 'application/ld+json', innerHTML: JSON.stringify(${lcFirst(typeName)}) }],
});
</script>`,
      },
    }),
    sveltekit: () => ({
      steps: [
        scope === 'site'
          ? 'Add it to `src/routes/+layout.svelte` inside `<svelte:head>`.'
          : 'Add it to the affected `+page.svelte` inside `<svelte:head>`.',
        check,
      ],
      files: [scope === 'site' ? 'src/routes/+layout.svelte' : 'src/routes/<route>/+page.svelte'],
      snippet: {
        language: 'svelte',
        code: `<script lang="ts">
  const ${lcFirst(typeName)} = ${body};
  const ld = \`<script type="application/ld+json">\${JSON.stringify(${lcFirst(typeName)})}</\` + \`script>\`;
</script>

<svelte:head>
  {@html ld}
</svelte:head>`,
      },
    }),
    gatsby: () => ({
      steps: [
        scope === 'site'
          ? 'Add the script with `setHeadComponents` in `gatsby-ssr.js` so it is in every page.'
          : "Return the script from the page's `Head` export.",
        check,
      ],
      files: [scope === 'site' ? 'gatsby-ssr.js' : 'src/pages/<route>.tsx'],
      snippet: {
        language: 'jsx',
        code: `// gatsby-ssr.js
const ${lcFirst(typeName)} = ${body};

export const onRenderBody = ({ setHeadComponents }) => {
  setHeadComponents([
    <script
      key="${lcFirst(typeName)}"
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(${lcFirst(typeName)}) }}
    />,
  ]);
};`,
      },
    }),
    remix: () => ({
      steps: [
        scope === 'site'
          ? 'Return it from the `meta` export in `app/root.tsx` as `script:ld+json`.'
          : 'Return it from the `meta` export of the affected route module.',
        check,
      ],
      files: [scope === 'site' ? 'app/root.tsx' : 'app/routes/<route>.tsx'],
      snippet: {
        language: 'tsx',
        code: `export const meta: MetaFunction = () => [
  { 'script:ld+json': ${indent(body, 2).trimStart()} },
];`,
      },
    }),
    spa: (i) => ({
      steps: [
        scope === 'site'
          ? 'Paste the script into the `<head>` of `index.html` so it is in the served HTML, not added by JavaScript.'
          : `${LABELS[i.stack.id]} renders in the browser, so page-specific JSON-LD added at runtime is not seen by most AI crawlers. Prerender the route (or move to SSR) and put the script in the prerendered HTML.`,
        check,
      ],
      files: [scope === 'site' ? 'index.html' : 'prerendered HTML for the route'],
      snippet: { language: 'html', code: scriptTag },
    }),
    wordpress: () => {
      const pluginSteps =
        plugin === 'yoast'
          ? [
              'Yoast SEO already outputs Organization/WebSite/Article/BreadcrumbList. Fill it in: Yoast SEO → Settings → Site representation (name, logo, social profiles).',
            ]
          : plugin === 'rank-math'
            ? [
                'Rank Math outputs this schema. Fill it in: Rank Math → Titles & Meta → Local SEO (organisation name, logo, social profiles), and per post: Rank Math → Schema.',
              ]
            : plugin === 'aioseo'
              ? [
                  'All in One SEO outputs this schema. Fill it in: All in One SEO → Search Appearance → Global Settings → Knowledge Graph, and per post: AIOSEO Settings → Schema.',
                ]
              : [];
      return {
        steps: [
          ...pluginSteps,
          `${pluginSteps.length ? 'If you need a type the plugin does not cover, add' : 'Add'} the code below to your child theme's \`functions.php\` (or a small plugin) so the script is printed in <head> on ${where}.`,
          check,
        ],
        files: ['wp-content/themes/<child-theme>/functions.php'],
        snippet: {
          language: 'php',
          code: `add_action('wp_head', function () {
  ${scope === 'page' ? "if (!is_singular()) return; // narrow to the right template\n  " : ''}$data = json_decode(<<<'JSON'
${body}
JSON, true);
  echo '<script type="application/ld+json">' . wp_json_encode($data, JSON_UNESCAPED_SLASHES) . '</script>' . "\\n";
});`,
        },
      };
    },
    shopify: () => ({
      steps: [
        scope === 'site'
          ? 'Online Store → Themes → Edit code → `layout/theme.liquid`: paste the script just before `</head>`.'
          : 'Edit the template or section for the affected page type (e.g. `sections/main-product.liquid`) and paste the script there, using Liquid objects for the values.',
        check,
      ],
      files: [scope === 'site' ? 'layout/theme.liquid' : 'sections/<template>.liquid'],
      snippet: { language: 'liquid', code: scriptTag },
    }),
    webflow: () => ({
      steps: [
        scope === 'site'
          ? 'Site settings → Custom code → Head code: paste the script, then publish.'
          : 'Page settings → Custom code → Inside <head> tag (for CMS templates, insert field values with the "+ Add field" button).',
        check,
      ],
      files: [scope === 'site' ? 'Webflow: Site settings → Custom code' : 'Webflow: Page settings'],
      snippet: { language: 'html', code: scriptTag },
    }),
    wix: () => ({
      steps: [
        scope === 'site'
          ? 'Settings → Custom code → Add custom code: paste the script, place it in Head, load on all pages.'
          : 'Open the page → SEO basics → Advanced SEO → Structured data markup → Add new markup, paste the JSON (without the <script> tag).',
        check,
      ],
      files: ['Wix: Settings → Custom code'],
      snippet: { language: scope === 'site' ? 'html' : 'json', code: scope === 'site' ? scriptTag : body },
    }),
    squarespace: () => ({
      steps: [
        scope === 'site'
          ? 'Settings → Developer tools → Code injection → Header: paste the script.'
          : 'Page settings → Advanced → Page header code injection: paste the script.',
        'Code injection needs a Core plan or higher.',
        check,
      ],
      files: ['Squarespace: Code injection'],
      snippet: { language: 'html', code: scriptTag },
    }),
    ghost: () => ({
      steps: [
        scope === 'site'
          ? 'Settings → Code injection → Site header: paste the script. Ghost already outputs Article and Organization basics; add only what is missing.'
          : 'Open the post → Settings → Code injection → Post header: paste the script.',
        check,
      ],
      files: ['Ghost: Settings → Code injection'],
      snippet: { language: 'html', code: scriptTag },
    }),
    drupal: () => ({
      steps: [
        'Install the Schema.org Metatag module (`composer require drupal/schema_metatag`) and enable the sub-module for this type, then fill the fields in Configuration → Search and metadata → Metatag.',
        'Or add the script to your theme’s `html.html.twig` (site-wide) or the node template.',
        check,
      ],
      files: ['Metatag: Schema.org settings', 'themes/<theme>/templates/html.html.twig'],
      snippet: { language: 'html', code: scriptTag },
    }),
    hubspot: () => ({
      steps: [
        'Settings → Content → Pages → Site header HTML (site-wide), or the page’s Settings → Advanced → Head HTML.',
        check,
      ],
      files: ['HubSpot: Site header HTML'],
      snippet: { language: 'html', code: scriptTag },
    }),
    framer: () => ({
      steps: [
        'Site settings → General → Custom code → End of <head> (site-wide), or the page’s settings → Custom code.',
        check,
      ],
      files: ['Framer: Site settings → Custom code'],
      snippet: { language: 'html', code: scriptTag },
    }),
    hugo: () => ({
      steps: [
        scope === 'site'
          ? 'Add the script to `layouts/partials/head.html` (copy the theme’s head partial into your project’s `layouts/` to override it).'
          : 'Add it to the single-page layout (`layouts/_default/single.html`) and fill values from front matter.',
        check,
      ],
      files: [scope === 'site' ? 'layouts/partials/head.html' : 'layouts/_default/single.html'],
      snippet: { language: 'html', code: scriptTag },
    }),
    jekyll: () => ({
      steps: [
        scope === 'site'
          ? 'Add the script to `_includes/head.html` (or the `<head>` in `_layouts/default.html`). `jekyll-seo-tag` already outputs basic WebSite/Organization data.'
          : 'Add it to the layout used by the page (`_layouts/post.html` or `page.html`).',
        check,
      ],
      files: [scope === 'site' ? '_includes/head.html' : '_layouts/post.html'],
      snippet: { language: 'html', code: scriptTag },
    }),
    static: () => ({
      steps: [
        scope === 'site'
          ? 'Paste the script into the `<head>` of every HTML page (or the shared header include).'
          : 'Paste the script into the `<head>` of the affected HTML file.',
        check,
      ],
      files: [scope === 'site' ? 'index.html (and every page)' : '<page>.html'],
      snippet: { language: 'html', code: scriptTag },
    }),
  });
}

function lcFirst(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9]/g, '');
  return clean.charAt(0).toLowerCase() + clean.slice(1) + 'Schema';
}

// ---------------------------------------------------------------------------
// Per-page metadata (title, description, robots)
// ---------------------------------------------------------------------------

export interface MetaSpec {
  field: 'title' | 'description' | 'robots' | 'canonical' | 'h1';
  /** An example value from the first affected page. */
  example?: string;
}

export function metaFix(input: RecipeInput, spec: MetaSpec): StackFix {
  const f = spec.field;
  const ex = spec.example ?? (f === 'title' ? 'Page title – Brand' : 'One-sentence summary of the page.');
  const plugin = wpPlugin(input.stack);
  const label: Record<MetaSpec['field'], string> = {
    title: 'title tag',
    description: 'meta description',
    robots: 'robots meta tag',
    canonical: 'canonical link',
    h1: 'H1 heading',
  };
  const name = label[f];
  if (f === 'h1') return h1Fix(input);
  return byStack(input, {
    'nextjs-app': () => ({
      steps: [
        f === 'title'
          ? 'Set a title template once in `app/layout.tsx` (`title: { default, template }`) and a specific `title` in each page’s `metadata` or `generateMetadata`.'
          : f === 'description'
            ? 'Export `metadata` (static pages) or `generateMetadata` (dynamic routes) with a `description` from each page’s data.'
            : f === 'robots'
              ? 'Remove `robots: { index: false }` from the `metadata` of pages that should be indexed (check `app/layout.tsx` too: it applies to every child route).'
              : 'Set `metadataBase` in `app/layout.tsx` and `alternates: { canonical: "/path" }` in each page’s metadata.',
        'Metadata is rendered on the server, so it is in the HTML crawlers receive.',
      ],
      files: ['app/layout.tsx', 'app/<route>/page.tsx'],
      snippet: {
        language: 'tsx',
        code:
          f === 'canonical'
            ? `// app/layout.tsx
export const metadata: Metadata = { metadataBase: new URL('${input.origin}') };

// app/<route>/page.tsx
export async function generateMetadata({ params }): Promise<Metadata> {
  const { slug } = await params;
  return { alternates: { canonical: \`/<route>/\${slug}\` } };
}`
            : `import type { Metadata } from 'next';

// app/layout.tsx
export const metadata: Metadata = {
  metadataBase: new URL('${input.origin}'),
  title: { default: ${JSON.stringify(ex)}, template: '%s – ${brandOf(input)}' },
};

// app/<route>/page.tsx (dynamic route)
export async function generateMetadata({ params }): Promise<Metadata> {
  const { slug } = await params;
  const item = await getItem(slug); // your data loader
  return {
    title: item.seoTitle ?? item.title,
    description: item.summary, // 1–2 sentences, ~150 characters
${f === 'robots' ? '    robots: { index: true, follow: true },\n' : ''}  };
}`,
      },
    }),
    'nextjs-pages': () => ({
      steps: [`Set the ${name} with \`next/head\` in each page component (or a shared \`<Seo>\` component).`],
      files: ['pages/<route>.tsx', 'components/seo.tsx'],
      snippet: {
        language: 'tsx',
        code: `import Head from 'next/head';

<Head>
  <title>{${JSON.stringify(ex)}}</title>
  <meta name="description" content="One-sentence summary of the page." />
  <link rel="canonical" href="${input.origin}/path" />
</Head>`,
      },
    }),
    astro: () => ({
      steps: [
        'Give your base layout `title`, `description` (and `canonical`) props, render them in `<head>`, and pass real values from each page.',
      ],
      files: ['src/layouts/Layout.astro', 'src/pages/*.astro'],
      snippet: {
        language: 'astro',
        code: `---
// src/layouts/Layout.astro
const { title, description } = Astro.props;
const canonical = new URL(Astro.url.pathname, Astro.site);
---
<head>
  <title>{title}</title>
  <meta name="description" content={description} />
  <link rel="canonical" href={canonical} />
</head>`,
      },
    }),
    nuxt: () => ({
      steps: [
        'Set a `titleTemplate` in `nuxt.config.ts` (`app.head`) and call `useSeoMeta` in each page with values from the page data.',
      ],
      files: ['nuxt.config.ts', 'pages/<route>.vue'],
      snippet: {
        language: 'vue',
        code: `<script setup lang="ts">
const { data: page } = await useFetch('/api/page');
useSeoMeta({
  title: () => page.value?.title,
  description: () => page.value?.summary,
});
useHead({ link: [{ rel: 'canonical', href: '${input.origin}' + useRoute().path }] });
</script>`,
      },
    }),
    sveltekit: () => ({
      steps: ['Return the values from `+page.ts`/`+page.server.ts` and render them in `<svelte:head>`.'],
      files: ['src/routes/<route>/+page.svelte'],
      snippet: {
        language: 'svelte',
        code: `<script lang="ts">
  let { data } = $props();
</script>

<svelte:head>
  <title>{data.title} – ${brandOf(input)}</title>
  <meta name="description" content={data.summary} />
  <link rel="canonical" href={\`${input.origin}\${data.path}\`} />
</svelte:head>`,
      },
    }),
    gatsby: () => ({
      steps: ['Export a `Head` component from each page (or use a shared `Seo` component).'],
      files: ['src/pages/<route>.tsx', 'src/components/seo.tsx'],
      snippet: {
        language: 'tsx',
        code: `export const Head = ({ data }) => (
  <>
    <title>{data.page.title} – ${brandOf(input)}</title>
    <meta name="description" content={data.page.summary} />
  </>
);`,
      },
    }),
    remix: () => ({
      steps: ['Return title and description from each route’s `meta` export, using loader data.'],
      files: ['app/routes/<route>.tsx'],
      snippet: {
        language: 'tsx',
        code: `export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: \`\${data.title} – ${brandOf(input)}\` },
  { name: 'description', content: data.summary },
  { tagName: 'link', rel: 'canonical', href: \`${input.origin}\${data.path}\` },
];`,
      },
    }),
    spa: (i) => ({
      steps: [
        `${LABELS[i.stack.id]} sets ${name}s in the browser, which most AI crawlers never run. Prerender the routes (e.g. vite-plugin-prerender, Angular SSR/prerender, or a static export) so each URL’s HTML already has its own ${name}.`,
        'Until then, at least make the default in `index.html` accurate for the home page.',
      ],
      files: ['index.html', 'prerender config'],
      snippet: {
        language: 'html',
        code: `<title>${escapeHtml(ex)}</title>\n<meta name="description" content="One-sentence summary of the page." />`,
      },
    }),
    wordpress: () => ({
      steps:
        plugin === 'yoast'
          ? [
              f === 'robots'
                ? 'Edit the page → Yoast SEO box → Advanced → "Allow search engines to show this content in search results?" → Yes. Check Yoast SEO → Settings → Content types too.'
                : `Edit the page → Yoast SEO box → ${f === 'title' ? 'SEO title' : f === 'canonical' ? 'Advanced → Canonical URL' : 'Meta description'}. Set templates for whole post types in Yoast SEO → Settings → Content types.`,
              'Bulk option: `avc fix --apply --target wordpress` writes titles and descriptions through the REST API with a rollback file.',
            ]
          : plugin === 'rank-math'
            ? [
                f === 'robots'
                  ? 'Edit the page → Rank Math → Advanced → Robots Meta → tick Index. Check Rank Math → Titles & Meta for post-type defaults.'
                  : `Edit the page → Rank Math → Edit Snippet → ${f === 'title' ? 'Title' : f === 'canonical' ? 'Advanced → Canonical URL' : 'Description'}. Defaults per post type: Rank Math → Titles & Meta.`,
                'Bulk option: `avc fix --apply --target wordpress`.',
              ]
            : plugin === 'aioseo'
              ? [
                  f === 'robots'
                    ? 'Edit the page → AIOSEO Settings → Advanced → Robots Setting: turn off "Use Default Settings" or untick No Index.'
                    : `Edit the page → AIOSEO Settings → General → ${f === 'title' ? 'Post Title' : f === 'canonical' ? 'Advanced → Canonical URL' : 'Meta Description'}. Defaults: All in One SEO → Search Appearance → Content Types.`,
                  'Bulk option: `avc fix --apply --target wordpress`.',
                ]
              : [
                  `Install one SEO plugin (Yoast SEO, Rank Math or All in One SEO) to manage the ${name} per page, or install the AVC helper (\`avc fix --wp-helper\`) which adds simple per-page fields.`,
                  f === 'robots'
                    ? 'Also check Settings → Reading → "Discourage search engines from indexing this site" is unticked.'
                    : 'Then run `avc fix --apply --target wordpress` to fill them in bulk.',
                ],
      files: [`WordPress: ${seoPluginLabel(input.stack)} (per page)`],
    }),
    shopify: () => ({
      steps: [
        f === 'robots'
          ? 'Shopify adds noindex on some templates (search, cart). For other pages check `layout/theme.liquid` and the template for `<meta name="robots"`, and remove it where the page should be indexed.'
          : `For each product, collection, page or post: open it in the admin → "Search engine listing" → Edit, and set the ${f === 'title' ? 'page title' : 'meta description'}.`,
        'Check `layout/theme.liquid` outputs `<title>{{ page_title }}…</title>` and `<meta name="description" content="{{ page_description | escape }}">`.',
      ],
      files: ['Shopify admin: Search engine listing', 'layout/theme.liquid'],
    }),
    webflow: () => ({
      steps: [
        `Page settings → SEO settings → ${f === 'title' ? 'Title tag' : 'Meta description'}. For CMS collection pages, set it on the template page and bind it to collection fields.`,
      ],
      files: ['Webflow: Page settings → SEO'],
    }),
    wix: () => ({
      steps: [
        `Open the page → SEO basics → ${f === 'title' ? 'Title tag' : f === 'robots' ? 'Let search engines index this page (toggle on)' : 'Meta description'}. Set patterns for page types in Settings → SEO → SEO Settings.`,
      ],
      files: ['Wix: SEO basics'],
    }),
    squarespace: () => ({
      steps: [
        `Page settings → SEO → ${f === 'title' ? 'SEO title' : 'SEO description'}. Site-wide title formats: Settings → SEO (Marketing → SEO on older versions).`,
      ],
      files: ['Squarespace: Page settings → SEO'],
    }),
    ghost: () => ({
      steps: [`Open the post or page → Settings → Meta data → ${f === 'title' ? 'Meta title' : 'Meta description'}.`],
      files: ['Ghost: Post settings → Meta data'],
    }),
    drupal: () => ({
      steps: [
        'Install the Metatag module, set defaults per content type in Configuration → Search and metadata → Metatag (e.g. `[node:title] | [site:name]`, `[node:summary]`), and override per node where needed.',
      ],
      files: ['Drupal: Metatag defaults'],
    }),
    joomla: () => ({
      steps: [
        `Menu item → Page Display → Browser Page Title (title), and Article → Publishing → Meta Description.`,
      ],
      files: ['Joomla: menu item and article settings'],
    }),
    hubspot: () => ({
      steps: [`Page editor → Settings → ${f === 'title' ? 'Page title' : 'Meta description'}.`],
      files: ['HubSpot: page settings'],
    }),
    framer: () => ({
      steps: [`Page settings (gear icon) → SEO → ${f === 'title' ? 'Title' : 'Description'}. For CMS pages, bind to fields.`],
      files: ['Framer: page settings'],
    }),
    hugo: () => ({
      steps: [
        'Set `title` and `description` in each page’s front matter and make `layouts/partials/head.html` print them.',
      ],
      files: ['content/**/*.md (front matter)', 'layouts/partials/head.html'],
      snippet: {
        language: 'html',
        code: `<title>{{ if .IsHome }}{{ site.Title }}{{ else }}{{ .Title }} – {{ site.Title }}{{ end }}</title>
<meta name="description" content="{{ with .Description }}{{ . }}{{ else }}{{ .Summary | plainify | truncate 155 }}{{ end }}">
<link rel="canonical" href="{{ .Permalink }}">`,
      },
    }),
    jekyll: () => ({
      steps: [
        'Add `{% seo %}` (jekyll-seo-tag) to `_includes/head.html` and set `title` and `description` in each page’s front matter.',
      ],
      files: ['_includes/head.html', '_config.yml', '<page>.md (front matter)'],
      snippet: {
        language: 'yaml',
        code: `---\ntitle: ${ex}\ndescription: One-sentence summary of the page.\n---`,
      },
    }),
    static: () => ({
      steps: [`Edit the \`<head>\` of each affected HTML file and set a unique ${name}.`],
      files: ['<page>.html'],
      snippet: {
        language: 'html',
        code: `<title>${escapeHtml(ex)}</title>\n<meta name="description" content="One-sentence summary of the page." />\n<link rel="canonical" href="${input.origin}/path" />`,
      },
    }),
  });
}

function h1Fix(input: RecipeInput): StackFix {
  return {
    steps: [
      'Give each page exactly one `<h1>` that states what the page is about, in the HTML the server sends.',
      byStack(input, {
        wordpress: () => ({
          steps: [
            'In WordPress the post/page title is usually the H1. Check your theme does not hide it, and that blocks in the content use Heading 2 and below.',
          ],
          files: [],
        }),
        shopify: () => ({ steps: ['Check the section templates use one `<h1>` (usually the product/page title).'], files: [] }),
        hosted: () => ({ steps: ['In the designer, set the main heading’s tag to H1 and other headings to H2–H4.'], files: [] }),
        unknown: () => ({
          steps: ['Usually this is the page component or template that renders the main heading; logos and card titles should not be H1s.'],
          files: [],
        }),
      }).steps[0],
    ],
    files: [templateFile(input)],
    snippet: { language: 'html', code: '<h1>What this page is about, in plain words</h1>' },
  };
}

/** The most likely template file for page-level content changes on this stack. */
export function templateFile(input: RecipeInput): string {
  switch (input.stack.id) {
    case 'nextjs':
      return input.router === 'pages' ? 'pages/<route>.tsx' : 'app/<route>/page.tsx';
    case 'astro':
      return 'src/pages/<route>.astro';
    case 'nuxt':
      return 'pages/<route>.vue';
    case 'sveltekit':
      return 'src/routes/<route>/+page.svelte';
    case 'gatsby':
      return 'src/pages/<route>.tsx (or src/templates/)';
    case 'remix':
      return 'app/routes/<route>.tsx';
    case 'wordpress':
      return 'WordPress editor (and theme templates)';
    case 'shopify':
      return 'sections/*.liquid, templates/*.json';
    case 'hugo':
      return 'layouts/_default/single.html';
    case 'jekyll':
      return '_layouts/*.html';
    default:
      return isHosted(input.stack.id) ? `${LABELS[input.stack.id]} designer` : '<page>.html';
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function brandOf(input: { brand?: { name?: string }; origin: string }): string {
  if (input.brand?.name) return input.brand.name;
  try {
    return new URL(input.origin).host.replace(/^www\./, '');
  } catch {
    return 'Brand';
  }
}

// ---------------------------------------------------------------------------
// Response headers per host
// ---------------------------------------------------------------------------

export type HostTarget =
  | 'vercel'
  | 'netlify'
  | 'cloudflare'
  | 'nginx'
  | 'apache'
  | 'nextjs'
  | 'nuxt'
  | 'sveltekit'
  | 'wordpress'
  | 'headers-file';

/** Config that adds `headers` to responses matching `path` (default: every path). */
export function headerConfig(target: HostTarget, headers: Record<string, string>, path = '/*'): string {
  const entries = Object.entries(headers);
  const regexPath = path === '/*' ? '/(.*)' : path.replace(/\*/g, '(.*)');
  switch (target) {
    case 'vercel':
      return json({
        headers: [
          {
            source: regexPath,
            headers: entries.map(([key, value]) => ({ key, value })),
          },
        ],
      });
    case 'netlify':
      return `[[headers]]\n  for = "${path}"\n  [headers.values]\n${entries
        .map(([k, v]) => `    ${k} = ${JSON.stringify(v)}`)
        .join('\n')}`;
    case 'headers-file':
      return `${path}\n${entries.map(([k, v]) => `  ${k}: ${v}`).join('\n')}`;
    case 'cloudflare':
      return `// Cloudflare: Rules → Transform Rules → Modify Response Header (no code), or a Worker:
export default {
  async fetch(request) {
    const res = await fetch(request);
    const out = new Response(res.body, res);
${entries.map(([k, v]) => `    out.headers.set(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n')}
    return out;
  },
};`;
    case 'nginx':
      return `# inside the server { } block for your site\n${entries
        .map(([k, v]) => `add_header ${k} "${v.replace(/"/g, '\\"')}" always;`)
        .join('\n')}`;
    case 'apache':
      return `# .htaccess (needs mod_headers)\n<IfModule mod_headers.c>\n${entries
        .map(([k, v]) => `  Header always set ${k} "${v.replace(/"/g, '\\"')}"`)
        .join('\n')}\n</IfModule>`;
    case 'nextjs':
      return `// next.config.ts
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '${regexPath === '/(.*)' ? '/:path*' : regexPath}',
        headers: [
${entries.map(([k, v]) => `          { key: ${JSON.stringify(k)}, value: ${JSON.stringify(v)} },`).join('\n')}
        ],
      },
    ];
  },
};`;
    case 'nuxt':
      return `// nuxt.config.ts
export default defineNuxtConfig({
  routeRules: {
    '${path === '/*' ? '/**' : path}': {
      headers: ${indent(json(headers), 6).trimStart()},
    },
  },
});`;
    case 'sveltekit':
      return `// src/hooks.server.ts
export async function handle({ event, resolve }) {
  const response = await resolve(event);
${entries.map(([k, v]) => `  response.headers.set(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n')}
  return response;
}`;
    case 'wordpress':
      return `// functions.php (child theme) — prefer the web server config where you can
add_action('send_headers', function () {
${entries.map(([k, v]) => `  header(${JSON.stringify(`${k}: ${v}`)});`).join('\n')}
});`;
  }
}

const HOST_FILES: Record<HostTarget, string> = {
  vercel: 'vercel.json',
  netlify: 'netlify.toml',
  cloudflare: 'Cloudflare: Transform Rules (or a Worker)',
  nginx: 'nginx site config (server block)',
  apache: '.htaccess',
  nextjs: 'next.config.ts',
  nuxt: 'nuxt.config.ts',
  sveltekit: 'src/hooks.server.ts',
  wordpress: 'functions.php (child theme)',
  'headers-file': '_headers (Netlify / Cloudflare Pages)',
};

/** The primary place to set headers for this stack + host, and alternatives. */
export function headerTargets(stack: StackInfo): HostTarget[] {
  const host = `${stack.host ?? ''} ${stack.cdn ?? ''}`.toLowerCase();
  const out: HostTarget[] = [];
  if (host.includes('vercel')) out.push('vercel');
  if (host.includes('netlify')) out.push('netlify');
  if (host.includes('cloudflare')) out.push('cloudflare');
  if (stack.id === 'nextjs') out.push('nextjs');
  if (stack.id === 'nuxt') out.push('nuxt');
  if (stack.id === 'sveltekit') out.push('sveltekit');
  if (host.includes('nginx')) out.push('nginx');
  if (host.includes('apache') || host.includes('litespeed')) out.push('apache');
  if (['astro', 'gatsby', 'hugo', 'jekyll', 'static', 'react-spa', 'vue-spa'].includes(stack.id))
    out.push('headers-file');
  if (stack.id === 'wordpress' || stack.id === 'drupal' || stack.id === 'joomla')
    out.push('apache', 'nginx');
  if (stack.id === 'wordpress') out.push('wordpress');
  if (!out.length) out.push('nginx', 'apache', 'cloudflare');
  return [...new Set(out)];
}

export function headersFix(
  input: RecipeInput,
  headers: Record<string, string>,
  opts: { path?: string; why?: string } = {},
): StackFix {
  const id = input.stack.id;
  const verify = `Verify with \`curl -sI ${input.urls[0] ?? input.origin}\` and look for ${Object.keys(headers)
    .map((h) => `\`${h}\``)
    .join(', ')}.`;
  if (isHosted(id) || id === 'shopify') {
    return {
      steps: [
        `${LABELS[id]} does not let you set custom response headers on your domain.`,
        'If the domain is proxied through Cloudflare, add the headers with a Transform Rule (Rules → Transform Rules → Modify Response Header) or the Worker below.',
        ...(id === 'shopify' ? ['Shopify already sends HSTS on its own domains.'] : []),
        verify,
      ],
      files: [HOST_FILES.cloudflare],
      snippet: { language: 'javascript', code: headerConfig('cloudflare', headers, opts.path) },
    };
  }
  const targets = headerTargets(input.stack);
  const primary = targets[0];
  const lang: Record<HostTarget, string> = {
    vercel: 'json',
    netlify: 'toml',
    cloudflare: 'javascript',
    nginx: 'nginx',
    apache: 'apache',
    nextjs: 'ts',
    nuxt: 'ts',
    sveltekit: 'ts',
    wordpress: 'php',
    'headers-file': 'text',
  };
  const others = targets.slice(1, 4);
  return {
    steps: [
      `Add the headers in \`${HOST_FILES[primary]}\` (below).`,
      ...(primary === 'vercel'
        ? ['If `vercel.json` already has a `headers` array, add this entry to it rather than replacing it.']
        : []),
      ...others.map(
        (t) =>
          `Alternative: \`${HOST_FILES[t]}\` — ${headerConfig(t, headers, opts.path).split('\n').slice(0, 1)[0].replace(/^[#/ ]+/, '').slice(0, 80) || 'same headers'}.`,
      ),
      'Set each header in one place only; duplicates from two layers can conflict.',
      verify,
    ],
    files: targets.map((t) => HOST_FILES[t]),
    snippet: { language: lang[primary], code: headerConfig(primary, headers, opts.path) },
  };
}
