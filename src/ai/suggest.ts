import { z } from 'zod';

import type { AvcConfig } from '../core/config.js';
import type { BrandProfile, SiteContext, TrackedPrompt } from '../core/types.js';
import { homePage, siteSummaryText } from './brand.js';
import { helperModel, structured } from './engines.js';
import {
  brandTemplates,
  categoryTemplates,
  comparisonTemplates,
  problemTemplates,
  SUGGEST_SYSTEM,
  suggestPrompt,
  type PromptTemplateInput,
} from './prompts.js';
import { hostOf, mentionsAny, promptId, uniq } from './util.js';

export interface SuggestOptions {
  config?: AvcConfig;
  /** How many prompts to return, custom ones included. Default 12. */
  count?: number;
  /** The owner's own prompts (SiteConfig.prompts): kept first, unchanged. */
  custom?: TrackedPrompt[];
  /** Also add a brand prompt with search off, to test what the model knows from training. Default true. */
  trainingProbe?: boolean;
  signal?: AbortSignal;
}

/** Words that would give the brand away in a prompt meant to test unprompted recall. */
export function brandWords(brand: BrandProfile): string[] {
  const label = brand.domain.split('.')[0] ?? '';
  return uniq(
    [brand.name, ...brand.aliases, brand.domain, label].map((w) => w.trim()).filter((w) => w.length >= 3),
    (w) => w.toLowerCase(),
  );
}

export function namesBrand(text: string, brand: BrandProfile): boolean {
  return mentionsAny(text, brandWords(brand));
}

function mainService(brand: BrandProfile, site?: SiteContext): string {
  if (brand.services[0]) return brand.services[0].toLowerCase();
  if (brand.industry) return `${brand.industry} services`;
  const h1 = site ? homePage(site)?.headings.find((h) => h.level === 1)?.text : undefined;
  if (h1 && h1.split(/\s+/).length <= 6 && !namesBrand(h1, brand)) return h1.toLowerCase();
  return 'professional services';
}

export function makePrompt(
  kind: TrackedPrompt['kind'],
  text: string,
  search = true,
): TrackedPrompt {
  const clean = text.replace(/\s+/g, ' ').trim();
  return { id: promptId(`${kind}:${search ? 's' : 'n'}`, clean), text: clean, kind, search };
}

/** Template prompts: always available, no model needed. */
export function templatePrompts(
  brand: BrandProfile,
  site?: SiteContext,
  opts: { trainingProbe?: boolean } = {},
): TrackedPrompt[] {
  const service = mainService(brand, site);
  const second = brand.services[1]?.toLowerCase();
  const base: PromptTemplateInput = {
    brand: brand.name,
    service,
    location: brand.location,
    industry: brand.industry,
  };
  const out: TrackedPrompt[] = [];
  for (const t of brandTemplates(base)) out.push(makePrompt('brand', t));
  if (opts.trainingProbe !== false)
    out.push(makePrompt('brand', `What do you know about ${brand.name} (${brand.domain})?`, false));
  for (const t of categoryTemplates(base)) out.push(makePrompt('category', t));
  if (brand.location) out.push(makePrompt('category', `Best ${second ?? service} in ${brand.location}`));
  if (brand.industry) out.push(makePrompt('category', `${capital(service)} for ${brand.industry}`));
  const competitors = brand.competitors.slice(0, 2);
  if (competitors.length)
    for (const c of competitors)
      for (const t of comparisonTemplates({ ...base, competitor: c.name })) out.push(makePrompt('comparison', t));
  else for (const t of comparisonTemplates(base)) out.push(makePrompt('comparison', t));
  for (const t of problemTemplates(base)) out.push(makePrompt('problem', t));
  // Category and problem prompts must never name the brand.
  return uniq(
    out.filter((p) => (p.kind === 'category' || p.kind === 'problem' ? !namesBrand(p.text, brand) : true)),
    (p) => p.text.toLowerCase(),
  );
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const suggestSchema = z.object({
  prompts: z.array(
    z.object({
      text: z.string(),
      kind: z.enum(['brand', 'category', 'comparison', 'problem']),
    }),
  ),
});

/**
 * Prompts worth tracking: the owner's own first, then model-written ones
 * when a model is available (from the site's own text), topped up from the
 * templates. Category and problem prompts never name the brand.
 */
export async function suggestPrompts(
  brand: BrandProfile,
  site: SiteContext | undefined,
  opts: SuggestOptions = {},
): Promise<TrackedPrompt[]> {
  const count = opts.count ?? 12;
  const custom = (opts.custom ?? []).map((p) => ({
    ...p,
    id: p.id || promptId(`${p.kind}:${p.search ? 's' : 'n'}`, p.text),
  }));
  const templates = templatePrompts(brand, site, { trainingProbe: opts.trainingProbe });

  let written: TrackedPrompt[] = [];
  if (opts.config && site && helperModel(opts.config, 'writer')) {
    try {
      const { value } = await structured(
        opts.config,
        suggestSchema,
        SUGGEST_SYSTEM,
        suggestPrompt({ brand, siteText: siteSummaryText(site), count: Math.max(6, count) }),
        { maxOutputTokens: 1_200, role: 'writer', signal: opts.signal },
      );
      written = value.prompts
        .map((p) => ({ ...p, text: p.text.replace(/\s+/g, ' ').trim() }))
        .filter((p) => p.text.length >= 12 && p.text.length <= 200)
        .filter((p) => (p.kind === 'category' || p.kind === 'problem' ? !namesBrand(p.text, brand) : true))
        .filter((p) => !p.text.toLowerCase().includes(hostOf(brand.domain)))
        .map((p) => makePrompt(p.kind, p.text));
    } catch {
      written = [];
    }
  }

  // Always keep the two brand prompts and the training probe from the templates.
  const anchors = templates.filter((p) => p.kind === 'brand');
  const rest = written.length ? written.filter((p) => p.kind !== 'brand') : templates.filter((p) => p.kind !== 'brand');
  const topUp = templates.filter((p) => p.kind !== 'brand');
  const merged = uniq([...custom, ...anchors, ...rest, ...topUp], (p) => p.text.toLowerCase());
  return merged.slice(0, Math.max(count, custom.length));
}
