/**
 * Structured data: JSON-LD validity, required and recommended properties
 * for the types that drive rich results and entity understanding, and
 * consistency with what the page actually shows.
 */
import type { Issue, PageData, SiteContext } from '../core/types.js';
import { isSchemaType, isSubtypeOf, SCHEMA_TYPES } from './schema-vocabulary.js';
import {
  ISO_DATE,
  REF,
  asArray,
  allNodes,
  groupBy,
  has,
  homePage,
  htmlPages,
  indexablePages,
  isArticleLike,
  isHomepage,
  isHtml200,
  isIndexable,
  list,
  nodeTypes,
  normText,
  pageCheck,
  plural,
  siteCheck,
  str,
  topNodes,
  truncate,
  words,
  type SchemaNode,
} from './_util.js';

export const HEADLINE_MAX = 110;
/** Folders with at least this many pages are compared for LocalBusiness markup. */
export const LOCAL_SIBLINGS_MIN = 3;
/** Share of sibling pages that must carry LocalBusiness markup. */
export const LOCAL_SIBLINGS_SHARE = 2 / 3;
export const BREADCRUMB_MIN_DEPTH = 2;

const C = 'content' as const;
const T = 'technical' as const;
const SD = (anchor: string) =>
  `https://developers.google.com/search/docs/appearance/structured-data/${anchor}`;

/** Common schema.org types, for catching case and spelling mistakes. */
const KNOWN_TYPES = [
  'Organization',
  'LocalBusiness',
  'Corporation',
  'Person',
  'WebSite',
  'WebPage',
  'AboutPage',
  'ContactPage',
  'FAQPage',
  'QAPage',
  'Question',
  'Answer',
  'HowTo',
  'HowToStep',
  'Article',
  'BlogPosting',
  'NewsArticle',
  'TechArticle',
  'Product',
  'ProductGroup',
  'Offer',
  'AggregateOffer',
  'AggregateRating',
  'Rating',
  'Review',
  'Brand',
  'BreadcrumbList',
  'ListItem',
  'ItemList',
  'Event',
  'Place',
  'PostalAddress',
  'GeoCoordinates',
  'ImageObject',
  'VideoObject',
  'SearchAction',
  'EntryPoint',
  'Service',
  'SoftwareApplication',
  'JobPosting',
  'Recipe',
  'Course',
  'OpeningHoursSpecification',
  'ContactPoint',
  'CollectionPage',
  'SiteNavigationElement',
  'MonetaryAmount',
];
const KNOWN_LOWER = new Map(KNOWN_TYPES.map((t) => [t.toLowerCase(), t]));
const MISSPELLINGS: Record<string, string> = {
  organisation: 'Organization',
  breadcrumb: 'BreadcrumbList',
  breadcrumbs: 'BreadcrumbList',
  breadcrumbslist: 'BreadcrumbList',
  faq: 'FAQPage',
  faqs: 'FAQPage',
  blogpost: 'BlogPosting',
  website: 'WebSite',
  localbusines: 'LocalBusiness',
  postaladdres: 'PostalAddress',
};

const LOCAL_TYPES = [
  'LocalBusiness',
  'Restaurant',
  'Store',
  'Dentist',
  'MedicalClinic',
  'LegalService',
  'Attorney',
  'AutoRepair',
  'HomeAndConstructionBusiness',
  'ProfessionalService',
  'HealthAndBeautyBusiness',
  'FinancialService',
  'RealEstateAgent',
  'LodgingBusiness',
  'Hotel',
  'FoodEstablishment',
  'Plumber',
  'Electrician',
  'Locksmith',
  'AccountingService',
  'Physician',
];
const ARTICLE_TYPES = ['Article', 'BlogPosting', 'NewsArticle', 'TechArticle'];
const DATE_PROPS = [
  'datePublished',
  'dateModified',
  'uploadDate',
  'startDate',
  'endDate',
  'datePosted',
  'validThrough',
  'priceValidUntil',
  'dateCreated',
];
const URL_PROPS = [
  'url',
  'logo',
  'image',
  'thumbnailUrl',
  'contentUrl',
  'embedUrl',
  'item',
  'sameAs',
];

function typed(page: PageData, types: string[]): SchemaNode[] {
  const set = new Set(types);
  return allNodes(page).filter((n) => nodeTypes(n).some((t) => set.has(t)));
}

function missingProps(node: SchemaNode, props: (string | string[])[]): string[] {
  return props
    .filter((p) => (Array.isArray(p) ? !p.some((x) => has(node, x)) : !has(node, p)))
    .map((p) => (Array.isArray(p) ? p.join(' or ') : p));
}

/** Build a property-completeness check for a type. */
function completeness(opts: {
  id: string;
  types: string[];
  label: string;
  required: (string | string[])[];
  recommended?: (string | string[])[];
  why: string;
  fix: string;
  ref: string;
  severity?: 'high' | 'medium' | 'low' | 'info';
  extra?: (n: SchemaNode, page: PageData) => string[];
}) {
  return pageCheck(
    {
      id: opts.id,
      category: 'schema',
      pillar: T,
      title: `${opts.label} markup is missing properties`,
      why: opts.why,
      severity: opts.severity ?? 'medium',
      fixTier: 'guided',
      fix: opts.fix,
      refs: [opts.ref],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const out: Issue[] = [];
      for (const n of typed(page, opts.types)) {
        const req = missingProps(n, opts.required);
        const rec = missingProps(n, opts.recommended ?? []);
        const extra = opts.extra?.(n, page) ?? [];
        if (!req.length && !rec.length && !extra.length) continue;
        const t = nodeTypes(n).join('/');
        out.push({
          checkId: opts.id,
          severity: req.length || extra.length ? undefined : 'low',
          message: [
            req.length ? `${t} missing required ${list(req, 6)}` : '',
            rec.length ? `${req.length ? '; ' : `${t} `}missing recommended ${list(rec, 6)}` : '',
            extra.length ? `${req.length || rec.length ? '; ' : ''}${extra.join('; ')}` : '',
          ].join(''),
          evidence: truncate(JSON.stringify(n), 300),
        });
        if (out.length >= 3) break;
      }
      return out;
    },
  );
}

