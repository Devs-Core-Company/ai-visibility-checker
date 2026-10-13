/** Markdown report and the diff summary used for PR comments and CI job summaries. */
import type { AuditDiff, AuditResult, Issue } from '../core/types.js';
import { executiveSummary } from './summary.js';
import {
  CATEGORY_NAMES,
  CHECKER_URL,
  PILLAR_NAMES,
  SEVERITY_ORDER,
  bySeverity,
  groupBy,
  issueSeverity,
  pct,
  plural,
  readinessOnly,
  shortDate,
} from './util.js';

/** Escape characters that break Markdown table cells and inline text. */
export function mdEscape(s: unknown): string {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/([*_`[\]<>])/g, '\\$1')
    .replace(/\r?\n/g, ' ');
}

function fence(code: string, lang = ''): string {
  const ticks = code.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${code}\n${ticks}`;
}

export function renderMarkdownReport(
  result: AuditResult,
  opts: { diff?: AuditDiff; maxUrlsPerCheck?: number } = {},
): string {
  const r = result;
  const s = r.score;
  const maxUrls = opts.maxUrlsPerCheck ?? 20;
  const out: string[] = [];
  const sev = bySeverity(r);

  out.push(`# AI Visibility Report: ${mdEscape(r.site)}`);
  out.push('');
  out.push(
    `**Score ${s.overall}/100 (grade ${s.grade})** · ${shortDate(r.at)} · ${plural(r.stats?.pagesCrawled ?? r.pages.length, 'page')} crawled · stack: ${mdEscape(r.stack?.id ?? 'unknown')}`,
  );
  const cap = (s as { cappedBy?: string }).cappedBy;
  if (cap)
    out.push(
      '',
      `> Score capped by \`${cap}\`: ${cap === 'response.homepage-error' ? 'the start URL did not load, so nothing else can be trusted' : 'an open critical issue keeps the grade below A until it is fixed'}.`,
    );
  if (readinessOnly(r))
    out.push(
      '',
      '> Readiness only: no AI visibility run was included, so that pillar is left out of the score.',
    );
  out.push(
    '',
    '| Pillar | Score | Weight | Failing | Passing |',
    '| --- | ---: | ---: | ---: | ---: |',
  );
  for (const p of s.pillars)
    out.push(
      p.weight > 0
        ? `| ${PILLAR_NAMES[p.pillar]} | ${p.score} | ${Math.round(p.weight)}% | ${p.failed} | ${p.passed} |`
        : `| ${PILLAR_NAMES[p.pillar]} | not measured | – | – | – |`,
    );

  out.push('', '## Summary', '');
  for (const p of executiveSummary(r, opts.diff)) out.push(p, '');
  out.push(
    `Issues: ${sev.critical} critical, ${sev.high} high, ${sev.medium} medium, ${sev.low} low, ${sev.info} info.`,
  );

  if (opts.diff)
    out.push('', renderDiffMarkdown(opts.diff, { next: r, heading: '## Since the last audit' }));

  const issuesByCheck = groupBy(r.issues, (i) => i.checkId);
  out.push('', '## Fix these first', '');
  if (!r.priorities.length) out.push('No failing checks.');
  r.priorities.slice(0, 10).forEach((p, i) => {
    const def = r.checks[p.checkId];
    out.push(
      `### ${i + 1}. ${mdEscape(def?.title ?? p.checkId)}`,
      '',
      `\`${p.checkId}\` · ${def?.severity ?? ''} · ${def?.scope === 'page' ? plural(p.affected, 'page') + ' affected' : 'site-wide'}`,
      '',
    );
    if (def?.why) out.push(def.why, '');
    const f = p.fix;
    if (f) {
      if (f.steps.length) out.push(...f.steps.map((st, n) => `${n + 1}. ${st}`), '');
      if (f.files.length) out.push(`Where: ${f.files.map((x) => `\`${x}\``).join(', ')}`, '');
      if (f.snippet) out.push(fence(f.snippet.code, f.snippet.language), '');
      if (f.agentPrompt)
        out.push(
          '<details><summary>Prompt for your AI coding assistant</summary>',
          '',
          fence(f.agentPrompt),
          '',
          '</details>',
          '',
        );
    } else if (def?.fix) out.push(`Fix: ${def.fix}`, '');
    const urls = (issuesByCheck.get(p.checkId) ?? []).filter((x) => x.url).slice(0, 5);
    if (urls.length) out.push(...urls.map((x) => `- ${x.url}`), '');
  });

  if (r.botFetches?.length) {
    out.push(
      '## AI crawler access',
      '',
      '| Crawler | Operator | Purpose | Live fetch | Status |',
      '| --- | --- | --- | --- | ---: |',
    );
    for (const b of r.botFetches)
      out.push(
        `| ${mdEscape(b.token)} | ${mdEscape(b.operator)} | ${b.purpose} | ${b.verdict}${b.challenge ? ` (${mdEscape(b.challenge)})` : ''} | ${b.status || '–'} |`,
      );
    out.push('');
  }

  if (r.probes?.length) {
    out.push(
      '## Agentic web readiness',
      '',
      '| Probe | URL | Status | Found |',
      '| --- | --- | ---: | --- |',
    );
    for (const p of r.probes)
      out.push(
        `| ${mdEscape(p.id)} | ${mdEscape(p.url)} | ${p.status ?? '–'} | ${p.found ? 'yes' : 'no'} |`,
      );
    out.push('');
  }

  if (r.visibility) {
    const v = r.visibility.summary;
    out.push(
      '## AI visibility',
      '',
      `Named in ${pct(v.mentionRate)} of answers. Cost $${v.costUsd.toFixed(2)}.`,
      '',
    );
    out.push(
      '| Engine | Mention rate | Avg position | Answers | Cited you |',
      '| --- | ---: | ---: | ---: | ---: |',
    );
    for (const [e, x] of Object.entries(v.byEngine))
      out.push(
        `| ${e} | ${pct(x.mentionRate)} | ${x.avgPosition === null ? '–' : x.avgPosition.toFixed(1)} | ${x.answers} | ${x.citedOwnSite} |`,
      );
    if (v.shareOfVoice.length) {
      out.push('', '| Brand | Share of voice | Mentions |', '| --- | ---: | ---: |');
      for (const x of v.shareOfVoice.slice(0, 10))
        out.push(
          `| ${mdEscape(x.name)}${x.isBrand ? ' (you)' : ''} | ${pct(x.share)} | ${x.mentions} |`,
        );
    }
    if (v.competitorWins.length) {
      out.push('', '**Prompts where a competitor was named instead of you**', '');
      for (const w of v.competitorWins.slice(0, 15))
        out.push(`- ${mdEscape(w.prompt)} → ${mdEscape(w.winner)} (${w.engines.join(', ')})`);
    }
    out.push('');
  }

  out.push('## Every issue', '');
  const failing = Object.values(r.checks).filter((c) => c.status === 'ran' && c.affected > 0);
  for (const [cat, defs] of groupBy(failing, (c) => c.category)) {
    out.push(`### ${CATEGORY_NAMES[cat] ?? cat}`, '');
    defs.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
    for (const d of defs) {
      out.push(
        `- **${mdEscape(d.title)}** (${d.severity}, ${d.scope === 'page' ? plural(d.affected, 'page') : 'site-wide'}) \`${d.id}\``,
      );
      const own = issuesByCheck.get(d.id) ?? [];
      for (const i of own.slice(0, maxUrls))
        out.push(`  - ${i.url ? `${i.url}: ` : ''}${mdEscape(i.message)}`);
      if (own.length > maxUrls) out.push(`  - and ${own.length - maxUrls} more`);
    }
    out.push('');
  }
  if (!failing.length) out.push('Nothing to report.', '');

  out.push(
    '---',
    '',
    `Made with the [AI Visibility Checker](${CHECKER_URL}) by [Devs Core](https://devs-core.com). Audit \`${r.id}\`.`,
  );
  return out.join('\n') + '\n';
}

/**
 * A compact diff for PR comments and GitHub job summaries.
 * Pass `next` (and `prev`) to show check titles and severities.
 */
export function renderDiffMarkdown(
  diff: AuditDiff,
  ctx: { prev?: AuditResult; next?: AuditResult; heading?: string; maxItems?: number } = {},
): string {
  const max = ctx.maxItems ?? 25;
  const out: string[] = [];
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const arrow = diff.scoreDelta > 0 ? '▲' : diff.scoreDelta < 0 ? '▼' : '●';
  out.push(ctx.heading ?? '## AI Visibility Checker: changes');
  out.push('');
  const scoreLine =
    ctx.prev && ctx.next
      ? `**Score ${ctx.prev.score.overall} → ${ctx.next.score.overall}** (${arrow} ${sign(diff.scoreDelta)})`
      : `**Score ${arrow} ${sign(diff.scoreDelta)}**`;
  out.push(
    `${scoreLine} · ${plural(diff.newIssues.length, 'new issue')} · ${plural(diff.fixedIssues.length, 'fixed issue')} · ${plural(diff.changedPages.length, 'changed page')}`,
  );
  const moved = diff.pillarDeltas.filter((p) => p.delta !== 0);
  if (moved.length) {
    out.push('', '| Pillar | Change |', '| --- | ---: |');
    for (const p of moved) out.push(`| ${PILLAR_NAMES[p.pillar]} | ${sign(p.delta)} |`);
  }
  const lookup = ctx.next ?? ctx.prev;
  const lookupFixed = ctx.prev ?? ctx.next;
  const row = (i: Issue, r?: AuditResult) => {
    const def = r?.checks[i.checkId];
    const sev = r ? issueSeverity(i, r) : (i.severity ?? '');
    return `| ${sev} | ${mdEscape(def?.title ?? i.checkId)} | ${i.url ? mdEscape(i.url) : 'site-wide'} |`;
  };
  const order = (r?: AuditResult) => (a: Issue, b: Issue) =>
    r
      ? SEVERITY_ORDER.indexOf(issueSeverity(a, r)) - SEVERITY_ORDER.indexOf(issueSeverity(b, r))
      : 0;
  if (diff.newIssues.length) {
    out.push(
      '',
      `### New issues (${diff.newIssues.length})`,
      '',
      '| Severity | Check | Where |',
      '| --- | --- | --- |',
    );
    for (const i of [...diff.newIssues].sort(order(lookup)).slice(0, max)) out.push(row(i, lookup));
    if (diff.newIssues.length > max) out.push(`| | and ${diff.newIssues.length - max} more | |`);
  }
  if (diff.fixedIssues.length) {
    out.push(
      '',
      `<details><summary>Fixed issues (${diff.fixedIssues.length})</summary>`,
      '',
      '| Severity | Check | Where |',
      '| --- | --- | --- |',
    );
    for (const i of [...diff.fixedIssues].sort(order(lookupFixed)).slice(0, max))
      out.push(row(i, lookupFixed));
    if (diff.fixedIssues.length > max)
      out.push(`| | and ${diff.fixedIssues.length - max} more | |`);
    out.push('', '</details>');
  }
  if (diff.changedPages.length) {
    out.push('', `<details><summary>Changed pages (${diff.changedPages.length})</summary>`, '');
    for (const c of diff.changedPages.slice(0, max))
      out.push(`- ${c.url} (${c.fields.join(', ')})`);
    out.push('', '</details>');
  }
  if (diff.newPages.length || diff.removedPages.length)
    out.push(
      '',
      `${plural(diff.newPages.length, 'new page')}, ${plural(diff.removedPages.length, 'removed page')}.`,
    );
  if (diff.visibility) {
    const v = diff.visibility;
    out.push(
      '',
      `### AI visibility`,
      '',
      `Mention rate ${sign(Math.round(v.mentionRateDelta * 100))} points · share of voice ${sign(Math.round(v.shareOfVoiceDelta * 100))} points · ${plural(v.wonPrompts.length, 'prompt')} won · ${plural(v.lostPrompts.length, 'prompt')} lost`,
    );
    if (v.newCompetitors.length)
      out.push('', `New competitors named: ${v.newCompetitors.map(mdEscape).join(', ')}`);
  }
  return out.join('\n') + '\n';
}
