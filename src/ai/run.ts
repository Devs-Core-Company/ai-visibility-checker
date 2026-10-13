import { randomBytes } from 'node:crypto';

import type { AvcConfig } from '../core/config.js';
import type {
  BrandProfile,
  Citation,
  EngineAnswer,
  EngineId,
  ProgressFn,
  SiteContext,
  TrackedPrompt,
  VisibilityRun,
} from '../core/types.js';
import { extractSiteFacts, sameAsLinks, type SiteFacts } from './brand.js';
import {
  askEngine,
  defaultEngines,
  engineLabel,
  engineStatus,
  helperModel,
  isBudgetError,
  isMock,
  isRefusedError,
  type AnswerResult,
  type EngineStatus,
} from './engines.js';
import { lookupEntity } from './entity.js';
import { checkFacts, factKey, isPlatform, judgeAnswer, type Judgement } from './judge.js';
import { mockAnswer } from './mock.js';
import { expectedCallCost } from './pricing.js';
import { describeError, hostOf, mapLimit, normBrand, sameBrand, sameSite, truncate, uniq } from './util.js';

export interface RunVisibilityInput {
  brand: BrandProfile;
  prompts: TrackedPrompt[];
  site?: SiteContext;
  config: AvcConfig;
  /** Engines to ask. Default: every available core engine (plus Grok with a direct xAI key). */
  engines?: EngineId[];
  /** Ask each prompt this many times per engine to measure how much answers vary. Default 1, max 10. */
  repeats?: number;
  /** Spend so far this calendar month (USD), for the monthly ceiling. */
  monthSpendUsd?: number;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
  /** Parallel calls. Default 6. */
  concurrency?: number;
  /** Look the brand up on Wikidata / Knowledge Graph. Default true (skipped in mock mode). */
  entity?: boolean;
}

/**
 * Spend guard. Before each call the expected cost is reserved; a call that
 * would take spent + reserved past the ceiling is not started.
 */
export class Budget {
  spent = 0;
  private reserved = 0;
  constructor(readonly capUsd: number) {}
  tryReserve(usd: number): boolean {
    if (this.spent + this.reserved + usd > this.capUsd + 1e-9) return false;
    this.reserved += usd;
    return true;
  }
  settle(reservedUsd: number, actualUsd: number): void {
    this.reserved = Math.max(0, this.reserved - reservedUsd);
    this.spent += actualUsd;
  }
}

export function runCeiling(config: AvcConfig, monthSpendUsd = 0): number {
  const run = Number.isFinite(config.ai.maxRunUsd) ? config.ai.maxRunUsd : 3;
  const month = Number.isFinite(config.ai.maxMonthUsd) ? config.ai.maxMonthUsd : 30;
  return Math.max(0, Math.min(run, month - monthSpendUsd));
}

interface Job {
  prompt: TrackedPrompt;
  status: EngineStatus;
  repeat: number;
}

