/**
 * The shared contract. Every module (crawler, checks, AI engine, fixes,
 * connectors, monitor, reports, dashboard, MCP) builds against these types.
 * Types only — safe to import anywhere. Change with care: other modules rely
 * on every field here.
 */

// ---------------------------------------------------------------------------
// Severity, categories, pillars
// ---------------------------------------------------------------------------

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** The five pillars of the AI Visibility Score (0–100). */
export type Pillar =
  | 'technical' // classic technical SEO: crawl, index, redirects, canonicals, links, sitemaps, perf, security
  | 'content' // on-page + content quality: titles, meta, headings, duplicates, thin pages, images, a11y
  | 'ai-access' // can AI crawlers reach and read the site: robots per bot, live fetch, JS gap, llms.txt
  | 'geo' // AEO/GEO readiness: answerability, entities, schema for AI, citations, freshness
  | 'agentic' // agentic web: MCP, A2A, WebMCP, OAuth discovery, markdown negotiation, commerce rails
  | 'ai-visibility'; // outcome: do ChatGPT/Claude/Gemini/Perplexity actually name and cite you

export type CategoryId =
  | 'crawlability'
  | 'robots'
  | 'response'
  | 'redirects'
  | 'canonical'
  | 'onpage'
  | 'headings'
  | 'content'
  | 'duplicates'
  | 'links-internal'
  | 'links-external'
  | 'images'
  | 'schema'
  | 'hreflang'
  | 'mobile'
  | 'performance'
  | 'security'
  | 'urls'
  | 'sitemaps'
  | 'pagination'
  | 'accessibility'
  | 'js-rendering'
  | 'analytics'
  | 'cms'
  | 'ai-crawlers'
  | 'llms-txt'
  | 'geo-content'
  | 'geo-entity'
  | 'agentic'
  | 'agentic-commerce'
  | 'ai-visibility';

/** Which optional data a check needs. A check whose requirement is missing is skipped, not failed. */
export type Requirement =
  | 'render' // headless Chromium (local Chrome via playwright-core)
  | 'psi' // PageSpeed Insights API (CrUX field data + Lighthouse lab)
  | 'gsc' // Google Search Console connection
  | 'ga4' // Google Analytics 4 connection
  | 'logs' // server access logs
  | 'llm' // AI engine API keys
  | 'repo'; // local source code of the site

export type Scope = 'page' | 'site';

export type FixTier =
  | 'auto' // the app can apply it (WordPress connector, or a patch to a local repo)
  | 'guided' // exact copy-paste fix with the file to change, per detected stack
  | 'manual'; // needs a human decision (content, strategy)

export interface CheckDef {
  /** Stable id, kebab-case, prefixed by category: e.g. `onpage.title-missing`. Never reuse or rename. */
  id: string;
  category: CategoryId;
  pillar: Pillar;
  title: string;
  /** One or two plain sentences: why this matters for Google and/or AI engines. */
  why: string;
  severity: Severity;
  scope: Scope;
  fixTier: FixTier;
  /** Default fix text (stack-neutral). The fixes module adds stack-specific detail. */
  fix: string;
  requires?: Requirement[];
  /** Links to authoritative docs (Google, Bing, OpenAI, Anthropic, llmstxt.org, MCP spec…). */
  refs?: string[];
  /** Short tags, e.g. ['aeo'], ['wcag-1.1.1'], ['core-web-vitals']. */
  tags?: string[];
}

