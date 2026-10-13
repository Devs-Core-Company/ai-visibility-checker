/**
 * Scoring: overall 0–100 from six pillars (weights in docs/ARCHITECTURE.md).
 *
 * Each check that ran earns points in its pillar, weighted by severity
 * (critical 10, high 6, medium 3, low 1, info 0). A site check that found
 * nothing earns all its points; one that found something earns none. A page
 * check loses points by reach: any affected page costs a quarter of its
 * points, and the rest scales with the share of pages affected. Checks that
 * were skipped are left out of the denominator — an unmeasured check is not a
 * failed one.
 *
 * The ai-visibility pillar comes from a real visibility run (mention rate,
 * share of voice, own-site citations, sentiment, fact errors). Without one,
 * its weight is shared out over the other pillars and the score is flagged
 * `readinessOnly`.
 */
import type {
  AuditResult,
  CategoryScore,
  Fix,
  Issue,
  PageSummary,
  Pillar,
  Severity,
  VisibilityRun,
} from '../core/types.js';
import type { CheckStatusMap } from './run-checks.js';

export const PILLAR_WEIGHTS: Record<Pillar, number> = {
  technical: 20,
  content: 15,
  'ai-access': 20,
  geo: 15,
  agentic: 5,
  'ai-visibility': 25,
};

export const PILLAR_ORDER: Pillar[] = [
  'technical',
  'content',
  'ai-access',
  'geo',
  'agentic',
  'ai-visibility',
];

export const PILLAR_LABELS: Record<Pillar, string> = {
  technical: 'Technical SEO',
  content: 'Content',
  'ai-access': 'AI crawler access',
  geo: 'AEO / GEO readiness',
  agentic: 'Agentic web',
  'ai-visibility': 'AI visibility',
};

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 10,
  high: 6,
  medium: 3,
  low: 1,
  info: 0,
};

const SEVERITY_RANK: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

/** Any affected page costs this share of a page check's points; the rest scales with reach. */
export const PRESENCE_PENALTY = 0.25;

export type Grade = AuditResult['score']['grade'];

export type ScoreBreakdown = AuditResult['score'] & {
  /** True when no AI visibility run was scored and its weight was redistributed. */
  readinessOnly: boolean;
  /** How the ai-visibility pillar was built, when a run was present. */
  visibilityParts?: VisibilityPart[];
};

export interface VisibilityPart {
  id: 'mention-rate' | 'share-of-voice' | 'own-citations' | 'sentiment' | 'accuracy';
  label: string;
  /** 0–1 */
  value: number;
  weight: number;
  measured: boolean;
}

export function gradeFor(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK.indexOf(a) >= SEVERITY_RANK.indexOf(b) ? a : b;
}

/** Severity used for scoring a check: the definition's, raised by any escalated instance. */
export function effectiveSeverity(defSeverity: Severity, issues: Issue[]): Severity {
  let s = defSeverity;
  for (const i of issues) if (i.severity) s = maxSeverity(s, i.severity);
  return s;
}

/** Pages page-checks are measured against: HTML-ish 200 responses, at least one. */
export function applicablePageCount(pages: PageSummary[] | number): number {
  if (typeof pages === 'number') return Math.max(1, pages);
  const ok = pages.filter((p) => p.status >= 200 && p.status < 300).length;
  return Math.max(1, ok || pages.length);
}

/** 0–1 share of a check's points it keeps. */
export function checkPassRate(
  scope: 'page' | 'site',
  affected: number,
  pageCount: number,
): number {
  if (affected <= 0) return 1;
  if (scope === 'site') return 0;
  const reach = clamp01(affected / Math.max(1, pageCount));
  return clamp01(1 - (PRESENCE_PENALTY + (1 - PRESENCE_PENALTY) * reach));
}

function groupIssues(issues: Issue[]): Map<string, Issue[]> {
  const m = new Map<string, Issue[]>();
  for (const i of issues) {
    const arr = m.get(i.checkId);
    if (arr) arr.push(i);
    else m.set(i.checkId, [i]);
  }
  return m;
}

