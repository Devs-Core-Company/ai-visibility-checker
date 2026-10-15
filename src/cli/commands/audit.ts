import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { CrawlOptions } from '../../core/types.js';
import { parseExtractorFlag } from '../../crawl/options.js';
import { c, fail, printAuditSummary, progressPrinter } from '../output.js';
import { ExitError } from '../errors.js';
import { openPath } from '../open.js';
import { ensureAiKeys, offerKeysOnce } from './keys.js';
import {
  audit,
  getConfig,
  parseFormats,
  pickEngines,
  previousAudit,
  diff,
  resolveSite,
  writeReports,
} from '../services.js';

interface AuditOpts {
  maxPages?: number;
  depth?: number;
  render?: boolean;
  include?: string[];
  exclude?: string[];
  only?: string[];
  skip?: string[];
  visibility?: boolean;
  engines?: string[];
  repeats?: number;
  mock?: boolean;
  format: string;
  out: string;
  failUnder?: number;
  open?: boolean;
  json?: boolean;
  quiet?: boolean;
  save?: boolean;
  profile?: string;
  preset?: string;
  list?: string;
  sitemapOnly?: boolean;
  subdomains?: boolean;
  stayInFolder?: boolean;
  followNofollow?: boolean;
  externalLinks?: boolean;
  ignoreRobots?: boolean;
  robotsUa?: string;
  userAgent?: string;
  concurrency?: number;
  delay?: number;
  removeParam?: string[];
  rewrite?: string[];
  lowercaseUrls?: boolean;
  maxUrlLength?: number;
  maxQueryParams?: number;
  maxFolderDepth?: number;
  maxPerDepth?: number;
  cdn?: string[];
  extract?: string[];
  contentSelector?: string;
  contentExclude?: string;
  formLogin?: string;
  mobile?: boolean;
  pdf?: boolean;
}

/** Crawl options from the audit flags (only those given). */
export function crawlFlags(opts: AuditOpts, argv = process.argv): Partial<CrawlOptions> {
  const c: Partial<CrawlOptions> = {};
  if (opts.preset) c.preset = opts.preset;
  if (opts.list) {
    const text = readFileSync(opts.list, 'utf8');
    c.urls = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (!c.urls.length) throw new Error(`${opts.list} lists no URLs.`);
  }
  if (opts.sitemapOnly) c.sitemapOnly = true;
  if (opts.subdomains) c.subdomains = true;
  if (opts.stayInFolder) c.stayInFolder = true;
  if (argv.includes('--no-follow-nofollow')) c.followNofollow = false;
  if (opts.externalLinks) c.checkExternalLinks = true;
  if (opts.ignoreRobots) c.respectRobots = false;
  if (opts.robotsUa) c.robotsUserAgent = opts.robotsUa;
  if (opts.userAgent) c.userAgent = opts.userAgent;
  if (opts.concurrency) c.concurrency = opts.concurrency;
  if (opts.delay !== undefined) c.delayMs = opts.delay;
  if (opts.removeParam?.length) c.removeParams = opts.removeParam;
  if (opts.rewrite?.length)
    c.rewrite = opts.rewrite.map((r) => {
      const i = r.indexOf('=>');
      if (i < 1) throw new Error(`--rewrite needs "regex=>replacement", got "${r}".`);
      return { pattern: r.slice(0, i), replace: r.slice(i + 2) };
    });
  if (opts.lowercaseUrls) c.lowercase = true;
  if (opts.maxUrlLength) c.maxUrlLength = opts.maxUrlLength;
  if (opts.maxQueryParams) c.maxQueryParams = opts.maxQueryParams;
  if (opts.maxFolderDepth) c.maxFolderDepth = opts.maxFolderDepth;
  if (opts.maxPerDepth) c.maxPerDepth = opts.maxPerDepth;
  if (opts.cdn?.length) c.cdns = opts.cdn;
  if (opts.extract?.length)
    c.extract = opts.extract.map((spec) => {
      const e = parseExtractorFlag(spec);
      if (!e)
        throw new Error(
          `--extract needs "name=css:selector", "name=regex:pattern" or "name=count:pattern", got "${spec}".`,
        );
      return e;
    });
  if (opts.contentSelector) c.contentSelector = opts.contentSelector;
  if (opts.contentExclude) c.contentExclude = opts.contentExclude;
  if (opts.formLogin) c.formLogin = { url: opts.formLogin };
  if (argv.includes('--no-mobile')) c.mobileRender = false;
  if (argv.includes('--no-pdf')) c.pdfProperties = false;
  return c;
}

