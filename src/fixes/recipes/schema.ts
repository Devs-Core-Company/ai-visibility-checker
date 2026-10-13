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
import { jsonLdFix } from '../stacks.js';
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
  patterns: [/same-?as/, /^geo-entity\./, /^entity\./],
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
  schemaErrors,
  faqSchema,
  breadcrumbs,
  article,
  localBusiness,
  organization,
  sameAs,
  schemaGeneric,
];
