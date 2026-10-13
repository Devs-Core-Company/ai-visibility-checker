/** Plain-English executive summary, shared by the HTML and Markdown reports. */
import type { AuditDiff, AuditResult } from '../core/types.js';
import { PILLAR_NAMES, bySeverity, pct, plural, readinessOnly } from './util.js';

export function executiveSummary(r: AuditResult, diff?: AuditDiff): string[] {
  const out: string[] = [];
  const s = r.score;
  const crawled = r.stats?.pagesCrawled ?? r.pages.length;
  const measured = s.pillars.filter((p) => p.weight > 0);
  const sorted = [...measured].sort((a, b) => b.score - a.score);
  const sev = bySeverity(r);

  let first = `${r.site} scores ${s.overall} out of 100 (grade ${s.grade}) across ${plural(crawled, 'crawled page')}.`;
  if (sorted.length >= 2) {
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    first += ` The strongest area is ${PILLAR_NAMES[best.pillar].toLowerCase()} (${best.score}); the weakest is ${PILLAR_NAMES[worst.pillar].toLowerCase()} (${worst.score}).`;
  }
  if (readinessOnly(r))
    first +=
      ' This is a readiness score: no AI visibility run was included, so it measures whether AI engines can find and use the site, not whether they already name it.';
  out.push(first);

  const serious = sev.critical + sev.high;
  if (r.issues.length === 0) out.push('No issues were found by the checks that ran.');
  else
    out.push(
      `The checks found ${plural(r.issues.length, 'issue')}: ${sev.critical} critical, ${sev.high} high, ${sev.medium} medium and ${sev.low} low.` +
        (serious ? ` Start with the critical and high ones; they cost the most.` : ''),
    );

  if (r.priorities.length) {
    const titles = r.priorities
      .slice(0, 3)
      .map((p) => r.checks[p.checkId]?.title ?? p.checkId)
      .map((t) => t.replace(/\.$/, ''));
    out.push(`Fix first: ${titles.join('; ')}.`);
  }

  const bots = r.botFetches ?? [];
  if (bots.length) {
    const blocked = bots.filter((b) => b.verdict === 'blocked');
    const differs = bots.filter((b) => b.verdict === 'differs');
    if (!blocked.length && !differs.length)
      out.push(`All ${bots.length} AI crawlers tested could fetch the home page.`);
    else
      out.push(
        [
          blocked.length
            ? `${plural(blocked.length, 'AI crawler')} could not fetch the home page (${blocked.map((b) => b.token).join(', ')}).`
            : '',
          differs.length
            ? `${plural(differs.length, 'crawler')} got different content from a browser (${differs.map((b) => b.token).join(', ')}).`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
  }

  if (r.visibility) {
    const v = r.visibility.summary;
    const engines = Object.keys(v.byEngine);
    const rivals = v.shareOfVoice.filter((x) => !x.isBrand).slice(0, 3);
    let t = `AI engines (${engines.join(', ')}) named ${r.visibility.brand.name} in ${pct(v.mentionRate)} of answers to ${plural(r.visibility.prompts.length, 'tracked prompt')}.`;
    if (rivals.length)
      t += ` Most named competitors: ${rivals.map((x) => `${x.name} (${pct(x.share)} share of voice)`).join(', ')}.`;
    if (v.ownPagesCited.length)
      t += ` ${plural(v.ownPagesCited.length, 'of your pages', 'of your pages')} were cited as sources.`;
    else t += ' None of your pages were cited as a source.';
    if (v.factIssues)
      t += ` ${plural(v.factIssues, 'answer claim')} about you looked wrong or out of date.`;
    out.push(t);
  }

  if (diff) {
    const dir = diff.scoreDelta > 0 ? 'up' : diff.scoreDelta < 0 ? 'down' : 'unchanged';
    out.push(
      `Since the last audit the score is ${dir}${diff.scoreDelta ? ` ${Math.abs(diff.scoreDelta)} points` : ''}: ${plural(diff.newIssues.length, 'new issue')}, ${plural(diff.fixedIssues.length, 'fixed issue')}, ${plural(diff.changedPages.length, 'changed page')}.`,
    );
  }
  return out;
}
