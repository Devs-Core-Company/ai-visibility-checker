/**
 * Alerts: compare two audits (and/or two visibility runs), decide what is
 * worth telling someone about, and send it by webhook (Slack, Discord,
 * Microsoft Teams or any JSON endpoint) and/or SMTP email.
 *
 * Each alert has a stable key; an alert already sent within the de-duplication
 * window (default 7 days) is not sent again. `dryRun` builds the payloads and
 * returns them without sending anything — used by tests and `avc monitor test`.
 */
import { createHash } from 'node:crypto';
import type { AvcConfig } from '../core/config.js';
import { siteIdFromUrl } from '../core/config.js';
import type { AuditResult, Issue, ProbeResult, VisibilityRun } from '../core/types.js';
import { diffAudits, issueKey } from './diff.js';
import type { Store } from './store.js';

export type AlertRuleId =
  | 'score-drop'
  | 'new-critical'
  | 'page-noindex'
  | 'page-error'
  | 'ai-bot-blocked'
  | 'robots-changed'
  | 'llms-txt-changed'
  | 'mention-rate-drop'
  | 'competitor-overtakes';

export interface AlertRules {
  /** Alert when the overall score falls by at least this many points. 0 disables. Default 5. */
  scoreDrop: number;
  newCritical: boolean;
  pageNoindex: boolean;
  pageError: boolean;
  aiBotBlocked: boolean;
  robotsChanged: boolean;
  llmsTxtChanged: boolean;
  /** Alert when the mention rate falls by at least this much (0–1). 0 disables. Default 0.1. */
  mentionRateDrop: number;
  competitorOvertakes: boolean;
}

export const DEFAULT_RULES: AlertRules = {
  scoreDrop: 5,
  newCritical: true,
  pageNoindex: true,
  pageError: true,
  aiBotBlocked: true,
  robotsChanged: true,
  llmsTxtChanged: true,
  mentionRateDrop: 0.1,
  competitorOvertakes: true,
};

export interface Alert {
  key: string;
  rule: AlertRuleId;
  site: string;
  level: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  urls?: string[];
}

const MAX_URLS = 10;

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

function makeKey(rule: AlertRuleId, site: string, identity: string): string {
  return `${rule}:${site}:${hash(identity)}`;
}

function sevOf(i: Issue, r: AuditResult) {
  return i.severity ?? r.checks[i.checkId]?.severity ?? 'info';
}

function llmsProbe(r: AuditResult): ProbeResult | undefined {
  return r.probes?.find(
    (p) => p.id === 'llms-txt' || p.id === 'llms.txt' || /\/llms\.txt$/i.test(p.url ?? ''),
  );
}

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

