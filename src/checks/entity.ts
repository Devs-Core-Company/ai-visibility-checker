/**
 * Entity clarity (pillar 'geo', category 'geo-entity'): can an engine tell
 * exactly which organisation this site belongs to, and connect it to the same
 * entity elsewhere on the web (knowledge graphs, profiles, directories)?
 */
import type { Check, PageData, SiteContext } from '../core/types.js';
import {
  ORG_TYPES,
  LOCAL_TYPES,
  collapse,
  ev,
  has,
  homePage,
  htmlPages,
  issue,
  memo,
  nodesOfType,
  pageCheck,
  pathOf,
  plural,
  safeUrl,
  sameSite,
  siteCheck,
  siteNodesOfType,
  str,
  strList,
  typesOf,
  vb,
  type AiDef,
  type JsonNode,
} from './_ai-util.js';
import { isSubtypeOf } from './schema-vocabulary.js';
import { geoSignals } from '../agentic/geo-score.js';

const REF = {
  org: 'https://developers.google.com/search/docs/appearance/structured-data/organization',
  local: 'https://developers.google.com/search/docs/appearance/structured-data/local-business',
  sameAs: 'https://schema.org/sameAs',
  website: 'https://developers.google.com/search/docs/appearance/site-names',
};

const base = { category: 'geo-entity', pillar: 'geo' } as const;
const def = (d: Omit<AiDef, 'category' | 'pillar'>): AiDef => ({
  ...base,
  tags: ['entity', 'schema'],
  ...d,
});

