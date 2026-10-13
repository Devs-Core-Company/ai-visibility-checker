/**
 * JavaScript rendering: what changes between the raw HTML (what most AI
 * crawlers see) and the page after JavaScript runs (what Google renders).
 * Every check here needs rendered pages.
 */
import type { PageData } from '../core/types.js';
import {
  REF,
  declaredCanonical,
  doc,
  isHtml200,
  list,
  normText,
  pageCheck,
  plural,
  rawHead,
  renderedDoc,
  sameUrl,
  truncate,
} from './_util.js';

export const EMPTY_SHELL_RAW_WORDS = 50;
export const EMPTY_SHELL_RENDERED_WORDS = 200;
export const CONTENT_GAP_RATIO = 0.5;
export const CONTENT_GAP_MIN_WORDS = 150;
export const LINK_GAP_MIN = 10;
export const CONTENT_REMOVED_RATIO = 0.5;

const T = 'technical' as const;
const R = ['render'] as const;

function r(page: PageData) {
  return isHtml200(page) ? page.rendered : undefined;
}

function renderedMeta(page: PageData, name: string): string | null {
  const d = renderedDoc(page);
  if (!d) return null;
  const el = d.querySelector(`meta[name="${name}" i]`);
  return el ? el.getAttribute('content') : null;
}

function renderedCanonical(page: PageData): string | null {
  const d = renderedDoc(page);
  const href = d?.querySelector('link[rel="canonical"]')?.getAttribute('href');
  if (!href) return null;
  try {
    return new URL(href, page.finalUrl || page.url).toString();
  } catch {
    return null;
  }
}

