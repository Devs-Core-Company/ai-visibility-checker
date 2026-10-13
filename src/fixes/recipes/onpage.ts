/**
 * On-page recipes: titles, meta descriptions, headings, images, social tags, language.
 */
import { suggestMetaRules } from '../generate.js';
import { brandOf, byStack, metaFix, templateFile } from '../stacks.js';
import type { Recipe, RecipeInput } from '../types.js';

function suggestionsBlock(input: RecipeInput, field: 'title' | 'description'): string | null {
  const pages = input.pages ?? input.result?.pages ?? [];
  const lines: string[] = [];
  for (const url of input.urls.slice(0, 10)) {
    const p = pages.find((x) => x.url === url || x.finalUrl === url);
    if (!p) continue;
    const s = suggestMetaRules(
      { url, title: p.title, metaDescription: p.metaDescription, h1: p.h1 },
      { brand: brandOf(input), force: true },
    );
    const v = field === 'title' ? s.title?.suggested : s.description?.suggested;
    if (v) lines.push(`${url}\n  → ${v}`);
  }
  return lines.length ? lines.join('\n') : null;
}

const titles: Recipe = {
  id: 'titles',
  patterns: [/^onpage\..*title/, /^duplicates\..*title/],
  impact: 'medium',
  effort: 'hours',
  auto: { wordpress: true, repo: true },
  build(input) {
    const p = (input.pages ?? []).find((x) => x.url === input.urls[0]);
    const f = metaFix(input, { field: 'title', example: p?.h1 ?? undefined });
    const sugg = suggestionsBlock(input, 'title');
    return {
      ...f,
      title: 'Write a clear, unique title for each page',
      steps: [
        'Each title: what the page is, in about 50–60 characters, unique across the site, brand at the end.',
        ...f.steps,
        ...(sugg ? [`Starting points from the H1s (edit them):\n${sugg}`] : []),
      ],
    };
  },
};

const descriptions: Recipe = {
  id: 'descriptions',
  patterns: [/^onpage\..*(description|meta-desc)/, /^duplicates\..*description/],
  impact: 'low',
  effort: 'hours',
  auto: { wordpress: true, repo: true },
  build(input) {
    const f = metaFix(input, { field: 'description' });
    return {
      ...f,
      title: 'Write a meta description for each page',
      steps: [
        'One or two sentences (about 120–155 characters) that say what the visitor gets. AI search tools often show or reuse it as the page summary.',
        ...f.steps,
        'Pages with real body text can get a draft from `avc fix --suggest-meta` (uses your configured model, or rules without one).',
      ],
    };
  },
};

const headings: Recipe = {
  id: 'headings',
  patterns: ['headings.*', /^onpage\..*(h1|heading)/],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const f = metaFix(input, { field: 'h1' });
    return {
      ...f,
      title: 'Fix the heading structure',
      steps: [
        ...f.steps,
        'Under the H1, use H2s for sections and H3s inside them; do not skip levels for styling. AI engines use headings to find the passage that answers a question.',
      ],
    };
  },
};

