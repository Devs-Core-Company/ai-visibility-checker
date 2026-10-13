/**
 * Crawl scope, URL rewriting, per-URL limits, custom extraction and content-area
 * selection. Pure helpers the crawler applies to every discovered URL and every
 * HTML page; nothing here fetches.
 */
import { parseHTML } from 'linkedom';
import type { CrawlOptions, Extractor, PageData } from '../core/types.js';
import { bareHost } from '../core/url.js';
import { countWords, normaliseForHash, oneLine, sha1, simhash, visibleText } from './text.js';

/** Registrable-ish domain of a host: the last two labels, or three for common second-level TLDs. */
export function baseDomain(host: string): string {
  const h = bareHost(host);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || !h.includes('.')) return h;
  const parts = h.split('.');
  const sld = parts.slice(-2).join('.');
  const twoPart =
    /^(co|com|org|net|ac|gov|edu|ltd|plc|me|or|ne|go)\.[a-z]{2}$/.test(sld) ||
    /^(com|net|org)\.(au|br|cn|mx|my|sg|tr|ua|bd|pk|ng|ar)$/.test(sld);
  return parts.slice(twoPart ? -3 : -2).join('.');
}

/** True when `url` is on `startHost` or (with subdomains on) any host under the same domain. */
export function onSubdomain(url: string, startHost: string): boolean {
  try {
    const h = bareHost(new URL(url).hostname);
    const d = baseDomain(startHost);
    return h === d || h.endsWith(`.${d}`);
  } catch {
    return false;
  }
}

/** The folder the crawl is limited to with `stayInFolder`, e.g. "/blog/". */
export function startFolder(startUrl: string): string {
  try {
    const p = new URL(startUrl).pathname;
    return p.endsWith('/') ? p : p.slice(0, p.lastIndexOf('/') + 1) || '/';
  } catch {
    return '/';
  }
}

/** Apply removeParams → rewrite rules → lowercase to a discovered URL. */
export function rewriteUrl(url: string, opts: Partial<CrawlOptions>): string {
  let out = url;
  if (opts.removeParams?.length) {
    try {
      const u = new URL(out);
      const drop = new Set(opts.removeParams.map((p) => p.toLowerCase()));
      for (const k of [...u.searchParams.keys()])
        if (drop.has(k.toLowerCase())) u.searchParams.delete(k);
      out = u.toString();
    } catch {
      /* keep */
    }
  }
  for (const r of opts.rewrite ?? []) {
    try {
      out = out.replace(new RegExp(r.pattern, 'g'), r.replace);
    } catch {
      /* invalid pattern: ignored (reported once by the crawler) */
    }
  }
  if (opts.lowercase) {
    try {
      const u = new URL(out);
      u.pathname = u.pathname.toLowerCase();
      out = u.toString();
    } catch {
      out = out.toLowerCase();
    }
  }
  return out;
}

/** Why a discovered URL is skipped by the per-URL limits, or null when it may be crawled. */
export function limitReason(url: string, opts: Partial<CrawlOptions>): string | null {
  if (opts.maxUrlLength && url.length > opts.maxUrlLength)
    return `longer than ${opts.maxUrlLength} characters`;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (opts.maxQueryParams && [...u.searchParams.keys()].length > opts.maxQueryParams)
    return `more than ${opts.maxQueryParams} query parameters`;
  if (opts.maxFolderDepth) {
    const segments = u.pathname.split('/').filter(Boolean).length;
    if (segments > opts.maxFolderDepth) return `more than ${opts.maxFolderDepth} folders deep`;
  }
  return null;
}

/** Links an authenticated crawl must never follow: they end the session or change data. */
export const DANGEROUS_LINK =
  /(log-?out|sign-?out|logoff|\/wp-login\.php\?action=logout|[?&]action=(delete|trash|remove|logout)|\/delete\b|\/remove\b|\/unsubscribe|\/cancel-?(account|subscription)|\/wp-admin\b|\/admin\b)/i;

// ---------------------------------------------------------------------------
// Custom extraction
// ---------------------------------------------------------------------------

const MAX_VALUES = 50;
const MAX_VALUE_LEN = 500;

/** Validate extractors; returns the usable ones and a message per rejected one. */
export function checkExtractors(list: Extractor[] | undefined): {
  ok: Extractor[];
  errors: string[];
} {
  const ok: Extractor[] = [];
  const errors: string[] = [];
  for (const e of list ?? []) {
    if (!e?.name || !e.expr) {
      errors.push('An extractor needs a name and an expression.');
      continue;
    }
    if (e.type === 'xpath') {
      if (!xpathToCss(e.expr)) {
        errors.push(
          `Extractor "${e.name}": only simple XPath paths are supported (//tag[@attr='value']/@attr, /text()).`,
        );
        continue;
      }
    } else if (e.type === 'regex' || e.type === 'count') {
      try {
        new RegExp(e.expr);
      } catch {
        errors.push(`Extractor "${e.name}": invalid regular expression.`);
        continue;
      }
    } else if (e.type === 'css') {
      try {
        parseHTML('<html><body></body></html>').document.querySelectorAll(e.expr);
      } catch {
        errors.push(`Extractor "${e.name}": invalid CSS selector.`);
        continue;
      }
    } else {
      errors.push(`Extractor "${e.name}": type must be css, xpath, regex or count.`);
      continue;
    }
    ok.push(e);
  }
  return { ok, errors };
}

