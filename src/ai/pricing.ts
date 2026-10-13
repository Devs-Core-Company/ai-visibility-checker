import type { EngineId } from '../core/types.js';

/**
 * Price table for spend estimates. ESTIMATES ONLY — list prices change, and
 * providers bill search, caching and reasoning tokens in their own ways. The
 * numbers are used to stop a run before it passes `maxRunUsd` / `maxMonthUsd`
 * and to show an approximate cost; the provider's own dashboard is the bill.
 *
 * Last reviewed: 2026-10-13. Keys are bare model ids (no "provider/" prefix).
 * Unknown models fall back to DEFAULT_PRICE, which is deliberately on the high
 * side so an unknown model never under-counts.
 */
export const PRICES_REVIEWED = '2026-10-13';

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.4': { input: 2.5, output: 15 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  // Anthropic
  'claude-haiku-4.5': { input: 1, output: 5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4.5': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  // Google
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  // Perplexity
  sonar: { input: 1, output: 1 },
  'sonar-pro': { input: 3, output: 15 },
  // xAI
  'grok-4.1-fast': { input: 0.2, output: 0.5 },
  'grok-4-fast': { input: 0.2, output: 0.5 },
  'grok-4': { input: 3, output: 15 },
  // DeepSeek
  'deepseek-v3.2': { input: 0.3, output: 0.45 },
  'deepseek-chat': { input: 0.3, output: 0.45 },
};

export const DEFAULT_PRICE: ModelPrice = { input: 3, output: 15 };

/** USD per web search call (Perplexity: its per-request fee). Estimates. */
export const SEARCH_PRICES: Partial<Record<EngineId, number>> = {
  chatgpt: 0.01,
  claude: 0.01,
  gemini: 0.014,
  perplexity: 0.005,
  grok: 0.025,
};

export function bareModel(model: string): string {
  const i = model.indexOf('/');
  return i >= 0 ? model.slice(i + 1) : model;
}

export function priceFor(model: string): ModelPrice {
  return MODEL_PRICES[bareModel(model)] ?? DEFAULT_PRICE;
}

/** Estimated USD for one call. */
export function estimateCost(
  model: string,
  usage: { inputTokens?: number; outputTokens?: number },
  searches = 0,
  engine?: EngineId,
): number {
  const p = priceFor(model);
  const tokens = ((usage.inputTokens ?? 0) * p.input + (usage.outputTokens ?? 0) * p.output) / 1e6;
  return tokens + searches * (engine ? (SEARCH_PRICES[engine] ?? 0.01) : 0);
}

/**
 * Upper-bound guess for a call that has not happened yet, used to decide
 * whether the next call fits under the ceiling. Answers with search pull in
 * a lot of page text, hence the large input allowance.
 */
export function expectedCallCost(
  model: string,
  kind: 'answer' | 'judge',
  search: boolean,
  engine?: EngineId,
): number {
  if (kind === 'judge') return estimateCost(model, { inputTokens: 4_000, outputTokens: 900 });
  return estimateCost(
    model,
    { inputTokens: search ? 12_000 : 300, outputTokens: 1_400 },
    search ? 2 : 0,
    engine,
  );
}
