/**
 * Structured data and entity recipes. Each one generates real JSON-LD from the crawl
 * (names, URLs, titles, descriptions) and leaves TODO markers only for facts the crawl
 * cannot know (address, author, dates).
 */
import {
  generateArticleJsonLd,
  generateBreadcrumbJsonLd,
  generateLocalBusinessJsonLd,
  generateOrganizationJsonLd,
  generateSiteGraphJsonLd,
} from '../generate.js';
import { escapeHtml, jsonLdFix, seoPluginLabel } from '../stacks.js';
import type { Recipe, RecipeInput } from '../types.js';

function data(input: RecipeInput) {
  return { site: input.origin, pages: input.pages ?? input.result?.pages };
}

const VALIDATE = 'Validate at https://validator.schema.org/ and with Google’s Rich Results Test.';

const organization: Recipe = {
  id: 'schema-organization',
  patterns: [
    /^schema\.(organization|org|website|site|publisher|logo)/,
    /^geo-entity\..*(organization|org-schema|schema)/,
    /^geo-entity\.(org-(incomplete|no-contact|no-description|no-background|no-expertise|no-id|name-conflict)|logo-not-image|duplicate-org-nodes|publisher-mismatch)$/,
  ],
  impact: 'high',
  effort: 'minutes',
  auto: { repo: true },
  build(input) {
    const ld = generateSiteGraphJsonLd(data(input), input.brand);
    const f = jsonLdFix(input, ld, 'site', 'Organization');
    return {
      ...f,
      title: 'Add Organization and WebSite structured data',
      steps: [
        'The JSON-LD below was built from your site: name, URL and description. Add your logo URL and every official profile (LinkedIn, Wikipedia/Wikidata, Crunchbase, social accounts) to `sameAs` — that is how AI engines connect the site to the entity.',
        ...f.steps,
      ],
      acceptance: [
        'Every page (or at least the home page) has one Organization node with name, url, logo and sameAs',
        VALIDATE,
      ],
    };
  },
};

const sameAs: Recipe = {
  id: 'entity-same-as',
  patterns: [
    /^geo-entity\.(org-no-sameas|sameas-[a-z-]+|no-wikidata|social-not-in-sameas)$/,
    /^schema\..*same-?as/,
    /^entity\..*same-?as/,
  ],
  impact: 'medium',
  effort: 'hours',
  auto: { repo: true },
  build(input) {
    const org = generateOrganizationJsonLd(data(input), input.brand);
    if (!org.sameAs)
      org.sameAs = [
        'https://www.linkedin.com/company/TODO',
        'https://www.wikidata.org/wiki/TODO',
        'https://x.com/TODO',
      ];
    const f = jsonLdFix(input, org, 'site', 'Organization');
    return {
      ...f,
      title: 'Connect your site to your brand’s profiles (sameAs)',
      steps: [
        'List your official profiles in `sameAs` and link back to the site from each profile. Use the same name, logo and description everywhere.',
        'If the brand has no Wikidata item and is notable, create one with references; it is a strong entity signal for AI engines.',
        ...f.steps,
      ],
    };
  },
};

/** Files to touch for the detected stack, with a fallback. */
function filesFor(input: RecipeInput, m: Record<string, string[]> & { default: string[] }) {
  const id = input.stack.id;
  const key = id === 'nextjs' ? (input.router === 'pages' ? 'nextjs-pages' : 'nextjs-app') : id;
  return m[key] ?? m.default;
}

const brandName: Recipe = {
  id: 'entity-brand-name',
  patterns: [/^geo-entity\.(brand-inconsistent|no-og-site-name)$/],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    const name = input.brand?.name ?? 'Your Brand';
    const files = filesFor(input, {
      'nextjs-app': ['app/layout.tsx (`metadata.openGraph.siteName` and the title template)'],
      'nextjs-pages': ['pages/_app.tsx or your shared <Head> component'],
      wordpress: [
        `${seoPluginLabel(input.stack)} → site name / Open Graph settings, and Settings → General → Site Title`,
      ],
      shopify: ['layout/theme.liquid (`<meta property="og:site_name">`)'],
      default: ['the shared <head> template used by every page'],
    });
    return {
      title: 'Use one brand name everywhere AI engines look for it',
      steps: [
        `Pick the exact brand name (e.g. “${name}”) and use it, spelt the same way, in og:site_name, the end of every title tag, and the Organization schema \`name\`.`,
        'Set og:site_name once in the shared head template so every page carries it.',
        'Make the Organization `name` and any `alternateName` match; avoid different legal and trading names unless both are listed.',
      ],
      files,
      snippet: {
        language: 'html',
        code: `<meta property="og:site_name" content="${escapeHtml(name)}" />`,
      },
      acceptance: [
        'og:site_name, the title suffix and Organization name are identical on every page',
        `Verify with \`avc audit --only ${input.def.id}\``,
      ],
    };
  },
};