/** Run extractors over one page's HTML. */
export function runExtractors(
  html: string,
  extractors: Extractor[],
  doc?: Document,
): Record<string, string[] | number> {
  const out: Record<string, string[] | number> = {};
  let document = doc;
  for (const e of extractors) {
    try {
      if (e.type === 'count') {
        out[e.name] = [...html.matchAll(new RegExp(e.expr, 'gi'))].length;
      } else if (e.type === 'regex') {
        const values: string[] = [];
        for (const m of html.matchAll(new RegExp(e.expr, 'gi'))) {
          const v = oneLine(m[1] ?? m[0]).slice(0, MAX_VALUE_LEN);
          if (v) values.push(v);
          if (values.length >= MAX_VALUES) break;
        }
        out[e.name] = values;
      } else {
        const x = e.type === 'xpath' ? xpathToCss(e.expr) : null;
        const css = x?.css ?? e.expr;
        const attr = x ? x.attr : e.attr;
        document ??= (parseHTML(html) as unknown as { document: Document }).document;
        const values: string[] = [];
        for (const el of [...document.querySelectorAll(css)].slice(0, MAX_VALUES)) {
          const v = attr ? el.getAttribute(attr) : el.textContent;
          const s = oneLine(v).slice(0, MAX_VALUE_LEN);
          if (s) values.push(s);
        }
        out[e.name] = values;
      }
    } catch {
      out[e.name] = e.type === 'count' ? 0 : [];
    }
  }
  return out;
}

/**
 * Convert a simple XPath to a CSS selector: steps with `//` (descendant) or `/` (child),
 * tag names or `*`, predicates `[@a='v']`, `[@a]`, `[contains(@a,'v')]` and `[n]`, and an
 * optional final `/@attr` or `/text()`. Returns null for anything more complex.
 */
export function xpathToCss(xpath: string): { css: string; attr?: string } | null {
  let x = xpath.trim();
  let attr: string | undefined;
  const tail = /\/(?:@([\w:-]+)|text\(\))$/.exec(x);
  if (tail) {
    attr = tail[1];
    x = x.slice(0, tail.index);
  }
  if (!/^\/\/?/.test(x)) return null;
  const parts: string[] = [];
  const re = /(\/\/?)([\w-]+|\*)((?:\[[^\]]+\])*)/gy;
  let m: RegExpExecArray | null;
  let pos = 0;
  while ((m = re.exec(x))) {
    pos = re.lastIndex;
    const [, sep, tag, preds] = m;
    let sel = tag === '*' ? '*' : tag!;
    for (const p of preds!.match(/\[[^\]]+\]/g) ?? []) {
      const inner = p.slice(1, -1).trim();
      let pm: RegExpExecArray | null;
      if ((pm = /^@([\w:-]+)\s*=\s*(['"])(.*)\2$/.exec(inner))) sel += `[${pm[1]}="${pm[3]}"]`;
      else if ((pm = /^@([\w:-]+)$/.exec(inner))) sel += `[${pm[1]}]`;
      else if ((pm = /^contains\(\s*@([\w:-]+)\s*,\s*(['"])(.*)\2\s*\)$/.exec(inner)))
        sel += `[${pm[1]}*="${pm[3]}"]`;
      else if ((pm = /^(\d+)$/.exec(inner))) sel += `:nth-of-type(${pm[1]})`;
      else return null;
    }
    parts.push(parts.length === 0 ? sel : sep === '//' ? ` ${sel}` : ` > ${sel}`);
  }
  if (pos !== x.length || !parts.length) return null;
  return { css: parts.join(''), ...(attr ? { attr } : {}) };
}

/** Parse "name=css:selector@attr" / "name=xpath:…" / "name=regex:..." / "name=count:..." from the CLI. */
export function parseExtractorFlag(spec: string): Extractor | null {
  const m = /^([^=]+)=(css|xpath|regex|count):(.+)$/s.exec(spec.trim());
  if (!m) return null;
  const type = m[2] as Extractor['type'];
  let expr = m[3]!;
  let attr: string | undefined;
  if (type === 'css') {
    const at = /^(.*)@([a-z_:][-a-z0-9_:.]*)$/i.exec(expr);
    if (at) {
      expr = at[1]!;
      attr = at[2];
    }
  }
  return { name: m[1]!.trim(), type, expr, ...(attr ? { attr } : {}) };
}

// ---------------------------------------------------------------------------
// Content area
// ---------------------------------------------------------------------------

/**
 * Recompute a page's text from a chosen content area: remove `contentExclude`
 * elements, then keep `contentSelector` elements (when it matches anything).
 * Word count, hashes and the lead follow the new text.
 */
export function applyContentArea(page: PageData, opts: Partial<CrawlOptions>): void {
  if (!page.isHtml || !page.html || (!opts.contentSelector && !opts.contentExclude)) return;
  let document: Document;
  try {
    ({ document } = parseHTML(page.html) as unknown as { document: Document });
  } catch {
    return;
  }
  try {
    if (opts.contentExclude)
      for (const el of [...document.querySelectorAll(opts.contentExclude)]) el.remove();
    let text = '';
    if (opts.contentSelector) {
      const parts = [...document.querySelectorAll(opts.contentSelector)].map((el) =>
        visibleText(el as never),
      );
      text = parts.join('\n').trim();
    }
    if (!text) text = visibleText((document.body ?? document.documentElement) as never);
    page.text = text;
    page.wordCount = countWords(text);
    const norm = normaliseForHash(text);
    page.contentHash = norm ? sha1(norm) : '';
    page.simhash = simhash(text);
    page.lead = text.slice(0, 300);
  } catch {
    /* keep the default extraction */
  }
}
