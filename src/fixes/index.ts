/**
 * Stack-aware fixes. `buildFix` turns one failing check into a Fix for the detected stack;
 * `buildFixes` does it for every failing check in an audit, ranked by
 * impact × reach ÷ effort.
 */
import type { AuditResult, CheckDef, Fix, Issue, PageSummary, StackInfo } from '../core/types.js';
import { FALLBACK, findRecipe } from './recipes/index.js';
import { CODE_STACKS, nextRouterFromSignals, stackLabel } from './stacks.js';
import type { BrandFacts, FixContext, Recipe, RecipeInput, StackFix } from './types.js';

export type { BrandFacts, FixContext } from './types.js';
export { findRecipe, RECIPES } from './recipes/index.js';

const MAX_PROMPT_URLS = 20;

function originFrom(ctx: FixContext, issues: Issue[]): string {
  const raw =
    ctx.site ?? ctx.result?.site ?? issues.find((i) => i.url)?.url ?? 'https://example.com';
  try {
    return new URL(raw).origin;
  } catch {
    return 'https://example.com';
  }
}

function uniqueUrls(issues: Issue[]): string[] {
  return [...new Set(issues.map((i) => i.url).filter((u): u is string => !!u))];
}

/** Can a connector apply this recipe for this stack? */
export function autoTargets(recipe: Recipe, stack: StackInfo): ('wordpress' | 'repo')[] {
  const out: ('wordpress' | 'repo')[] = [];
  if (recipe.auto?.wordpress && stack.id === 'wordpress') out.push('wordpress');
  if (recipe.auto?.repo && (CODE_STACKS.includes(stack.id) || stack.id === 'unknown'))
    out.push('repo');
  return out;
}

export function buildFix(
  def: CheckDef,
  issues: Issue[],
  ctx: {
    stack: StackInfo;
    site?: string;
    pages?: PageSummary[];
    result?: AuditResult;
    brand?: BrandFacts;
    /** Your own guidance per check id (config `fixes.overrides`). */
    overrides?: FixOverrides;
  },
): Fix {
  const origin = originFrom(ctx, issues);
  const input: RecipeInput = {
    ...ctx,
    pages: ctx.pages ?? ctx.result?.pages,
    def,
    issues,
    origin,
    host: new URL(origin).host,
    urls: uniqueUrls(issues),
    router: nextRouterFromSignals(ctx.stack),
  };
  const recipe = findRecipe(def.id);
  let sf: StackFix;
  try {
    sf = recipe.build(input);
  } catch {
    sf = FALLBACK.build(input);
  }
  if (!sf.steps.length) sf = { ...sf, ...FALLBACK.build(input) };
  sf = applyOverride(sf, ctx.overrides?.[def.id]);
  const targets = autoTargets(recipe, ctx.stack);
  const autoApplicable = targets.length > 0;
  const tier = autoApplicable
    ? 'auto'
    : (recipe.tier ?? (def.fixTier === 'auto' ? 'guided' : def.fixTier));
  const fix: Fix = {
    checkId: def.id,
    stack: ctx.stack.id,
    tier,
    title: sf.title ?? def.title,
    steps: sf.steps,
    files: [...new Set(sf.files)],
    snippet: sf.snippet,
    agentPrompt: '',
    autoApplicable,
    effort: recipe.effort,
    impact: recipe === FALLBACK ? impactFromSeverity(def) : recipe.impact,
  };
  fix.agentPrompt = buildAgentPrompt(def, input, fix, sf.acceptance ?? [], targets);
  return fix;
}

export type FixOverrides = Record<string, { steps?: string[]; note?: string; replace?: boolean }>;

/** Your own guidance first (or instead of the built-in steps with `replace`). */
export function applyOverride(sf: StackFix, o: FixOverrides[string] | undefined): StackFix {
  if (!o || (!o.steps?.length && !o.note)) return sf;
  const own = [...(o.note ? [`Note from your team: ${o.note}`] : []), ...(o.steps ?? [])];
  return { ...sf, steps: o.replace && o.steps?.length ? own : [...own, ...sf.steps] };
}

function impactFromSeverity(def: CheckDef): Fix['impact'] {
  return def.severity === 'critical' || def.severity === 'high'
    ? 'high'
    : def.severity === 'medium'
      ? 'medium'
      : 'low';
}

