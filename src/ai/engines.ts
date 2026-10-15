import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createPerplexity } from '@ai-sdk/perplexity';
import { createGateway, generateText, Output, type LanguageModel, type ToolSet } from 'ai';
import type { z } from 'zod';

import type { AvcConfig } from '../core/config.js';
import { SECRET_FIELDS } from '../core/secrets.js';
import { isMock } from './availability.js';

export { aiUnavailableReason, hasAnyKey, isMock, NO_AI_KEY_REASON } from './availability.js';
import type { EngineId } from '../core/types.js';
import { bareModel, estimateCost } from './pricing.js';
import { describeError, withTimeout } from './util.js';

/**
 * Engines, keys and model calls.
 *
 * Bring your own keys: a provider key (OPENAI_API_KEY, ANTHROPIC_API_KEY,
 * GOOGLE_GENERATIVE_AI_API_KEY, PERPLEXITY_API_KEY, XAI_API_KEY) is used
 * directly for its engine. Engines without their own key go through the
 * Vercel AI Gateway when AI_GATEWAY_API_KEY is set. With no keys at all, or
 * with mock on, every engine returns labelled sample answers and nothing is
 * spent.
 *
 * Each engine gets its provider's own web search (OpenAI web search,
 * Anthropic web search, Google Search grounding, Perplexity Sonar's built-in
 * search), so "what ChatGPT says" is sampled the way ChatGPT searches.
 * Answers are API samples, not recordings of the consumer apps.
 */

export type Via = 'direct' | 'gateway' | 'mock';

export interface EngineEntry {
  engine: EngineId;
  via: Via;
  model: string;
}

export interface EngineStatus extends EngineEntry {
  label: string;
  available: boolean;
  /** Whether this engine searches the web when asked to. */
  search: boolean;
  /** Whether it can answer with search switched off (training-data answers). */
  canDisableSearch: boolean;
  /** Included in a run when the caller does not pick engines. */
  default: boolean;
  note?: string;
}

interface EngineInfo {
  id: EngineId;
  label: string;
  key?: keyof AvcConfig['ai'];
  keyEnv?: string;
  gatewayModel?: string;
  directModel?: string;
  search: boolean;
  canDisableSearch: boolean;
  core: boolean;
}

export const ENGINE_INFO: EngineInfo[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    key: 'openaiKey',
    keyEnv: 'OPENAI_API_KEY',
    gatewayModel: 'openai/gpt-5.4-mini',
    directModel: 'gpt-5.4-mini',
    search: true,
    canDisableSearch: true,
    core: true,
  },
  {
    id: 'claude',
    label: 'Claude',
    key: 'anthropicKey',
    keyEnv: 'ANTHROPIC_API_KEY',
    gatewayModel: 'anthropic/claude-haiku-4.5',
    directModel: 'claude-haiku-4-5',
    search: true,
    canDisableSearch: true,
    core: true,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    key: 'googleKey',
    keyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
    gatewayModel: 'google/gemini-3.8-flash',
    directModel: 'gemini-3.8-flash',
    search: true,
    canDisableSearch: true,
    core: true,
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    key: 'perplexityKey',
    keyEnv: 'PERPLEXITY_API_KEY',
    gatewayModel: 'perplexity/sonar',
    directModel: 'sonar',
    search: true,
    // Sonar always searches: there is no training-data-only mode to test.
    canDisableSearch: false,
    core: true,
  },
  {
    id: 'grok',
    label: 'Grok',
    key: 'xaiKey',
    keyEnv: 'XAI_API_KEY',
    gatewayModel: 'xai/grok-4.1-fast',
    directModel: 'grok-4.1-fast',
    // Answers from the model's own knowledge; xAI's search is not wired in.
    search: false,
    canDisableSearch: true,
    core: false,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    gatewayModel: 'deepseek/deepseek-v3.2',
    search: false,
    canDisableSearch: true,
    core: false,
  },
  {
    id: 'copilot',
    label: 'Microsoft Copilot',
    search: true,
    canDisableSearch: false,
    core: false,
  },
];

