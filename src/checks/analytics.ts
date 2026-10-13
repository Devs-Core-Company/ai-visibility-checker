/**
 * Analytics and tag hygiene. Mostly informational: you cannot measure AI
 * referrals or the effect of fixes without working analytics.
 */
import type { PageData, SiteContext } from '../core/types.js';
import { homePage, htmlPages, isHtml200, list, pageCheck, plural, siteCheck } from './_util.js';

export const SAMPLE_PAGES = 50;
export const INCONSISTENT_MIN_SHARE = 0.2;

const T = 'technical' as const;

const TOOLS: [name: string, re: RegExp][] = [
  ['Google Analytics 4', /gtag\/js\?id=G-|['"]G-[A-Z0-9]{6,}['"]/],
  ['Google Tag Manager', /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/],
  [
    'Universal Analytics (retired)',
    /google-analytics\.com\/(analytics|ga)\.js|['"]UA-\d{4,}-\d+['"]/,
  ],
  ['Plausible', /plausible\.io\/js/],
  ['Fathom', /cdn\.usefathom\.com/],
  ['Matomo', /matomo\.js|piwik\.js|_paq\.push/],
  ['Simple Analytics', /scripts\.simpleanalyticscdn\.com/],
  ['Umami', /umami\.(is|js)|data-website-id=/],
  ['Vercel Web Analytics', /\/_vercel\/insights\/script\.js|va\.vercel-scripts\.com/],
  ['Cloudflare Web Analytics', /static\.cloudflareinsights\.com\/beacon/],
  ['Microsoft Clarity', /clarity\.ms\/tag/],
  ['Hotjar', /static\.hotjar\.com|hotjar\.com\/c\/hotjar/],
  ['Adobe Analytics', /assets\.adobedtm\.com|omniture|s_code\.js/],
  ['Segment', /cdn\.segment\.com\/analytics\.js/],
  ['PostHog', /posthog\.com|posthog\.init/],
  ['Mixpanel', /cdn\.mxpnl\.com|mixpanel\.init/],
  ['Heap', /heapanalytics\.com|heap\.load/],
  ['Meta Pixel', /connect\.facebook\.net\/[^"']+\/fbevents\.js/],
  ['LinkedIn Insight', /snap\.licdn\.com\/li\.lms-analytics/],
  ['Shopify analytics', /monorail-edge\.shopifysvc\.com|trekkie/],
  ['Wix analytics', /static\.parastorage\.com\/services\/wix-bi/],
  ['Jetpack Stats', /stats\.wp\.com\/e-/],
];
const TRACKERS =
  /gtag\/js|googletagmanager|google-analytics|fbevents|clarity\.ms|hotjar|snap\.licdn|analytics\.tiktok|bat\.bing\.com/;
const CONSENT =
  /cookiebot|onetrust|cookielaw\.org|cookieyes|iubenda|usercentrics|didomi|quantcast|trustarc|osano|termly|cookie-?consent|cookie-?notice|complianz|borlabs|klaro|gdpr-cookie|consentmanager|axeptio|tarteaucitron|civic\s*cookie|gtag\(\s*['"]consent['"]/i;

function detect(html: string): string[] {
  return TOOLS.filter(([, re]) => re.test(html)).map(([n]) => n);
}

function ids(html: string, re: RegExp): string[] {
  return [...html.matchAll(re)].map((m) => m[1]);
}

function sample(site: SiteContext): PageData[] {
  const home = homePage(site);
  const rest = htmlPages(site).filter((p) => p !== home);
  return (home && isHtml200(home) ? [home, ...rest] : rest).slice(0, SAMPLE_PAGES);
}

export const checks = [
  siteCheck(
    {
      id: 'analytics.inventory',
      category: 'analytics',
      pillar: T,
      title: 'Analytics and tracking tools detected',
      why: 'Knowing which tags run on the site helps you plan how to measure traffic from AI assistants and keep third-party scripts under control.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Check the list matches what you expect; remove tools nobody uses.',
    },
    (site) => {
      const found = new Set<string>();
      for (const p of sample(site)) for (const t of detect(p.html || '')) found.add(t);
      return found.size
        ? {
            checkId: 'analytics.inventory',
            message: `Detected: ${list([...found], 10)}`,
            data: { tools: [...found] },
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'analytics.none',
      category: 'analytics',
      pillar: T,
      title: 'No analytics detected',
      why: 'Without analytics you cannot see visits referred by ChatGPT, Perplexity, Gemini or Copilot, or tell whether SEO changes worked.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add an analytics tool (GA4, or a privacy-friendly one such as Plausible or Fathom) and set up a channel for AI assistant referrals.',
    },
    (site) => {
      const pages = sample(site);
      if (!pages.length || pages.some((p) => detect(p.html || '').length)) return null;
      return {
        checkId: 'analytics.none',
        message: `No analytics tag found on ${plural(pages.length, 'sampled page')} (server-side or consent-gated tags cannot be seen)`,
      };
    },
  ),
  pageCheck(
    {
      id: 'analytics.duplicate-ga4',
      category: 'analytics',
      pillar: T,
      title: 'Same GA4 measurement ID loaded twice',
      why: 'Loading the same GA4 property twice (often once directly and once through Tag Manager) double-counts page views and halves the bounce rate.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Load GA4 once: either the gtag snippet or the Tag Manager tag, not both.',
      refs: ['https://support.google.com/analytics/answer/9539598'],
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const scripts = ids(page.html, /gtag\/js\?id=(G-[A-Z0-9]+)/g);
      const configs = ids(page.html, /gtag\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]+)['"]/g);
      const dupe = [...new Set([...scripts, ...configs])].filter(
        (id) =>
          scripts.filter((x) => x === id).length > 1 || configs.filter((x) => x === id).length > 1,
      );
      return dupe.length
        ? { checkId: 'analytics.duplicate-ga4', message: `${list(dupe)} configured more than once` }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'analytics.duplicate-gtm',
      category: 'analytics',
      pillar: T,
      title: 'Same Tag Manager container loaded twice',
      why: 'A duplicated GTM container fires every tag twice: double page views, double conversions and slower pages.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove the second container snippet (often one is in the theme and one in a plugin).',
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const all = ids(page.html, /googletagmanager\.com\/gtm\.js\?id=(GTM-[A-Z0-9]+)/g).concat(
        ids(page.html, /['"](GTM-[A-Z0-9]+)['"]\s*\)\s*;?\s*<\/script>/g),
      );
      const dupe = [...new Set(all)].filter((id) => all.filter((x) => x === id).length > 1);
      return dupe.length
        ? { checkId: 'analytics.duplicate-gtm', message: `${list(dupe)} loaded more than once` }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'analytics.multiple-ga4-properties',
      category: 'analytics',
      pillar: T,
      title: 'Several GA4 properties on one page',
      why: 'More than one GA4 ID is sometimes intended (agency plus client), but often a leftover from an old property that still receives data.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Confirm each GA4 property is in use and remove the ones that are not.',
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const all = [
        ...new Set([
          ...ids(page.html, /gtag\/js\?id=(G-[A-Z0-9]+)/g),
          ...ids(page.html, /gtag\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]+)['"]/g),
        ]),
      ];
      return all.length > 1
        ? {
            checkId: 'analytics.multiple-ga4-properties',
            message: `${all.length} GA4 properties: ${list(all)}`,
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'analytics.universal-analytics',
      category: 'analytics',
      pillar: T,
      title: 'Retired Universal Analytics code still on the site',
      why: 'Universal Analytics stopped processing data in 2023 (2024 for 360). The script still loads and costs performance, but records nothing.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove the analytics.js / ga.js snippet and UA- IDs, and make sure GA4 (or another tool) is in place.',
      refs: ['https://support.google.com/analytics/answer/11583528'],
    },
    (site) => {
      const hit = sample(site).find((p) =>
        /google-analytics\.com\/(analytics|ga)\.js|['"]UA-\d{4,}-\d+['"]/.test(p.html || ''),
      );
      return hit
        ? {
            checkId: 'analytics.universal-analytics',
            url: hit.url,
            message: 'Universal Analytics code found',
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'analytics.inconsistent',
      category: 'analytics',
      pillar: T,
      title: 'Analytics missing on some pages',
      why: 'If some templates lack the tag, visits to those pages (and the AI referrals landing on them) are not counted.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add the analytics tag to the shared layout so every template includes it.',
    },
    (site) => {
      const pages = sample(site);
      if (pages.length < 5) return null;
      const tagged = pages.filter((p) => detect(p.html || '').some((t) => !/retired/.test(t)));
      const missing = pages.filter((p) => !tagged.includes(p));
      // Only flag when most pages are tagged, so a site with no analytics is not reported twice.
      if (!missing.length || tagged.length / pages.length < 1 - INCONSISTENT_MIN_SHARE * 2)
        return null;
      return {
        checkId: 'analytics.inconsistent',
        message: `${missing.length} of ${pages.length} sampled pages have no analytics tag`,
        evidence: list(
          missing.map((p) => p.url),
          4,
        ),
      };
    },
  ),
  siteCheck(
    {
      id: 'analytics.consent-not-detected',
      category: 'analytics',
      pillar: T,
      title: 'Tracking tags without a detectable consent tool',
      why: 'In the UK, EU and several other places, non-essential tracking cookies need prior consent. No consent manager was found in the HTML.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'If you have visitors from regions that require consent, add a consent banner and Google Consent Mode, or switch to cookie-less analytics.',
      refs: [
        'https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/cookies-and-similar-technologies/',
        'https://developers.google.com/tag-platform/security/guides/consent',
      ],
    },
    (site) => {
      const pages = sample(site).slice(0, 10);
      const tracked = pages.filter((p) => TRACKERS.test(p.html || ''));
      if (!tracked.length || pages.some((p) => CONSENT.test(p.html || ''))) return null;
      return {
        checkId: 'analytics.consent-not-detected',
        url: tracked[0].url,
        message: 'Tracking tags found but no consent manager detected',
      };
    },
  ),
  pageCheck(
    {
      id: 'analytics.gtm-noscript-misplaced',
      category: 'analytics',
      pillar: T,
      title: 'Tag Manager noscript iframe placed in <head>',
      why: 'The GTM <noscript><iframe> belongs right after <body>. In <head> it ends the head early, which can make Google ignore tags after it (canonical, hreflang, robots).',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Move the GTM noscript snippet to immediately after the opening <body> tag.',
      refs: ['https://developers.google.com/tag-platform/tag-manager/web'],
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const end = page.html.search(/<\/head\s*>/i);
      if (end < 0) return null;
      return /<noscript>\s*<iframe[^>]+googletagmanager\.com\/ns\.html/i.test(
        page.html.slice(0, end),
      )
        ? {
            checkId: 'analytics.gtm-noscript-misplaced',
            message: 'GTM noscript iframe is inside <head>',
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'analytics.verification-missing',
      category: 'analytics',
      pillar: T,
      title: 'No search engine verification tags on the home page',
      why: 'Search Console and Bing Webmaster Tools show indexing problems, queries and (for Bing) Copilot data. No verification tag was found; DNS verification would not be visible here.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Verify the site in Google Search Console and Bing Webmaster Tools (DNS verification is best; a meta tag works too).',
      refs: [
        'https://support.google.com/webmasters/answer/9008080',
        'https://www.bing.com/webmasters/help/add-and-verify-site-12184f8b',
      ],
    },
    (site) => {
      const home = homePage(site);
      if (!home || !isHtml200(home)) return null;
      const html = home.html || '';
      const missing = [
        !/google-site-verification/i.test(html) && 'Google',
        !/msvalidate\.01/i.test(html) && 'Bing',
      ].filter(Boolean) as string[];
      return missing.length === 2
        ? {
            checkId: 'analytics.verification-missing',
            url: home.url,
            message: 'No Google or Bing verification meta tag',
          }
        : null;
    },
  ),
];
