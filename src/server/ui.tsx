/** Shared dashboard pieces: layout, score gauge, bars, sparklines, badges. Server-rendered hono/jsx. */
import type { Child } from 'hono/jsx';
import { raw } from 'hono/html';
import { APP_NAME, APP_VERSION } from '../core/version.js';
import type { Severity } from '../core/types.js';

export const PILLAR_LABEL: Record<string, string> = {
  technical: 'Technical SEO',
  content: 'Content',
  'ai-access': 'AI access',
  geo: 'AEO / GEO',
  agentic: 'Agentic web',
  'ai-visibility': 'AI visibility',
};

export function band(score: number): 'good' | 'mid' | 'bad' {
  return score >= 80 ? 'good' : score >= 50 ? 'mid' : 'bad';
}

export interface LayoutProps {
  title: string;
  siteId?: string;
  siteUrl?: string;
  active?: string;
  flash?: { kind: 'ok' | 'warn' | 'error' | 'info'; text: string } | null;
  actions?: Child;
  children?: Child;
}

const SITE_NAV: [string, string][] = [
  ['overview', 'Overview'],
  ['run', 'Run audit'],
  ['issues', 'Issues'],
  ['pages', 'Pages'],
  ['crawlers', 'AI crawlers'],
  ['agentic', 'Agentic web'],
  ['visibility', 'AI visibility'],
  ['fixes', 'Fixes'],
  ['connections', 'Connections'],
  ['history', 'History & diff'],
];

export function siteHref(siteId: string, section = 'overview'): string {
  return `/s/${encodeURIComponent(siteId)}${section === 'overview' ? '' : '/' + section}`;
}