/** The `avc keys set <id>` id for an engine's config key. */
function keyIdFor(key: EngineInfo['key']): string {
  return SECRET_FIELDS.find((f) => f.path[0] === 'ai' && f.path[1] === key)?.id ?? 'gateway';
}

export function engineLabel(id: EngineId): string {
  return ENGINE_INFO.find((e) => e.id === id)?.label ?? id;
}

function modelFor(info: EngineInfo, via: Via, config: AvcConfig): string {
  const override = config.ai.models?.[info.id];
  if (via === 'gateway') {
    if (override)
      return override.includes('/') ? override : `${info.gatewayModel!.split('/')[0]}/${override}`;
    return info.gatewayModel!;
  }
  if (via === 'direct') return override ? bareModel(override) : info.directModel!;
  return `mock/${info.id}`;
}

/** Every engine with whether it can run, how, and why not. */
export function engineStatus(config: AvcConfig): EngineStatus[] {
  const mock = isMock(config);
  const xaiDirect = Boolean(config.ai.xaiKey);
  return ENGINE_INFO.map((info): EngineStatus => {
    const base = {
      engine: info.id,
      label: info.label,
      search: info.search,
      canDisableSearch: info.canDisableSearch,
    };
    if (info.id === 'copilot') {
      return {
        ...base,
        via: 'mock',
        model: 'n/a',
        available: false,
        default: false,
        note: 'Microsoft Copilot has no public API for its answers. Copilot grounds answers in Bing, so use Bing Webmaster Tools data and the ChatGPT (with search) results as the closest proxy.',
      };
    }
    if (mock) {
      return {
        ...base,
        via: 'mock',
        model: modelFor(info, 'mock', config),
        available: true,
        default: info.core,
        note: 'Mock mode: sample answers, nothing is sent to an AI provider.',
      };
    }
    const directKey = info.key ? config.ai[info.key] : undefined;
    if (directKey && info.directModel) {
      return {
        ...base,
        via: 'direct',
        model: modelFor(info, 'direct', config),
        available: true,
        default: info.core || (info.id === 'grok' && xaiDirect),
      };
    }
    if (config.ai.gatewayKey && info.gatewayModel) {
      return {
        ...base,
        via: 'gateway',
        model: modelFor(info, 'gateway', config),
        available: true,
        default: info.core,
      };
    }
    return {
      ...base,
      via: 'gateway',
      model: info.gatewayModel ?? 'n/a',
      available: false,
      default: false,
      note: info.keyEnv
        ? `Skipped: no ${info.label} key. Add one with \`avc keys set ${keyIdFor(info.key)}\` (or ${info.keyEnv}), or a Vercel AI Gateway key (\`avc keys set gateway\`) for every engine.`
        : `Skipped: ${info.label} runs through the Vercel AI Gateway. Add a key with \`avc keys set gateway\`.`,
    };
  });
}

/** Engines that can run with this config: direct key, else AI Gateway, else mock. */
export function availableEngines(config: AvcConfig): EngineEntry[] {
  return engineStatus(config)
    .filter((s) => s.available)
    .map(({ engine, via, model }) => ({ engine, via, model }));
}

/** The engines a run uses when the caller does not choose. */
export function defaultEngines(config: AvcConfig): EngineId[] {
  return engineStatus(config)
    .filter((s) => s.available && s.default)
    .map((s) => s.engine);
}

// ---------------------------------------------------------------------------
// Model construction
// ---------------------------------------------------------------------------

