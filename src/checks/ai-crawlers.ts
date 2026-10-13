/**
 * AI crawler access (pillar 'ai-access'): can AI crawlers and assistants reach
 * and read the site? robots.txt per bot and purpose, what the firewall really
 * does (live fetch as each bot, home page and a key-page sample), page-level
 * opt-outs, and content a non-JavaScript reader cannot see.
 */
import type { Check, Issue, PageData, SiteContext } from '../core/types.js';
import {
  AI_BOTS,
  PURPOSE_COPY,
  botByToken,
  robotsBots,
  type AiBot,
  type BotPurpose,
} from '../agentic/bots.js';
import { botFetchDetail, sampleBotFetches } from '../agentic/bot-fetch.js';
import {
  countWords,
  ev,
  groupsFor,
  homePage,
  htmlPages,
  indexablePages,
  isIndexable,
  issue,
  pageCheck,
  pageDoc,
  parseDoc,
  plural,
  robotsLine,
  robotsParsed,
  robotsUsable,
  roughText,
  siteCheck,
  topLinkedPages,
  vb,
  type AiDef,
} from './_ai-util.js';

const REF = {
  rfc: 'https://www.rfc-editor.org/rfc/rfc9309',
  openai: 'https://platform.openai.com/docs/bots',
  anthropic: 'https://support.claude.com/en/articles/8896518',
  google: 'https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers',
  perplexity: 'https://docs.perplexity.ai/guides/bots',
  robotsMeta: 'https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag',
  bing: 'https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a',
  indexnow: 'https://www.indexnow.org/documentation',
  cc: 'https://commoncrawl.org/ccbot',
};

const base = { category: 'ai-crawlers', pillar: 'ai-access' } as const;
const def = (d: Omit<AiDef, 'category' | 'pillar'>): AiDef => ({ ...base, ...d });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rootUrl(site: SiteContext): string {
  return `${site.origin}/`;
}

interface Block {
  bot: AiBot;
  line: number | null;
  rule: string;
  inherited: boolean;
}

/** Bots disallowed from the site root, with the deciding line. */
function rootBlocks(site: SiteContext): Block[] {
  if (!robotsUsable(site)) return [];
  const parsed = robotsParsed(site);
  const root = rootUrl(site);
  const out: Block[] = [];
  for (const bot of robotsBots()) {
    let allowed = true;
    try {
      allowed = site.robots.isAllowed(root, bot.token) !== false;
    } catch {
      continue;
    }
    if (allowed) continue;
    const d = site.robots.decidingLine(root, bot.token);
    out.push({
      bot,
      line: d?.line ?? null,
      rule: d?.rule ?? (d?.line ? robotsLine(site, d.line) : 'Disallow'),
      inherited: !groupsFor(parsed, bot.token).specific,
    });
  }
  return out;
}

function fmt(b: Block): string {
  return `${b.bot.token}: ${b.line ? `line ${b.line} "${b.rule}"` : b.rule}${b.inherited ? ' (via User-agent: *)' : ''}`;
}

function purposeCheck(purpose: BotPurpose, severity: AiDef['severity'], title: string): Check {
  const id = `ai-crawlers.${purpose === 'user' ? 'user-fetchers' : `${purpose}-bots`}-blocked`;
  return siteCheck(
    def({
      id,
      title,
      why: `${PURPOSE_COPY[purpose].blockedMeans}`,
      severity,
      fixTier: 'guided',
      fix:
        purpose === 'training'
          ? 'If keeping your content out of model training is a deliberate choice, no change is needed. If not, remove the Disallow rules for these tokens in robots.txt.'
          : `Remove the Disallow rules for these bots in robots.txt, or add an explicit group such as "User-agent: ${purpose === 'search' ? 'OAI-SearchBot' : 'ChatGPT-User'}" with "Allow: /".`,
      refs: [REF.openai, REF.anthropic, REF.perplexity],
      tags: ['robots', purpose],
    }),
    (site) => {
      const blocks = rootBlocks(site).filter(
        (b) =>
          b.bot.purpose === purpose &&
          !b.inherited &&
          b.bot.token !== 'Googlebot' &&
          b.bot.token !== 'Bingbot',
      );
      if (!blocks.length) return null;
      const important = blocks.filter((b) => b.bot.important);
      return issue(
        id,
        `robots.txt blocks ${plural(blocks.length, `${PURPOSE_COPY[purpose].label.toLowerCase()} bot`)} from the whole site: ${blocks.map((b) => b.bot.token).join(', ')}.`,
        {
          severity: purpose !== 'training' && !important.length ? 'medium' : undefined,
          evidence: ev(blocks.map(fmt)),
          data: {
            bots: blocks.map((b) => ({
              token: b.bot.token,
              operator: b.bot.operator,
              line: b.line,
            })),
          },
        },
      );
    },
  );
}

