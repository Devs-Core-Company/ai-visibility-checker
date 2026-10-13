/**
 * Recipe registry. Order matters: specific recipes first, category catch-alls last.
 * Anything unmatched falls back to the check's own `fix` text with stack hints.
 */
import { templateFile } from '../stacks.js';
import type { Recipe } from '../types.js';
import { recipes as a11yMobile } from './a11y-mobile.js';
import { recipes as aiAccess } from './ai-access.js';
import { recipes as agentic } from './agentic.js';
import { recipes as analytics } from './analytics.js';
import { recipes as cms } from './cms.js';
import { recipes as crawlExtra } from './crawl-extra.js';
import { recipes as geo } from './geo.js';
import { recipes as linksUrls } from './links-urls.js';
import { recipes as onpage } from './onpage.js';
import { recipes as parity } from './parity.js';
import { recipes as responseExtra } from './response-extra.js';
import { recipes as schema } from './schema.js';
import { recipes as securityExtra } from './security-extra.js';
import { recipes as technical } from './technical.js';

export const RECIPES: Recipe[] = [
  // Exact ids for the parity checks first, so broad patterns below never take them.
  ...parity,
  ...aiAccess,
  ...agentic,
  ...schema,
  ...onpage,
  ...technical,
  ...geo,
  // Exact-id recipes for the remaining checks. They come last so they never take over an id
  // an earlier recipe already handles.
  ...crawlExtra,
  ...responseExtra,
  ...linksUrls,
  ...securityExtra,
  ...a11yMobile,
  ...analytics,
  ...cms,
];

export const FALLBACK: Recipe = {
  id: 'fallback',
  patterns: [/.*/],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    return {
      title: input.def.title,
      steps: [input.def.fix, `Where to look on ${input.stack.id}: ${templateFile(input)}.`],
      files: [templateFile(input)],
    };
  },
};

const cache = new Map<string, RegExp>();

/** Glob → RegExp: `*` matches anything (including dots). */
export function patternToRegExp(p: string | RegExp): RegExp {
  if (p instanceof RegExp) return p;
  let re = cache.get(p);
  if (!re) {
    re = new RegExp(
      '^' +
        p
          .split('*')
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    );
    cache.set(p, re);
  }
  return re;
}

export function matches(recipe: Recipe, checkId: string): boolean {
  return recipe.patterns.some((p) => patternToRegExp(p).test(checkId));
}

export function findRecipe(checkId: string): Recipe {
  return RECIPES.find((r) => matches(r, checkId)) ?? FALLBACK;
}
