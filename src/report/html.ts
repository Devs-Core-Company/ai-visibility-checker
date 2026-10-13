/**
 * A single self-contained HTML report: no network requests, no external fonts
 * or scripts. Works offline and reads well as raw HTML. Devs Core dark style.
 */
import type { AuditDiff, AuditResult, Fix, Issue } from '../core/types.js';
import type { Trends } from '../monitor/store.js';
import { executiveSummary } from './summary.js';
import {
  CATEGORY_NAMES,
  CHECKER_URL,
  PILLAR_NAMES,
  SEVERITY_ORDER,
  bySeverity,
  esc,
  groupBy,
  issueSeverity,
  pct,
  plural,
  readinessOnly,
  robotsRuleFor,
  shortDate,
} from './util.js';

export interface HtmlReportOptions {
  diff?: AuditDiff;
  trends?: Trends;
  title?: string;
  /** Max affected URLs listed per check. Default 200. */
  maxUrlsPerCheck?: number;
  /** Max rows in the page table. Default 2000. */
  maxPages?: number;
  /** White-label: your name, accent colour, logo URL and contact line in the header and footer. */
  branding?: { brandName?: string; brandColor?: string; brandLogo?: string; brandContact?: string };
  /** Light, print-friendly colours (used for PDF export). */
  print?: boolean;
}

const PRINT_CSS = `:root{--ink:#ffffff;--surface:#f6f7f9;--surface2:#eef0f3;--line:#d9dde3;--fg:#15171a;--muted:#555d66}
html{color-scheme:light}body{font-size:13px}a{color:var(--royal)}header.top{background:#fff}
.card,details{break-inside:avoid}`;

/** Accept only a hex colour (white-label accent). */
export function safeColor(c: string | undefined): string | null {
  return c && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c.trim()) ? c.trim() : null;
}

function brandHeader(opts: HtmlReportOptions): string {
  const b = opts.branding;
  if (!b?.brandName && !b?.brandLogo)
    return '<i aria-hidden="true"></i>Devs Core · AI Visibility Checker';
  const logo =
    b.brandLogo && /^(https?:|data:image\/)/i.test(b.brandLogo)
      ? `<img src="${esc(b.brandLogo)}" alt="" style="height:24px;width:auto">`
      : '<i aria-hidden="true"></i>';
  return `${logo}${esc(b.brandName ?? '')}`;
}