function liveRows(site: SiteContext) {
  return site.botFetches ?? [];
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array<number>(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[m]![n]!;
}

function wordsIn(page: PageData, selector: string): number {
  const doc = pageDoc(page);
  if (!doc) return 0;
  let n = 0;
  for (const el of doc.querySelectorAll(selector))
    n += countWords(roughText((el as unknown as Element).innerHTML ?? ''));
  return n;
}

function directives(page: PageData): string {
  return [page.metaRobots ?? '', page.xRobotsTag ?? ''].join(', ').toLowerCase();
}

function hasDirective(all: string, d: string): boolean {
  return new RegExp(`(^|[\\s,:;])${d}($|[\\s,;])`, 'i').test(all);
}

function schemaCount(html: string): number {
  return (html.match(/<script[^>]+application\/ld\+json/gi) ?? []).length;
}

function titleOf(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? roughText(m[1]!).trim() : null;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export const checks: Check[] = [
  purposeCheck('search', 'high', 'AI search crawlers blocked in robots.txt'),
  purposeCheck('user', 'high', 'AI user-triggered fetchers blocked in robots.txt'),
  purposeCheck('training', 'info', 'AI training crawlers blocked in robots.txt'),

  siteCheck(
    def({
      id: 'ai-crawlers.googlebot-blocked',
      title: 'Googlebot blocked from the site',
      why: 'Googlebot feeds Google Search, AI Overviews and AI Mode. Blocking it removes the site from all three; there is no way to opt out of AI Overviews alone through robots.txt.',
      severity: 'critical',
      fixTier: 'guided',
      fix: 'Remove the Disallow: / that applies to Googlebot. To keep content out of Gemini training only, disallow Google-Extended instead.',
      refs: [REF.google],
      tags: ['robots', 'google'],
    }),
    (site) => {
      const b = rootBlocks(site).find((x) => x.bot.token === 'Googlebot');
      return b
        ? issue(
            'ai-crawlers.googlebot-blocked',
            'robots.txt blocks Googlebot from the home page.',
            { evidence: fmt(b) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.bingbot-blocked',
      title: 'Bingbot blocked from the site',
      why: 'Bing’s index grounds Microsoft Copilot and is one of the indexes other AI search products draw on. Blocking Bingbot removes the site from those answers as well as from Bing.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Remove the Disallow rules that apply to Bingbot in robots.txt.',
      refs: [REF.bing],
      tags: ['robots', 'bing', 'copilot'],
    }),
    (site) => {
      const b = rootBlocks(site).find((x) => x.bot.token === 'Bingbot');
      return b
        ? issue('ai-crawlers.bingbot-blocked', 'robots.txt blocks Bingbot from the home page.', {
            evidence: fmt(b),
          })
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.key-pages-blocked',
      title: 'Key pages blocked for AI search or user bots',
      why: 'The home page can be open while the pages people actually ask about (services, pricing, guides) are disallowed by a path rule. Those pages then cannot be cited.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Narrow the Disallow rules so they do not match these pages, or add Allow rules for them in the groups that apply to AI bots.',
      refs: [REF.rfc],
      tags: ['robots'],
    }),
    (site) => {
      if (!robotsUsable(site)) return null;
      const bots = AI_BOTS.filter(
        (b) => b.important && b.ua && b.purpose !== 'training' && b.robotsToken !== false,
      );
      const root = rootUrl(site);
      const out: Issue[] = [];
      for (const page of topLinkedPages(site, 15)) {
        const hits: string[] = [];
        for (const bot of bots) {
          try {
            if (site.robots.isAllowed(root, bot.token) === false) continue;
            if (site.robots.isAllowed(page.url, bot.token) === false) {
              const d = site.robots.decidingLine(page.url, bot.token);
              hits.push(`${bot.token}${d ? ` (line ${d.line}: ${d.rule})` : ''}`);
            }
          } catch {
            /* ignore */
          }
        }
        if (hits.length)
          out.push(
            issue(
              'ai-crawlers.key-pages-blocked',
              `A key page is disallowed for ${plural(hits.length, 'AI bot')} although the site root is allowed.`,
              {
                url: page.url,
                evidence: ev(hits),
              },
            ),
          );
      }
      return out;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.path-blocked',
      title: 'Sections of the site blocked for specific AI crawlers',
      why: 'A Disallow rule in one AI bot’s robots.txt group can hide a whole section (team biographies, guides, prices) from that bot while the rest of the site is open. Pages it cannot fetch cannot inform or be cited by that engine. Often a leftover from an old rule rather than a decision.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Check each rule listed. If the section should be readable by that bot, remove the Disallow line from its group (or add an Allow for the section). If the block is deliberate, no change is needed.',
      refs: [REF.rfc, REF.openai, REF.anthropic],
      tags: ['robots'],
    }),
    (site) => {
      if (!robotsUsable(site)) return null;
      const root = rootUrl(site);
      const pages = indexablePages(site);
      // bot token + deciding rule → pages it blocks
      const groups = new Map<string, { bot: AiBot; rule: string; pages: string[] }>();
      for (const bot of robotsBots()) {
        if (bot.token === 'Googlebot' || bot.token === 'Bingbot') continue;
        try {
          if (site.robots.isAllowed(root, bot.token) === false) continue; // whole-site blocks: purpose checks
        } catch {
          continue;
        }
        // Only rules written for this bot: a User-agent: * rule applies to every crawler alike.
        if (!groupsFor(robotsParsed(site), bot.token).specific) continue;
        for (const p of pages) {
          let allowed = true;
          try {
            allowed = site.robots.isAllowed(p.url, bot.token) !== false;
          } catch {
            continue;
          }
          if (allowed) continue;
          const d = site.robots.decidingLine(p.url, bot.token);
          const rule = d ? `line ${d.line}: ${d.rule}` : 'Disallow';
          const key = `${bot.token}|${rule}`;
          const g = groups.get(key) ?? { bot, rule, pages: [] };
          g.pages.push(p.url);
          groups.set(key, g);
        }
      }
      if (!groups.size) return null;
      const rows = [...groups.values()];
      const pageCount = new Set(rows.flatMap((g) => g.pages)).size;
      return issue(
        'ai-crawlers.path-blocked',
        `robots.txt blocks ${plural(new Set(rows.map((g) => g.bot.token)).size, 'AI bot')} from ${plural(pageCount, 'indexable page')} while allowing the rest of the site.`,
        {
          severity: rows.some((g) => g.bot.purpose !== 'training') ? 'high' : 'medium',
          evidence: ev(
            rows.map(
              (g) =>
                `${g.bot.token} (${g.rule}): ${plural(g.pages.length, 'page')}, e.g. ${new URL(g.pages[0]!).pathname}`,
            ),
          ),
          data: {
            rules: rows.map((g) => ({ token: g.bot.token, rule: g.rule, pages: g.pages.length })),
          },
        },
      );
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.wildcard-catches-ai',
      title: 'A User-agent: * rule blocks AI bots that have no group of their own',
      why: 'Rules written for all crawlers also apply to every AI bot without its own group. Sites often add a broad block for scrapers and silently remove themselves from AI search and assistants.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add explicit groups for the AI bots you want (for example "User-agent: OAI-SearchBot" then "Allow: /"), or narrow the User-agent: * rules.',
      refs: [REF.rfc],
      tags: ['robots'],
    }),
    (site) => {
      const blocks = rootBlocks(site).filter((b) => b.inherited && b.bot.purpose !== 'training');
      if (!blocks.length) return null;
      return issue(
        'ai-crawlers.wildcard-catches-ai',
        `${plural(blocks.length, 'AI search or user bot')} ${vb(blocks.length, 'inherits', 'inherit')} a site-wide block from User-agent: *.`,
        {
          evidence: ev(blocks.map(fmt)),
          severity: blocks.some((b) => b.bot.important) ? 'high' : undefined,
          data: { bots: blocks.map((b) => b.bot.token) },
        },
      );
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.duplicate-groups',
      title: 'The same AI bot is named in more than one robots.txt group',
      why: 'RFC 9309 says groups for the same agent are merged, but not every crawler implements that; some apply only the first group. The outcome for that bot becomes unpredictable.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Merge the rules for each bot into a single group.',
      refs: [REF.rfc],
      tags: ['robots'],
    }),
    (site) => {
      if (!robotsUsable(site)) return null;
      const parsed = robotsParsed(site);
      const seen = new Map<string, number[]>();
      for (const g of parsed.groups)
        g.agents.forEach((a, i) => {
          const k = a.toLowerCase();
          if (k === '*' || !botByToken(a)) return;
          seen.set(k, [...(seen.get(k) ?? []), g.agentLines[i]!]);
        });
      const dups = [...seen.entries()].filter(([, lines]) => lines.length > 1);
      if (!dups.length) return null;
      return issue(
        'ai-crawlers.duplicate-groups',
        `${plural(dups.length, 'AI bot')} ${vb(dups.length, 'appears', 'appear')} in more than one group.`,
        {
          evidence: ev(
            dups.map(([k, lines]) => `${botByToken(k)?.token ?? k}: lines ${lines.join(', ')}`),
          ),
        },
      );
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.misspelt-tokens',
      title: 'robots.txt names an AI bot with a misspelt token',
      why: 'A group for "GPT-Bot" or "Claude Bot" matches nothing, so the bot falls through to User-agent: * and the rule you wrote has no effect.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Use the exact product tokens the operators publish (for example GPTBot, ClaudeBot, PerplexityBot, Google-Extended).',
      refs: [REF.openai, REF.anthropic],
      tags: ['robots'],
    }),
    (site) => {
      if (!robotsUsable(site)) return null;
      const known = AI_BOTS.map((b) => b.token);
      const hits: string[] = [];
      for (const g of robotsParsed(site).groups)
        g.agents.forEach((a, i) => {
          if (a === '*' || botByToken(a)) return;
          const norm = a.toLowerCase().replace(/[\s_-]/g, '');
          const match = known.find((t) => {
            const tn = t.toLowerCase().replace(/[\s_-]/g, '');
            return tn === norm || (norm.length >= 5 && levenshtein(norm, tn) <= 2);
          });
          if (match) hits.push(`line ${g.agentLines[i]}: "${a}" — did you mean ${match}?`);
        });
      return hits.length
        ? issue(
            'ai-crawlers.misspelt-tokens',
            `Possible misspelt AI bot tokens in robots.txt: ${hits.length}.`,
            { evidence: ev(hits) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.legacy-tokens-only',
      title: 'Anthropic blocked only through retired tokens',
      why: 'anthropic-ai and Claude-Web are retired. A block on them alone does not stop ClaudeBot, so the policy you intended is not in force.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'If you mean to block Anthropic training, add "User-agent: ClaudeBot" with "Disallow: /". If not, remove the legacy groups to avoid confusion.',
      refs: [REF.anthropic],
      tags: ['robots', 'anthropic'],
    }),
    (site) => {
      const blocks = rootBlocks(site);
      const legacy = blocks.filter(
        (b) => ['anthropic-ai', 'Claude-Web'].includes(b.bot.token) && !b.inherited,
      );
      if (!legacy.length || blocks.some((b) => b.bot.token === 'ClaudeBot')) return null;
      return issue(
        'ai-crawlers.legacy-tokens-only',
        'robots.txt blocks retired Anthropic tokens but leaves ClaudeBot allowed.',
        { evidence: ev(legacy.map(fmt)) },
      );
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.extended-optout-scope',
      title: 'Google-Extended or Applebot-Extended opt-out: know what it does not cover',
      why: 'Google-Extended controls Gemini training and grounding only; pages still appear in AI Overviews and AI Mode through Googlebot. Applebot-Extended likewise leaves Applebot search crawling in place. Owners often expect more from these switches.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'No change is needed if training opt-out is what you want. To appear less in Google’s AI features, use nosnippet or max-snippet on specific pages, accepting it also affects normal results.',
      refs: [REF.google],
      tags: ['robots', 'google', 'apple'],
    }),
    (site) => {
      const blocks = rootBlocks(site).filter(
        (b) => ['Google-Extended', 'Applebot-Extended'].includes(b.bot.token) && !b.inherited,
      );
      return blocks.length
        ? issue(
            'ai-crawlers.extended-optout-scope',
            `robots.txt opts out via ${blocks.map((b) => b.bot.token).join(' and ')}; search crawling and AI Overviews are unaffected.`,
            { evidence: ev(blocks.map(fmt)) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.backwards-policy',
      title: 'Training allowed but search blocked for the same AI company',
      why: 'This combination gives the company your content to train on while stopping its assistant from citing or linking to you. Most owners want the opposite.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Allow the search bot (OAI-SearchBot, Claude-SearchBot, PerplexityBot). If you object to training, block the training bot instead.',
      refs: [REF.openai, REF.anthropic],
      tags: ['robots'],
    }),
    (site) => {
      if (!robotsUsable(site)) return null;
      const blocked = new Set(rootBlocks(site).map((b) => b.bot.token));
      const pairs: [string, string][] = [
        ['GPTBot', 'OAI-SearchBot'],
        ['ClaudeBot', 'Claude-SearchBot'],
        ['Applebot-Extended', 'Applebot'],
      ];
      const hits = pairs.filter(([train, search]) => !blocked.has(train) && blocked.has(search));
      return hits.length
        ? issue(
            'ai-crawlers.backwards-policy',
            `Training allowed but search blocked: ${hits.map(([t, s]) => `${t} allowed, ${s} blocked`).join('; ')}.`,
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.user-fetcher-robots-ineffective',
      title: 'robots.txt rules aimed at fetchers that do not apply them',
      why: 'Some operators say their user-triggered fetchers act on a person’s behalf and generally ignore robots.txt (for example Perplexity-User and Google’s user-triggered fetchers). A Disallow for them gives a false sense of control.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'If you really need to stop these requests, use a firewall rule on the user agent (verified by the operator’s published IP ranges). Otherwise remove the rule.',
      refs: [
        REF.perplexity,
        'https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers',
      ],
      tags: ['robots'],
    }),
    (site) => {
      const blocks = rootBlocks(site).filter((b) => b.bot.honoursRobots === false && !b.inherited);
      return blocks.length
        ? issue(
            'ai-crawlers.user-fetcher-robots-ineffective',
            `robots.txt disallows ${blocks.map((b) => b.bot.token).join(', ')}, which operators say do not generally follow robots.txt.`,
            { evidence: ev(blocks.map(fmt)) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.robots-server-error',
      title: 'robots.txt returns a server error',
      why: 'Under RFC 9309, when robots.txt fails with a 5xx crawlers must treat the whole site as disallowed. Google and AI crawlers stop fetching until it recovers.',
      severity: 'critical',
      fixTier: 'guided',
      fix: 'Make /robots.txt return 200 with your rules (or 404 if you have none). Check the server, CDN and any security rule that serves an error to bots.',
      refs: [REF.rfc],
      tags: ['robots'],
    }),
    (site) => {
      const s = site.robots?.status;
      return s && s >= 500
        ? issue('ai-crawlers.robots-server-error', `/robots.txt returned ${s}.`, {
            evidence: site.robots.url,
          })
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.robots-missing',
      title: 'No robots.txt',
      why: 'Without robots.txt every crawler is allowed, which is fine for access. But you lose the one place to point crawlers at your sitemap and state AI preferences.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add /robots.txt with at least a Sitemap: line, and any AI-specific groups you want.',
      refs: [REF.rfc],
      tags: ['robots'],
    }),
    (site) => {
      const r = site.robots;
      if (!r || r.found || (r.status !== null && r.status >= 500) || r.error) return null;
      return issue(
        'ai-crawlers.robots-missing',
        `/robots.txt was not found (status ${r.status ?? 'none'}).`,
      );
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.robots-not-text',
      title: 'robots.txt is served as an HTML page',
      why: 'A robots.txt URL that returns an HTML page (often a soft 404) is not a valid robots file; crawlers ignore it, along with any rules and sitemap you meant to declare.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Serve a plain-text robots.txt at the site root with Content-Type: text/plain.',
      refs: [REF.rfc],
      tags: ['robots'],
    }),
    (site) => {
      const r = site.robots;
      if (!r?.body || !r.status || r.status >= 300) return null;
      return /^\s*<(!doctype|html|head|body)\b/i.test(r.body)
        ? issue(
            'ai-crawlers.robots-not-text',
            '/robots.txt returns HTML rather than robots rules.',
            { evidence: r.body.slice(0, 200) },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.robots-too-large',
      title: 'robots.txt is larger than crawlers read',
      why: 'Google reads only the first 500 KiB of robots.txt; rules after that are ignored, and other crawlers have similar limits.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Shorten robots.txt: group paths with wildcards and drop rules for URLs that no longer exist.',
      refs: [REF.rfc],
      tags: ['robots'],
    }),
    (site) => {
      const bytes = robotsParsed(site).bytes;
      return bytes > 500 * 1024
        ? issue('ai-crawlers.robots-too-large', `robots.txt is ${Math.round(bytes / 1024)} KiB.`)
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.sitemap-not-in-robots',
      title: 'robots.txt does not list a sitemap',
      why: 'Crawlers that do not know your site well, which includes most AI crawlers, find the sitemap through the Sitemap: line in robots.txt.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add a line such as "Sitemap: https://example.com/sitemap.xml" to robots.txt.',
      refs: [REF.rfc],
      tags: ['robots', 'sitemaps'],
    }),
    (site) =>
      robotsUsable(site) && !robotsParsed(site).sitemaps.length
        ? issue('ai-crawlers.sitemap-not-in-robots', 'robots.txt has no Sitemap: line.')
        : null,
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.sitemap-not-found',
      title: 'No XML sitemap could be found',
      why: 'A sitemap is how crawlers discover pages your navigation does not link prominently, and how they learn which pages changed. AI crawlers visit less often than Googlebot and lean on it more.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Publish /sitemap.xml listing your indexable pages with lastmod dates, and reference it from robots.txt.',
      refs: ['https://www.sitemaps.org/protocol.html'],
      tags: ['sitemaps'],
    }),
    (site) =>
      site.sitemaps && !site.sitemaps.some((s) => s.found)
        ? issue(
            'ai-crawlers.sitemap-not-found',
            'No sitemap was found via robots.txt or the default locations.',
          )
        : null,
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.crawl-delay-high',
      title: 'Crawl-delay slows AI crawlers to a trickle',
      why: 'A large Crawl-delay limits how many pages a crawler that honours it can fetch per day. At 10 seconds or more, a site of a few thousand pages takes days to refresh.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove Crawl-delay or lower it to a few seconds; manage load with caching or rate limits instead.',
      refs: [REF.rfc],
      tags: ['robots'],
    }),
    (site) => {
      if (!robotsUsable(site)) return null;
      const parsed = robotsParsed(site);
      const hits: string[] = [];
      for (const bot of AI_BOTS.filter((b) => b.important && b.robotsToken !== false)) {
        const { groups } = groupsFor(parsed, bot.token);
        const cd = groups.map((g) => g.crawlDelay).find(Boolean);
        if (cd && cd.value >= 10)
          hits.push(`${bot.token}: Crawl-delay ${cd.value} (line ${cd.line})`);
      }
      return hits.length
        ? issue(
            'ai-crawlers.crawl-delay-high',
            `${plural(hits.length, 'AI bot')} ${vb(hits.length, 'faces', 'face')} a crawl delay of 10 seconds or more.`,
            { evidence: ev(hits) },
          )
        : null;
    },
  ),

  // --- Live fetch: home page ------------------------------------------------

  siteCheck(
    def({
      id: 'ai-crawlers.firewall-challenge',
      title: 'Firewall or CDN challenges AI bots',
      why: 'A bot shown a JavaScript challenge or captcha cannot pass it, so it gets nothing however open robots.txt is. This is the most common hidden reason a site is never cited.',
      severity: 'critical',
      fixTier: 'guided',
      fix: 'In your CDN or firewall (Cloudflare, Vercel, Akamai…), allow verified AI search and user bots. On Cloudflare, check Security → Bots and AI Crawl Control; on Vercel, the Firewall bot rules.',
      refs: ['https://developers.cloudflare.com/bots/', REF.openai],
      tags: ['firewall', 'live'],
    }),
    (site) => {
      const rows = liveRows(site).filter((r) => r.challenge && r.verdict === 'blocked');
      if (!rows.length) return null;
      const important = rows.filter(
        (r) => botByToken(r.token)?.important && r.purpose !== 'training',
      );
      return issue(
        'ai-crawlers.firewall-challenge',
        `${plural(rows.length, 'AI bot')} received a ${rows[0]!.challenge} challenge instead of the home page.`,
        {
          severity: important.length ? 'critical' : 'high',
          evidence: ev(rows.map((r) => `${r.token}: HTTP ${r.status}, ${r.challenge}`)),
          data: { bots: rows.map((r) => r.token) },
        },
      );
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.live-blocked',
      title: 'AI bots refused by the server',
      why: 'The server answered these bots with an error or dropped the connection while a browser got the page. Something other than robots.txt — a WAF rule, hosting bot filter or plugin — is blocking them.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Find the rule that matches these user agents (CDN firewall, hosting security, a WordPress security plugin) and allow the bots you want, verified by IP where the operator publishes ranges.',
      refs: [REF.openai, REF.perplexity],
      tags: ['firewall', 'live'],
    }),
    (site) => {
      const rows = liveRows(site).filter(
        (r) => (r.verdict === 'blocked' && !r.challenge) || r.verdict === 'error',
      );
      if (!rows.length) return null;
      const robotsAllows = rows.filter((r) => {
        try {
          return site.robots?.isAllowed(rootUrl(site), r.token) !== false;
        } catch {
          return true;
        }
      });
      const searchOrUser = rows.filter((r) => r.purpose !== 'training');
      return issue(
        'ai-crawlers.live-blocked',
        `${plural(rows.length, 'AI bot')} ${vb(rows.length, 'was', 'were')} refused while a browser received the page${robotsAllows.length ? `; robots.txt allows ${robotsAllows.length} of them` : ''}.`,
        {
          severity: searchOrUser.length ? 'high' : 'medium',
          evidence: ev(rows.map((r) => `${r.token}: ${r.error ? r.error : `HTTP ${r.status}`}`)),
          data: { bots: rows.map((r) => ({ token: r.token, status: r.status, error: r.error })) },
        },
      );
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.live-differs',
      title: 'AI bots receive less content than a browser',
      why: 'When a bot is redirected elsewhere or given a much thinner page than visitors, the assistant answers from that thinner version, or not at all.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Serve bots the same HTML as browsers. Look for bot-specific rules in the CDN, a prerender service with a stale cache, or a consent wall shown to unknown user agents.',
      refs: ['https://developers.google.com/search/docs/essentials/spam-policies#cloaking'],
      tags: ['live'],
    }),
    (site) => {
      const rows = liveRows(site).filter((r) => r.verdict === 'differs');
      if (!rows.length) return null;
      const bWords = site.browserFetch ? countWords(roughText(site.browserFetch.body || '')) : 0;
      return issue(
        'ai-crawlers.live-differs',
        `${plural(rows.length, 'AI bot')} got a different or thinner page than a browser (${bWords} words).`,
        {
          evidence: ev(rows.map((r) => `${r.token}: HTTP ${r.status}, ${r.words} words`)),
        },
      );
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.live-inconclusive',
      title: 'Live bot test inconclusive: the browser request was blocked too',
      why: 'The audit’s own browser-like request was challenged or refused, so bot access cannot be compared. Often this means the firewall blocks unfamiliar traffic generally.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Run the audit from a network your firewall trusts, or allow the audit’s IP temporarily, then re-run.',
      tags: ['live'],
    }),
    (site) => {
      const rows = liveRows(site);
      if (!rows.length || !rows.every((r) => r.verdict === 'inconclusive' || r.verdict === 'ok'))
        return null;
      const n = rows.filter((r) => r.verdict === 'inconclusive').length;
      return n
        ? issue(
            'ai-crawlers.live-inconclusive',
            `The browser baseline returned HTTP ${site.browserFetch?.status ?? 0}; ${plural(n, 'bot result')} could not be judged.`,
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.slow-for-bots',
      title: 'AI bots are served much more slowly than a browser',
      why: 'Some bot-management products slow suspected bots down rather than block them. Crawlers with tight time budgets give up, and user-triggered fetchers time out while a person waits.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Check for tarpit or rate-limit rules matching AI user agents, and make sure bots are served from cache.',
      tags: ['live', 'performance'],
    }),
    (site) => {
      const browserMs = site.browserFetch?.totalMs ?? 0;
      if (!browserMs) return null;
      const slow = liveRows(site).filter(
        (r) => r.verdict === 'ok' && r.ms > 4000 && r.ms > browserMs * 3,
      );
      return slow.length >= 2
        ? issue(
            'ai-crawlers.slow-for-bots',
            `${plural(slow.length, 'AI bot')} took over three times as long as the browser (${browserMs} ms).`,
            {
              evidence: ev(slow.map((r) => `${r.token}: ${r.ms} ms`)),
            },
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.bot-missing-schema',
      title: 'AI bots receive the page without its structured data',
      why: 'If JSON-LD is injected only for browsers (by a tag manager or client script), crawlers that do not run JavaScript never see it.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Render JSON-LD into the server HTML rather than through a tag manager or client-side script.',
      refs: [
        'https://developers.google.com/search/docs/appearance/structured-data/generate-structured-data-with-javascript',
      ],
      tags: ['live', 'schema'],
    }),
    (site) => {
      const browser = site.browserFetch;
      const bot = botFetchDetail(site, 'OAI-SearchBot') ?? botFetchDetail(site, 'GPTBot');
      if (!browser?.body || !bot?.body || bot.status !== 200) return null;
      const a = schemaCount(browser.body);
      const b = schemaCount(bot.body);
      return a > 0 && b < a
        ? issue(
            'ai-crawlers.bot-missing-schema',
            `The browser HTML has ${plural(a, 'JSON-LD block')}; the AI bot’s copy has ${b}.`,
          )
        : null;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.bot-title-differs',
      title: 'AI bots see a different page title',
      why: 'A different title for bots usually means they are being served a block page, a stale prerender or a different language variant, so the assistant describes the wrong page.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Compare the HTML your CDN serves to the bot user agent with what browsers get, and remove the bot-specific variant.',
      tags: ['live'],
    }),
    (site) => {
      const browser = site.browserFetch;
      if (!browser?.body || browser.status !== 200) return null;
      const bt = titleOf(browser.body);
      const hits: string[] = [];
      for (const r of liveRows(site)) {
        if (r.verdict !== 'ok' && r.verdict !== 'differs') continue;
        const d = botFetchDetail(site, r.token);
        if (!d?.body || d.status !== 200) continue;
        const t = titleOf(d.body);
        if (bt && t !== null && t !== bt) hits.push(`${r.token}: "${t}"`);
      }
      return hits.length
        ? issue(
            'ai-crawlers.bot-title-differs',
            `${plural(hits.length, 'AI bot')} saw a different <title> than the browser ("${bt}").`,
            { evidence: ev(hits) },
          )
        : null;
    },
  ),

  // --- Live fetch: key-page sample ------------------------------------------

  siteCheck(
    def({
      id: 'ai-crawlers.sample-pages-blocked',
      title: 'AI bots blocked on key pages',
      why: 'Firewall rules often apply to paths rather than the whole site, so the home page can pass while articles or product pages are blocked. These are usually the pages an assistant would cite.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Find the path-specific rule (WAF custom rule, paywall, rate limit on /blog/*) and allow verified AI search and user bots through it.',
      tags: ['firewall', 'live'],
    }),
    (site) => {
      const sample = sampleBotFetches(site);
      if (!sample) return null;
      const out: Issue[] = [];
      for (const s of sample) {
        // Only path-specific blocking: bots already blocked on the home page are reported there.
        const homeOk = new Set(
          liveRows(site)
            .filter((r) => r.verdict === 'ok')
            .map((r) => r.token),
        );
        const bad = s.bots.filter(
          (b) =>
            (b.verdict === 'blocked' || b.verdict === 'error') &&
            (homeOk.has(b.token) || !liveRows(site).length),
        );
        if (bad.length)
          out.push(
            issue(
              'ai-crawlers.sample-pages-blocked',
              `${plural(bad.length, 'AI bot')} blocked on this page while a browser got HTTP ${s.browser.status}.`,
              {
                url: s.url,
                evidence: ev(
                  bad.map(
                    (b) =>
                      `${b.token}: ${b.error ?? `HTTP ${b.status}`}${b.challenge ? `, ${b.challenge}` : ''}`,
                  ),
                ),
              },
            ),
          );
      }
      return out;
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.sample-pages-differ',
      title: 'AI bots get thinner key pages than a browser',
      why: 'A metered paywall, consent wall or bot variant can give crawlers a fraction of the page. The assistant then cites, or misquotes, that fraction.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Serve bots the full page HTML. For paywalled content, consider structured paywall markup (isAccessibleForFree) rather than serving bots a stub.',
      refs: [
        'https://developers.google.com/search/docs/appearance/structured-data/paywalled-content',
      ],
      tags: ['live'],
    }),
    (site) => {
      const sample = sampleBotFetches(site);
      if (!sample) return null;
      const out: Issue[] = [];
      for (const s of sample) {
        const homeOk = new Set(
          liveRows(site)
            .filter((r) => r.verdict === 'ok')
            .map((r) => r.token),
        );
        const diff = s.bots.filter(
          (b) => b.verdict === 'differs' && (homeOk.has(b.token) || !liveRows(site).length),
        );
        if (diff.length)
          out.push(
            issue(
              'ai-crawlers.sample-pages-differ',
              `${plural(diff.length, 'AI bot')} received a different or thinner page (browser: ${s.browser.words} words).`,
              {
                url: s.url,
                evidence: ev(diff.map((b) => `${b.token}: HTTP ${b.status}, ${b.words} words`)),
              },
            ),
          );
      }
      return out;
    },
  ),

  // --- Page-level directives ------------------------------------------------

  pageCheck(
    def({
      id: 'ai-crawlers.page-noai',
      title: 'Page carries noai / noimageai',
      why: 'noai and noimageai are non-standard signals some tools honour to exclude content from AI use. If they were added by a plugin default rather than by choice, they work against being cited.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove noai/noimageai from the robots meta tag or X-Robots-Tag unless excluding this page from AI use is intended.',
      refs: [REF.robotsMeta],
      tags: ['meta-robots'],
    }),
    (page) => {
      if (!isIndexable(page)) return null;
      const all = directives(page);
      const found = ['noai', 'noimageai'].filter((d) => hasDirective(all, d));
      return found.length
        ? issue('ai-crawlers.page-noai', `Page opts out of AI use with ${found.join(' and ')}.`, {
            url: page.url,
            evidence: ev(all),
          })
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'ai-crawlers.page-nosnippet',
      title: 'Page forbids snippets (nosnippet or max-snippet:0)',
      why: 'Google treats nosnippet as an opt-out from AI Overviews and AI Mode as well as text snippets; other engines read it the same way. The page can rank but cannot be quoted.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Remove nosnippet / max-snippet:0 unless it is deliberate. To protect one passage, wrap only that passage in data-nosnippet.',
      refs: [REF.robotsMeta],
      tags: ['meta-robots', 'aeo'],
    }),
    (page) => {
      if (!isIndexable(page)) return null;
      const all = directives(page);
      const ms = all.match(/max-snippet\s*:\s*(-?\d+)/);
      if (hasDirective(all, 'nosnippet') || (ms && Number(ms[1]) === 0))
        return issue(
          'ai-crawlers.page-nosnippet',
          'Page forbids text snippets, which also keeps it out of AI answers.',
          { url: page.url, evidence: ev(all) },
        );
      return null;
    },
  ),

  pageCheck(
    def({
      id: 'ai-crawlers.page-max-snippet-low',
      title: 'max-snippet is too short to quote an answer',
      why: 'A max-snippet limit under about 50 characters is shorter than a single answer sentence, so engines that honour it can barely quote the page.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove max-snippet or set it to -1 (no limit), or at least 160.',
      refs: [REF.robotsMeta],
      tags: ['meta-robots', 'aeo'],
    }),
    (page) => {
      if (!isIndexable(page)) return null;
      const m = directives(page).match(/max-snippet\s*:\s*(\d+)/);
      const n = m ? Number(m[1]) : -1;
      return n > 0 && n < 50
        ? issue('ai-crawlers.page-max-snippet-low', `max-snippet is ${n} characters.`, {
            url: page.url,
          })
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'ai-crawlers.bot-specific-meta',
      title: 'Robots meta tag aimed at a specific AI bot',
      why: 'A <meta name="GPTBot" content="noindex"> style tag applies to that one crawler only. Such tags are often left over from experiments and quietly remove the page from one assistant.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove the bot-specific meta tag unless the exclusion is intended.',
      refs: [REF.robotsMeta],
      tags: ['meta-robots'],
    }),
    (page) => {
      const hits = Object.entries(page.botMeta ?? {}).filter(([name, v]) => {
        const bot = botByToken(name);
        return bot && bot.token !== 'Googlebot' && /noindex|none|nosnippet|noai|nofollow/i.test(v);
      });
      return hits.length
        ? issue(
            'ai-crawlers.bot-specific-meta',
            `Page has robots directives for ${hits.map(([n]) => n).join(', ')}.`,
            {
              url: page.url,
              evidence: ev(hits.map(([n, v]) => `<meta name="${n}" content="${v}">`)),
            },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'ai-crawlers.x-robots-tag-bot',
      title: 'X-Robots-Tag header restricts an AI bot',
      why: 'An X-Robots-Tag header such as "GPTBot: noindex" or "noai" is invisible in the page source, so it is easy to forget it is there. It is often set site-wide by a CDN or server rule.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove the header rule in your server, CDN or hosting config unless the restriction is intended.',
      refs: [REF.robotsMeta],
      tags: ['headers'],
    }),
    (page) => {
      const h = page.xRobotsTag;
      if (!h) return null;
      const parts = h.split(/,(?=\s*[A-Za-z-]+\s*:)/);
      const hits = parts.filter((p) => {
        const m = p.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/);
        if (m && botByToken(m[1]!) && m[1]!.toLowerCase() !== 'googlebot')
          return /noindex|none|nosnippet|noai/i.test(m[2]!);
        return /\bnoai\b|\bnoimageai\b/i.test(p);
      });
      return hits.length
        ? issue('ai-crawlers.x-robots-tag-bot', 'X-Robots-Tag restricts AI crawlers on this URL.', {
            url: page.url,
            evidence: ev(h),
          })
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'ai-crawlers.data-nosnippet-main',
      title: 'Most of the main content is marked data-nosnippet',
      why: 'Text inside data-nosnippet cannot be shown or quoted by Google, including in AI Overviews. Wrapping the main content in it removes the page from answers.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Apply data-nosnippet only to the specific passages you need to protect, not to the article body.',
      refs: [REF.robotsMeta],
      tags: ['aeo'],
    }),
    (page) => {
      if (!isIndexable(page) || page.wordCount < 150 || !/data-nosnippet/i.test(page.html))
        return null;
      const n = wordsIn(page, '[data-nosnippet]');
      return n > page.wordCount * 0.4
        ? issue(
            'ai-crawlers.data-nosnippet-main',
            `${n} of ${page.wordCount} words are inside data-nosnippet.`,
            { url: page.url },
          )
        : null;
    },
  ),

  // --- What a non-JavaScript crawler gets -----------------------------------

  pageCheck(
    def({
      id: 'ai-crawlers.empty-shell',
      title: 'Page HTML is an empty JavaScript app shell',
      why: 'AI crawlers (GPTBot, ClaudeBot, PerplexityBot and most others) do not run JavaScript. A page whose HTML is an empty root element reads to them as blank.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Render the content on the server: server-side rendering or static generation (Next.js, Nuxt, Astro, SvelteKit), or a prerender step for single-page apps.',
      refs: ['https://vercel.com/blog/the-rise-of-the-ai-crawler'],
      tags: ['js', 'rendering'],
    }),
    (page) => {
      if (!page.isHtml || page.status !== 200 || page.wordCount >= 50) return null;
      const shell =
        /<div[^>]+id=["'](root|app|__next|__nuxt|svelte|main-app|q-app)["'][^>]*>\s*<\/div>/i.test(
          page.html,
        );
      const noscript = /<noscript[^>]*>[^<]*(enable|turn on) javascript/i.test(page.html);
      if (!shell && !noscript) return null;
      const rendered = page.rendered?.wordCount;
      return issue(
        'ai-crawlers.empty-shell',
        `The HTML has ${page.wordCount} words of text${rendered ? `; after JavaScript runs it has ${rendered}` : ''}.`,
        {
          url: page.url,
          severity: isIndexable(page) ? 'high' : 'medium',
        },
      );
    },
  ),

  pageCheck(
    def({
      id: 'ai-crawlers.js-gap',
      title: 'Much of the content appears only after JavaScript runs',
      why: 'Text that exists only in the rendered page is invisible to AI crawlers, which read the raw HTML. They see a partial page and cite it accordingly, or skip it.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Move the missing content into the server-rendered HTML (render it on the server or at build time instead of fetching it in the browser).',
      requires: ['render'],
      tags: ['js', 'rendering'],
    }),
    (page) => {
      const r = page.rendered;
      if (!r || r.wordCount < 100 || !isIndexable(page)) return null;
      const ratio = page.wordCount / r.wordCount;
      return ratio < 0.5
        ? issue(
            'ai-crawlers.js-gap',
            `Raw HTML has ${page.wordCount} words; the rendered page has ${r.wordCount} (${Math.round(ratio * 100)}%).`,
            {
              url: page.url,
              severity: ratio < 0.2 ? 'critical' : undefined,
              data: { raw: page.wordCount, rendered: r.wordCount },
            },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'ai-crawlers.rendered-headings-missing',
      title: 'Headings exist only after JavaScript runs',
      why: 'Headings tell an engine how the page is divided. If they are added client-side, a crawler reading raw HTML sees one undivided block.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Render the headings in the server HTML.',
      requires: ['render'],
      tags: ['js', 'rendering'],
    }),
    (page) => {
      const r = page.rendered;
      if (!r || !isIndexable(page)) return null;
      const raw = new Set((page.headings ?? []).map((h) => h.text.trim().toLowerCase()));
      const missing = r.headings.filter(
        (h) => h.level <= 3 && !raw.has(h.text.trim().toLowerCase()),
      );
      return missing.length >= 2
        ? issue(
            'ai-crawlers.rendered-headings-missing',
            `${plural(missing.length, 'heading')} ${vb(missing.length, 'appears', 'appear')} only in the rendered page.`,
            {
              url: page.url,
              evidence: ev(missing.slice(0, 8).map((h) => `H${h.level}: ${h.text}`)),
            },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'ai-crawlers.hidden-content',
      title: 'Much of the content is hidden in tabs or collapsed panels',
      why: 'Text in hidden tabs is in the HTML, so most crawlers still read it. But extractors that drop hidden elements, and pipelines that read the rendered text, can miss it, and engines may weight it less.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Keep the answer to the page’s main question visible by default. Use <details>/<summary> rather than hidden attributes for secondary content.',
      tags: ['content'],
    }),
    (page) => {
      if (!isIndexable(page) || page.wordCount < 200) return null;
      if (!/\shidden(\s|>|=)|aria-hidden=["']true|display\s*:\s*none/i.test(page.html)) return null;
      const n = wordsIn(
        page,
        'main [hidden], main [aria-hidden="true"], main [style*="display:none"], main [style*="display: none"], article [hidden], [role="tabpanel"][hidden]',
      );
      return n >= 150 && n > page.wordCount * 0.3
        ? issue(
            'ai-crawlers.hidden-content',
            `${n} of ${page.wordCount} words are in hidden elements.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    def({
      id: 'ai-crawlers.iframe-content',
      title: 'Main content is loaded in an iframe',
      why: 'Content inside an iframe belongs to the framed URL, not this page. Crawlers attribute it elsewhere or skip it, so this page looks empty.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Put the content directly in the page HTML; keep iframes for embeds such as maps and video.',
      tags: ['content'],
    }),
    (page) => {
      if (!isIndexable(page) || page.wordCount >= 150 || !page.iframes?.length) return null;
      const content = page.iframes.filter(
        (u) =>
          !/youtube|vimeo|maps\.google|google\.com\/maps|player\.|recaptcha|googletagmanager|doubleclick|facebook\.com\/plugins|calendly/i.test(
            u,
          ),
      );
      return content.length
        ? issue(
            'ai-crawlers.iframe-content',
            `Page has ${page.wordCount} words of its own and ${plural(content.length, 'content iframe')}.`,
            { url: page.url, evidence: ev(content.slice(0, 5)) },
          )
        : null;
    },
  ),

  // --- Index presence --------------------------------------------------------

  siteCheck(
    def({
      id: 'ai-crawlers.common-crawl',
      title: 'Site not found in the latest Common Crawl',
      why: 'Common Crawl is the open web archive most AI training datasets start from. Absence is a strong hint models know little about you from training. Presence is not proof any model trained on you.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Allow CCBot in robots.txt and make sure your firewall does not block it; the next monthly crawl can then include you.',
      refs: [REF.cc],
      tags: ['training'],
    }),
    async (site) => {
      // Network failures (offline, sandbox, index overloaded) produce no finding.
      try {
        const info = await site.fetcher.fetch('https://index.commoncrawl.org/collinfo.json', {
          timeoutMs: 10_000,
          maxBytes: 200_000,
        });
        if (info.status !== 200) return null;
        const list = JSON.parse(info.body) as { id: string; 'cdx-api': string }[];
        const latest = list.find((c) => c.id.startsWith('CC-MAIN-'));
        if (!latest) return null;
        const host = site.host.replace(/^www\./, '');
        const q = new URLSearchParams({ url: `${host}/*`, output: 'json', fl: 'url', limit: '5' });
        const res = await site.fetcher.fetch(`${latest['cdx-api']}?${q}`, {
          timeoutMs: 20_000,
          maxBytes: 100_000,
        });
        if (res.status === 404 || (res.status === 200 && !res.body.trim()))
          return issue('ai-crawlers.common-crawl', `No captures of ${host} in ${latest.id}.`, {
            data: { collection: latest.id },
          });
        return null;
      } catch {
        return null;
      }
    },
  ),

  siteCheck(
    def({
      id: 'ai-crawlers.bing-webmaster',
      title: 'No sign the site is verified in Bing Webmaster Tools',
      why: 'Copilot is grounded in Bing, and Bing’s index is one of the sources other AI search products draw on. Bing Webmaster Tools shows what Bing has indexed and lets you submit URLs through IndexNow.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Verify the site in Bing Webmaster Tools (importing from Google Search Console is quickest), submit the sitemap, and enable IndexNow if your CMS supports it. If you verified by DNS, ignore this.',
      refs: [REF.bing, REF.indexnow],
      tags: ['bing', 'copilot'],
    }),
    (site) => {
      const home = homePage(site);
      if (!home?.html) return null;
      if (/<meta[^>]+name=["']msvalidate\.01["']/i.test(home.html)) return null;
      return issue(
        'ai-crawlers.bing-webmaster',
        'The home page has no msvalidate.01 verification tag.',
      );
    },
  ),
];

/** Exposed for tests and the report. */
export const _internal = { rootBlocks, levenshtein, parseDoc, htmlPages };
