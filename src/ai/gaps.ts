import { z } from 'zod';

import type { AvcConfig } from '../core/config.js';
import type {
  EngineAnswer,
  EngineId,
  PageData,
  SiteContext,
  VisibilityRun,
} from '../core/types.js';
import { htmlPages } from './brand.js';
import { engineLabel, helperModel, structured } from './engines.js';
import { isPlatform } from './judge.js';
import { GAPS_SYSTEM } from './prompts.js';
import { validAnswers } from './run.js';
import { hostOf, keywords, mentionsAny, sameBrand, truncate, uniq } from './util.js';

/**
 * The "why not you": for every prompt an engine answered without naming the
 * brand, compare what it cited and who it named with the site's own pages,
 * and say what to build or fix. Rule-based from the run and the crawl;
 * `explainGapsWithModel` adds a model's reading when keys exist.
 */

export interface Gap {
  promptId: string;
  engine: EngineId;
  whyNotYou: string[];
  pagesToCreateOrImprove: { url?: string; suggestion: string }[];
}

type SourceType = 'reviews' | 'directories' | 'forums' | 'news' | 'social' | 'video' | 'other';

const SOURCE_TYPES: [RegExp, SourceType][] = [
  [
    /(^|\.)(trustpilot|g2|capterra|yelp|clutch|goodfirms|glassdoor|sitejabber|tripadvisor|reviews\.io|bbb|softwareadvice|getapp)\./,
    'reviews',
  ],
  [
    /(^|\.)(reddit|quora|stackexchange|stackoverflow|news\.ycombinator)\.|^(community|forum|forums)\./,
    'forums',
  ],
  [/(^|\.)youtube\.com$|(^|\.)vimeo\.com$/, 'video'],
  [/(^|\.)(linkedin|facebook|x|twitter|instagram|tiktok|medium|substack)\.com$/, 'social'],
  [
    /(^|\.)(crunchbase|wikipedia|wikidata|yellowpages|manta|zoominfo|upwork|designrush|themanifest|sortlist|builtin|wellfound|producthunt|google)\./,
    'directories',
  ],
  [
    /(^|\.)(techcrunch|forbes|reuters|bbc|cnn|nytimes|theverge|wired|businessinsider|bloomberg|ft|wsj|cnbc|venturebeat|zdnet|inc|techradar|theguardian)\./,
    'news',
  ],
];

export function sourceType(domain: string): SourceType {
  const d = hostOf(domain);
  return SOURCE_TYPES.find(([re]) => re.test(d))?.[1] ?? 'other';
}

/** What a cited URL looks like, from its path. */
function pageShape(
  url: string,
):
  | 'list'
  | 'comparison'
  | 'guide'
  | 'pricing'
  | 'location'
  | 'case-study'
  | 'service'
  | 'home'
  | 'other' {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return 'other';
  }
  if (path === '/' || path === '') return 'home';
  if (/(^|[/-])(vs|versus|compare|comparison|alternatives?)([/-]|$)/.test(path))
    return 'comparison';
  if (/(^|[/-])(best|top)[-\d]/.test(path)) return 'list';
  if (/pricing|prices|cost/.test(path)) return 'pricing';
  if (/case-stud|portfolio|our-work|clients/.test(path)) return 'case-study';
  if (/locations?\/|areas?-we-serve|near-me/.test(path)) return 'location';
  if (
    /(^|\/)(blog|guides?|learn|resources|insights|articles?)\//.test(path) ||
    /how-to|guide/.test(path)
  )
    return 'guide';
  if (/services?|solutions?/.test(path)) return 'service';
  return 'other';
}

const SHAPE_LABEL: Record<string, string> = {
  list: 'a "best of" list article',
  comparison: 'a comparison page',
  guide: 'a guide or blog post',
  pricing: 'a pricing page',
  location: 'a location page',
  'case-study': 'a case study page',
  service: 'a service page',
  home: 'its home page',
};

function pageText(p: PageData): string {
  return `${p.title ?? ''} ${p.headings.map((h) => h.text).join(' ')} ${p.url}`;
}