export function languageModel(
  entry: EngineEntry,
  config: AvcConfig,
  role: 'engine' | 'helper' = 'engine',
): LanguageModel {
  if (entry.via === 'gateway') return createGateway({ apiKey: config.ai.gatewayKey })(entry.model);
  const a = config.ai;
  switch (entry.engine) {
    case 'chatgpt':
      // An OpenAI-compatible endpoint speaks Chat Completions, not the Responses API.
      // Visibility answers must come from OpenAI itself; the custom endpoint is for helpers only.
      return a.openaiBaseUrl && role === 'helper'
        ? createOpenAI({ apiKey: a.openaiKey, baseURL: a.openaiBaseUrl }).chat(entry.model)
        : createOpenAI({ apiKey: a.openaiKey })(entry.model);
    case 'claude':
      return createAnthropic({ apiKey: a.anthropicKey })(entry.model);
    case 'gemini':
      return createGoogle({ apiKey: a.googleKey })(entry.model);
    case 'perplexity':
      return createPerplexity({ apiKey: a.perplexityKey })(entry.model);
    case 'grok':
      // xAI's API is OpenAI-compatible (chat completions).
      return createOpenAI({ apiKey: a.xaiKey, baseURL: 'https://api.x.ai/v1' }).chat(entry.model);
    default:
      throw new Error(`${entry.engine} has no direct provider`);
  }
}

// Tool definitions do not hold keys; any provider instance builds them.
const toolOpenAI = createOpenAI({ apiKey: 'unused' });
const toolAnthropic = createAnthropic({ apiKey: 'unused' });
const toolGoogle = createGoogle({ apiKey: 'unused' });

function searchTools(engine: EngineId): ToolSet | undefined {
  switch (engine) {
    case 'chatgpt':
      return { web_search: toolOpenAI.tools.webSearch({ searchContextSize: 'low' }) } as ToolSet;
    case 'claude':
      return { web_search: toolAnthropic.tools.webSearch_20250305({ maxUses: 2 }) } as ToolSet;
    case 'gemini':
      return { google_search: toolGoogle.tools.googleSearch({}) } as ToolSet;
    default:
      return undefined; // Perplexity searches by itself; others do not search.
  }
}

export interface AnswerResult {
  text: string;
  citations: { url: string; title?: string }[];
  queries: string[];
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
}

type GenResult = Awaited<ReturnType<typeof generateText>>;

/** Pulls the search queries out of whichever shape this provider reports them in. */
function collectQueries(result: GenResult): string[] {
  const queries = new Set<string>();
  for (const step of result.steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      const input = call.input as { query?: unknown } | undefined;
      if (typeof input?.query === 'string') queries.add(input.query);
    }
    for (const toolResult of step.toolResults ?? []) {
      const action = (toolResult.output as { action?: { query?: unknown; queries?: unknown } })
        ?.action;
      if (typeof action?.query === 'string') queries.add(action.query);
      if (Array.isArray(action?.queries))
        for (const q of action.queries) if (typeof q === 'string') queries.add(q);
    }
  }
  const grounding = (
    result.providerMetadata?.google as { groundingMetadata?: { webSearchQueries?: unknown } }
  )?.groundingMetadata;
  if (Array.isArray(grounding?.webSearchQueries))
    for (const q of grounding.webSearchQueries) if (typeof q === 'string') queries.add(q);
  return [...queries].slice(0, 12);
}

export const ANSWER_TIMEOUT_MS = 90_000;
export const JUDGE_TIMEOUT_MS = 60_000;

