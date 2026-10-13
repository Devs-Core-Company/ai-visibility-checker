/**
 * Content recipes (AEO/GEO and content quality). These need a person: the fix is a
 * writing brief per affected page, plus the markup to add once the content exists.
 */
import { templateFile } from '../stacks.js';
import type { Recipe, RecipeInput, StackFix } from '../types.js';

function pageLines(input: RecipeInput, n = 15): string[] {
  const pages = input.pages ?? input.result?.pages ?? [];
  return input.urls.slice(0, n).map((u) => {
    const p = pages.find((x) => x.url === u || x.finalUrl === u);
    return p ? `- ${u} — H1: "${p.h1 ?? p.title ?? '(none)'}", ${p.wordCount} words` : `- ${u}`;
  });
}

function brief(
  input: RecipeInput,
  goal: string,
  rules: string[],
  snippet?: StackFix['snippet'],
): StackFix {
  return {
    steps: [
      `Goal: ${goal}`,
      ...rules,
      `Pages to work on:\n${pageLines(input).join('\n') || '- (site-wide)'}`,
      'Write it yourself or brief a writer with this list; an AI assistant can draft, but check every fact against what you actually offer.',
    ],
    files: [templateFile(input)],
    snippet,
  };
}

const answerFirst: Recipe = {
  id: 'answer-first',
  patterns: [/^geo-content\..*(answer|lead|first|summary|intro|tldr|direct)/],
  impact: 'high',
  effort: 'hours',
  tier: 'manual',
  build(input) {
    return {
      title: 'Answer the main question in the first paragraph',
      ...brief(
        input,
        'AI engines quote the passage that answers the question directly. Put that passage right under the H1.',
        [
          'Under the H1, write 40–60 words that answer the page’s main question in plain terms (who it is for, what it is, the key fact or price range).',
          'Then expand with H2 sections, each opening with its own one- or two-sentence answer.',
          'Keep the answer in the HTML (not in a tab, accordion that loads later, or image).',
        ],
      ),
    };
  },
};

const faq: Recipe = {
  id: 'faq-content',
  patterns: [/^geo-content\..*(faq|question)/],
  impact: 'medium',
  effort: 'hours',
  tier: 'manual',
  build(input) {
    return {
      title: 'Add a short FAQ with real customer questions',
      ...brief(
        input,
        'Cover the questions people ask AI assistants about this topic, in their words.',
        [
          'Collect 4–8 questions from sales emails, support tickets, Search Console queries and "People also ask".',
          'Use each question as an H2/H3 (ending with "?") and answer it in 2–4 sentences directly below.',
          'Once published, add FAQPage JSON-LD that matches the visible text (`avc fix --faq <url>` generates it from the page).',
        ],
        {
          language: 'html',
          code: `<section>\n  <h2>Frequently asked questions</h2>\n  <h3>How long does setup take?</h3>\n  <p>Direct answer in two to four sentences.</p>\n</section>`,
        },
      ),
    };
  },
};

const freshness: Recipe = {
  id: 'freshness',
  patterns: [
    /^geo-content\..*(fresh|date|updated|stale|modified)/,
    /^content\..*(stale|fresh|date)/,
  ],
  impact: 'medium',
  effort: 'hours',
  tier: 'manual',
  build(input) {
    return {
      title: 'Show when content was last reviewed',
      ...brief(input, 'Engines prefer recent sources for anything that changes.', [
        'Review the content, update facts and examples, then show a visible "Updated <date>" line.',
        'Output the same date as `dateModified` in Article JSON-LD and the sitemap `<lastmod>`; change it only when the content really changes.',
      ]),
    };
  },
};

const evidence: Recipe = {
  id: 'evidence',
  patterns: [
    /^geo-content\..*(stat|number|cite|citation|source|evidence|quote|expert|author|eeat|e-e-a-t)/,
  ],
  impact: 'medium',
  effort: 'days',
  tier: 'manual',
  build(input) {
    return {
      title: 'Back claims with specifics and sources',
      ...brief(
        input,
        'Pages with concrete facts, named authors and cited sources are quoted more by AI engines.',
        [
          'Replace vague claims with specific ones you can back up (your own figures, named clients with permission, dates, prices).',
          'Link to primary sources for external facts. Add an author line with a short bio linking to an author page.',
          'Do not invent numbers or credentials.',
        ],
      ),
    };
  },
};

const thin: Recipe = {
  id: 'thin-content',
  patterns: [
    /^(content|geo-content)\..*(thin|short|word|depth|coverage|duplicate|near-duplicate)/,
    /^duplicates\./,
  ],
  impact: 'medium',
  effort: 'days',
  tier: 'manual',
  build(input) {
    return {
      title: input.def.title,
      ...brief(
        input,
        'Each indexable page should answer something specific that no other page on the site already answers.',
        [
          'Merge near-duplicates into one stronger page and 301 the others to it, or set a canonical.',
          'Expand thin pages that matter with the specifics a buyer needs; noindex or remove the rest.',
        ],
      ),
    };
  },
};

const geoGeneric: Recipe = {
  id: 'geo-generic',
  patterns: ['geo-content.*', 'content.*'],
  impact: 'medium',
  effort: 'hours',
  tier: 'manual',
  build(input) {
    return { title: input.def.title, ...brief(input, input.def.why, [input.def.fix]) };
  },
};

export const recipes: Recipe[] = [answerFirst, faq, freshness, evidence, thin, geoGeneric];