/** Alerts from an audit compared with the one before it. */
export function evaluateAlerts(
  prev: AuditResult | null | undefined,
  next: AuditResult,
  rules: Partial<AlertRules> = {},
): Alert[] {
  const R = { ...DEFAULT_RULES, ...rules };
  const site = siteIdFromUrl(next.site);
  const out: Alert[] = [];
  if (!prev) return out;
  const diff = diffAudits(prev, next);

  if (R.scoreDrop > 0 && -diff.scoreDelta >= R.scoreDrop) {
    out.push({
      key: makeKey('score-drop', site, `${prev.id}>${next.id}`),
      rule: 'score-drop',
      site,
      level: -diff.scoreDelta >= R.scoreDrop * 2 ? 'critical' : 'warning',
      title: `Score fell ${-diff.scoreDelta} points to ${next.score.overall}`,
      detail: `The AI Visibility Score for ${next.site} went from ${prev.score.overall} (${prev.score.grade}) to ${next.score.overall} (${next.score.grade}).`,
    });
  }

  if (R.newCritical) {
    const crit = diff.newIssues.filter((i) => sevOf(i, next) === 'critical');
    if (crit.length) {
      const byCheck = new Map<string, Issue[]>();
      for (const i of crit) byCheck.set(i.checkId, [...(byCheck.get(i.checkId) ?? []), i]);
      const titles = [...byCheck.keys()].map((id) => next.checks[id]?.title ?? id);
      out.push({
        key: makeKey('new-critical', site, crit.map(issueKey).sort().join(',')),
        rule: 'new-critical',
        site,
        level: 'critical',
        title: `${crit.length} new critical issue${crit.length === 1 ? '' : 's'}`,
        detail: titles.join('; '),
        urls: crit
          .map((i) => i.url)
          .filter((u): u is string => !!u)
          .slice(0, MAX_URLS),
      });
    }
  }

  const prevPages = new Map(prev.pages.map((p) => [p.url, p]));
  const noindex: string[] = [];
  const errors: { url: string; status: number }[] = [];
  for (const p of next.pages) {
    const a = prevPages.get(p.url);
    if (!a) continue;
    const wasOk = a.status >= 200 && a.status < 400;
    if (wasOk && (p.status >= 400 || p.status === 0)) errors.push({ url: p.url, status: p.status });
    else if (a.indexable && !p.indexable && p.status >= 200 && p.status < 300) noindex.push(p.url);
  }
  if (R.pageNoindex && noindex.length)
    out.push({
      key: makeKey('page-noindex', site, noindex.sort().join(',')),
      rule: 'page-noindex',
      site,
      level: 'critical',
      title: `${noindex.length} page${noindex.length === 1 ? '' : 's'} stopped being indexable`,
      detail:
        'These pages were indexable in the last audit and now are not (noindex, a canonical to another URL, or blocked by robots.txt).',
      urls: noindex.slice(0, MAX_URLS),
    });
  if (R.pageError && errors.length)
    out.push({
      key: makeKey(
        'page-error',
        site,
        errors
          .map((e) => `${e.url}=${e.status}`)
          .sort()
          .join(','),
      ),
      rule: 'page-error',
      site,
      level: errors.some((e) => e.status >= 500 || e.status === 0) ? 'critical' : 'warning',
      title: `${errors.length} page${errors.length === 1 ? '' : 's'} now return${errors.length === 1 ? 's' : ''} an error`,
      detail: errors
        .slice(0, MAX_URLS)
        .map((e) => `${e.url} → ${e.status || 'no response'}`)
        .join('\n'),
      urls: errors.map((e) => e.url).slice(0, MAX_URLS),
    });

  if (R.aiBotBlocked) {
    const before = new Map((prev.botFetches ?? []).map((b) => [b.token, b.verdict]));
    const blocked = (next.botFetches ?? []).filter(
      (b) => b.verdict === 'blocked' && before.has(b.token) && before.get(b.token) !== 'blocked',
    );
    const robotIssues = diff.newIssues.filter(
      (i) =>
        next.checks[i.checkId]?.category === 'ai-crawlers' &&
        ['critical', 'high'].includes(sevOf(i, next)),
    );
    if (blocked.length || robotIssues.length) {
      const names = blocked.map((b) => `${b.token} (${b.operator})`);
      const lines = [
        ...(names.length ? [`Now blocked on a live fetch: ${names.join(', ')}.`] : []),
        ...robotIssues.map((i) => i.message),
      ];
      out.push({
        key: makeKey(
          'ai-bot-blocked',
          site,
          [...blocked.map((b) => b.token), ...robotIssues.map(issueKey)].sort().join(','),
        ),
        rule: 'ai-bot-blocked',
        site,
        level: 'critical',
        title: names.length
          ? `AI crawler${names.length === 1 ? '' : 's'} newly blocked: ${blocked.map((b) => b.token).join(', ')}`
          : 'AI crawler access got worse',
        detail: lines.join('\n'),
      });
    }
  }

  if (R.robotsChanged) {
    const a = prev.robots ?? { found: false, body: '' };
    const b = next.robots ?? { found: false, body: '' };
    if (a.found && !b.found)
      out.push({
        key: makeKey('robots-changed', site, `gone:${hash(a.body)}`),
        rule: 'robots-changed',
        site,
        level: 'critical',
        title: 'robots.txt disappeared',
        detail: `${next.site}/robots.txt was found in the last audit and now returns ${b.status ?? 'no response'}.`,
      });
    else if (a.found !== b.found || (b.found && a.body.trim() !== b.body.trim()))
      out.push({
        key: makeKey('robots-changed', site, `${hash(a.body)}>${hash(b.body)}`),
        rule: 'robots-changed',
        site,
        level: 'warning',
        title: a.found ? 'robots.txt changed' : 'robots.txt appeared',
        detail: 'Check that the change does not block search or AI crawlers you want.',
      });
  }

  if (R.llmsTxtChanged) {
    const a = llmsProbe(prev);
    const b = llmsProbe(next);
    if (a?.found && !b?.found)
      out.push({
        key: makeKey('llms-txt-changed', site, `gone:${hash(a.body ?? '')}`),
        rule: 'llms-txt-changed',
        site,
        level: 'warning',
        title: 'llms.txt disappeared',
        detail: `${a.url} was found in the last audit and now returns ${b?.status ?? 'no response'}.`,
      });
    else if (a?.found && b?.found && (a.body ?? '').trim() !== (b.body ?? '').trim())
      out.push({
        key: makeKey('llms-txt-changed', site, `${hash(a.body ?? '')}>${hash(b.body ?? '')}`),
        rule: 'llms-txt-changed',
        site,
        level: 'info',
        title: 'llms.txt changed',
        detail: `${b.url} has new content since the last audit.`,
      });
  }

  if (prev.visibility && next.visibility)
    out.push(...evaluateVisibilityAlerts(prev.visibility, next.visibility, R, site));
  return out;
}