/** Ask one engine one question, the way a user would: the prompt alone, no system prompt. */
export async function askEngine(
  entry: EngineEntry,
  prompt: string,
  search: boolean,
  config: AvcConfig,
  signal?: AbortSignal,
): Promise<AnswerResult> {
  const tools = search ? searchTools(entry.engine) : undefined;
  const result = await generateText({
    model: languageModel(entry, config),
    prompt,
    ...(tools ? { tools } : {}),
    maxOutputTokens: entry.engine === 'chatgpt' ? 2_600 : 1_400,
    maxRetries: 1,
    abortSignal: withTimeout(ANSWER_TIMEOUT_MS, signal),
    providerOptions: {
      openai: { reasoningEffort: 'low', store: false },
      google: { thinkingConfig: { thinkingBudget: 0 } },
    },
  });

  const citations = new Map<string, string | undefined>();
  for (const source of result.sources ?? []) {
    if (source.sourceType === 'url' && source.url) citations.set(source.url, source.title);
  }
  const queries = collectQueries(result);
  const searched =
    !search || !(entry.engine in { chatgpt: 1, claude: 1, gemini: 1, perplexity: 1 })
      ? 0
      : entry.engine === 'perplexity' || entry.engine === 'gemini'
        ? 1
        : Math.max(
            queries.length ? 1 : 0,
            (result.steps ?? []).reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0),
          );
  const usage = {
    inputTokens: result.totalUsage?.inputTokens ?? result.usage?.inputTokens,
    outputTokens: result.totalUsage?.outputTokens ?? result.usage?.outputTokens,
  };
  return {
    text: result.text.trim(),
    citations: [...citations].slice(0, 20).map(([url, title]) => ({ url, title })),
    queries,
    costUsd: estimateCost(entry.model, usage, searched, entry.engine),
    ...usage,
  };
}

// ---------------------------------------------------------------------------
// Judge / writer model (structured output)
// ---------------------------------------------------------------------------

/** The model used to grade answers and write prompts, or null when only rules can run. */
export function helperModel(
  config: AvcConfig,
  role: 'judge' | 'writer' = 'judge',
): EngineEntry | null {
  if (isMock(config)) return null;
  const a = config.ai;
  const override = a.models?.[role] ?? (role === 'writer' ? a.models?.judge : undefined);
  if (a.gatewayKey)
    return {
      engine: 'chatgpt',
      via: 'gateway',
      model: override?.includes('/') ? override : 'openai/gpt-4.1-mini',
    };
  if (a.openaiKey)
    return {
      engine: 'chatgpt',
      via: 'direct',
      model: override ? bareModel(override) : 'gpt-4.1-mini',
    };
  if (a.anthropicKey)
    return {
      engine: 'claude',
      via: 'direct',
      model: override ? bareModel(override) : 'claude-haiku-4-5',
    };
  if (a.googleKey)
    return {
      engine: 'gemini',
      via: 'direct',
      model: override ? bareModel(override) : 'gemini-2.5-flash',
    };
  if (a.xaiKey)
    return {
      engine: 'grok',
      via: 'direct',
      model: override ? bareModel(override) : 'grok-4.1-fast',
    };
  return null;
}

/** Schema-validated output at temperature 0, one retry. Throws on failure. */
export async function structured<T>(
  config: AvcConfig,
  schema: z.ZodType<T>,
  system: string,
  prompt: string,
  opts: { maxOutputTokens?: number; role?: 'judge' | 'writer'; signal?: AbortSignal } = {},
): Promise<{ value: T; costUsd: number }> {
  const entry = helperModel(config, opts.role);
  if (!entry) throw new Error('No model available for structured output');
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (opts.signal?.aborted) break;
    try {
      const result = await generateText({
        model: languageModel(entry, config, 'helper'),
        system,
        prompt,
        temperature: 0,
        maxOutputTokens: opts.maxOutputTokens ?? 900,
        maxRetries: 1,
        abortSignal: withTimeout(JUDGE_TIMEOUT_MS, opts.signal),
        output: Output.object({ schema }),
      });
      return {
        value: result.output as T,
        costUsd: estimateCost(entry.model, {
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
        }),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Aborted');
}

/** The provider budget or credits are spent: no further call will succeed. */
export function isBudgetError(error: unknown): boolean {
  const text = describeError(error);
  return (
    /\b402\b/.test(text) ||
    /budget|insufficient|credit|quota|payment required|spend limit/i.test(text)
  );
}

/** Auth or permission refused: stop calling this engine, keep the others. */
export function isRefusedError(error: unknown): boolean {
  return /\b(401|403)\b|Authentication|Forbidden|invalid api key|incorrect api key/i.test(
    describeError(error),
  );
}