const PROFILES: { name: string; re: RegExp; weight: number }[] = [
  { name: 'LinkedIn', re: /linkedin\.com\/(company|in|school)\//i, weight: 3 },
  { name: 'Wikidata', re: /wikidata\.org\/(wiki|entity)\/Q\d+/i, weight: 3 },
  { name: 'Wikipedia', re: /wikipedia\.org\/wiki\//i, weight: 3 },
  { name: 'Crunchbase', re: /crunchbase\.com\/organization\//i, weight: 1 },
  { name: 'GitHub', re: /github\.com\/[^/]+\/?$/i, weight: 1 },
  { name: 'X / Twitter', re: /(twitter|x)\.com\/[^/]+\/?$/i, weight: 1 },
  { name: 'YouTube', re: /youtube\.com\/(@|c\/|channel\/|user\/)/i, weight: 1 },
  { name: 'Facebook', re: /facebook\.com\/[^/]+/i, weight: 1 },
  { name: 'Instagram', re: /instagram\.com\/[^/]+/i, weight: 1 },
  {
    name: 'Google Business Profile',
    re: /(g\.page\/|maps\.app\.goo\.gl|google\.com\/maps\/place|business\.google\.com|g\.co\/kgs\/)/i,
    weight: 2,
  },
  { name: 'Clutch', re: /clutch\.co\/profile\//i, weight: 1 },
  { name: 'Trustpilot', re: /trustpilot\.com\/review\//i, weight: 1 },
];

const SOCIAL_HOSTS =
  /(linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|github\.com|tiktok\.com|crunchbase\.com|pinterest\.com|threads\.net|bsky\.app|clutch\.co|trustpilot\.com)/i;

interface OrgRef {
  page: PageData;
  node: JsonNode;
}

function orgs(site: SiteContext): OrgRef[] {
  return memo(site, 'entityOrgs', () =>
    siteNodesOfType(site, ORG_TYPES).filter(({ node }) => {
      // Skip publisher/brand stubs nested in other nodes that only carry a name.
      return Object.keys(node).filter((k) => !k.startsWith('@')).length >= 3;
    }),
  );
}

/** The site's primary organisation node: from the home page if present, else the most complete. */
function primaryOrg(site: SiteContext): OrgRef | null {
  return memo(site, 'primaryOrg', () => {
    const all = orgs(site);
    if (!all.length) return null;
    const home = homePage(site);
    const score = (n: JsonNode) => Object.keys(n).length;
    const onHome = all.filter((o) => o.page === home).sort((a, b) => score(b.node) - score(a.node));
    if (onHome.length) return onHome[0]!;
    return [...all].sort((a, b) => score(b.node) - score(a.node))[0]!;
  });
}

function sameAs(node: JsonNode): string[] {
  return strList(node.sameAs);
}

function isLocal(node: JsonNode): boolean {
  return typesOf(node).some((t) => LOCAL_TYPES.includes(t));
}

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(
      /\b(ltd|limited|llc|inc|plc|gmbh|pvt|private|co|corp|corporation|company|sdn bhd|bhd|pte)\b\.?/g,
      '',
    )
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function findPage(site: SiteContext, re: RegExp): PageData | undefined {
  return htmlPages(site).find((p) => re.test(pathOf(p.url)) && p.status === 200);
}

const ABOUT_RE =
  /^\/(about|about-us|company|who-we-are|our-story|om-oss|uber-uns|a-propos|qui-sommes-nous)(\/|$)/i;
const CONTACT_RE = /^\/(contact|contact-us|get-in-touch|kontakt|contacto|enquiries)(\/|$)/i;

function phones(page: PageData): string[] {
  return [
    ...new Set(
      page.links
        .filter((l) => /^tel:/i.test(l.href))
        .map((l) => l.href.replace(/^tel:/i, '').replace(/[^\d+]/g, '')),
    ),
  ].filter((x) => x.length >= 7);
}

/** Digits of a phone number, compared by the last nine (national number without prefixes). */
function phoneKey(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  return d.length >= 9 && d.length <= 15 ? d.slice(-9) : null;
}

const PHONE_TEXT = /(?:\+|\b0)\d[\d\s().-]{6,18}\d/g;

/** Phone numbers a visitor sees on the page: click-to-call links and numbers in the text. */
function visiblePhones(page: PageData): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of page.links) {
    if (!/^tel:/i.test(l.href)) continue;
    const raw = decodeURIComponent(l.href.replace(/^tel:/i, ''));
    const k = phoneKey(raw);
    if (k && !out.has(k)) out.set(k, raw);
  }
  for (const m of (page.text || '').matchAll(PHONE_TEXT)) {
    const k = phoneKey(m[0]);
    if (k && !out.has(k)) out.set(k, m[0].trim());
  }
  return out;
}

/** Organisation/LocalBusiness nodes on a page that describe that page (url or @id points to it). */
function ownBusinessNodes(page: PageData): JsonNode[] {
  const here = (page.finalUrl || page.url).replace(/[#?].*$/, '').replace(/\/$/, '');
  return nodesOfType(page, ['Organization', 'LocalBusiness', ...ORG_TYPES]).filter((n) => {
    if (!typesOf(n).some((t) => isSubtypeOf(t, 'Organization') || isSubtypeOf(t, 'LocalBusiness')))
      return false;
    return [str(n.url), str(n['@id'])].some((u) => {
      if (!u) return false;
      const abs = safeUrl(u, page.finalUrl || page.url)?.toString();
      return abs ? abs.replace(/[#?].*$/, '').replace(/\/$/, '') === here : false;
    });
  });
}

export const checks: Check[] = [
  siteCheck(
    def({
      id: 'geo-entity.no-organization',
      title: 'No Organization or LocalBusiness schema',
      why: 'Organization markup is how you tell engines, in their own vocabulary, who is behind the site: legal name, logo, contact and profiles. Without it they infer, and can confuse you with similarly named companies.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Add Organization (or the most specific LocalBusiness subtype) JSON-LD to the home page with name, url, logo, sameAs, contactPoint and, for local firms, address.',
      refs: [REF.org],
    }),
    (site) =>
      htmlPages(site).length && !primaryOrg(site)
        ? issue(
            'geo-entity.no-organization',
            'No Organization-type JSON-LD found on any crawled page.',
          )
        : null,
  ),

  siteCheck(
    def({
      id: 'geo-entity.org-incomplete',
      title: 'Organization schema missing core properties',
      why: 'name, url and logo are the minimum engines use to identify the organisation and show it. Missing any of them weakens the match between your site and your entity.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add the missing properties to the Organization JSON-LD.',
      refs: [REF.org],
    }),
    (site) => {
      const o = primaryOrg(site);
      if (!o) return null;
      const missing = ['name', 'url', 'logo'].filter((k) => !has(o.node, k));
      return missing.length
        ? issue('geo-entity.org-incomplete', `Organization schema lacks ${missing.join(', ')}.`, {
            url: o.page.url,
          })
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.org-no-sameas',
      title: 'Organization has no sameAs links',
      why: 'sameAs ties your site to the same organisation’s profiles elsewhere (LinkedIn, Wikidata, Crunchbase). It is one of the strongest ways to disambiguate your brand for knowledge graphs and AI models.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add "sameAs": [ … ] listing the URLs of your official profiles.',
      refs: [REF.org, REF.sameAs],
    }),
    (site) => {
      const o = primaryOrg(site);
      return o && !sameAs(o.node).length
        ? issue('geo-entity.org-no-sameas', 'The Organization schema has no sameAs.', {
            url: o.page.url,
          })
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.sameas-thin',
      title: 'sameAs misses major profiles',
      why: 'LinkedIn, Wikidata and (for local firms) the Google Business Profile are the sources AI models and knowledge graphs most often reconcile companies against.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add the missing official profiles to sameAs. Only link profiles you control or that are about you.',
      refs: [REF.sameAs],
    }),
    (site) => {
      const o = primaryOrg(site);
      if (!o) return null;
      const links = sameAs(o.node);
      if (!links.length) return null;
      const present = PROFILES.filter((p) => links.some((l) => p.re.test(l))).map((p) => p.name);
      const want = ['LinkedIn', ...(isLocal(o.node) ? ['Google Business Profile'] : [])];
      const missing = want.filter((w) => !present.includes(w));
      return missing.length
        ? issue(
            'geo-entity.sameas-thin',
            `sameAs has ${plural(links.length, 'link')} but none to ${missing.join(' or ')}.`,
            { data: { present, missing } },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.no-wikidata',
      title: 'No Wikidata entry linked',
      why: 'Wikidata is the open knowledge graph many AI systems use to identify organisations. Linking an existing entry from sameAs removes ambiguity. Not every business qualifies for one; only add an entry if you meet Wikidata’s notability rules.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'If a Wikidata item for your organisation exists, add its URL (https://www.wikidata.org/wiki/Q…) to sameAs.',
      refs: ['https://www.wikidata.org/wiki/Wikidata:Notability'],
    }),
    (site) => {
      const o = primaryOrg(site);
      if (!o || !sameAs(o.node).length) return null;
      return sameAs(o.node).some((l) => /wikidata\.org/i.test(l))
        ? null
        : issue('geo-entity.no-wikidata', 'sameAs does not include a Wikidata item.');
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.sameas-invalid',
      title: 'sameAs contains invalid or self links',
      why: 'sameAs should list other pages about the same entity. Relative paths, non-URLs and links back to your own site add nothing and can be read as errors.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Keep only absolute https URLs of external profiles in sameAs.',
    }),
    (site) => {
      const o = primaryOrg(site);
      if (!o) return null;
      const bad = sameAs(o.node).filter(
        (l) => !/^https?:\/\//i.test(l) || sameSite(l, site.origin),
      );
      return bad.length
        ? issue(
            'geo-entity.sameas-invalid',
            `${plural(bad.length, 'sameAs value')} ${vb(bad.length, 'is', 'are')} not external profile URLs.`,
            { evidence: ev(bad) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.social-not-in-sameas',
      title: 'Profiles linked on the site are missing from sameAs',
      why: 'You already link these profiles in your header or footer. Listing them in sameAs as well turns a visual link into a machine-readable identity claim.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add the listed profile URLs to the Organization sameAs.',
    }),
    (site) => {
      const o = primaryOrg(site);
      const home = homePage(site);
      if (!o || !home) return null;
      const listed = new Set(sameAs(o.node).map((u) => u.replace(/\/$/, '').toLowerCase()));
      const social = [
        ...new Set(
          home.links
            .filter(
              (l) =>
                !l.internal &&
                SOCIAL_HOSTS.test(safeUrl(l.href)?.host ?? '') &&
                !/\/(share|sharer|intent)/i.test(l.href),
            )
            .map((l) => l.href.replace(/\/$/, '')),
        ),
      ];
      const missing = social.filter((u) => !listed.has(u.toLowerCase()));
      return missing.length
        ? issue(
            'geo-entity.social-not-in-sameas',
            `${plural(missing.length, 'profile')} linked from the home page ${vb(missing.length, 'is', 'are')} not in sameAs.`,
            { evidence: ev(missing) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.org-no-contact',
      title: 'Organization schema has no contact details',
      why: 'contactPoint, telephone or email let engines answer “how do I contact X” from your own data rather than a directory that may be out of date.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add contactPoint (contactType, telephone or email) or telephone/email to the Organization schema.',
      refs: [REF.org],
    }),
    (site) => {
      const o = primaryOrg(site);
      if (!o) return null;
      return ['contactPoint', 'telephone', 'email'].some((k) => has(o.node, k))
        ? null
        : issue(
            'geo-entity.org-no-contact',
            'No contactPoint, telephone or email in the Organization schema.',
          );
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.local-no-address',
      title: 'Local business schema without address or hours',
      why: 'For a business people visit or call, address, geo coordinates and opening hours are what “near me” and “open now” answers are built from.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add address (PostalAddress), geo, telephone and openingHoursSpecification to the LocalBusiness schema.',
      refs: [REF.local],
    }),
    (site) => {
      const o = primaryOrg(site);
      if (!o || !isLocal(o.node)) return null;
      const missing = ['address', 'telephone', 'openingHoursSpecification'].filter(
        (k) =>
          !has(o.node, k) && !(k === 'openingHoursSpecification' && has(o.node, 'openingHours')),
      );
      return missing.length
        ? issue(
            'geo-entity.local-no-address',
            `${typesOf(o.node).join('/')} schema lacks ${missing.join(', ')}.`,
            { url: o.page.url },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.org-no-description',
      title: 'Organization schema has no description',
      why: 'A one-sentence description in your own words is a ready answer to “what does X do” that engines can attribute to you.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Add "description": what you do, for whom, and where, in one plain sentence.',
    }),
    (site) => {
      const o = primaryOrg(site);
      return o && !has(o.node, 'description')
        ? issue('geo-entity.org-no-description', 'No description in the Organization schema.')
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.org-no-background',
      title: 'Organization schema lacks founding facts',
      why: 'foundingDate, founder and location are facts engines repeat when describing a company. Supplying them reduces the chance of wrong guesses.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add foundingDate and founder (Person) and, if relevant, foundingLocation.',
    }),
    (site) => {
      const o = primaryOrg(site);
      if (!o) return null;
      const missing = ['foundingDate', 'founder'].filter(
        (k) => !has(o.node, k) && !(k === 'founder' && has(o.node, 'founders')),
      );
      return missing.length === 2
        ? issue(
            'geo-entity.org-no-background',
            'No foundingDate or founder in the Organization schema.',
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.org-no-expertise',
      title: 'Organization schema does not say what you do',
      why: 'knowsAbout, areaServed and makesOffer/hasOfferCatalog describe your subject areas, markets and services in a structured way, helping engines match you to category questions.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add knowsAbout (topics), areaServed (countries or regions) and makesOffer or hasOfferCatalog (services).',
    }),
    (site) => {
      const o = primaryOrg(site);
      if (!o) return null;
      return ['knowsAbout', 'areaServed', 'makesOffer', 'hasOfferCatalog', 'serviceArea'].some(
        (k) => has(o.node, k),
      )
        ? null
        : issue(
            'geo-entity.org-no-expertise',
            'No knowsAbout, areaServed or offers in the Organization schema.',
          );
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.org-no-id',
      title: 'Organization schema has no @id',
      why: 'A stable @id (such as https://example.com/#organization) lets every page’s Article publisher, WebSite and Product markup point to one organisation node instead of creating many.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Give the Organization an "@id" and reference it ({"@id": "…#organization"}) from publisher, brand and provider fields.',
    }),
    (site) => {
      const o = primaryOrg(site);
      return o && !has(o.node, '@id')
        ? issue('geo-entity.org-no-id', 'The Organization node has no @id.')
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.org-name-conflict',
      title: 'Different organisation names across pages',
      why: 'If page templates declare different organisation names, engines cannot tell whether they are one company or several.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Use one exact organisation name in every Organization node (put trading names in alternateName).',
    }),
    (site) => {
      const names = new Map<string, Set<string>>();
      for (const { page, node } of orgs(site)) {
        const n = str(node.name);
        if (!n) continue;
        const k = normName(n);
        if (!names.has(k)) names.set(k, new Set());
        names.get(k)!.add(`${n} (${pathOf(page.url)})`);
      }
      if (names.size < 2) return null;
      return issue(
        'geo-entity.org-name-conflict',
        `${names.size} different organisation names are declared.`,
        {
          evidence: ev([...names.values()].map((s) => [...s][0]!)),
        },
      );
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.brand-inconsistent',
      title: 'Brand name differs between title, og:site_name and schema',
      why: 'The site name engines show and repeat is taken from WebSite schema, og:site_name and title patterns. When they disagree, engines pick one, not necessarily yours.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Use the same brand name in WebSite/Organization schema, og:site_name and the title suffix.',
      refs: [REF.website],
    }),
    (site) => {
      const home = homePage(site);
      if (!home) return null;
      const vals: [string, string][] = [];
      const o = primaryOrg(site);
      const ws = nodesOfType(home, ['WebSite'])[0];
      if (o && str(o.node.name)) vals.push(['Organization', str(o.node.name)!]);
      if (ws && str(ws.name)) vals.push(['WebSite', str(ws.name)!]);
      if (home.og?.['og:site_name']) vals.push(['og:site_name', home.og['og:site_name']]);
      if (vals.length < 2) return null;
      const norm = vals.map(([, v]) => normName(v));
      const ok = norm.every((n) => n === norm[0]);
      return ok
        ? null
        : issue(
            'geo-entity.brand-inconsistent',
            'The brand name is declared differently in different places.',
            { evidence: ev(vals.map(([k, v]) => `${k}: ${v}`)) },
          );
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.no-og-site-name',
      title: 'No og:site_name on the home page',
      why: 'og:site_name is one of the signals Google and link previews use for your site name.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add <meta property="og:site_name" content="Your Brand">.',
      refs: [REF.website],
    }),
    (site) => {
      const home = homePage(site);
      return home && home.isHtml && !home.og?.['og:site_name']
        ? issue('geo-entity.no-og-site-name', 'The home page has no og:site_name.', {
            url: home.url,
          })
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.no-website-schema',
      title: 'No WebSite schema on the home page',
      why: 'WebSite JSON-LD with name and url is Google’s preferred way to state your site name, and links the site to its publisher organisation.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add WebSite JSON-LD to the home page with name, url, and publisher referencing your Organization @id.',
      refs: [REF.website],
    }),
    (site) => {
      const home = homePage(site);
      return home && home.isHtml && !nodesOfType(home, ['WebSite']).length
        ? issue('geo-entity.no-website-schema', 'No WebSite JSON-LD on the home page.', {
            url: home.url,
          })
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.publisher-mismatch',
      title: 'Article publisher differs from the organisation',
      why: 'When articles name a different publisher from your Organization schema, engines may credit the content to someone else.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Set publisher on Article/BlogPosting to your Organization (ideally by @id).',
    }),
    (site) => {
      const o = primaryOrg(site);
      const orgName = o ? str(o.node.name) : null;
      if (!orgName) return null;
      const hits: string[] = [];
      for (const { page, node } of siteNodesOfType(site, [
        'Article',
        'BlogPosting',
        'NewsArticle',
        'TechArticle',
      ])) {
        const pub = node.publisher as JsonNode | undefined;
        const n = pub && typeof pub === 'object' ? str(pub.name) : null;
        if (n && normName(n) !== normName(orgName)) hits.push(`${pathOf(page.url)}: ${n}`);
      }
      return hits.length
        ? issue(
            'geo-entity.publisher-mismatch',
            `${plural(hits.length, 'article')} ${vb(hits.length, 'names', 'name')} a publisher other than "${orgName}".`,
            { evidence: ev(hits.slice(0, 8)) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.logo-not-image',
      title: 'Organization logo is not an image URL',
      why: 'Engines show and match your logo from this URL. A page URL or relative path cannot be used.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Point logo at an absolute URL of a square or rectangular PNG, SVG or JPG (at least 112 × 112 px).',
      refs: [REF.org],
    }),
    (site) => {
      const o = primaryOrg(site);
      const logo = o ? str(o.node.logo) : null;
      if (!logo) return null;
      const bad =
        !/^https?:\/\//i.test(logo) ||
        (!/\.(png|jpe?g|svg|webp|gif|avif)(\?|$)/i.test(logo) && /\/$|\.html?(\?|$)/i.test(logo));
      return bad ? issue('geo-entity.logo-not-image', `logo is "${logo}".`) : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.nap-inconsistent',
      title: 'Phone numbers differ across pages',
      why: 'Consistent name, address and phone details across your pages and directories are how engines confirm a business is real and where it is. Several numbers in click-to-call links suggest outdated templates.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Use one primary phone number site-wide (and in schema); label any other numbers clearly by department or branch.',
    }),
    (site) => {
      const counts = new Map<string, number>();
      for (const p of htmlPages(site))
        for (const n of phones(p))
          counts.set(n.replace(/^\+?44|^0/, ''), (counts.get(n.replace(/^\+?44|^0/, '')) ?? 0) + 1);
      const o = primaryOrg(site);
      const schemaTel = o
        ? str(o.node.telephone)
            ?.replace(/[^\d+]/g, '')
            .replace(/^\+?44|^0/, '')
        : undefined;
      const nums = [...counts.entries()].filter(([, n]) => n >= 2);
      const distinct = new Set(nums.map(([k]) => k.slice(-9)));
      if (schemaTel && distinct.size && !distinct.has(schemaTel.slice(-9)))
        return issue(
          'geo-entity.nap-inconsistent',
          'The phone number in the schema does not appear in click-to-call links on the site.',
          {
            evidence: ev([`schema: ${schemaTel}`, ...nums.map(([k, n]) => `${k} on ${n} pages`)]),
          },
        );
      return distinct.size > 2
        ? issue(
            'geo-entity.nap-inconsistent',
            `${distinct.size} different phone numbers are used in click-to-call links.`,
            { evidence: ev(nums.map(([k, n]) => `${k} on ${n} pages`)) },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-entity.nap-page-mismatch',
      title: 'Phone number in the markup differs from the page',
      why: 'Google asks that structured data describe the content people see. When the LocalBusiness or Organization telephone differs from the number shown on the same page, engines cannot tell which is right and assistants may give out the wrong one.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Make the telephone in the JSON-LD the same number the page shows (in international format, for example +44 1632 960245), and update both together.',
      refs: [
        'https://developers.google.com/search/docs/appearance/structured-data/local-business',
        'https://developers.google.com/search/docs/appearance/structured-data/sd-policies',
      ],
      tags: ['geo', 'local'],
    }),
    (page) => {
      if (!page.isHtml || page.status !== 200) return null;
      const shown = visiblePhones(page);
      if (!shown.size) return null;
      const bad: string[] = [];
      for (const n of ownBusinessNodes(page)) {
        const tel = str(n.telephone);
        const k = tel ? phoneKey(tel) : null;
        if (tel && k && !shown.has(k)) bad.push(`${typesOf(n).join('/')} telephone "${tel}"`);
      }
      return bad.length
        ? issue(
            'geo-entity.nap-page-mismatch',
            `The markup gives a phone number the page does not show (${[...shown.values()].slice(0, 2).join(', ')} on the page).`,
            { url: page.url, evidence: ev(bad) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.no-about-page',
      title: 'No About page found',
      why: 'An About page is where engines look for who you are, how long you have operated and who runs the business. It is a basic trust signal for people and for AI answers.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Publish an About page (/about) with the company story, people, location and credentials, and link it from the main navigation or footer.',
    }),
    (site) =>
      htmlPages(site).length >= 3 &&
      !findPage(site, ABOUT_RE) &&
      !htmlPages(site).some((p) => schemaTypesHas(p, 'AboutPage'))
        ? issue('geo-entity.no-about-page', 'No About page among the crawled pages.')
        : null,
  ),

  siteCheck(
    def({
      id: 'geo-entity.about-not-linked',
      title: 'About page not linked from the home page',
      why: 'If the About page is not linked from the home page, crawlers reach it late or not at all, and it loses weight as the source of who you are.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Link the About page from the header or footer.',
    }),
    (site) => {
      const about = findPage(site, ABOUT_RE);
      const home = homePage(site);
      if (!about || !home) return null;
      const linked = home.links.some((l) => l.internal && ABOUT_RE.test(pathOf(l.href)));
      return linked
        ? null
        : issue('geo-entity.about-not-linked', 'The home page does not link to the About page.', {
            url: about.url,
          });
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.no-contact-page',
      title: 'No Contact page found',
      why: 'A contact page with address, phone and email confirms you are a real, reachable business and gives engines contact facts from the source.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Publish a Contact page with your business name, address (if you have one), phone and email, and link it site-wide.',
    }),
    (site) => {
      if (htmlPages(site).length < 3) return null;
      const home = homePage(site);
      const linked = home?.links.some((l) => l.internal && CONTACT_RE.test(pathOf(l.href)));
      return !findPage(site, CONTACT_RE) &&
        !linked &&
        !htmlPages(site).some((p) => schemaTypesHas(p, 'ContactPage'))
        ? issue('geo-entity.no-contact-page', 'No Contact page among the crawled pages.')
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'geo-entity.no-author-pages',
      title: 'Authors have no profile pages',
      why: 'An author page that lists a person’s role, experience and other articles, linked from each byline, lets engines connect the work to a person and judge their expertise.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Create a page per author (/authors/name) with bio, credentials and sameAs profiles, and link bylines and the schema author url to it.',
    }),
    (site) => {
      const named = new Set<string>();
      let withUrl = 0;
      for (const p of htmlPages(site)) {
        const s = geoSignals(p);
        if (!s.authorSchema && !s.bylineVisible) continue;
        named.add(s.authorName ?? s.bylineVisible ?? '');
        if (s.authorSchema && (str(s.authorSchema.url) || str(s.authorSchema['@id']))) withUrl++;
      }
      const hasAuthorPages = htmlPages(site).some(
        (p) =>
          /\/(authors?|team|people|writers?)\//i.test(pathOf(p.url)) ||
          schemaTypesHas(p, 'ProfilePage'),
      );
      return named.size && !withUrl && !hasAuthorPages
        ? issue(
            'geo-entity.no-author-pages',
            `${plural(named.size, 'author')} named, but no author pages found.`,
            { evidence: ev([...named].filter(Boolean)) },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-entity.duplicate-org-nodes',
      title: 'Several conflicting Organization nodes on one page',
      why: 'When a theme and a plugin each output an Organization, engines see two descriptions of the company that may disagree.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Keep one Organization node per page (disable the duplicate output in the theme or SEO plugin).',
    }),
    (page) => {
      const nodes = nodesOfType(page, ORG_TYPES).filter((n) => Object.keys(n).length >= 4);
      const names = new Set(nodes.map((n) => normName(str(n.name) ?? '')).filter(Boolean));
      const ids = new Set(nodes.map((n) => str(n['@id'])).filter(Boolean));
      return nodes.length >= 2 && (names.size > 1 || ids.size > 1)
        ? issue(
            'geo-entity.duplicate-org-nodes',
            `${nodes.length} separate Organization nodes on this page.`,
            {
              url: page.url,
              evidence: ev(
                nodes.map((n) => collapse(`${typesOf(n).join('/')}: ${str(n.name) ?? ''}`)),
              ),
            },
          )
        : null;
    },
  ),
];

function schemaTypesHas(page: PageData, type: string): boolean {
  return page.structuredData?.some((s) => s.types.includes(type)) ?? false;
}
