/**
 * AEO/GEO content readiness (pillar 'geo', category 'geo-content'): can an
 * answer engine lift a clean, attributable, current answer from the page?
 * Signals come from src/agentic/geo-score.ts so findings and the page score
 * always agree.
 */
import type { Check, PageData, SiteContext } from '../core/types.js';
import { geoPageScore, geoSignals, QUESTION_RE } from '../agentic/geo-score.js';
import {
  collapse,
  ev,
  homePage,
  indexablePages,
  inlinkCount,
  isArticleLike,
  isIndexable,
  issue,
  memo,
  nodesOfType,
  pageCheck,
  pathOf,
  plural,
  schemaTypes,
  siteCheck,
  truncate,
  vb,
  type AiDef,
} from './_ai-util.js';

const REF = {
  ai: 'https://developers.google.com/search/docs/appearance/ai-features',
  helpful: 'https://developers.google.com/search/docs/fundamentals/creating-helpful-content',
  article: 'https://developers.google.com/search/docs/appearance/structured-data/article',
  faq: 'https://developers.google.com/search/docs/appearance/structured-data/faqpage',
  bing: 'https://blogs.bing.com/webmaster/',
};

const base = { category: 'geo-content', pillar: 'geo' } as const;
const def = (d: Omit<AiDef, 'category' | 'pillar'>): AiDef => ({
  ...base,
  tags: ['geo', 'aeo'],
  ...d,
});

/** Pages worth judging as answer sources: indexable, with real text. */
function isContent(page: PageData): boolean {
  return isIndexable(page) && page.wordCount >= 150;
}

const UTILITY_PATH =
  /\/(contact|contact-us|privacy|terms|cookies?|legal|login|sign-?in|register|cart|basket|checkout|account|search|thank-?you)(\/|$|\.)/i;

/** Pages the GEO score is meaningful for: articles and substantial content pages, not utility pages. */
function isScorable(page: PageData, site: SiteContext): boolean {
  if (!isContent(page) || isHome(page, site) || UTILITY_PATH.test(pathOf(page.url))) return false;
  return isArticleLike(page) || page.wordCount >= 500;
}

function isHome(page: PageData, site: SiteContext): boolean {
  return homePage(site) === page || pathOf(page.url) === '/';
}

const ARTICLE_TYPES = [
  'Article',
  'BlogPosting',
  'NewsArticle',
  'TechArticle',
  'Report',
  'ScholarlyArticle',
];