/** The site's page most about this prompt, with a 0–1 keyword overlap score. */
export function bestMatchingPage(
  site: SiteContext,
  prompt: string,
): { page: PageData; score: number } | null {
  const words = keywords(prompt);
  if (!words.length) return null;
  let best: { page: PageData; score: number } | null = null;
  for (const p of htmlPages(site)) {
    const hay = new Set(keywords(pageText(p)));
    const score = words.filter((w) => hay.has(w)).length / words.length;
    if (!best || score > best.score || (score === best.score && p.depth < best.page.depth))
      best = { page: p, score };
  }
  return best;
}

function hasSchema(p: PageData, type: string): boolean {
  return p.structuredData.some((s) => s.types.includes(type));
}

function list(items: string[], max = 3): string {
  const xs = items.slice(0, max);
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** Rule-based explanation of every lost prompt × engine. */
export function explainGaps(run: VisibilityRun, site?: SiteContext): Gap[] {
  const brand = run.brand;
  const valid = validAnswers(run.answers);
  const kindOf = new Map(run.prompts.map((p) => [p.id, p]));
  const ownCitedBy = new Set(
    valid.filter((a) => a.citations.some((c) => c.ownSite)).map((a) => a.engine),
  );
  const pages = site ? htmlPages(site) : [];
  const siteText = pages.map((p) => `${p.title ?? ''} ${p.mainText ?? p.text}`).join(' ');
  const hasComparisonPage = pages.some((p) => pageShape(p.url) === 'comparison');
  const hasPricing = pages.some((p) => pageShape(p.url) === 'pricing');
  const hasCaseStudies = pages.some((p) => pageShape(p.url) === 'case-study');

  const groups = new Map<string, EngineAnswer[]>();
  for (const a of valid) {
    const k = `${a.promptId}|${a.engine}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }

  const gaps: Gap[] = [];
  for (const [k, xs] of groups) {
    const mentioned = xs.filter((a) => a.mentioned).length;
    if (mentioned / xs.length >= 0.5) continue;
    const [promptId, engine] = k.split('|') as [string, EngineId];
    const prompt = kindOf.get(promptId);
    const text = prompt?.text ?? xs[0]!.prompt;
    const kind = prompt?.kind ?? 'custom';
    const search = prompt?.search ?? true;
    const label = engineLabel(engine);
    const why: string[] = [];
    const todo: Gap['pagesToCreateOrImprove'] = [];

    const named = uniq(
      xs.flatMap((a) => a.brandsNamed).filter((n) => !isPlatform(n) && !sameBrand(n, brand.name)),
      (n) => n.toLowerCase(),
    );
    const cites = xs.flatMap((a) => a.citations).filter((c) => !c.ownSite);
    const repeatsNote = xs.length > 1 ? ` (in ${xs.length - mentioned} of ${xs.length} tries)` : '';

    if (kind === 'brand') {
      why.push(
        search
          ? `${label} could not say clearly what ${brand.name} is${repeatsNote}, even with web search.`
          : `Without web search, ${label} does not know ${brand.name} from its training data${repeatsNote}. That changes only as independent sites write about you.`,
      );
      if (!run.entity?.wikidataId)
        todo.push({
          suggestion: `Create a well-sourced Wikidata item for ${brand.name} with your website (P856), and link it from sameAs in your Organization schema.`,
        });
      if (!run.entity?.sameAs.length)
        todo.push({
          suggestion:
            'Add Organization schema to the home page with name, url, logo, address and sameAs links to your LinkedIn and review-site profiles.',
        });
      const about = pages.find((p) => /\/(about|company|who-we-are)/.test(p.url));
      todo.push(
        about
          ? {
              url: about.url,
              suggestion: `Open the About page with one plain paragraph: what ${brand.name} does, for whom, where, and since when.`,
            }
          : {
              suggestion: `Create an About page that states what ${brand.name} does, for whom, where it is based and when it was founded.`,
            },
      );
      if (!search)
        todo.push({
          suggestion:
            'Earn mentions on sites engines learn from: industry directories, press, podcasts, and answers on forums where your buyers ask questions.',
        });
      gaps.push({ promptId, engine, whyNotYou: why, pagesToCreateOrImprove: todo });
      continue;
    }

    if (named.length)
      why.push(
        `${label} named ${list(named)}${named.length > 3 ? ` and ${named.length - 3} more` : ''} instead${repeatsNote}.`,
      );
    else why.push(`${label} answered without naming ${brand.name}${repeatsNote}.`);

    if (!search)
      why.push(
        `This prompt runs without web search, so the answer comes from training data; only third-party coverage over time changes it.`,
      );

    // What the engine leaned on.
    const types = new Map<SourceType, string[]>();
    for (const c of cites) {
      const t = sourceType(c.domain);
      types.set(t, uniq([...(types.get(t) ?? []), c.domain]));
    }
    const reviews = [...(types.get('reviews') ?? []), ...(types.get('directories') ?? [])];
    if (reviews.length) {
      why.push(`The answer drew on ${list(reviews)}, where your profile was not cited.`);
      todo.push({
        suggestion: `Claim or complete your profile on ${list(reviews)} and ask recent clients for reviews there.`,
      });
    }
    const forums = types.get('forums') ?? [];
    if (forums.length) {
      why.push(`Discussion threads on ${list(forums)} were cited.`);
      todo.push({
        suggestion: `Answer relevant questions on ${list(forums)} as yourself, with specifics rather than links alone.`,
      });
    }
    const news = types.get('news') ?? [];
    if (news.length)
      todo.push({
        suggestion: `Pitch the publications cited (${list(news)}) with original data or a client result they can quote.`,
      });

    const compCites = cites.filter(
      (c) => c.competitor || (sourceType(c.domain) === 'other' && !isPlatform(c.domain)),
    );
    const shapes = uniq(
      compCites.map((c) => ({
        shape: pageShape(c.url),
        url: c.url,
        who: c.competitor ?? c.domain,
      })),
      (x) => x.shape,
    ).filter((x) => x.shape !== 'other');
    for (const s of shapes.slice(0, 2))
      why.push(`${s.who} was cited for ${SHAPE_LABEL[s.shape]} (${truncate(s.url, 90)}).`);

    if (!ownCitedBy.has(engine) && search)
      why.push(`${label} did not cite any of your pages anywhere in this run.`);

    // What the site has for this question.
    if (site) {
      const match = bestMatchingPage(site, text);
      if (!match || match.score < 0.34) {
        why.push(
          `Your site has no page clearly about "${truncate(keywords(text).join(' '), 60)}".`,
        );
        todo.push({
          suggestion: `Create a page that answers "${text}" in its first paragraph, then backs it with specifics: services, prices or ranges, timelines, location and client examples.`,
        });
      } else {
        const p = match.page;
        const fixes: string[] = [];
        if (p.wordCount < 400)
          fixes.push(`expand it (${p.wordCount} words now) with specifics a buyer needs`);
        if (!keywords(p.lead).some((w) => keywords(text).includes(w)))
          fixes.push('open with a direct one-paragraph answer to the question');
        if (!hasSchema(p, 'FAQPage') && kind !== 'comparison')
          fixes.push('add an FAQ section with FAQPage markup for the questions buyers ask');
        if (
          brand.location &&
          text.toLowerCase().includes(brand.location.toLowerCase().split(',')[0]!) &&
          !mentionsAny(p.mainText ?? p.text, [brand.location.split(',')[0]!])
        )
          fixes.push(`say plainly that you serve ${brand.location}`);
        if (!fixes.length)
          fixes.push('add evidence engines can quote: named clients, results, reviews and dates');
        todo.push({
          url: p.finalUrl || p.url,
          suggestion: `Improve this page: ${list(fixes, 4)}.`,
        });
      }
      if (
        brand.location &&
        text.toLowerCase().includes(brand.location.toLowerCase().split(',')[0]!) &&
        !mentionsAny(siteText, [brand.location.split(',')[0]!])
      )
        why.push(`The question is about ${brand.location}, and your site does not mention it.`);
      if (kind === 'comparison' && !hasComparisonPage)
        todo.push({
          suggestion: `Create an honest comparison page (for example /compare/${brand.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-vs-${(named[0] ?? 'alternatives').toLowerCase().replace(/[^a-z0-9]+/g, '-')}) covering who each option suits, prices and differences.`,
        });
      if (shapes.some((s) => s.shape === 'list') && !hasCaseStudies)
        todo.push({
          suggestion:
            'Publish case studies with the client type, the problem, what you built and the result, so list articles and engines have something specific to cite.',
        });
      if (shapes.some((s) => s.shape === 'pricing') && !hasPricing)
        todo.push({
          suggestion:
            'Publish a pricing page, or at least price ranges, so engines can answer cost questions with your numbers.',
        });
    } else {
      todo.push({
        suggestion: `Make sure one page answers "${text}" directly in its first paragraph.`,
      });
    }

    gaps.push({
      promptId,
      engine,
      whyNotYou: uniq(why).slice(0, 6),
      pagesToCreateOrImprove: uniq(todo, (t) => `${t.url ?? ''}|${t.suggestion}`).slice(0, 5),
    });
  }
  return gaps;
}

const gapSchema = z.object({
  why_not_you: z.array(z.string()),
  pages: z.array(z.object({ url: z.string().nullable(), suggestion: z.string() })),
});

/**
 * The rule-based gaps, with a model's reading added for the first `limit`
 * gaps when a model is available. Falls back to the rules per gap on failure.
 */
export async function explainGapsWithModel(
  run: VisibilityRun,
  site: SiteContext | undefined,
  config: AvcConfig,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<{ gaps: Gap[]; costUsd: number }> {
  const gaps = explainGaps(run, site);
  if (!helperModel(config, 'writer')) return { gaps, costUsd: 0 };
  let costUsd = 0;
  const limit = Math.min(opts.limit ?? 8, gaps.length);
  for (let i = 0; i < limit; i += 1) {
    if (opts.signal?.aborted) break;
    const g = gaps[i]!;
    const xs = validAnswers(run.answers).filter(
      (a) => a.promptId === g.promptId && a.engine === g.engine,
    );
    const match = site ? bestMatchingPage(site, xs[0]?.prompt ?? '') : null;
    const data = {
      question: xs[0]?.prompt,
      engine: engineLabel(g.engine),
      company: {
        name: run.brand.name,
        domain: run.brand.domain,
        services: run.brand.services,
        location: run.brand.location,
      },
      named_instead: uniq(xs.flatMap((a) => a.brandsNamed)).slice(0, 8),
      cited: uniq(xs.flatMap((a) => a.citations.map((c) => c.url))).slice(0, 10),
      answer_excerpt: truncate(xs[0]?.answer ?? '', 1_500),
      company_page: match
        ? {
            url: match.page.url,
            title: match.page.title,
            words: match.page.wordCount,
            headings: match.page.headings.slice(0, 12).map((h) => h.text),
          }
        : null,
      rule_findings: g.whyNotYou,
    };
    try {
      const { value, costUsd: c } = await structured(
        config,
        gapSchema,
        GAPS_SYSTEM,
        JSON.stringify(data, null, 1),
        {
          maxOutputTokens: 900,
          role: 'writer',
          signal: opts.signal,
        },
      );
      costUsd += c;
      g.whyNotYou = uniq([
        ...g.whyNotYou,
        ...value.why_not_you.map((s) => truncate(s.trim(), 300)),
      ]).slice(0, 8);
      g.pagesToCreateOrImprove = uniq(
        [
          ...value.pages.map((p) => ({
            ...(p.url ? { url: p.url } : {}),
            suggestion: truncate(p.suggestion.trim(), 400),
          })),
          ...g.pagesToCreateOrImprove,
        ],
        (t) => t.suggestion,
      ).slice(0, 6);
    } catch {
      // Keep the rule-based explanation.
    }
  }
  return { gaps, costUsd };
}