export function Layout(p: LayoutProps) {
  return (
    <>
      {raw('<!doctype html>')}
      <html lang="en-GB">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex, nofollow" />
          <title>{`${p.title} · ${APP_NAME}`}</title>
          <link rel="stylesheet" href="/assets/app.css" />
          <link
            rel="icon"
            href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230072ba'/%3E%3C/svg%3E"
          />
        </head>
        <body>
          <a class="skip" href="#main">
            Skip to content
          </a>
          <button
            class="btn ghost menu-toggle"
            type="button"
            aria-expanded="false"
            aria-controls="side"
          >
            Menu
          </button>
          <div class="shell">
            <nav class="side" id="side" aria-label="Main">
              <a class="logo" href="/">
                <span class="logo-mark" aria-hidden="true">
                  AVC
                </span>
                <span>AI Visibility Checker</span>
              </a>
              <ul class="nav">
                <li>
                  <a href="/" aria-current={p.active === 'sites' ? 'page' : undefined}>
                    Sites
                  </a>
                </li>
              </ul>
              {p.siteId ? (
                <>
                  <div class="nav-group eyebrow">This site</div>
                  <div class="side-site">
                    <strong>{p.siteId}</strong>
                    {p.siteUrl ? <div class="muted">{p.siteUrl}</div> : null}
                  </div>
                  <ul class="nav">
                    {SITE_NAV.map(([key, label]) => (
                      <li>
                        <a
                          href={siteHref(p.siteId!, key)}
                          aria-current={p.active === key ? 'page' : undefined}
                        >
                          {label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <div class="nav-group eyebrow">App</div>
              <ul class="nav">
                <li>
                  <a href="/settings" aria-current={p.active === 'settings' ? 'page' : undefined}>
                    Settings
                  </a>
                </li>
                <li>
                  <a href="/checks" aria-current={p.active === 'checks' ? 'page' : undefined}>
                    All checks
                  </a>
                </li>
              </ul>
            </nav>
            <main class="main" id="main">
              <div class="topbar">
                <div>
                  {p.siteId ? <div class="eyebrow">{p.siteId}</div> : null}
                  <h1>{p.title}</h1>
                </div>
                {p.actions ? <div class="row">{p.actions}</div> : null}
              </div>
              {p.flash ? (
                <div
                  class={`notice ${p.flash.kind}`}
                  role={p.flash.kind === 'error' ? 'alert' : 'status'}
                >
                  {p.flash.text}
                </div>
              ) : null}
              {p.children}
              <p class="footer">
                {APP_NAME} {APP_VERSION} by{' '}
                <a href="https://devs-core.com" rel="noopener">
                  Devs Core
                </a>
                . Runs on your machine; it only calls the sites and APIs you configure.
              </p>
            </main>
          </div>
          <div id="toast" class="toast" role="status" aria-live="polite"></div>
          <script src="/assets/app.js" defer></script>
        </body>
      </html>
    </>
  );
}

/** Circular score gauge as inline SVG. */
export function Gauge({
  score,
  grade,
  size = 150,
  label,
}: {
  score: number;
  grade?: string;
  size?: number;
  label?: string;
}) {
  const r = 52;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const colour = { good: '#5fd69b', mid: '#f2c14e', bad: '#f0616d' }[band(score)];
  return (
    <svg
      class="gauge"
      width={size}
      height={size}
      viewBox="0 0 120 120"
      role="img"
      aria-label={`${label ?? 'Score'} ${Math.round(score)} out of 100${grade ? `, grade ${grade}` : ''}`}
    >
      <defs>
        <linearGradient id="g-brand" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="#0e4f95" />
          <stop offset="50%" stop-color="#0072ba" />
          <stop offset="100%" stop-color="#0092d3" />
        </linearGradient>
      </defs>
      <circle cx="60" cy="60" r={r} fill="none" stroke="#23242a" stroke-width="10" />
      <circle
        cx="60"
        cy="60"
        r={r}
        fill="none"
        stroke={colour}
        stroke-width="10"
        stroke-linecap="round"
        stroke-dasharray={`${(circ * pct).toFixed(1)} ${circ.toFixed(1)}`}
        transform="rotate(-90 60 60)"
      />
      <text x="60" y="62" text-anchor="middle" font-size="32" font-weight="600" fill="#e8e8e8">
        {Math.round(score)}
      </text>
      <text x="60" y="84" text-anchor="middle" font-size="12" fill="#9aa4ae">
        {grade ? `grade ${grade}` : '/ 100'}
      </text>
    </svg>
  );
}

export function Bar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div class={`bar ${band(pct)}`} role="presentation">
      <span style={`width:${pct.toFixed(1)}%`}></span>
    </div>
  );
}

/** Inline SVG sparkline for a series of 0–100 values (oldest first). */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  label?: string;
}) {
  if (values.length < 2)
    return <span class="muted">{values.length ? '1 data point' : 'no data yet'}</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (width - 4) + 2;
    const y = height - 3 - ((v - min) / span) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = values[values.length - 1];
  return (
    <svg
      class="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label ?? 'Trend'}: ${values.map((v) => Math.round(v)).join(', ')}`}
    >
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke="#0092d3"
        stroke-width="2"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      <circle
        cx={pts[pts.length - 1].split(',')[0]}
        cy={pts[pts.length - 1].split(',')[1]}
        r="2.5"
        fill={{ good: '#5fd69b', mid: '#f2c14e', bad: '#f0616d' }[band(last)]}
      />
    </svg>
  );
}

export function SevBadge({ sev }: { sev: Severity | string }) {
  return <span class={`badge sev-${sev}`}>{sev}</span>;
}

export function Badge({ cls, children }: { cls?: string; children?: Child }) {
  return <span class={`badge ${cls ?? ''}`}>{children}</span>;
}

export function CopyButton({
  target,
  text,
  label = 'Copy',
}: {
  target?: string;
  text?: string;
  label?: string;
}) {
  return (
    <button type="button" class="btn small" data-copy={target} data-copy-text={text}>
      {label}
    </button>
  );
}

export function Empty({ children }: { children?: Child }) {
  return <div class="empty">{children}</div>;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
