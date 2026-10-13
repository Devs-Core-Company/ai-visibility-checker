import type { AuditResult, CategoryId, Issue, Pillar, Severity } from '../core/types.js';

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export const PILLAR_NAMES: Record<Pillar, string> = {
  technical: 'Technical SEO',
  content: 'Content',
  'ai-access': 'AI crawler access',
  geo: 'AEO / GEO readiness',
  agentic: 'Agentic web',
  'ai-visibility': 'AI visibility',
};

export const CATEGORY_NAMES: Record<CategoryId, string> = {
  crawlability: 'Crawlability',
  robots: 'robots.txt',
  response: 'Responses and status codes',
  redirects: 'Redirects',
  canonical: 'Canonicals',
  onpage: 'Titles and meta',
  headings: 'Headings',
  content: 'Content',
  duplicates: 'Duplicates',
  'links-internal': 'Internal links',
  'links-external': 'External links',
  images: 'Images',
  schema: 'Structured data',
  hreflang: 'Hreflang',
  mobile: 'Mobile',
  performance: 'Performance',
  security: 'Security',
  urls: 'URLs',
  sitemaps: 'Sitemaps',
  pagination: 'Pagination',
  accessibility: 'Accessibility',
  'js-rendering': 'JavaScript rendering',
  analytics: 'Analytics',
  cms: 'CMS',
  'ai-crawlers': 'AI crawlers',
  'llms-txt': 'llms.txt',
  'geo-content': 'AEO / GEO content',
  'geo-entity': 'Entity and brand signals',
  agentic: 'Agentic web',
  'agentic-commerce': 'Agentic commerce',
  'ai-visibility': 'AI visibility',
};

export const CHECKER_URL = 'https://devs-core.com/ai-visibility-checker';

export function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export function issueSeverity(i: Issue, r: Pick<AuditResult, 'checks'>): Severity {
  return i.severity ?? r.checks[i.checkId]?.severity ?? 'info';
}

export function bySeverity(r: Pick<AuditResult, 'checks' | 'issues'>): Record<Severity, number> {
  const out: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const i of r.issues) out[issueSeverity(i, r)]++;
  return out;
}

export function readinessOnly(r: AuditResult): boolean {
  const f = (r.score as { readinessOnly?: boolean }).readinessOnly;
  return typeof f === 'boolean' ? f : !r.visibility;
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return `${(n * 100).toFixed(digits)}%`;
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

/** Find the robots.txt group and rule lines that apply to a user-agent token. */
export function robotsRuleFor(
  body: string,
  token: string,
): { line: number; text: string }[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  type Group = { agents: string[]; rules: { line: number; text: string }[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  lines.forEach((raw, idx) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) return;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(m[2].trim().toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow'))
        cur.rules.push({ line: idx + 1, text: `${m[1]}: ${m[2]}` });
    }
  });
  const t = token.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && t.includes(a)));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

export function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}
