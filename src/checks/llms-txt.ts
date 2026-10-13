/**
 * llms.txt (pillar 'ai-access'): presence, structure per llmstxt.org, link
 * health, coverage of key pages, llms-full.txt and markdown variants.
 *
 * Honest framing for every finding: llms.txt is a proposal. Coding assistants
 * and agent frameworks read it; no major answer engine has confirmed using it
 * for ranking or citation. It is cheap to do well, so worth doing, but it is
 * not why a site is or is not cited.
 */
import type { Check, SiteContext } from '../core/types.js';
import { botByToken } from '../agentic/bots.js';
import { keyPages, llmsParsed, llmsTxtGrade, type LlmsLink } from '../agentic/llms.js';
import {
  ev,
  found,
  isNoindex,
  canonicalElsewhere,
  issue,
  looksHtml,
  mapLimit,
  memo,
  plural,
  probe,
  robotsUsable,
  sameSite,
  siteCheck,
  urlKey,
  vb,
  type AiDef,
} from './_ai-util.js';

const SPEC = 'https://llmstxt.org/';
const base = { category: 'llms-txt', pillar: 'ai-access' } as const;
const def = (d: Omit<AiDef, 'category' | 'pillar'>): AiDef => ({
  ...base,
  refs: [SPEC],
  tags: ['llms-txt'],
  ...d,
});
const MATURITY =
  'llms.txt is a proposal read mainly by coding assistants and agent tools; no major answer engine has confirmed using it for citations.';

const MAX_LINK_FETCH = 20;

function pageFor(site: SiteContext, u: string | null) {
  if (!u) return undefined;
  const direct = site.pages.get(u);
  if (direct) return direct;
  const k = urlKey(u);
  return memo(site, 'pageByKey', () => {
    const m = new Map<string, ReturnType<typeof site.pages.get>>();
    for (const p of site.pages.values()) {
      m.set(urlKey(p.url), p);
      if (p.finalUrl) m.set(urlKey(p.finalUrl), p);
    }
    return m;
  }).get(k);
}

interface LinkStatus {
  link: LlmsLink;
  status: number;
  finalUrl: string;
  redirected: boolean;
  error?: string;
}

