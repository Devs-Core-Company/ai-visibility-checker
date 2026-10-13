/**
 * Analytics recipes: missing, duplicated or retired tags, inconsistent coverage, consent,
 * and the tag inventory. Verification tags and the GTM noscript placement live in
 * response-extra.ts and crawl-extra.ts.
 */
import { byStack, templateFile } from '../stacks.js';
import type { Recipe, RecipeInput, StackFix } from '../types.js';
import { evidenceStep, urlsBlock, verifyStep } from './common.js';

function ga4Id(input: RecipeInput): string {
  return (
    input.issues
      .map((i) => /G-[A-Z0-9]{6,}/.exec(`${i.evidence ?? ''} ${i.message}`)?.[0])
      .find(Boolean) ?? 'G-XXXXXXXXXX'
  );
}

/** Where the one analytics tag should live, per stack. */
function tagPlacement(input: RecipeInput): StackFix {
  const id = ga4Id(input);
  return byStack(input, {
    'nextjs-app': () => ({
      steps: [
        'Load the tag once in the root layout with `@next/third-parties/google`, so every route includes it.',
      ],
      files: ['app/layout.tsx'],
      snippet: {
        language: 'tsx',
        code: `// app/layout.tsx
import { GoogleAnalytics } from '@next/third-parties/google';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
      <GoogleAnalytics gaId="${id}" />
    </html>
  );
}`,
      },
    }),
    'nextjs-pages': () => ({
      steps: ['Load the tag once in `pages/_app.tsx` with `@next/third-parties/google`.'],
      files: ['pages/_app.tsx'],
    }),
    wordpress: () => ({
      steps: [
        'Use one method only: Site Kit by Google (Settings → Connect Analytics) or a single GTM container plugin. Remove tags pasted into the theme, header/footer plugins or page builders.',
      ],
      files: [
        'WordPress: Site Kit / GTM plugin',
        'header & footer code plugin',
        'theme header.php',
      ],
    }),
    shopify: () => ({
      steps: [
        'Connect GA4 through the Google & YouTube app (Online Store → Preferences links to it). Remove GA code pasted into `theme.liquid` or Customer events if the app already sends it.',
      ],
      files: ['Google & YouTube app', 'Settings → Customer events', 'layout/theme.liquid'],
    }),
    hosted: () => ({
      steps: [
        'Use the platform’s built-in Google Analytics field (site settings → integrations) or one custom-code snippet in the site-wide head, not both.',
      ],
      files: ['Site settings → Integrations / Custom code'],
    }),
    unknown: () => ({
      steps: ['Put the tag once in the shared layout `<head>` used by every template:'],
      files: [templateFile(input)],
      snippet: {
        language: 'html',
        code: `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${id}');
</script>`,
      },
    }),
  });
}

const AI_CHANNEL_REGEX =
  '^(.*\\.)?(chatgpt\\.com|chat\\.openai\\.com|perplexity\\.ai|claude\\.ai|gemini\\.google\\.com|copilot\\.microsoft\\.com|edgeservices\\.bing\\.com|chat\\.deepseek\\.com|grok\\.com)$';

const analyticsSetup: Recipe = {
  id: 'analytics-setup',
  patterns: [/^analytics\.(none|inconsistent)$/],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const none = input.def.id.endsWith('none');
    const f = tagPlacement(input);
    return {
      ...f,
      title: none ? 'Add analytics and an AI referral channel' : 'Load analytics on every template',
      steps: [
        none
          ? 'No analytics was found, so you cannot see visits from ChatGPT, Perplexity, Gemini or Copilot, or tell whether changes worked. Add GA4, or a cookie-less tool (Plausible, Fathom, Simple Analytics) if you want to avoid a consent banner.'
          : 'Some templates lack the analytics tag, so visits to those pages (and AI referrals landing on them) are not counted. Move the tag into the layout every template shares.',
        ...f.steps,
        `In GA4, create a custom channel group with an “AI assistants” channel (Admin → Data display → Channel groups) matching source by this regex, placed above Referral:\n\`${AI_CHANNEL_REGEX}\``,
        ...(none ? [] : urlsBlock(input, 10, 'Pages without the tag')),
        verifyStep(input, 'Check GA4 → Reports → Realtime while browsing a few page types.'),
      ],
    };
  },
};

const duplicateTags: Recipe = {
  id: 'analytics-duplicates',
  patterns: [/^analytics\.(duplicate-ga4|duplicate-gtm|multiple-ga4-properties)$/],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    const id = input.def.id;
    const gtm = id.endsWith('duplicate-gtm');
    const multi = id.endsWith('multiple-ga4-properties');
    const where = byStack(input, {
      wordpress: () => ({
        steps: [
          'Typical cause: Site Kit (or MonsterInsights) adds GA4 and a GTM plugin or the theme adds it again. Keep one: if you use GTM, turn off Site Kit’s “Place Google Analytics code” and send GA4 through a GTM tag.',
        ],
        files: [
          'Site Kit settings',
          'GTM plugin',
          'header & footer code plugin',
          'theme header.php',
        ],
      }),
      shopify: () => ({
        steps: [
          'Typical cause: the Google & YouTube app sends GA4 and the same ID is also pasted into `theme.liquid` or a Customer events pixel. Remove the manual copy.',
        ],
        files: ['layout/theme.liquid', 'Settings → Customer events'],
      }),
      'nextjs-app': () => ({
        steps: [
          'Search the code for the ID: it is often in both `app/layout.tsx` (`<GoogleAnalytics>` / gtag script) and inside the GTM container. Keep one.',
        ],
        files: ['app/layout.tsx', 'Google Tag Manager container'],
      }),
      unknown: () => ({
        steps: [
          'Search templates and injected-code settings for the ID and keep a single copy; if you use GTM, the GA4 tag belongs inside the container, not as a separate gtag snippet.',
        ],
        files: [templateFile(input), 'Google Tag Manager container'],
      }),
    });
    return {
      ...where,
      title: gtm
        ? 'Load the Tag Manager container once'
        : multi
          ? 'Remove GA4 properties nobody uses'
          : 'Load GA4 once',
      steps: [
        gtm
          ? 'The same GTM container is loaded twice, so every tag fires twice: double page views, double conversions and slower pages.'
          : multi
            ? 'Several GA4 IDs load on the page. Sometimes that is intended (agency and client, or a roll-up property); often one is a leftover. In GA4 → Admin → Data streams, check each ID is a property someone uses, then remove the rest.'
            : 'The same GA4 ID is loaded twice (often once directly and once through Tag Manager), which double-counts page views.',
        ...evidenceStep(input),
        ...where.steps,
        'Confirm with Google Tag Assistant (tagassistant.google.com) that each tag fires once per page view.',
        verifyStep(input),
      ],
    };
  },
};