function parseDate(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const DAY = 86_400_000;

export const checks: Check[] = [
  pageCheck(
    def({
      id: 'geo-content.no-answer-first',
      title: 'Page does not open with a direct answer',
      why: 'Answer engines favour passages that state the answer plainly near the top. Opening with a welcome, a rhetorical question or scene-setting pushes the answer down where it is less likely to be lifted.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Rewrite the first 40–60 words after the H1 to answer the page’s main question directly: what it is, who it is for, and the key fact.',
      refs: [REF.ai],
    }),
    (page, site) => {
      if (!isContent(page) || isHome(page, site)) return null;
      const s = geoSignals(page);
      if (s.leadWords >= 15 && !s.leadFiller && !s.leadIsQuestion) return null;
      const why = s.leadFiller
        ? 'opens with filler'
        : s.leadIsQuestion
          ? 'opens with a question rather than an answer'
          : `opens with only ${s.leadWords} words of text`;
      return issue('geo-content.no-answer-first', `The page ${why}.`, {
        url: page.url,
        evidence: truncate(s.lead, 300),
      });
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.no-question-headings',
      title: 'No subheadings phrased as questions',
      why: 'People ask assistants questions. A subheading that matches the question, followed by a direct answer, is the easiest passage for an engine to match and quote.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Rephrase two or three subheadings as the questions your readers ask, and answer each in the first sentence below.',
      refs: [REF.ai],
    }),
    (page, site) => {
      if (!isContent(page) || isHome(page, site) || page.wordCount < 400) return null;
      const s = geoSignals(page);
      if (s.subheadings < 3 || s.questionHeadings.length > 0) return null;
      return issue(
        'geo-content.no-question-headings',
        `None of ${s.subheadings} subheadings is a question.`,
        {
          url: page.url,
          evidence: ev(
            s.headings
              .filter((h) => h.level >= 2)
              .slice(0, 5)
              .map((h) => `H${h.level}: ${h.text}`),
          ),
        },
      );
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.answer-buried',
      title: 'Answers under question headings are long-winded',
      why: 'When the paragraph under a question heading runs past 80 words before answering, engines struggle to extract a concise answer and may pick another source.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Start each answer with a one or two sentence direct answer (under about 50 words), then add detail in following paragraphs.',
    }),
    (page) => {
      if (!isContent(page)) return null;
      const long = geoSignals(page).questionHeadings.filter((q) => q.answerWords > 80);
      return long.length
        ? issue(
            'geo-content.answer-buried',
            `${plural(long.length, 'question heading')} ${vb(long.length, 'opens', 'open')} with a paragraph over 80 words.`,
            {
              url: page.url,
              evidence: ev(long.slice(0, 5).map((q) => `${q.text} (${q.answerWords} words)`)),
            },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.faq-without-schema',
      title: 'FAQ content without FAQPage markup',
      why: 'FAQPage JSON-LD states each question and answer explicitly, so engines do not have to infer the pairs from layout. Google limits FAQ rich results to some sites, but the markup still describes the content clearly.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add FAQPage JSON-LD whose questions and answers match the visible FAQ text exactly.',
      refs: [REF.faq],
    }),
    (page) => {
      if (!isContent(page)) return null;
      const s = geoSignals(page);
      if (s.faqSchemaQuestions.length || !(s.faqHeading && s.questionHeadings.length >= 2))
        return null;
      return issue(
        'geo-content.faq-without-schema',
        `FAQ section with ${plural(s.questionHeadings.length, 'question')} has no FAQPage markup.`,
        { url: page.url },
      );
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.faq-schema-mismatch',
      title: 'FAQPage markup does not match the visible page',
      why: 'Markup for questions that are not on the page is treated as misleading by Google and gives engines facts the reader cannot see. It undermines trust in all your markup.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Make the FAQPage questions and answers match the visible FAQ, or remove the markup.',
      refs: [REF.faq],
    }),
    (page) => {
      if (!page.isHtml) return null;
      const s = geoSignals(page);
      if (!s.faqSchemaQuestions.length) return null;
      const text = collapse(page.text).toLowerCase();
      const missing = s.faqSchemaQuestions.filter(
        (q) =>
          q.q &&
          !text.includes(
            collapse(q.q)
              .toLowerCase()
              .replace(/[?.!]+$/, ''),
          ),
      );
      return missing.length
        ? issue(
            'geo-content.faq-schema-mismatch',
            `${missing.length} of ${s.faqSchemaQuestions.length} FAQPage questions are not visible on the page.`,
            {
              url: page.url,
              evidence: ev(missing.slice(0, 5).map((q) => q.q)),
            },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.faq-answers-thin',
      title: 'FAQ answers are too short to be useful',
      why: 'One-line answers such as "Yes." or "Contact us." give an engine nothing to quote and read as filler.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Give each FAQ answer two or three sentences with the specific fact (price, time, condition).',
    }),
    (page) => {
      const qs = geoSignals(page).faqSchemaQuestions;
      const thin = qs.filter((q) => q.a.split(/\s+/).filter(Boolean).length < 8);
      return qs.length && thin.length / qs.length > 0.5
        ? issue(
            'geo-content.faq-answers-thin',
            `${thin.length} of ${qs.length} FAQ answers are under eight words.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.no-lists-or-tables',
      title: 'Long page with no lists or tables',
      why: 'Steps, options, specifications and comparisons are lifted whole when they are lists or tables. As running prose they must be paraphrased, and other sources win.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Turn steps into a numbered list, options into bullets, and comparisons or specifications into a table.',
    }),
    (page) => {
      if (!isContent(page) || page.wordCount < 600) return null;
      const s = geoSignals(page);
      return s.lists === 0 && s.tables === 0
        ? issue(
            'geo-content.no-lists-or-tables',
            `${page.wordCount} words with no lists or tables in the main content.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.howto-without-steps',
      title: '“How to” page without numbered steps',
      why: 'For how-to questions, engines prefer sources that give an ordered list of steps they can reproduce.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Present the procedure as a numbered list (<ol>), one action per step.',
    }),
    (page) => {
      if (!isContent(page)) return null;
      const s = geoSignals(page);
      const t = `${page.title ?? ''} ${s.h1 ?? ''}`;
      return /\bhow to\b/i.test(t) && s.ordered === 0 && !schemaTypes(page).includes('HowTo')
        ? issue(
            'geo-content.howto-without-steps',
            'The page is a how-to but has no ordered list of steps.',
            { url: page.url, evidence: s.h1 ?? page.title ?? '' },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.no-specifics',
      title: 'No concrete figures on the page',
      why: 'Answers are built from specifics: prices, timescales, quantities, dates. A page without a single figure gives an engine nothing factual to quote.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Add the figures you can stand behind: starting price, delivery time, years in operation, sizes, limits.',
    }),
    (page) => {
      if (!isContent(page) || page.wordCount < 300) return null;
      return geoSignals(page).numbers === 0
        ? issue('geo-content.no-specifics', `${page.wordCount} words without a single number.`, {
            url: page.url,
          })
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.stats-without-sources',
      title: 'Statistics without sources',
      why: 'Percentages and market figures with no link to their source are hard for an engine to trust or attribute. Cited statistics are more likely to be repeated.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Link each statistic to the study, dataset or official source it came from, or label it as your own data.',
    }),
    (page) => {
      if (!isContent(page)) return null;
      const s = geoSignals(page);
      return s.stats >= 3 && s.externalLinks.length === 0 && !s.firstHand
        ? issue(
            'geo-content.stats-without-sources',
            `${s.stats} statistics and no outbound links to sources.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.no-citations',
      title: 'Long article cites no outside sources',
      why: 'Content that links claims to authoritative sources is easier to verify, and engines that weigh trust treat it as a safer citation.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Link key claims to primary sources: standards, official statistics, research, or vendor documentation.',
      refs: [REF.helpful],
    }),
    (page) => {
      if (!isContent(page) || !isArticleLike(page) || page.wordCount < 800) return null;
      return geoSignals(page).externalLinks.length === 0
        ? issue(
            'geo-content.no-citations',
            `${page.wordCount}-word article with no outbound links.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.quotes-unattributed',
      title: 'Quotations without attribution',
      why: 'A blockquote with no named source cannot be attributed, so an engine cannot repeat it with confidence.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Name the person and role for each quotation, in a <cite> or caption, and link the source where there is one.',
    }),
    (page) => {
      if (!isContent(page)) return null;
      const s = geoSignals(page);
      return s.blockquotesUnattributed > 0
        ? issue(
            'geo-content.quotes-unattributed',
            `${plural(s.blockquotesUnattributed, 'blockquote')} ${vb(s.blockquotesUnattributed, 'has', 'have')} no attribution.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.no-author',
      title: 'Article has no author',
      why: 'A named, accountable author is one of the clearest trust signals for both Google and AI engines. Anonymous articles are weaker citation candidates, especially on advice topics.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Show a byline linking to an author page, and set "author" (a Person with name and url) in the Article schema.',
      refs: [REF.article],
    }),
    (page) => {
      if (!isContent(page) || !isArticleLike(page)) return null;
      const s = geoSignals(page);
      return !s.bylineVisible && !s.authorSchema
        ? issue('geo-content.no-author', 'No visible byline and no author in the schema.', {
            url: page.url,
          })
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.author-not-in-schema',
      title: 'Byline shown but no author in the schema',
      why: 'The visible byline helps readers; the schema author is how engines connect the article to a known person and their other work.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add "author": {"@type": "Person", "name": "…", "url": "…/authors/…"} to the Article JSON-LD.',
      refs: [REF.article],
    }),
    (page) => {
      if (!isContent(page) || !isArticleLike(page)) return null;
      const s = geoSignals(page);
      return s.bylineVisible && !s.authorSchema
        ? issue(
            'geo-content.author-not-in-schema',
            `Byline "${s.bylineVisible}" is visible but no schema author is set.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.author-no-credentials',
      title: 'Author markup has only a name',
      why: 'A name alone is ambiguous. A url to an author page, a jobTitle and sameAs links to professional profiles let engines identify the person and judge their expertise.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Extend the author Person with url, jobTitle, and sameAs (LinkedIn and similar).',
    }),
    (page) => {
      const a = geoSignals(page).authorSchema;
      if (!a || !isContent(page)) return null;
      const t = String(a['@type'] ?? 'Person');
      if (/Organization/.test(t)) return null;
      const has = ['url', 'sameAs', 'jobTitle', 'description', '@id'].filter((k) => a[k]);
      return has.length === 0
        ? issue(
            'geo-content.author-no-credentials',
            `Author "${String(a.name ?? '')}" has no url, sameAs or jobTitle.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.no-visible-date',
      title: 'Article shows no date',
      why: 'Engines and readers both prefer current information. Without a visible published or updated date, an article cannot show it is current.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Show the published date and, when you revise it, “Last updated” with the date.',
    }),
    (page) => {
      if (!isContent(page) || !isArticleLike(page)) return null;
      return geoSignals(page).visibleDate
        ? null
        : issue('geo-content.no-visible-date', 'No visible publish or update date found.', {
            url: page.url,
          });
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.no-schema-dates',
      title: 'Article schema without datePublished or dateModified',
      why: 'datePublished and dateModified in the schema are the machine-readable freshness signal engines read.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add datePublished and dateModified (ISO 8601) to the Article JSON-LD and keep dateModified current.',
      refs: [REF.article],
    }),
    (page) => {
      if (!isContent(page) || !nodesOfType(page, ARTICLE_TYPES).length) return null;
      const s = geoSignals(page);
      return !s.datePublished && !s.dateModified
        ? issue(
            'geo-content.no-schema-dates',
            'Article schema has no datePublished or dateModified.',
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.date-invalid',
      title: 'Schema dates are invalid or contradictory',
      why: 'A dateModified before datePublished, a date in the future, or an unparseable date makes freshness unreliable and can be ignored altogether.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use ISO 8601 dates (2026-03-14 or 2026-03-14T09:00:00+00:00) and make sure dateModified is on or after datePublished.',
    }),
    (page) => {
      const s = geoSignals(page);
      if (!s.datePublished && !s.dateModified) return null;
      const p = parseDate(s.datePublished);
      const m = parseDate(s.dateModified);
      const problems: string[] = [];
      if (s.datePublished && p === null)
        problems.push(`datePublished "${s.datePublished}" is not a date`);
      if (s.dateModified && m === null)
        problems.push(`dateModified "${s.dateModified}" is not a date`);
      if (p && m && m < p - DAY) problems.push('dateModified is before datePublished');
      const now = Date.now();
      if ((p && p > now + 2 * DAY) || (m && m > now + 2 * DAY))
        problems.push('a date is in the future');
      return problems.length
        ? issue('geo-content.date-invalid', problems.join('; ') + '.', { url: page.url })
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.stale',
      title: 'Article not updated in over 18 months',
      why: 'For topics that change (prices, tools, regulations), engines favour recent sources. An old date is a reason to choose a competitor’s page.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Review the article, update facts and figures, and set a new dateModified. Do not change the date without changing the content.',
    }),
    (page) => {
      if (!isContent(page) || !isArticleLike(page)) return null;
      const s = geoSignals(page);
      const d = parseDate(s.dateModified) ?? parseDate(s.datePublished) ?? parseDate(s.visibleDate);
      if (!d) return null;
      const months = Math.floor((Date.now() - d) / (30 * DAY));
      return months > 18
        ? issue('geo-content.stale', `Last dated ${months} months ago.`, {
            url: page.url,
            data: { months },
          })
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.long-sections',
      title: 'Sections too long to stand alone',
      why: 'Engines retrieve passages, not pages. A section of 400+ words under one heading mixes several points, so no single chunk answers a question cleanly.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Split long sections with descriptive subheadings so each covers one point in roughly 100–300 words.',
    }),
    (page) => {
      if (!isContent(page)) return null;
      const long = geoSignals(page).sectionWords.filter((n) => n > 400);
      return long.length
        ? issue(
            'geo-content.long-sections',
            `${plural(long.length, 'section')} ${vb(long.length, 'exceeds', 'exceed')} 400 words (${long.join(', ')}).`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.wall-of-text',
      title: 'Very long paragraphs',
      why: 'Paragraphs over 150 words hide the key sentence and make passage extraction less precise.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Break long paragraphs so each makes one point, leading with that point.',
    }),
    (page) => {
      if (!isContent(page)) return null;
      const n = geoSignals(page).longParagraphs;
      return n >= 2
        ? issue('geo-content.wall-of-text', `${n} paragraphs exceed 150 words.`, { url: page.url })
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.too-few-headings',
      title: 'Too few headings for the length',
      why: 'Headings are how engines segment a page into answerable passages. Under one subheading per 400 words, sections blur together.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Add descriptive H2/H3 headings for each distinct topic on the page.',
    }),
    (page) => {
      if (!isContent(page) || page.wordCount < 800) return null;
      const s = geoSignals(page);
      return s.subheadings < Math.floor(page.wordCount / 400)
        ? issue(
            'geo-content.too-few-headings',
            `${plural(s.subheadings, 'subheading')} for ${page.wordCount} words.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.heading-noise',
      title: 'More headings than content',
      why: 'When headings outnumber the text beneath them (one per 40 words or fewer), passages are fragments with no answer in them.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Merge thin sections and give each remaining heading enough text to answer its point.',
    }),
    (page) => {
      if (!isContent(page) || page.wordCount < 300) return null;
      const s = geoSignals(page);
      return s.subheadings >= 6 && page.wordCount / s.subheadings < 40
        ? issue(
            'geo-content.heading-noise',
            `${s.subheadings} subheadings for ${page.wordCount} words.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.vague-language',
      title: 'Marketing language instead of specifics',
      why: 'Words like “world-class” or “seamless” carry no information. Engines skip them, and pages built on them have little left to quote.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Replace each claim with the fact behind it: what you do, for whom, how fast, at what price, with what result.',
    }),
    (page) => {
      if (!isContent(page)) return null;
      const h = geoSignals(page).hype;
      return h.length >= 3
        ? issue(
            'geo-content.vague-language',
            `${plural(h.length, 'vague marketing term')}: ${h.slice(0, 6).join(', ')}.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.no-summary',
      title: 'Long article with no summary up front',
      why: 'A short summary or key-takeaways block near the top gives engines a ready-made answer and readers a reason to stay.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Add a three to five point “Key takeaways” or a two-sentence summary right after the introduction.',
    }),
    (page) => {
      if (!isContent(page) || !isArticleLike(page) || page.wordCount < 1500) return null;
      return geoSignals(page).tldr
        ? null
        : issue(
            'geo-content.no-summary',
            `${page.wordCount}-word article with no summary or key takeaways near the top.`,
            { url: page.url },
          );
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.no-definition',
      title: '“What is” page without a definition sentence',
      why: 'For definitional questions engines look for a sentence of the form “X is …”. Without one they quote a source that has it.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Open with a one-sentence definition: “[Term] is [category] that [distinguishing feature].”',
    }),
    (page) => {
      if (!isContent(page)) return null;
      const s = geoSignals(page);
      const m = `${s.h1 ?? page.title ?? ''}`.match(/what (?:is|are) (?:an? |the )?([^?:|–-]+)/i);
      if (!m) return null;
      const term = m[1]!.trim().split(/\s+/).slice(0, 3).join(' ').toLowerCase();
      const lead = s.lead.toLowerCase();
      const ok =
        /\b(is|are|refers to|means|describes)\b/.test(lead) && lead.includes(term.split(' ')[0]!);
      return ok
        ? null
        : issue('geo-content.no-definition', `The opening does not define “${m[1]!.trim()}”.`, {
            url: page.url,
            evidence: truncate(s.lead, 200),
          });
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.comparison-no-table',
      title: 'Comparison page without a comparison table',
      why: '“X vs Y”, “best” and “alternatives” questions are often answered with a table. Pages that give one are easy to lift; prose comparisons are not.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Add a table comparing the options on the criteria buyers care about (price, features, fit), with honest entries.',
    }),
    (page) => {
      if (!isContent(page)) return null;
      const s = geoSignals(page);
      const t = `${page.title ?? ''} ${s.h1 ?? ''}`;
      return /\b(vs\.?|versus|compared?|comparison|alternatives?|best \w+ for)\b/i.test(t) &&
        s.tables === 0
        ? issue('geo-content.comparison-no-table', 'Comparison page with no table.', {
            url: page.url,
            evidence: s.h1 ?? page.title ?? '',
          })
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.low-entity-density',
      title: 'Few named things on the page',
      why: 'Engines build answers around entities: products, places, organisations, standards. Text that rarely names anything specific is hard to match to a question.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Name the specific products, tools, places, standards and organisations you mean instead of “our solution” or “the platform”.',
    }),
    (page) => {
      if (!isContent(page) || page.wordCount < 400) return null;
      const s = geoSignals(page);
      const per100 = (s.properNouns / page.wordCount) * 100;
      return per100 < 1.5
        ? issue(
            'geo-content.low-entity-density',
            `About ${per100.toFixed(1)} named things per 100 words.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.no-first-hand-evidence',
      title: 'Long article with no first-hand evidence',
      why: 'Engines can already summarise what everyone says. Pages with your own tests, data, cases or experience offer something new to cite.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Add what only you can say: results from your own work, measurements, examples or a short case study.',
      refs: [REF.helpful],
    }),
    (page) => {
      if (!isContent(page) || !isArticleLike(page) || page.wordCount < 1000) return null;
      return geoSignals(page).firstHand
        ? null
        : issue(
            'geo-content.no-first-hand-evidence',
            'No sign of first-hand testing, data or experience.',
            { url: page.url },
          );
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.missing-article-schema',
      title: 'Article without Article schema',
      why: 'Article (or BlogPosting) JSON-LD states the headline, author, publisher and dates in a form engines read reliably.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add Article or BlogPosting JSON-LD with headline, author, publisher, datePublished, dateModified and image.',
      refs: [REF.article],
    }),
    (page) => {
      if (!isContent(page) || !isArticleLike(page)) return null;
      return nodesOfType(page, ARTICLE_TYPES).length
        ? null
        : issue(
            'geo-content.missing-article-schema',
            'Article-like page with no Article/BlogPosting schema.',
            { url: page.url },
          );
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.isolated-article',
      title: 'Article barely linked from the rest of the site',
      why: 'Topical clusters, where related pages link to each other, show engines you cover a subject in depth and help crawlers find each piece.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Link to this article from two or more related pages and from a hub page for its topic.',
    }),
    (page, site) => {
      if (!isContent(page) || !isArticleLike(page)) return null;
      const n = inlinkCount(site, page.url);
      return n < 2
        ? issue(
            'geo-content.isolated-article',
            `Only ${plural(n, 'internal link')} ${vb(n, 'points', 'point')} here.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.no-related-links',
      title: 'Article links to no related content',
      why: 'Links from an article to related pages build the topical cluster from the other side and keep crawlers moving through your expertise.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Add in-text links to two or three related articles or service pages.',
    }),
    (page) => {
      if (!isContent(page) || !isArticleLike(page) || page.wordCount < 500) return null;
      return geoSignals(page).internalMainLinks === 0
        ? issue('geo-content.no-related-links', 'No internal links in the article body.', {
            url: page.url,
          })
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.boilerplate-lead',
      title: 'Same opening text on many pages',
      why: 'When many pages open with the same banner or intro, the first thing an engine reads on each is identical, and the page-specific answer is pushed down.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Move shared banners out of the main content (or below it) so each page opens with its own answer.',
    }),
    (page, site) => {
      if (!isContent(page)) return null;
      const counts = memo(site, 'leadCounts', () => {
        const m = new Map<string, number>();
        for (const p of indexablePages(site)) {
          const k = collapse(p.lead ?? '')
            .slice(0, 120)
            .toLowerCase();
          if (k.length >= 40) m.set(k, (m.get(k) ?? 0) + 1);
        }
        return m;
      });
      const k = collapse(page.lead ?? '')
        .slice(0, 120)
        .toLowerCase();
      const n = counts.get(k) ?? 0;
      return k.length >= 40 && n >= 3
        ? issue(
            'geo-content.boilerplate-lead',
            `The opening text is shared with ${n - 1} other pages.`,
            { url: page.url, evidence: truncate(page.lead, 160) },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'geo-content.low-geo-score',
      title: 'Low GEO readiness score for the page',
      why: 'The GEO score sums how easily an answer engine can lift, trust and attribute this page: direct answer, structure, specifics, sources, author, freshness and chunking.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Work through the tips listed with this finding; each names the specific change for this page.',
    }),
    (page, site) => {
      if (!isScorable(page, site)) return null;
      const g = geoPageScore(page);
      if (g.score >= 50) return null;
      return issue('geo-content.low-geo-score', `GEO score ${g.score}/100.`, {
        url: page.url,
        severity: g.score < 30 ? 'medium' : 'low',
        evidence: ev(g.tips),
        data: { score: g.score, parts: g.parts, tips: g.tips },
      });
    },
  ),

  siteCheck(
    def({
      id: 'geo-content.site-geo-score',
      title: 'Site-wide GEO readiness is low',
      why: 'The average GEO score across content pages shows whether answer-friendly writing is a habit or an exception. Low averages usually trace to a template (no dates, no authors) or a house style (no direct answers).',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Fix template-level gaps first (author, dates, schema), then rewrite the openings of your most-visited pages.',
    }),
    (site) => {
      const pages = indexablePages(site).filter((p) => isScorable(p, site));
      if (pages.length < 3) return null;
      const scores = pages.map((p) => ({ url: p.url, score: geoPageScore(p).score }));
      const avg = Math.round(scores.reduce((n, s) => n + s.score, 0) / scores.length);
      // Most common missing parts across pages.
      const gaps = new Map<string, number>();
      for (const p of pages)
        for (const part of geoPageScore(p).parts)
          if (part.earned < part.max / 2) gaps.set(part.label, (gaps.get(part.label) ?? 0) + 1);
      const top = [...gaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const data = {
        average: avg,
        pages: scores.length,
        distribution: {
          under30: scores.filter((s) => s.score < 30).length,
          from30to59: scores.filter((s) => s.score >= 30 && s.score < 60).length,
          from60: scores.filter((s) => s.score >= 60).length,
        },
        commonGaps: top.map(([label, n]) => ({ label, pages: n })),
        worst: scores.sort((a, b) => a.score - b.score).slice(0, 10),
      };
      if (avg >= 60) return null;
      return issue(
        'geo-content.site-geo-score',
        `Average GEO score is ${avg}/100 across ${scores.length} content pages.`,
        {
          severity: avg < 40 ? 'medium' : 'low',
          evidence: ev(top.map(([label, n]) => `${label}: weak on ${n} pages`)),
          data,
        },
      );
    },
  ),
];

/** Shared for the report. */
export function siteGeoSummary(site: SiteContext): { average: number; pages: number } | null {
  const pages = indexablePages(site).filter((p) => isScorable(p, site));
  if (!pages.length) return null;
  const total = pages.reduce((n, p) => n + geoPageScore(p).score, 0);
  return { average: Math.round(total / pages.length), pages: pages.length };
}

export const _internal = { isContent, QUESTION_RE };
