/**
 * llms.txt parsing and grading, per the llmstxt.org proposal:
 *   # Name                         (one H1, required)
 *   > Short summary                 (blockquote, optional but expected)
 *   Free-form details               (optional)
 *   ## Section                      (H2 sections of link lists)
 *   - [Title](https://url): notes
 *   ## Optional                     (links a model may skip when short of context)
 */
import type { SiteContext } from '../core/types.js';
import {
  homePage,
  inlinkCount,
  memo,
  probe,
  safeUrl,
  topLinkedPages,
  urlKey,
} from '../checks/_ai-util.js';

export interface LlmsLink {
  text: string;
  url: string; // as written
  abs: string | null; // resolved against the file URL
  note: string | null;
  line: number;
  section: string;
}

export interface LlmsParsed {
  title: string | null;
  h1Count: number;
  firstIsH1: boolean;
  summary: string | null;
  details: string;
  sections: { name: string; line: number; links: number }[];
  links: LlmsLink[];
  nonLinkItems: { line: number; text: string }[];
  relativeLinks: number;
  bytes: number;
  lines: number;
}

export function parseLlmsTxt(body: string, fileUrl = 'https://example.com/llms.txt'): LlmsParsed {
  const lines = body.replace(/^﻿/, '').split(/\r?\n/);
  const firstContent = lines.find((l) => l.trim().length > 0) ?? '';
  const out: LlmsParsed = {
    title: null,
    h1Count: 0,
    firstIsH1: /^#\s+\S/.test(firstContent),
    summary: null,
    details: '',
    sections: [],
    links: [],
    nonLinkItems: [],
    relativeLinks: 0,
    bytes: Buffer.byteLength(body),
    lines: lines.length,
  };
  let section: LlmsParsed['sections'][number] | null = null;
  let inFence = false;
  const details: string[] = [];
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (/^\s*```/.test(raw)) inFence = !inFence;
    if (inFence) return;
    const h1 = raw.match(/^#\s+(.+?)\s*#*\s*$/);
    if (h1) {
      out.h1Count++;
      if (!out.title) out.title = h1[1]!.trim();
      return;
    }
    const h2 = raw.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h2) {
      section = { name: h2[1]!.trim(), line, links: 0 };
      out.sections.push(section);
      return;
    }
    if (!section) {
      const q = raw.match(/^>\s?(.*)$/);
      if (q && out.summary === null && q[1]!.trim()) {
        out.summary = q[1]!.trim();
        return;
      }
      if (q && out.summary !== null) {
        out.summary += ` ${q[1]!.trim()}`;
        return;
      }
    }
    const item = raw.match(/^\s*[-*+]\s+(.*)$/);
    const link = (item?.[1] ?? '').match(
      /^\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*(?::\s*(.*))?$/,
    );
    if (item && link) {
      const url = link[2]!;
      const abs = safeUrl(url, fileUrl)?.toString() ?? null;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) out.relativeLinks++;
      out.links.push({
        text: link[1]!.trim(),
        url,
        abs,
        note: link[3]?.trim() || null,
        line,
        section: section?.name ?? '',
      });
      if (section) section.links++;
      return;
    }
    if (item && section) {
      out.nonLinkItems.push({ line, text: item[1]!.trim() });
      return;
    }
    if (!section && raw.trim()) details.push(raw.trim());
  });
  out.details = details.join(' ');
  return out;
}

export interface LlmsGrade {
  grade: number;
  parts: { label: string; earned: number; max: number; note: string }[];
  reasons: string[];
}

/** Key pages: the home page plus the most-linked indexable pages. */
export function keyPages(site: SiteContext, n = 10): string[] {
  return memo(site, `keyPages:${n}`, () => {
    const out: string[] = [];
    const home = homePage(site);
    if (home) out.push(home.finalUrl || home.url);
    for (const p of topLinkedPages(site, n))
      if (inlinkCount(site, p.url) >= 2) out.push(p.finalUrl || p.url);
    return out;
  });
}

export function llmsParsed(site: SiteContext): LlmsParsed | null {
  const p = probe(site, 'llms-txt');
  if (!p?.found) return null;
  const parsed = p.parsed as LlmsParsed | undefined;
  if (parsed && Array.isArray(parsed.links)) return parsed;
  return memo(site, 'llmsParsed', () => parseLlmsTxt(p.body ?? '', p.url));
}

/**
 * 0–100 quality grade for /llms.txt with reasons, or null when there is none.
 * Uses only data already gathered (probe + crawl); never fetches.
 */
export function llmsTxtGrade(site: SiteContext): LlmsGrade | null {
  const parsed = llmsParsed(site);
  if (!parsed) return null;
  const parts: LlmsGrade['parts'] = [];
  const reasons: string[] = [];
  const add = (label: string, earned: number, max: number, note: string, reason?: string) => {
    parts.push({ label, earned, max, note });
    if (reason && earned < max) reasons.push(reason);
  };

  add(
    'Title (H1)',
    parsed.firstIsH1 && parsed.h1Count === 1 ? 15 : parsed.title ? 8 : 0,
    15,
    parsed.title ? `“${parsed.title}”` : 'none',
    parsed.title
      ? 'Start the file with exactly one H1.'
      : 'Add an H1 with the site or company name as the first line.',
  );
  add(
    'Summary',
    parsed.summary ? (parsed.summary.length >= 40 ? 10 : 6) : 0,
    10,
    parsed.summary ? `${parsed.summary.length} characters` : 'none',
    'Add a one or two sentence blockquote (> …) saying what the site is and who it is for.',
  );
  add(
    'Sections',
    parsed.sections.length >= 2 ? 10 : parsed.sections.length === 1 ? 6 : 0,
    10,
    `${parsed.sections.length} H2 sections`,
    'Group links under H2 sections such as ## Services, ## Guides, ## Company.',
  );
  const n = parsed.links.length;
  add(
    'Links',
    n >= 8 ? 15 : n >= 4 ? 10 : n >= 1 ? 5 : 0,
    15,
    `${n} links`,
    'List your key pages as markdown links.',
  );
  if (n > 400) {
    parts[parts.length - 1]!.earned = 8;
    reasons.push(
      `${n} links reads as a dump of the sitemap; keep llms.txt to the pages that matter and move the rest to llms-full.txt or the sitemap.`,
    );
  }
  const described = parsed.links.filter((l) => l.note && l.note.length >= 10).length;
  add(
    'Link notes',
    n ? Math.round((described / n) * 10) : 0,
    10,
    `${described} of ${n} links have a note`,
    'Add a short note after each link (- [Pricing](url): what each plan includes) so a model knows when to open it.',
  );
  add(
    'Absolute URLs',
    parsed.relativeLinks === 0 && n ? 5 : 0,
    5,
    `${parsed.relativeLinks} relative`,
    'Use absolute https:// URLs.',
  );

  // Coverage of key pages.
  const listed = new Set(parsed.links.map((l) => urlKey(l.abs ?? l.url)));
  const keys = keyPages(site, 10);
  const covered = keys.filter((k) => listed.has(urlKey(k))).length;
  const coverage = keys.length ? covered / keys.length : 1;
  add(
    'Key pages listed',
    Math.round(coverage * 20),
    20,
    `${covered} of ${keys.length} key pages`,
    'Include your most important pages (the ones most linked from your own navigation).',
  );

  // Links that point at crawled pages with problems.
  let bad = 0;
  let known = 0;
  for (const l of parsed.links) {
    const page = l.abs
      ? (site.pages.get(l.abs) ??
        [...site.pages.values()].find((p) => urlKey(p.url) === urlKey(l.abs!)))
      : undefined;
    if (!page) continue;
    known++;
    if (page.status >= 400 || page.status === 0) bad++;
  }
  add(
    'Links resolve',
    known ? Math.round(((known - bad) / known) * 10) : 10,
    10,
    `${bad} broken among ${known} crawled`,
    'Fix or remove links that return errors.',
  );
  add(
    'Size',
    parsed.bytes <= 50_000 ? 5 : parsed.bytes <= 200_000 ? 2 : 0,
    5,
    `${Math.round(parsed.bytes / 1024)} KB`,
    'Keep llms.txt short (under about 50 KB) so it fits in a model’s context alongside the question.',
  );

  const grade = Math.max(
    0,
    Math.min(
      100,
      parts.reduce((s, p) => s + p.earned, 0),
    ),
  );
  return { grade, parts, reasons };
}
