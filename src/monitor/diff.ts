/**
 * Compare two audits of the same site.
 *
 * Issue identity is checkId + URL (site issues have no URL), so the same
 * problem on the same page is never reported as both fixed and new. Pages
 * count as changed when title, meta description, H1, canonical, status or
 * indexability change, or when the word count moves by more than 20%.
 */
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

const brandShare = (r: VisibilityRun) => r.summary.shareOfVoice?.find((s) => s.isBrand)?.share ?? 0;

/** Prompt ids where the brand was named by at least one engine. */
function promptsWon(r: VisibilityRun): Set<string> {
  const s = new Set<string>();
  for (const a of r.answers ?? []) if (a.mentioned && !a.error) s.add(a.promptId);
  return s;
}

function promptsAsked(r: VisibilityRun): Set<string> {
  const s = new Set<string>();
  for (const a of r.answers ?? []) if (!a.error) s.add(a.promptId);
  return s;
}

/**
 * Visibility change between two runs. Matches the shape of AuditDiff['visibility'].
 * Prompts only count as won or lost when both runs asked them.
 */
export function diffVisibility(
  prev: VisibilityRun,
  next: VisibilityRun,
): NonNullable<AuditDiff['visibility']> {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const prevNames = new Set(
    (prev.summary.shareOfVoice ?? [])
      .filter((s) => !s.isBrand && s.mentions > 0)
      .map((s) => s.name.toLowerCase()),
  );
  const newCompetitors = (next.summary.shareOfVoice ?? [])
    .filter((s) => !s.isBrand && s.mentions > 0 && !prevNames.has(s.name.toLowerCase()))
    .map((s) => s.name);
  const bothAsked = new Set([...promptsAsked(prev)].filter((p) => promptsAsked(next).has(p)));
  const wonBefore = promptsWon(prev);
  const wonNow = promptsWon(next);
  return {
    mentionRateDelta: round((next.summary.mentionRate ?? 0) - (prev.summary.mentionRate ?? 0)),
    shareOfVoiceDelta: round(brandShare(next) - brandShare(prev)),
    newCompetitors,
    lostPrompts: [...bothAsked].filter((p) => wonBefore.has(p) && !wonNow.has(p)),
    wonPrompts: [...bothAsked].filter((p) => !wonBefore.has(p) && wonNow.has(p)),
  };
}

export function diffAudits(prev: AuditResult, next: AuditResult): AuditDiff {
  const before = dedupe(prev.issues);
  const after = dedupe(next.issues);
  const newIssues = [...after].filter(([k]) => !before.has(k)).map(([, v]) => v);
  const fixedIssues = [...before].filter(([k]) => !after.has(k)).map(([, v]) => v);

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
