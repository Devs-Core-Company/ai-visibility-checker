/**
 * Recipes for checks that validate against a published standard: RFC 9116 security.txt,
 * the WHATWG autofill tokens, JSON Schema for WebMCP tools, schema.org vocabulary and date
 * order, structured data matching the page, copied main content and advertised markdown
 * alternates. Exact ids, listed before the broad category recipes.
 */
import { templateFile } from '../stacks.js';
import type { Recipe } from '../types.js';
import { evidenceStep, urlsBlock, verifyStep } from './common.js';

const securityTxt: Recipe = {
  id: 'security-txt-fields',
  patterns: ['security.security-txt-invalid'],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    const next = new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10);
    return {
      title: 'Complete security.txt (RFC 9116)',
      steps: [
        ...evidenceStep(input),
        'Edit /.well-known/security.txt. It needs at least one Contact line and exactly one Expires line; Expires should be less than a year ahead.',
        'Serve it as text/plain over HTTPS, and put a reminder in your calendar to renew Expires before it passes.',
        verifyStep(input),
      ],
      files: ['.well-known/security.txt (in the web root or public/ folder)'],
      snippet: {
        language: 'text',
        code: `Contact: mailto:security@${input.host}\nExpires: ${next}T00:00:00.000Z\nPreferred-Languages: en\nCanonical: ${input.origin}/.well-known/security.txt`,
      },
    };
  },
};

const autocomplete: Recipe = {
  id: 'autocomplete-tokens',
  patterns: ['accessibility.autocomplete-invalid'],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    return {
      title: 'Use standard autocomplete tokens',
      steps: [
        ...evidenceStep(input),
        ...urlsBlock(input),
        'Replace each invalid value with the HTML autofill token for the field: name, given-name, family-name, email, tel, street-address, postal-code, country-name, organization, bday, username, current-password, new-password, one-time-code.',
        'Common fixes: "e-mail" → "email", "phone" or "telephone" → "tel", "zip" or "postcode" → "postal-code", "firstname" → "given-name". Use "off" only where autofill would be wrong.',
        verifyStep(input),
      ],
      files: [templateFile(input)],
      snippet: {
        language: 'html',
        code: '<input type="email" name="email" autocomplete="email">\n<input type="tel" name="phone" autocomplete="tel">',
      },
    };
  },
};

const webmcpSchema: Recipe = {
  id: 'webmcp-input-schema',
  patterns: ['agentic.webmcp-schema-invalid'],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    return {
      title: 'Give WebMCP tools a valid JSON Schema',
      steps: [
        ...evidenceStep(input),
        'Find the navigator.modelContext.registerTool (or provideContext) call in the page’s scripts.',
        'Make inputSchema a JSON Schema with "type": "object", a "properties" object whose values are schemas, and "required" as an array of property names. Types must be string, number, integer, boolean, object, array or null; use "format": "date" for dates.',
        'Validate the schema with any JSON Schema validator before deploying.',
        verifyStep(input),
      ],
      files: ['The script that registers the tool'],
      snippet: {
        language: 'js',
        code: `navigator.modelContext.registerTool({
  name: 'request_appointment',
  description: 'Request an appointment',
  inputSchema: {
    type: 'object',
    properties: { date: { type: 'string', format: 'date' }, name: { type: 'string' } },
    required: ['date', 'name'],
  },
  execute: async (args) => { /* … */ },
});`,
      },
    };
  },
};

const schemaVocabulary: Recipe = {
  id: 'schema-vocabulary',
  patterns: ['schema.type-unknown', 'schema.date-order'],
  impact: 'high',
  effort: 'minutes',
  build(input) {
    const unknown = input.def.id === 'schema.type-unknown';
    return {
      title: unknown ? 'Use real schema.org types' : 'Fix start and end dates in structured data',
      steps: [
        ...evidenceStep(input),
        ...urlsBlock(input),
        unknown
          ? 'Replace each @type with an existing schema.org type (https://schema.org/docs/full.html), the most specific that fits. For a category schema.org lacks, keep the nearest type and add additionalType with a Wikidata or product-ontology URL.'
          : 'Correct endDate (or validThrough) so it is at or after the start, using the same time zone offset on both, and check them against the times the page shows.',
        `Edit the JSON-LD in ${templateFile(input)} (or the SEO plugin field that outputs it), then test the page in the Schema Markup Validator.`,
        verifyStep(input),
      ],
      files: [templateFile(input)],
    };
  },
};

const napPage: Recipe = {
  id: 'nap-page-match',
  patterns: ['geo-entity.nap-page-mismatch'],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    return {
      title: 'Make the markup phone number match the page',
      steps: [
        ...evidenceStep(input),
        ...urlsBlock(input),
        'Decide which number is correct for this location. Put that number in both the visible page and the LocalBusiness/Organization telephone, in international format (+44 …).',
        'If the number lives in a CMS field used by both the template and the JSON-LD, fix it there so they cannot drift apart again.',
        verifyStep(input),
      ],
      files: [templateFile(input)],
    };
  },
};

const copied: Recipe = {
  id: 'copied-content',
  patterns: ['duplicates.copied-content'],
  impact: 'medium',
  effort: 'hours',
  tier: 'manual',
  build(input) {
    return {
      title: 'Rewrite or consolidate copied main content',
      steps: [
        ...urlsBlock(input),
        ...evidenceStep(input, 'Copied from'),
        'Decide which page should rank for the topic. Keep the full text there.',
        'On the other page, write text for its own purpose (a short summary plus a link to the main page is often enough), or merge the pages and 301-redirect one to the other.',
        'If both must keep the same text, add a canonical on the copy pointing to the original.',
        verifyStep(input),
      ],
      files: ['CMS content of the pages listed'],
    };
  },
};

const markdownAlternate: Recipe = {
  id: 'markdown-alternate',
  patterns: ['llms-txt.markdown-alternate-broken'],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    return {
      title: 'Publish the advertised markdown versions (or stop advertising them)',
      steps: [
        ...urlsBlock(input),
        ...evidenceStep(input, 'Markdown URLs that fail'),
        'Generate a markdown copy of each page at the advertised URL (most frameworks can emit one at build time), served as text/markdown.',
        'If a page has no markdown version, remove its <link rel="alternate" type="text/markdown"> tag.',
        verifyStep(input),
      ],
      files: [templateFile(input)],
    };
  },
};

export const recipes: Recipe[] = [
  securityTxt,
  autocomplete,
  webmcpSchema,
  schemaVocabulary,
  napPage,
  copied,
  markdownAlternate,
];