const entityPages: Recipe = {
  id: 'entity-pages',
  patterns: [/^geo-entity\.(no-about-page|about-not-linked|no-contact-page|no-author-pages)$/],
  impact: 'medium',
  effort: 'hours',
  tier: 'manual',
  build(input) {
    const id = input.def.id;
    const steps = id.endsWith('no-author-pages')
      ? [
          'Create a profile page for each author at a stable URL (e.g. /team/jane-doe): name, role, qualifications, a photo and links to their professional profiles.',
          'Link the byline on every article to that page, and add a Person node (with `url` and `sameAs`) as the Article `author`.',
        ]
      : id.endsWith('no-contact-page')
        ? [
            'Publish a Contact page (/contact) with the business name, address, phone and email exactly as they appear on your Google Business Profile.',
            'Link it from the header or footer of every page and add a `contactPoint` to the Organization schema.',
          ]
        : [
            'Publish an About page (/about) that states who you are, what you do, where, since when, and who runs it, with verifiable facts (registrations, qualifications, awards).',
            'Link it from the home page and the main navigation or footer, and point the Organization schema `url`/`sameAs` at the same facts.',
          ];
    return {
      title: id.endsWith('no-author-pages')
        ? 'Give every author a profile page'
        : id.endsWith('no-contact-page')
          ? 'Publish a Contact page'
          : 'Publish and link an About page',
      steps,
      files: filesFor(input, {
        wordpress: ['Pages → Add New, then Appearance → Menus (or the site editor) to link it'],
        default: ['a new page in your site, plus the shared header/footer template'],
      }),
      acceptance: [
        'The page returns 200, is indexable and is linked from the home page',
        `Verify with \`avc audit --only ${id}\``,
      ],
    };
  },
};

const localBusiness: Recipe = {
  id: 'schema-local-business',
  patterns: [/local-?business|(^|[.-])nap([.-]|$)|address/],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    const ld = generateLocalBusinessJsonLd(data(input), input.brand);
    const f = jsonLdFix(input, ld, 'site', 'LocalBusiness');
    return {
      ...f,
      title: 'Add LocalBusiness structured data',
      steps: [
        'Replace each TODO with the exact name, address and phone shown on the site and your Google Business Profile (they must match). Use the most specific type (e.g. `Dentist`, `LegalService`).',
        ...f.steps,
      ],
    };
  },
};

const article: Recipe = {
  id: 'schema-article',
  patterns: [
    /^schema\..*(article|blog|post|author|date)/,
    /^geo-content\..*(author|byline|date-published)/,
  ],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const p = (input.pages ?? []).find((x) => x.url === input.urls[0]);
    const ld = generateArticleJsonLd(
      {
        url: input.urls[0] ?? `${input.origin}/blog/example`,
        title: p?.title ?? null,
        h1: p?.h1,
        metaDescription: p?.metaDescription,
      },
      input.brand,
      input.origin,
    );
    const f = jsonLdFix(input, ld, 'page', 'Article');
    return {
      ...f,
      title: 'Add Article structured data to posts',
      steps: [
        'Generate it in the post template from the post’s own fields (title, description, author, published and modified dates, image) — the block below is the shape, filled from the first affected page.',
        ...f.steps,
      ],
    };
  },
};

const breadcrumbs: Recipe = {
  id: 'schema-breadcrumbs',
  patterns: [/breadcrumb/],
  impact: 'low',
  effort: 'hours',
  build(input) {
    const url =
      input.urls.find((u) => new URL(u).pathname.split('/').filter(Boolean).length >= 2) ??
      input.urls[0] ??
      `${input.origin}/section/page`;
    const ld = generateBreadcrumbJsonLd(url, input.pages ?? [], input.brand?.name);
    const f = jsonLdFix(input, ld, 'page', 'BreadcrumbList');
    return {
      ...f,
      title: 'Add BreadcrumbList structured data',
      steps: [
        'Build the list from the route in your page template (the example below is for one affected URL, with names from crawled titles).',
        ...f.steps,
      ],
    };
  },
};

const faqSchema: Recipe = {
  id: 'schema-faq',
  patterns: [/^schema\..*faq/],
  impact: 'low',
  effort: 'hours',
  build(input) {
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'The question exactly as shown on the page?',
          acceptedAnswer: { '@type': 'Answer', text: 'The full visible answer.' },
        },
      ],
    };
    const f = jsonLdFix(input, ld, 'page', 'FAQPage');
    return {
      ...f,
      title: 'Mark up visible FAQs',
      steps: [
        'Only mark up questions and answers that are visible on the page. `avc fix --faq <url>` extracts them from the page HTML and prints ready JSON-LD.',
        ...f.steps,
      ],
    };
  },
};

const schemaErrors: Recipe = {
  id: 'schema-errors',
  patterns: [
    /^schema\..*(invalid|error|parse|syntax|missing-required|required|warning|deprecated|mismatch)/,
  ],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const ev = input.issues
      .map((i) => i.evidence)
      .filter(Boolean)
      .slice(0, 3);
    return {
      title: 'Fix invalid structured data',
      steps: [
        'Paste each affected URL into https://validator.schema.org/ and fix every error: invalid JSON (trailing commas, unescaped quotes), wrong types, missing required properties.',
        'Make sure values in the markup match what is visible on the page.',
        ...(ev.length ? [`Evidence:\n${ev.join('\n')}`] : []),
      ],
      files: ['the component, template or plugin that outputs the JSON-LD'],
    };
  },
};

const schemaGeneric: Recipe = {
  id: 'schema-generic',
  patterns: ['schema.*'],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const ld = generateSiteGraphJsonLd(data(input), input.brand);
    return { ...jsonLdFix(input, ld, 'site', 'Organization'), title: input.def.title };
  },
};

export const recipes: Recipe[] = [
  brandName,
  entityPages,
  schemaErrors,
  faqSchema,
  breadcrumbs,
  article,
  localBusiness,
  organization,
  sameAs,
  schemaGeneric,
];
