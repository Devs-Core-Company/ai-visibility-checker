import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditResult, PageSummary } from '../src/core/types.js';
import type { AvcConfig } from '../src/core/config.js';
import {
  evaluateAlerts,
  evaluateVisibilityAlerts,
  sendAlerts,
  webhookFlavour,
  webhookPayload,
} from '../src/monitor/alerts.js';
import { diffAudits, diffVisibility } from '../src/monitor/diff.js';
import {
  installSystemSchedule,
  runScheduledOnce,
  startScheduler,
} from '../src/monitor/scheduler.js';
import { openStore, SCHEMA_VERSION, type Store } from '../src/monitor/store.js';
import { config, def, minimalResult, visibilityRun } from './audit-fixtures.js';

function row(url: string, over: Partial<PageSummary> = {}): PageSummary {
  return {
    url,
    finalUrl: url,
    status: 200,
    depth: 1,
    title: 'T',
    metaDescription: 'D',
    h1: 'H',
    wordCount: 500,
    canonical: url,
    indexable: true,
    inlinks: 1,
    outlinks: 1,
    bytes: 1,
    ttfbMs: 1,
    schemaTypes: [],
    issues: 0,
    inSitemap: true,
    ...over,
  };
}

function audit(id: string, at: string, over: Partial<AuditResult> = {}): AuditResult {
  return minimalResult({
    id,
    at,
    checks: {
      'onpage.title': {
        ...def('onpage.title', { severity: 'critical' }),
        status: 'ran',
        affected: 1,
      },
      'ai-crawlers.blocked': {
        ...def('ai-crawlers.blocked', {
          category: 'ai-crawlers',
          pillar: 'ai-access',
          severity: 'high',
          scope: 'site',
        }),
        status: 'ran',
        affected: 0,
      },
    },
    score: {
      overall: 80,
      grade: 'B',
      pillars: [
        { pillar: 'technical', score: 80, weight: 26.7, passed: 3, failed: 1, skipped: 0 },
        { pillar: 'ai-visibility', score: 0, weight: 0, passed: 0, failed: 0, skipped: 0 },
      ],
    },
    pages: [row('https://example.com/'), row('https://example.com/a')],
    ...over,
  });
}

describe('diffAudits', () => {
  it('finds new, fixed, added, removed and changed', () => {
    const prev = audit('a1', '2026-01-01T00:00:00Z', {
      issues: [
        { checkId: 'onpage.title', url: 'https://example.com/a', message: 'x' },
        { checkId: 'robots.x', message: 'site' },
      ],
      pages: [
        row('https://example.com/'),
        row('https://example.com/a'),
        row('https://example.com/old'),
      ],
    });
    const next = audit('a2', '2026-01-08T00:00:00Z', {
      score: {
        ...prev.score,
        overall: 70,
        pillars: [{ ...prev.score.pillars[0], score: 65 }, prev.score.pillars[1]],
      },
      issues: [
        { checkId: 'onpage.title', url: 'https://example.com/a', message: 'x' },
        { checkId: 'onpage.title', url: 'https://example.com/', message: 'x' },
      ],
      pages: [
        row('https://example.com/', { title: 'New', wordCount: 700 }),
        row('https://example.com/a', { wordCount: 550 }),
        row('https://example.com/new'),
      ],
    });
    const d = diffAudits(prev, next);
    expect(d.scoreDelta).toBe(-10);
    expect(d.pillarDeltas).toEqual([{ pillar: 'technical', delta: -15 }]);
    expect(d.newIssues.map((i) => i.url)).toEqual(['https://example.com/']);
    expect(d.fixedIssues.map((i) => i.checkId)).toEqual(['robots.x']);
    expect(d.newPages).toEqual(['https://example.com/new']);
    expect(d.removedPages).toEqual(['https://example.com/old']);
    expect(d.changedPages).toEqual([
      { url: 'https://example.com/', fields: ['title', 'wordCount'] },
    ]);
  });

  it('diffs visibility runs', () => {
    const a = visibilityRun();
    const b = visibilityRun(
      {
        mentionRate: 1,
        shareOfVoice: [
          { name: 'Example', share: 0.5, mentions: 2, isBrand: true },
          { name: 'Newco', share: 0.5, mentions: 2, isBrand: false },
        ],
      },
      'v2',
    );
    b.answers = b.answers.map((x) => ({ ...x, mentioned: true }));
    const v = diffVisibility(a, b);
    expect(v.mentionRateDelta).toBe(0.5);
    expect(v.shareOfVoiceDelta).toBeCloseTo(0.1);
    expect(v.newCompetitors).toEqual(['Newco']);
    expect(v.wonPrompts).toEqual(['example vs rival']);
    expect(v.lostPrompts).toEqual([]);
    const d = diffAudits(
      audit('a', '2026-01-01', { visibility: a }),
      audit('b', '2026-01-02', { visibility: b }),
    );
    expect(d.visibility?.wonPrompts).toEqual(['example vs rival']);
  });
});

