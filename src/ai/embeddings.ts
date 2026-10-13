/**
 * Page embeddings: which pages mean nearly the same thing (even with different
 * wording) and which sit far from the rest of the site. Bring your own model:
 * an OpenAI key, or the AI Gateway. In mock mode a deterministic bag-of-words
 * vector stands in, so the feature can be tried without spend.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { createGateway, embedMany } from 'ai';
import type { AvcConfig } from '../core/config.js';
import type { EmbeddingInsights, PageData, SiteContext } from '../core/types.js';
import { isMock } from './engines.js';

const MAX_CHARS = 4_000;
export const DEFAULT_THRESHOLD = 0.92;

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** A deterministic 256-dimension hashed word vector (mock mode and tests). */
export function hashedVector(text: string, dims = 256): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const w of text.toLowerCase().match(/\p{L}{3,}/gu) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    v[(h >>> 0) % dims]! += 1;
  }
  return v;
}

/** Whether embeddings can run, and how. */
export function embeddingsAvailable(config: AvcConfig): 'mock' | 'gateway' | 'openai' | null {
  if (!config.embeddings?.enabled) return null;
  if (isMock(config)) return 'mock';
  if (config.ai.gatewayKey) return 'gateway';
  if (config.ai.openaiKey) return 'openai';
  return null;
}

/** Turn vectors into similar pairs and outliers. */
export function analyseVectors(
  urls: string[],
  vectors: number[][],
  threshold = DEFAULT_THRESHOLD,
): Pick<EmbeddingInsights, 'similarPairs' | 'outliers'> {
  const similarPairs: EmbeddingInsights['similarPairs'] = [];
  for (let i = 0; i < vectors.length; i++)
    for (let j = i + 1; j < vectors.length; j++) {
      const s = cosine(vectors[i]!, vectors[j]!);
      if (s >= threshold)
        similarPairs.push({ a: urls[i]!, b: urls[j]!, similarity: Math.round(s * 1000) / 1000 });
    }
  similarPairs.sort((x, y) => y.similarity - x.similarity);
  const outliers: EmbeddingInsights['outliers'] = [];
  if (vectors.length >= 8) {
    const dims = vectors[0]!.length;
    const centroid = new Array<number>(dims).fill(0);
    for (const v of vectors) for (let d = 0; d < dims; d++) centroid[d]! += v[d]! / vectors.length;
    const sims = vectors.map((v) => cosine(v, centroid));
    const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
    const sd = Math.sqrt(sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length);
    sims.forEach((s, i) => {
      if (s < mean - 2 * sd)
        outliers.push({ url: urls[i]!, similarity: Math.round(s * 1000) / 1000 });
    });
    outliers.sort((x, y) => x.similarity - y.similarity);
  }
  return { similarPairs: similarPairs.slice(0, 500), outliers };
}

function pagesFor(site: SiteContext, max: number): PageData[] {
  return [...site.pages.values()]
    .filter((p) => p.isHtml && p.status === 200 && p.wordCount >= 100 && !p.redirects.length)
    .sort((a, b) => a.depth - b.depth)
    .slice(0, max);
}

export async function computeEmbeddings(
  site: SiteContext,
  config: AvcConfig,
  opts: { signal?: AbortSignal } = {},
): Promise<EmbeddingInsights | null> {
  const how = embeddingsAvailable(config);
  if (!how) return null;
  const pages = pagesFor(site, config.embeddings?.maxPages ?? 300);
  if (pages.length < 2) return null;
  const texts = pages.map((p) => `${p.title ?? ''}\n${(p.mainText || p.text).slice(0, MAX_CHARS)}`);
  let vectors: number[][];
  let model: string;
  if (how === 'mock') {
    model = 'mock-hashed-bow';
    vectors = texts.map((t) => hashedVector(t));
  } else {
    const configured = config.embeddings?.model;
    if (how === 'gateway') {
      model = configured?.includes('/')
        ? configured
        : `openai/${configured ?? 'text-embedding-3-small'}`;
      const res = await embedMany({
        model: createGateway({ apiKey: config.ai.gatewayKey }).embeddingModel(model),
        values: texts,
        abortSignal: opts.signal,
      });
      vectors = res.embeddings;
    } else {
      model = configured?.replace(/^openai\//, '') ?? 'text-embedding-3-small';
      const res = await embedMany({
        model: createOpenAI({
          apiKey: config.ai.openaiKey,
          ...(config.ai.openaiBaseUrl ? { baseURL: config.ai.openaiBaseUrl } : {}),
        }).embedding(model),
        values: texts,
        abortSignal: opts.signal,
      });
      vectors = res.embeddings;
    }
  }
  const analysis = analyseVectors(
    pages.map((p) => p.url),
    vectors,
    config.embeddings?.threshold ?? DEFAULT_THRESHOLD,
  );
  return { model, pages: pages.length, ...analysis };
}