function rawMetaRobots(page: PageData): string {
  return (
    /<meta[^>]+name=["']?robots["']?[^>]*content=["']([^"']*)/i.exec(
      rawHead(page.html || ''),
    )?.[1] ??
    page.metaRobots ??
    ''
  );
}

/** Short "loading" texts: Loading…, Loading prices..., Please wait, Fetching data… */
const PLACEHOLDER =
  /^(?:loading|fetching|please wait|one moment|retrieving|getting)\b[^.!?]{0,40}(?:\.{3}|…|\.)?$/i;

/** Placeholder texts in the main content (elements with at most six words). */
function placeholders(d: Document): string[] {
  const root =
    d.querySelector('main, [role="main"]') ?? d.querySelector('article') ?? d.body ?? null;
  if (!root) return [];
  const out: string[] = [];
  for (const el of Array.from(root.querySelectorAll('p, div, span, li, td, h2, h3'))) {
    if (el.children.length > 1) continue;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.split(' ').length <= 6 && PLACEHOLDER.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

export const checks = [
  pageCheck(
    {
      id: 'js-rendering.client-only',
      category: 'js-rendering',
      pillar: T,
      title: 'Content only appears after JavaScript runs',
      why: 'The raw HTML is almost empty and the content is built in the browser. GPTBot, ClaudeBot, PerplexityBot and most other AI crawlers do not run JavaScript, so they see a blank page.',
      severity: 'critical',
      fixTier: 'guided',
      fix: 'Render the page on the server or pre-render it at build time (SSR/SSG), so the HTML response already contains the text, links and headings.',
      requires: [...R],
      refs: [REF.js, 'https://web.dev/articles/rendering-on-the-web'],
      tags: ['ai-crawlers'],
    },
    (page) => {
      const rd = r(page);
      if (!rd) return null;
      if (page.wordCount >= EMPTY_SHELL_RAW_WORDS || rd.wordCount < EMPTY_SHELL_RENDERED_WORDS)
        return null;
      return {
        checkId: 'js-rendering.client-only',
        message: `Raw HTML has ${page.wordCount} words; after JavaScript the page has ${rd.wordCount}`,
      };
    },
  ),
  pageCheck(
    {
      id: 'js-rendering.content-gap',
      category: 'js-rendering',
      pillar: T,
      title: 'Much of the content depends on JavaScript',
      why: 'A large share of the text is added by JavaScript. Crawlers that read only the HTML response, including most AI crawlers, miss it.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Server-render the main content (descriptions, FAQs, reviews, specs). Keep JavaScript for interactivity.',
      requires: [...R],
      refs: [REF.js],
      tags: ['ai-crawlers'],
    },
    (page) => {
      const rd = r(page);
      if (!rd || page.wordCount < EMPTY_SHELL_RAW_WORDS) return null; // client-only covers the empty case
      if (
        rd.wordCount - page.wordCount < CONTENT_GAP_MIN_WORDS ||
        page.wordCount / rd.wordCount > CONTENT_GAP_RATIO
      )
        return null;
      return {
        checkId: 'js-rendering.content-gap',
        message: `${Math.round((1 - page.wordCount / rd.wordCount) * 100)}% of the words appear only after JavaScript (${page.wordCount} raw vs ${rd.wordCount} rendered)`,
      };
    },
  ),
  pageCheck(
    {
      id: 'js-rendering.loading-placeholder',
      category: 'js-rendering',
      pillar: T,
      title: 'Main content is a loading placeholder until JavaScript runs',
      why: 'The HTML response shows a placeholder such as "Loading…" where the content should be, and a script fills it in later (usually from an API). Crawlers that do not run JavaScript, including most AI crawlers, index the placeholder instead of the content.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Render this content on the server (or at build time) so it is in the HTML response, and keep JavaScript for updates. If the data changes often, render the current values and refresh them client-side.',
      requires: [...R],
      refs: [REF.js, 'https://web.dev/articles/rendering-on-the-web'],
      tags: ['ai-crawlers'],
    },
    (page) => {
      const rd = r(page);
      if (!rd) return null;
      const raw = placeholders(doc(page));
      if (!raw.length) return null;
      const rdoc = renderedDoc(page);
      if (!rdoc) return null;
      const after = new Set(placeholders(rdoc).map(normText));
      // The placeholder was replaced, and the page gained text in its place.
      const gone = raw.filter((t) => !after.has(normText(t)));
      if (!gone.length || rd.wordCount <= page.wordCount) return null;
      return {
        checkId: 'js-rendering.loading-placeholder',
        message: `The HTML shows ${list(
          gone.map((t) => `"${truncate(t, 40)}"`),
          2,
        )} where JavaScript later adds ${rd.wordCount - page.wordCount} words`,
        evidence: list(gone, 2),
      };
    },
  ),
  pageCheck(
    {
      id: 'js-rendering.content-removed',
      category: 'js-rendering',
      pillar: T,
      title: 'JavaScript removes content after load',
      why: 'The rendered page has far less text than the HTML. Google indexes the rendered version, so content may vanish from search, often because of a client-side error or a consent wall.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Check the console errors for this page and make sure hydration does not replace server content with an empty or error state.',
      requires: [...R],
      refs: [REF.js],
    },
    (page) => {
      const rd = r(page);
      if (!rd || page.wordCount < CONTENT_GAP_MIN_WORDS) return null;
      if (rd.wordCount >= page.wordCount * CONTENT_REMOVED_RATIO) return null;
      return {
        checkId: 'js-rendering.content-removed',
        message: `${page.wordCount} words in the HTML but only ${rd.wordCount} after rendering`,
      };
    },
  ),
  pageCheck(
    {
      id: 'js-rendering.links-only-rendered',
      category: 'js-rendering',
      pillar: T,
      title: 'Links added only by JavaScript',
      why: 'Crawlers that do not render cannot follow links that are inserted by JavaScript, so the pages they lead to may never be discovered.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Output navigation and content links as <a href> in the server HTML.',
      requires: [...R],
      refs: [REF.links],
    },
    (page) => {
      const rd = r(page);
      if (!rd) return null;
      const raw = page.links.length;
      if (rd.links - raw < LINK_GAP_MIN || rd.links < raw * 1.5) return null;
      return {
        checkId: 'js-rendering.links-only-rendered',
        message: `${raw} links in the HTML, ${rd.links} after rendering`,
      };
    },
  ),
  pageCheck(
    {
      id: 'js-rendering.title-changed',
      category: 'js-rendering',
      pillar: T,
      title: 'JavaScript changes or adds the title',
      why: 'Non-rendering crawlers see the raw title, Google may see the rendered one. Different titles send mixed signals, and a missing raw title leaves AI crawlers with none.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Output the final title in the server HTML (for example with your framework’s metadata API).',
      requires: [...R],
      refs: [REF.titles],
    },
    (page) => {
      const rd = r(page);
      if (!rd || !rd.title) return null;
      const raw = normText(page.title);
      if (raw === normText(rd.title)) return null;
      return {
        checkId: 'js-rendering.title-changed',
        severity: raw ? 'medium' : 'high',
        message: raw ? 'Title differs after rendering' : 'Title exists only after rendering',
        evidence: `raw: ${truncate(page.title || '(none)', 80)} | rendered: ${truncate(rd.title, 80)}`,
      };
    },
  ),
  pageCheck(
    {
      id: 'js-rendering.h1-only-rendered',
      category: 'js-rendering',
      pillar: T,
      title: 'H1 appears only after JavaScript',
      why: 'Crawlers reading the HTML response see a page with no main heading.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Render the H1 on the server.',
      requires: [...R],
    },
    (page) => {
      const rd = r(page);
      if (
        !rd ||
        page.headings.some((h) => h.level === 1) ||
        !rd.headings.some((h) => h.level === 1)
      )
        return null;
      return {
        checkId: 'js-rendering.h1-only-rendered',
        message: 'No H1 in the HTML; one appears after rendering',
        evidence: truncate(rd.headings.find((h) => h.level === 1)!.text, 100),
      };
    },
  ),
  pageCheck(
    {
      id: 'js-rendering.schema-only-rendered',
      category: 'js-rendering',
      pillar: T,
      title: 'Structured data added only by JavaScript',
      why: 'Google can read JSON-LD injected by JavaScript, but most other consumers, including AI crawlers and many SEO tools, cannot.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Output JSON-LD in the server HTML (Google Tag Manager–injected schema is the usual culprit).',
      requires: [...R],
      refs: [
        'https://developers.google.com/search/docs/appearance/structured-data/generate-structured-data-with-javascript',
      ],
    },
    (page) => {
      const rd = r(page);
      if (!rd) return null;
      const raw = new Set(page.structuredData.flatMap((s) => s.types));
      const extra = [...new Set(rd.structuredData.flatMap((s) => s.types))].filter(
        (t) => !raw.has(t),
      );
      return extra.length
        ? {
            checkId: 'js-rendering.schema-only-rendered',
            message: `${list(extra)} only present after rendering`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'js-rendering.canonical-changed',
      category: 'js-rendering',
      pillar: T,
      title: 'JavaScript changes the canonical',
      why: 'Google warns against changing the canonical with JavaScript: it may use either value, and non-rendering crawlers only see the original.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Set the correct canonical in the server HTML and do not modify it client-side.',
      requires: [...R],
      refs: [REF.canonical, REF.js],
    },
    (page) => {
      const rd = r(page);
      if (!rd) return null;
      const raw = declaredCanonical(page);
      const ren = renderedCanonical(page);
      if (!ren || sameUrl(raw, ren)) return null;
      return {
        checkId: 'js-rendering.canonical-changed',
        message: raw
          ? 'Canonical differs after rendering'
          : 'Canonical exists only after rendering',
        evidence: `raw: ${raw ?? '(none)'} | rendered: ${ren}`,
      };
    },
  ),
  pageCheck(
    {
      id: 'js-rendering.robots-changed',
      category: 'js-rendering',
      pillar: T,
      title: 'JavaScript changes the robots meta tag',
      why: 'If the raw HTML says noindex, Google may not render the page at all, so removing it with JavaScript does not work. Adding noindex with JavaScript hides the page from Google but not from other crawlers.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Set the robots directive in the server response only.',
      requires: [...R],
      refs: [
        'https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics#use-meta-robots-tags-carefully',
      ],
    },
    (page) => {
      const rd = r(page);
      if (!rd) return null;
      const raw = /noindex|none/i.test(rawMetaRobots(page));
      const ren = /noindex|none/i.test(renderedMeta(page, 'robots') || '');
      if (raw === ren) return null;
      return {
        checkId: 'js-rendering.robots-changed',
        message: raw
          ? 'Raw HTML is noindex but the rendered page is not'
          : 'Rendered page adds noindex that the raw HTML does not have',
      };
    },
  ),
  pageCheck(
    {
      id: 'js-rendering.description-changed',
      category: 'js-rendering',
      pillar: T,
      title: 'JavaScript changes the meta description',
      why: 'Different raw and rendered descriptions mean different crawlers show different snippets.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Output the final meta description in the server HTML.',
      requires: [...R],
      refs: [REF.snippets],
    },
    (page) => {
      const rd = r(page);
      if (!rd) return null;
      const ren = renderedMeta(page, 'description');
      if (ren == null || normText(ren) === normText(page.metaDescription)) return null;
      return {
        checkId: 'js-rendering.description-changed',
        message: page.metaDescription
          ? 'Description differs after rendering'
          : 'Description exists only after rendering',
        evidence: truncate(ren, 160),
      };
    },
  ),
  pageCheck(
    {
      id: 'js-rendering.console-errors',
      category: 'js-rendering',
      pillar: T,
      title: 'JavaScript errors while rendering',
      why: 'Script errors can stop content, links or structured data from appearing in the rendered page that Google indexes, and break the page for visitors and AI agents.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Open the page with the browser console and fix the errors listed.',
      requires: [...R],
    },
    (page) => {
      const rd = r(page);
      if (!rd || !rd.consoleErrors.length) return null;
      return {
        checkId: 'js-rendering.console-errors',
        severity: rd.consoleErrors.length >= 5 ? 'medium' : 'low',
        message: `${plural(rd.consoleErrors.length, 'console error')}`,
        evidence: truncate(rd.consoleErrors.slice(0, 3).join(' | '), 400),
      };
    },
  ),
  pageCheck(
    {
      id: 'js-rendering.failed-requests',
      category: 'js-rendering',
      pillar: T,
      title: 'Resources failed to load during rendering',
      why: 'Failed scripts, styles or API calls can leave the rendered page incomplete. If an API is blocked for bots, crawlers get the broken version.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Fix or remove the failing requests; make sure APIs the page needs are not blocked by robots.txt or bot protection.',
      requires: [...R],
    },
    (page) => {
      const rd = r(page);
      if (!rd || !rd.failedRequests.length) return null;
      const important = rd.failedRequests.filter(
        (u) =>
          !/google-analytics|googletagmanager|doubleclick|facebook|hotjar|clarity|segment|sentry|intercom/i.test(
            u,
          ),
      );
      if (!important.length) return null;
      return {
        checkId: 'js-rendering.failed-requests',
        message: `${plural(important.length, 'request')} failed`,
        evidence: list(important, 3),
      };
    },
  ),
];
