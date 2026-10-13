/**
 * Compare two audits of the same site.
 *
 * Issue identity is checkId + URL (site issues have no URL), so the same
 * problem on the same page is never reported as both fixed and new. Pages
 * count as changed when title, meta description, H1, canonical, status or
 * indexability change, or when the word count moves by more than 20%.
 */
import { compareRuns } from '../ai/index.js';
import type { AuditDiff, AuditResult, Issue, PageSummary, VisibilityRun } from '../core/types.js';

export const issueKey = (i: Pick<Issue, 'checkId' | 'url'>) => `${i.checkId}|${i.url ?? ''}`;

const WORD_COUNT_CHANGE = 0.2;

function dedupe(issues: Issue[]): Map<string, Issue> {
  const m = new Map<string, Issue>();
  for (const i of issues) if (!m.has(issueKey(i))) m.set(issueKey(i), i);
  return m;
}

export function changedFields(a: PageSummary, b: PageSummary): string[] {
  const fields: string[] = [];
  const norm = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');
  if (norm(a.title) !== norm(b.title)) fields.push('title');
  if (norm(a.metaDescription) !== norm(b.metaDescription)) fields.push('metaDescription');
  if (norm(a.h1) !== norm(b.h1)) fields.push('h1');
  if (norm(a.canonical) !== norm(b.canonical)) fields.push('canonical');
  if (a.status !== b.status) fields.push('status');
  if (a.indexable !== b.indexable) fields.push('indexable');
  const wa = a.wordCount ?? 0;
  const wb = b.wordCount ?? 0;
  if (wa > 0 ? Math.abs(wb - wa) / wa > WORD_COUNT_CHANGE : wb >= 50) fields.push('wordCount');
  return fields;
}

/**
 * Visibility change between two runs (the AI module's compareRuns): mention rate and
 * share-of-voice deltas, newly named competitors, and prompts won or lost (by text).
 */
export const diffVisibility: (
  prev: VisibilityRun,
  next: VisibilityRun,
) => NonNullable<AuditDiff['visibility']> = compareRuns;

export function diffAudits(prev: AuditResult, next: AuditResult): AuditDiff {
  const before = dedupe(prev.issues);
  const after = dedupe(next.issues);
  const newIssues = [...after].filter(([k]) => !before.has(k)).map(([, v]) => v);
  // An issue only counts as fixed when its check actually ran this time: a check skipped
  // for lack of data (e.g. --no-render, no PSI key) proves nothing.
  const ranNow = (checkId: string) => next.checks?.[checkId]?.status !== 'skipped';
  const fixedIssues = [...before]
    .filter(([k, v]) => !after.has(k) && ranNow(v.checkId))
    .map(([, v]) => v);

  const prevPages = new Map(prev.pages.map((p) => [p.url, p]));
  const nextPages = new Map(next.pages.map((p) => [p.url, p]));
  const newPages = [...nextPages.keys()].filter((u) => !prevPages.has(u));
  const removedPages = [...prevPages.keys()].filter((u) => !nextPages.has(u));
  const changedPages: AuditDiff['changedPages'] = [];
  for (const [url, b] of nextPages) {
    const a = prevPages.get(url);
    if (!a) continue;
    const fields = changedFields(a, b);
    if (fields.length) changedPages.push({ url, fields });
  }

  const prevPillars = new Map(prev.score.pillars.map((p) => [p.pillar, p]));
  const pillarDeltas: AuditDiff['pillarDeltas'] = next.score.pillars
    .filter((p) => p.weight > 0 && (prevPillars.get(p.pillar)?.weight ?? 0) > 0)
    .map((p) => ({ pillar: p.pillar, delta: p.score - (prevPillars.get(p.pillar)?.score ?? 0) }));

  const diff: AuditDiff = {
    from: prev.id,
    to: next.id,
    scoreDelta: next.score.overall - prev.score.overall,
    pillarDeltas,
    newIssues,
    fixedIssues,
    newPages,
    removedPages,
    changedPages,
  };
  if (prev.visibility && next.visibility)
    diff.visibility = diffVisibility(prev.visibility, next.visibility);
  return diff;
}

/** True when nothing worth reporting changed. */
export function isEmptyDiff(d: AuditDiff): boolean {
  return (
    d.scoreDelta === 0 &&
    !d.newIssues.length &&
    !d.fixedIssues.length &&
    !d.newPages.length &&
    !d.removedPages.length &&
    !d.changedPages.length &&
    (!d.visibility ||
      (d.visibility.mentionRateDelta === 0 &&
        !d.visibility.newCompetitors.length &&
        !d.visibility.lostPrompts.length &&
        !d.visibility.wonPrompts.length))
  );
}
