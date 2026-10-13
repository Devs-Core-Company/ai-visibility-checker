/**
 * On-page basics: titles, meta descriptions, social tags, headings.
 */
import type { Issue, PageData, SiteContext } from '../core/types.js';
import {
  REF,
  STOP_WORDS,
  doc,
  groupBy,
  homePage,
  indexablePages,
  isIndexable,
  list,
  normText,
  pageCheck,
  plural,
  safeUrl,
  sameUrl,
  siteCheck,
  truncate,
  words,
} from './_util.js';

export const TITLE_MAX = 60;
export const TITLE_MIN = 20;
export const DESC_MAX = 160;
export const DESC_MIN = 70;
export const H1_MAX = 70;
export const SUBHEADING_MIN_WORDS = 600;
export const HEADING_DENSITY_MAX = 1 / 25; // headings per word, beyond which headings are styling
export const DUPLICATE_REPORT_LIMIT = 200;

const C = 'content' as const;

const GENERIC_TITLES =
  /^(home|homepage|home page|untitled|untitled document|new page|page|index|welcome|document|default|test|blog|my site|my website|my blog|my store|just another .* site)$/i;

function h1s(page: PageData) {
  return page.headings.filter((h) => h.level === 1);
}

function duplicateGroups(site: SiteContext, key: (p: PageData) => string | null) {
  const groups = groupBy(indexablePages(site), (p) => {
    const k = key(p);
    return k ? normText(k) : null;
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

function dupIssues(
  checkId: string,
  label: string,
  groups: PageData[][],
  value: (p: PageData) => string,
): Issue[] {
  const out: Issue[] = [];
  for (const g of groups) {
    for (const p of g) {
      const others = g.filter((o) => o !== p).map((o) => o.url);
      out.push({
        checkId,
        url: p.url,
        message: `Same ${label} as ${plural(others.length, 'other page')}`,
        evidence: truncate(`"${value(p)}" — also on ${list(others, 3)}`, 480),
        data: { group: g.length },
      });
      if (out.length >= DUPLICATE_REPORT_LIMIT) return out;
    }
  }
  return out;
}

function repeatedWord(text: string): [string, number] | null {
  const counts = new Map<string, number>();
  for (const w of words(text.toLowerCase())) {
    const c = w.replace(/[^\p{L}\p{N}]/gu, '');
    if (c.length < 3 || STOP_WORDS.has(c)) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= 3 ? top : null;
}

export const checks = [
  // -------------------------------------------------------------------------
  // Titles
  // -------------------------------------------------------------------------
  pageCheck(
    {
      id: 'onpage.title-missing',
      category: 'onpage',
      pillar: C,
      title: 'Missing or empty title',
      why: 'The title is the main label for the page in search results, browser tabs and AI citations. Without one, engines invent a title from other text.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Add a unique, descriptive <title> in <head> that names the page topic first and the brand last.',
      refs: [REF.titles],
    },
    (page) =>
      isIndexable(page) && !page.title?.trim()
        ? { checkId: 'onpage.title-missing', message: 'No <title> text on this page' }
        : null,
  ),
  pageCheck(
    {
      id: 'onpage.title-multiple',
      category: 'onpage',
      pillar: C,
      title: 'More than one title element',
      why: 'Several <title> tags (often one from the theme and one from a plugin) make it unclear which one search engines should use.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove the extra <title> so the page has exactly one, in <head>.',
      refs: [REF.titles],
    },
    (page) =>
      isIndexable(page) && page.titleCount > 1
        ? { checkId: 'onpage.title-multiple', message: `${page.titleCount} <title> elements` }
        : null,
  ),
  pageCheck(
    {
      id: 'onpage.title-too-long',
      category: 'onpage',
      pillar: C,
      title: 'Title is likely to be cut off',
      why: `Google shows roughly the first ${TITLE_MAX} characters (about 600 pixels). Longer titles are truncated or rewritten, so the end of the title is lost.`,
      severity: 'low',
      fixTier: 'manual',
      fix: `Keep the title under about ${TITLE_MAX} characters with the most important words first.`,
      refs: [REF.titles],
    },
    (page) => {
      const t = page.title?.trim();
      if (!isIndexable(page) || !t || t.length <= TITLE_MAX) return null;
      return {
        checkId: 'onpage.title-too-long',
        message: `Title is ${t.length} characters (aim for ${TITLE_MAX} or fewer)`,
        evidence: t,
      };
    },
  ),
  pageCheck(
    {
      id: 'onpage.title-too-short',
      category: 'onpage',
      pillar: C,
      title: 'Title is very short',
      why: 'A very short title rarely describes the page well enough to win the click or to tell an AI engine what the page covers.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Expand the title to describe the page specifically, for example "Service in City | Brand".',
      refs: [REF.titles],
    },
    (page) => {
      const t = page.title?.trim();
      if (!isIndexable(page) || !t || t.length >= TITLE_MIN || GENERIC_TITLES.test(t)) return null;
      return {
        checkId: 'onpage.title-too-short',
        message: `Title is ${t.length} characters`,
        evidence: t,
      };
    },
  ),
  pageCheck(
    {
      id: 'onpage.title-generic',
      category: 'onpage',
      pillar: C,
      title: 'Generic or placeholder title',
      why: 'Titles such as "Home", "Untitled" or "Just another WordPress site" say nothing about the page and are often rewritten by Google.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Replace it with a title that names what the page offers and who it is for.',
      refs: [REF.titles],
    },
    (page) => {
      const t = page.title?.trim();
      if (!isIndexable(page) || !t) return null;
      const core = t.split(/\s[|\-–—:·]\s/)[0].trim();
      if (!GENERIC_TITLES.test(t) && !GENERIC_TITLES.test(core)) return null;
      return {
        checkId: 'onpage.title-generic',
        message: `Title "${truncate(t, 80)}" is generic`,
        evidence: t,
      };
    },
  ),
  pageCheck(
    {
      id: 'onpage.title-repeated-words',
      category: 'onpage',
      pillar: C,
      title: 'Title repeats the same word',
      why: 'Repeating a keyword in the title reads as spammy, and Google rewrites keyword-stuffed titles.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Use the main term once and describe the page in natural language.',
      refs: [REF.titles],
    },
    (page) => {
      const t = page.title?.trim();
      if (!isIndexable(page) || !t) return null;
      const r = repeatedWord(t);
      if (!r) return null;
      return {
        checkId: 'onpage.title-repeated-words',
        message: `"${r[0]}" appears ${r[1]} times in the title`,
        evidence: t,
      };
    },
  ),
  pageCheck(
    {
      id: 'onpage.title-all-caps',
      category: 'onpage',
      pillar: C,
      title: 'Title written in capitals',
      why: 'All-caps titles are harder to read and look like shouting in results. Google may rewrite them.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Use sentence case or title case.',
    },
    (page) => {
      const t = page.title?.trim() || '';
      const letters = t.replace(/[^A-Za-z]/g, '');
      if (!isIndexable(page) || letters.length < 12 || letters !== letters.toUpperCase())
        return null;
      return { checkId: 'onpage.title-all-caps', message: 'Title is all upper case', evidence: t };
    },
  ),
  pageCheck(
    {
      id: 'onpage.title-h1-mismatch',
      category: 'onpage',
      pillar: C,
      title: 'Title and H1 share no words',
      why: 'When the title and main heading describe different things, Google is more likely to rewrite the title and readers are less sure they landed in the right place.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Make the title and H1 describe the same topic, even if worded differently.',
      refs: [REF.titles],
    },
    (page) => {
      const t = page.title?.trim();
      const h = h1s(page)[0]?.text?.trim();
      if (!isIndexable(page) || !t || !h) return null;
      const sig = (s: string) =>
        new Set(
          words(s.toLowerCase())
            .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
            .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
        );
      const a = sig(t);
      const b = sig(h);
      if (a.size < 2 || b.size < 2) return null;
      for (const w of b) if (a.has(w)) return null;
      return {
        checkId: 'onpage.title-h1-mismatch',
        message: 'The title and H1 have no meaningful words in common',
        evidence: `title: ${truncate(t, 80)} | h1: ${truncate(h, 80)}`,
      };
    },
  ),
  siteCheck(
    {
      id: 'onpage.title-duplicate',
      category: 'onpage',
      pillar: C,
      title: 'Duplicate titles',
      why: 'Pages with the same title look like duplicates. Search engines struggle to pick which one to show and the pages compete with each other.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Give every indexable page a unique title that reflects its own content (include the page number or variant where relevant).',
      refs: [REF.titles],
    },
    (site) =>
      dupIssues(
        'onpage.title-duplicate',
        'title',
        duplicateGroups(site, (p) => p.title),
        (p) => p.title || '',
      ),
  ),

  // -------------------------------------------------------------------------
  // Meta description
  // -------------------------------------------------------------------------
  pageCheck(
    {
      id: 'onpage.description-missing',
      category: 'onpage',
      pillar: C,
      title: 'Missing meta description',
      why: 'Without a description, search engines pick a snippet from the page that may not sell the click. Many AI tools also read it as the page summary.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Write a unique meta description of about 120 to 160 characters that summarises the page and its main benefit.',
      refs: [REF.snippets],
    },
    (page) =>
      isIndexable(page) && !page.metaDescription?.trim()
        ? { checkId: 'onpage.description-missing', message: 'No meta description' }
        : null,
  ),
  pageCheck(
    {
      id: 'onpage.description-multiple',
      category: 'onpage',
      pillar: C,
      title: 'More than one meta description',
      why: 'Duplicate description tags (often theme plus plugin) mean the one you edit may not be the one shown.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Remove the extra tag so there is one meta description in <head>.',
      refs: [REF.snippets],
    },
    (page) =>
      isIndexable(page) && page.metaDescriptionCount > 1
        ? {
            checkId: 'onpage.description-multiple',
            message: `${page.metaDescriptionCount} meta description tags`,
          }
        : null,
  ),
  pageCheck(
    {
      id: 'onpage.description-too-long',
      category: 'onpage',
      pillar: C,
      title: 'Meta description likely to be cut off',
      why: `Snippets are trimmed to around ${DESC_MAX} characters on desktop and less on mobile, so the end of a long description is lost.`,
      severity: 'low',
      fixTier: 'manual',
      fix: `Keep the description under about ${DESC_MAX} characters and put the key message first.`,
      refs: [REF.snippets],
    },
    (page) => {
      const d = page.metaDescription?.trim();
      if (!isIndexable(page) || !d || d.length <= DESC_MAX) return null;
      return {
        checkId: 'onpage.description-too-long',
        message: `Description is ${d.length} characters`,
        evidence: truncate(d, 300),
      };
    },
  ),
  pageCheck(
    {
      id: 'onpage.description-too-short',
      category: 'onpage',
      pillar: C,
      title: 'Meta description is very short',
      why: 'A very short description gives searchers and AI summaries little reason to choose the page and is often replaced by page text.',
      severity: 'low',
      fixTier: 'manual',
      fix: `Expand it to at least ${DESC_MIN} characters: what the page offers, for whom, and why it is worth a click.`,
      refs: [REF.snippets],
    },
    (page) => {
      const d = page.metaDescription?.trim();
      if (!isIndexable(page) || !d || d.length >= DESC_MIN) return null;
      return {
        checkId: 'onpage.description-too-short',
        message: `Description is ${d.length} characters`,
        evidence: d,
      };
    },
  ),
  pageCheck(
    {
      id: 'onpage.description-same-as-title',
      category: 'onpage',
      pillar: C,
      title: 'Meta description repeats the title',
      why: 'A description that only repeats the title wastes the snippet space that could explain the page.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Write a description that adds detail beyond the title.',
    },
    (page) => {
      if (!isIndexable(page) || !page.metaDescription || !page.title) return null;
      if (normText(page.metaDescription) !== normText(page.title)) return null;
      return {
        checkId: 'onpage.description-same-as-title',
        message: 'Description is identical to the title',
        evidence: page.title,
      };
    },
  ),
  pageCheck(
    {
      id: 'onpage.description-placeholder',
      category: 'onpage',
      pillar: C,
      title: 'Placeholder meta description',
      why: 'Default descriptions left by a theme or CMS appear in search results and AI summaries and make the site look unfinished.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Replace the placeholder with a description written for this page.',
    },
    (page) => {
      const d = page.metaDescription?.trim() || '';
      if (!isIndexable(page) || !d) return null;
      if (
        !/(just another (wordpress|word press) site|lorem ipsum|^description$|^meta description$|add a description|your (site|website|store) description|this is (my|the) (site|website|description))/i.test(
          d,
        )
      )
        return null;
      return {
        checkId: 'onpage.description-placeholder',
        message: 'Description looks like a placeholder',
        evidence: truncate(d),
      };
    },
  ),
  siteCheck(
    {
      id: 'onpage.description-duplicate',
      category: 'onpage',
      pillar: C,
      title: 'Duplicate meta descriptions',
      why: 'Repeated descriptions make pages look interchangeable in results and are usually ignored in favour of page text.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Write a unique description for each indexable page, or leave it out on pages where a template would only repeat itself.',
      refs: [REF.snippets],
    },
    (site) =>
      dupIssues(
        'onpage.description-duplicate',
        'meta description',
        duplicateGroups(site, (p) => p.metaDescription),
        (p) => p.metaDescription || '',
      ),
  ),
  pageCheck(
    {
      id: 'onpage.meta-keywords',
      category: 'onpage',
      pillar: C,
      title: 'Meta keywords tag present',
      why: 'Google and Bing ignore meta keywords for ranking. The tag only shows competitors which terms you target.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Remove the meta keywords tag.',
      refs: [
        'https://developers.google.com/search/blog/2009/09/google-does-not-use-keywords-meta-tag',
      ],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const m = /<meta[^>]+name=["']?keywords["']?[^>]*>/i.exec(page.html || '');
      return m
        ? {
            checkId: 'onpage.meta-keywords',
            message: 'Page has a meta keywords tag',
            evidence: truncate(m[0]),
          }
        : null;
    },
  ),

  // -------------------------------------------------------------------------
  // Social / Open Graph
  // -------------------------------------------------------------------------
  pageCheck(
    {
      id: 'onpage.og-missing',
      category: 'onpage',
      pillar: C,
      title: 'Open Graph tags missing',
      why: 'og:title, og:description and og:image control how the page looks when shared on LinkedIn, Slack, WhatsApp and in some AI chat link previews.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add og:title, og:description, og:image (absolute URL, at least 1200×630) and og:url to the page template.',
      refs: ['https://ogp.me/'],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const missing = ['og:title', 'og:description', 'og:image'].filter((k) => !page.og[k]);
      if (!missing.length) return null;
      return { checkId: 'onpage.og-missing', message: `Missing ${list(missing)}` };
    },
  ),
  pageCheck(
    {
      id: 'onpage.og-image-invalid',
      category: 'onpage',
      pillar: C,
      title: 'og:image is not an absolute URL',
      why: 'Social platforms do not resolve relative paths in og:image, so no preview image is shown.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use a full https:// URL for og:image.',
      refs: ['https://ogp.me/'],
    },
    (page) => {
      const img = page.og['og:image'];
      if (!isIndexable(page) || !img || /^https?:\/\//i.test(img)) return null;
      return {
        checkId: 'onpage.og-image-invalid',
        message: 'og:image is relative or malformed',
        evidence: truncate(img),
      };
    },
  ),
  pageCheck(
    {
      id: 'onpage.og-url-mismatch',
      category: 'onpage',
      pillar: C,
      title: 'og:url differs from the canonical',
      why: 'Shares are counted against og:url. When it disagrees with the canonical, signals are split and the wrong URL may be shared.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Set og:url to the same URL as the canonical tag.',
    },
    (page) => {
      const og = page.og['og:url'];
      const canon = page.canonical;
      if (!isIndexable(page) || !og || !canon || !/^https?:/i.test(og) || sameUrl(og, canon))
        return null;
      return {
        checkId: 'onpage.og-url-mismatch',
        message: 'og:url and canonical point to different URLs',
        evidence: `og:url ${og} | canonical ${canon}`,
      };
    },
  ),
  pageCheck(
    {
      id: 'onpage.twitter-card-missing',
      category: 'onpage',
      pillar: C,
      title: 'No Twitter/X card type',
      why: 'Without twitter:card, X shows a plain link (it falls back to Open Graph for text but needs the card type for a large image).',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add <meta name="twitter:card" content="summary_large_image">.',
      refs: ['https://developer.x.com/en/docs/x-for-websites/cards/overview/markup'],
    },
    (page) =>
      isIndexable(page) && !page.twitter['twitter:card'] && page.og['og:image']
        ? { checkId: 'onpage.twitter-card-missing', message: 'No twitter:card meta tag' }
        : null,
  ),
  siteCheck(
    {
      id: 'onpage.favicon-missing',
      category: 'onpage',
      pillar: C,
      title: 'No favicon declared',
      why: 'Google shows the favicon next to your result on mobile and desktop, and AI tools show it next to citations. Without one, a generic icon appears.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add <link rel="icon" href="/favicon.png"> (a square image, at least 48×48) to the home page.',
      refs: ['https://developers.google.com/search/docs/appearance/favicon-in-search'],
    },
    (site) => {
      const home = homePage(site);
      if (!home || home.status !== 200 || home.favicon) return null;
      return {
        checkId: 'onpage.favicon-missing',
        url: home.url,
        message: 'The home page does not declare a favicon',
      };
    },
  ),

  // -------------------------------------------------------------------------
  // Headings
  // -------------------------------------------------------------------------
  pageCheck(
    {
      id: 'headings.h1-missing',
      category: 'headings',
      pillar: C,
      title: 'No H1 heading',
      why: 'The H1 tells readers, assistive technology and AI extractors what the page is about. Pages without one are harder to summarise correctly.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add one visible <h1> that states the page topic.',
      refs: ['https://www.w3.org/WAI/tutorials/page-structure/headings/'],
    },
    (page) =>
      isIndexable(page) && h1s(page).length === 0
        ? { checkId: 'headings.h1-missing', message: 'Page has no <h1>' }
        : null,
  ),
  pageCheck(
    {
      id: 'headings.h1-empty',
      category: 'headings',
      pillar: C,
      title: 'Empty H1',
      why: 'An empty H1 (often a logo wrapper with no text) gives the page no main heading at all.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Put real text in the H1, or use a different element for the logo.',
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const list1 = h1s(page);
      if (!list1.length || list1.some((h) => h.text.trim())) return null;
      return { checkId: 'headings.h1-empty', message: 'The H1 has no text' };
    },
  ),
  pageCheck(
    {
      id: 'headings.h1-multiple',
      category: 'headings',
      pillar: C,
      title: 'Several H1 headings',
      why: 'Several H1s blur which topic is the main one. It is allowed, but one clear H1 makes the outline easier for people and parsers.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Keep one H1 for the page topic and turn the others into H2s.',
    },
    (page) => {
      const list1 = h1s(page).filter((h) => h.text.trim());
      if (!isIndexable(page) || list1.length < 2) return null;
      return {
        checkId: 'headings.h1-multiple',
        message: `${list1.length} H1 headings`,
        evidence: truncate(list1.map((h) => h.text).join(' | ')),
      };
    },
  ),
  pageCheck(
    {
      id: 'headings.h1-too-long',
      category: 'headings',
      pillar: C,
      title: 'H1 is very long',
      why: 'A long H1 is usually a paragraph styled as a heading, which weakens the page outline.',
      severity: 'low',
      fixTier: 'manual',
      fix: `Shorten the H1 to under about ${H1_MAX} characters and move the rest into a paragraph.`,
    },
    (page) => {
      const h = h1s(page)[0]?.text.trim();
      if (!isIndexable(page) || !h || h.length <= H1_MAX) return null;
      return {
        checkId: 'headings.h1-too-long',
        message: `H1 is ${h.length} characters`,
        evidence: truncate(h),
      };
    },
  ),
  pageCheck(
    {
      id: 'headings.h1-image-only',
      category: 'headings',
      pillar: C,
      title: 'H1 contains only an image',
      why: 'An H1 that is just an image relies on alt text for its meaning. Many crawlers and AI extractors read it as empty.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use real text in the H1. Keep the logo outside it, or add visually styled text.',
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const el = doc(page).querySelector('h1');
      if (!el || (el.textContent || '').trim() || !el.querySelector('img, svg')) return null;
      return {
        checkId: 'headings.h1-image-only',
        message: 'The H1 wraps an image and has no text of its own',
      };
    },
  ),
  pageCheck(
    {
      id: 'headings.not-first',
      category: 'headings',
      pillar: C,
      title: 'Content headings appear before the H1',
      why: 'When H2s or H3s come before the H1 (often in sidebars or promos), the outline that screen readers and AI parsers see starts in the wrong place.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Put the H1 first in the main content; use non-heading elements for promos and widgets above it.',
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const i = page.headings.findIndex((h) => h.level === 1);
      if (i <= 0) return null;
      const before = page.headings.slice(0, i).filter((h) => h.text.trim());
      if (before.length < 2) return null; // a single site-name heading is common and harmless
      return {
        checkId: 'headings.not-first',
        message: `${before.length} headings appear before the H1`,
        evidence: truncate(before.map((h) => `H${h.level} ${h.text}`).join(' | ')),
      };
    },
  ),
  pageCheck(
    {
      id: 'headings.skipped-level',
      category: 'headings',
      pillar: C,
      title: 'Heading levels are skipped',
      why: 'Jumping from H2 to H4 breaks the outline used by screen readers and by tools that split pages into sections for AI answers.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use heading levels in order (H1, then H2, then H3) and style them with CSS rather than picking a level for its size.',
      refs: ['https://www.w3.org/WAI/tutorials/page-structure/headings/'],
      tags: ['wcag-1.3.1'],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const jumps: string[] = [];
      let prev = 0;
      for (const h of page.headings) {
        if (prev && h.level > prev + 1)
          jumps.push(`H${prev}→H${h.level} ("${truncate(h.text, 40)}")`);
        prev = h.level;
      }
      if (!jumps.length) return null;
      return {
        checkId: 'headings.skipped-level',
        message: `${plural(jumps.length, 'skipped heading level')}`,
        evidence: list(jumps, 3),
      };
    },
  ),
  pageCheck(
    {
      id: 'headings.empty',
      category: 'headings',
      pillar: C,
      title: 'Empty headings',
      why: 'Empty heading tags are announced by screen readers as blank headings and add noise to the outline.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Remove empty heading tags or give them text.',
      tags: ['wcag-2.4.6'],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const empty = page.headings.filter((h) => h.level > 1 && !h.text.trim());
      return empty.length
        ? {
            checkId: 'headings.empty',
            message: `${plural(empty.length, 'empty heading')} (${[...new Set(empty.map((h) => 'H' + h.level))].join(', ')})`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'headings.no-subheadings',
      category: 'headings',
      pillar: C,
      title: 'Long page without subheadings',
      why: 'Long text without H2s is hard to scan. Search and AI engines use subheadings to find the passage that answers a question.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Break the content into sections with descriptive H2s, ideally phrased the way people ask about the topic.',
      tags: ['aeo'],
    },
    (page) => {
      if (!isIndexable(page) || page.wordCount < SUBHEADING_MIN_WORDS) return null;
      if (page.headings.some((h) => h.level >= 2 && h.level <= 3 && h.text.trim())) return null;
      return {
        checkId: 'headings.no-subheadings',
        message: `${page.wordCount} words with no H2 or H3`,
      };
    },
  ),
  pageCheck(
    {
      id: 'headings.duplicate-in-page',
      category: 'headings',
      pillar: C,
      title: 'Same subheading repeated on a page',
      why: 'Identical subheadings make sections indistinguishable in the outline and in jump links.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Make each subheading describe its own section.',
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const g = groupBy(
        page.headings.filter((h) => h.level >= 2 && h.text.trim().length > 3),
        (h) => `${h.level}:${normText(h.text)}`,
      );
      const dups = [...g.values()].filter((x) => x.length > 1);
      if (!dups.length) return null;
      return {
        checkId: 'headings.duplicate-in-page',
        message: `${plural(dups.length, 'heading')} repeated`,
        evidence: list(
          dups.map((d) => `H${d[0].level} "${truncate(d[0].text, 40)}" ×${d.length}`),
          3,
        ),
      };
    },
  ),
  pageCheck(
    {
      id: 'headings.overused',
      category: 'headings',
      pillar: C,
      title: 'Headings used for styling',
      why: 'When nearly every line is a heading, the outline stops meaning anything to screen readers and content parsers.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use headings only for section titles. Style other text with CSS classes.',
    },
    (page) => {
      if (!isIndexable(page) || page.headings.length < 15 || page.wordCount < 100) return null;
      if (page.headings.length / page.wordCount <= HEADING_DENSITY_MAX) return null;
      return {
        checkId: 'headings.overused',
        message: `${page.headings.length} headings for ${page.wordCount} words`,
      };
    },
  ),
  siteCheck(
    {
      id: 'headings.h1-duplicate',
      category: 'headings',
      pillar: C,
      title: 'Duplicate H1 across pages',
      why: 'Pages with the same H1 look like they cover the same topic and can compete for the same searches.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Give each page an H1 that names its specific topic.',
    },
    (site) =>
      dupIssues(
        'headings.h1-duplicate',
        'H1',
        duplicateGroups(site, (p) => {
          const h = h1s(p)[0]?.text;
          // Paginated series share an H1 on purpose.
          return h && !safeUrl(p.url)?.search ? h : null;
        }),
        (p) => h1s(p)[0]?.text || '',
      ),
  ),
];
