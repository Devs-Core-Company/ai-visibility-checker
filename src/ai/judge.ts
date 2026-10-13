import { z } from 'zod';

import type { AvcConfig } from '../core/config.js';
import type { BrandProfile, EngineAnswer } from '../core/types.js';
import { structured } from './engines.js';
import { FACT_SYSTEM, factPrompt, JUDGE_SYSTEM, judgePrompt } from './prompts.js';
import type { SiteFacts } from './brand.js';
import { escapeRegExp, keywords, mentionsAny, normBrand, sameBrand, truncate, uniq } from './util.js';

/**
 * Grading one answer: is the brand named, where in the list, who else is
 * named, in what tone, and what facts it states. A model does this when one
 * is available; the rules below do it otherwise (mock mode, or when the
 * judge call fails) and are good enough for list-style answers.
 */

export interface Judgement {
  mentioned: boolean;
  position: number | null;
  brandsNamed: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  facts: string[];
}

/** Directories and platforms: cited or named, but never "a competitor". */
export const PLATFORMS = new Set(
  [
    'google',
    'google maps',
    'clutch',
    'yelp',
    'linkedin',
    'g2',
    'upwork',
    'reddit',
    'quora',
    'trustpilot',
    'capterra',
    'fiverr',
    'facebook',
    'instagram',
    'youtube',
    'wikipedia',
    'goodfirms',
    'glassdoor',
    'crunchbase',
    'tripadvisor',
    'amazon',
    'x',
    'twitter',
    'tiktok',
    'designrush',
    'sortlist',
    'the manifest',
    'bing',
    'chatgpt',
    'openai',
    'perplexity',
    'gemini',
    'claude',
  ].map(normBrand),
);

export function isPlatform(name: string): boolean {
  return PLATFORMS.has(normBrand(name));
}

function brandNames(brand: BrandProfile): string[] {
  return uniq([brand.name, ...brand.aliases, brand.domain].filter((n) => n && n.length >= 2));
}

const NO_KNOWLEDGE =
  /\b(?:(?:do not|don't|doesn't|does not|couldn't|could not|can't|cannot|unable to)\s+(?:have|find|locate|access|verify)|no (?:specific |reliable |verified )?(?:information|details|data|record))\b/i;

const POSITIVE =
  /\b(well[- ]reviewed|highly rated|reliable|recommended|excellent|strong|trusted|reputable|known for|experienced|specialis|speciali[sz]es|award|leading|praised|responsive|good choice|solid)\b/i;
const NEGATIVE =
  /\b(complain|complaints|poor|slow to|overpriced|expensive|mixed reviews|negative reviews|lawsuit|scam|avoid|issues with|problems with|unreliable|lacks|limited track record|not recommended)\b/i;

/** Candidate brand names from list items, headings and bold text, in order of appearance. */
export function extractNamed(text: string): { name: string; index: number }[] {
  const found: { name: string; index: number }[] = [];
  const push = (raw: string, index: number) => {
    const name = raw
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')
      .replace(/[*_`#]/g, '')
      .split(/\s+[—–-]\s+|:\s|\s\(|,\s/)[0]!
      .replace(/[.:;,]+$/, '')
      .trim();
    if (!name || name.length < 2 || name.length > 60) return;
    if (name.split(/\s+/).length > 6) return;
    if (!/^[\p{Lu}\p{N}]/u.test(name)) return;
    if (/^(the|a|an|for|if|when|why|how|what|which|note|tip|summary|conclusion|option|step)\b/i.test(name) && name.split(/\s+/).length > 2)
      return;
    if (isPlatform(name)) return;
    found.push({ name, index });
  };
  const listRe = /^[ \t]*(?:\d+[.)]|[-*•])\s+(.+)$/gm;
  for (let m = listRe.exec(text); m; m = listRe.exec(text)) push(m[1]!, m.index);
  const headRe = /^#{2,4}\s+(?:\d+[.)]\s*)?(.+)$/gm;
  for (let m = headRe.exec(text); m; m = headRe.exec(text)) push(m[1]!, m.index);
  const boldRe = /\*\*([^*\n]{2,60})\*\*/g;
  for (let m = boldRe.exec(text); m; m = boldRe.exec(text)) push(m[1]!, m.index);
  found.sort((a, b) => a.index - b.index);
  const out: { name: string; index: number }[] = [];
  for (const f of found) if (!out.some((o) => sameBrand(o.name, f.name))) out.push(f);
  return out;
}

function firstIndex(text: string, names: string[]): number {
  let best = -1;
  for (const n of names) {
    const m = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(n)}`, 'iu').exec(text);
    if (m && (best < 0 || m.index < best)) best = m.index;
  }
  return best;
}

/** Sentences that name the brand. */
function brandSentences(text: string, names: string[]): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => mentionsAny(s, names));
}

