/**
 * The AI crawler and agent reference list.
 *
 * One place for everything the app knows about AI bots: robots.txt checks,
 * the live fetch test, server-log verification (src/connect) and the report
 * all read this array. Adding a bot is one entry here.
 *
 * REVIEW QUARTERLY. Operators rename tokens, split crawlers by purpose and
 * bump user-agent versions without notice.
 * Last reviewed: 2026-10-13, against each operator's published crawler docs.
 *
 * Field notes
 * - `token` is the robots.txt product token (matched case-insensitively).
 * - `ua` is set only for bots that really fetch pages and whose user agent is
 *   published. Robots-only switches (Google-Extended, Applebot-Extended…) have
 *   no request to simulate.
 * - `honoursRobots: false` marks fetchers the operator says act for a person
 *   and generally do not apply robots.txt. Blocking them needs a firewall rule.
 * - `ipRangesUrl` is the operator's published JSON of crawler IP ranges, for
 *   verifying log hits. `rdns` lists reverse-DNS suffixes used for the same.
 */

export type BotPurpose = 'training' | 'search' | 'user';

export interface AiBot {
  token: string;
  operator: string;
  purpose: BotPurpose;
  /** What the token controls, in a site owner's words. */
  role: string;
  /** Full user-agent string for the live fetch test. */
  ua?: string;
  /** Extra substrings that identify this bot in a User-Agent header. */
  uaMatch?: string[];
  /** False when the operator says robots.txt is generally not applied. Default true. */
  honoursRobots?: boolean;
  /** True when the token can be addressed in robots.txt. Default true. */
  robotsToken?: boolean;
  /** Bots worth a dedicated finding when blocked. */
  important?: boolean;
  /** Published IP ranges (JSON) for verifying log hits. */
  ipRangesUrl?: string;
  /** Reverse-DNS host suffixes for verifying log hits. */
  rdns?: string[];
  /** Web Bot Auth Signature-Agent the operator signs with, when it signs. */
  signatureAgent?: string;
  docs?: string;
}

export const BOTS_REVIEWED = '2026-10-13';

const GOOGLE_IPS = 'https://developers.google.com/static/search/apis/ipranges';