/** Alerts from two AI visibility runs. */
export function evaluateVisibilityAlerts(
  prev: VisibilityRun,
  next: VisibilityRun,
  rules: Partial<AlertRules> = {},
  siteId?: string,
): Alert[] {
  const R = { ...DEFAULT_RULES, ...rules };
  const site = siteId ?? siteIdFromUrl(`https://${next.brand.domain}`);
  const out: Alert[] = [];
  const drop = (prev.summary.mentionRate ?? 0) - (next.summary.mentionRate ?? 0);
  if (R.mentionRateDrop > 0 && drop >= R.mentionRateDrop - 1e-9)
    out.push({
      key: makeKey('mention-rate-drop', site, `${prev.id}>${next.id}`),
      rule: 'mention-rate-drop',
      site,
      level: drop >= R.mentionRateDrop * 2 ? 'critical' : 'warning',
      title: `AI engines name ${next.brand.name} less often: ${pct(prev.summary.mentionRate)} → ${pct(next.summary.mentionRate)}`,
      detail: `Across the tracked prompts, ${next.brand.name} was named in ${pct(next.summary.mentionRate)} of answers, down from ${pct(prev.summary.mentionRate)}.`,
    });

  if (R.competitorOvertakes) {
    const share = (r: VisibilityRun) =>
      new Map((r.summary.shareOfVoice ?? []).map((s) => [s.name.toLowerCase(), s]));
    const a = share(prev);
    const b = share(next);
    const brandBefore = (prev.summary.shareOfVoice ?? []).find((s) => s.isBrand)?.share ?? 0;
    const brandNow = (next.summary.shareOfVoice ?? []).find((s) => s.isBrand)?.share ?? 0;
    const overtakers = [...b.values()].filter((s) => {
      if (s.isBrand) return false;
      const before = a.get(s.name.toLowerCase())?.share ?? 0;
      return before <= brandBefore && s.share > brandNow;
    });
    if (overtakers.length)
      out.push({
        key: makeKey(
          'competitor-overtakes',
          site,
          overtakers
            .map((o) => o.name.toLowerCase())
            .sort()
            .join(',') + `@${next.id}`,
        ),
        rule: 'competitor-overtakes',
        site,
        level: 'warning',
        title: `${overtakers.map((o) => o.name).join(', ')} now ${overtakers.length === 1 ? 'has' : 'have'} a bigger share of AI answers than ${next.brand.name}`,
        detail: overtakers
          .map((o) => `${o.name}: ${pct(o.share)} share of voice (yours: ${pct(brandNow)})`)
          .join('\n'),
      });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type WebhookFlavour = 'slack' | 'discord' | 'teams' | 'generic';

export function webhookFlavour(url: string): WebhookFlavour {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  })();
  if (/(^|\.)hooks\.slack\.com$/.test(host)) return 'slack';
  if (/(^|\.)(discord|discordapp)\.com$/.test(host)) return 'discord';
  if (/webhook\.office\.com$|\.logic\.azure\.com$|outlook\.office\.com$/.test(host)) return 'teams';
  return 'generic';
}