/** A complete, self-contained prompt for an AI coding agent. */
export function buildAgentPrompt(
  def: CheckDef,
  input: RecipeInput,
  fix: Fix,
  acceptance: string[],
  targets: ('wordpress' | 'repo')[] = [],
): string {
  const urls = input.urls.slice(0, MAX_PROMPT_URLS);
  const evidence = input.issues
    .filter((i) => i.evidence || i.message)
    .slice(0, 5)
    .map(
      (i) =>
        `- ${i.url ? `${i.url}: ` : ''}${i.message}${i.evidence ? ` (evidence: ${i.evidence.slice(0, 200)})` : ''}`,
    );
  const manual = fix.tier === 'manual';
  const lines = [
    `You are fixing an issue found by AI Visibility Checker on ${input.origin}.`,
    '',
    `## Problem: ${def.title} (\`${def.id}\`)`,
    def.why,
    '',
    `## Stack`,
    `${stackLabel(input.stack, input.router)}${input.stack.host ? `, hosted on ${input.stack.host}` : ''}${input.stack.seoPlugin ? `, SEO plugin: ${input.stack.seoPlugin}` : ''}.`,
    '',
  ];
  if (urls.length) {
    lines.push(
      `## Affected URLs (${input.urls.length}${input.urls.length > urls.length ? `, first ${urls.length} shown` : ''})`,
    );
    lines.push(...urls.map((u) => `- ${u}`), '');
  } else {
    lines.push('## Scope', 'Site-wide.', '');
  }
  if (evidence.length) lines.push('## What the audit saw', ...evidence, '');
  lines.push('## Files likely involved', ...fix.files.map((f) => `- ${f}`), '');
  lines.push('## Steps', ...fix.steps.map((s, i) => `${i + 1}. ${s}`), '');
  if (fix.snippet)
    lines.push('## Reference code', '```' + fix.snippet.language, fix.snippet.code, '```', '');
  lines.push(
    '## Rules',
    '- Find the real files in this project first; the paths above are the usual locations for this stack and may differ.',
    '- Change only what this fix needs. Keep existing behaviour, rules and content unless a step says otherwise.',
    '- Do not invent facts (addresses, prices, clients, dates). Leave a clear TODO where a fact is missing.',
    ...(manual
      ? ['- This is content work: draft it, then mark it for human review rather than publishing.']
      : []),
    '',
    '## Acceptance criteria',
    ...[
      ...acceptance,
      'The project builds and existing tests pass',
      `\`avc audit --only ${def.id}\` reports no issues for this check`,
    ].map((a) => `- [ ] ${a}`),
    '',
    `Verify with \`avc audit --only ${def.id}\`.`,
  );
  if (targets.length)
    lines.push(
      '',
      `This fix can also be applied by the app: \`avc fix --apply --target ${targets[0]} --only ${def.id}\` (dry run first).`,
    );
  return lines.join('\n');
}

const IMPACT_W = { high: 3, medium: 2, low: 1 } as const;
const EFFORT_W = { minutes: 1, hours: 2, days: 4 } as const;
const SEVERITY_W = { critical: 2, high: 1.5, medium: 1, low: 0.7, info: 0.4 } as const;

/** Ranking score: impact × severity × reach ÷ effort. Reach grows with the log of pages affected. */
export function fixScore(fix: Fix, def: CheckDef, affected: number, totalPages: number): number {
  const reach =
    def.scope === 'site'
      ? Math.log2(2 + Math.max(totalPages, 1))
      : Math.log2(1 + Math.max(affected, 1));
  return (IMPACT_W[fix.impact] * SEVERITY_W[def.severity] * reach) / EFFORT_W[fix.effort];
}

/** One Fix per failing check, best first. */
export function buildFixes(
  result: AuditResult,
  opts: { brand?: BrandFacts; overrides?: FixOverrides } = {},
): Fix[] {
  const byCheck = new Map<string, Issue[]>();
  for (const i of result.issues) {
    const list = byCheck.get(i.checkId) ?? [];
    list.push(i);
    byCheck.set(i.checkId, list);
  }
  const brand: BrandFacts | undefined =
    opts.brand ??
    (result.visibility?.brand
      ? {
          name: result.visibility.brand.name,
          description: result.visibility.brand.description,
          services: result.visibility.brand.services,
          location: result.visibility.brand.location,
          sameAs: result.visibility.entity?.sameAs,
        }
      : undefined);
  const scored: { fix: Fix; score: number }[] = [];
  for (const [checkId, issues] of byCheck) {
    const meta = result.checks[checkId];
    if (meta?.status === 'skipped') continue;
    const def: CheckDef = meta ?? {
      id: checkId,
      category: (checkId.split('.')[0] as CheckDef['category']) ?? 'content',
      pillar: 'technical',
      title: checkId,
      why: '',
      severity: issues[0].severity ?? 'medium',
      scope: issues.some((i) => i.url) ? 'page' : 'site',
      fixTier: 'guided',
      fix: issues[0].message,
    };
    if (def.severity === 'info' && !issues.some((i) => i.severity && i.severity !== 'info'))
      continue;
    const fix = buildFix(def, issues, {
      stack: result.stack,
      site: result.site,
      pages: result.pages,
      result,
      brand,
      overrides: opts.overrides,
    });
    const affected = meta?.affected ?? (uniqueUrls(issues).length || 1);
    scored.push({ fix, score: fixScore(fix, def, affected, result.pages.length) });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.fix.checkId.localeCompare(b.fix.checkId))
    .map((s) => s.fix);
}

export { applyFixes } from './apply/index.js';
export { rollback } from './apply/rollback.js';
export * from './generate.js';
export { WP_HELPER_PHP, WP_HELPER_FILENAME, WP_HELPER_INSTALL } from './apply/wp-helper.js';
