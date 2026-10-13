/**
 * Content quality and duplication.
 */
import type { Issue, PageData } from '../core/types.js';
import {
  CURRENT_YEAR,
  ISO_DATE,
  REF,
  STOP_WORDS,
  doc,
  fleschReadingEase,
  groupBy,
  indexablePages,
  isArticleLike,
  isEnglish,
  isHomepage,
  isIndexable,
  list,
  nodesOfType,
  normText,
  pageCheck,
  pageNumber,
  plural,
  safeUrl,
  sentences,
  simhashDistance,
  siteCheck,
  str,
  truncate,
  urlKey,
  words,
} from './_util.js';
import * as cu from './_util.js';

export const THIN_WORDS = 200;
export const VERY_THIN_WORDS = 50;
export const TEXT_HTML_RATIO_MIN = 0.05;
export const TEXT_HTML_MIN_HTML_BYTES = 50_000;
export const STUFFING_MIN_WORDS = 300;
export const STUFFING_DENSITY = 0.04;
export const STUFFING_MIN_COUNT = 15;
export const FLESCH_HARD = 30;
export const AVG_SENTENCE_WORDS_MAX = 25;
export const PARAGRAPH_WORDS_MAX = 150;
export const BOILERPLATE_MAIN_SHARE = 0.25;
export const STALE_ARTICLE_YEARS = 2;
export const NEAR_DUP_DISTANCE = 3;
export const NEAR_DUP_MIN_WORDS = 100;
export const NEAR_DUP_MAX_PAGES = 3000;
export const SHARED_LEAD_MIN_PAGES = 5;
export const DUPLICATE_REPORT_LIMIT = 200;

const C = 'content' as const;

const LOREM = /\blorem ipsum\b|\bdolor sit amet\b|\bconsectetur adipiscing\b/i;
const PLACEHOLDER =
  /\b(coming soon|under construction|insert (text|content|image) here|your (text|content|title|company name) here|sample page|placeholder text|add your (text|content) here|this is a sample)\b|\[(insert|add|your)[^\]]{0,30}\]|\bTODO:|\bTBD\b|\bxxx+\b/i;
