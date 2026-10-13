/**
 * The AI crawler tokens the fixes module writes robots rules and firewall rules for.
 * Kept local to src/fixes so generated files do not depend on the detection list in
 * src/agentic (which may grow with tokens we do not want to manage in robots.txt).
 */
export interface FixBot {
  token: string;
  operator: string;
  purpose: 'training' | 'search' | 'user';
  /** Where the operator publishes IP ranges or verification guidance. */
  verify?: string;
}

export const FIX_AI_BOTS: FixBot[] = [
  {
    token: 'GPTBot',
    operator: 'OpenAI',
    purpose: 'training',
    verify: 'https://openai.com/gptbot.json',
  },
  {
    token: 'OAI-SearchBot',
    operator: 'OpenAI',
    purpose: 'search',
    verify: 'https://openai.com/searchbot.json',
  },
  {
    token: 'ChatGPT-User',
    operator: 'OpenAI',
    purpose: 'user',
    verify: 'https://openai.com/chatgpt-user.json',
  },
  { token: 'ClaudeBot', operator: 'Anthropic', purpose: 'training' },
  { token: 'Claude-SearchBot', operator: 'Anthropic', purpose: 'search' },
  { token: 'Claude-User', operator: 'Anthropic', purpose: 'user' },
  {
    token: 'PerplexityBot',
    operator: 'Perplexity',
    purpose: 'search',
    verify: 'https://www.perplexity.ai/perplexitybot.json',
  },
  {
    token: 'Perplexity-User',
    operator: 'Perplexity',
    purpose: 'user',
    verify: 'https://www.perplexity.ai/perplexity-user.json',
  },
  { token: 'Google-Extended', operator: 'Google', purpose: 'training' },
  { token: 'Applebot', operator: 'Apple', purpose: 'search' },
  { token: 'Applebot-Extended', operator: 'Apple', purpose: 'training' },
  { token: 'DuckAssistBot', operator: 'DuckDuckGo', purpose: 'search' },
  { token: 'Amazonbot', operator: 'Amazon', purpose: 'search' },
  { token: 'MistralAI-User', operator: 'Mistral', purpose: 'user' },
  { token: 'meta-externalagent', operator: 'Meta', purpose: 'training' },
  { token: 'Meta-ExternalFetcher', operator: 'Meta', purpose: 'user' },
  { token: 'CCBot', operator: 'Common Crawl', purpose: 'training' },
  { token: 'Bytespider', operator: 'ByteDance', purpose: 'training' },
];

export function isManagedToken(token: string): boolean {
  const t = token.toLowerCase();
  return FIX_AI_BOTS.some((b) => b.token.toLowerCase() === t);
}
