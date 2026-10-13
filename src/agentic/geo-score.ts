/**
 * GEO signals and the page-level GEO score (0–100).
 *
 * Signals are extracted once per page (cached) and shared by every
 * geo-content check, so the score and the individual findings always agree.
 */
import type { PageData } from '../core/types.js';
import {
  collapse,
  countWords,
  firstWords,
  mainRoot,
  memo,
  nodesOfType,
  pageDoc,
  roughText,
  safeUrl,
  sameSite,
  str,
  type JsonNode,
} from '../checks/_ai-util.js';

export const QUESTION_RE =
  /^(how|what|why|when|where|who|whom|which|can|could|does|do|did|is|are|was|should|will|would|may|must|has|have)\b/i;

const FILLER_RE =
  /^(welcome to|in today'?s|in this (article|post|guide|blog)|are you (looking|searching|wondering)|have you ever|looking for|if you'?re (looking|wondering)|we are (a|the) (leading|premier)|thank you for visiting|hello and welcome|did you know)/i;

/** Marketing words that say nothing an engine can quote. */
export const HYPE_WORDS = [
  'world-class',
  'cutting-edge',
  'best-in-class',
  'industry-leading',
  'state-of-the-art',
  'next-generation',
  'next-gen',
  'revolutionary',
  'game-changing',
  'game changer',
  'unparalleled',
  'unrivalled',
  'unrivaled',
  'seamless',
  'seamlessly',
  'synergy',
  'synergies',
  'innovative solutions',
  'robust solutions',
  'leverage',
  'holistic',
  'bespoke solutions',
  'one-stop shop',
  'second to none',
  'top-notch',
  'unmatched',
  'disruptive',
  'turnkey',
  'paradigm',
  'supercharge',
];

const AUTHORITY_HOSTS =
  /(\.gov(\.[a-z]{2})?|\.edu|\.ac\.[a-z]{2}|\.int|wikipedia\.org|doi\.org|ncbi\.nlm\.nih\.gov|who\.int|europa\.eu|ons\.gov\.uk|oecd\.org|worldbank\.org|imf\.org|nature\.com|sciencedirect\.com|arxiv\.org|w3\.org|ietf\.org|rfc-editor\.org|iso\.org|developers\.google\.com|statista\.com|pewresearch\.org|gartner\.com|mckinsey\.com|reuters\.com|bbc\.co\.uk|ft\.com)$/i;

const FIRST_HAND_RE =
  /\b(we (tested|measured|surveyed|analys(?:ed|ed)|analyzed|interviewed|found|built|ran|tracked|benchmarked)|our (data|survey|research|analysis|tests?|benchmark|study|findings|experience)|in our (tests?|experience|study|survey)|case study|we have (built|delivered|worked))\b/i;

const TLDR_RE =
  /\b(tl;?dr|key takeaways?|in (short|brief|summary)|summary|at a glance|quick answer|the short answer|bottom line)\b/i;

export interface GeoSignals {
  words: number;
  h1: string | null;
  headings: { level: number; text: string }[];
  subheadings: number;
  questionHeadings: { text: string; answerWords: number }[];
  lead: string;
  leadWords: number;
  leadFiller: boolean;
  leadIsQuestion: boolean;
  lists: number;
  tables: number;
  numbers: number;
  stats: number;
  externalLinks: string[];
  authorityLinks: number;
  internalMainLinks: number;
  faqHeading: boolean;
  faqSchemaQuestions: { q: string; a: string }[];
  bylineVisible: string | null;
  authorSchema: JsonNode | null;
  authorName: string | null;
  visibleDate: string | null;
  datePublished: string | null;
  dateModified: string | null;
  sectionWords: number[];
  longParagraphs: number;
  hype: string[];
  tldr: boolean;
  blockquotes: number;
  blockquotesUnattributed: number;
  firstHand: boolean;
  ordered: number;
  properNouns: number;
}

function textOf(el: { textContent?: string | null } | null | undefined): string {
  return collapse(el?.textContent ?? '');
}

const ARTICLE_TYPES = [
  'Article',
  'BlogPosting',
  'NewsArticle',
  'TechArticle',
  'Report',
  'HowTo',
  'WebPage',
  'AboutPage',
  'FAQPage',
  'QAPage',
  'CollectionPage',
  'ItemPage',
  'ProfilePage',
];