function ratingProblems(r: unknown): string[] {
  if (!r || typeof r !== 'object') return [];
  const o = r as SchemaNode;
  const v = Number(str(o.ratingValue));
  const best = o.bestRating != null ? Number(str(o.bestRating)) : 5;
  const worst = o.worstRating != null ? Number(str(o.worstRating)) : 1;
  const out: string[] = [];
  if (o.ratingValue != null && Number.isNaN(v))
    out.push(`ratingValue "${str(o.ratingValue)}" is not a number`);
  else if (o.ratingValue != null && (v > best || v < Math.min(worst, 0)))
    out.push(`ratingValue ${v} is outside ${worst}–${best}`);
  return out;
}

/** Start/end property pairs where the end may not come before the start. */
const DATE_PAIRS: [string, string][] = [
  ['startDate', 'endDate'],
  ['validFrom', 'validThrough'],
  ['availabilityStarts', 'availabilityEnds'],
  ['checkinTime', 'checkoutTime'],
  ['departureTime', 'arrivalTime'],
];

function hasJsonLdError(page: PageData): boolean {
  return page.structuredData.some((s) => s.format === 'json-ld' && Boolean(s.error));
}

/**
 * @type values of JSON-LD nodes that use the schema.org vocabulary. Blocks whose @context is
 * another vocabulary are skipped, and so are prefixed (foo:Bar) or full-IRI types from it.
 */
function schemaOrgTypes(page: PageData): string[] {
  const out: string[] = [];
  const walk = (v: unknown, schemaOrg: boolean, depth: number) => {
    if (depth > 12 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, schemaOrg, depth + 1));
    const o = v as SchemaNode;
    let inSchema = schemaOrg;
    const ctx = o['@context'];
    if (ctx !== undefined) {
      const text = JSON.stringify(ctx);
      inSchema = /schema\.org/i.test(text) && !/"@vocab"\s*:\s*"(?![^"]*schema\.org)/i.test(text);
    }
    if (inSchema)
      for (const t of asArray(o['@type']))
        if (typeof t === 'string') {
          const name = t.replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/i, '');
          if (name && !/[:/#]/.test(name)) out.push(name);
        }
    for (const [k, val] of Object.entries(o)) if (k !== '@context') walk(val, inSchema, depth + 1);
  };
  for (const s of page.structuredData)
    if (s.format === 'json-ld' && !s.error) walk(s.raw, false, 0);
  return out;
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** The nearest real type by spelling (edit distance up to 2), if any. */
function closestType(t: string): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const known of SCHEMA_TYPES.keys()) {
    const d = editDistance(t.toLowerCase(), known.toLowerCase(), 2);
    if (d < bestD) {
      best = known;
      bestD = d;
    }
  }
  return best;
}

/** The parent folder of a URL path ("/locations/bath" → "/locations/"). */
function parentFolder(url: string): string | null {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '');
    const i = p.lastIndexOf('/');
    return i > 0 ? p.slice(0, i + 1) : null;
  } catch {
    return null;
  }
}

/** LocalBusiness nodes (any subtype) on a page. */
function localBusinessNodes(page: PageData): SchemaNode[] {
  return allNodes(page).filter((n) => nodeTypes(n).some((t) => isSubtypeOf(t, 'LocalBusiness')));
}