const LEVEL_MARK: Record<Alert['level'], string> = {
  critical: '[critical]',
  warning: '[warning]',
  info: '[info]',
};

export function alertsText(alerts: Alert[], ctx: { site: string; reportUrl?: string }): string {
  const lines = [
    `AI Visibility Checker: ${alerts.length} alert${alerts.length === 1 ? '' : 's'} for ${ctx.site}`,
  ];
  for (const a of alerts) {
    lines.push('', `${LEVEL_MARK[a.level]} ${a.title}`, a.detail);
    if (a.urls?.length) lines.push(...a.urls.map((u) => `- ${u}`));
  }
  if (ctx.reportUrl) lines.push('', `Report: ${ctx.reportUrl}`);
  return lines.join('\n');
}

/** JSON body for an incoming webhook, shaped for the detected service. */
export function webhookPayload(
  url: string,
  alerts: Alert[],
  ctx: { site: string; reportUrl?: string },
): Record<string, unknown> {
  const text = alertsText(alerts, ctx);
  switch (webhookFlavour(url)) {
    case 'slack':
      return { text };
    case 'discord':
      return {
        content: text.length > 1990 ? text.slice(0, 1987) + '...' : text,
        username: 'AI Visibility Checker',
      };
    case 'teams':
      return {
        '@type': 'MessageCard',
        '@context': 'https://schema.org/extensions',
        summary: `AI Visibility Checker alerts for ${ctx.site}`,
        themeColor: alerts.some((a) => a.level === 'critical') ? 'F0616D' : 'F2C14E',
        title: `AI Visibility Checker: ${ctx.site}`,
        text: text.replace(/\n/g, '<br>'),
      };
    default:
      return { text, content: text, site: ctx.site, alerts };
  }
}