const images: Recipe = {
  id: 'images',
  patterns: ['images.*'],
  impact: 'low',
  effort: 'hours',
  build(input) {
    const id = input.def.id;
    const alt = /alt/.test(id);
    const dims = /dimension|width|height|cls/.test(id);
    const lazy = /lazy|loading/.test(id);
    const size = /size|large|heavy|format|webp|avif|bytes|weight/.test(id);
    const what = alt
      ? 'Add alt text that describes what the image shows (empty `alt=""` for purely decorative images).'
      : dims
        ? 'Set `width` and `height` on every `<img>` so the browser reserves space (no layout shift).'
        : lazy
          ? 'Lazy-load images below the fold (`loading="lazy"`), but never the main (LCP) image above the fold.'
          : size
            ? 'Resize images to the size they are shown at, and serve WebP or AVIF.'
            : input.def.fix;
    const fix = byStack(input, {
      nextjs: () => ({
        steps: [
          'Use `next/image`: it sets dimensions, lazy-loads, resizes and serves modern formats. Give it a real `alt`; add `priority` to the hero image.',
        ],
        files: ['components/*', templateFile(input)],
        snippet: {
          language: 'tsx',
          code: `import Image from 'next/image';\n\n<Image src="/team.jpg" alt="Our support team at the Manchester office" width={1200} height={800} />`,
        },
      }),
      astro: () => ({
        steps: [
          'Use `<Image />` from `astro:assets` (sets width/height, lazy loading and modern formats).',
        ],
        files: ['src/components/*'],
        snippet: {
          language: 'astro',
          code: `---\nimport { Image } from 'astro:assets';\nimport team from '../assets/team.jpg';\n---\n<Image src={team} alt="Our support team at the Manchester office" />`,
        },
      }),
      nuxt: () => ({
        steps: [
          'Use `<NuxtImg>` from `@nuxt/image` with `width`, `height`, `alt` and `format="webp"`.',
        ],
        files: ['components/*'],
      }),
      gatsby: () => ({
        steps: ['Use `GatsbyImage`/`StaticImage` from gatsby-plugin-image with an `alt`.'],
        files: ['src/components/*'],
      }),
      sveltekit: () => ({
        steps: ['Use `@sveltejs/enhanced-img` (`<enhanced:img>`) for local images; set `alt`.'],
        files: ['src/lib/components/*'],
      }),
      wordpress: () => ({
        steps: [
          alt
            ? 'Media → Library → each image → Alternative Text. `avc fix --apply --target wordpress` can fill alt text for images whose file names are descriptive, with a rollback file; others need a human description.'
            : 'WordPress adds width/height and lazy loading for images inserted through the editor. Use an image optimiser (e.g. your host’s, or a plugin) for WebP/AVIF and resizing; check theme templates that print `<img>` by hand.',
        ],
        files: ['WordPress: Media Library', 'theme templates'],
      }),
      shopify: () => ({
        steps: [
          alt
            ? 'Products → each image → Add alt text (also Content → Files).'
            : 'Use `{{ image | image_url: width: 1200 | image_tag: loading: "lazy", widths: "400,800,1200" }}` in sections.',
        ],
        files: ['Shopify admin: product media', 'sections/*.liquid'],
      }),
      hosted: () => ({
        steps: [
          alt
            ? 'Select each image in the designer → settings → Alt text.'
            : 'Upload images at the size they are shown; the platform converts formats.',
        ],
        files: ['Designer: image settings'],
      }),
      unknown: () => ({
        steps: ['Update the `<img>` tags in the templates.'],
        files: [templateFile(input)],
        snippet: {
          language: 'html',
          code: '<img src="/img/team-800.webp" alt="Our support team at the Manchester office" width="800" height="533" loading="lazy" decoding="async" />',
        },
      }),
    });
    return {
      ...fix,
      title: input.def.title,
      steps: [
        what,
        ...fix.steps,
        `Pages affected:\n${input.urls
          .slice(0, 10)
          .map((u) => `- ${u}`)
          .join('\n')}`,
      ],
    };
  },
};

const social: Recipe = {
  id: 'social-tags',
  patterns: [/^onpage\..*(og-|open-graph|twitter|social)/],
  impact: 'low',
  effort: 'hours',
  build(input) {
    const f = metaFix(input, { field: 'title' });
    return {
      title: 'Add Open Graph tags',
      steps: [
        'Add og:title, og:description, og:image (1200×630), og:url and og:type to each page; they are also used when links are shared in chat and AI tools.',
        input.stack.id === 'nextjs'
          ? 'Next.js: set `openGraph` in `metadata`/`generateMetadata`, or add `opengraph-image.tsx` next to the page.'
          : f.steps[0],
      ],
      files: f.files,
      snippet: {
        language: 'html',
        code: `<meta property="og:title" content="Page title" />\n<meta property="og:description" content="One-sentence summary." />\n<meta property="og:image" content="${input.origin}/og/page.jpg" />\n<meta property="og:url" content="${input.origin}/page" />\n<meta property="og:type" content="website" />`,
      },
    };
  },
};

const lang: Recipe = {
  id: 'html-lang',
  patterns: [/(^|\.)(lang|html-lang|language)(-|$)/],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    return {
      title: 'Declare the page language',
      steps: [
        input.stack.id === 'nextjs'
          ? 'Set `<html lang="en-GB">` in `app/layout.tsx` (or `pages/_document.tsx`).'
          : input.stack.id === 'wordpress'
            ? 'Settings → General → Site Language; the theme prints it via `language_attributes()`.'
            : 'Set the `lang` attribute on the `<html>` element in the base layout.',
      ],
      files: [input.stack.id === 'nextjs' ? 'app/layout.tsx' : 'base layout'],
      snippet: { language: 'html', code: '<html lang="en-GB">' },
    };
  },
};

const imagesAlt: Recipe = {
  ...images,
  id: 'images-alt',
  patterns: [/^images\..*alt/, /^accessibility\..*(alt|img)/],
  auto: { wordpress: true },
};

export const recipes: Recipe[] = [titles, descriptions, headings, imagesAlt, images, social, lang];
