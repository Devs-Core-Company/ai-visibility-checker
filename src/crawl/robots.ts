/**
 * robots.txt loading and evaluation (RFC 9309), wrapping robots-parser.
 *
 * - 2xx with a text body: parsed.
 * - 4xx (incl. 404): no rules, everything allowed.
 * - 5xx or network failure: per RFC 9309 §2.3.1.4 crawlers treat the whole
 *   site as disallowed. `isAllowed` returns false and `decidingLine` explains.
 * - A 2xx that is actually an HTML page (soft 404) counts as not found.
 */
import robotsParserModule from 'robots-parser';
import type { Fetcher, RobotsInfo } from '../core/types.js';

interface RobotRules {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getMatchingLineNumber(url: string, ua?: string): number;
  getSitemaps(): string[];
}
// robots-parser is CommonJS; its typings describe an ES default export.
const robotsParser = ((robotsParserModule as unknown as { default?: unknown }).default ??
  robotsParserModule) as unknown as (url: string, body: string) => RobotRules;

const MAX_ROBOTS_BYTES = 500 * 1024; // Google reads the first 500 KiB.

export async function loadRobots(origin: string, fetcher: Fetcher): Promise<RobotsInfo> {
  const url = new URL('/robots.txt', origin).toString();
  const res = await fetcher.fetch(url, {
    headers: { accept: 'text/plain,*/*;q=0.5' },
    maxBytes: MAX_ROBOTS_BYTES,
  });
  const looksHtml = /^\s*(<!doctype html|<html|<head|<body)/i.test(res.body);
  const found = res.status >= 200 && res.status < 300 && !looksHtml;
  const body = found ? res.body : '';
  const unreachable = res.status === 0 || res.status >= 500;
  const info = buildRobots(url, body, {
    status: res.status || null,
    found,
    unreachable,
    error: res.error ?? (looksHtml && res.ok ? 'robots.txt returned an HTML page, not a text file' : undefined),
  });
  return info;
}

/** Build a RobotsInfo from text (exported for tests and for other modules that already hold the body). */
export function buildRobots(
  url: string,
  body: string,
  meta: { status: number | null; found: boolean; unreachable?: boolean; error?: string },
): RobotsInfo {
  const parser = robotsParser(url, body);
  const lines = body.split(/\r?\n/);
  const sitemaps = meta.found ? dedupe(parser.getSitemaps()) : [];
  const unreachable = Boolean(meta.unreachable);
  const why =
    meta.status === null || meta.status === 0
      ? 'robots.txt could not be fetched, so crawlers treat the whole site as disallowed'
      : `robots.txt returned ${meta.status}, so crawlers treat the whole site as disallowed`;

  const info: RobotsInfo = {
    url,
    status: meta.status,
    found: meta.found,
    body,
    sitemaps,
    isAllowed(target: string, ua: string): boolean {
      if (unreachable) return false;
      if (!meta.found) return true;
      try {
        return parser.isAllowed(target, ua) !== false;
      } catch {
        return true;
      }
    },
    decidingLine(target: string, ua: string) {
      if (unreachable) return { line: 0, rule: why };
      if (!meta.found) return null;
      let n = -1;
      try {
        n = parser.getMatchingLineNumber(target, ua);
      } catch {
        n = -1;
      }
      if (n > 0) return { line: n, rule: (lines[n - 1] ?? '').trim() };
      return null;
    },
  };
  if (meta.error) info.error = meta.error;
  return info;
}

/** Product token of a full user-agent string: "AVC/1.0 (+https://…)" → "AVC". */
export function uaToken(userAgent: string): string {
  return (userAgent.trim().split(/[\s/;(]/)[0] || userAgent).trim();
}

function dedupe(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}
