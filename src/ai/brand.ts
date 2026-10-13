import { z } from 'zod';

import type { AvcConfig, SiteConfig } from '../core/config.js';
import type { BrandProfile, PageData, SiteContext } from '../core/types.js';
import { helperModel, structured } from './engines.js';
import { BRAND_SYSTEM } from './prompts.js';
import { hostOf, normBrand, sameBrand, truncate, uniq } from './util.js';

/**
 * Who the site belongs to, read from the crawl: Organization schema,
 * og:site_name, the title, the about and contact pages, and the services in
 * the navigation and headings. No model call is needed; `refineBrand` can
 * tidy the result with one when keys exist.
 */

type Node = Record<string, unknown>;

const ORG_TYPES =
  /^(Organization|Corporation|LocalBusiness|ProfessionalService|OnlineStore|OnlineBusiness|NGO|EducationalOrganization|MedicalOrganization|SportsOrganization|Store|Restaurant|LegalService|FinancialService|HomeAndConstructionBusiness|HealthAndBeautyBusiness|AutomotiveBusiness|Dentist|Physician|RealEstateAgent|TravelAgency|AccountingService|Attorney|EmploymentAgency|InsuranceAgency|MedicalClinic|Hotel|LodgingBusiness|FoodEstablishment|SoftwareCompany|Brand)$/;

const GENERIC_TYPES = new Set([
  'Organization',
  'Corporation',
  'LocalBusiness',
  'ProfessionalService',
  'OnlineBusiness',
  'OnlineStore',
  'Brand',
]);

function typesOf(n: Node): string[] {
  const t = n['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
}

/** Flattens JSON-LD (arrays, @graph, nested objects) into nodes with a @type. */
export function schemaNodes(pages: PageData[]): Node[] {
  const out: Node[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const n = v as Node;
    if (n['@type']) out.push(n);
    for (const [k, x] of Object.entries(n)) if (k !== '@context') walk(x, depth + 1);
  };
  for (const p of pages)
    for (const sd of p.structuredData ?? [])
      if (sd.format === 'json-ld' && !sd.error) walk(sd.raw, 0);
  return out;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : undefined;

const strs = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v])
    .map((x) => (typeof x === 'string' ? x : str((x as Node | null)?.name)))
    .filter((x): x is string => Boolean(x && x.trim()))
    .map((x) => x.trim());

export function htmlPages(site: SiteContext): PageData[] {
  return [...site.pages.values()].filter((p) => p.isHtml && p.status >= 200 && p.status < 300);
}