const CSS = `
:root{--ink:#0a0a0b;--surface:#101013;--surface2:#15161a;--line:#23242a;--fg:#e8e8e8;--muted:#9aa4ae;
--navy:#0e4f95;--royal:#0072ba;--azure:#0092d3;--pass:#5fd69b;--hold:#f2c14e;--danger:#f0616d;
--grad:linear-gradient(90deg,var(--navy),var(--royal),var(--azure));
--display:Jost,"Futura","Avenir Next","Segoe UI",system-ui,sans-serif;
--body:"Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}html{color-scheme:dark}
body{margin:0;background:var(--ink);color:var(--fg);font:15px/1.6 var(--body);-webkit-font-smoothing:antialiased}
a{color:var(--azure)}a:hover{color:#4fb6e6}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
header.top{border-bottom:1px solid var(--line);background:var(--surface)}
header.top .wrap{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 20px;flex-wrap:wrap}
.brand{font:600 15px var(--display);letter-spacing:.02em;display:flex;align-items:center;gap:10px}
.brand i{display:inline-block;width:22px;height:22px;border-radius:6px;background:var(--grad)}
.eyebrow,.label{font:500 11px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}
h1,h2,h3{font-family:var(--display);font-weight:500;line-height:1.2;margin:0}
h1{font-size:30px}h2{font-size:22px;margin-bottom:14px}h3{font-size:17px}
section{padding:34px 0;border-bottom:1px solid var(--line)}
.muted{color:var(--muted)}.small{font-size:13px}
.hero{display:grid;grid-template-columns:240px 1fr;gap:34px;align-items:center}
.ring{position:relative;width:200px;height:200px}
.ring .num{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ring .num b{font:500 56px/1 var(--display)}.ring .num span{font:500 13px var(--mono);color:var(--muted);margin-top:6px}
.pillars{display:grid;gap:10px}
.pillar{display:grid;grid-template-columns:170px 1fr 44px;gap:12px;align-items:center}
.bar{height:10px;background:var(--surface2);border-radius:5px;overflow:hidden;border:1px solid var(--line)}
.bar>i{display:block;height:100%;border-radius:0 4px 4px 0;background:var(--azure)}
.bar.pass>i{background:var(--pass)}.bar.hold>i{background:var(--hold)}.bar.danger>i{background:var(--danger)}
.pillar .val{font:500 14px var(--mono);text-align:right}
.note{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--hold);padding:10px 14px;border-radius:6px;margin-top:16px;font-size:14px}
.summary p{max-width:78ch;margin:0 0 10px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:18px}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.stat b{display:block;font:500 24px var(--display)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:14px}
.card h3{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.card h3 .rank{font:500 13px var(--mono);color:var(--azure)}
.badge{display:inline-block;font:500 11px/1 var(--mono);text-transform:uppercase;letter-spacing:.08em;padding:4px 7px;border-radius:4px;border:1px solid currentColor;white-space:nowrap}
.sev-critical{color:var(--danger)}.sev-high{color:#f58a6b}.sev-medium{color:var(--hold)}.sev-low{color:var(--azure)}.sev-info{color:var(--muted)}
.v-ok{color:var(--pass)}.v-blocked,.v-error{color:var(--danger)}.v-differs{color:var(--hold)}.v-inconclusive{color:var(--muted)}
ol.steps{margin:8px 0 8px 20px;padding:0}ol.steps li{margin:3px 0}
pre{background:var(--ink);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:auto;font:13px/1.5 var(--mono);color:#cfd6dc;max-height:360px}
code{font-family:var(--mono);font-size:.92em}
button.copy{font:500 12px var(--mono);background:transparent;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:7px 11px;cursor:pointer}
button.copy:hover{border-color:var(--azure);color:var(--azure)}
.meta{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin:6px 0 10px}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font:500 11px var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);background:var(--surface);position:sticky;top:0}
tr:last-child td{border-bottom:0}td.num{text-align:right;font-family:var(--mono)}
td.url{max-width:420px;word-break:break-all}
details{background:var(--surface);border:1px solid var(--line);border-radius:8px;margin-bottom:8px}
details>summary{cursor:pointer;padding:10px 14px;list-style:none;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
details>summary::-webkit-details-marker{display:none}
details>summary:before{content:"+";font:500 14px var(--mono);color:var(--muted);width:12px}
details[open]>summary:before{content:"–"}
details .body{padding:0 14px 12px 36px}
details details{background:var(--surface2)}
ul.urls{margin:6px 0;padding-left:18px;font-size:13px}ul.urls li{word-break:break-all;margin:2px 0}
.hbar{display:grid;grid-template-columns:160px 1fr 60px;gap:10px;align-items:center;margin:6px 0}
.hbar .bar{height:12px}.hbar.brand .bar>i{background:var(--azure)}.hbar.other .bar>i{background:#5a6470}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.spark{display:block;width:100%;height:auto}
footer{padding:30px 0 50px;color:var(--muted);font-size:13px}
.delta-up{color:var(--pass)}.delta-down{color:var(--danger)}
@media (max-width:760px){.hero,.grid2{grid-template-columns:1fr}.pillar{grid-template-columns:120px 1fr 40px}.hbar{grid-template-columns:110px 1fr 50px}h1{font-size:24px}}
@media print{body{background:#fff;color:#000}details{break-inside:avoid}button.copy{display:none}}
`;

const JS = `document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button.copy');if(!b)return;
var t=document.getElementById(b.getAttribute('data-copy'));if(!t)return;var s=t.textContent||'';
function done(){var o=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=o},1500)}
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(s).then(done,fallback)}else fallback();
function fallback(){var a=document.createElement('textarea');a.value=s;a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();try{document.execCommand('copy');done()}catch(_){}document.body.removeChild(a)}});`;

function tone(score: number): 'pass' | 'hold' | 'danger' {
  return score >= 75 ? 'pass' : score >= 50 ? 'hold' : 'danger';
}