const TEMPLATE_LEAK =
  /\{\{\s*[\w.$[\]'"-]+\s*\}\}|\{%\s*\w+|<\?php|\$\{[\w.]+\}|\[object Object\]|\bundefined undefined\b|\b(?:NaN|null null)\b|%%[a-z_]+%%|\[\/?(vc_|et_pb_|fusion_|av_)[a-z_]*[^\]]*\]/;
const MOJIBAKE = /Ã[\u0080-¿¡-¿]|â€[™œ\u009d"“”˜¦]|Â[ -¿ ]|�/;
const DOUBLE_ESCAPED = /&amp;(amp|lt|gt|quot|#\d+|nbsp|[a-z]+);/i;
const COPYRIGHT_YEAR = /(?:©|&copy;|\(c\)|copyright)\s*(?:\d{4}\s*[-–—]\s*)?(\d{4})/gi;

function visible(page: PageData): string {
  return page.text || '';
}

function articleDates(page: PageData): { published: string | null; modified: string | null } {
  const nodes = nodesOfType(page, [
    'Article',
    'BlogPosting',
    'NewsArticle',
    'TechArticle',
    'WebPage',
  ]);
  let published = page.og['article:published_time'] || null;
  let modified = page.og['article:modified_time'] || page.og['og:updated_time'] || null;
  for (const n of nodes) {
    published ??= str(n.datePublished);
    modified ??= str(n.dateModified);
  }
  return { published, modified };
}

function topTerm(text: string): { term: string; count: number; total: number } | null {
  const ws = words(text.toLowerCase())
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ''))
    .filter(Boolean);
  if (ws.length < STUFFING_MIN_WORDS) return null;
  const counts = new Map<string, number>();
  for (const w of ws) {
    if (w.length < 4 || STOP_WORDS.has(w) || /^\d+$/.test(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const [term, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  return term ? { term, count, total: ws.length } : null;
}

function brandWords(page: PageData): Set<string> {
  const s = new Set<string>();
  const host =
    safeUrl(page.url)
      ?.hostname.replace(/^www\./, '')
      .split('.')[0] ?? '';
  if (host) s.add(host.toLowerCase());
  for (const w of words((page.og['og:site_name'] || '').toLowerCase())) s.add(w);
  return s;
}

export const checks = [
  pageCheck(
    {
      id: 'content.thin',
      category: 'content',
      pillar: C,
      title: 'Thin content',
      why: 'Pages with very little text rarely answer a question fully, so search engines rank them poorly and AI engines have nothing worth quoting.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Add useful, original detail (what, who for, how, price, proof, FAQs), merge the page with a related one, or noindex it if it only exists for navigation.',
      refs: [REF.helpfulContent],
    },
    (page, site) => {
      if (!isIndexable(page) || isHomepage(page, site) || pageNumber(page.url) != null) return null;
      if (page.wordCount >= THIN_WORDS) return null;
      if (/\/(contact|login|signin|sign-in|cart|checkout|search)\b/i.test(page.url)) return null;
      return {
        checkId: 'content.thin',
        severity: page.wordCount < VERY_THIN_WORDS ? 'high' : 'medium',
        message: `${page.wordCount} words of main text (aim for at least ${THIN_WORDS} on indexable pages)`,
        data: { words: page.wordCount },
      };
    },
  ),
  pageCheck(
    {
      id: 'content.low-text-ratio',
      category: 'content',
      pillar: C,
      title: 'Very little text for a heavy page',
      why: 'A large HTML document with little readable text is mostly code. It is slower to crawl and gives parsers more noise to wade through to find the content.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Move inline scripts, styles and data into cached files, trim unused markup and make sure the main content is in the HTML.',
    },
    (page) => {
      if (!isIndexable(page) || page.bytes < TEXT_HTML_MIN_HTML_BYTES) return null;
      const ratio = Buffer.byteLength(visible(page)) / page.bytes;
      if (ratio >= TEXT_HTML_RATIO_MIN) return null;
      return {
        checkId: 'content.low-text-ratio',
        message: `Text is ${(ratio * 100).toFixed(1)}% of a ${Math.round(page.bytes / 1024)} KB HTML document`,
      };
    },
  ),
  pageCheck(
    {
      id: 'content.lorem-ipsum',
      category: 'content',
      pillar: C,
      title: 'Lorem ipsum text on the page',
      why: 'Dummy text in production makes the page look unfinished to visitors and low quality to search engines, and it can end up quoted in AI answers.',
      severity: 'high',
      fixTier: 'manual',
      fix: 'Replace the dummy text with real content or remove the section.',
      refs: [REF.helpfulContent],
    },
    (page) => {
      if (!page.isHtml || page.status !== 200) return null;
      const m = LOREM.exec(visible(page));
      if (!m) return null;
      const i = m.index;
      return {
        checkId: 'content.lorem-ipsum',
        message: 'Placeholder Latin text found',
        evidence: truncate(visible(page).slice(Math.max(0, i - 40), i + 80)),
      };
    },
  ),
  pageCheck(
    {
      id: 'content.placeholder',
      category: 'content',
      pillar: C,
      title: 'Placeholder or unfinished text',
      why: 'Phrases such as "coming soon", "[insert text]" or "TODO" signal an unfinished page to readers and quality systems.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Finish the content or remove the placeholder. Keep unfinished pages noindex until they are ready.',
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const t = visible(page);
      const m = PLACEHOLDER.exec(t);
      if (!m) return null;
      return {
        checkId: 'content.placeholder',
        message: `Found "${m[0]}"`,
        evidence: truncate(t.slice(Math.max(0, m.index - 40), m.index + 80)),
      };
    },
  ),
  pageCheck(
    {
      id: 'content.template-leak',
      category: 'content',
      pillar: C,
      title: 'Template code or broken values shown as text',
      why: 'Visible "{{ variable }}", "[object Object]", "undefined" or raw page-builder shortcodes mean a template failed. Crawlers index the broken text as content.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Fix the template or data that produces the raw code, and make sure server-side rendering fills every value.',
    },
    (page) => {
      if (!page.isHtml || page.status !== 200) return null;
      const t = visible(page);
      const m = TEMPLATE_LEAK.exec(t);
      if (!m) return null;
      return {
        checkId: 'content.template-leak',
        message: `Visible text contains "${truncate(m[0], 40)}"`,
        evidence: truncate(t.slice(Math.max(0, m.index - 40), m.index + 80)),
      };
    },
  ),
  pageCheck(
    {
      id: 'content.broken-encoding',
      category: 'content',
      pillar: C,
      title: 'Garbled characters (encoding errors)',
      why: 'Sequences like "Ã©" or "â€™" come from text saved in one encoding and served as another. They look broken and corrupt quotes in search snippets and AI answers.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Store and serve everything as UTF-8 (database, files and the Content-Type header), then correct the affected text.',
    },
    (page) => {
      if (!page.isHtml || page.status !== 200) return null;
      const t = [page.title || '', page.metaDescription || '', visible(page)].join(' ');
      const m = MOJIBAKE.exec(t);
      if (!m) return null;
      return {
        checkId: 'content.broken-encoding',
        message: 'Text contains garbled character sequences',
        evidence: truncate(t.slice(Math.max(0, m.index - 30), m.index + 50)),
      };
    },
  ),
  pageCheck(
    {
      id: 'content.double-escaped',
      category: 'content',
      pillar: C,
      title: 'Double-escaped HTML entities in text',
      why: 'Text such as "&amp;amp;" or "&amp;#8217;" shows raw entity code to readers and in snippets.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Escape text once. Look for a template or plugin that encodes already-encoded values.',
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const t = [page.title || '', page.metaDescription || '', visible(page)].join(' ');
      const m = DOUBLE_ESCAPED.exec(t);
      return m
        ? {
            checkId: 'content.double-escaped',
            message: `Found "${m[0]}" in visible text`,
            evidence: truncate(t.slice(Math.max(0, m.index - 30), m.index + 50)),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'content.keyword-stuffing',
      category: 'content',
      pillar: C,
      title: 'One word is repeated unnaturally often',
      why: 'Repeating a term far more than natural writing would is a spam signal for search engines and makes the text worse for readers and AI summaries.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Rewrite the text naturally. Use the term where it fits and cover related subtopics instead of repeating it.',
      refs: [REF.spam],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const t = topTerm(page.mainText || visible(page));
      if (!t || t.count < STUFFING_MIN_COUNT || t.count / t.total < STUFFING_DENSITY) return null;
      if (brandWords(page).has(t.term)) return null;
      return {
        checkId: 'content.keyword-stuffing',
        message: `"${t.term}" is ${((100 * t.count) / t.total).toFixed(1)}% of all words (${t.count} of ${t.total})`,
        data: { term: t.term, count: t.count },
      };
    },
  ),
  pageCheck(
    {
      id: 'content.hard-to-read',
      category: 'content',
      pillar: C,
      title: 'Text is hard to read',
      why: 'Dense text with long words and sentences is harder to follow. Clear, plain writing is easier to quote accurately in AI answers.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Use shorter sentences, everyday words and one idea per paragraph. Define technical terms once.',
      tags: ['readability'],
    },
    (page) => {
      if (!isIndexable(page) || !isEnglish(page)) return null;
      const score = fleschReadingEase(page.mainText || visible(page));
      if (score == null || score >= FLESCH_HARD) return null;
      return {
        checkId: 'content.hard-to-read',
        message: `Flesch reading ease ${Math.round(score)} (below ${FLESCH_HARD} is very difficult)`,
        data: { flesch: Math.round(score) },
      };
    },
  ),
  pageCheck(
    {
      id: 'content.long-sentences',
      category: 'content',
      pillar: C,
      title: 'Sentences are long on average',
      why: 'Long sentences are harder to scan and harder to lift out as a self-contained answer.',
      severity: 'low',
      fixTier: 'manual',
      fix: `Aim for an average under ${AVG_SENTENCE_WORDS_MAX} words per sentence. Split sentences joined with "and", "which" or semicolons.`,
      tags: ['readability'],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const s = sentences(page.mainText || visible(page));
      if (s.length < 8) return null;
      const avg = s.reduce((n, x) => n + words(x).length, 0) / s.length;
      if (avg <= AVG_SENTENCE_WORDS_MAX) return null;
      return {
        checkId: 'content.long-sentences',
        message: `Average sentence is ${Math.round(avg)} words`,
      };
    },
  ),
  pageCheck(
    {
      id: 'content.long-paragraphs',
      category: 'content',
      pillar: C,
      title: 'Very long paragraphs',
      why: 'Walls of text are skipped on screens, especially on mobile, and are harder for AI engines to split into answerable passages.',
      severity: 'low',
      fixTier: 'manual',
      fix: `Break paragraphs longer than ${PARAGRAPH_WORDS_MAX} words into shorter ones, or use lists for steps and options.`,
      tags: ['readability'],
    },
    (page) => {
      if (!isIndexable(page) || page.wordCount < PARAGRAPH_WORDS_MAX) return null;
      const long = Array.from(doc(page).querySelectorAll('p')).filter(
        (p) => words(p.textContent || '').length > PARAGRAPH_WORDS_MAX,
      );
      if (!long.length) return null;
      return {
        checkId: 'content.long-paragraphs',
        message: `${plural(long.length, 'paragraph')} over ${PARAGRAPH_WORDS_MAX} words`,
        evidence: truncate(long[0].textContent || '', 120),
      };
    },
  ),
  pageCheck(
    {
      id: 'content.repeated-paragraph',
      category: 'content',
      pillar: C,
      title: 'Same paragraph repeated on the page',
      why: 'Repeated blocks inflate the word count without adding information and look like low-effort content.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Remove the repeated paragraph or rewrite it for its context.',
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const ps = Array.from(doc(page).querySelectorAll('main p, article p, body p'))
        .map((p) => normText(p.textContent))
        .filter((t) => words(t).length >= 20);
      const g = groupBy(ps, (t) => t);
      const dup = [...g.values()].find((x) => x.length > 1);
      return dup
        ? {
            checkId: 'content.repeated-paragraph',
            message: `A ${words(dup[0]).length}-word paragraph appears ${dup.length} times`,
            evidence: truncate(dup[0], 120),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'content.boilerplate-heavy',
      category: 'content',
      pillar: C,
      title: 'Navigation and footer outweigh the main content',
      why: 'When most of the text on a page is shared navigation, footer and sidebar copy, pages look alike and the unique content is hard to find.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Add more page-specific content, or trim repeated menus, footers and widgets.',
    },
    (page, site) => {
      if (!isIndexable(page) || isHomepage(page, site) || !page.mainText || page.wordCount < 150)
        return null;
      const main = words(page.mainText).length;
      const share = main / page.wordCount;
      if (share >= BOILERPLATE_MAIN_SHARE || main >= THIN_WORDS * 2) return null;
      return {
        checkId: 'content.boilerplate-heavy',
        message: `Main content is ${Math.round(share * 100)}% of the page text (${main} of ${page.wordCount} words)`,
      };
    },
  ),
  pageCheck(
    {
      id: 'content.copyright-outdated',
      category: 'content',
      pillar: C,
      title: 'Copyright year is out of date',
      why: 'An old copyright year makes the site look abandoned to visitors and is a weak freshness signal.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Generate the current year automatically in the footer template.',
    },
    (page, site) => {
      if (!isHomepage(page, site) || !page.isHtml || page.status !== 200) return null;
      const years = [...(page.html || '').matchAll(COPYRIGHT_YEAR)]
        .map((m) => Number(m[1]))
        .filter((y) => y > 1990 && y <= CURRENT_YEAR);
      if (!years.length) return null;
      const y = Math.max(...years);
      if (y >= CURRENT_YEAR - 1) return null;
      return { checkId: 'content.copyright-outdated', message: `Footer copyright says ${y}` };
    },
  ),
  pageCheck(
    {
      id: 'content.outdated-year-in-title',
      category: 'content',
      pillar: C,
      title: 'Title or H1 names a past year',
      why: 'A heading like "Best tools for 2022" tells searchers and AI engines the page is out of date, which lowers clicks and citations.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Update the content and the year, or remove the year if the page is evergreen.',
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const h1 = page.headings.find((h) => h.level === 1)?.text || '';
      const txt = `${page.title || ''} ${h1}`;
      if (
        !/\b(best|top|guide|review|trends?|update|statistics|stats|prices?|pricing|in|for)\b/i.test(
          txt,
        )
      )
        return null;
      const years = [...txt.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
      if (!years.length) return null;
      const y = Math.max(...years);
      if (y >= CURRENT_YEAR || y < 2000) return null;
      // History pages ("in 2019 we…") or dated events are fine when the article itself is dated that year.
      if (isArticleLike(page)) {
        const { published } = articleDates(page);
        if (published && published.startsWith(String(y))) return null;
      }
      return {
        checkId: 'content.outdated-year-in-title',
        message: `Mentions ${y} in the title or H1`,
        evidence: truncate(txt),
      };
    },
  ),
  pageCheck(
    {
      id: 'content.article-date-missing',
      category: 'content',
      pillar: C,
      title: 'Article has no published or updated date',
      why: 'Readers and AI engines use dates to judge freshness. Undated articles are less likely to be chosen for time-sensitive answers.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Show the published and last-updated dates on the page and add datePublished and dateModified to the Article markup.',
      refs: ['https://developers.google.com/search/docs/appearance/publication-dates'],
      tags: ['geo'],
    },
    (page) => {
      if (!isIndexable(page) || !isArticleLike(page)) return null;
      const { published, modified } = articleDates(page);
      if (published || modified || doc(page).querySelector('time[datetime], time')) return null;
      return {
        checkId: 'content.article-date-missing',
        message: 'No date found in markup, meta tags or a <time> element',
      };
    },
  ),
  pageCheck(
    {
      id: 'content.article-author-missing',
      category: 'content',
      pillar: C,
      title: 'Article has no author',
      why: 'Named, credible authors are part of how Google and AI engines judge expertise and trust. Anonymous articles are weaker sources to cite.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Show the author name with a link to an author page, and add author (Person with name and url) to the Article markup.',
      refs: [
        'https://developers.google.com/search/docs/appearance/structured-data/article#author-bp',
      ],
      tags: ['geo', 'eeat'],
    },
    (page) => {
      if (!isIndexable(page) || !isArticleLike(page)) return null;
      const nodes = nodesOfType(page, ['Article', 'BlogPosting', 'NewsArticle', 'TechArticle']);
      if (nodes.some((n) => str(n.author))) return null;
      const d = doc(page);
      if (
        d.querySelector(
          'meta[name="author"][content], [rel~="author"], [itemprop="author"], .author, .byline, [class*="author-name"]',
        )
      )
        return null;
      return {
        checkId: 'content.article-author-missing',
        message: 'No author in markup or on the page',
      };
    },
  ),
  pageCheck(
    {
      id: 'content.date-in-future',
      category: 'content',
      pillar: C,
      title: 'Article date is in the future',
      why: 'A published or modified date ahead of today is a sign of a wrong timezone or a faked freshness date, and can be ignored or distrusted.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Correct the date and include a timezone offset (for example 2025-05-01T09:00:00+01:00).',
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const { published, modified } = articleDates(page);
      const ahead = [published, modified].filter(
        (d): d is string => !!d && ISO_DATE.test(d) && Date.parse(d) > Date.now() + 2 * 86_400_000,
      );
      return ahead.length
        ? { checkId: 'content.date-in-future', message: `Date ${ahead[0]} is in the future` }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'content.modified-before-published',
      category: 'content',
      pillar: C,
      title: 'Modified date is earlier than published date',
      why: 'An updated date before the published date is contradictory, so engines may ignore both.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Make sure dateModified is the same as or later than datePublished.',
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const { published, modified } = articleDates(page);
      if (!published || !modified) return null;
      const p = Date.parse(published);
      const m = Date.parse(modified);
      if (Number.isNaN(p) || Number.isNaN(m) || m >= p - 86_400_000) return null;
      return {
        checkId: 'content.modified-before-published',
        message: `Modified ${modified} is before published ${published}`,
      };
    },
  ),
  pageCheck(
    {
      id: 'content.stale-article',
      category: 'content',
      pillar: C,
      title: 'Article not updated in a long time',
      why: `Articles last touched more than ${STALE_ARTICLE_YEARS} years ago may contain outdated facts, and engines favour current sources for many queries.`,
      severity: 'info',
      fixTier: 'manual',
      fix: 'Review the article: update facts, examples and screenshots, then change the modified date. Retire or redirect it if it is no longer useful.',
      tags: ['freshness'],
    },
    (page) => {
      if (!isIndexable(page) || !isArticleLike(page)) return null;
      const { published, modified } = articleDates(page);
      const d = Date.parse(modified || published || '');
      if (Number.isNaN(d)) return null;
      const years = (Date.now() - d) / (365.25 * 86_400_000);
      if (years < STALE_ARTICLE_YEARS) return null;
      return {
        checkId: 'content.stale-article',
        message: `Last dated ${new Date(d).toISOString().slice(0, 10)} (${Math.floor(years)} years ago)`,
      };
    },
  ),

  // -------------------------------------------------------------------------
  // Duplicates (site)
  // -------------------------------------------------------------------------
  siteCheck(
    {
      id: 'duplicates.exact',
      category: 'duplicates',
      pillar: C,
      title: 'Exact duplicate pages',
      why: 'Identical content on several indexable URLs splits ranking signals and lets search engines pick the version to show, which may not be yours.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Keep one URL. 301-redirect the others to it, or add a canonical pointing to it if both must stay reachable.',
      refs: [REF.canonical],
    },
    (site) => {
      const groups = [
        ...groupBy(
          indexablePages(site).filter((p) => p.wordCount >= 20),
          (p) => p.contentHash,
        ).values(),
      ].filter((g) => g.length > 1);
      const out: Issue[] = [];
      for (const g of groups)
        for (const p of g) {
          const others = g.filter((o) => o !== p).map((o) => o.url);
          out.push({
            checkId: 'duplicates.exact',
            url: p.url,
            message: `Same content as ${plural(others.length, 'other page')}`,
            evidence: list(others, 3),
            data: { group: g.length },
          });
          if (out.length >= DUPLICATE_REPORT_LIMIT) return out;
        }
      return out;
    },
  ),
  siteCheck(
    {
      id: 'duplicates.near',
      category: 'duplicates',
      pillar: C,
      title: 'Near-duplicate pages',
      why: 'Pages that differ by only a few words (location or product variants built from one template) look like duplicates and may be filtered out of results.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Make each page genuinely different (local details, specific examples, pricing, FAQs), or merge them into one stronger page.',
      refs: [REF.helpfulContent],
    },
    (site) => {
      const pages = indexablePages(site).filter(
        (p) => p.wordCount >= NEAR_DUP_MIN_WORDS && p.simhash,
      );
      if (pages.length > NEAR_DUP_MAX_PAGES) pages.length = NEAR_DUP_MAX_PAGES;
      const partners = new Map<PageData, PageData[]>();
      for (let i = 0; i < pages.length; i++)
        for (let j = i + 1; j < pages.length; j++) {
          const a = pages[i];
          const b = pages[j];
          if (a.contentHash === b.contentHash) continue; // exact duplicates reported separately
          if (simhashDistance(a.simhash, b.simhash) > NEAR_DUP_DISTANCE) continue;
          (partners.get(a) ?? partners.set(a, []).get(a)!).push(b);
          (partners.get(b) ?? partners.set(b, []).get(b)!).push(a);
        }
      return [...partners.entries()].slice(0, DUPLICATE_REPORT_LIMIT).map(([p, others]) => ({
        checkId: 'duplicates.near',
        url: p.url,
        message: `Almost the same text as ${plural(others.length, 'other page')}`,
        evidence: list(
          others.map((o) => o.url),
          3,
        ),
      }));
    },
  ),
  siteCheck(
    {
      id: 'duplicates.url-variants',
      category: 'duplicates',
      pillar: 'technical',
      title: 'Same page indexable at several URL variants',
      why: 'When the same content is indexable at URLs that differ only by parameters, case or a trailing slash, link signals are split across copies.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Pick one form, redirect the others to it, and make the canonical tag on every variant point to that form.',
      refs: [REF.canonical],
    },
    (site) => {
      const groups = groupBy(indexablePages(site), (p) => {
        const u = safeUrl(p.url);
        if (!u) return null;
        return `${u.hostname.replace(/^www\./, '')}${u.pathname.toLowerCase().replace(/\/(index\.(html?|php))?$/, '')}|${p.contentHash}`;
      });
      const out: Issue[] = [];
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        const urls = [...new Set(g.map((p) => urlKey(p.url)))];
        if (urls.length < 2) continue;
        out.push({
          checkId: 'duplicates.url-variants',
          url: g[0].url,
          message: `${g.length} URL variants serve the same page`,
          evidence: list(urls, 4),
        });
      }
      return out.slice(0, DUPLICATE_REPORT_LIMIT);
    },
  ),
  siteCheck(
    {
      id: 'duplicates.shared-intro',
      category: 'duplicates',
      pillar: C,
      title: 'Many pages open with the same text',
      why: 'The first lines after the H1 are what snippets and AI answers quote most. When many pages share the same opening, none of them stands out.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Rewrite the opening paragraph of each page so it answers that page’s own topic directly.',
      tags: ['aeo'],
    },
    (site) => {
      const groups = groupBy(
        indexablePages(site).filter((p) => words(p.lead).length >= 15),
        (p) => normText(p.lead).slice(0, 160),
      );
      const out: Issue[] = [];
      for (const g of groups.values())
        if (g.length >= SHARED_LEAD_MIN_PAGES)
          out.push({
            checkId: 'duplicates.shared-intro',
            message: `${g.length} pages start with the same text`,
            evidence: truncate(
              `"${g[0].lead}" — ${list(
                g.map((p) => p.url),
                3,
              )}`,
              480,
            ),
          });
      return out;
    },
  ),
  siteCheck(
    {
      id: 'duplicates.title-and-description',
      category: 'duplicates',
      pillar: C,
      title: 'Pages share both title and description',
      why: 'When two pages have the same title and the same description, search engines see them as the same result and usually show only one.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Differentiate the title and description of each page, or merge the pages if they really cover the same thing.',
    },
    (site) => {
      const groups = groupBy(
        indexablePages(site).filter((p) => p.title && p.metaDescription),
        (p) => `${normText(p.title)}|${normText(p.metaDescription)}`,
      );
      const out: Issue[] = [];
      for (const g of groups.values())
        if (g.length > 1)
          out.push({
            checkId: 'duplicates.title-and-description',
            url: g[0].url,
            message: `${g.length} pages share the title "${truncate(g[0].title, 60)}" and its description`,
            evidence: list(
              g.map((p) => p.url),
              4,
            ),
          });
      return out.slice(0, DUPLICATE_REPORT_LIMIT);
    },
  ),
];

// ---------------------------------------------------------------------------
// Added for feature parity: cannibalisation, doubled words, spelling (LanguageTool),
// PDF titles, and meaning-based duplicates from embeddings
// ---------------------------------------------------------------------------

/** Significant words of a title or heading: lower-case, no stop words or brand, crude singular. */
export function topicTerms(
  text: string | null | undefined,
  brand: Set<string> = new Set(),
): string[] {
  const out = new Set<string>();
  for (const raw of words((text ?? '').toLowerCase())) {
    const w = raw.replace(/[^\p{L}\p{N}-]/gu, '');
    if (w.length < 3 || STOP_WORDS.has(w) || brand.has(w) || /^\d+$/.test(w)) continue;
    out.add(w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return [...out].sort();
}

const DOUBLED_OK = new Set([
  'that',
  'had',
  'can',
  'do',
  'so',
  'bye',
  'very',
  'no',
  'yes',
  'ha',
  'la',
  'really',
  'far',
  'many',
  'is',
  'knock',
  'tut',
  'chop',
  'pom',
  'dum',
  'ta',
  'go',
  'hip',
  'well',
  'blah',
]);

/** Doubled words such as "the the" in visible text (case-insensitive, first 20). */
export function doubledWords(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(\p{L}{2,})[ \t]+\1(?![\p{L}\p{N}])/giu)) {
    const w = m[1]!.toLowerCase();
    if (DOUBLED_OK.has(w)) continue;
    const start = Math.max(0, (m.index ?? 0) - 30);
    out.push(
      text
        .slice(start, (m.index ?? 0) + m[0].length + 30)
        .replace(/\s+/g, ' ')
        .trim(),
    );
    if (out.length >= 20) break;
  }
  return out;
}

const PDF_GENERIC_TITLE =
  /^(untitled|document\d*|microsoft (word|powerpoint|excel) - .*|.*\.(docx?|pptx?|xlsx?|indd|pdf)|title|new document|presentation\d*)$/i;

const SPELLING_MIN_MATCHES = 3;

checks.push(
  siteCheck(
    {
      id: 'content.cannibalisation',
      category: 'content',
      pillar: C,
      title: 'Several pages target the same topic',
      why: 'When two or more pages use the same key words in their title and H1, they compete for the same searches. Search engines and AI assistants pick one, often not the one you want, and the signals (links, engagement) are split between them.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Decide which page should rank for the topic. Merge the others into it (with a 301), or give each page a distinct focus and rewrite its title and H1 to match.',
      refs: [REF.canonical, REF.helpfulContent],
    },
    (site) => {
      const pages = indexablePages(site).filter(
        (p) => p.title && (pageNumber(p.url) ?? 1) <= 1 && !isHomepage(p, site),
      );
      if (pages.length < 2) return null;
      const brand = brandWords(pages[0]!);
      const groups = new Map<string, PageData[]>();
      for (const p of pages) {
        const h1 = p.headings.find((h) => h.level === 1)?.text ?? '';
        const t = topicTerms(p.title, brand);
        const h = topicTerms(h1, brand);
        if (t.length < 2 || !h.length) continue;
        // Key: the terms the title and H1 share (both signal the same intent).
        const shared = t.filter((x) => h.includes(x));
        const key = (shared.length >= 2 ? shared : t).join(' ');
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
      }
      const out: Issue[] = [];
      for (const [key, g] of groups) {
        if (g.length < 2) continue;
        // Exact duplicate titles are reported by onpage.title-duplicate already.
        if (new Set(g.map((p) => normText(p.title))).size === 1) continue;
        out.push({
          checkId: 'content.cannibalisation',
          url: g[0]!.url,
          message: `${g.length} pages compete for "${key}"`,
          evidence: list(
            g.map((p) => `${p.url} — ${truncate(p.title, 60)}`),
            4,
          ),
          data: { topic: key, pages: g.map((p) => p.url) },
        });
      }
      return out.slice(0, DUPLICATE_REPORT_LIMIT);
    },
  ),
  pageCheck(
    {
      id: 'content.repeated-words',
      category: 'content',
      pillar: C,
      title: 'Doubled words in the text',
      why: 'Typos such as "the the" look careless to readers and lower trust. AI answer engines quote sentences verbatim, so a slip can travel with your brand name on it.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Remove the repeated word in each quoted sentence. A spelling and grammar check (for example `avc connect spelling`) catches more.',
    },
    (page) => {
      if (!isIndexable(page) || !isEnglish(page) || page.wordCount < 50) return null;
      const found = doubledWords(page.text);
      if (!found.length) return null;
      return {
        checkId: 'content.repeated-words',
        message: `${plural(found.length, 'doubled word')} in the text`,
        evidence: found.slice(0, 5).join(' | '),
        data: { count: found.length },
      };
    },
  ),
  siteCheck(
    {
      id: 'content.spelling',
      category: 'content',
      pillar: C,
      title: 'Spelling and grammar mistakes',
      why: 'Mistakes make a page look less trustworthy to readers and quality raters, and AI answers that quote the page repeat them. Checked with LanguageTool on the main content only, so menus and footers do not add noise.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Correct the listed mistakes in your CMS. Add brand and product names to your LanguageTool dictionary so they are not flagged again.',
      requires: ['spelling'],
      refs: ['https://languagetool.org/'],
    },
    (site) => {
      const data = site.external.spelling;
      if (!data) return null;
      const out: Issue[] = [];
      for (const p of data.pages) {
        if (p.matches.length < SPELLING_MIN_MATCHES) continue;
        out.push({
          checkId: 'content.spelling',
          url: p.url,
          message: `${plural(p.matches.length, 'possible mistake')} (${p.language})`,
          evidence: p.matches
            .slice(0, 5)
            .map((m) => `${m.message}: "${truncate(m.context, 70)}"`)
            .join(' | '),
          data: { matches: p.matches.length },
        });
      }
      return out;
    },
  ),
  pageCheck(
    {
      id: 'content.pdf-title-missing',
      category: 'content',
      pillar: C,
      title: 'PDF has no meaningful title',
      why: 'Search engines index PDFs and use the document Title property as the result title. Without one, results show the file name or a generated title such as "Microsoft Word - final_v3.docx".',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Set the Title (File → Properties → Description in Acrobat or Word) to a descriptive title, enable "show document title" in the PDF\'s initial view, and re-upload it at the same URL.',
      refs: ['https://developers.google.com/search/docs/crawling-indexing/indexable-file-types'],
    },
    (page) => {
      if (!page.pdf || page.status !== 200 || page.pdf.encrypted) return null;
      const t = page.pdf.title?.trim();
      if (t && !PDF_GENERIC_TITLE.test(t)) return null;
      return {
        checkId: 'content.pdf-title-missing',
        message: t ? `PDF title is "${truncate(t, 60)}"` : 'PDF has no Title property',
        evidence: [page.pdf.producer, page.pdf.pages ? `${page.pdf.pages} pages` : '']
          .filter(Boolean)
          .join(' | '),
      };
    },
  ),
  siteCheck(
    {
      id: 'duplicates.semantic',
      category: 'duplicates',
      pillar: C,
      title: 'Pages that say the same thing in different words',
      why: 'Search engines and AI systems compare meaning, not only wording. Pages whose content is nearly the same in meaning compete with each other and dilute the one you want cited, even when no sentence is copied.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Merge pages that answer the same need (301 the weaker one), or make each page clearly different: its own audience, question or offer.',
      requires: ['embeddings'],
      refs: [REF.helpfulContent],
    },
    (site) => {
      const e = site.external.embeddings;
      if (!e) return null;
      const out: Issue[] = [];
      for (const pair of e.similarPairs.slice(0, DUPLICATE_REPORT_LIMIT)) {
        const a = cu.findPage(site, pair.a);
        const b = cu.findPage(site, pair.b);
        // Exact and near-exact copies are reported by duplicates.exact / duplicates.near.
        if (
          a &&
          b &&
          a.simhash &&
          b.simhash &&
          simhashDistance(a.simhash, b.simhash) <= NEAR_DUP_DISTANCE
        )
          continue;
        out.push({
          checkId: 'duplicates.semantic',
          url: pair.a,
          message: `Meaning ${Math.round(pair.similarity * 100)}% similar to ${pair.b}`,
          evidence: pair.b,
          data: { other: pair.b, similarity: pair.similarity },
        });
      }
      return out;
    },
  ),
  siteCheck(
    {
      id: 'content.off-topic',
      category: 'content',
      pillar: C,
      title: "Pages far from the site's main topics",
      why: 'AI systems build a picture of what a site is an authority on. Indexable pages that have little to do with the rest of the site blur that picture and rarely earn citations themselves.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Check each page: connect it to your core topics (context, internal links), move it to a better home, or noindex it if it serves no search purpose.',
      requires: ['embeddings'],
    },
    (site) => {
      const e = site.external.embeddings;
      if (!e) return null;
      return e.outliers.slice(0, 50).map((o) => ({
        checkId: 'content.off-topic',
        url: o.url,
        message: `Similarity to the site's average page is ${Math.round(o.similarity * 100)}%`,
        data: { similarity: o.similarity },
      }));
    },
  ),
);
