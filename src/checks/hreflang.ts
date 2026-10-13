/**
 * hreflang annotations for multilingual and multi-regional sites.
 */
import type { HreflangRef, Issue, PageData } from '../core/types.js';
import {
  REF,
  declaredCanonical,
  findPage,
  groupBy,
  isCanonicalisedAway,
  isHtml200,
  isIndexable,
  isNoindex,
  list,
  pageCheck,
  plural,
  rawHead,
  sameUrl,
  siteCheck,
  wasRedirected,
} from './_util.js';

export const RETURN_LINK_REPORT_LIMIT = 200;

const T = 'technical' as const;

/** ISO 639-1 language codes. */
const LANGS = new Set(
  'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(
    ' ',
  ),
);
/** Common mistakes: region or wrong code used as a language. */
const WRONG_CODES: Record<string, string> = {
  uk: 'en-GB for British English (uk is Ukrainian)',
  'en-uk': 'en-GB',
  jp: 'ja',
  cn: 'zh',
  'zh-cn': 'zh-Hans or zh-CN is fine; check the region',
  dk: 'da',
  se: 'sv (se is Northern Sami)',
  gr: 'el',
  cz: 'cs',
  kr: 'ko',
  vn: 'vi',
  ua: 'uk',
  ee: 'et (ee is Ewe)',
  'en-eu': 'a country code (EU is not a country)',
};

/** Returns null when valid, else a short reason. */
export function hreflangProblem(code: string): string | null {
  const c = code.trim();
  const low = c.toLowerCase();
  if (low === 'x-default') return null;
  if (WRONG_CODES[low] && low !== 'zh-cn') return `use ${WRONG_CODES[low]}`;
  if (c.includes('_')) return 'use a hyphen, not an underscore';
  const parts = low.split('-');
  if (!LANGS.has(parts[0])) return `"${parts[0]}" is not an ISO 639-1 language code`;
  if (parts.length === 1) return null;
  const rest = parts.slice(1);
  // Script subtag (zh-Hant) then optional region.
  let i = 0;
  if (/^[a-z]{4}$/.test(rest[0])) i = 1;
  if (rest.length > i + 1) return 'too many subtags';
  if (rest.length === i) return null;
  const region = rest[i];
  if (!/^[a-z]{2}$/.test(region) && !/^\d{3}$/.test(region))
    return `"${region}" is not a region code`;
  if (region === 'uk') return 'use GB, not UK, for the United Kingdom';
  if (region === 'eu') return 'EU is not a country code';
  return null;
}

function htmlRefs(page: PageData): HreflangRef[] {
  return page.hreflang.filter((h) => h.source !== 'sitemap');
}

function allRefs(page: PageData): HreflangRef[] {
  return page.hreflang;
}