export function geoSignals(page: PageData): GeoSignals {
  return memo(page, 'geoSignals', () => compute(page));
}

function compute(page: PageData): GeoSignals {
  const doc = pageDoc(page);
  const root = doc ? mainRoot(doc) : null;
  const html = (root as unknown as { innerHTML?: string } | null)?.innerHTML ?? page.html ?? '';
  const mainText = page.mainText || page.text || roughText(html);
  const words = page.wordCount || countWords(mainText);
  const headings = (page.headings ?? []).map((h) => ({ level: h.level, text: collapse(h.text) }));
  const h1 = headings.find((h) => h.level === 1)?.text ?? null;
  const subs = headings.filter((h) => h.level >= 2 && h.level <= 4);

  // Sections split at H2–H4 inside the main content.
  const chunks = html.split(/<h[2-4]\b[^>]*>/i);
  const sectionWords = chunks
    .slice(1)
    .map((c) => countWords(roughText(c.replace(/^[\s\S]*?<\/h[2-4]>/i, ''))));

  // Question headings and the length of the first paragraph under each.
  const questionHeadings: GeoSignals['questionHeadings'] = [];
  const headingBlocks = [
    ...html.matchAll(/<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>([\s\S]*?)(?=<h[1-4]\b|$)/gi),
  ];
  for (const m of headingBlocks) {
    const text = collapse(roughText(m[2]!));
    if (!(text.endsWith('?') || QUESTION_RE.test(text))) continue;
    const firstP = m[3]!.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? m[3]!;
    questionHeadings.push({ text, answerWords: countWords(roughText(firstP)) });
  }
  if (!headingBlocks.length) {
    for (const h of subs)
      if (h.text.endsWith('?') || QUESTION_RE.test(h.text))
        questionHeadings.push({ text: h.text, answerWords: 0 });
  }

  const lead = page.lead ? collapse(page.lead) : firstWords(mainText, 60);
  const leadFirst = firstWords(lead, 60);

  const q = (sel: string) =>
    root ? [...(root as unknown as ParentNode).querySelectorAll(sel)] : [];
  const lists = q('ul, ol').filter(
    (l) => q('nav ul, nav ol, header ul, footer ul').indexOf(l) === -1,
  ).length;
  const ordered = q('ol').length;
  const tables = q('table').length;

  const numbers = (
    mainText.match(
      /(?:[£$€¥₹]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:%|percent|per cent|k\b|m\b|bn\b)|\b(19|20)\d{2}\b|\b\d{2,}[\d,.]*\b)/gi,
    ) ?? []
  ).length;
  const stats = (
    mainText.match(
      /(?:\b\d[\d,.]*\s?(?:%|percent|per cent)|[£$€]\s?\d[\d,.]*\s?(?:m|bn|million|billion)?|\b\d+(?:\.\d+)?x\b|\b\d+ (?:out of|in) \d+\b)/gi,
    ) ?? []
  ).length;

  const mainLinks = (page.links ?? []).filter(
    (l) => (l.region ?? 'main') === 'main' || l.region === 'other',
  );
  const externalLinks = [
    ...new Set(
      mainLinks.filter((l) => !l.internal && !sameSite(l.href, page.url)).map((l) => l.href),
    ),
  ];
  const authorityLinks = externalLinks.filter((u) =>
    AUTHORITY_HOSTS.test(safeUrl(u)?.hostname ?? ''),
  ).length;
  const internalMainLinks = new Set(mainLinks.filter((l) => l.internal).map((l) => l.href)).size;

  const faqHeading = headings.some((h) =>
    /\b(faqs?|frequently asked|questions and answers|common questions|q&a)\b/i.test(h.text),
  );
  const faqSchemaQuestions: GeoSignals['faqSchemaQuestions'] = [];
  for (const n of nodesOfType(page, ['FAQPage'])) {
    const items = Array.isArray(n.mainEntity) ? n.mainEntity : n.mainEntity ? [n.mainEntity] : [];
    for (const it of items as JsonNode[]) {
      if (!it || typeof it !== 'object') continue;
      const ans = it.acceptedAnswer as JsonNode | JsonNode[] | undefined;
      const a = Array.isArray(ans) ? ans[0] : ans;
      faqSchemaQuestions.push({
        q: str(it.name) ?? '',
        a: roughText(String((a && (a.text as string)) ?? '')),
      });
    }
  }

  // Author: visible byline and schema author.
  let bylineVisible: string | null = null;
  if (doc) {
    const el = doc.querySelector(
      '[rel~="author"], [itemprop="author"], .author, .byline, .post-author, .entry-author, [class*="byline"], [class*="author-name"]',
    );
    const t = textOf(el as unknown as Element);
    if (t && t.length < 120) bylineVisible = t;
  }
  if (!bylineVisible) {
    const m = mainText
      .slice(0, 1500)
      .match(/\b(?:by|written by|author:)\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})/u);
    if (m) bylineVisible = m[1]!;
  }
  const articles = nodesOfType(page, ARTICLE_TYPES);
  let authorSchema: JsonNode | null = null;
  let authorName: string | null = null;
  let datePublished: string | null = null;
  let dateModified: string | null = null;
  for (const a of articles) {
    const au = Array.isArray(a.author) ? a.author[0] : a.author;
    if (au && !authorSchema) {
      authorSchema =
        typeof au === 'object' ? (au as JsonNode) : { '@type': 'Person', name: String(au) };
      authorName = str(au);
    }
    datePublished ??= str(a.datePublished);
    dateModified ??= str(a.dateModified);
  }

  let visibleDate: string | null = null;
  if (doc) {
    const t = doc.querySelector('time[datetime], time');
    visibleDate = t?.getAttribute('datetime') || textOf(t as unknown as Element) || null;
  }
  if (!visibleDate) {
    const m = mainText
      .slice(0, 3000)
      .match(
        /\b(?:(?:published|updated|last updated|posted|modified)\s*(?:on)?:?\s*)?(\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})\b/i,
      );
    if (m) visibleDate = m[1]!;
  }

  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) =>
    countWords(roughText(m[1]!)),
  );
  const lower = ` ${mainText.toLowerCase()} `;
  const hype = HYPE_WORDS.filter((w) => lower.includes(` ${w}`) || lower.includes(`${w} `));

  const quotes = q('blockquote');
  const unattributed = quotes.filter((b) => {
    const el = b as unknown as Element;
    return (
      !el.getAttribute('cite') &&
      !el.querySelector('cite, footer, figcaption') &&
      !/[—–-]\s*[A-Z]/.test(el.textContent ?? '')
    );
  }).length;

  const properNouns = (
    mainText.match(/(?<![.!?]\s)(?<!^)\b[A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})*/gm) ?? []
  ).length;

  return {
    words,
    h1,
    headings,
    subheadings: subs.length,
    questionHeadings,
    lead: leadFirst,
    leadWords: countWords(leadFirst),
    leadFiller: FILLER_RE.test(leadFirst),
    leadIsQuestion: /^[^.!]{3,160}\?/.test(leadFirst),
    lists,
    tables,
    numbers,
    stats,
    externalLinks,
    authorityLinks,
    internalMainLinks,
    faqHeading,
    faqSchemaQuestions,
    bylineVisible,
    authorSchema,
    authorName,
    visibleDate,
    datePublished,
    dateModified,
    sectionWords,
    longParagraphs: paragraphs.filter((n) => n > 150).length,
    hype,
    tldr:
      TLDR_RE.test(firstWords(mainText, 250)) ||
      headings.slice(0, 4).some((h) => TLDR_RE.test(h.text)),
    blockquotes: quotes.length,
    blockquotesUnattributed: unattributed,
    firstHand: FIRST_HAND_RE.test(mainText),
    ordered,
    properNouns,
  };
}

