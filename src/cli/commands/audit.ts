import { relative } from 'node:path';
import { c, fail, printAuditSummary, progressPrinter } from '../output.js';
import { ExitError } from '../errors.js';
import { openPath } from '../open.js';
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
}

export async function cmdAudit(target: string, opts: AuditOpts): Promise<void> {
  if (opts.mock) process.env.AVC_LLM_MOCK = '1';
  const config = getConfig(Boolean(opts.mock));
  const site = resolveSite(target, config);
  const formats = parseFormats(opts.format);
  const wantVisibility = Boolean(opts.visibility || opts.engines?.length || opts.repeats);
  const visibility = wantVisibility
    ? {
        engines: opts.engines?.length ? pickEngines(opts.engines, config) : undefined,
        repeats: opts.repeats,
      }
    : false;

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
    files = writeReports(result, formats, opts.out, { diff: d ?? undefined });

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
