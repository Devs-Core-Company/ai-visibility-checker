/**
 * Terminal output helpers for the CLI: colours, score formatting, progress line, tables.
 * Respects NO_COLOR / FORCE_COLOR through picocolors.
 */
import pc from 'picocolors';
import type { AuditResult, ProgressEvent, Severity } from '../core/types.js';

export const c = pc;

export function scoreColour(score: number): (s: string) => string {
  if (score >= 80) return pc.green;
  if (score >= 50) return pc.yellow;
  return pc.red;
}

export function fmtScore(score: number): string {
  return scoreColour(score)(pc.bold(String(Math.round(score))));
}

export function bar(score: number, width = 20): string {
  const n = Math.max(0, Math.min(width, Math.round((score / 100) * width)));
  return scoreColour(score)('█'.repeat(n)) + pc.dim('░'.repeat(width - n));
}

const SEV_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export function sevRank(s: Severity | undefined): number {
  const i = SEV_ORDER.indexOf(s ?? 'info');
  return i < 0 ? SEV_ORDER.length : i;
}

export function sevLabel(s: Severity): string {
  const label = s.padEnd(8);
  switch (s) {
    case 'critical':
      return pc.red(pc.bold(label));
    case 'high':
      return pc.red(label);
    case 'medium':
      return pc.yellow(label);
    case 'low':
      return pc.cyan(label);
    default:
      return pc.dim(label);
  }
}

export function heading(text: string): string {
  return '\n' + pc.bold(text);
}

export function table(rows: string[][], opts: { header?: string[]; maxWidth?: number[] } = {}): string {
  const all = opts.header ? [opts.header, ...rows] : rows;
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const widths: number[] = [];
  for (const r of all)
    r.forEach((cell, i) => {
      const w = Math.min(strip(cell).length, opts.maxWidth?.[i] ?? 80);
      widths[i] = Math.max(widths[i] ?? 0, w);
    });
  const fit = (cell: string, i: number) => {
    const max = opts.maxWidth?.[i] ?? 80;
    const plain = strip(cell);
    if (plain.length > max) return plain.slice(0, max - 1) + '…';
    return cell + ' '.repeat(Math.max(0, widths[i] - plain.length));
  };
  const lines = rows.map((r) => r.map(fit).join('  ').trimEnd());
  if (opts.header) {
    lines.unshift(pc.dim(opts.header.map(fit).join('  ').trimEnd()));
  }
  return lines.join('\n');
}

/** A single-line progress indicator on TTYs; plain log lines otherwise. */
export function progressPrinter(opts: { quiet?: boolean; json?: boolean } = {}) {
  const tty = process.stderr.isTTY && !opts.json;
  let last = '';
  const write = (line: string) => {
    if (opts.quiet) return;
    if (tty) {
      const cols = process.stderr.columns || 100;
      const plain = line.length > cols - 1 ? line.slice(0, cols - 2) + '…' : line;
      process.stderr.write('\r\x1b[2K' + plain);
      last = plain;
    } else {
      process.stderr.write(line + '\n');
    }
  };
  const fn = (e: ProgressEvent) => {
    if (e.type === 'phase') {
      if (e.phase === 'done') return;
      write(pc.cyan('› ') + phaseLabel(e.phase) + (e.message ? pc.dim(' ' + e.message) : ''));
    } else if (e.type === 'page') {
      const total = e.crawled + e.queued;
      write(
        pc.cyan('› ') +
          `Crawling ${e.crawled}/${total} ` +
          pc.dim(`${e.status || 'ERR'} ${e.url}`),
      );
    } else if (e.type === 'log') {
      if (e.level === 'info' && !process.env.AVC_VERBOSE) return;
      if (tty && last) process.stderr.write('\r\x1b[2K');
      const tag = e.level === 'error' ? pc.red('error') : e.level === 'warn' ? pc.yellow('warn') : pc.dim('info');
      if (!opts.quiet) process.stderr.write(`${tag} ${e.message}\n`);
      last = '';
    }
  };
  const end = () => {
    if (tty && last) process.stderr.write('\r\x1b[2K');
    last = '';
  };
  return { onProgress: fn, end };
}

export function phaseLabel(phase: string): string {
  const m: Record<string, string> = {
    robots: 'Reading robots.txt',
    sitemaps: 'Reading sitemaps',
    crawl: 'Crawling',
    render: 'Rendering JavaScript pages',
    probes: 'Probing AI and agent endpoints',
    checks: 'Running checks',
    external: 'Collecting connected data',
    visibility: 'Asking AI engines',
    score: 'Scoring',
    done: 'Done',
  };
  return m[phase] ?? phase;
}

const PILLAR_NAMES: Record<string, string> = {
  technical: 'Technical SEO',
  content: 'Content',
  'ai-access': 'AI access',
  geo: 'AEO / GEO',
  agentic: 'Agentic web',
  'ai-visibility': 'AI visibility',
};
export function pillarName(p: string): string {
  return PILLAR_NAMES[p] ?? p;
}

/** The human summary printed after `avc audit`. */
export function printAuditSummary(result: AuditResult, opts: { top?: number } = {}): string {
  const out: string[] = [];
  const s = result.score;
  out.push('');
  out.push(
    `${pc.bold('AI Visibility Score')}  ${fmtScore(s.overall)}${pc.dim('/100')}  grade ${scoreColour(s.overall)(pc.bold(s.grade))}` +
      (result.visibility ? '' : pc.dim('  (readiness only: no AI visibility run)')),
  );
  out.push(
    pc.dim(
      `${result.site} · ${result.stats.pagesCrawled} pages · ${result.issues.length} issues · stack ${result.stack.id}` +
        (result.stack.host ? ` on ${result.stack.host}` : '') +
        ` · ${Math.round(result.stats.durationMs / 1000)}s`,
    ),
  );
  out.push('');
  for (const p of s.pillars) {
    if (!p.weight && p.pillar === 'ai-visibility') continue;
    out.push(
      `  ${pillarName(p.pillar).padEnd(15)} ${bar(p.score)} ${fmtScore(p.score).padStart(3)}  ${pc.dim(
        `${p.failed} failing, ${p.passed} passing${p.skipped ? `, ${p.skipped} skipped` : ''}`,
      )}`,
    );
  }
  if (result.visibility) {
    const v = result.visibility.summary;
    out.push('');
    out.push(
      `  ${pc.bold('AI engines')}  named in ${fmtScore(v.mentionRate * 100)}% of answers · cost ~$${v.costUsd.toFixed(2)}`,
    );
  }
  const top = result.priorities.slice(0, opts.top ?? 10);
  if (top.length) {
    out.push(heading(`Top ${top.length} priorities`));
    top.forEach((p, i) => {
      const def = result.checks[p.checkId];
      const sev = (def?.severity ?? 'info') as Severity;
      out.push(
        `${String(i + 1).padStart(3)}. ${sevLabel(sev)} ${def?.title ?? p.checkId} ${pc.dim(
          `(${p.affected} affected · ${p.checkId})`,
        )}`,
      );
      const step = p.fix?.steps?.[0] ?? def?.fix;
      if (step) out.push(`       ${pc.dim('→ ' + truncate(step, 110))}`);
    });
  }
  return out.join('\n');
}

export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

export function ok(msg: string): void {
  console.log(pc.green('✓ ') + msg);
}
export function warn(msg: string): void {
  console.error(pc.yellow('! ') + msg);
}
export function fail(msg: string): void {
  console.error(pc.red('✗ ') + msg);
}