describe('store', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'avc-store-'));
    store = openStore(dir);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates and round-trips audits', () => {
    expect(
      (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);
    const a = audit('a1', '2026-01-01T00:00:00Z', {
      issues: [{ checkId: 'onpage.title', url: 'https://example.com/a', message: 'x' }],
    });
    const b = audit('a2', '2026-01-08T00:00:00Z', {
      score: { ...a.score, overall: 60, grade: 'C' },
      visibility: visibilityRun(),
    });
    store.saveAudit(a);
    store.saveAudit(b);
    expect(store.getAudit('a1')).toEqual(a);
    expect(store.latestAudit('example.com')?.id).toBe('a2');
    expect(store.latestAudit('example.com', { before: '2026-01-05' })?.id).toBe('a1');
    expect(store.previousAudit('a2')?.id).toBe('a1');
    expect(store.previousAudit('a1')).toBeNull();
    const rows = store.listAudits('example.com');
    expect(rows.map((r) => r.id)).toEqual(['a2', 'a1']);
    expect(rows[0]).toMatchObject({
      score: 60,
      grade: 'C',
      readinessOnly: false,
      pillars: { technical: 80 },
    });
    expect(store.listSites().map((s) => s.id)).toEqual(['example.com']);

    // Visibility saved with the audit, spend recorded once even if saved again.
    expect(store.listVisibility('example.com')).toHaveLength(1);
    store.saveAudit(b);
    store.saveVisibility(visibilityRun(), 'example.com');
    expect(store.monthSpend('2026-01')).toBeCloseTo(0.02);
    store.recordSpend(1.5, { date: new Date('2026-01-20T00:00:00Z') });
    expect(store.monthSpend('2026-01')).toBeCloseTo(1.52);
    expect(store.getVisibility('v1')?.summary.mentionRate).toBe(0.5);
  });

  it('builds trends', () => {
    store.saveAudit(
      audit('a1', '2026-01-01T00:00:00Z', {
        issues: [{ checkId: 'onpage.title', url: 'u', message: 'x' }],
      }),
    );
    store.saveAudit(audit('a2', '2026-01-08T00:00:00Z', { visibility: visibilityRun() }));
    const t = store.trends('example.com');
    expect(t.audits.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(t.audits[0].bySeverity.critical).toBe(1);
    expect(t.audits[1].bySeverity.critical).toBe(0);
    expect(t.visibility[0]).toMatchObject({ mentionRate: 0.5, shareOfVoice: 0.4, citedOwn: 1 });
    expect(t.visibility[0].byEngine.chatgpt).toEqual({ mentionRate: 1, answers: 1 });
  });

  it('deletes a site, keeps spend; schedules and alert dedupe', () => {
    store.saveAudit(audit('a1', '2026-01-01T00:00:00Z', { visibility: visibilityRun() }));
    store.setSchedule('example.com', { audit: '0 6 * * 1' });
    store.markScheduledRun('example.com', 'audit', new Date('2026-01-01T06:00:00Z'));
    expect(store.getSchedule('example.com')).toMatchObject({
      auditCron: '0 6 * * 1',
      lastAuditRun: '2026-01-01T06:00:00.000Z',
    });
    const now = new Date('2026-02-01T00:00:00Z');
    store.markAlertSent('k', 'example.com', 'score-drop', 'webhook', now);
    expect(store.alertSentWithin('k', 24, new Date('2026-02-01T12:00:00Z'))).toBe(true);
    expect(store.alertSentWithin('k', 24, new Date('2026-02-03T00:00:00Z'))).toBe(false);
    store.deleteSite('example.com');
    expect(store.getAudit('a1')).toBeNull();
    expect(store.listSites()).toEqual([]);
    expect(store.getSchedule('example.com')).toBeNull();
    expect(store.monthSpend('2026-01')).toBeCloseTo(0.02);
  });

  it('reopens an existing database without re-migrating', () => {
    store.saveAudit(audit('a1', '2026-01-01T00:00:00Z'));
    store.close();
    store = openStore(dir);
    expect(store.getAudit('a1')?.id).toBe('a1');
  });
});