export async function cmdAudit(target: string, opts: AuditOpts): Promise<void> {
  if (opts.mock) process.env.AVC_LLM_MOCK = '1';
  let config = getConfig(Boolean(opts.mock));
  const site = resolveSite(target, config);
  const formats = parseFormats(opts.format);
  const wantVisibility = Boolean(opts.visibility || opts.engines?.length || opts.repeats);
  // Without a key the AI run is skipped (and the summary says so); offer to add one first.
  if (wantVisibility && !opts.json) await ensureAiKeys('The AI visibility run');
  else if (!opts.json && !opts.quiet) await offerKeysOnce();
  const visibility = wantVisibility
    ? {
        engines: opts.engines?.length ? pickEngines(opts.engines, config) : undefined,
        repeats: opts.repeats,
      }
    : false;

  config = getConfig(true);

  // commander sets render=true for --render, false for --no-render, and leaves it
  // true by default because of the negated option; only pass it when given explicitly.
  const argv = process.argv;
  const render = argv.includes('--no-render')
    ? false
    : argv.includes('--render')
      ? true
      : undefined;

  const progress = progressPrinter({ quiet: opts.quiet, json: opts.json });
  const ac = new AbortController();
  const onSigint = () => {
    progress.end();
    console.error(c.yellow('\nStopping…'));
    ac.abort();
  };
  process.once('SIGINT', onSigint);

  if (!opts.json && !opts.quiet) {
    console.error(c.dim(`Auditing ${site.url}${wantVisibility ? ' with AI visibility' : ''}…`));
  }
  let result;
  try {
    result = await audit(
      {
        url: site.url === target || !/^https?:/i.test(target) ? site.url : target,
        site,
        maxPages: opts.maxPages,
        maxDepth: opts.depth,
        render,
        include: opts.include,
        exclude: opts.exclude,
        only: opts.only,
        skip: opts.skip,
        visibility,
        onProgress: progress.onProgress,
        signal: ac.signal,
        save: opts.save !== false,
        crawl: crawlFlags(opts),
        profile: opts.profile,
      },
      config,
    );
  } finally {
    progress.end();
    process.off('SIGINT', onSigint);
  }

  let files: string[] = [];
  const prev = opts.save !== false ? safe(() => previousAudit(result, config)) : null;
  const d = prev ? safe(() => diff(prev, result)) : null;
  if (formats.length && opts.out)
    files = await writeReports(result, formats, opts.out, { diff: d ?? undefined }, (m) =>
      console.error(c.yellow(m)),
    );

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    console.log(printAuditSummary(result, { top: 10 }));
    if (d) {
      const sign =
        d.scoreDelta > 0
          ? c.green(`+${d.scoreDelta}`)
          : d.scoreDelta < 0
            ? c.red(String(d.scoreDelta))
            : '±0';
      console.log(
        `\n${c.bold('Since last audit')} ${sign} · ${c.red(`${d.newIssues.length} new`)} · ${c.green(`${d.fixedIssues.length} fixed`)} issues`,
      );
    }
    console.log('\n' + c.bold('Saved'));
    if (opts.save !== false) console.log(`  audit id   ${c.cyan(result.id)}`);
    for (const f of files)
      console.log(`  ${c.dim('report')}     ${relative(process.cwd(), f) || f}`);
    console.log(c.dim(`\nNext: avc fix ${site.id} · avc ui · avc report ${result.id} --format md`));
  }

  const html = files.find((f) => f.endsWith('.html'));
  if (opts.open && html) openPath(html);

  if (opts.failUnder !== undefined && result.score.overall < opts.failUnder) {
    if (!opts.json) fail(`Score ${result.score.overall} is below --fail-under ${opts.failUnder}.`);
    throw new ExitError(2);
  }
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