/** Status of llms.txt links: from the crawl when known, else fetched (max 20). Shared by checks. */
function linkStatuses(site: SiteContext): Promise<LinkStatus[]> {
  return memo(site, 'llmsLinkStatuses', async () => {
    const parsed = llmsParsed(site);
    if (!parsed) return [];
    const unique = new Map<string, LlmsLink>();
    for (const l of parsed.links)
      if (l.abs && /^https?:/i.test(l.abs) && !unique.has(l.abs)) unique.set(l.abs, l);
    const links = [...unique.values()];
    const out: LinkStatus[] = [];
    const toFetch: LlmsLink[] = [];
    for (const l of links) {
      const p = pageFor(site, l.abs);
      if (p)
        out.push({
          link: l,
          status: p.status,
          finalUrl: p.finalUrl,
          redirected: (p.redirects?.length ?? 0) > 0,
        });
      else toFetch.push(l);
    }
    // Same-site first: those are the owner's to fix.
    toFetch.sort(
      (a, b) => Number(sameSite(b.abs!, site.origin)) - Number(sameSite(a.abs!, site.origin)),
    );
    const fetched = await mapLimit(toFetch.slice(0, MAX_LINK_FETCH), 3, async (l) => {
      try {
        const r = await site.fetcher.fetch(l.abs!, { timeoutMs: 10_000, maxBytes: 64 * 1024 });
        return {
          link: l,
          status: r.status,
          finalUrl: r.finalUrl,
          redirected: (r.redirects?.length ?? 0) > 0,
          error: r.error,
        };
      } catch (e) {
        return {
          link: l,
          status: 0,
          finalUrl: l.abs!,
          redirected: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    });
    return [...out, ...fetched];
  });
}

function parsedOrNull(site: SiteContext) {
  return llmsParsed(site);
}

export const checks: Check[] = [
  siteCheck(
    def({
      id: 'llms-txt.missing',
      title: 'No /llms.txt',
      why: `An llms.txt gives AI tools a short, curated map of your site in markdown. ${MATURITY}`,
      severity: 'low',
      fixTier: 'guided',
      fix: 'Publish /llms.txt: an H1 with your name, a one-line > summary, then ## sections listing your key pages as - [Title](https://…): what it covers.',
    }),
    (site) => {
      const p = probe(site, 'llms-txt');
      if (!p || p.found || p.status === null) return null;
      if (p.status >= 200 && p.status < 300 && looksHtml(p.body, p.contentType)) return null; // reported as served-as-html
      return issue('llms-txt.missing', `/llms.txt returned ${p.status}.`);
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.served-as-html',
      title: '/llms.txt returns an HTML page',
      why: 'A 200 response with an HTML page (usually a catch-all route or soft 404) tells tools an llms.txt exists when it does not, and they ingest your page template as if it were the file.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Either publish a real markdown llms.txt or make /llms.txt return 404.',
    }),
    (site) => {
      const p = probe(site, 'llms-txt');
      if (!p || p.found || !p.status || p.status >= 300 || !looksHtml(p.body, p.contentType))
        return null;
      return issue(
        'llms-txt.served-as-html',
        `/llms.txt returned ${p.status} with ${p.contentType || 'an HTML body'}.`,
        { evidence: (p.body ?? '').slice(0, 200) },
      );
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.no-h1',
      title: 'llms.txt does not start with an H1',
      why: 'The format requires one H1 with the project or site name as the first line; parsers use it as the document title.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Make the first line "# Your Company Name".',
    }),
    (site) => {
      const p = parsedOrNull(site);
      if (!p || p.firstIsH1) return null;
      return issue(
        'llms-txt.no-h1',
        p.title ? `The H1 "${p.title}" is not the first line.` : 'llms.txt has no H1 line.',
      );
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.multiple-h1',
      title: 'llms.txt has more than one H1',
      why: 'The format allows exactly one H1; extra ones are usually sections that should be H2, and parsers will not see them as sections.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Keep the first H1 and change the others to "## ".',
    }),
    (site) => {
      const p = parsedOrNull(site);
      return p && p.h1Count > 1
        ? issue('llms-txt.multiple-h1', `llms.txt has ${p.h1Count} H1 lines.`)
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.no-summary',
      title: 'llms.txt has no blockquote summary',
      why: 'The > summary under the title is what a model reads first to understand who you are. Without it, the file is a list of links with no context.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Add a line under the H1 such as "> Acme builds accounting software for UK sole traders."',
    }),
    (site) => {
      const p = parsedOrNull(site);
      return p && !p.summary
        ? issue('llms-txt.no-summary', 'No "> summary" line found before the first section.')
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.no-sections',
      title: 'llms.txt has no H2 sections',
      why: 'Sections are how the format groups links (## Docs, ## Services). Tools that expand llms.txt into context rely on them.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Group your links under "## " headings.',
    }),
    (site) => {
      const p = parsedOrNull(site);
      return p && !p.sections.length
        ? issue('llms-txt.no-sections', 'llms.txt has no "## " sections.')
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.no-links',
      title: 'llms.txt lists no links',
      why: 'The point of llms.txt is to point tools at your most useful pages. Without markdown links there is nothing to follow.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'List key pages as "- [Title](https://example.com/page): one-line description".',
    }),
    (site) => {
      const p = parsedOrNull(site);
      return p && !p.links.length
        ? issue('llms-txt.no-links', 'No markdown links found in list items.')
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.malformed-items',
      title: 'llms.txt list items are not markdown links',
      why: 'Inside sections the format expects "- [name](url): notes". Bare URLs or plain text items are skipped by parsers.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Rewrite each item as "- [Title](https://…): note".',
    }),
    (site) => {
      const p = parsedOrNull(site);
      if (!p?.nonLinkItems.length) return null;
      return issue(
        'llms-txt.malformed-items',
        `${plural(p.nonLinkItems.length, 'list item')} in sections are not markdown links.`,
        {
          evidence: ev(p.nonLinkItems.slice(0, 6).map((x) => `line ${x.line}: ${x.text}`)),
        },
      );
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.relative-links',
      title: 'llms.txt uses relative links',
      why: 'llms.txt is often copied into a prompt or another tool, where a relative link no longer resolves.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use absolute https:// URLs.',
    }),
    (site) => {
      const p = parsedOrNull(site);
      return p && p.relativeLinks
        ? issue(
            'llms-txt.relative-links',
            `${plural(p.relativeLinks, 'link')} ${vb(p.relativeLinks, 'is', 'are')} relative.`,
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.duplicate-links',
      title: 'llms.txt lists the same URL more than once',
      why: 'Duplicates waste the limited context a model gives the file and suggest it was generated without review.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Keep each URL once, in the section where it fits best.',
    }),
    (site) => {
      const p = parsedOrNull(site);
      if (!p) return null;
      const counts = new Map<string, number>();
      for (const l of p.links)
        counts.set(urlKey(l.abs ?? l.url), (counts.get(urlKey(l.abs ?? l.url)) ?? 0) + 1);
      const dups = [...counts.entries()].filter(([, n]) => n > 1);
      return dups.length
        ? issue(
            'llms-txt.duplicate-links',
            `${plural(dups.length, 'URL')} ${vb(dups.length, 'appears', 'appear')} more than once.`,
            { evidence: ev(dups.slice(0, 8).map(([u, n]) => `${u} ×${n}`)) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.empty-link-notes',
      title: 'Most llms.txt links have no description',
      why: 'The note after each link (": what this page covers") is how a model decides which link to open for a question. Bare titles force it to guess.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Add a short note after each link, for example "- [Pricing](https://…): plans, what each includes, and VAT".',
    }),
    (site) => {
      const p = parsedOrNull(site);
      if (!p || p.links.length < 3) return null;
      const bare = p.links.filter((l) => !l.note).length;
      return bare / p.links.length > 0.5
        ? issue('llms-txt.empty-link-notes', `${bare} of ${p.links.length} links have no note.`)
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.broken-links',
      title: 'llms.txt links to pages that fail',
      why: 'A tool following a broken link from llms.txt gets an error instead of your content, and the file loses credibility as a map.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Update or remove links that return 4xx/5xx or fail to load.',
    }),
    async (site) => {
      const bad = (await linkStatuses(site)).filter((s) => s.status === 0 || s.status >= 400);
      if (!bad.length) return null;
      return issue(
        'llms-txt.broken-links',
        `${plural(bad.length, 'link')} in llms.txt ${vb(bad.length, 'fails', 'fail')}.`,
        {
          evidence: ev(
            bad.map((b) => `${b.link.abs} → ${b.error ?? b.status} (line ${b.link.line})`),
          ),
          severity: bad.some((b) => sameSite(b.link.abs!, site.origin)) ? 'high' : 'medium',
        },
      );
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.redirecting-links',
      title: 'llms.txt links redirect',
      why: 'Each redirect costs a request and some tools do not follow them. Linking the final URL is cleaner.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Replace each redirecting link with the URL it ends up at.',
    }),
    async (site) => {
      const r = (await linkStatuses(site)).filter(
        (s) => s.redirected && s.status < 400 && s.status > 0,
      );
      return r.length
        ? issue(
            'llms-txt.redirecting-links',
            `${plural(r.length, 'link')} ${vb(r.length, 'redirects', 'redirect')}.`,
            { evidence: ev(r.map((x) => `${x.link.abs} → ${x.finalUrl}`)) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.links-not-indexable',
      title: 'llms.txt points to noindex or non-canonical pages',
      why: 'Sending AI tools to a page you have asked search engines not to index, or to a duplicate whose canonical is elsewhere, sends mixed signals about which URL represents the content.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Link the canonical, indexable URL of each page instead.',
    }),
    (site) => {
      const p = parsedOrNull(site);
      if (!p) return null;
      const hits: string[] = [];
      for (const l of p.links) {
        const page = pageFor(site, l.abs);
        if (!page || !page.isHtml) continue;
        if (isNoindex(page)) hits.push(`${l.abs}: noindex`);
        else if (canonicalElsewhere(page))
          hits.push(`${l.abs}: canonical is ${page.canonical ?? page.canonicalHeader}`);
      }
      return hits.length
        ? issue(
            'llms-txt.links-not-indexable',
            `${plural(hits.length, 'link')} ${vb(hits.length, 'points', 'point')} to noindex or non-canonical pages.`,
            { evidence: ev(hits) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.links-blocked-by-robots',
      title: 'llms.txt links to pages AI bots are disallowed from',
      why: 'Listing a page in llms.txt while robots.txt disallows AI crawlers from it is contradictory; compliant tools will not fetch it.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Either allow AI bots to fetch these pages or remove them from llms.txt.',
    }),
    (site) => {
      const p = parsedOrNull(site);
      if (!p || !robotsUsable(site)) return null;
      const tokens = ['OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'ChatGPT-User'].filter((t) =>
        botByToken(t),
      );
      const hits: string[] = [];
      for (const l of p.links) {
        if (!l.abs || !sameSite(l.abs, site.origin)) continue;
        const blocked = tokens.filter((t) => {
          try {
            // Path-level contradictions only; a whole-site block is reported by ai-crawlers.
            return (
              site.robots.isAllowed(l.abs!, t) === false &&
              site.robots.isAllowed(`${site.origin}/`, t) !== false
            );
          } catch {
            return false;
          }
        });
        if (blocked.length) hits.push(`${l.abs}: ${blocked.join(', ')}`);
      }
      return hits.length
        ? issue(
            'llms-txt.links-blocked-by-robots',
            `${plural(hits.length, 'listed page')} ${vb(hits.length, 'is', 'are')} disallowed for AI bots.`,
            { evidence: ev(hits) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.mostly-offsite',
      title: 'Most llms.txt links point to other sites',
      why: 'llms.txt should map your own content. A file that mostly links elsewhere tells tools little about you.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Lead with your own key pages; keep external links to the few that matter (docs hosted elsewhere, a GitHub repo).',
    }),
    (site) => {
      const p = parsedOrNull(site);
      if (!p || p.links.length < 4) return null;
      const off = p.links.filter((l) => l.abs && !sameSite(l.abs, site.origin)).length;
      return off / p.links.length > 0.5
        ? issue('llms-txt.mostly-offsite', `${off} of ${p.links.length} links are to other sites.`)
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.missing-key-pages',
      title: 'llms.txt leaves out key pages',
      why: 'The pages your own navigation links most are usually the ones people ask about. If llms.txt omits them, tools that rely on it never see them.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Add the missing pages to the relevant section with a one-line description each.',
    }),
    (site) => {
      const p = parsedOrNull(site);
      if (!p) return null;
      const listed = new Set(p.links.map((l) => urlKey(l.abs ?? l.url)));
      const keys = keyPages(site, 10);
      const missing = keys.filter((k) => !listed.has(urlKey(k)));
      if (!keys.length || missing.length / keys.length < 0.4) return null;
      return issue(
        'llms-txt.missing-key-pages',
        `${missing.length} of ${keys.length} key pages are not in llms.txt.`,
        { evidence: ev(missing), data: { missing } },
      );
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.key-pages-in-optional',
      title: 'Key pages listed under ## Optional',
      why: 'In the llms.txt format, the "Optional" section holds links a tool may skip when context is short. Core pages placed there are the first to be dropped.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Move core pages out of ## Optional into a main section.',
    }),
    (site) => {
      const p = parsedOrNull(site);
      if (!p) return null;
      const keys = new Set(keyPages(site, 10).map(urlKey));
      const hits = p.links.filter(
        (l) => /^optional$/i.test(l.section) && keys.has(urlKey(l.abs ?? l.url)),
      );
      return hits.length
        ? issue(
            'llms-txt.key-pages-in-optional',
            `${plural(hits.length, 'key page')} ${vb(hits.length, 'is', 'are')} in the Optional section.`,
            { evidence: ev(hits.map((h) => h.abs ?? h.url)) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.link-dump',
      title: 'llms.txt is too large to be useful',
      why: 'An llms.txt with hundreds of links or hundreds of kilobytes will not fit beside a question in a model’s context, which defeats its purpose as a short map.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Keep llms.txt to your key pages (tens of links). Put exhaustive lists in the sitemap and full content in llms-full.txt.',
    }),
    (site) => {
      const p = parsedOrNull(site);
      if (!p) return null;
      if (p.links.length > 300 || p.bytes > 200_000)
        return issue(
          'llms-txt.link-dump',
          `llms.txt has ${p.links.length} links and is ${Math.round(p.bytes / 1024)} KB.`,
        );
      return null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.too-thin',
      title: 'llms.txt lists very few pages',
      why: 'One or two links say little more than the home page does. The file earns its keep by pointing at the specific pages that answer common questions.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'List the pages people most need: services or products, pricing, about, contact, and your best guides.',
    }),
    (site) => {
      const p = parsedOrNull(site);
      if (!p || p.links.length === 0 || p.links.length >= 3) return null;
      return site.pages.size >= 10
        ? issue(
            'llms-txt.too-thin',
            `llms.txt lists ${plural(p.links.length, 'link')} for a site of ${site.pages.size} crawled URLs.`,
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.content-type',
      title: 'llms.txt served with an unexpected content type',
      why: 'Served as text/plain or text/markdown in UTF-8, the file displays and parses predictably. Other types (application/octet-stream, no charset) can be downloaded instead of read, or garble non-ASCII text.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Serve llms.txt as "text/plain; charset=utf-8" or "text/markdown; charset=utf-8".',
    }),
    (site) => {
      const p = found(site, 'llms-txt');
      if (!p) return null;
      const ct = (p.contentType ?? '').toLowerCase();
      if (/text\/(plain|markdown|x-markdown)/.test(ct) && /utf-?8/.test(ct)) return null;
      return issue(
        'llms-txt.content-type',
        `llms.txt is served as "${p.contentType || 'no content type'}".`,
      );
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.quality-grade',
      title: 'llms.txt quality below good',
      why: `A well-formed llms.txt is short, titled, summarised, sectioned and lists the right pages with notes. ${MATURITY}`,
      severity: 'low',
      fixTier: 'manual',
      fix: 'Work through the reasons listed with this finding, highest-weight first.',
    }),
    (site) => {
      const g = llmsTxtGrade(site);
      if (!g || g.grade >= 80) return null;
      return issue('llms-txt.quality-grade', `llms.txt scores ${g.grade}/100.`, {
        evidence: ev(g.reasons),
        data: { grade: g.grade, parts: g.parts, reasons: g.reasons },
      });
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.full-missing',
      title: 'No /llms-full.txt on a content-heavy site',
      why: 'llms-full.txt carries the full text of your key pages in one markdown file, which documentation tools and coding assistants load directly. It matters most for docs and knowledge sites.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Generate llms-full.txt from your content at build time (many docs generators and SEO plugins can).',
    }),
    (site) => {
      if (!found(site, 'llms-txt') || found(site, 'llms-full-txt') || !probe(site, 'llms-full-txt'))
        return null;
      const docsLike = [...site.pages.keys()].filter((u) =>
        /\/(docs?|documentation|guides?|api|reference|help|kb|learn)\//i.test(u),
      ).length;
      return docsLike >= 10
        ? issue(
            'llms-txt.full-missing',
            `The site has ${docsLike} documentation-style pages and no llms-full.txt.`,
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.full-too-large',
      title: 'llms-full.txt is very large',
      why: 'Above a few megabytes the file no longer fits any model’s context and many tools truncate or refuse it.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Split by product or section (for example /docs/llms-full.txt per area) and link each from llms.txt.',
    }),
    (site) => {
      const p = found(site, 'llms-full-txt');
      if (!p) return null;
      const truncated = p.headers?.['x-avc-truncated'] === '1';
      const bytes = p.bytes ?? 0;
      return truncated || bytes > 5 * 1024 * 1024
        ? issue(
            'llms-txt.full-too-large',
            `llms-full.txt is ${truncated ? 'over 2 MB (download was cut off)' : `${Math.round(bytes / 1024 / 1024)} MB`}.`,
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.full-stale',
      title: 'llms-full.txt is older than your content',
      why: 'A full-text export that lags your site feeds tools outdated facts, which then appear in their answers.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Regenerate llms-full.txt on every deploy or content change.',
    }),
    (site) => {
      const p = found(site, 'llms-full-txt');
      const lm = p?.headers?.['last-modified'];
      if (!p || !lm) return null;
      const fileDate = Date.parse(lm);
      let newest = 0;
      for (const s of site.sitemaps ?? [])
        for (const u of s.urls)
          if (u.lastmod) newest = Math.max(newest, Date.parse(u.lastmod) || 0);
      if (!fileDate || !newest) return null;
      const days = Math.round((newest - fileDate) / 86_400_000);
      return days > 90
        ? issue(
            'llms-txt.full-stale',
            `llms-full.txt was last modified ${days} days before your newest sitemap entry.`,
            { evidence: `Last-Modified: ${lm}` },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.full-is-html',
      title: '/llms-full.txt returns an HTML page',
      why: 'Tools that load llms-full.txt will ingest your page template instead of content.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Publish a real markdown file or make the URL return 404.',
    }),
    (site) => {
      const p = probe(site, 'llms-full-txt');
      return p && !p.found && p.status && p.status < 300 && looksHtml(p.body, p.contentType)
        ? issue('llms-txt.full-is-html', '/llms-full.txt returns an HTML page with a 2xx status.')
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'llms-txt.no-markdown-variants',
      title: 'Pages listed in llms.txt have no markdown versions',
      why: 'The llms.txt proposal suggests offering each page as markdown at the same URL plus .md, so tools can fetch clean text without HTML clutter. Optional, and useful mainly for docs.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Serve a markdown copy at <page>.md, or answer Accept: text/markdown with markdown.',
    }),
    (site) => {
      if (!found(site, 'llms-txt')) return null;
      const suffix = probe(site, 'md-suffix');
      const neg = probe(site, 'md-article') ?? probe(site, 'md-home');
      if (!suffix || suffix.found || neg?.found) return null;
      return issue(
        'llms-txt.no-markdown-variants',
        `No markdown variant at ${suffix.url} and no markdown response to Accept: text/markdown.`,
      );
    },
  ),
];

/** Test seam. */
export const _internal = { linkStatuses };