/** Rule-based judge. Works on real answers too; used when no judge model is available. */
export function heuristicJudge(
  text: string,
  brand: BrandProfile,
  competitors: string[] = brand.competitors.map((c) => c.name),
): Judgement {
  const names = brandNames(brand);
  const sentences = brandSentences(text, names);
  let mentioned = sentences.length > 0;
  if (mentioned && sentences.every((s) => NO_KNOWLEDGE.test(s))) mentioned = false;

  const named = extractNamed(text).filter((n) => !names.some((b) => sameBrand(b, n.name)));
  for (const c of competitors) {
    if (named.some((n) => sameBrand(n.name, c))) continue;
    const i = firstIndex(text, [c]);
    if (i >= 0) named.push({ name: c, index: i });
  }
  if (mentioned) named.push({ name: brand.name, index: Math.max(0, firstIndex(text, names)) });
  named.sort((a, b) => a.index - b.index);
  const brandsNamed = named.map((n) => n.name).slice(0, 15);
  const pos = brandsNamed.findIndex((n) => n === brand.name);

  let sentiment: Judgement['sentiment'] = null;
  if (mentioned) {
    const own = sentences.join(' ');
    const pos = POSITIVE.test(own);
    const neg = NEGATIVE.test(own);
    sentiment = neg && !pos ? 'negative' : pos && !neg ? 'positive' : 'neutral';
  }

  const facts: string[] = [];
  if (mentioned) {
    for (const s of sentences) {
      const founded = s.match(/\b(?:founded|established|started|launched)\s+(?:in\s+)?((?:19|20)\d{2})\b/i);
      if (founded) facts.push(`Founded in ${founded[1]}`);
      const based = s.match(/\b(?:based|headquartered|located)\s+in\s+([\p{Lu}][\p{L}'.-]+(?:(?:,\s*|\s+)[\p{Lu}][\p{L}'.-]+){0,3})/u);
      if (based) facts.push(`Based in ${based[1]!.replace(/[.,]+$/, '')}`);
    }
  }

  return {
    mentioned,
    position: mentioned && pos >= 0 ? pos + 1 : null,
    brandsNamed,
    sentiment,
    facts: uniq(facts).slice(0, 8),
  };
}

const judgeSchema = z.object({
  mentioned: z.boolean(),
  position: z.number().int().nullable(),
  brands_named: z.array(z.string()),
  sentiment: z.enum(['positive', 'neutral', 'negative']).nullable(),
  facts: z.array(z.string()),
});

/** Model judge, falling back to the rules on failure. */
export async function judgeAnswer(
  input: { text: string; question: string; citations: string[]; brand: BrandProfile },
  config: AvcConfig,
  useModel: boolean,
  signal?: AbortSignal,
): Promise<{ judgement: Judgement; costUsd: number; byModel: boolean }> {
  if (!useModel || !input.text.trim())
    return { judgement: heuristicJudge(input.text, input.brand), costUsd: 0, byModel: false };
  try {
    const { value, costUsd } = await structured(
      config,
      judgeSchema,
      JUDGE_SYSTEM,
      judgePrompt({ brand: input.brand, question: input.question, answer: input.text, citations: input.citations }),
      { maxOutputTokens: 900, signal },
    );
    const brandsNamed = value.brands_named
      .map((b) => truncate(b.trim(), 80))
      .filter((b) => b && !isPlatform(b))
      .slice(0, 15);
    let mentioned = Boolean(value.mentioned);
    if (!mentioned && brandsNamed.some((b) => brandNames(input.brand).some((n) => sameBrand(b, n))))
      mentioned = true;
    const listPos = brandsNamed.findIndex((b) => brandNames(input.brand).some((n) => sameBrand(b, n)));
    const position =
      mentioned && typeof value.position === 'number' && value.position > 0
        ? value.position
        : mentioned && listPos >= 0
          ? listPos + 1
          : null;
    return {
      judgement: {
        mentioned,
        position,
        brandsNamed,
        sentiment: mentioned ? value.sentiment : null,
        facts: mentioned ? value.facts.map((f) => truncate(f, 200)).slice(0, 8) : [],
      },
      costUsd,
      byModel: true,
    };
  } catch {
    return { judgement: heuristicJudge(input.text, input.brand), costUsd: 0, byModel: false };
  }
}