describe('alerts', () => {
  const prev = audit('a1', '2026-01-01T00:00:00Z', {
    robots: { found: true, status: 200, body: 'User-agent: *\nAllow: /' },
    probes: [
      {
        id: 'llms-txt',
        url: 'https://example.com/llms.txt',
        status: 200,
        found: true,
        body: '# Example',
      },
    ],
    botFetches: [
      {
        token: 'GPTBot',
        operator: 'OpenAI',
        purpose: 'training',
        status: 200,
        bytes: 1,
        words: 1,
        challenge: null,
        verdict: 'ok',
        ms: 1,
      },
    ],
  });
  const next = audit('a2', '2026-01-08T00:00:00Z', {
    score: { ...prev.score, overall: 70, grade: 'C' },
    issues: [{ checkId: 'onpage.title', url: 'https://example.com/a', message: 'Missing title' }],
    pages: [
      row('https://example.com/', { indexable: false }),
      row('https://example.com/a', { status: 500 }),
    ],
    robots: { found: true, status: 200, body: 'User-agent: *\nDisallow: /' },
    probes: [{ id: 'llms-txt', url: 'https://example.com/llms.txt', status: 404, found: false }],
    botFetches: [
      {
        token: 'GPTBot',
        operator: 'OpenAI',
        purpose: 'training',
        status: 403,
        bytes: 1,
        words: 0,
        challenge: 'cloudflare',
        verdict: 'blocked',
        ms: 1,
      },
    ],
  });

  it('evaluates every audit rule', () => {
    const alerts = evaluateAlerts(prev, next);
    expect(alerts.map((a) => a.rule).sort()).toEqual(
      [
        'ai-bot-blocked',
        'llms-txt-changed',
        'new-critical',
        'page-error',
        'page-noindex',
        'robots-changed',
        'score-drop',
      ].sort(),
    );
    expect(alerts.find((a) => a.rule === 'score-drop')!.level).toBe('critical');
    expect(evaluateAlerts(null, next)).toEqual([]);
    expect(
      evaluateAlerts(prev, next, { scoreDrop: 20, robotsChanged: false }).map((a) => a.rule),
    ).not.toContain('score-drop');
    // Stable keys
    expect(evaluateAlerts(prev, next).map((a) => a.key)).toEqual(alerts.map((a) => a.key));
  });

  it('evaluates visibility rules', () => {
    const a = visibilityRun({
      mentionRate: 0.6,
      shareOfVoice: [
        { name: 'Example', share: 0.6, mentions: 3, isBrand: true },
        { name: 'Rival', share: 0.4, mentions: 2, isBrand: false },
      ],
    });
    const b = visibilityRun(
      {
        mentionRate: 0.3,
        shareOfVoice: [
          { name: 'Example', share: 0.3, mentions: 1, isBrand: true },
          { name: 'Rival', share: 0.7, mentions: 3, isBrand: false },
        ],
      },
      'v2',
    );
    const alerts = evaluateVisibilityAlerts(a, b, {}, 'example.com');
    expect(alerts.map((x) => x.rule)).toEqual(['mention-rate-drop', 'competitor-overtakes']);
    expect(alerts[0].level).toBe('critical');
    expect(alerts[1].title).toMatch(/Rival/);
  });

  it('shapes webhook payloads per service', () => {
    const al = evaluateAlerts(prev, next);
    expect(webhookFlavour('https://hooks.slack.com/services/x')).toBe('slack');
    expect(webhookFlavour('https://discord.com/api/webhooks/1/x')).toBe('discord');
    expect(webhookFlavour('https://acme.webhook.office.com/x')).toBe('teams');
    expect(webhookPayload('https://hooks.slack.com/x', al, { site: 'example.com' })).toHaveProperty(
      'text',
    );
    const disc = webhookPayload('https://discord.com/api/webhooks/1/x', al, {
      site: 'example.com',
    }) as { content: string };
    expect(disc.content.length).toBeLessThanOrEqual(2000);
    expect(
      webhookPayload('https://acme.webhook.office.com/x', al, { site: 'example.com' }),
    ).toHaveProperty('@type', 'MessageCard');
    expect(webhookPayload('https://example.org/hook', al, { site: 'example.com' })).toHaveProperty(
      'alerts',
    );
  });

  it('dry-runs, sends, and de-duplicates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avc-alerts-'));
    const store = openStore(dir);
    try {
      const cfg: Pick<AvcConfig, 'alerts'> = {
        alerts: {
          webhookUrl: 'https://hooks.slack.com/x',
          email: { to: 'me@example.com', smtpUrl: 'smtp://localhost' },
        },
      };
      const alerts = evaluateAlerts(prev, next);
      const dry = await sendAlerts(alerts, cfg, { store, dryRun: true });
      expect(dry.deliveries.map((d) => d.channel)).toEqual(['webhook', 'email']);
      expect(dry.sent).toHaveLength(alerts.length);

      const posted: unknown[] = [];
      const mails: unknown[] = [];
      const fetchImpl = (async (_u: string, init: RequestInit) => {
        posted.push(JSON.parse(String(init.body)));
        return new Response('ok', { status: 200 });
      }) as unknown as typeof fetch;
      const transport = { sendMail: async (m: unknown) => void mails.push(m) };
      const real = await sendAlerts(alerts, cfg, { store, fetchImpl, transport });
      expect(real.deliveries.every((d) => d.ok)).toBe(true);
      expect(posted).toHaveLength(1);
      expect(mails).toHaveLength(1);
      expect((mails[0] as { subject: string }).subject).toMatch(/critical/);

      const again = await sendAlerts(alerts, cfg, { store, fetchImpl, transport });
      expect(again.sent).toEqual([]);
      expect(again.suppressed).toHaveLength(alerts.length);
      expect(posted).toHaveLength(1);

      const failing = await sendAlerts(
        evaluateVisibilityAlerts(
          visibilityRun({ mentionRate: 0.9 }),
          visibilityRun({ mentionRate: 0.1 }, 'v9'),
        ),
        cfg,
        {
          store,
          fetchImpl: (async () => new Response('no', { status: 500 })) as unknown as typeof fetch,
          transport: {
            sendMail: async () => {
              throw new Error('smtp down');
            },
          },
        },
      );
      expect(failing.sent).toEqual([]);
      expect(failing.deliveries.map((d) => d.error)).toEqual(['HTTP 500', 'smtp down']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scheduler', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'avc-sched-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cfg = (over: Partial<AvcConfig> = {}): AvcConfig => ({
    ...config,
    dataDir: dir,
    ai: { ...config.ai, mock: false, maxMonthUsd: 1 },
    sites: [
      {
        id: 'example.com',
        url: 'https://example.com/',
        schedule: { audit: '0 6 * * 1' },
        brand: { name: 'Example' },
        prompts: visibilityRun().prompts,
      },
    ],
    ...over,
  });

  it('runs an audit, saves it, diffs and alerts in dry-run', async () => {
    let n = 0;
    const deps = {
      runAudit: async () =>
        audit(
          `a${++n}`,
          `2026-01-0${n}T00:00:00Z`,
          n === 2 ? { score: { overall: 50, grade: 'D' as const, pillars: [] } } : {},
        ),
    };
    const c = cfg({ alerts: { webhookUrl: 'https://hooks.slack.com/x' } });
    const first = await runScheduledOnce('example.com', { config: c, deps, dryRunAlerts: true });
    expect(first.status).toBe('ok');
    expect(first.diff).toBeUndefined();
    const second = await runScheduledOnce('example.com', { config: c, deps, dryRunAlerts: true });
    expect(second.diff?.scoreDelta).toBe(-30);
    expect(second.alerts.map((a) => a.rule)).toContain('score-drop');
    expect(second.delivery?.dryRun).toBe(true);
    const store = openStore(dir);
    expect(store.listAudits('example.com')).toHaveLength(2);
    expect(store.getSchedule('example.com')?.lastAuditRun).toBeTruthy();
    store.close();
  });

  it('skips visibility once the month cap is reached', async () => {
    const store = openStore(dir);
    store.recordSpend(5);
    let asked = false;
    const r = await runScheduledOnce('example.com', {
      config: cfg(),
      kind: 'visibility',
      store,
      deps: { runVisibility: async () => ((asked = true), visibilityRun()) },
    });
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/cap/);
    expect(asked).toBe(false);
    // In an audit, visibility is switched off rather than the run skipped.
    let vis: unknown;
    const a = await runScheduledOnce('example.com', {
      config: cfg(),
      store,
      deps: { runAudit: async (o) => ((vis = o.visibility), audit('x', '2026-01-01')) },
    });
    expect(a.status).toBe('ok');
    expect(vis).toBe(false);
    store.close();
  });

  it('runs visibility-only jobs and reports unknown sites', async () => {
    const r = await runScheduledOnce('example.com', {
      config: cfg(),
      kind: 'visibility',
      deps: { runVisibility: async () => visibilityRun() },
    });
    expect(r.status).toBe('ok');
    expect(r.visibility?.id).toBe('v1');
    expect((await runScheduledOnce('nope.com', { config: cfg() })).status).toBe('error');
  });

  it('creates cron jobs and never overlaps runs for one site', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps = { runAudit: async () => (await gate, audit('a1', '2026-01-01')) };
    const h = startScheduler(cfg(), { deps });
    try {
      expect(h.jobs).toHaveLength(1);
      expect(h.jobs[0].nextRun).toBeInstanceOf(Date);
      const first = h.runNow('example.com', 'audit');
      const second = await h.runNow('example.com', 'audit');
      expect(second.status).toBe('skipped');
      release();
      expect((await first).status).toBe('ok');
    } finally {
      h.stop();
    }
  });

  it('prints system schedules without installing them', () => {
    const linux = installSystemSchedule('example.com', '0 6 * * 1', { platform: 'linux' });
    expect(linux.content).toMatch(/^0 6 \* \* 1 .*avc monitor run example\.com/);
    const mac = installSystemSchedule('example.com', '0 6 * * 1,3', { platform: 'darwin' });
    expect(mac.content).toContain('<key>Weekday</key><integer>1</integer>');
    expect(mac.content).toContain('<key>Weekday</key><integer>3</integer>');
    expect(mac.warning).toBeUndefined();
    expect(
      installSystemSchedule('example.com', '*/15 * * * *', { platform: 'darwin' }).warning,
    ).toBeTruthy();
    const win = installSystemSchedule('example.com', '30 6 * * 1', { platform: 'win32' });
    expect(win.content).toContain('/SC WEEKLY /D MON /ST 06:30');
    expect(
      installSystemSchedule('example.com', '0 7 * * *', { platform: 'win32' }).content,
    ).toContain('/SC DAILY /ST 07:00');
    expect(() => installSystemSchedule('x', 'bad')).toThrow();
  });
});
