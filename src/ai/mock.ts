import type { BrandProfile, EngineId, SiteContext, TrackedPrompt } from '../core/types.js';
import { htmlPages } from './brand.js';
import type { AnswerResult } from './engines.js';
import { seeded } from './util.js';

/**
 * Mock mode (config.ai.mock, AVC_LLM_MOCK=1, or no keys at all): fake
 * answers, clearly labelled, deterministic for a given prompt, engine and
 * repeat, so the whole pipeline and dashboard can be demoed and tested
 * without keys or spend. They sometimes name the brand, sometimes only
 * competitors, and cite a mix of the brand's own pages, competitor pages,
 * review sites and forums.
 */

export const MOCK_LABEL = '[Sample answer: mock mode, not from a real AI engine]';

const FAKE_COMPETITORS = [
  'Northwind Digital',
  'Harbour Lane Studio',
  'Summit Works',
  'Brightline Partners',
  'Copperfield & Co',
];

/** How often each engine "recommends" the brand in category prompts. Arbitrary, for demos. */
const BIAS: Record<EngineId, number> = {
  chatgpt: 0.4,
  claude: 0.3,
  gemini: 0.5,
  perplexity: 0.6,
  grok: 0.35,
  deepseek: 0.25,
  copilot: 0.4,
};

const SEARCHING: EngineId[] = ['chatgpt', 'claude', 'gemini', 'perplexity'];

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function mockCompetitors(brand: BrandProfile): { name: string; domain: string }[] {
  const named = brand.competitors.map((c) => ({ name: c.name, domain: c.domain ?? `${slug(c.name)}.example` }));
  const fill = FAKE_COMPETITORS.filter((n) => !named.some((c) => c.name === n)).map((n) => ({
    name: n,
    domain: `${slug(n)}.example`,
  }));
  return [...named, ...fill].slice(0, 5);
}

function ownPages(brand: BrandProfile, site?: SiteContext): string[] {
  const pages = site
    ? htmlPages(site)
        .sort((a, b) => a.depth - b.depth)
        .map((p) => p.finalUrl || p.url)
    : [];
  if (pages.length) return pages.slice(0, 6);
  return [`https://${brand.domain}/`, `https://${brand.domain}/services`, `https://${brand.domain}/about`];
}

function pick<T>(rnd: () => number, items: T[]): T {
  return items[Math.floor(rnd() * items.length) % items.length]!;
}

function shuffle<T>(rnd: () => number, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const PRAISE = [
  'well reviewed on Clutch and responsive',
  'publishes detailed case studies with timelines and prices',
  'known for fixed-price projects',
  'strong local reputation and fast turnaround',
  'specialises in mid-sized businesses',
];

export function mockAnswer(input: {
  engine: EngineId;
  prompt: TrackedPrompt;
  brand: BrandProfile;
  site?: SiteContext;
  repeat?: number;
}): AnswerResult {
  const { engine, prompt, brand } = input;
  const rnd = seeded(`${engine}|${prompt.id}|${input.repeat ?? 0}`);
  const service = (brand.services[0] ?? 'professional services').toLowerCase();
  const where = brand.location ? ` in ${brand.location}` : '';
  const competitors = shuffle(rnd, mockCompetitors(brand));
  const searching = prompt.search && SEARCHING.includes(engine);
  const own = ownPages(brand, input.site);
  const citations: { url: string; title?: string }[] = [];
  const queries: string[] = [];
  let text: string;
  let mentioned = false;

  if (prompt.kind === 'brand') {
    const knows = prompt.search ? rnd() > 0.1 : !(engine === 'chatgpt' || engine === 'deepseek') && rnd() > 0.3;
    if (knows) {
      mentioned = true;
      // Occasionally states a wrong founding year, so the fact check has something to find.
      const year = rnd() < 0.35 ? 2015 : null;
      text = [
        `${brand.name} is a ${service} provider${brand.location ? ` based in ${brand.location}` : ''}.`,
        year ? `It was founded in ${year}.` : '',
        `It is ${pick(rnd, PRAISE)}.`,
        brand.services.length > 1 ? `Services include ${brand.services.slice(0, 3).join(', ')}.` : '',
      ]
        .filter(Boolean)
        .join(' ');
    } else {
      text = `I don't have reliable information about ${brand.name}. It may be a smaller ${service} business; check its website (${brand.domain}) and independent reviews.`;
    }
    if (searching) {
      if (mentioned) citations.push({ url: own[0]!, title: `${brand.name}` });
      citations.push({ url: `https://www.linkedin.com/company/${slug(brand.name)}`, title: 'LinkedIn' });
      queries.push(brand.name, `${brand.name} reviews`);
    }
  } else {
    const base = BIAS[engine] ?? 0.4;
    const chance = prompt.kind === 'comparison' ? 1 : prompt.kind === 'problem' ? base * 0.6 : base;
    mentioned = prompt.kind === 'comparison' ? prompt.text.toLowerCase().includes(brand.name.toLowerCase()) || rnd() < base : rnd() < chance;
    const listed = competitors.slice(0, 3 + Math.floor(rnd() * 2));
    if (mentioned) listed.splice(Math.floor(rnd() * (listed.length + 1)), 0, { name: brand.name, domain: brand.domain });
    const intro =
      prompt.kind === 'problem'
        ? `A few providers can help with this${where}:`
        : prompt.kind === 'comparison'
          ? `Here is how the main options compare for ${service}:`
          : `Here are some well-regarded ${service} providers${where}:`;
    text = [
      intro,
      '',
      ...listed.map((c, i) => `${i + 1}. **${c.name}** — ${c.name === brand.name ? pick(rnd, PRAISE.slice(2)) : pick(rnd, PRAISE)}.`),
      '',
      'Check recent reviews and ask for case studies before you decide.',
    ].join('\n');
    if (searching) {
      const top = listed.find((c) => c.name !== brand.name)!;
      citations.push({ url: `https://${top.domain}/blog/best-${slug(service)}${brand.location ? `-${slug(brand.location)}` : ''}`, title: `Best ${service}${where}` });
      citations.push({ url: `https://clutch.co/directory/${slug(service)}`, title: `Top ${service} companies` });
      if (rnd() < 0.5) citations.push({ url: `https://www.reddit.com/r/smallbusiness/comments/${slug(service).slice(0, 20)}`, title: 'Reddit thread' });
      if (rnd() < 0.4) citations.push({ url: `https://${listed[listed.length - 1]!.domain}/`, title: listed[listed.length - 1]!.name });
      if (mentioned && rnd() < 0.7) citations.push({ url: pick(rnd, own), title: brand.name });
      if (engine !== 'perplexity')
        queries.push(`best ${service}${brand.location ? ` ${brand.location}` : ''}`, `${service} reviews`, `top ${service} companies`);
    }
  }

  return {
    text: `${MOCK_LABEL}\n\n${text}`,
    citations: citations.filter((c, i, all) => all.findIndex((x) => x.url === c.url) === i),
    queries,
    costUsd: 0,
  };
}
