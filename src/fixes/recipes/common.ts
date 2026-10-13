/**
 * Helpers shared by the recipe files added for full check coverage: affected-URL lists,
 * issue evidence, and web-server / edge config snippets picked by the detected host.
 */
import type { StackInfo } from '../../core/types.js';
import { isHosted } from '../stacks.js';
import type { RecipeInput, StackFix } from '../types.js';

/** Bullet list of affected URLs (first `n`). Empty string when there are none. */
export function urlsBlock(input: RecipeInput, n = 10, label = 'Affected pages'): string[] {
  if (!input.urls.length) return [];
  const more = input.urls.length > n ? `\n- … and ${input.urls.length - n} more` : '';
  return [
    `${label}:\n${input.urls
      .slice(0, n)
      .map((u) => `- ${u}`)
      .join('\n')}${more}`,
  ];
}

/** The raw evidence strings from the issues (deduplicated, first `n`). */
export function evidenceOf(input: RecipeInput, n = 8): string[] {
  const out = new Set<string>();
  for (const i of input.issues) {
    if (!i.evidence) continue;
    for (const part of i.evidence.split(' | ')) if (part.trim()) out.add(part.trim());
    if (out.size >= n) break;
  }
  return [...out].slice(0, n);
}

/** One step quoting the evidence, or nothing. */
export function evidenceStep(input: RecipeInput, label = 'What the audit found'): string[] {
  const ev = evidenceOf(input);
  return ev.length ? [`${label}:\n${ev.map((e) => `- ${e}`).join('\n')}`] : [];
}

/** A re-test step for the check. */
export function verifyStep(input: RecipeInput, extra?: string): string {
  return `${extra ? `${extra} ` : ''}Re-run \`avc audit --only ${input.def.id}\` to confirm the issue has gone.`;
}

// ---------------------------------------------------------------------------
// Web server / edge configuration
// ---------------------------------------------------------------------------

export type ServerTarget = 'vercel' | 'netlify' | 'cloudflare' | 'nginx' | 'apache';

export const SERVER_FILES: Record<ServerTarget, string> = {
  vercel: 'vercel.json',
  netlify: 'netlify.toml (or _redirects / _headers)',
  cloudflare: 'Cloudflare dashboard: Rules / WAF (or a Worker)',
  nginx: 'nginx site config (server block)',
  apache: '.htaccess (or the Apache vhost)',
};

const LANG: Record<ServerTarget, string> = {
  vercel: 'json',
  netlify: 'toml',
  cloudflare: 'text',
  nginx: 'nginx',
  apache: 'apache',
};

/** Where server-level rules go for this stack and host, most likely first. */
export function serverTargets(stack: StackInfo): ServerTarget[] {
  const host = `${stack.host ?? ''} ${stack.cdn ?? ''}`.toLowerCase();
  const out: ServerTarget[] = [];
  if (host.includes('vercel')) out.push('vercel');
  if (host.includes('netlify')) out.push('netlify');
  if (host.includes('nginx')) out.push('nginx');
  if (host.includes('apache') || host.includes('litespeed')) out.push('apache');
  if (['wordpress', 'drupal', 'joomla', 'magento', 'laravel'].includes(stack.id))
    out.push('apache', 'nginx');
  if (stack.id === 'nextjs') out.push('vercel');
  if (host.includes('cloudflare')) out.push('cloudflare');
  out.push('nginx', 'apache', 'cloudflare');
  return [...new Set(out)];
}

/**
 * A fix expressed as web-server or edge rules. `rules` holds the config per target; the
 * detected host's version becomes the snippet and up to two others are listed as alternatives.
 */
export function serverFix(
  input: RecipeInput,
  rules: Partial<Record<ServerTarget, string>>,
  intro: string[] = [],
): StackFix {
  const targets = serverTargets(input.stack).filter((t) => rules[t]);
  const all = (Object.keys(rules) as ServerTarget[]).filter((t) => rules[t]);
  const order = [...new Set([...targets, ...all])];
  const primary = order[0];
  if (!primary) return { steps: intro, files: [] };
  const alts = order.slice(1, 3);
  return {
    steps: [
      ...intro,
      `Add the rule in \`${SERVER_FILES[primary]}\` (below).`,
      ...alts.map((t) => `On ${SERVER_FILES[t]} instead:\n${rules[t]}`),
    ],
    files: [primary, ...alts].map((t) => SERVER_FILES[t]),
    snippet: { language: LANG[primary], code: rules[primary]! },
  };
}

/** True for platforms where the owner cannot change server config (hosted builders, Shopify). */
export function noServerAccess(input: RecipeInput): boolean {
  return isHosted(input.stack.id) || input.stack.id === 'shopify';
}