// ---------------------------------------------------------------------------
// Fact check
// ---------------------------------------------------------------------------

export type FactIssue = EngineAnswer['factIssues'][number];
type Verdict = 'matches' | FactIssue['verdict'];

function overlap(a: string, b: string): boolean {
  const x = keywords(a);
  const y = new Set(keywords(b));
  return x.some((w) => y.has(w));
}

/** Rule-based check of one claim against the site's own facts. */
export function checkFactByRules(claim: string, facts: SiteFacts): { verdict: Verdict; siteSays?: string } {
  const year = claim.match(/\b(?:founded|established|started|launched)\b.*?\b((?:19|20)\d{2})\b/i);
  if (year) {
    if (!facts.foundedYear) return { verdict: 'unverifiable' };
    return Number(year[1]) === facts.foundedYear
      ? { verdict: 'matches', siteSays: `Founded in ${facts.foundedYear}` }
      : { verdict: 'wrong', siteSays: `Founded in ${facts.foundedYear}` };
  }
  const based = claim.match(/\b(?:based|headquartered|located)\s+in\s+(.+)$/i);
  if (based) {
    const place = based[1]!;
    if (facts.locations.some((l) => overlap(l, place))) return { verdict: 'matches', siteSays: facts.locations[0] };
    if (facts.text && mentionsAny(facts.text, [place])) return { verdict: 'matches' };
    if (facts.locations.length) return { verdict: 'wrong', siteSays: facts.locations.join('; ') };
    return { verdict: 'unverifiable' };
  }
  const words = keywords(claim);
  if (!words.length || !facts.text) return { verdict: 'unverifiable' };
  const site = facts.text.toLowerCase();
  const hit = words.filter((w) => site.includes(w)).length;
  return hit / words.length >= 0.75 ? { verdict: 'matches' } : { verdict: 'unverifiable' };
}

const factSchema = z.object({
  checks: z.array(
    z.object({
      claim: z.string(),
      verdict: z.enum(['matches', 'wrong', 'outdated', 'unverifiable']),
      site_says: z.string().nullable(),
    }),
  ),
});

/**
 * Checks every distinct claim made about the brand against the site, once,
 * and returns a verdict per claim (keyed by the normalised claim).
 */
export async function checkFacts(
  claims: string[],
  brand: BrandProfile,
  facts: SiteFacts,
  config: AvcConfig,
  useModel: boolean,
  signal?: AbortSignal,
): Promise<{ verdicts: Map<string, { verdict: Verdict; siteSays?: string }>; costUsd: number }> {
  const unique = uniq(claims.map((c) => c.trim()).filter(Boolean), factKey).slice(0, 25);
  const verdicts = new Map<string, { verdict: Verdict; siteSays?: string }>();
  for (const c of unique) verdicts.set(factKey(c), checkFactByRules(c, facts));
  if (!useModel || !unique.length || !facts.text.trim()) return { verdicts, costUsd: 0 };
  try {
    const { value, costUsd } = await structured(
      config,
      factSchema,
      FACT_SYSTEM,
      factPrompt(brand.name, unique, facts.text),
      { maxOutputTokens: 1_600, signal },
    );
    unique.forEach((c, i) => {
      const check = value.checks[i];
      if (!check) return;
      // A hard rule match on years wins over the model; otherwise trust the model.
      const rule = verdicts.get(factKey(c));
      if (rule && rule.verdict === 'wrong' && /\d{4}/.test(c)) return;
      verdicts.set(factKey(c), {
        verdict: check.verdict,
        ...(check.site_says ? { siteSays: truncate(check.site_says, 220) } : {}),
      });
    });
    return { verdicts, costUsd };
  } catch {
    return { verdicts, costUsd: 0 };
  }
}

export function factKey(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