function scoreRing(score: number, grade: string): string {
  const r = 86;
  const c = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * c;
  return `<div class="ring" role="img" aria-label="Score ${score} out of 100, grade ${esc(grade)}">
<svg viewBox="0 0 200 200" width="200" height="200" aria-hidden="true">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0e4f95"/><stop offset=".5" stop-color="#0072ba"/><stop offset="1" stop-color="#0092d3"/></linearGradient></defs>
<circle cx="100" cy="100" r="${r}" fill="none" stroke="#23242a" stroke-width="12"/>
<circle cx="100" cy="100" r="${r}" fill="none" stroke="url(#g)" stroke-width="12" stroke-linecap="round" stroke-dasharray="${filled.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 100 100)"/>
</svg><div class="num"><b>${score}</b><span>GRADE ${esc(grade)} · /100</span></div></div>`;
}

function sevBadge(sev: string): string {
  return `<span class="badge sev-${esc(sev)}">${esc(sev)}</span>`;
}

function sparkline(
  points: { at: string; value: number }[],
  opts: { max: number; label: string; fmt: (n: number) => string },
): string {
  if (points.length < 2)
    return '<p class="muted small">Not enough history yet. Trends appear after two runs.</p>';
  const W = 520;
  const H = 120;
  const pad = 24;
  const x = (i: number) => pad + (i * (W - pad * 2)) / (points.length - 1);
  const y = (v: number) =>
    H - pad - (Math.max(0, Math.min(opts.max, v)) / opts.max) * (H - pad * 2);
  const d = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(' ');
  const last = points[points.length - 1];
  const dots = points
    .map(
      (p, i) =>
        `<g><circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="10" fill="transparent"/><circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${i === points.length - 1 ? 4 : 2.5}" fill="#0092d3" stroke="#101013" stroke-width="2"/><title>${esc(shortDate(p.at))}: ${esc(opts.fmt(p.value))}</title></g>`,
    )
    .join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label)}: ${esc(opts.fmt(points[0].value))} to ${esc(opts.fmt(last.value))} over ${points.length} runs">
<line x1="${pad}" x2="${W - pad}" y1="${H - pad}" y2="${H - pad}" stroke="#23242a"/>
<line x1="${pad}" x2="${W - pad}" y1="${pad}" y2="${pad}" stroke="#23242a" stroke-dasharray="2 4"/>
<text x="${pad}" y="${pad - 8}" fill="#9aa4ae" font-size="10" font-family="ui-monospace,monospace">${esc(opts.fmt(opts.max))}</text>
<text x="${pad}" y="${H - 6}" fill="#9aa4ae" font-size="10" font-family="ui-monospace,monospace">${esc(shortDate(points[0].at))}</text>
<text x="${W - pad}" y="${H - 6}" fill="#9aa4ae" font-size="10" text-anchor="end" font-family="ui-monospace,monospace">${esc(shortDate(last.at))}</text>
<path d="${d}" fill="none" stroke="#0092d3" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}
<text x="${(x(points.length - 1) - 8).toFixed(1)}" y="${(y(last.value) - 10).toFixed(1)}" fill="#e8e8e8" font-size="11" text-anchor="end" font-family="ui-monospace,monospace">${esc(opts.fmt(last.value))}</text>
</svg>`;
}

function hbar(label: string, value: number, display: string, cls = ''): string {
  const w = Math.max(0, Math.min(100, value * 100));
  return `<div class="hbar ${cls}"><span class="small">${esc(label)}</span><div class="bar"><i style="width:${w.toFixed(1)}%"></i></div><span class="small" style="text-align:right;font-family:var(--mono)">${esc(display)}</span></div>`;
}

let copyId = 0;

function fixBlock(fix: Fix | undefined, fallback: string): string {
  if (!fix) return `<p><span class="label">Fix</span><br>${esc(fallback)}</p>`;
  const id = `prompt-${++copyId}`;
  return `<div class="meta"><span>Effort: ${esc(fix.effort)}</span><span>Impact: ${esc(fix.impact)}</span><span>Fix type: ${esc(fix.tier)}${fix.autoApplicable ? ' (can be applied automatically)' : ''}</span>${fix.stack && fix.stack !== 'unknown' ? `<span>Stack: ${esc(fix.stack)}</span>` : ''}</div>
${fix.steps.length ? `<ol class="steps">${fix.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
${fix.files.length ? `<p class="small"><span class="label">Where</span><br>${fix.files.map((f) => `<code>${esc(f)}</code>`).join(', ')}</p>` : ''}
${fix.snippet ? `<pre><code class="language-${esc(fix.snippet.language)}">${esc(fix.snippet.code)}</code></pre>` : ''}
${fix.agentPrompt ? `<p><button class="copy" type="button" data-copy="${id}">Copy prompt for your AI coding assistant</button></p><pre id="${id}" hidden>${esc(fix.agentPrompt)}</pre>` : ''}`;
}