export interface Issue {
  checkId: string;
  /** Page URL for page-scope issues. Omitted for site-scope issues. */
  url?: string;
  /** Override of the definition's severity for this instance (e.g. escalate on key pages). */
  severity?: Severity;
  /** Specific to this instance: "Title is 78 characters (limit ~60)". */
  message: string;
  /** The raw thing that triggered it: the tag, header, line, value. Keep under 500 chars. */
  evidence?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fetching and crawled pages
// ---------------------------------------------------------------------------

export interface RedirectHop {
  url: string;
  status: number;
}

export interface FetchResult {
  url: string; // requested
  finalUrl: string;
  status: number; // 0 on network error
  ok: boolean;
  headers: Record<string, string>; // lower-cased names
  redirects: RedirectHop[];
  body: string; // decoded text (truncated at the size limit)
  bytes: number;
  truncated: boolean;
  contentType: string;
  ttfbMs: number;
  totalMs: number;
  error?: string;
}

export interface Fetcher {
  fetch(
    url: string,
    opts?: {
      userAgent?: string;
      headers?: Record<string, string>;
      method?: 'GET' | 'HEAD' | 'POST';
      body?: string;
      followRedirects?: boolean; // default true
      timeoutMs?: number;
      maxBytes?: number;
    },
  ): Promise<FetchResult>;
}

export interface LinkRef {
  href: string; // absolute, fragment stripped
  text: string; // anchor text (or img alt when the link wraps an image)
  rel: string[]; // nofollow, sponsored, ugc, noopener…
  internal: boolean;
  /** Where on the page: nav/header/footer/main/aside — best effort. */
  region?: 'nav' | 'header' | 'footer' | 'main' | 'aside' | 'other';
  target?: string;
}

export interface ImageRef {
  src: string; // absolute
  alt: string | null; // null = attribute missing; '' = decorative
  width?: number;
  height?: number;
  loading?: string;
  srcset?: string;
  bytes?: number; // filled when the crawler HEADs images
  contentType?: string;
}

export interface HeadingRef {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

export interface StructuredDataItem {
  format: 'json-ld' | 'microdata' | 'rdfa';
  types: string[]; // @type values, flattened incl. @graph
  raw: unknown; // parsed JSON for json-ld; best-effort object otherwise
  error?: string; // JSON parse error
}

export interface HreflangRef {
  lang: string;
  href: string;
  source: 'html' | 'header' | 'sitemap';
}

export interface PageData {
  url: string; // the URL as discovered (normalised)
  finalUrl: string;
  depth: number; // clicks from the start URL
  status: number;
  redirects: RedirectHop[];
  headers: Record<string, string>;
  contentType: string;
  isHtml: boolean;
  bytes: number;
  ttfbMs: number;
  totalMs: number;
  error?: string;
  discoveredFrom: string[]; // up to 20 referring URLs
  inSitemap: boolean;
  blockedByRobots: boolean; // for the crawler's own UA / Googlebot

  // ---- HTML-derived (empty/null when not HTML) ----
  html: string; // raw HTML (may be truncated for very large pages)
  lang: string | null;
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  metaRobots: string | null; // combined content of <meta name="robots">
  botMeta: Record<string, string>; // e.g. { googlebot: 'noindex', 'gptbot': '...' }
  xRobotsTag: string | null;
  canonical: string | null; // absolute
  canonicalCount: number;
  canonicalHeader: string | null; // from Link: rel=canonical
  viewport: string | null;
  charset: string | null;
  og: Record<string, string>; // og:title → value
  twitter: Record<string, string>;
  headings: HeadingRef[];
  links: LinkRef[];
  images: ImageRef[];
  scripts: {
    src: string | null;
    inline: boolean;
    async: boolean;
    defer: boolean;
    type: string | null;
    bytes: number;
  }[];
  stylesheets: { href: string; media: string | null }[];
  structuredData: StructuredDataItem[];
  hreflang: HreflangRef[];
  pagination: { next: string | null; prev: string | null };
  favicon: string | null;
  /** Visible main text (boilerplate removed when possible). */
  text: string;
  wordCount: number;
  /** Readability-style extraction of the main article, when it succeeds. */
  mainText: string | null;
  /** First ~300 chars of main content after the H1 — used for answer-first / AEO checks. */
  lead: string;
  contentHash: string; // sha1 of normalised text, for exact duplicates
  simhash: string; // 64-bit hex simhash of text shingles, for near-duplicates
  forms: {
    action: string;
    method: string;
    inputs: number;
    hasLabels: boolean;
    toolname?: string;
  }[];
  iframes: string[];
  mixedContent: string[]; // http:// subresources on an https page
  inlineStyleBytes: number;
  inlineScriptBytes: number;
  /** Detected from markup + headers on this page. */
  generator: string | null;