function newId(): string {
  return `vis_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

/** Competitor names from the profile plus everyone named in non-brand answers. */
function competitorNames(brand: BrandProfile, judgements: (Judgement | null)[]): string[] {
  const names = [...brand.competitors.map((c) => c.name)];
  for (const j of judgements)
    for (const n of j?.brandsNamed ?? [])
      if (!isOwn(n, brand) && !names.some((x) => sameBrand(x, n))) names.push(n);
  return names;
}

function isOwn(name: string, brand: BrandProfile): boolean {
  return [brand.name, ...brand.aliases, brand.domain].some((b) => sameBrand(b, name));
}

function toCitation(
  c: { url: string; title?: string },
  brand: BrandProfile,
  named: string[],
): Citation {
  const domain = hostOf(c.url);
  const ownSite = sameSite(domain, brand.domain);
  let competitor: string | undefined;
  if (!ownSite) {
    const known = brand.competitors.find((x) => x.domain && sameSite(domain, x.domain));
    if (known) competitor = known.name;
    else {
      const label = domain.split('.').slice(0, -1).join('.') || domain;
      const hit = named.find((n) => !isPlatform(n) && !isOwn(n, brand) && sameBrand(n, label));
      if (hit) competitor = hit;
    }
  }
  return {
    url: c.url,
    domain,
    ...(c.title ? { title: truncate(c.title, 200) } : {}),
    ownSite,
    ...(competitor ? { competitor } : {}),
  };
}

const NON_BRAND: TrackedPrompt['kind'][] = ['category', 'comparison', 'problem', 'custom'];

/**
 * Ask every prompt to every engine (optionally N times), grade every answer,
 * check what the engines say about the brand against the site, and add up
 * mention rate, share of voice, citations and competitor wins.
 */
export async function runVisibility(input: RunVisibilityInput): Promise<VisibilityRun> {
  const { brand, config, signal } = input;
  const progress = input.onProgress ?? (() => {});
  const mock = isMock(config);
  const statuses = engineStatus(config);
  const wanted = uniq(input.engines?.length ? input.engines : defaultEngines(config));
  const repeats = Math.max(1, Math.min(10, Math.floor(input.repeats ?? 1)));
  const useModelJudge = !mock && Boolean(helperModel(config, 'judge'));
  const judgeModel = helperModel(config, 'judge');
  const budget = new Budget(mock ? Number.POSITIVE_INFINITY : runCeiling(config, input.monthSpendUsd));
  const startedAt = new Date().toISOString();

  const jobs: Job[] = [];
  const unavailable: EngineAnswer[] = [];
  for (const engine of wanted) {
    const status = statuses.find((s) => s.engine === engine);
    for (const prompt of input.prompts) {
      if (!status || !status.available) {
        unavailable.push(emptyAnswer(engine, status?.model ?? 'n/a', prompt, status?.note ?? `${engine} is not available.`));
        continue;
      }
      if (!prompt.search && !status.canDisableSearch) continue;
      for (let r = 0; r < repeats; r += 1) jobs.push({ prompt, status, repeat: r });
    }
  }

  progress({
    type: 'phase',
    phase: 'visibility',
    message: `Asking ${wanted.map(engineLabel).join(', ')} ${input.prompts.length} prompt${input.prompts.length === 1 ? '' : 's'}${repeats > 1 ? ` × ${repeats} repeats` : ''}${mock ? ' (mock mode: sample answers, no spend)' : ''}`,
  });

  let budgetHit = false;
  let ceilingHit = false;
  const refused = new Set<EngineId>();
  let done = 0;
  const judgements: (Judgement | null)[] = new Array(jobs.length).fill(null);

  const answers = await mapLimit(jobs, input.concurrency ?? 6, async (job, i): Promise<EngineAnswer> => {
    const { prompt, status } = job;
    const base = emptyAnswer(status.engine, status.model, prompt);
    const finish = (a: EngineAnswer) => {
      done += 1;
      if (done % 5 === 0 || done === jobs.length)
        progress({ type: 'log', level: 'info', message: `AI visibility: ${done}/${jobs.length} answers` });
      return a;
    };
    if (signal?.aborted) return finish({ ...base, error: 'Cancelled' });
    if (budgetHit) return finish({ ...base, error: 'Skipped: the provider reports the budget or credits are used up' });
    if (refused.has(status.engine))
      return finish({ ...base, error: `Skipped: ${engineLabel(status.engine)} refused the API key` });

    const estimate = mock
      ? 0
      : expectedCallCost(status.model, 'answer', prompt.search, status.engine) +
        (useModelJudge && judgeModel ? expectedCallCost(judgeModel.model, 'judge', false) : 0);
    if (!budget.tryReserve(estimate)) {
      ceilingHit = true;
      return finish({
        ...base,
        error: `Skipped: the next call would pass the spend ceiling ($${budget.capUsd.toFixed(2)})`,
      });
    }

    const started = Date.now();
    let answer: AnswerResult;
    try {
      answer =
        status.via === 'mock'
          ? mockAnswer({ engine: status.engine, prompt, brand, site: input.site, repeat: job.repeat })
          : await askEngine(status, prompt.text, prompt.search, config, signal);
    } catch (error) {
      budget.settle(estimate, 0);
      if (isBudgetError(error)) budgetHit = true;
      else if (isRefusedError(error)) refused.add(status.engine);
      progress({ type: 'log', level: 'warn', message: `${engineLabel(status.engine)} failed: ${describeError(error)}` });
      return finish({
        ...base,
        ms: Date.now() - started,
        error: signal?.aborted ? 'Cancelled' : `The engine did not answer: ${describeError(error)}`,
      });
    }
    const ms = Date.now() - started;

    const judged = await judgeAnswer(
      { text: answer.text, question: prompt.text, citations: answer.citations.map((c) => c.url), brand },
      config,
      useModelJudge,
      signal,
    );
    budget.settle(estimate, answer.costUsd + judged.costUsd);
    judgements[i] = judged.judgement;
    const j = judged.judgement;

    return finish({
      ...base,
      answer: truncate(answer.text, 10_000),
      citations: answer.citations.map((c) => toCitation(c, brand, j.brandsNamed)),
      searchQueries: answer.queries,
      mentioned: j.mentioned,
      position: j.position,
      brandsNamed: j.brandsNamed,
      sentiment: j.sentiment,
      costUsd: answer.costUsd + judged.costUsd,
      ms,
      ...(answer.text ? {} : { error: 'Empty answer' }),
    });
  });

  if (ceilingHit)
    progress({ type: 'log', level: 'warn', message: `AI visibility stopped at the spend ceiling of $${budget.capUsd.toFixed(2)}. Raise maxRunUsd or ask fewer prompts.` });

  // Second pass: competitors named anywhere, so citations can be attributed across answers.
  const competitors = competitorNames(brand, judgements);
  for (const a of answers)
    for (const c of a.citations)
      if (!c.ownSite && !c.competitor) {
        const label = c.domain.split('.').slice(0, -1).join('.');
        const hit = competitors.find((n) => !isPlatform(n) && sameBrand(n, label));
        if (hit) c.competitor = hit;
      }

  // Facts the engines state about the brand, checked against the site once.
  let extraCost = 0;
  const facts: SiteFacts = input.site
    ? extractSiteFacts(input.site, brand)
    : { locations: brand.location ? [brand.location] : [], emails: [], phones: [], services: brand.services, text: brand.description ?? '' };
  const claims = judgements.flatMap((j) => (j?.mentioned ? j.facts : []));
  if (claims.length && !signal?.aborted) {
    const est = useModelJudge && judgeModel ? expectedCallCost(judgeModel.model, 'judge', false) * 2 : 0;
    const allowModel = useModelJudge && budget.tryReserve(est);
    const checked = await checkFacts(claims, brand, facts, config, allowModel, signal);
    if (allowModel) budget.settle(est, checked.costUsd);
    extraCost += checked.costUsd;
    answers.forEach((a, i) => {
      const j = judgements[i];
      if (!j?.mentioned) return;
      a.factIssues = uniq(j.facts, factKey)
        .map((claim) => ({ claim, v: checked.verdicts.get(factKey(claim)) }))
        .filter((x) => x.v && x.v.verdict !== 'matches')
        .map((x) => ({
          claim: x.claim,
          ...(x.v!.siteSays ? { siteSays: x.v!.siteSays } : {}),
          verdict: x.v!.verdict as 'wrong' | 'outdated' | 'unverifiable',
        }));
    });
  }

  let entity: VisibilityRun['entity'];
  if (input.entity !== false && !signal?.aborted) {
    try {
      entity = await lookupEntity(brand, {
        sameAs: input.site ? sameAsLinks(input.site) : [],
        offline: mock,
        signal,
      });
    } catch {
      entity = undefined;
    }
  }

  const all = [...answers, ...unavailable];
  const run: VisibilityRun = {
    id: newId(),
    at: startedAt,
    brand,
    prompts: input.prompts,
    answers: all,
    summary: summarise(all, brand, input.prompts),
    ...(entity ? { entity } : {}),
  };
  run.summary.costUsd = round(run.summary.costUsd + extraCost);
  progress({
    type: 'log',
    level: 'info',
    message: `AI visibility: named in ${Math.round(run.summary.mentionRate * 100)}% of answers, estimated cost $${run.summary.costUsd.toFixed(3)}`,
  });
  return run;
}

function emptyAnswer(engine: EngineId, model: string, prompt: TrackedPrompt, error?: string): EngineAnswer {
  return {
    engine,
    model,
    promptId: prompt.id,
    prompt: prompt.text,
    answer: '',
    citations: [],
    searchQueries: [],
    mentioned: false,
    position: null,
    brandsNamed: [],
    sentiment: null,
    factIssues: [],
    costUsd: 0,
    ms: 0,
    ...(error ? { error } : {}),
  };
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Answers that count: the engine answered. */
export function validAnswers(answers: EngineAnswer[]): EngineAnswer[] {
  return answers.filter((a) => !a.error && a.answer);
}

/** Groups brand names that are the same company ("Acme", "ACME Ltd", "acme.com"). */
function clusterNames(names: string[]): Map<string, string> {
  const labels: { key: string; variants: Map<string, number> }[] = [];
  const toKey = new Map<string, string>();
  for (const n of names) {
    let c = labels.find((l) => [...l.variants.keys()].some((v) => sameBrand(v, n)));
    if (!c) {
      c = { key: normBrand(n) || n.toLowerCase(), variants: new Map() };
      labels.push(c);
    }
    c.variants.set(n, (c.variants.get(n) ?? 0) + 1);
    toKey.set(n, c.key);
  }
  return toKey;
}

/** The VisibilityRun summary, from the answers alone. Pure, so it can be recomputed any time. */
export function summarise(
  answers: EngineAnswer[],
  brand: BrandProfile,
  prompts: TrackedPrompt[],
): VisibilityRun['summary'] {
  const valid = validAnswers(answers);
  const kindOf = new Map(prompts.map((p) => [p.id, p.kind]));
  const rate = (xs: EngineAnswer[]) => (xs.length ? xs.filter((a) => a.mentioned).length / xs.length : 0);

  // By engine (every engine that was asked, even if all its calls failed).
  const byEngine: VisibilityRun['summary']['byEngine'] = {};
  for (const engine of uniq(answers.map((a) => a.engine))) {
    const xs = valid.filter((a) => a.engine === engine);
    const positions = xs.map((a) => a.position).filter((p): p is number => typeof p === 'number');
    byEngine[engine] = {
      mentionRate: round(rate(xs)),
      avgPosition: positions.length ? round(positions.reduce((s, p) => s + p, 0) / positions.length, 2) : null,
      answers: xs.length,
      citedOwnSite: xs.filter((a) => a.citations.some((c) => c.ownSite)).length,
    };
  }

  // Share of voice across non-brand prompts: each answer counts each company once.
  const sovAnswers = valid.filter((a) => NON_BRAND.includes(kindOf.get(a.promptId) ?? 'custom'));
  const allNames = sovAnswers.flatMap((a) => a.brandsNamed.filter((n) => !isOwn(n, brand) && !isPlatform(n)));
  const keyOf = clusterNames(allNames);
  const counts = new Map<string, { names: Map<string, number>; mentions: number }>();
  let own = 0;
  for (const a of sovAnswers) {
    if (a.mentioned) own += 1;
    const seen = new Set<string>();
    for (const n of a.brandsNamed) {
      if (isOwn(n, brand) || isPlatform(n)) continue;
      const k = keyOf.get(n) ?? normBrand(n);
      if (seen.has(k)) continue;
      seen.add(k);
      const entry = counts.get(k) ?? { names: new Map(), mentions: 0 };
      entry.mentions += 1;
      entry.names.set(n, (entry.names.get(n) ?? 0) + 1);
      counts.set(k, entry);
    }
  }
  const total = own + [...counts.values()].reduce((s, c) => s + c.mentions, 0);
  const shareOfVoice = [
    { name: brand.name, mentions: own, isBrand: true },
    ...[...counts.values()].map((c) => ({
      name: [...c.names.entries()].sort((x, y) => y[1] - x[1] || x[0].length - y[0].length)[0]![0],
      mentions: c.mentions,
      isBrand: false,
    })),
  ]
    .map((s) => ({ ...s, share: total ? round(s.mentions / total) : 0 }))
    .sort((a, b) => b.mentions - a.mentions || Number(b.isBrand) - Number(a.isBrand))
    .filter((s, i) => s.isBrand || i < 15)
    .map(({ name, share, mentions, isBrand }) => ({ name, share, mentions, isBrand }));

  // Citations.
  const domainCounts = new Map<string, number>();
  const ownCounts = new Map<string, number>();
  for (const a of valid)
    for (const c of a.citations) {
      domainCounts.set(c.domain, (domainCounts.get(c.domain) ?? 0) + 1);
      if (c.ownSite) ownCounts.set(c.url, (ownCounts.get(c.url) ?? 0) + 1);
    }
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  // Competitor wins: non-brand prompts where the brand was named in under half the answers.
  const competitorWins: VisibilityRun['summary']['competitorWins'] = [];
  for (const p of prompts) {
    if (!NON_BRAND.includes(p.kind)) continue;
    const xs = valid.filter((a) => a.promptId === p.id);
    if (!xs.length || rate(xs) >= 0.5) continue;
    const tally = new Map<string, { name: string; count: number; rankSum: number }>();
    for (const a of xs) {
      const others = a.brandsNamed.filter((n) => !isOwn(n, brand) && !isPlatform(n));
      others.forEach((n, idx) => {
        const k = [...tally.keys()].find((key) => sameBrand(tally.get(key)!.name, n)) ?? normBrand(n);
        const t = tally.get(k) ?? { name: n, count: 0, rankSum: 0 };
        t.count += 1;
        t.rankSum += idx + 1;
        tally.set(k, t);
      });
    }
    const winner = [...tally.values()].sort((a, b) => b.count - a.count || a.rankSum / a.count - b.rankSum / b.count)[0];
    if (!winner) continue;
    const lost = xs.filter((a) => !a.mentioned && a.brandsNamed.some((n) => sameBrand(n, winner.name)));
    const cites = lost.flatMap((a) => a.citations);
    const sources = uniq(
      [...cites.filter((c) => c.competitor && sameBrand(c.competitor, winner.name)), ...cites.filter((c) => !c.ownSite)].map((c) => c.url),
    ).slice(0, 8);
    competitorWins.push({
      promptId: p.id,
      prompt: p.text,
      winner: winner.name,
      engines: uniq(lost.map((a) => a.engine)),
      sources,
    });
  }

  const sentiment = { positive: 0, neutral: 0, negative: 0 };
  for (const a of valid) if (a.mentioned && a.sentiment) sentiment[a.sentiment] += 1;

  return {
    mentionRate: round(rate(valid)),
    byEngine,
    shareOfVoice,
    topCitedDomains: sorted(domainCounts)
      .slice(0, 20)
      .map(([domain, count]) => ({ domain, count })),
    ownPagesCited: sorted(ownCounts)
      .slice(0, 20)
      .map(([url, count]) => ({ url, count })),
    competitorWins,
    sentiment,
    factIssues: valid.reduce((s, a) => s + a.factIssues.length, 0),
    costUsd: round(answers.reduce((s, a) => s + a.costUsd, 0)),
  };
}