export const AI_BOTS: AiBot[] = [
  // --- OpenAI ---------------------------------------------------------------
  {
    token: 'GPTBot',
    operator: 'OpenAI',
    purpose: 'training',
    role: 'Collects content that may be used to train OpenAI models',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.3; +https://openai.com/gptbot)',
    important: true,
    ipRangesUrl: 'https://openai.com/gptbot.json',
    docs: 'https://platform.openai.com/docs/bots',
  },
  {
    token: 'OAI-SearchBot',
    operator: 'OpenAI',
    purpose: 'search',
    role: 'Builds the index behind ChatGPT search answers and citations',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot)',
    important: true,
    ipRangesUrl: 'https://openai.com/searchbot.json',
    docs: 'https://platform.openai.com/docs/bots',
  },
  {
    token: 'ChatGPT-User',
    operator: 'OpenAI',
    purpose: 'user',
    role: 'Opens a page when a ChatGPT user asks about it or a GPT action needs it',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
    important: true,
    ipRangesUrl: 'https://openai.com/chatgpt-user.json',
    docs: 'https://platform.openai.com/docs/bots',
  },
  {
    token: 'ChatGPT agent',
    operator: 'OpenAI',
    purpose: 'user',
    role: 'ChatGPT agent mode browsing on a user’s behalf; identified by signed requests, not a robots token',
    uaMatch: [],
    robotsToken: false,
    honoursRobots: false,
    signatureAgent: 'https://chatgpt.com',
    docs: 'https://help.openai.com/en/articles/11845367-chatgpt-agent-allowlisting',
  },

  // --- Anthropic ------------------------------------------------------------
  {
    token: 'ClaudeBot',
    operator: 'Anthropic',
    purpose: 'training',
    role: 'Collects content that may be used to train Claude models',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    important: true,
    docs: 'https://support.claude.com/en/articles/8896518',
  },
  {
    token: 'Claude-SearchBot',
    operator: 'Anthropic',
    purpose: 'search',
    role: 'Indexes pages so Claude can find and cite them when it searches',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)',
    important: true,
    docs: 'https://support.claude.com/en/articles/8896518',
  },
  {
    token: 'Claude-User',
    operator: 'Anthropic',
    purpose: 'user',
    role: 'Opens a page when a Claude user asks about it',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
    important: true,
    docs: 'https://support.claude.com/en/articles/8896518',
  },
  {
    token: 'anthropic-ai',
    operator: 'Anthropic',
    purpose: 'training',
    role: 'Retired Anthropic token; blocking it alone does not stop ClaudeBot',
  },
  {
    token: 'Claude-Web',
    operator: 'Anthropic',
    purpose: 'training',
    role: 'Retired Anthropic token; blocking it alone does not stop ClaudeBot',
  },

  // --- Google ---------------------------------------------------------------
  {
    token: 'Googlebot',
    operator: 'Google',
    purpose: 'search',
    role: 'Google Search, including AI Overviews and AI Mode',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/141.0.0.0 Safari/537.36',
    important: true,
    ipRangesUrl: `${GOOGLE_IPS}/googlebot.json`,
    rdns: ['googlebot.com', 'google.com'],
    docs: 'https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers',
  },
  {
    token: 'Google-Extended',
    operator: 'Google',
    purpose: 'training',
    role: 'Opt-out switch for Gemini training and grounding; does not affect Google Search or AI Overviews',
    important: true,
    docs: 'https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers#google-extended',
  },
  {
    token: 'Google-CloudVertexBot',
    operator: 'Google',
    purpose: 'user',
    role: 'Fetches pages for agents site owners build on Vertex AI',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Google-CloudVertexBot; +https://cloud.google.com/enterprise-search)',
    ipRangesUrl: `${GOOGLE_IPS}/special-crawlers.json`,
    rdns: ['google.com'],
  },
  {
    token: 'Google-NotebookLM',
    operator: 'Google',
    purpose: 'user',
    role: 'Fetches a page a NotebookLM user adds as a source',
    robotsToken: false,
    honoursRobots: false,
    ipRangesUrl: `${GOOGLE_IPS}/user-triggered-fetchers-google.json`,
    docs: 'https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers',
  },
  {
    token: 'Gemini-Deep-Research',
    operator: 'Google',
    purpose: 'user',
    role: 'Fetches pages for a Gemini Deep Research report a user asked for',
    robotsToken: false,
    honoursRobots: false,
    ipRangesUrl: `${GOOGLE_IPS}/user-triggered-fetchers-google.json`,
    docs: 'https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers',
  },

  // --- Microsoft ------------------------------------------------------------
  {
    token: 'Bingbot',
    operator: 'Microsoft',
    purpose: 'search',
    role: 'Bing Search, which grounds Microsoft Copilot and feeds other AI search products',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/141.0.0.0 Safari/537.36',
    important: true,
    ipRangesUrl: 'https://www.bing.com/toolbox/bingbot.json',
    rdns: ['search.msn.com'],
  },

  // --- Apple ----------------------------------------------------------------
  {
    token: 'Applebot',
    operator: 'Apple',
    purpose: 'search',
    role: 'Siri, Spotlight and Safari suggestions',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
    important: true,
    ipRangesUrl: 'https://search.developer.apple.com/applebot.json',
    rdns: ['applebot.apple.com'],
  },
  {
    token: 'Applebot-Extended',
    operator: 'Apple',
    purpose: 'training',
    role: 'Opt-out switch for Apple Intelligence training; Applebot still crawls for search',
    important: true,
  },

  // --- Perplexity -----------------------------------------------------------
  {
    token: 'PerplexityBot',
    operator: 'Perplexity',
    purpose: 'search',
    role: 'Builds the index behind Perplexity answers and citations',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    important: true,
    ipRangesUrl: 'https://www.perplexity.com/perplexitybot.json',
  },
  {
    token: 'Perplexity-User',
    operator: 'Perplexity',
    purpose: 'user',
    role: 'Opens a page when a Perplexity user asks about it',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
    important: true,
    honoursRobots: false,
    ipRangesUrl: 'https://www.perplexity.com/perplexity-user.json',
  },

  // --- Meta -----------------------------------------------------------------
  {
    token: 'meta-externalagent',
    operator: 'Meta',
    purpose: 'training',
    role: 'Collects content to train Meta AI models and improve its products',
    ua: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
    important: true,
  },
  {
    token: 'meta-externalfetcher',
    operator: 'Meta',
    purpose: 'user',
    role: 'Opens a page when a Meta AI user asks about it',
    ua: 'meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
    honoursRobots: false,
  },

  // --- Amazon ---------------------------------------------------------------
  {
    token: 'Amazonbot',
    operator: 'Amazon',
    purpose: 'search',
    role: 'Alexa and Amazon AI answers',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36',
    important: true,
    rdns: ['crawl.amazonbot.amazon'],
  },
  {
    token: 'Amzn-SearchBot',
    operator: 'Amazon',
    purpose: 'search',
    role: 'Indexes pages for Alexa+ and Rufus search answers',
  },
  {
    token: 'Amzn-User',
    operator: 'Amazon',
    purpose: 'user',
    role: 'Opens a page when an Alexa+ user asks about it',
    honoursRobots: false,
  },

  // --- Others ---------------------------------------------------------------
  {
    token: 'CCBot',
    operator: 'Common Crawl',
    purpose: 'training',
    role: 'Open web archive that many AI training datasets are built from',
    ua: 'CCBot/2.0 (https://commoncrawl.org/faq/)',
    important: true,
  },
  {
    token: 'Bytespider',
    operator: 'ByteDance',
    purpose: 'training',
    role: 'Collects content for ByteDance models',
    ua: 'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
  },
  {
    token: 'DuckAssistBot',
    operator: 'DuckDuckGo',
    purpose: 'search',
    role: 'DuckDuckGo AI-assisted answers',
    ua: 'DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)',
    important: true,
    ipRangesUrl: 'https://duckduckgo.com/duckassistbot.json',
  },
  {
    token: 'MistralAI-User',
    operator: 'Mistral',
    purpose: 'user',
    role: 'Opens a page when a Le Chat user asks about it',
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)',
    important: true,
  },
  {
    token: 'cohere-ai',
    operator: 'Cohere',
    purpose: 'training',
    role: 'Opt-out switch for Cohere training',
  },
  {
    token: 'cohere-training-data-crawler',
    operator: 'Cohere',
    purpose: 'training',
    role: 'Collects content for Cohere training data',
  },
  {
    token: 'YouBot',
    operator: 'You.com',
    purpose: 'search',
    role: 'Indexes pages for You.com AI search',
    ua: 'Mozilla/5.0 (compatible; YouBot/1.0; +https://about.you.com/youbot/)',
  },
  {
    token: 'Diffbot',
    operator: 'Diffbot',
    purpose: 'training',
    role: 'Builds a knowledge graph sold to AI companies',
    ua: 'Mozilla/5.0 (compatible; Diffbot/0.1; +http://www.diffbot.com)',
  },
  {
    token: 'Timpibot',
    operator: 'Timpi',
    purpose: 'training',
    role: 'Builds a web index licensed for AI use',
    ua: 'Timpibot/0.8 (+http://www.timpi.io)',
  },
  {
    token: 'PetalBot',
    operator: 'Huawei',
    purpose: 'search',
    role: 'Petal Search and Huawei assistant answers',
    ua: 'Mozilla/5.0 (compatible;PetalBot;+https://webmaster.petalsearch.com/site/petalbot)',
    rdns: ['petalsearch.com'],
  },
  {
    token: 'PanguBot',
    operator: 'Huawei',
    purpose: 'training',
    role: 'Collects content to train Huawei PanGu models',
  },
  {
    token: 'AI2Bot',
    operator: 'Allen Institute for AI',
    purpose: 'training',
    role: 'Collects content for open research models and datasets',
    ua: 'Mozilla/5.0 (compatible) AI2Bot (+https://www.allenai.org/crawler)',
  },
  {
    token: 'ImagesiftBot',
    operator: 'ImageSift',
    purpose: 'training',
    role: 'Collects images for reverse-image and AI datasets',
    ua: 'ImagesiftBot (+imagesift.com)',
  },
  {
    token: 'Omgilibot',
    operator: 'Webz.io',
    purpose: 'training',
    role: 'Collects content Webz.io resells, including for AI training',
  },
  {
    token: 'webzio-extended',
    operator: 'Webz.io',
    purpose: 'training',
    role: 'Opt-out switch for Webz.io AI-training data',
  },
  {
    token: 'YandexAdditional',
    operator: 'Yandex',
    purpose: 'search',
    role: 'Controls use of content in Yandex AI answers (Neuro)',
  },
];