  // ---- Rendered (only when render is enabled) ----
  rendered?: {
    html: string;
    text: string;
    wordCount: number;
    title: string | null;
    links: number;
    headings: HeadingRef[];
    structuredData: StructuredDataItem[];
    consoleErrors: string[];
    failedRequests: string[];
    timings?: {
      domContentLoaded?: number;
      load?: number;
      lcp?: number;
      cls?: number;
      tbt?: number;
    };
  };
}

// ---------------------------------------------------------------------------
// Site-level context
// ---------------------------------------------------------------------------

export interface RobotsInfo {
  url: string;
  status: number | null;
  found: boolean;
  body: string;
  error?: string;
  sitemaps: string[];
  /** isAllowed(url, userAgentToken) — wraps a robots.txt parser. */
  isAllowed(url: string, ua: string): boolean;
  /** 1-based line that decided the rule for a UA + URL, if any. */
  decidingLine(url: string, ua: string): { line: number; rule: string } | null;
}

export interface SitemapInfo {
  url: string;
  status: number | null;
  found: boolean;
  isIndex: boolean;
  urls: { loc: string; lastmod?: string; images?: number; hreflang?: HreflangRef[] }[];
  children: string[]; // for sitemap indexes
  errors: string[];
  bytes: number;
  gzip: boolean;
  source: 'robots' | 'default' | 'child' | 'user';
}

export type StackId =
  | 'nextjs'
  | 'nuxt'
  | 'gatsby'
  | 'astro'
  | 'sveltekit'
  | 'remix'
  | 'angular'
  | 'react-spa'
  | 'vue-spa'
  | 'wordpress'
  | 'shopify'
  | 'webflow'
  | 'wix'
  | 'squarespace'
  | 'ghost'
  | 'drupal'
  | 'joomla'
  | 'hubspot'
  | 'framer'
  | 'hugo'
  | 'jekyll'
  | 'static'
  | 'unknown';

export interface StackInfo {
  id: StackId;
  confidence: number; // 0–1
  signals: string[];
  /** Hosting/CDN when detectable: vercel, netlify, cloudflare, aws, fastly… */
  host?: string;
  cdn?: string;
  /** e.g. 'yoast', 'rank-math', 'next-seo' */
  seoPlugin?: string;
  version?: string;
}

/** One request made by the agentic-web probe (src/agentic/probe.ts). */
export interface ProbeResult {
  id: string; // e.g. 'mcp-server-card', 'a2a-agent-card'
  url: string;
  status: number | null;
  found: boolean;
  contentType?: string;
  bytes?: number;
  /** Parsed body when JSON/text is relevant. */
  parsed?: unknown;
  body?: string; // first 20 KB
  error?: string;
  headers?: Record<string, string>;
}

/** Live fetch of the home page as each AI crawler vs a browser. */
export interface BotFetchResult {
  token: string;
  operator: string;
  purpose: 'training' | 'search' | 'user';
  status: number;
  bytes: number;
  words: number;
  challenge: string | null; // 'cloudflare', 'akamai', 'datadome', 'captcha'… when detected
  verdict: 'ok' | 'blocked' | 'differs' | 'inconclusive' | 'error';
  ms: number;
  error?: string;
}

export interface CrawlStats {
  startedAt: string;
  finishedAt: string;
  pagesCrawled: number;
  pagesQueuedNotCrawled: number;
  maxPages: number;
  maxDepth: number;
  rendered: number;
  errors: number;
  durationMs: number;
}

export interface SiteContext {
  startUrl: string;
  origin: string; // https://example.com
  host: string;
  /** All crawled pages keyed by normalised URL (HTML and non-HTML responses). */
  pages: Map<string, PageData>;
  /** Inlinks: target URL → source URLs (internal only). */
  inlinks: Map<string, Set<string>>;
  robots: RobotsInfo;
  sitemaps: SitemapInfo[];
  stack: StackInfo;
  /** Agentic/AI origin probes, keyed by probe id. Filled by src/agentic/probe.ts. */
  probes: Map<string, ProbeResult>;
  /** Live AI-crawler fetches of the start URL. */
  botFetches: BotFetchResult[];
  /** Browser-UA baseline fetch of the start URL. */
  browserFetch: FetchResult | null;
  /** Optional connected data (filled by src/connect/*). */
  external: ExternalData;
  fetcher: Fetcher;
  options: CrawlOptions;
  stats: CrawlStats;
}

export interface ExternalData {
  psi?: Record<string, PsiResult>; // url → result
  gsc?: GscData;
  ga4?: Ga4Data;
  logs?: LogInsights;
  repo?: { path: string; stack: StackId; files: number };
  wordpress?: { url: string; user: string; version?: string; seoPlugin?: string };
}

export interface PsiResult {
  url: string;
  strategy: 'mobile' | 'desktop';
  performanceScore: number | null; // 0–100
  lcpMs?: number;
  cls?: number;
  inpMs?: number;
  tbtMs?: number;
  fcpMs?: number;
  ttfbMs?: number;
  field?: { lcpMs?: number; cls?: number; inpMs?: number; category?: 'FAST' | 'AVERAGE' | 'SLOW' };
  opportunities: { id: string; title: string; savingsMs?: number }[];
  accessibilityScore?: number | null;
  seoScore?: number | null;
  error?: string;
}

export interface GscData {
  property: string;
  range: { start: string; end: string };
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  pages: { url: string; clicks: number; impressions: number; ctr: number; position: number }[];
  queries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
  /** URL Inspection results for a sample of URLs. */
  inspections?: {
    url: string;
    verdict: string;
    coverageState: string;
    googleCanonical?: string;
    lastCrawl?: string;
  }[];
}

export interface Ga4Data {
  property: string;
  range: { start: string; end: string };
  /** Sessions referred by AI assistants (chatgpt.com, perplexity.ai, gemini, claude.ai, copilot…). */
  aiReferrals: {
    source: string;
    sessions: number;
    engagedSessions?: number;
    conversions?: number;
  }[];
  landingPages: { path: string; source: string; sessions: number }[];
}

export interface LogInsights {
  files: string[];
  lines: number;
  range: { start: string; end: string } | null;
  /** Hits per AI bot (verified by IP/rDNS where possible). */
  bots: {
    token: string;
    operator: string;
    purpose: 'training' | 'search' | 'user';
    hits: number;
    verified: number;
    spoofed: number;
    statuses: Record<string, number>;
    topPaths: { path: string; hits: number }[];
    lastSeen?: string;
  }[];
  /** Pages that AI bots never fetched in the window. */
  neverFetched: string[];
  errorsServedToBots: { path: string; status: number; bot: string; hits: number }[];
}

// ---------------------------------------------------------------------------
// Check modules
// ---------------------------------------------------------------------------

export interface PageCheck {
  def: CheckDef;
  /** Return issues for this page (or nothing). Must not throw; must not fetch. */
  run(page: PageData, site: SiteContext): Issue[] | Issue | null | void;
}

export interface SiteCheck {
  def: CheckDef;
  /** May use site.fetcher for extra requests (keep them few). */
  run(site: SiteContext): Promise<Issue[] | Issue | null | void> | Issue[] | Issue | null | void;
}

export type Check = ({ kind: 'page' } & PageCheck) | ({ kind: 'site' } & SiteCheck);

// ---------------------------------------------------------------------------
// AI visibility (outcome) — src/ai
// ---------------------------------------------------------------------------

export type EngineId =
  'chatgpt' | 'claude' | 'gemini' | 'perplexity' | 'copilot' | 'grok' | 'deepseek';

export interface BrandProfile {
  name: string;
  domain: string;
  aliases: string[];
  description?: string;
  services: string[];
  location?: string;
  industry?: string;
  competitors: { name: string; domain?: string }[];
}

export interface TrackedPrompt {
  id: string;
  text: string;
  kind: 'brand' | 'category' | 'comparison' | 'problem' | 'custom';
  /** Whether the engine may search the web for this prompt. */
  search: boolean;
}

export interface Citation {
  url: string;
  domain: string;
  title?: string;
  ownSite: boolean;
  competitor?: string;
}

export interface EngineAnswer {
  engine: EngineId;
  model: string;
  promptId: string;
  prompt: string;
  answer: string; // up to 10,000 chars
  citations: Citation[];
  searchQueries: string[]; // query fan-out, when the engine exposes it
  mentioned: boolean;
  position: number | null; // rank among named brands, 1 = first
  brandsNamed: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  factIssues: {
    claim: string;
    siteSays?: string;
    verdict: 'wrong' | 'outdated' | 'unverifiable';
  }[];
  costUsd: number;
  ms: number;
  error?: string;
}

export interface VisibilityRun {
  id: string;
  at: string;
  brand: BrandProfile;
  prompts: TrackedPrompt[];
  answers: EngineAnswer[];
  summary: {
    mentionRate: number; // 0–1 across all answers
    byEngine: Record<
      string,
      { mentionRate: number; avgPosition: number | null; answers: number; citedOwnSite: number }
    >;
    shareOfVoice: { name: string; share: number; mentions: number; isBrand: boolean }[];
    topCitedDomains: { domain: string; count: number }[];
    ownPagesCited: { url: string; count: number }[];
    competitorWins: {
      promptId: string;
      prompt: string;
      winner: string;
      engines: EngineId[];
      sources: string[];
    }[];
    sentiment: { positive: number; neutral: number; negative: number };
    factIssues: number;
    costUsd: number;
  };
  entity?: { wikidataId?: string; knowledgeGraph?: boolean; sameAs: string[]; notes: string[] };
}

// ---------------------------------------------------------------------------
// Audit results, scoring, fixes
// ---------------------------------------------------------------------------

export interface Fix {
  checkId: string;
  stack: StackId;
  tier: FixTier;
  title: string;
  /** Plain steps, stack-specific. */
  steps: string[];
  /** Files to touch for this stack, e.g. 'app/layout.tsx', 'public/robots.txt', 'Yoast → Search Appearance'. */
  files: string[];
  /** Copy-paste code/config for this stack. */
  snippet?: { language: string; code: string };
  /** A ready prompt for an AI coding assistant (Claude Code, Cursor, Copilot) to apply this fix. */
  agentPrompt: string;
  /** Applied automatically by a connector when true (WordPress / local repo). */
  autoApplicable: boolean;
  effort: 'minutes' | 'hours' | 'days';
  impact: 'high' | 'medium' | 'low';
}

export interface CategoryScore {
  pillar: Pillar;
  score: number; // 0–100
  weight: number; // points this pillar is worth in the overall 100
  passed: number;
  failed: number;
  skipped: number;
}

export interface AuditResult {
  id: string;
  version: string; // app version
  site: string; // origin
  startUrl: string;
  at: string;
  stack: StackInfo;
  stats: CrawlStats;
  pages: PageSummary[];
  issues: Issue[];
  /** Check id → definition, for every check that ran or was skipped. */
  checks: Record<
    string,
    CheckDef & { status: 'ran' | 'skipped'; skippedReason?: string; affected: number }
  >;
  score: { overall: number; grade: 'A' | 'B' | 'C' | 'D' | 'F'; pillars: CategoryScore[] };
  /** Top fixes ranked by impact × reach ÷ effort. */
  priorities: { checkId: string; affected: number; impact: number; fix?: Fix }[];
  probes: ProbeResult[];
  botFetches: BotFetchResult[];
  robots: { found: boolean; status: number | null; body: string };
  sitemaps: { url: string; found: boolean; urls: number; errors: string[] }[];
  external: Omit<ExternalData, 'repo'> & { repo?: ExternalData['repo'] };
  visibility?: VisibilityRun;
}

/** Light per-page row kept in results and the database (no HTML). */
export interface PageSummary {
  url: string;
  finalUrl: string;
  status: number;
  depth: number;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  wordCount: number;
  renderedWordCount?: number;
  canonical: string | null;
  indexable: boolean;
  inlinks: number;
  outlinks: number;
  bytes: number;
  ttfbMs: number;
  schemaTypes: string[];
  issues: number;
  inSitemap: boolean;
}

export interface AuditDiff {
  from: string; // audit id
  to: string;
  scoreDelta: number;
  pillarDeltas: { pillar: Pillar; delta: number }[];
  newIssues: Issue[];
  fixedIssues: Issue[];
  newPages: string[];
  removedPages: string[];
  changedPages: { url: string; fields: string[] }[];
  visibility?: {
    mentionRateDelta: number;
    shareOfVoiceDelta: number;
    newCompetitors: string[];
    lostPrompts: string[];
    wonPrompts: string[];
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CrawlOptions {
  startUrl: string;
  maxPages: number; // default 500; 0 = no limit
  maxDepth: number; // default 10
  concurrency: number; // default 4
  delayMs: number; // politeness delay per worker, default 250
  userAgent: string; // default 'AVC/1.0 (+https://devs-core.com/ai-visibility-checker/app)'
  respectRobots: boolean; // default true
  render: boolean | 'auto'; // 'auto' = render a sample + pages with tiny raw text
  renderLimit: number; // max pages to render, default 50
  include?: string[]; // regex strings
  exclude?: string[];
  useSitemaps: boolean; // seed from sitemaps, default true
  checkExternalLinks: boolean; // HEAD external links, default false
  checkImages: boolean; // HEAD images for size, default true
  timeoutMs: number; // default 20000
  maxBytes: number; // default 5 MB
  chromePath?: string;
  headers?: Record<string, string>;
  /** Basic auth / cookie for staging sites. */
  auth?: { user: string; pass: string } | { cookie: string };
}

export type ProgressEvent =
  | {
      type: 'phase';
      phase:
        | 'robots'
        | 'sitemaps'
        | 'crawl'
        | 'render'
        | 'probes'
        | 'checks'
        | 'external'
        | 'visibility'
        | 'score'
        | 'done';
      message?: string;
    }
  | { type: 'page'; url: string; status: number; crawled: number; queued: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type ProgressFn = (e: ProgressEvent) => void;