export interface GeoScore {
  score: number;
  parts: { label: string; earned: number; max: number; note: string }[];
  tips: string[];
}

/**
 * Page-level GEO score, 0–100: how easily an answer engine can lift, trust and
 * attribute this page. Every tip names something specific to the page.
 */
export function geoPageScore(page: PageData): GeoScore {
  return memo(page, 'geoScore', () => {
    const s = geoSignals(page);
    const parts: GeoScore['parts'] = [];
    const tips: { w: number; t: string }[] = [];
    const part = (label: string, earned: number, max: number, note: string, tip?: string) => {
      parts.push({ label, earned, max, note });
      if (tip && earned < max) tips.push({ w: max - earned, t: tip });
    };

    const leadOk = s.leadWords >= 15 && !s.leadFiller && !s.leadIsQuestion;
    part(
      'Answer-first opening',
      leadOk ? 15 : s.leadWords >= 15 ? 6 : 0,
      15,
      leadOk
        ? 'Opens with a statement'
        : s.leadFiller
          ? 'Opens with filler'
          : s.leadIsQuestion
            ? 'Opens with a question'
            : 'Opening too short',
      'Open with one or two sentences that answer the page’s main question directly, before any background.',
    );

    const qn = s.questionHeadings.length;
    part(
      'Question-shaped headings',
      qn >= 3 ? 10 : qn === 2 ? 7 : qn === 1 ? 4 : 0,
      10,
      `${qn} of ${s.subheadings} subheadings`,
      'Phrase some subheadings as the questions people ask, and answer each in the first sentence below it.',
    );

    const faqSchema = s.faqSchemaQuestions.length > 0;
    part(
      'FAQ content',
      faqSchema ? 10 : s.faqHeading || qn >= 3 ? 5 : 0,
      10,
      faqSchema
        ? `FAQPage with ${s.faqSchemaQuestions.length} questions`
        : s.faqHeading
          ? 'FAQ section, no FAQPage markup'
          : 'None',
      s.faqHeading
        ? 'Mark up the FAQ section with FAQPage JSON-LD.'
        : 'Add a short FAQ answering real customer questions.',
    );

    const structure = (s.lists > 0 ? 6 : 0) + (s.tables > 0 ? 4 : 0);
    part(
      'Lists and tables',
      s.words < 300 ? 10 : Math.min(10, structure),
      10,
      `${s.lists} lists, ${s.tables} tables`,
      'Put steps, options and comparisons in lists or tables; engines lift them whole.',
    );

    part(
      'Specific figures',
      s.numbers >= 5 ? 10 : s.numbers >= 2 ? 6 : s.numbers === 1 ? 3 : 0,
      10,
      `${s.numbers} figures`,
      'State concrete figures: prices, timescales, quantities, dates.',
    );

    part(
      'Cited sources',
      s.authorityLinks >= 1
        ? 10
        : s.externalLinks.length >= 2
          ? 7
          : s.externalLinks.length === 1
            ? 4
            : 0,
      10,
      `${s.externalLinks.length} outbound, ${s.authorityLinks} authoritative`,
      'Link claims to their primary sources (standards, official statistics, research).',
    );

    const authorPts = (s.bylineVisible ? 5 : 0) + (s.authorSchema ? 5 : 0);
    part(
      'Author',
      authorPts,
      10,
      s.bylineVisible ?? s.authorName ?? 'none',
      'Show who wrote or reviewed the page, and name them as author in the page’s Article schema.',
    );

    const datePts = (s.visibleDate ? 5 : 0) + (s.dateModified || s.datePublished ? 5 : 0);
    part(
      'Freshness',
      datePts,
      10,
      s.dateModified ?? s.datePublished ?? s.visibleDate ?? 'no date',
      'Show a published or last-updated date and add datePublished/dateModified to the schema.',
    );

    const longSections = s.sectionWords.filter((n) => n > 400).length;
    const chunk = Math.max(
      0,
      10 -
        longSections * 3 -
        Math.min(4, s.longParagraphs * 2) -
        (s.words >= 600 && s.subheadings < 2 ? 4 : 0),
    );
    part(
      'Chunkable sections',
      chunk,
      10,
      `${longSections} long sections, ${s.longParagraphs} long paragraphs`,
      'Break long sections under more subheadings and keep paragraphs under about 120 words, so each passage stands on its own.',
    );

    part(
      'Plain language',
      s.hype.length === 0 ? 5 : s.hype.length <= 2 ? 3 : 0,
      5,
      s.hype.length ? s.hype.slice(0, 4).join(', ') : 'none',
      `Replace vague claims (${s.hype.slice(0, 3).join(', ')}) with what you actually do and for whom.`,
    );

    const score = Math.round(parts.reduce((n, p) => n + p.earned, 0));
    return {
      score,
      parts,
      tips: tips
        .sort((a, b) => b.w - a.w)
        .slice(0, 5)
        .map((x) => x.t),
    };
  });
}