/** The ordinary-visitor baseline every bot fetch is compared against. */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export const PURPOSE_COPY: Record<
  BotPurpose,
  { label: string; blockedMeans: string; allowedMeans: string }
> = {
  training: {
    label: 'Training',
    blockedMeans:
      'Your pages stay out of future model training. Live answers that search the web are not affected, but models will know less about you when they answer from memory. Blocking this is a legitimate choice.',
    allowedMeans:
      'Your content can be included in future model training, which is how a model comes to know your brand without looking it up.',
  },
  search: {
    label: 'Search',
    blockedMeans:
      'You drop out of the index the assistant searches when it answers. This group decides whether you can be cited at all.',
    allowedMeans: 'Your pages can be indexed and cited when the assistant answers with search.',
  },
  user: {
    label: 'User-triggered',
    blockedMeans:
      'When someone pastes your link into an assistant, or it opens your page to answer them, the request fails and the assistant answers without you.',
    allowedMeans: 'Assistants can open your page when a user asks about it or pastes the link.',
  },
};

/** Relative weight of each purpose when grading access. */
export const PURPOSE_WEIGHT: Record<BotPurpose, number> = { search: 3, user: 2, training: 1 };

/** Bots that make requests we can simulate. */
export function fetchingBots(): AiBot[] {
  return AI_BOTS.filter((b) => b.ua);
}