export function homePage(site: SiteContext): PageData | undefined {
  const pages = htmlPages(site);
  const start = site.pages.get(site.startUrl);
  if (start?.isHtml) return start;
  return (
    pages.find((p) => {
      try {
        return new URL(p.finalUrl || p.url).pathname.replace(/\/+$/, '') === '';
      } catch {
        return false;
      }
    }) ?? [...pages].sort((a, b) => a.depth - b.depth)[0]
  );
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

export function findPages(site: SiteContext, re: RegExp, limit = 3): PageData[] {
  return htmlPages(site)
    .filter((p) => re.test(pathOf(p.finalUrl || p.url)))
    .sort((a, b) => a.depth - b.depth || a.url.length - b.url.length)
    .slice(0, limit);
}

const ABOUT_RE = /\/(about|about-us|company|who-we-are|our-story|team)(\/|$)/;
const CONTACT_RE = /\/(contact|contact-us|locations?|find-us|visit)(\/|$)/;
const SERVICE_RE = /\/(services?|solutions?|what-we-do|products?|capabilities|offerings?)(\/|$)/;

const GENERIC_LINKS =
  /^(services?|solutions?|products?|all services|view all|see all|learn more|read more|more|home|about|contact|blog|pricing|faq|menu|overview|what we do)$/i;

function titleName(title: string | null, domainLabel: string): string | undefined {
  if (!title) return undefined;
  const parts = title
    .split(/\s+[|\-–—:·•]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const hit = parts.find(
    (p) => sameBrand(p, domainLabel) || normBrand(p).includes(normBrand(domainLabel)),
  );
  if (hit && hit.split(/\s+/).length <= 5) return hit;
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return last && last.split(/\s+/).length <= 4 ? last : undefined;
}

function capitalise(label: string): string {
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function addressText(addr: unknown): string | undefined {
  if (!addr) return undefined;
  if (typeof addr === 'string') return str(addr);
  const list = Array.isArray(addr) ? addr : [addr];
  for (const a of list) {
    const n = a as Node;
    const locality = str(n.addressLocality);
    const country = str(n.addressCountry) ?? str((n.addressCountry as Node | undefined)?.name);
    const region = str(n.addressRegion);
    const parts = uniq(
      [locality, locality ? undefined : region, country].filter(Boolean) as string[],
    );
    if (parts.length) return parts.join(', ');
  }
  return undefined;
}

const LOCATION_RE =
  /\b(?:based in|located in|headquartered in|offices? in|serving clients in)\s+((?:[A-Z][\p{L}'.-]+)(?:(?:,\s*|\s+)(?:[A-Z][\p{L}'.-]+)){0,3})/u;

function humanType(t: string): string {
  return t.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** Read the brand from the crawl. Pure: no network, no model. */
export function inferBrand(site: SiteContext): BrandProfile {
  const domain = site.host.replace(/^www\./, '').toLowerCase();
  const domainLabel = domain.split('.')[0] ?? domain;
  const home = homePage(site);
  const about = findPages(site, ABOUT_RE, 2);
  const contact = findPages(site, CONTACT_RE, 2);
  const keyPages = uniq([home, ...about, ...contact].filter(Boolean) as PageData[], (p) => p.url);
  const nodes = schemaNodes(keyPages.length ? keyPages : htmlPages(site).slice(0, 10));
  const orgs = nodes.filter((n) => typesOf(n).some((t) => ORG_TYPES.test(t)));
  // Prefer the organisation whose URL is this site, then the one with most detail.
  const org =
    orgs.find((n) => str(n.url) && hostOf(str(n.url)!) === domain) ??
    [...orgs].sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0];
  const website = nodes.find((n) => typesOf(n).includes('WebSite'));

  const name =
    str(org?.name) ??
    str(home?.og['og:site_name']) ??
    str(website?.name) ??
    titleName(home?.title ?? null, domainLabel) ??
    capitalise(domainLabel);

  const description =
    str(org?.description) ??
    str(home?.metaDescription) ??
    str(home?.og['og:description']) ??
    undefined;

  // Services: schema first, then service links in the nav, then headings on the services page.
  const services: string[] = [];
  for (const n of nodes) {
    const types = typesOf(n);
    if (types.includes('Service')) services.push(...strs(n.name ?? n.serviceType));
    if (types.includes('OfferCatalog')) services.push(...strs(n.itemListElement));
  }
  if (org) {
    for (const offer of Array.isArray(org.makesOffer)
      ? org.makesOffer
      : org.makesOffer
        ? [org.makesOffer]
        : [])
      services.push(...strs((offer as Node).itemOffered));
    services.push(...strs(org.knowsAbout).slice(0, 4));
  }
  if (home) {
    for (const l of home.links) {
      if (!l.internal || !(l.region === 'nav' || l.region === 'header' || l.region === 'footer'))
        continue;
      const p = pathOf(l.href);
      const segs = p.split('/').filter(Boolean);
      if (segs.length >= 2 && SERVICE_RE.test(`/${segs[0]}/`)) services.push(l.text);
    }
  }
  const servicesPage = findPages(site, /^\/(services?|solutions?|what-we-do)\/?$/, 1)[0];
  if (servicesPage && services.length < 3)
    services.push(
      ...servicesPage.headings.filter((h) => h.level === 2 || h.level === 3).map((h) => h.text),
    );
  const cleanServices = uniq(
    services
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(
        (s) => s.length >= 3 && s.length <= 60 && !GENERIC_LINKS.test(s) && !sameBrand(s, name),
      ),
    (s) => s.toLowerCase(),
  ).slice(0, 10);

  // Location: schema address, then areaServed, then "based in …" on about/contact/home.
  let location = addressText(org?.address) ?? addressText(nodes.find((n) => n.address)?.address);
  if (!location) {
    const served = strs(org?.areaServed)[0];
    if (served) location = served;
  }
  if (!location) {
    for (const p of [...contact, ...about, home].filter(Boolean) as PageData[]) {
      const m = (p.mainText ?? p.text).match(LOCATION_RE);
      if (m) {
        location = m[1]!.replace(/[.,]+$/, '');
        break;
      }
    }
  }

  // Industry: a specific schema type, or "… for <audience>" in the description.
  let industry: string | undefined;
  const specific = org ? typesOf(org).find((t) => !GENERIC_TYPES.has(t)) : undefined;
  if (specific) industry = humanType(specific);
  if (!industry && description) {
    const m = description.match(
      /\bfor ((?:small|medium|large|local|growing|b2b|b2c)?\s?[a-z][a-z &-]{3,40}?)(?:\s+in\b|[,.;]|$)/i,
    );
    if (m) industry = m[1]!.trim().toLowerCase();
  }

  const aliases = uniq(
    [
      ...strs(org?.alternateName),
      ...strs(org?.legalName),
      domain,
      name.replace(/\b(ltd|limited|inc|llc|plc|gmbh|sdn bhd|pte ltd)\.?$/i, '').trim(),
    ].filter((a) => a && a.toLowerCase() !== name.toLowerCase()),
    (a) => a.toLowerCase(),
  );

  return {
    name,
    domain,
    aliases,
    ...(description ? { description: truncate(description, 300) } : {}),
    services: cleanServices,
    ...(location ? { location } : {}),
    ...(industry ? { industry } : {}),
    competitors: [],
  };
}

/** Apply the owner's overrides (SiteConfig.brand) on top of what was inferred. */
export function mergeBrand(inferred: BrandProfile, override?: SiteConfig['brand']): BrandProfile {
  if (!override) return inferred;
  const out: BrandProfile = { ...inferred };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** The `sameAs` profile links from the site's Organization schema. */
export function sameAsLinks(site: SiteContext): string[] {
  const home = homePage(site);
  const nodes = schemaNodes(
    home ? [home, ...findPages(site, ABOUT_RE, 2)] : htmlPages(site).slice(0, 5),
  );
  return uniq(nodes.flatMap((n) => strs(n.sameAs)).filter((u) => /^https?:\/\//.test(u)));
}

export interface SiteFacts {
  foundedYear?: number;
  locations: string[];
  emails: string[];
  phones: string[];
  services: string[];
  /** Text of the home, about, contact and service pages, for fact checks. */
  text: string;
}

/** Facts the site states about itself, for checking what AI says against them. */
export function extractSiteFacts(site: SiteContext, brand?: BrandProfile): SiteFacts {
  const home = homePage(site);
  const pages = uniq(
    [
      home,
      ...findPages(site, ABOUT_RE, 2),
      ...findPages(site, CONTACT_RE, 2),
      ...findPages(site, SERVICE_RE, 3),
    ].filter(Boolean) as PageData[],
    (p) => p.url,
  );
  const text = pages.map((p) => `# ${p.title ?? p.url}\n${p.mainText ?? p.text}`).join('\n\n');
  const nodes = schemaNodes(pages);
  let foundedYear: number | undefined;
  for (const n of nodes) {
    const f = str(n.foundingDate);
    if (f && /^\d{4}/.test(f)) {
      foundedYear = Number(f.slice(0, 4));
      break;
    }
  }
  if (!foundedYear) {
    const m = text.match(
      /\b(?:founded|established|started|since|est\.?)\s+(?:in\s+)?((?:19|20)\d{2})\b/i,
    );
    if (m) foundedYear = Number(m[1]);
  }
  const locations = uniq(
    [brand?.location, ...nodes.map((n) => addressText(n.address))].filter(Boolean) as string[],
    (s) => s.toLowerCase(),
  );
  const emails = uniq(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []).slice(0, 5);
  const phones = uniq(text.match(/\+?\d[\d\s().-]{7,}\d/g) ?? []).slice(0, 5);
  return {
    ...(foundedYear ? { foundedYear } : {}),
    locations,
    emails,
    phones,
    services: brand?.services ?? [],
    text: truncate(text, 30_000),
  };
}

/** Short text of the site for prompt writing: home, about, services. */
export function siteSummaryText(site: SiteContext, max = 6_000): string {
  const home = homePage(site);
  const pages = uniq(
    [home, ...findPages(site, ABOUT_RE, 1), ...findPages(site, SERVICE_RE, 2)].filter(
      Boolean,
    ) as PageData[],
    (p) => p.url,
  );
  return truncate(
    pages
      .map(
        (p) =>
          `# ${p.title ?? p.url}\n${p.headings
            .slice(0, 15)
            .map((h) => `${'#'.repeat(h.level)} ${h.text}`)
            .join('\n')}\n${truncate(p.mainText ?? p.text, 2_000)}`,
      )
      .join('\n\n'),
    max,
  );
}

const brandSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  services: z.array(z.string()),
  location: z.string().nullable(),
  industry: z.string().nullable(),
});

/**
 * Optional: one model call to tidy the inferred profile (services named as
 * buyers name them, a one-line description). Keeps the inferred values when
 * no model is available or the call fails. Never changes the domain.
 */
export async function refineBrand(
  brand: BrandProfile,
  site: SiteContext,
  config: AvcConfig,
  signal?: AbortSignal,
): Promise<{ brand: BrandProfile; costUsd: number }> {
  if (!helperModel(config, 'writer')) return { brand, costUsd: 0 };
  try {
    const { value, costUsd } = await structured(
      config,
      brandSchema,
      BRAND_SYSTEM,
      `Domain: ${brand.domain}\nInferred so far: ${JSON.stringify({ ...brand, competitors: undefined })}\n\nWebsite text:\n<<<\n${siteSummaryText(site)}\n>>>`,
      { maxOutputTokens: 600, role: 'writer', signal },
    );
    return {
      brand: {
        ...brand,
        name: value.name?.trim() || brand.name,
        description: value.description?.trim() || brand.description,
        services: value.services.length
          ? uniq(value.services.map((s) => s.trim()).filter(Boolean), (s) => s.toLowerCase()).slice(
              0,
              8,
            )
          : brand.services,
        location: value.location?.trim() || brand.location,
        industry: value.industry?.trim() || brand.industry,
      },
      costUsd,
    };
  } catch {
    return { brand, costUsd: 0 };
  }
}