/** The ai-visibility pillar from a run: 0–100, or null when the run has no usable answers. */
export function visibilityScore(
  run: VisibilityRun | undefined | null,
): { score: number; parts: VisibilityPart[] } | null {
  if (!run) return null;
  const s = run.summary;
  const answers = run.answers?.filter((a) => !a.error) ?? [];
  const engineAnswers = Object.values(s.byEngine ?? {}).reduce((n, e) => n + (e.answers || 0), 0);
  const total = answers.length || engineAnswers;
  if (!total) return null;

  const mentioned = answers.length
    ? answers.filter((a) => a.mentioned).length
    : Math.round(s.mentionRate * total);
  const brandShare = s.shareOfVoice?.find((x) => x.isBrand)?.share ?? 0;
  const hasRivals = (s.shareOfVoice ?? []).some((x) => !x.isBrand && x.mentions > 0);
  const citedOwn = answers.length
    ? answers.filter((a) => a.citations?.some((c) => c.ownSite)).length
    : Object.values(s.byEngine ?? {}).reduce((n, e) => n + (e.citedOwnSite || 0), 0);
  const sentTotal = s.sentiment.positive + s.sentiment.neutral + s.sentiment.negative;

  const parts: VisibilityPart[] = [
    {
      id: 'mention-rate',
      label: 'Named in answers',
      value: clamp01(s.mentionRate),
      weight: 40,
      measured: true,
    },
    {
      // Holding half the voice among named brands counts as full marks.
      id: 'share-of-voice',
      label: 'Share of voice',
      value: hasRivals ? clamp01(brandShare * 2) : clamp01(s.mentionRate),
      weight: 25,
      measured: (s.shareOfVoice ?? []).length > 0,
    },
    {
      // Being cited in a third of answers counts as full marks.
      id: 'own-citations',
      label: 'Own pages cited',
      value: clamp01((citedOwn / total) * 3),
      weight: 15,
      measured: true,
    },
    {
      id: 'sentiment',
      label: 'Sentiment',
      value: sentTotal ? clamp01((s.sentiment.positive + 0.5 * s.sentiment.neutral) / sentTotal) : 0,
      weight: 10,
      measured: sentTotal > 0,
    },
    {
      id: 'accuracy',
      label: 'Facts right',
      value: mentioned ? clamp01(1 - s.factIssues / mentioned) : 0,
      weight: 10,
      measured: mentioned > 0,
    },
  ];
  const measured = parts.filter((p) => p.measured);
  const w = measured.reduce((n, p) => n + p.weight, 0);
  const score = w ? (100 * measured.reduce((n, p) => n + p.value * p.weight, 0)) / w : 0;
  return { score: round1(score), parts };
}

export function scoreAudit(
  status: CheckStatusMap,
  issues: Issue[],
  pages: PageSummary[] | number,
  visibility?: VisibilityRun | null,
): ScoreBreakdown {
  const pageCount = applicablePageCount(pages);
  const byCheck = groupIssues(issues);

  const acc = new Map<Pillar, { earned: number; max: number; passed: number; failed: number; skipped: number }>();
  for (const p of PILLAR_ORDER) acc.set(p, { earned: 0, max: 0, passed: 0, failed: 0, skipped: 0 });

  for (const [id, c] of Object.entries(status)) {
    const a = acc.get(c.pillar);
    if (!a) continue;
    if (c.status === 'skipped') {
      a.skipped++;
      continue;
    }
    const own = byCheck.get(id) ?? [];
    const affected = c.affected || (own.length ? new Set(own.map((i) => i.url ?? '')).size : 0);
    if (affected > 0) a.failed++;
    else a.passed++;
    const w = SEVERITY_WEIGHT[effectiveSeverity(c.severity, own)];
    if (!w) continue;
    a.max += w;
    a.earned += w * checkPassRate(c.scope, affected, pageCount);
  }

  const vis = visibilityScore(visibility);
  const raw = new Map<Pillar, number | null>();
  for (const p of PILLAR_ORDER) {
    const a = acc.get(p)!;
    const checksScore = a.max > 0 ? (100 * a.earned) / a.max : null;
    if (p === 'ai-visibility') {
      // The outcome dominates; readiness checks in this pillar (if any) add a fifth.
      if (vis) raw.set(p, checksScore === null ? vis.score : 0.8 * vis.score + 0.2 * checksScore);
      else raw.set(p, null);
    } else raw.set(p, checksScore);
  }

  const measuredWeight = PILLAR_ORDER.reduce(
    (n, p) => n + (raw.get(p) === null ? 0 : PILLAR_WEIGHTS[p]),
    0,
  );
  const pillars: CategoryScore[] = PILLAR_ORDER.map((p) => {
    const a = acc.get(p)!;
    const s = raw.get(p);
    const weight = s === null || !measuredWeight ? 0 : (PILLAR_WEIGHTS[p] * 100) / measuredWeight;
    return {
      pillar: p,
      score: s === null ? 0 : Math.round(s),
      weight: round1(weight),
      passed: a.passed,
      failed: a.failed,
      skipped: a.skipped,
    };
  });

  const overall = measuredWeight
    ? Math.round(
        PILLAR_ORDER.reduce((n, p) => {
          const s = raw.get(p);
          return s === null ? n : n + (s * PILLAR_WEIGHTS[p]) / measuredWeight;
        }, 0),
      )
    : 0;

  return {
    overall,
    grade: gradeFor(overall),
    pillars,
    readinessOnly: !vis,
    ...(vis ? { visibilityParts: vis.parts } : {}),
  };
}

