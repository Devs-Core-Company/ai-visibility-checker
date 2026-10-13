import type { BrandProfile, VisibilityRun } from '../core/types.js';
import { hostOf, sameBrand, withTimeout } from './util.js';

/**
 * Entity lookup: does the brand exist as an entity that AI engines and
 * search can resolve? Wikidata by name and by official website (P856), and
 * the Google Knowledge Graph when GOOGLE_KG_API_KEY is set. Both are free,
 * keyless (Wikidata) public APIs; failures are reported as notes, never thrown.
 */

const UA = 'AVC/1.0 (+https://devs-core.com/ai-visibility-checker/app)';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface EntityOptions {
  sameAs?: string[];
  /** Skip all network calls (mock mode / offline). */
  offline?: boolean;
  kgKey?: string;
  fetch?: FetchFn;
  signal?: AbortSignal;
}

async function getJson<T>(f: FetchFn, url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await f(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: withTimeout(8_000, signal),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function wikidataByName(
  name: string,
  f: FetchFn = fetch,
  signal?: AbortSignal,
): Promise<{ id: string; label: string; description?: string } | null> {
  const q = new URLSearchParams({
    action: 'wbsearchentities',
    search: name,
    language: 'en',
    format: 'json',
    limit: '5',
    type: 'item',
  });
  const data = await getJson<{ search?: { id: string; label?: string; description?: string }[] }>(
    f,
    `https://www.wikidata.org/w/api.php?${q}`,
    signal,
  );
  const hit = (data?.search ?? []).find(
    (s) => s.label && sameBrand(s.label, name) && s.label.length <= name.length + 12,
  );
  return hit ? { id: hit.id, label: hit.label ?? name, description: hit.description } : null;
}

export async function wikidataByDomain(
  domain: string,
  f: FetchFn = fetch,
  signal?: AbortSignal,
): Promise<{ id: string } | null> {
  const d = hostOf(domain);
  const variants = [`https://${d}`, `https://${d}/`, `https://www.${d}`, `https://www.${d}/`, `http://${d}/`];
  const q = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: `haswbstatement:${variants.map((v) => `P856=${v}`).join('|')}`,
    format: 'json',
    srlimit: '3',
  });
  const data = await getJson<{ query?: { search?: { title: string }[] } }>(
    f,
    `https://www.wikidata.org/w/api.php?${q}`,
    signal,
  );
  const title = data?.query?.search?.[0]?.title;
  return title && /^Q\d+$/.test(title) ? { id: title } : null;
}

export async function knowledgeGraph(
  name: string,
  key: string,
  f: FetchFn = fetch,
  signal?: AbortSignal,
): Promise<boolean | null> {
  const q = new URLSearchParams({ query: name, key, limit: '5', languages: 'en' });
  const data = await getJson<{ itemListElement?: { result?: { name?: string } }[] }>(
    f,
    `https://kgsearch.googleapis.com/v1/entities:search?${q}`,
    signal,
  );
  if (!data) return null;
  return (data.itemListElement ?? []).some((i) => i.result?.name && sameBrand(i.result.name, name));
}

export async function lookupEntity(
  brand: BrandProfile,
  opts: EntityOptions = {},
): Promise<NonNullable<VisibilityRun['entity']>> {
  const sameAs = [...new Set(opts.sameAs ?? [])];
  const notes: string[] = [];
  if (sameAs.length)
    notes.push(`Your Organization schema links ${sameAs.length} profile${sameAs.length === 1 ? '' : 's'} with sameAs.`);
  else
    notes.push(
      'No sameAs links found in your Organization schema. Add your LinkedIn, Wikidata, Crunchbase and review-site profiles so engines can tie them to you.',
    );

  if (opts.offline) {
    notes.push('Wikidata and Knowledge Graph were not checked (mock or offline mode).');
    return { sameAs, notes };
  }

  const f = opts.fetch ?? fetch;
  const [byDomain, byName] = await Promise.all([
    wikidataByDomain(brand.domain, f, opts.signal),
    wikidataByName(brand.name, f, opts.signal),
  ]);
  const wikidataId = byDomain?.id ?? byName?.id;
  if (byDomain) notes.push(`Wikidata item ${byDomain.id} lists ${brand.domain} as its official website.`);
  else if (byName)
    notes.push(
      `Wikidata has an item named "${byName.label}" (${byName.id}${byName.description ? `, ${byName.description}` : ''}), but it does not list ${brand.domain} as its official website. Check it is you and add the website (P856).`,
    );
  else
    notes.push(
      `No Wikidata item found for ${brand.name}. A well-sourced Wikidata item helps engines recognise you as an entity.`,
    );
  if (wikidataId && !sameAs.some((u) => u.includes(wikidataId)))
    notes.push(`Add https://www.wikidata.org/wiki/${wikidataId} to sameAs in your Organization schema.`);

  const kgKey = opts.kgKey ?? process.env.GOOGLE_KG_API_KEY;
  let kg: boolean | undefined;
  if (kgKey) {
    const r = await knowledgeGraph(brand.name, kgKey, f, opts.signal);
    if (r === null) notes.push('The Google Knowledge Graph lookup failed.');
    else {
      kg = r;
      notes.push(
        r
          ? `Google's Knowledge Graph has an entity named ${brand.name}.`
          : `Google's Knowledge Graph returned no entity named ${brand.name}.`,
      );
    }
  }

  return {
    ...(wikidataId ? { wikidataId } : {}),
    ...(kg !== undefined ? { knowledgeGraph: kg } : {}),
    sameAs,
    notes,
  };
}