const universalAnalytics: Recipe = {
  id: 'universal-analytics',
  patterns: [/^analytics\.universal-analytics$/],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    const where = byStack(input, {
      wordpress: () => ({
        steps: [
          'Remove UA- IDs from Site Kit / MonsterInsights / GA plugins (older versions kept both), header & footer code plugins, and the theme.',
        ],
        files: ['WordPress: analytics plugins', 'theme header.php'],
      }),
      shopify: () => ({
        steps: [
          'Online Store → Preferences: clear the old “Google Analytics” UA field if present, and remove analytics.js code from `theme.liquid`.',
        ],
        files: ['Online Store → Preferences', 'layout/theme.liquid'],
      }),
      unknown: () => ({
        steps: [
          'Remove `analytics.js` / `ga.js` snippets and `UA-` IDs from templates and from the GTM container (Universal Analytics tags).',
        ],
        files: [templateFile(input), 'Google Tag Manager container'],
      }),
    });
    return {
      ...where,
      title: 'Remove retired Universal Analytics code',
      steps: [
        'Universal Analytics stopped processing data in 2023 (2024 for 360). The script still loads and costs performance but records nothing.',
        ...evidenceStep(input),
        ...where.steps,
        'Make sure GA4 (or another tool) is in place before removing it.',
        verifyStep(input),
      ],
    };
  },
};

const consent: Recipe = {
  id: 'analytics-consent',
  patterns: [/^analytics\.consent-not-detected$/],
  impact: 'medium',
  effort: 'hours',
  tier: 'manual',
  build(input) {
    const where = byStack(input, {
      wordpress: () => ({
        steps: [
          'Use a consent plugin that supports Google Consent Mode v2 (Complianz, CookieYes, Cookiebot) and block non-essential tags until consent; Site Kit integrates with the WP Consent API.',
        ],
        files: ['WordPress: consent plugin'],
      }),
      shopify: () => ({
        steps: [
          'Settings → Customer privacy → Cookie banner: turn it on for the regions that need it. Shopify’s banner works with the Customer Privacy API and the Google & YouTube app.',
        ],
        files: ['Shopify: Customer privacy settings'],
      }),
      unknown: () => ({
        steps: [
          'Add a consent management platform that supports Google Consent Mode v2, and set default consent to “denied” before any tag loads:',
        ],
        files: [templateFile(input)],
        snippet: {
          language: 'html',
          code: `<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('consent', 'default', {
    ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
    analytics_storage: 'denied', wait_for_update: 500,
  });
</script>
<!-- then the CMP script, then GA4 / GTM -->`,
        },
      }),
    });
    return {
      ...where,
      title: 'Check consent for tracking tags',
      steps: [
        'Tracking tags were found but no consent tool. Whether you need one depends on where your visitors are: the UK and EU (and several other places) require consent before non-essential cookies. This is a legal decision — check with whoever handles privacy for the business.',
        'If you need consent: add a consent banner with Google Consent Mode v2 and load non-essential tags only after consent.',
        'If you would rather not have a banner: switch to cookie-less analytics (Plausible, Fathom, Simple Analytics) and remove advertising pixels.',
        ...where.steps,
        'A consent tool loaded through Tag Manager may not be visible in the HTML; if you have one, this finding can be ignored.',
      ],
    };
  },
};

const inventory: Recipe = {
  id: 'analytics-inventory',
  patterns: [/^analytics\.inventory$/],
  impact: 'low',
  effort: 'minutes',
  tier: 'manual',
  build(input) {
    return {
      title: 'Review the tracking tools on the site',
      steps: [
        'This is an inventory, not a fault. Check the list matches what you expect:',
        ...evidenceStep(input, 'Tools detected'),
        'Remove tools nobody uses (old pixels, trial heatmaps, retired chat widgets): each one costs page speed and may need consent.',
        'Keep one place where tags are managed (Tag Manager or the CMS integration) so the list stays under control.',
        'Make sure at least one tool can report visits referred by AI assistants (chatgpt.com, perplexity.ai, gemini.google.com, copilot.microsoft.com, claude.ai).',
      ],
      files: ['Google Tag Manager container', templateFile(input)],
    };
  },
};

export const recipes: Recipe[] = [
  analyticsSetup,
  duplicateTags,
  universalAnalytics,
  consent,
  inventory,
];