/** Bots addressable in robots.txt. */
export function robotsBots(): AiBot[] {
  return AI_BOTS.filter((b) => b.robotsToken !== false);
}

export function botByToken(token: string): AiBot | undefined {
  const t = token.toLowerCase();
  return AI_BOTS.find((b) => b.token.toLowerCase() === t);
}

// Longest token first, so 'Claude-SearchBot' is tried before shorter tokens.
const MATCHERS = AI_BOTS.flatMap((bot) =>
  [bot.token, ...(bot.uaMatch ?? [])]
    .filter(Boolean)
    .map((s) => ({ needle: s.toLowerCase(), bot })),
).sort((a, b) => b.needle.length - a.needle.length);

/**
 * Identify an AI bot from a User-Agent header. Matches the product token as a
 * case-insensitive substring; returns undefined for browsers and unknown bots.
 * A match says who the request claims to be — verify by IP or rDNS for trust.
 */
export function botByUserAgent(ua: string | null | undefined): AiBot | undefined {
  if (!ua) return undefined;
  const s = ua.toLowerCase();
  for (const m of MATCHERS) {
    const i = s.indexOf(m.needle);
    if (i === -1) continue;
    // Require a token boundary so 'gptbot' does not match inside other words.
    const before = i === 0 ? '' : s[i - 1];
    const after = s[i + m.needle.length] ?? '';
    if (before && /[a-z0-9]/.test(before)) continue;
    if (after && /[a-z0-9]/.test(after)) continue;
    return m.bot;
  }
  return undefined;
}