export const EFFORT_DIVISOR: Record<Fix['effort'], number> = { minutes: 1, hours: 1.5, days: 2.5 };

/**
 * Rank failing checks by impact × reach ÷ effort. `impact` is the points the
 * check costs the overall score today (0–100 scale), divided by effort when a
 * fix is known. Info checks are never priorities.
 */
export function rankPriorities(
  status: CheckStatusMap,
  issues: Issue[],
  pages: PageSummary[] | number,
  opts: { fixes?: Fix[]; limit?: number; readinessOnly?: boolean } = {},
): AuditResult['priorities'] {
  const pageCount = applicablePageCount(pages);
  const byCheck = groupIssues(issues);
  const fixes = new Map((opts.fixes ?? []).map((f) => [f.checkId, f]));

  // Points available per pillar, for converting a check's loss into overall points.
  const pillarMax = new Map<Pillar, number>();
  for (const [id, c] of Object.entries(status)) {
    if (c.status !== 'ran') continue;
    const w = SEVERITY_WEIGHT[effectiveSeverity(c.severity, byCheck.get(id) ?? [])];
    pillarMax.set(c.pillar, (pillarMax.get(c.pillar) ?? 0) + w);
  }
  const visWeight = opts.readinessOnly === false ? PILLAR_WEIGHTS['ai-visibility'] : 0;
  const weightTotal =
    PILLAR_ORDER.reduce((n, p) => n + (p === 'ai-visibility' ? 0 : PILLAR_WEIGHTS[p]), 0) +
    visWeight;

  const out: AuditResult['priorities'] = [];
  for (const [id, c] of Object.entries(status)) {
    if (c.status !== 'ran' || c.affected <= 0) continue;
    const own = byCheck.get(id) ?? [];
    const sev = effectiveSeverity(c.severity, own);
    const w = SEVERITY_WEIGHT[sev];
    if (!w) continue;
    const loss = w * (1 - checkPassRate(c.scope, c.affected, pageCount));
    const max = pillarMax.get(c.pillar) || w;
    const pillarShare = (PILLAR_WEIGHTS[c.pillar] / weightTotal) * 100;
    let impact = (loss / max) * pillarShare;
    const fix = fixes.get(id);
    if (fix) impact /= EFFORT_DIVISOR[fix.effort] ?? 1;
    // Keep tiny but real problems visible above zero.
    impact = Math.max(0.1, round1(impact));
    out.push({ checkId: id, affected: c.affected, impact, ...(fix ? { fix } : {}) });
  }
  out.sort(
    (a, b) =>
      b.impact - a.impact ||
      SEVERITY_WEIGHT[status[b.checkId].severity] - SEVERITY_WEIGHT[status[a.checkId].severity] ||
      b.affected - a.affected ||
      a.checkId.localeCompare(b.checkId),
  );
  return opts.limit ? out.slice(0, opts.limit) : out;
}