export interface MailTransport {
  sendMail(msg: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
}

export interface SendAlertsOptions {
  store?: Pick<Store, 'alertSentWithin' | 'markAlertSent'>;
  dryRun?: boolean;
  /** Hours within which an identical alert is not resent. Default 168 (7 days). */
  dedupeHours?: number;
  reportUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injected mail transport (tests); otherwise nodemailer with config.alerts.email.smtpUrl. */
  transport?: MailTransport;
  now?: Date;
}

export interface Delivery {
  channel: 'webhook' | 'email';
  ok: boolean;
  error?: string;
  payload: unknown;
}

export interface SendAlertsResult {
  sent: Alert[];
  suppressed: Alert[];
  deliveries: Delivery[];
  dryRun: boolean;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function emailHtml(alerts: Alert[], ctx: { site: string; reportUrl?: string }): string {
  const colour = { critical: '#f0616d', warning: '#f2c14e', info: '#0092d3' };
  const items = alerts
    .map(
      (
        a,
      ) => `<div style="border-left:3px solid ${colour[a.level]};padding:8px 12px;margin:12px 0;background:#101013">
<div style="font-weight:600;color:#e8e8e8">${escapeHtml(a.title)}</div>
<div style="color:#9aa4ae;white-space:pre-line">${escapeHtml(a.detail)}</div>
${a.urls?.length ? `<ul style="color:#9aa4ae">${a.urls.map((u) => `<li>${escapeHtml(u)}</li>`).join('')}</ul>` : ''}</div>`,
    )
    .join('');
  return `<div style="font-family:system-ui,sans-serif;background:#0a0a0b;color:#e8e8e8;padding:20px">
<h2 style="margin:0 0 8px">AI Visibility Checker alerts for ${escapeHtml(ctx.site)}</h2>${items}
${ctx.reportUrl ? `<p><a style="color:#0092d3" href="${escapeHtml(ctx.reportUrl)}">Open the report</a></p>` : ''}
<p style="color:#9aa4ae;font-size:12px">Sent by AI Visibility Checker from Devs Core, running on your machine.</p></div>`;
}

export async function sendAlerts(
  alerts: Alert[],
  config: Pick<AvcConfig, 'alerts'>,
  opts: SendAlertsOptions = {},
): Promise<SendAlertsResult> {
  const dryRun = !!opts.dryRun;
  const hours = opts.dedupeHours ?? 168;
  const now = opts.now ?? new Date();
  const fresh: Alert[] = [];
  const suppressed: Alert[] = [];
  const seen = new Set<string>();
  for (const a of alerts) {
    if (seen.has(a.key) || opts.store?.alertSentWithin(a.key, hours, now)) suppressed.push(a);
    else fresh.push(a);
    seen.add(a.key);
  }
  const res: SendAlertsResult = { sent: [], suppressed, deliveries: [], dryRun };
  if (!fresh.length) return res;

  const site = fresh[0].site;
  const ctx = { site, reportUrl: opts.reportUrl };
  const webhookUrl = config.alerts?.webhookUrl;
  const email = config.alerts?.email;

  if (webhookUrl) {
    const payload = webhookPayload(webhookUrl, fresh, ctx);
    if (dryRun) res.deliveries.push({ channel: 'webhook', ok: true, payload });
    else {
      try {
        const f = opts.fetchImpl ?? fetch;
        const r = await f(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        });
        res.deliveries.push({
          channel: 'webhook',
          ok: r.ok,
          payload,
          ...(r.ok ? {} : { error: `HTTP ${r.status}` }),
        });
      } catch (e) {
        res.deliveries.push({
          channel: 'webhook',
          ok: false,
          payload,
          error: String((e as Error)?.message ?? e),
        });
      }
    }
  }

  if (email?.to) {
    const critical = fresh.filter((a) => a.level === 'critical').length;
    const msg = {
      from: email.from || 'AI Visibility Checker <avc@localhost>',
      to: email.to,
      subject: `${critical ? `${critical} critical: ` : ''}${fresh[0].title}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''} — ${site}`,
      text: alertsText(fresh, ctx),
      html: emailHtml(fresh, ctx),
    };
    if (dryRun) res.deliveries.push({ channel: 'email', ok: true, payload: msg });
    else {
      try {
        let transport = opts.transport;
        if (!transport) {
          if (!email.smtpUrl)
            throw new Error('No SMTP URL set (alerts.email.smtpUrl or AVC_SMTP_URL).');
          const nodemailer = await import('nodemailer');
          transport = nodemailer.createTransport(email.smtpUrl) as unknown as MailTransport;
        }
        await transport.sendMail(msg);
        res.deliveries.push({ channel: 'email', ok: true, payload: msg });
      } catch (e) {
        res.deliveries.push({
          channel: 'email',
          ok: false,
          payload: msg,
          error: String((e as Error)?.message ?? e),
        });
      }
    }
  }

  const delivered = res.deliveries.some((d) => d.ok);
  if (delivered) {
    res.sent = fresh;
    if (!dryRun && opts.store) {
      const channels = res.deliveries
        .filter((d) => d.ok)
        .map((d) => d.channel)
        .join(',');
      for (const a of fresh) opts.store.markAlertSent(a.key, a.site, a.rule, channels, now);
    }
  }
  return res;
}