export const checks = [
  pageCheck(
    {
      id: 'hreflang.invalid-code',
      category: 'hreflang',
      pillar: T,
      title: 'Invalid hreflang language or region code',
      why: 'hreflang values must be an ISO 639-1 language, optionally with an ISO 3166-1 region (en-GB). Invalid codes such as "en-UK" or "jp" are ignored.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Correct the codes. Use language-REGION with a hyphen, for example en-GB, pt-BR, es-419.',
      refs: [REF.hreflang],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = [...new Set(allRefs(page).map((h) => h.lang))]
        .map((l) => [l, hreflangProblem(l)] as const)
        .filter(([, p]) => p);
      return bad.length
        ? {
            checkId: 'hreflang.invalid-code',
            message: `${plural(bad.length, 'invalid hreflang value')}`,
            evidence: list(
              bad.map(([l, p]) => `${l}: ${p}`),
              4,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'hreflang.missing-self',
      category: 'hreflang',
      pillar: T,
      title: 'hreflang set has no self-reference',
      why: 'Each page in an hreflang set should list itself as well as its alternates. Without it, Google may not treat the set as complete.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add an hreflang entry pointing to the page itself, with its own language code.',
      refs: [REF.hreflang],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const refs = allRefs(page);
      if (!refs.length) return null;
      if (
        refs.some(
          (h) =>
            sameUrl(h.href, page.url) ||
            sameUrl(h.href, page.finalUrl) ||
            sameUrl(h.href, declaredCanonical(page)),
        )
      )
        return null;
      return {
        checkId: 'hreflang.missing-self',
        message: 'The page is not listed in its own hreflang set',
      };
    },
  ),
  pageCheck(
    {
      id: 'hreflang.missing-x-default',
      category: 'hreflang',
      pillar: T,
      title: 'No x-default hreflang',
      why: 'x-default tells search engines which version to show users whose language or region you do not target.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add hreflang="x-default" pointing at the language selector or the main version.',
      refs: [REF.hreflang],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const refs = allRefs(page);
      if (refs.length < 2 || refs.some((h) => h.lang.toLowerCase() === 'x-default')) return null;
      return {
        checkId: 'hreflang.missing-x-default',
        message: `${refs.length} hreflang entries, none of them x-default`,
      };
    },
  ),
  pageCheck(
    {
      id: 'hreflang.duplicate-code',
      category: 'hreflang',
      pillar: T,
      title: 'Same hreflang code points to different URLs',
      why: 'If one language-region code lists two different URLs, search engines cannot tell which to show and may ignore both.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Keep one URL per hreflang code.',
      refs: [REF.hreflang],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const g = groupBy(htmlRefs(page), (h) => h.lang.toLowerCase());
      const bad = [...g]
        .filter(([, hs]) => new Set(hs.map((h) => h.href)).size > 1)
        .map(([l]) => l);
      return bad.length
        ? { checkId: 'hreflang.duplicate-code', message: `Conflicting URLs for ${list(bad)}` }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'hreflang.single-entry',
      category: 'hreflang',
      pillar: T,
      title: 'hreflang lists only the page itself',
      why: 'A lone self-referencing hreflang does nothing. It usually means alternates failed to output from the CMS.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'List every language version in the set, or remove hreflang if the site has only one language.',
      refs: [REF.hreflang],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const refs = allRefs(page).filter((h) => h.lang.toLowerCase() !== 'x-default');
      return refs.length === 1 && sameUrl(refs[0].href, page.url)
        ? { checkId: 'hreflang.single-entry', message: 'Only one hreflang entry (the page itself)' }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'hreflang.relative-url',
      category: 'hreflang',
      pillar: T,
      title: 'hreflang uses relative URLs',
      why: 'Google requires fully qualified URLs in hreflang annotations. Relative ones are ignored.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Use absolute URLs including https:// and the host.',
      refs: [REF.hreflang],
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const tags = [...rawHead(page.html).matchAll(/<link\b[^>]*\bhreflang=[^>]*>/gi)].map(
        (m) => m[0],
      );
      const rel = tags
        .map((t) => /\bhref\s*=\s*["']?([^"'\s>]*)/i.exec(t)?.[1] ?? '')
        .filter((h) => h && !/^https?:\/\//i.test(h));
      return rel.length
        ? {
            checkId: 'hreflang.relative-url',
            message: `${plural(rel.length, 'hreflang link')} with relative URLs`,
            evidence: list(rel, 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'hreflang.lang-mismatch',
      category: 'hreflang',
      pillar: T,
      title: 'Self hreflang language differs from the page language',
      why: 'When a page says hreflang="fr" for itself but its html lang is "en", one of the two is wrong and the language version may be served to the wrong audience.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Make the self-referencing hreflang code and the <html lang> attribute agree.',
      refs: [REF.hreflang],
    },
    (page) => {
      if (!isIndexable(page) || !page.lang) return null;
      const self = allRefs(page).find(
        (h) =>
          h.lang.toLowerCase() !== 'x-default' &&
          (sameUrl(h.href, page.url) || sameUrl(h.href, page.finalUrl)),
      );
      if (!self) return null;
      const a = self.lang.toLowerCase().split('-')[0];
      const b = page.lang.toLowerCase().split(/[-_]/)[0];
      return a !== b
        ? {
            checkId: 'hreflang.lang-mismatch',
            message: `Self hreflang is "${self.lang}" but <html lang> is "${page.lang}"`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'hreflang.canonical-conflict',
      category: 'hreflang',
      pillar: T,
      title: 'Canonical points to another language version',
      why: 'If a translated page canonicalises to a different language version, search engines drop the translation and the hreflang set breaks.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Make each language version canonicalise to itself.',
      refs: [REF.hreflang, REF.canonical],
    },
    (page) => {
      if (!isHtml200(page) || !isCanonicalisedAway(page)) return null;
      const c = declaredCanonical(page)!;
      const target = allRefs(page).find((h) => sameUrl(h.href, c));
      const self = allRefs(page).find((h) => sameUrl(h.href, page.url));
      if (!target || !self || target.lang.toLowerCase() === self.lang.toLowerCase()) return null;
      return {
        checkId: 'hreflang.canonical-conflict',
        message: `The ${self.lang} page canonicalises to the ${target.lang} version`,
        evidence: c,
      };
    },
  ),
  pageCheck(
    {
      id: 'hreflang.target-problem',
      category: 'hreflang',
      pillar: T,
      title: 'hreflang points to a URL that is not indexable',
      why: 'Alternates must be live, indexable, canonical URLs. Links to errors, redirects, noindex or canonicalised pages are ignored.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Point each hreflang entry at the final, indexable, self-canonical URL of that language version.',
      refs: [REF.hreflang],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const bad: string[] = [];
      for (const h of allRefs(page)) {
        const t = findPage(site, h.href);
        if (!t) continue;
        if (t.status >= 400 || (t.status === 0 && !t.blockedByRobots))
          bad.push(`${h.lang} → ${t.status || 'no response'}`);
        else if (wasRedirected(t)) bad.push(`${h.lang} → redirects`);
        else if (isHtml200(t) && isNoindex(t)) bad.push(`${h.lang} → noindex`);
        else if (isHtml200(t) && isCanonicalisedAway(t))
          bad.push(`${h.lang} → canonicalised elsewhere`);
        else if (t.blockedByRobots) bad.push(`${h.lang} → blocked by robots.txt`);
      }
      return bad.length
        ? {
            checkId: 'hreflang.target-problem',
            message: `${plural(bad.length, 'hreflang target')} not indexable`,
            evidence: list(bad, 4),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'hreflang.on-non-indexable',
      category: 'hreflang',
      pillar: T,
      title: 'hreflang on a page that is not indexable',
      why: 'hreflang on a noindex or canonicalised page cannot take effect, and the alternates pointing back to it are wasted.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Remove hreflang from non-indexable pages, or make the page indexable if it is a real language version.',
      refs: [REF.hreflang],
    },
    (page) =>
      isHtml200(page) && htmlRefs(page).length && !isIndexable(page) && !page.blockedByRobots
        ? {
            checkId: 'hreflang.on-non-indexable',
            message: 'Page carries hreflang but is noindex or canonicalised elsewhere',
          }
        : null,
  ),
  siteCheck(
    {
      id: 'hreflang.missing-return',
      category: 'hreflang',
      pillar: T,
      title: 'hreflang return links missing',
      why: 'hreflang only counts when both pages point to each other. If page A lists B but B does not list A, Google ignores the pair.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Make every language version list every other version (and itself). Generate the set from one source so they stay in sync.',
      refs: [REF.hreflang],
    },
    (site) => {
      const out: Issue[] = [];
      for (const p of site.pages.values()) {
        if (!isIndexable(p)) continue;
        for (const h of allRefs(p)) {
          if (h.lang.toLowerCase() === 'x-default' || sameUrl(h.href, p.url)) continue;
          const t = findPage(site, h.href);
          if (!t || !isHtml200(t) || !t.hreflang.length) continue;
          if (t.hreflang.some((r) => sameUrl(r.href, p.url) || sameUrl(r.href, p.finalUrl)))
            continue;
          out.push({
            checkId: 'hreflang.missing-return',
            url: p.url,
            message: `${h.href} (${h.lang}) does not link back`,
            evidence: h.href,
          });
          if (out.length >= RETURN_LINK_REPORT_LIMIT) return out;
        }
      }
      return out;
    },
  ),
  siteCheck(
    {
      id: 'hreflang.source-conflict',
      category: 'hreflang',
      pillar: T,
      title: 'HTML and sitemap hreflang disagree',
      why: 'When hreflang is declared in both the HTML and the sitemap with different values, search engines get two conflicting sets.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Declare hreflang in one place, or generate both from the same data.',
      refs: [REF.hreflang],
    },
    (site) => {
      const out: Issue[] = [];
      for (const p of site.pages.values()) {
        const html = p.hreflang.filter((h) => h.source !== 'sitemap');
        const sm = p.hreflang.filter((h) => h.source === 'sitemap');
        if (!html.length || !sm.length) continue;
        const key = (hs: HreflangRef[]) =>
          hs
            .map((h) => `${h.lang.toLowerCase()}=${h.href}`)
            .sort()
            .join('|');
        if (key(html) !== key(sm))
          out.push({
            checkId: 'hreflang.source-conflict',
            url: p.url,
            message: 'hreflang in HTML and in the sitemap list different alternates',
          });
      }
      return out.slice(0, RETURN_LINK_REPORT_LIMIT);
    },
  ),
];