export const checks = [
  // -------------------------------------------------------------------------
  // Syntax and basics
  // -------------------------------------------------------------------------
  pageCheck(
    {
      id: 'schema.invalid-json',
      category: 'schema',
      pillar: T,
      title: 'JSON-LD block cannot be parsed',
      why: 'A syntax error (trailing comma, unescaped quote, HTML inside the script) makes the whole block unreadable, so search and AI engines ignore all of it.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Fix the JSON syntax. Validate with the Schema Markup Validator or Google’s Rich Results Test.',
      refs: ['https://validator.schema.org/', 'https://search.google.com/test/rich-results'],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = page.structuredData.filter((s) => s.format === 'json-ld' && s.error);
      return bad.length
        ? {
            checkId: 'schema.invalid-json',
            message: `${plural(bad.length, 'JSON-LD block')} with a syntax error`,
            evidence: truncate(bad[0].error, 200),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'schema.missing-context',
      category: 'schema',
      pillar: T,
      title: 'JSON-LD without a schema.org @context',
      why: 'Without "@context": "https://schema.org", the types and properties have no defined meaning and parsers may skip the block.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add "@context": "https://schema.org" at the top level of each JSON-LD block.',
      refs: [REF.structuredData],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = page.structuredData.filter((s) => {
        if (s.format !== 'json-ld' || s.error) return false;
        const roots = asArray<SchemaNode>(s.raw);
        return roots.some(
          (r) =>
            r && typeof r === 'object' && !/schema\.org/i.test(JSON.stringify(r['@context'] ?? '')),
        );
      });
      return bad.length
        ? {
            checkId: 'schema.missing-context',
            message: `${plural(bad.length, 'JSON-LD block')} without a schema.org @context`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'schema.missing-type',
      category: 'schema',
      pillar: T,
      title: 'JSON-LD block without @type',
      why: 'A node without @type does not say what it describes, so it cannot be used for rich results or entity understanding.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add the correct @type (for example Organization, Article, Product) to the node.',
      refs: [REF.structuredData],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = page.structuredData.filter(
        (s) => s.format === 'json-ld' && !s.error && s.types.length === 0,
      );
      return bad.length
        ? {
            checkId: 'schema.missing-type',
            message: `${plural(bad.length, 'JSON-LD block')} without any @type`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'schema.type-misspelled',
      category: 'schema',
      pillar: T,
      title: 'Schema type misspelled or wrong case',
      why: 'schema.org types are case-sensitive and use American spelling. "Organisation" or "localbusiness" are not recognised, so the markup does nothing.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Use the exact type name from schema.org, for example "Organization", "LocalBusiness", "BreadcrumbList".',
      refs: ['https://schema.org/docs/full.html'],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = new Map<string, string>();
      for (const n of allNodes(page))
        for (const t of nodeTypes(n)) {
          const low = t.toLowerCase();
          const known = KNOWN_LOWER.get(low);
          if (known && known !== t) bad.set(t, known);
          else if (!known && MISSPELLINGS[low]) bad.set(t, MISSPELLINGS[low]);
        }
      return bad.size
        ? {
            checkId: 'schema.type-misspelled',
            message: list([...bad].map(([a, b]) => `"${a}" should be "${b}"`)),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'schema.type-unknown',
      category: 'schema',
      pillar: T,
      title: 'Schema type that does not exist',
      why: 'An @type that is not in the schema.org vocabulary is not understood by Google, Bing or AI engines, so the node and everything in it is ignored. Invented types such as "OnlineShop" or "Agency" are a common cause.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Use an existing schema.org type (search https://schema.org/docs/full.html), choosing the most specific one that fits, for example "Dentist" or "Store". Use additionalType for a more precise external category.',
      refs: ['https://schema.org/docs/full.html', 'https://validator.schema.org/'],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = new Map<string, string | null>();
      for (const t of schemaOrgTypes(page)) {
        if (isSchemaType(t) || bad.has(t)) continue;
        const low = t.toLowerCase();
        // Case and spelling slips are reported by schema.type-misspelled.
        if (KNOWN_LOWER.has(low) || MISSPELLINGS[low]) continue;
        bad.set(t, closestType(t));
      }
      if (!bad.size) return null;
      return {
        checkId: 'schema.type-unknown',
        message: `${plural(bad.size, 'type')} not in the schema.org vocabulary: ${list([...bad.keys()].map((t) => `"${t}"`))}`,
        evidence: list(
          [...bad].map(([t, near]) => (near ? `"${t}" (did you mean "${near}"?)` : `"${t}"`)),
        ),
        data: { types: [...bad.keys()] },
      };
    },
  ),
  pageCheck(
    {
      id: 'schema.date-order',
      category: 'schema',
      pillar: T,
      title: 'Structured data ends before it starts',
      why: 'An endDate earlier than the startDate (or a validThrough before validFrom) is impossible. Google drops such events and offers, and assistants can give people the wrong times.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Correct the dates so the end is at or after the start, with the same time zone on both, and make them match the times shown on the page.',
      refs: [SD('event'), 'https://schema.org/endDate'],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad: string[] = [];
      for (const n of allNodes(page))
        for (const [a, b] of DATE_PAIRS) {
          const start = str(n[a]);
          const end = str(n[b]);
          if (!start || !end || !ISO_DATE.test(start) || !ISO_DATE.test(end)) continue;
          const s = Date.parse(start);
          const e = Date.parse(end);
          // Date-only end values mean "that day": compare by day so 2026-05-01 / 2026-05-01T18:00 pass.
          const dateOnly = !/T|\d \d/.test(end) || !/T|\d \d/.test(start);
          const late = dateOnly ? start.slice(0, 10) > end.slice(0, 10) : s > e;
          if (Number.isFinite(s) && Number.isFinite(e) && late)
            bad.push(`${nodeTypes(n).join('/') || 'node'}: ${b} ${end} is before ${a} ${start}`);
        }
      return bad.length
        ? {
            checkId: 'schema.date-order',
            message: `${plural(bad.length, 'node')} with an end before its start`,
            evidence: list(bad, 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'schema.date-format',
      category: 'schema',
      pillar: T,
      title: 'Dates not in ISO 8601 format',
      why: 'Dates like "12/03/2024" are ambiguous and are rejected for rich results. ISO 8601 (2024-03-12T09:00:00+00:00) is required.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Output dates in ISO 8601, ideally with time and timezone offset.',
      refs: [SD('article#structured-data-type-definitions')],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad: string[] = [];
      for (const n of allNodes(page))
        for (const p of DATE_PROPS) {
          const v = str(n[p]);
          if (v && !ISO_DATE.test(v)) bad.push(`${p}: "${v}"`);
        }
      return bad.length
        ? {
            checkId: 'schema.date-format',
            message: `${plural(bad.length, 'date')} not in ISO 8601`,
            evidence: list(bad, 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'schema.relative-urls',
      category: 'schema',
      pillar: T,
      title: 'Relative URLs in structured data',
      why: 'Structured data is often read out of context. Relative paths for url, image or logo may be resolved wrongly or dropped.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use absolute https:// URLs for url, image, logo, sameAs and item properties.',
      refs: [REF.structuredData],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad: string[] = [];
      for (const n of allNodes(page))
        for (const p of URL_PROPS)
          for (const v of asArray(n[p]))
            if (
              typeof v === 'string' &&
              v.trim() &&
              !/^(https?:)?\/\//i.test(v.trim()) &&
              !/^data:/.test(v)
            )
              bad.push(`${p}: ${v}`);
      return bad.length
        ? {
            checkId: 'schema.relative-urls',
            message: `${plural(bad.length, 'URL')} in structured data not absolute`,
            evidence: list(bad, 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'schema.empty-values',
      category: 'schema',
      pillar: T,
      title: 'Empty values in structured data',
      why: 'Empty strings for name, description or image usually come from a template field left blank. They are invalid and can block rich results.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Fill the fields or omit them from the markup when there is no value.',
      tags: ['structured-data'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad: string[] = [];
      for (const n of allNodes(page))
        for (const [k, v] of Object.entries(n))
          if (
            !k.startsWith('@') &&
            ((typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0))
          )
            bad.push(`${nodeTypes(n)[0]}.${k}`);
      return bad.length
        ? {
            checkId: 'schema.empty-values',
            message: `${plural(bad.length, 'empty property', 'empty properties')}`,
            evidence: list([...new Set(bad)], 6),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'schema.conflicting-ids',
      category: 'schema',
      pillar: T,
      title: 'Same @id used for different things',
      why: '@id joins nodes into one entity. Reusing an @id for nodes with different types merges unrelated things in the knowledge graph parsers build.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Give each distinct entity its own @id (for example https://example.com/#organization, …/#website).',
      refs: ['https://json-ld.org/spec/latest/json-ld/#node-identifiers'],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const g = groupBy(
        allNodes(page).filter((n) => typeof n['@id'] === 'string' && nodeTypes(n).length),
        (n) => n['@id'] as string,
      );
      const bad = [...g].filter(
        ([, ns]) => new Set(ns.map((n) => nodeTypes(n).sort().join('/'))).size > 1,
      );
      return bad.length
        ? {
            checkId: 'schema.conflicting-ids',
            message: `${plural(bad.length, '@id')} used for different types`,
            evidence: list(
              bad.map(([id, ns]) => `${id} (${[...new Set(ns.flatMap(nodeTypes))].join(', ')})`),
              3,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'schema.sameas-invalid',
      category: 'schema',
      pillar: T,
      title: 'sameAs values are not profile URLs',
      why: 'sameAs links your entity to its profiles (LinkedIn, Wikipedia, Wikidata, Crunchbase). Values that are not URLs, or point back at your own site, add nothing.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'List full URLs of official profiles on other sites in sameAs.',
      refs: ['https://schema.org/sameAs'],
      tags: ['structured-data', 'entity'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const host = new URL(page.url).hostname.replace(/^www\./, '');
      const bad: string[] = [];
      for (const n of allNodes(page))
        for (const v of asArray(n.sameAs)) {
          if (typeof v !== 'string' || !/^https?:\/\/[^/]+\.[^/]+/i.test(v)) bad.push(String(v));
          else if (new URL(v).hostname.replace(/^www\./, '') === host) bad.push(v);
        }
      return bad.length
        ? {
            checkId: 'schema.sameas-invalid',
            message: `${plural(bad.length, 'sameAs value')} not pointing to another site`,
            evidence: list(bad, 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'schema.microdata-only',
      category: 'schema',
      pillar: T,
      title: 'Structured data only in Microdata or RDFa',
      why: 'Google supports Microdata, but JSON-LD is its recommended format and is far easier to keep correct. Many AI tools only read JSON-LD.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Move the markup to a JSON-LD script in <head> and remove the inline attributes once it is validated.',
      refs: [
        'https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data#supported-formats',
      ],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isIndexable(page) || !page.structuredData.length) return null;
      if (page.structuredData.some((s) => s.format === 'json-ld')) return null;
      return {
        checkId: 'schema.microdata-only',
        message: `Markup found only as ${[...new Set(page.structuredData.map((s) => s.format))].join(' and ')}`,
      };
    },
  ),

  // -------------------------------------------------------------------------
  // Per-type completeness
  // -------------------------------------------------------------------------
  completeness({
    id: 'schema.organization-incomplete',
    types: ['Organization', 'Corporation', 'NGO', 'EducationalOrganization', 'OnlineStore'],
    label: 'Organization',
    required: ['name'],
    recommended: ['url', 'logo', 'sameAs'],
    why: 'Organization markup with name, url, logo and sameAs helps Google and AI engines recognise your brand as one entity and show the right logo.',
    fix: 'Include name, url, logo (absolute image URL, at least 112×112) and sameAs links to official profiles.',
    ref: SD('organization'),
    extra: (n) => {
      const logo = str(n.logo);
      return logo &&
        /^https?:/.test(logo) &&
        !/\.(png|jpe?g|gif|svg|webp|avif)(\?|$)/i.test(logo) &&
        typeof n.logo === 'string'
        ? [`logo "${truncate(logo, 60)}" does not look like an image URL`]
        : [];
    },
  }),
  completeness({
    id: 'schema.localbusiness-incomplete',
    types: LOCAL_TYPES,
    label: 'LocalBusiness',
    required: ['name', 'address'],
    recommended: [
      'telephone',
      'url',
      ['openingHoursSpecification', 'openingHours'],
      'geo',
      'image',
    ],
    why: 'Local business markup with a full address, phone and opening hours supports local results and lets AI assistants answer "is it open" and "where is it" correctly.',
    fix: 'Add name, a PostalAddress (streetAddress, addressLocality, postalCode, addressCountry), telephone, openingHoursSpecification, geo and image.',
    ref: SD('local-business'),
    severity: 'high',
    extra: (n) => {
      const a = n.address;
      if (!a || typeof a !== 'object' || Array.isArray(a)) return [];
      const miss = missingProps(a as SchemaNode, [
        'streetAddress',
        'addressLocality',
        'addressCountry',
      ]);
      return miss.length ? [`address missing ${list(miss)}`] : [];
    },
  }),
  completeness({
    id: 'schema.article-incomplete',
    types: ARTICLE_TYPES,
    label: 'Article',
    required: ['headline'],
    recommended: ['image', 'datePublished', 'dateModified', 'author'],
    why: 'Article markup with headline, image, dates and author makes the piece eligible for article features and gives AI engines clear authorship and freshness signals.',
    fix: 'Include headline, image, datePublished, dateModified and author (a Person or Organization with name and url).',
    ref: SD('article'),
    extra: (n) => {
      const out: string[] = [];
      for (const a of asArray(n.author)) {
        if (typeof a === 'string')
          out.push('author should be a Person or Organization object, not a plain string');
        else if (a && typeof a === 'object' && !has(a as SchemaNode, 'name'))
          out.push('author has no name');
      }
      return out.slice(0, 1);
    },
  }),
  pageCheck(
    {
      id: 'schema.headline-too-long',
      category: 'schema',
      pillar: T,
      title: 'Article headline is very long',
      why: `Very long headlines are truncated in article features; Google historically limited headline to ${HEADLINE_MAX} characters.`,
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use the page’s concise title as the headline.',
      refs: [SD('article')],
      tags: ['structured-data'],
    },
    (page) => {
      const n = typed(page, ARTICLE_TYPES).find(
        (x) => (str(x.headline) || '').length > HEADLINE_MAX,
      );
      return isHtml200(page) && n
        ? {
            checkId: 'schema.headline-too-long',
            message: `headline is ${str(n.headline)!.length} characters`,
            evidence: truncate(str(n.headline), 150),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'schema.headline-mismatch',
      category: 'schema',
      pillar: C,
      title: 'Article headline does not match the page',
      why: 'Structured data must describe the visible page. A headline that matches neither the title nor the H1 suggests copied or stale markup.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Generate the headline from the same field as the page title or H1.',
      refs: [REF.structuredData],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const n = typed(page, ARTICLE_TYPES)[0];
      const hl = normText(str(n?.headline));
      if (!hl) return null;
      const h1 = normText(page.headings.find((h) => h.level === 1)?.text);
      const title = normText(page.title);
      const sig = (s: string) => new Set(words(s).filter((w) => w.length > 3));
      const overlap = (a: string, b: string) => {
        const A = sig(a);
        const B = sig(b);
        let k = 0;
        for (const w of A) if (B.has(w)) k++;
        return A.size ? k / A.size : 1;
      };
      if (
        title.includes(hl) ||
        h1.includes(hl) ||
        hl.includes(h1 || '\u0000') ||
        overlap(hl, `${title} ${h1}`) >= 0.5
      )
        return null;
      return {
        checkId: 'schema.headline-mismatch',
        message: 'Article headline shares little with the title and H1',
        evidence: `headline: ${truncate(hl, 80)} | h1: ${truncate(h1, 80)}`,
      };
    },
  ),
  completeness({
    id: 'schema.product-incomplete',
    types: ['Product', 'ProductGroup'],
    label: 'Product',
    required: ['name', ['offers', 'review', 'aggregateRating']],
    recommended: [
      'image',
      'description',
      ['sku', 'gtin', 'gtin13', 'gtin12', 'gtin8', 'mpn'],
      'brand',
    ],
    why: 'Product markup needs a name and at least one of offers, review or aggregateRating to be eligible for product results. Identifiers and brand help shopping surfaces and AI shopping agents match the product.',
    fix: 'Add name, image, description, brand, an identifier (sku or gtin) and an Offer with price, priceCurrency and availability.',
    ref: SD('product-snippet'),
    severity: 'high',
  }),
  completeness({
    id: 'schema.offer-incomplete',
    types: ['Offer', 'AggregateOffer'],
    label: 'Offer',
    required: [['price', 'lowPrice', 'priceSpecification']],
    recommended: ['priceCurrency', 'availability', 'url'],
    why: 'Offers without price, currency and availability cannot show price in results and give shopping agents nothing reliable to act on.',
    fix: 'Add price (a plain number such as 1299.00), priceCurrency (ISO code such as GBP) and availability (https://schema.org/InStock).',
    ref: SD('merchant-listing'),
    extra: (n) => {
      const p = n.price;
      if (p == null) return [];
      const s = String(str(p));
      return /[^\d.]/.test(s)
        ? [`price "${s}" should be a plain number without symbols or commas`]
        : [];
    },
  }),
  completeness({
    id: 'schema.faq-incomplete',
    types: ['FAQPage'],
    label: 'FAQPage',
    required: ['mainEntity'],
    why: 'FAQ markup needs Question items with an acceptedAnswer. Incomplete markup is ignored, and AI engines lose a clean question-and-answer source.',
    fix: 'Give mainEntity a list of Question nodes, each with name and acceptedAnswer.text.',
    ref: SD('faqpage'),
    extra: (n) => {
      const qs = asArray<SchemaNode>(n.mainEntity);
      const bad = qs.filter(
        (q) =>
          !q ||
          typeof q !== 'object' ||
          !has(q, 'name') ||
          !str((q.acceptedAnswer as SchemaNode)?.text ?? null),
      );
      return bad.length
        ? [`${plural(bad.length, 'question')} without a name or acceptedAnswer.text`]
        : [];
    },
  }),
  pageCheck(
    {
      id: 'schema.faq-not-visible',
      category: 'schema',
      pillar: C,
      title: 'FAQ markup questions are not on the page',
      why: 'Google requires FAQ content to be visible to users. Questions that appear only in markup break the guidelines and can be treated as spammy structured data.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Show every marked-up question and answer on the page, or remove the ones that are not shown.',
      refs: [SD('faqpage#guidelines'), REF.structuredData],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const body = normText(page.text);
      const qs = typed(page, ['Question'])
        .map((q) => str(q.name))
        .filter((q): q is string => !!q);
      const missing = qs.filter((q) => !body.includes(normText(q).slice(0, 60)));
      return missing.length
        ? {
            checkId: 'schema.faq-not-visible',
            message: `${plural(missing.length, 'marked-up question')} not found in the page text`,
            evidence: list(
              missing.map((q) => `"${truncate(q, 60)}"`),
              3,
            ),
          }
        : null;
    },
  ),
  completeness({
    id: 'schema.howto-incomplete',
    types: ['HowTo'],
    label: 'HowTo',
    required: ['name', 'step'],
    recommended: ['totalTime', 'image'],
    why: 'Google no longer shows HowTo rich results, but complete step markup still gives AI engines an unambiguous sequence to quote.',
    fix: 'Give the HowTo a name and a list of HowToStep items, each with text (and name or url where useful).',
    ref: 'https://schema.org/HowTo',
    severity: 'low',
  }),
  completeness({
    id: 'schema.breadcrumb-incomplete',
    types: ['BreadcrumbList'],
    label: 'BreadcrumbList',
    required: ['itemListElement'],
    why: 'Breadcrumb markup replaces the URL in results with a readable path. Items without position, name or item are ignored.',
    fix: 'Each ListItem needs position (1, 2, 3…), name and item (the URL; optional for the last item).',
    ref: SD('breadcrumb'),
    extra: (n) => {
      const items = asArray<SchemaNode>(n.itemListElement);
      const out: string[] = [];
      items.forEach((it, i) => {
        if (!it || typeof it !== 'object') return;
        const miss = missingProps(
          it,
          i === items.length - 1 ? ['position', 'name'] : ['position', 'name', 'item'],
        );
        if (
          miss.length &&
          !(
            miss.includes('name') &&
            has(it, 'item') &&
            typeof it.item === 'object' &&
            has(it.item as SchemaNode, 'name')
          )
        )
          out.push(`item ${i + 1} missing ${list(miss)}`);
      });
      const pos = items.map((it) => Number(str(it?.position))).filter((x) => !Number.isNaN(x));
      if (pos.length > 1 && pos.some((p, i) => i > 0 && p <= pos[i - 1]))
        out.push('positions are not in increasing order');
      return out.slice(0, 3);
    },
  }),
  completeness({
    id: 'schema.website-incomplete',
    types: ['WebSite'],
    label: 'WebSite',
    required: ['name', 'url'],
    recommended: ['alternateName'],
    why: 'WebSite markup with name and url is how Google picks the site name shown in results. alternateName covers acronyms or shorter names.',
    fix: 'Add WebSite markup on the home page with name, url and optionally alternateName.',
    ref: SD('site-names'),
    severity: 'low',
    extra: (n) => {
      const out: string[] = [];
      for (const a of asArray<SchemaNode>(n.potentialAction)) {
        if (!a || !nodeTypes(a).includes('SearchAction')) continue;
        const target = JSON.stringify(a.target ?? '');
        if (!/\{[^}]+\}/.test(target))
          out.push('SearchAction target has no {search_term_string} placeholder');
        const qi = str(a['query-input']) || '';
        const placeholder = /\{([^}]+)\}/.exec(target)?.[1];
        if (placeholder && qi && !qi.includes(placeholder))
          out.push(`query-input does not name "${placeholder}"`);
      }
      return out;
    },
  }),
  completeness({
    id: 'schema.event-incomplete',
    types: [
      'Event',
      'MusicEvent',
      'BusinessEvent',
      'EducationEvent',
      'SocialEvent',
      'SportsEvent',
      'Festival',
      'TheaterEvent',
      'ExhibitionEvent',
    ],
    label: 'Event',
    required: ['name', 'startDate', 'location'],
    recommended: [
      'endDate',
      'eventStatus',
      'eventAttendanceMode',
      'image',
      'description',
      'offers',
      'organizer',
    ],
    why: 'Events need a name, start date and location to appear in event results and to be answered correctly by assistants.',
    fix: 'Add name, startDate (ISO 8601 with timezone), location (Place with address, or VirtualLocation), and recommended endDate, eventStatus, image and offers.',
    ref: SD('event'),
  }),
  completeness({
    id: 'schema.review-incomplete',
    types: ['Review'],
    label: 'Review',
    required: ['author', 'reviewRating'],
    recommended: ['itemReviewed', 'datePublished'],
    why: 'Reviews need an author and a rating to be valid. Incomplete reviews are ignored for review snippets.',
    fix: 'Add author (Person or Organization with name), reviewRating with ratingValue, and itemReviewed when the review stands alone.',
    ref: SD('review-snippet'),
    extra: (n) => ratingProblems(n.reviewRating),
  }),
  completeness({
    id: 'schema.rating-invalid',
    types: ['AggregateRating'],
    label: 'AggregateRating',
    required: ['ratingValue', ['ratingCount', 'reviewCount']],
    why: 'An aggregate rating needs a value and a count, and the value must sit inside the rating scale. Invalid ratings are dropped and can look manipulated.',
    fix: 'Provide ratingValue within bestRating/worstRating (default 1–5) and a ratingCount or reviewCount above zero, taken from real reviews.',
    ref: SD('review-snippet'),
    extra: (n) => {
      const out = ratingProblems(n);
      const count = Number(str(n.ratingCount ?? n.reviewCount));
      if (!Number.isNaN(count) && (n.ratingCount != null || n.reviewCount != null) && count <= 0)
        out.push('rating count is zero');
      return out;
    },
  }),
  completeness({
    id: 'schema.video-incomplete',
    types: ['VideoObject'],
    label: 'VideoObject',
    required: ['name', 'thumbnailUrl', 'uploadDate'],
    recommended: ['description', ['contentUrl', 'embedUrl'], 'duration'],
    why: 'Videos need name, thumbnail and upload date to appear in video results. contentUrl or embedUrl lets Google fetch the file for key moments.',
    fix: 'Add name, thumbnailUrl, uploadDate (ISO 8601), description, duration (ISO 8601, e.g. PT2M30S) and contentUrl or embedUrl.',
    ref: SD('video'),
  }),
  completeness({
    id: 'schema.person-incomplete',
    types: ['Person'],
    label: 'Person',
    required: ['name'],
    recommended: [['url', 'sameAs'], 'jobTitle'],
    why: 'A Person with a name, profile URL and role lets search and AI engines connect authors and team members to their wider reputation.',
    fix: 'Give each Person a name, url (their author or team page), sameAs (LinkedIn and other profiles) and jobTitle.',
    ref: 'https://schema.org/Person',
    severity: 'low',
  }),
  completeness({
    id: 'schema.jobposting-incomplete',
    types: ['JobPosting'],
    label: 'JobPosting',
    required: [
      'title',
      'description',
      'datePosted',
      'hiringOrganization',
      ['jobLocation', 'applicantLocationRequirements'],
    ],
    recommended: ['validThrough', 'employmentType', 'baseSalary'],
    why: 'Job postings missing required fields are not shown in Google’s job experience.',
    fix: 'Add title, description, datePosted, hiringOrganization and jobLocation (or applicantLocationRequirements with jobLocationType TELECOMMUTE for remote roles).',
    ref: SD('job-posting'),
  }),
  pageCheck(
    {
      id: 'schema.self-serving-reviews',
      category: 'schema',
      pillar: T,
      title: 'Business rates itself in its own markup',
      why: 'Google ignores review stars that an Organization or LocalBusiness adds about itself on its own site, and repeated misuse can lead to a manual action.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Remove aggregateRating and review from Organization/LocalBusiness markup. Keep ratings on Product or Service pages where they reflect real third-party reviews.',
      refs: [
        'https://developers.google.com/search/blog/2019/09/making-review-rich-results-more-helpful',
      ],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const n = typed(page, ['Organization', 'Corporation', ...LOCAL_TYPES]).find(
        (x) => has(x, 'aggregateRating') || has(x, 'review'),
      );
      return n
        ? {
            checkId: 'schema.self-serving-reviews',
            message: `${nodeTypes(n)[0]} markup includes ${has(n, 'aggregateRating') ? 'aggregateRating' : 'review'}`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'schema.price-not-visible',
      category: 'schema',
      pillar: C,
      title: 'Marked-up price not shown on the page',
      why: 'Prices in markup must match what shoppers see. A mismatch can remove the product from rich results and misleads shopping agents.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Make sure the Offer price in the markup is the price shown on the page.',
      refs: [SD('merchant-listing'), REF.structuredData],
      tags: ['structured-data'],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const prices = typed(page, ['Offer'])
        .map((o) => str(o.price))
        .filter((p): p is string => !!p && /^\d+(\.\d+)?$/.test(p) && Number(p) > 0);
      if (!prices.length) return null;
      const text = page.text.replace(/[,\s ]/g, '');
      const missing = prices.filter((p) => {
        const n = Number(p);
        const forms = [p, n.toFixed(2), String(n), n.toFixed(0)];
        return !forms.some((f) => text.includes(f));
      });
      return missing.length === prices.length
        ? {
            checkId: 'schema.price-not-visible',
            message: `Price ${list(missing, 3)} from markup not found in the page text`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'schema.article-missing',
      category: 'schema',
      pillar: T,
      title: 'Article page without Article markup',
      why: 'Article markup states the headline, author and dates explicitly, which helps Google’s article features and gives AI engines reliable authorship and freshness.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add Article or BlogPosting JSON-LD with headline, image, datePublished, dateModified and author.',
      refs: [SD('article')],
      tags: ['structured-data', 'geo'],
    },
    (page) => {
      if (!isIndexable(page) || !isArticleLike(page)) return null;
      if (typed(page, ARTICLE_TYPES).length) return null;
      // A block that failed to parse may hold the Article: schema.invalid-json reports that.
      if (hasJsonLdError(page)) return null;
      return {
        checkId: 'schema.article-missing',
        message: 'Looks like an article but has no Article/BlogPosting markup',
      };
    },
  ),

  // -------------------------------------------------------------------------
  // Site level
  // -------------------------------------------------------------------------
  siteCheck(
    {
      id: 'schema.localbusiness-missing',
      category: 'schema',
      pillar: T,
      title: 'Location page without LocalBusiness markup that its sibling pages have',
      why: 'When most pages in a folder (for example one page per branch or clinic) carry LocalBusiness markup and one does not, that location loses its address, opening hours and phone in local results and AI answers. It is almost always a template or CMS field left empty.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add the same LocalBusiness (or subtype) JSON-LD the sibling pages use, with this location’s own name, address, telephone, opening hours and url.',
      refs: [SD('local-business')],
      tags: ['structured-data', 'local'],
    },
    (site: SiteContext) => {
      const byFolder = groupBy(
        indexablePages(site).filter((p) => !isHomepage(p, site)),
        (p) => parentFolder(p.url),
      );
      const out: Issue[] = [];
      for (const pages of byFolder.values()) {
        if (pages.length < LOCAL_SIBLINGS_MIN) continue;
        const withLb = pages.filter((p) => localBusinessNodes(p).length > 0);
        // At least two siblings and two thirds of the other pages must carry it, so the folder
        // is clearly one page per location.
        if (withLb.length < 2 || withLb.length / (pages.length - 1) < LOCAL_SIBLINGS_SHARE)
          continue;
        const types = [...new Set(withLb.flatMap((p) => localBusinessNodes(p).flatMap(nodeTypes)))];
        for (const p of pages) {
          if (withLb.includes(p)) continue;
          out.push({
            checkId: 'schema.localbusiness-missing',
            url: p.url,
            message: `No LocalBusiness markup, unlike ${withLb.length} of ${pages.length - 1} sibling pages (${list(types, 3)})`,
            evidence: list(
              withLb.map((x) => x.url),
              3,
            ),
          });
        }
      }
      return out;
    },
  ),
  siteCheck(
    {
      id: 'schema.organization-missing',
      category: 'schema',
      pillar: T,
      title: 'No Organization or LocalBusiness markup',
      why: 'Organization markup on the home page is the clearest statement of who runs the site: name, logo, contact details and official profiles. Search and AI engines use it to build an entity for your brand.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add Organization (or the most specific LocalBusiness type) JSON-LD to the home page with name, url, logo, contactPoint and sameAs.',
      refs: [SD('organization')],
      tags: ['structured-data', 'entity'],
    },
    (site) => {
      const pages = htmlPages(site);
      if (!pages.length) return null;
      const any = pages.some(
        (p) =>
          typed(p, [
            'Organization',
            'Corporation',
            'NGO',
            'EducationalOrganization',
            'OnlineStore',
            ...LOCAL_TYPES,
          ]).length,
      );
      if (any) return null;
      const home = homePage(site);
      return {
        checkId: 'schema.organization-missing',
        url: home?.url,
        message: 'No crawled page declares Organization or LocalBusiness markup',
      };
    },
  ),
  siteCheck(
    {
      id: 'schema.website-missing',
      category: 'schema',
      pillar: T,
      title: 'No WebSite markup on the home page',
      why: 'WebSite markup is how Google chooses the site name shown above your results.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add WebSite JSON-LD to the home page with name and url.',
      refs: [SD('site-names')],
      tags: ['structured-data'],
    },
    (site) => {
      const home = homePage(site);
      if (!home || !isHtml200(home) || typed(home, ['WebSite']).length) return null;
      return {
        checkId: 'schema.website-missing',
        url: home.url,
        message: 'Home page has no WebSite markup',
      };
    },
  ),
  siteCheck(
    {
      id: 'schema.breadcrumbs-missing',
      category: 'schema',
      pillar: T,
      title: 'Deeper pages without breadcrumb markup',
      why: 'Breadcrumb markup shows the site hierarchy in results and helps engines understand where a page sits.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add BreadcrumbList JSON-LD (and a visible breadcrumb trail) to pages below the top level.',
      refs: [SD('breadcrumb')],
      tags: ['structured-data'],
    },
    (site) => {
      const deep = indexablePages(site).filter(
        (p) =>
          !isHomepage(p, site) &&
          new URL(p.url).pathname.split('/').filter(Boolean).length >= BREADCRUMB_MIN_DEPTH,
      );
      if (deep.length < 5) return null;
      const without = deep.filter((p) => !typed(p, ['BreadcrumbList']).length);
      if (without.length < deep.length * 0.5) return null;
      return {
        checkId: 'schema.breadcrumbs-missing',
        message: `${without.length} of ${deep.length} deeper pages have no BreadcrumbList markup`,
        evidence: list(
          without.map((p) => new URL(p.url).pathname),
          4,
        ),
      };
    },
  ),
  siteCheck(
    {
      id: 'schema.organization-inconsistent',
      category: 'schema',
      pillar: T,
      title: 'Organization details differ between pages',
      why: 'If pages describe the organisation with different names, logos or phone numbers, search and AI engines cannot tell which is right and may merge or split the entity.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Output the Organization markup from one shared source so every page carries identical name, logo and contact details.',
      tags: ['structured-data', 'entity'],
    },
    (site) => {
      const names = new Map<string, string[]>();
      const phones = new Map<string, string[]>();
      for (const p of htmlPages(site))
        for (const n of topNodes(p).filter((x) =>
          nodeTypes(x).some((t) => t === 'Organization' || LOCAL_TYPES.includes(t)),
        )) {
          const nm = str(n.name);
          if (nm)
            (names.get(normText(nm)) ?? names.set(normText(nm), []).get(normText(nm))!).push(p.url);
          const tel = str(n.telephone)?.replace(/[^\d+]/g, '');
          if (tel) (phones.get(tel) ?? phones.set(tel, []).get(tel)!).push(p.url);
        }
      const out: Issue[] = [];
      if (names.size > 1)
        out.push({
          checkId: 'schema.organization-inconsistent',
          message: `${names.size} different organisation names in markup`,
          evidence: list(
            [...names.keys()].map((k) => `"${k}"`),
            4,
          ),
        });
      if (phones.size > 1)
        out.push({
          checkId: 'schema.organization-inconsistent',
          message: `${phones.size} different telephone numbers in organisation markup`,
          evidence: list([...phones.keys()], 4),
        });
      return out;
    },
  ),
];

export type { PageData };