function urlList(issues: Issue[], max: number): string {
  const withUrl = issues.filter((i) => i.url);
  if (!withUrl.length)
    return issues.length
      ? `<ul class="urls">${issues
          .slice(0, max)
          .map(
            (i) =>
              `<li>${esc(i.message)}${i.evidence ? ` <code>${esc(i.evidence)}</code>` : ''}</li>`,
          )
          .join('')}</ul>`
      : '';
  const shown = withUrl.slice(0, max);
  return `<ul class="urls">${shown
    .map(
      (i) =>
        `<li><a href="${esc(i.url)}" rel="noopener nofollow">${esc(i.url)}</a> <span class="muted">— ${esc(i.message)}</span>${i.evidence ? ` <code>${esc(i.evidence.slice(0, 200))}</code>` : ''}</li>`,
    )
    .join(
      '',
    )}</ul>${withUrl.length > max ? `<p class="muted small">and ${withUrl.length - max} more (see the CSV export).</p>` : ''}`;
}

export function renderHtmlReport(result: AuditResult, opts: HtmlReportOptions = {}): string {
  copyId = 0;
  const r = result;
  const s = r.score;
  const maxUrls = opts.maxUrlsPerCheck ?? 200;
  const maxPages = opts.maxPages ?? 2000;
  const title = opts.title ?? `AI Visibility Report: ${r.site.replace(/^https?:\/\//, '')}`;
  const sev = bySeverity(r);
  const issuesByCheck = groupBy(r.issues, (i) => i.checkId);
  const parts: string[] = [];

  // Header + hero
  parts.push(
    `<header class="top"><div class="wrap"><div class="brand">${brandHeader(opts)}</div><div class="label">Report · ${esc(shortDate(r.at))} · v${esc(r.version)}</div></div></header>`,
  );
  parts.push(`<main class="wrap">`);
  const pillarRows = s.pillars
    .map((p) =>
      p.weight > 0
        ? `<div class="pillar"><span>${esc(PILLAR_NAMES[p.pillar])} <span class="muted small">· ${Math.round(p.weight)}%</span></span><div class="bar ${tone(p.score)}" role="img" aria-label="${esc(PILLAR_NAMES[p.pillar])} ${p.score} of 100"><i style="width:${p.score}%"></i></div><span class="val">${p.score}</span></div>`
        : `<div class="pillar"><span>${esc(PILLAR_NAMES[p.pillar])}</span><span class="muted small">Not measured${p.pillar === 'ai-visibility' ? ' — run with --visibility' : ''}</span><span class="val muted">–</span></div>`,
    )
    .join('');
  parts.push(`<section><div class="eyebrow">AI Visibility Score</div><h1 style="margin:6px 0 22px">${esc(r.site)}</h1>
<div class="hero">${scoreRing(s.overall, s.grade)}<div class="pillars">${pillarRows}</div></div>
${(r.score as { cappedBy?: string }).cappedBy ? `<div class="note">Score capped by <code>${esc((r.score as { cappedBy?: string }).cappedBy!)}</code>: ${(r.score as { cappedBy?: string }).cappedBy === 'response.homepage-error' ? 'the start URL did not load, so nothing else can be trusted.' : 'an open critical issue keeps the grade below A until it is fixed.'}</div>` : ''}
${readinessOnly(r) ? '<div class="note">Readiness only. No AI visibility run was included, so this score measures whether AI engines can reach, read and trust the site. Run <code>avc audit --visibility</code> to measure whether ChatGPT, Claude, Gemini and Perplexity actually name you.</div>' : ''}
<div class="stats">
<div class="stat"><span class="label">Pages crawled</span><b>${r.stats?.pagesCrawled ?? r.pages.length}</b></div>
<div class="stat"><span class="label">Critical</span><b class="sev-critical">${sev.critical}</b></div>
<div class="stat"><span class="label">High</span><b class="sev-high">${sev.high}</b></div>
<div class="stat"><span class="label">Medium</span><b class="sev-medium">${sev.medium}</b></div>
<div class="stat"><span class="label">Low</span><b>${sev.low}</b></div>
<div class="stat"><span class="label">Stack</span><b style="font-size:18px">${esc(r.stack?.id ?? 'unknown')}</b></div>
</div></section>`);

  // Executive summary
  parts.push(
    `<section class="summary"><h2>Summary</h2>${executiveSummary(r, opts.diff)
      .map((p) => `<p>${esc(p)}</p>`)
      .join('')}</section>`,
  );

  // Changes
  if (opts.diff) {
    const d = opts.diff;
    const cls = d.scoreDelta > 0 ? 'delta-up' : d.scoreDelta < 0 ? 'delta-down' : '';
    const issueRow = (i: Issue) =>
      `<li>${sevBadge(issueSeverity(i, r))} ${esc(r.checks[i.checkId]?.title ?? i.checkId)}${i.url ? ` — <span class="muted">${esc(i.url)}</span>` : ''}</li>`;
    parts.push(`<section><h2>Since the last audit</h2>
<p>Score <b class="${cls}">${d.scoreDelta > 0 ? '+' : ''}${d.scoreDelta}</b>. ${d.pillarDeltas
      .filter((p) => p.delta)
      .map(
        (p) =>
          `${esc(PILLAR_NAMES[p.pillar])} <span class="${p.delta > 0 ? 'delta-up' : 'delta-down'}">${p.delta > 0 ? '+' : ''}${p.delta}</span>`,
      )
      .join(', ')}</p>
<div class="grid2"><div><h3>New issues (${d.newIssues.length})</h3><ul class="urls">${d.newIssues.slice(0, 50).map(issueRow).join('') || '<li class="muted">None</li>'}</ul></div>
<div><h3>Fixed (${d.fixedIssues.length})</h3><ul class="urls">${d.fixedIssues.slice(0, 50).map(issueRow).join('') || '<li class="muted">None</li>'}</ul></div></div>
${
  d.changedPages.length
    ? `<details><summary>${plural(d.changedPages.length, 'changed page')}</summary><div class="body"><ul class="urls">${d.changedPages
        .slice(0, 200)
        .map(
          (c) => `<li>${esc(c.url)} <span class="muted">(${esc(c.fields.join(', '))})</span></li>`,
        )
        .join('')}</ul></div></details>`
    : ''
}
${d.newPages.length || d.removedPages.length ? `<p class="muted small">${plural(d.newPages.length, 'new page')}, ${plural(d.removedPages.length, 'removed page')}.</p>` : ''}
${d.visibility ? `<p>AI mention rate ${d.visibility.mentionRateDelta >= 0 ? '+' : ''}${(d.visibility.mentionRateDelta * 100).toFixed(0)} points; share of voice ${d.visibility.shareOfVoiceDelta >= 0 ? '+' : ''}${(d.visibility.shareOfVoiceDelta * 100).toFixed(0)} points.${d.visibility.newCompetitors.length ? ` New competitors named: ${esc(d.visibility.newCompetitors.join(', '))}.` : ''}</p>` : ''}
</section>`);
  }

  // Trends
  if (opts.trends && (opts.trends.audits.length > 1 || opts.trends.visibility.length > 1)) {
    const t = opts.trends;
    parts.push(`<section><h2>Trends</h2><div class="grid2">
<div><div class="label">AI Visibility Score</div>${sparkline(
      t.audits.map((a) => ({ at: a.at, value: a.score })),
      { max: 100, label: 'Score over time', fmt: (n) => String(Math.round(n)) },
    )}</div>
<div><div class="label">Named in AI answers</div>${sparkline(
      t.visibility.map((v) => ({ at: v.at, value: v.mentionRate })),
      { max: 1, label: 'Mention rate over time', fmt: (n) => pct(n) },
    )}</div>
</div>
${
  t.audits.length
    ? `<details><summary>History table</summary><div class="body"><div class="tablewrap"><table><thead><tr><th>Date</th><th>Score</th><th>Grade</th><th>Critical</th><th>High</th><th>Medium</th><th>Low</th></tr></thead><tbody>${t.audits
        .map(
          (a) =>
            `<tr><td>${esc(shortDate(a.at))}</td><td class="num">${a.score}</td><td>${esc(a.grade)}</td><td class="num">${a.bySeverity.critical}</td><td class="num">${a.bySeverity.high}</td><td class="num">${a.bySeverity.medium}</td><td class="num">${a.bySeverity.low}</td></tr>`,
        )
        .join('')}</tbody></table></div></div></details>`
    : ''
}
</section>`);
  }

  // Priorities
  const top = r.priorities.slice(0, 10);
  parts.push(`<section><h2>Fix these first</h2><p class="muted">Ranked by how much each costs the score, how many pages it affects and how long the fix takes.</p>
${
  top.length
    ? top
        .map((p, i) => {
          const def = r.checks[p.checkId];
          const own = issuesByCheck.get(p.checkId) ?? [];
          const sevName = def ? issueSeverity({ checkId: p.checkId, message: '' }, r) : 'info';
          return `<article class="card"><h3><span class="rank">${String(i + 1).padStart(2, '0')}</span>${esc(def?.title ?? p.checkId)} ${sevBadge(sevName)}</h3>
<div class="meta"><span>${def?.scope === 'page' ? plural(p.affected, 'page') + ' affected' : 'Site-wide'}</span><span>${esc(def ? PILLAR_NAMES[def.pillar] : '')}</span><span><code>${esc(p.checkId)}</code></span></div>
${def?.why ? `<p>${esc(def.why)}</p>` : ''}
${fixBlock(p.fix, def?.fix ?? '')}
${own.length ? `<details><summary class="small">Where it happens (${own.length})</summary><div class="body">${urlList(own, 25)}</div></details>` : ''}
</article>`;
        })
        .join('')
    : '<p>No failing checks. Keep monitoring so you hear about regressions.</p>'
}</section>`);

  // AI crawler matrix
  if (r.botFetches?.length || r.robots) {
    const rows = (r.botFetches ?? [])
      .map((b) => {
        const rules = robotsRuleFor(r.robots?.body ?? '', b.token);
        const ruleText = rules.length
          ? rules
              .slice(0, 3)
              .map((x) => `<code>L${x.line}: ${esc(x.text)}</code>`)
              .join('<br>')
          : `<span class="muted">${r.robots?.found ? 'No rule (allowed)' : 'No robots.txt'}</span>`;
        return `<tr><td><b>${esc(b.token)}</b><br><span class="muted small">${esc(b.operator)}</span></td><td>${esc(b.purpose)}</td><td class="v-${esc(b.verdict)}">${esc(b.verdict)}${b.challenge ? `<br><span class="small">${esc(b.challenge)} challenge</span>` : ''}</td><td class="num">${b.status || '–'}</td><td class="num">${b.words}</td><td>${ruleText}</td></tr>`;
      })
      .join('');
    parts.push(`<section><h2>AI crawler access</h2><p class="muted">Each AI crawler's live fetch of your home page, compared with a normal browser, and the robots.txt rule that applies to it.</p>
${rows ? `<div class="tablewrap"><table><thead><tr><th>Crawler</th><th>Purpose</th><th>Live fetch</th><th>Status</th><th>Words</th><th>robots.txt</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Live AI crawler fetches were not run.</p>'}
${r.robots ? `<details><summary class="small">robots.txt (${r.robots.found ? `HTTP ${r.robots.status}` : 'not found'})</summary><div class="body"><pre>${esc(r.robots.body.slice(0, 20_000) || '(empty)')}</pre></div></details>` : ''}
</section>`);
  }

  // Agentic probes
  if (r.probes?.length) {
    parts.push(`<section><h2>Agentic web readiness</h2><p class="muted">Files and endpoints AI agents look for: llms.txt, MCP and A2A cards, OAuth discovery, markdown versions of pages and more.</p>
<div class="tablewrap"><table><thead><tr><th>Probe</th><th>URL</th><th>Status</th><th>Found</th></tr></thead><tbody>${r.probes
      .map(
        (p) =>
          `<tr><td><code>${esc(p.id)}</code></td><td class="url">${esc(p.url)}</td><td class="num">${p.status ?? '–'}</td><td class="${p.found ? 'v-ok' : 'muted'}">${p.found ? 'Yes' : 'No'}${p.error ? ` <span class="small">(${esc(p.error)})</span>` : ''}</td></tr>`,
      )
      .join('')}</tbody></table></div></section>`);
  }

  // Visibility
  if (r.visibility) {
    const v = r.visibility;
    const sm = v.summary;
    const engines = Object.entries(sm.byEngine);
    const sov = sm.shareOfVoice.slice(0, 10);
    const maxShare = Math.max(0.0001, ...sov.map((x) => x.share));
    parts.push(`<section><h2>AI visibility</h2>
<p>${esc(v.brand.name)} was named in <b>${pct(sm.mentionRate)}</b> of ${plural(v.answers.filter((a) => !a.error).length, 'answer')} across ${plural(v.prompts.length, 'prompt')}. Run cost: $${sm.costUsd.toFixed(2)}.</p>
<div class="grid2"><div><h3 style="margin-bottom:8px">Mention rate by engine</h3>${engines
      .map(([e, x]) => hbar(e, x.mentionRate, `${pct(x.mentionRate)}`, 'brand'))
      .join('')}
<div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>Engine</th><th>Answers</th><th>Avg position</th><th>Cited you</th></tr></thead><tbody>${engines
      .map(
        ([e, x]) =>
          `<tr><td>${esc(e)}</td><td class="num">${x.answers}</td><td class="num">${x.avgPosition === null ? '–' : x.avgPosition.toFixed(1)}</td><td class="num">${x.citedOwnSite}</td></tr>`,
      )
      .join('')}</tbody></table></div></div>
<div><h3 style="margin-bottom:8px">Share of voice</h3>${sov
      .map((x) =>
        hbar(
          x.name + (x.isBrand ? ' (you)' : ''),
          x.share / maxShare,
          pct(x.share),
          x.isBrand ? 'brand' : 'other',
        ),
      )
      .join('')}
<p class="muted small">Sentiment: ${sm.sentiment.positive} positive, ${sm.sentiment.neutral} neutral, ${sm.sentiment.negative} negative. ${sm.factIssues ? `${plural(sm.factIssues, 'claim')} looked wrong or out of date.` : ''}</p></div></div>
${
  sm.competitorWins.length
    ? `<h3 style="margin:18px 0 8px">Prompts where a competitor was named instead of you</h3><div class="tablewrap"><table><thead><tr><th>Prompt</th><th>Named instead</th><th>Engines</th><th>Sources they cited</th></tr></thead><tbody>${sm.competitorWins
        .slice(0, 30)
        .map(
          (w) =>
            `<tr><td>${esc(w.prompt)}</td><td>${esc(w.winner)}</td><td>${esc(w.engines.join(', '))}</td><td class="url small">${w.sources.slice(0, 5).map(esc).join('<br>')}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : ''
}
<div class="grid2" style="margin-top:18px"><div><h3 style="margin-bottom:8px">Your pages cited</h3>${sm.ownPagesCited.length ? `<ul class="urls">${sm.ownPagesCited.map((c) => `<li>${esc(c.url)} <span class="muted">× ${c.count}</span></li>`).join('')}</ul>` : '<p class="muted small">None of your pages were cited.</p>'}</div>
<div><h3 style="margin-bottom:8px">Most cited domains</h3>${
      sm.topCitedDomains.length
        ? `<ul class="urls">${sm.topCitedDomains
            .slice(0, 15)
            .map((c) => `<li>${esc(c.domain)} <span class="muted">× ${c.count}</span></li>`)
            .join('')}</ul>`
        : '<p class="muted small">No citations returned.</p>'
    }</div></div>
<details style="margin-top:14px"><summary class="small">Every answer (${v.answers.length})</summary><div class="body">${v.answers
      .slice(0, 300)
      .map(
        (a) =>
          `<details><summary class="small"><b>${esc(a.engine)}</b> · ${esc(a.prompt)} · <span class="${a.mentioned ? 'v-ok' : 'v-blocked'}">${a.error ? 'error' : a.mentioned ? `named${a.position ? ` #${a.position}` : ''}` : 'not named'}</span></summary><div class="body"><pre>${esc(a.error ?? a.answer)}</pre>${a.citations.length ? `<ul class="urls">${a.citations.map((c) => `<li>${esc(c.url)}${c.ownSite ? ' <b class="v-ok">(yours)</b>' : ''}</li>`).join('')}</ul>` : ''}</div></details>`,
      )
      .join('')}</div></details>
</section>`);
  }

  // All issues by category
  const failing = Object.values(r.checks).filter((c) => c.status === 'ran' && c.affected > 0);
  const byCat = groupBy(failing, (c) => c.category);
  const catBlocks = [...byCat.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cat, defs]) => {
      defs.sort(
        (a, b) =>
          SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
          b.affected - a.affected,
      );
      const inner = defs
        .map((d) => {
          const own = issuesByCheck.get(d.id) ?? [];
          return `<details><summary>${sevBadge(d.severity)} <span>${esc(d.title)}</span> <span class="muted small">${d.scope === 'page' ? plural(d.affected, 'page') : 'site-wide'} · <code>${esc(d.id)}</code></span></summary><div class="body"><p>${esc(d.why)}</p><p><span class="label">Fix</span><br>${esc(d.fix)}</p>${urlList(own, maxUrls)}${d.refs?.length ? `<p class="small">${d.refs.map((u) => `<a href="${esc(u)}" rel="noopener">${esc(u)}</a>`).join('<br>')}</p>` : ''}</div></details>`;
        })
        .join('');
      return `<details><summary><b>${esc(CATEGORY_NAMES[cat] ?? cat)}</b> <span class="muted small">${plural(defs.length, 'failing check')}</span></summary><div class="body">${inner}</div></details>`;
    })
    .join('');
  const ran = Object.values(r.checks).filter((c) => c.status === 'ran').length;
  const skippedChecks = Object.values(r.checks).filter((c) => c.status === 'skipped');
  parts.push(`<section><h2>Every issue</h2><p class="muted">${ran} checks ran, ${failing.length} found something${skippedChecks.length ? `, ${skippedChecks.length} were skipped` : ''}.</p>${catBlocks || '<p>Nothing to report.</p>'}
${skippedChecks.length ? `<details><summary class="small">Skipped checks (${skippedChecks.length})</summary><div class="body"><ul class="urls">${skippedChecks.map((c) => `<li>${esc(c.title)} <span class="muted">— ${esc(c.skippedReason ?? '')}</span></li>`).join('')}</ul></div></details>` : ''}
</section>`);

  // Pages
  const pages = [...r.pages].sort((a, b) => b.issues - a.issues || a.depth - b.depth);
  parts.push(
    `<section><h2>Pages</h2><details><summary>${plural(r.pages.length, 'page')}${r.pages.length > maxPages ? ` (first ${maxPages} shown)` : ''}</summary><div class="body" style="padding-left:14px"><div class="tablewrap"><table><thead><tr><th>URL</th><th>Status</th><th>Indexable</th><th>Title</th><th>Words</th><th>Inlinks</th><th>Issues</th></tr></thead><tbody>${pages
      .slice(0, maxPages)
      .map(
        (p) =>
          `<tr><td class="url">${esc(p.url)}</td><td class="num ${p.status >= 400 || p.status === 0 ? 'v-error' : p.status >= 300 ? 'v-differs' : ''}">${p.status}</td><td>${p.indexable ? 'Yes' : '<span class="muted">No</span>'}</td><td>${esc(p.title ?? '')}</td><td class="num">${p.wordCount}</td><td class="num">${p.inlinks}</td><td class="num">${p.issues}</td></tr>`,
      )
      .join('')}</tbody></table></div></div></details></section>`,
  );

  parts.push(
    `</main><footer><div class="wrap">${opts.branding?.brandName || opts.branding?.brandContact ? `<p><b>${esc(opts.branding.brandName ?? '')}</b>${opts.branding.brandContact ? ` · ${esc(opts.branding.brandContact)}` : ''}</p>` : ''}<p>Made with the AI Visibility Checker by <a href="https://devs-core.com">Devs Core</a>. It runs on your machine; this report was not uploaded anywhere. <a href="${CHECKER_URL}">devs-core.com/ai-visibility-checker</a></p><p class="small">Audit ${esc(r.id)} · ${esc(r.at)} · ${esc(r.startUrl)}</p></div></footer>`,
  );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="generator" content="AI Visibility Checker ${esc(r.version)} by Devs Core">
<title>${esc(title)}</title><style>${CSS}${opts.print ? PRINT_CSS : ''}${safeColor(opts.branding?.brandColor) ? `:root{--azure:${safeColor(opts.branding?.brandColor)};--grad:linear-gradient(90deg,${safeColor(opts.branding?.brandColor)},${safeColor(opts.branding?.brandColor)})}` : ''}</style></head>
<body>${parts.join('\n')}<script>${JS}</script></body></html>`;
}
