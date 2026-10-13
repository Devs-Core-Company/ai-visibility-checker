/**
 * Local history: SQLite through node:sqlite (built into Node 22.5+, no native build).
 *
 * Full audit results are stored brotli-compressed; issues and per-answer
 * visibility rows are also kept flat so trends and queries stay fast.
 * Schema changes go through MIGRATIONS, keyed by PRAGMA user_version.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants as zc } from 'node:zlib';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import { siteIdFromUrl } from '../core/config.js';
import type { AuditResult, EngineId, Pillar, Severity, VisibilityRun } from '../core/types.js';

const require = createRequire(import.meta.url);
let sqliteMod: typeof import('node:sqlite') | null = null;

/** Load node:sqlite once, without printing its ExperimentalWarning. */
function loadSqlite(): typeof import('node:sqlite') {
  if (sqliteMod) return sqliteMod;
  const original = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (/sqlite/i.test(text ?? '')) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqliteMod = require('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
  return sqliteMod;
}

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE sites (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_audit_at TEXT
  );
  CREATE TABLE audits (
    id TEXT PRIMARY KEY,
    site TEXT NOT NULL,
    at TEXT NOT NULL,
    score INTEGER NOT NULL,
    grade TEXT NOT NULL,
    readiness_only INTEGER NOT NULL DEFAULT 1,
    pillars TEXT NOT NULL,
    pages INTEGER NOT NULL,
    issues INTEGER NOT NULL,
    version TEXT,
    json BLOB NOT NULL
  );
  CREATE INDEX audits_site_at ON audits(site, at);
  CREATE TABLE issues (
    audit_id TEXT NOT NULL,
    check_id TEXT NOT NULL,
    url TEXT,
    severity TEXT NOT NULL
  );
  CREATE INDEX issues_audit ON issues(audit_id);
  CREATE INDEX issues_check ON issues(check_id);
  CREATE TABLE visibility_runs (
    id TEXT PRIMARY KEY,
    site TEXT NOT NULL,
    at TEXT NOT NULL,
    audit_id TEXT,
    mention_rate REAL NOT NULL,
    share_of_voice REAL NOT NULL,
    cited_own INTEGER NOT NULL,
    answers INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    json BLOB NOT NULL
  );
  CREATE INDEX visibility_site_at ON visibility_runs(site, at);
  CREATE TABLE visibility_answers (
    run_id TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    mentioned INTEGER NOT NULL,
    position INTEGER,
    sentiment TEXT,
    cited_own INTEGER NOT NULL,
    error TEXT
  );
  CREATE INDEX visibility_answers_run ON visibility_answers(run_id);
  CREATE TABLE spend (
    date TEXT NOT NULL,
    usd REAL NOT NULL,
    kind TEXT NOT NULL DEFAULT 'visibility',
    ref TEXT
  );
  CREATE INDEX spend_date ON spend(date);
  CREATE TABLE schedules (
    site TEXT PRIMARY KEY,
    audit_cron TEXT,
    visibility_cron TEXT,
    last_audit_run TEXT,
    last_visibility_run TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE alerts_sent (
    key TEXT NOT NULL,
    site TEXT NOT NULL,
    rule TEXT NOT NULL,
    at TEXT NOT NULL,
    channel TEXT
  );
  CREATE INDEX alerts_sent_key ON alerts_sent(key, at);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export interface AuditRow {
  id: string;
  site: string;
  at: string;
  score: number;
  grade: AuditResult['score']['grade'];
  readinessOnly: boolean;
  pillars: Partial<Record<Pillar, number>>;
  pages: number;
  issues: number;
}

export interface VisibilityRow {
  id: string;
  site: string;
  at: string;
  auditId: string | null;
  mentionRate: number;
  shareOfVoice: number;
  citedOwn: number;
  answers: number;
  costUsd: number;
}

export interface Trends {
  site: string;
  audits: (AuditRow & { bySeverity: Record<Severity, number> })[];
  visibility: (VisibilityRow & {
    byEngine: Partial<Record<EngineId, { mentionRate: number; answers: number }>>;
  })[];
}

export interface ScheduleRow {
  site: string;
  auditCron: string | null;
  visibilityCron: string | null;
  lastAuditRun: string | null;
  lastVisibilityRun: string | null;
}

export interface Store {
  readonly path: string;
  readonly db: DatabaseSyncT;
  saveAudit(result: AuditResult, siteId?: string): string;
  getAudit(id: string): AuditResult | null;
  listAudits(site: string, limit?: number): AuditRow[];
  latestAudit(site: string, opts?: { before?: string }): AuditResult | null;
  /** The audit saved just before this one for the same site. */
  previousAudit(id: string): AuditResult | null;
  saveVisibility(run: VisibilityRun, siteId: string, auditId?: string): string;
  getVisibility(id: string): VisibilityRun | null;
  listVisibility(site: string, limit?: number): VisibilityRow[];
  latestVisibility(site: string, opts?: { before?: string }): VisibilityRun | null;
  trends(site: string, limit?: number): Trends;
  /** USD spent in a calendar month (UTC). Default: this month. */
  monthSpend(month?: string): number;
  recordSpend(usd: number, opts?: { kind?: string; ref?: string; date?: Date }): void;
  listSites(): { id: string; url: string; createdAt: string; lastAuditAt: string | null }[];
  deleteSite(site: string): void;
  setSchedule(site: string, s: { audit?: string | null; visibility?: string | null }): void;
  getSchedule(site: string): ScheduleRow | null;
  markScheduledRun(site: string, kind: 'audit' | 'visibility', at?: Date): void;
  /** True if an alert with this key was sent within the window. */
  alertSentWithin(key: string, hours: number, now?: Date): boolean;
  markAlertSent(key: string, site: string, rule: string, channel?: string, at?: Date): void;
  close(): void;
}

function pack(value: unknown): Uint8Array {
  return brotliCompressSync(Buffer.from(JSON.stringify(value)), {
    params: { [zc.BROTLI_PARAM_QUALITY]: 5 },
  });
}

function unpack<T>(blob: unknown): T {
  const buf = Buffer.from(blob as Uint8Array);
  return JSON.parse(brotliDecompressSync(buf).toString('utf8')) as T;
}

function brandShare(run: VisibilityRun): number {
  return run.summary.shareOfVoice?.find((s) => s.isBrand)?.share ?? 0;
}

function citedOwnCount(run: VisibilityRun): number {
  return Object.values(run.summary.byEngine ?? {}).reduce((n, e) => n + (e.citedOwnSite || 0), 0);
}

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function openStore(dataDir: string, opts: { filename?: string } = {}): Store {
  const { DatabaseSync } = loadSqlite();
  const path =
    opts.filename === ':memory:' ? ':memory:' : join(dataDir, opts.filename ?? 'avc.sqlite');
  if (path !== ':memory:') mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  const current = Number(
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
  );
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const upsertSite = (id: string, url: string, at?: string, keepUrl = false) => {
    if (keepUrl) {
      // Only register an unknown site; never overwrite a URL learnt from an audit.
      db.prepare('INSERT OR IGNORE INTO sites (id, url, created_at) VALUES (?, ?, ?)').run(
        id,
        url,
        new Date().toISOString(),
      );
      return;
    }
    db.prepare(
      `INSERT INTO sites (id, url, created_at, last_audit_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET url = excluded.url,
         last_audit_at = COALESCE(excluded.last_audit_at, sites.last_audit_at)`,
    ).run(id, url, new Date().toISOString(), at ?? null);
  };

  const toAuditRow = (r: Record<string, unknown>): AuditRow => ({
    id: String(r.id),
    site: String(r.site),
    at: String(r.at),
    score: Number(r.score),
    grade: String(r.grade) as AuditRow['grade'],
    readinessOnly: !!r.readiness_only,
    pillars: JSON.parse(String(r.pillars)),
    pages: Number(r.pages),
    issues: Number(r.issues),
  });

  const toVisRow = (r: Record<string, unknown>): VisibilityRow => ({
    id: String(r.id),
    site: String(r.site),
    at: String(r.at),
    auditId: (r.audit_id as string | null) ?? null,
    mentionRate: Number(r.mention_rate),
    shareOfVoice: Number(r.share_of_voice),
    citedOwn: Number(r.cited_own),
    answers: Number(r.answers),
    costUsd: Number(r.cost_usd),
  });

  const saveVisibility = (run: VisibilityRun, siteId: string, auditId?: string): string => {
    const exists = db.prepare('SELECT 1 FROM visibility_runs WHERE id = ?').get(run.id);
    if (exists) return run.id;
    const answers = run.answers ?? [];
    db.prepare(
      `INSERT INTO visibility_runs (id, site, at, audit_id, mention_rate, share_of_voice, cited_own, answers, cost_usd, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      siteId,
      run.at,
      auditId ?? null,
      run.summary.mentionRate ?? 0,
      brandShare(run),
      citedOwnCount(run),
      answers.length,
      run.summary.costUsd ?? 0,
      pack(run),
    );
    const ins = db.prepare(
      `INSERT INTO visibility_answers (run_id, prompt_id, engine, mentioned, position, sentiment, cited_own, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const a of answers)
      ins.run(
        run.id,
        a.promptId,
        a.engine,
        a.mentioned ? 1 : 0,
        a.position ?? null,
        a.sentiment ?? null,
        a.citations?.some((c) => c.ownSite) ? 1 : 0,
        a.error ?? null,
      );
    // Spend is recorded once, when the run is first saved.
    if (run.summary.costUsd > 0)
      db.prepare('INSERT INTO spend (date, usd, kind, ref) VALUES (?, ?, ?, ?)').run(
        run.at.slice(0, 10),
        run.summary.costUsd,
        'visibility',
        run.id,
      );
    return run.id;
  };

  const store: Store = {
    path,
    db,

    saveAudit(result, siteId) {
      const site = siteId ?? siteIdFromUrl(result.site);
      const pillars: Partial<Record<Pillar, number>> = {};
      for (const p of result.score.pillars) if (p.weight > 0) pillars[p.pillar] = p.score;
      const readinessOnly =
        (result.score as { readinessOnly?: boolean }).readinessOnly ?? !result.visibility;
      tx(() => {
        upsertSite(site, result.startUrl || result.site, result.at);
        db.prepare('DELETE FROM issues WHERE audit_id = ?').run(result.id);
        db.prepare(
          `INSERT OR REPLACE INTO audits (id, site, at, score, grade, readiness_only, pillars, pages, issues, version, json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          result.id,
          site,
          result.at,
          result.score.overall,
          result.score.grade,
          readinessOnly ? 1 : 0,
          JSON.stringify(pillars),
          result.pages.length,
          result.issues.length,
          result.version ?? null,
          pack(result),
        );
        const ins = db.prepare(
          'INSERT INTO issues (audit_id, check_id, url, severity) VALUES (?, ?, ?, ?)',
        );
        for (const i of result.issues)
          ins.run(
            result.id,
            i.checkId,
            i.url ?? null,
            i.severity ?? result.checks[i.checkId]?.severity ?? 'info',
          );
        if (result.visibility) saveVisibility(result.visibility, site, result.id);
      });
      return result.id;
    },

    getAudit(id) {
      const r = db.prepare('SELECT json FROM audits WHERE id = ?').get(id) as
        { json: Uint8Array } | undefined;
      return r ? unpack<AuditResult>(r.json) : null;
    },

    listAudits(site, limit = 20) {
      const rows = db
        .prepare(
          `SELECT id, site, at, score, grade, readiness_only, pillars, pages, issues
           FROM audits WHERE site = ? ORDER BY at DESC, rowid DESC LIMIT ?`,
        )
        .all(site, limit) as Record<string, unknown>[];
      return rows.map(toAuditRow);
    },

    latestAudit(site, o = {}) {
      const r = (
        o.before
          ? db
              .prepare(
                'SELECT json FROM audits WHERE site = ? AND at < ? ORDER BY at DESC, rowid DESC LIMIT 1',
              )
              .get(site, o.before)
          : db
              .prepare(
                'SELECT json FROM audits WHERE site = ? ORDER BY at DESC, rowid DESC LIMIT 1',
              )
              .get(site)
      ) as { json: Uint8Array } | undefined;
      return r ? unpack<AuditResult>(r.json) : null;
    },

    previousAudit(id) {
      const cur = db.prepare('SELECT site, at, rowid FROM audits WHERE id = ?').get(id) as
        { site: string; at: string; rowid: number } | undefined;
      if (!cur) return null;
      const r = db
        .prepare(
          `SELECT json FROM audits WHERE site = ? AND id != ? AND (at < ? OR (at = ? AND rowid < ?))
           ORDER BY at DESC, rowid DESC LIMIT 1`,
        )
        .get(cur.site, id, cur.at, cur.at, cur.rowid) as { json: Uint8Array } | undefined;
      return r ? unpack<AuditResult>(r.json) : null;
    },

    saveVisibility(run, siteId, auditId) {
      return tx(() => {
        upsertSite(siteId, `https://${run.brand?.domain ?? siteId}`, undefined, true);
        return saveVisibility(run, siteId, auditId);
      });
    },

    getVisibility(id) {
      const r = db.prepare('SELECT json FROM visibility_runs WHERE id = ?').get(id) as
        { json: Uint8Array } | undefined;
      return r ? unpack<VisibilityRun>(r.json) : null;
    },

    listVisibility(site, limit = 20) {
      const rows = db
        .prepare(
          'SELECT * FROM visibility_runs WHERE site = ? ORDER BY at DESC, rowid DESC LIMIT ?',
        )
        .all(site, limit) as Record<string, unknown>[];
      return rows.map(toVisRow);
    },

    latestVisibility(site, o = {}) {
      const r = (
        o.before
          ? db
              .prepare(
                'SELECT json FROM visibility_runs WHERE site = ? AND at < ? ORDER BY at DESC, rowid DESC LIMIT 1',
              )
              .get(site, o.before)
          : db
              .prepare(
                'SELECT json FROM visibility_runs WHERE site = ? ORDER BY at DESC, rowid DESC LIMIT 1',
              )
              .get(site)
      ) as { json: Uint8Array } | undefined;
      return r ? unpack<VisibilityRun>(r.json) : null;
    },

    trends(site, limit = 52) {
      const audits = store.listAudits(site, limit).reverse();
      const sevRows = audits.length
        ? (db
            .prepare(
              `SELECT i.audit_id AS audit_id, i.severity AS severity, COUNT(*) AS n
               FROM issues i JOIN audits a ON a.id = i.audit_id
               WHERE a.site = ? GROUP BY i.audit_id, i.severity`,
            )
            .all(site) as { audit_id: string; severity: Severity; n: number }[])
        : [];
      const sevMap = new Map<string, Record<Severity, number>>();
      for (const r of sevRows) {
        const m =
          sevMap.get(r.audit_id) ??
          (Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>);
        if (r.severity in m) m[r.severity] = Number(r.n);
        sevMap.set(r.audit_id, m);
      }
      const vis = store.listVisibility(site, limit).reverse();
      const engRows = vis.length
        ? (db
            .prepare(
              `SELECT v.run_id AS run_id, v.engine AS engine, AVG(v.mentioned) AS rate, COUNT(*) AS n
               FROM visibility_answers v JOIN visibility_runs r ON r.id = v.run_id
               WHERE r.site = ? AND v.error IS NULL GROUP BY v.run_id, v.engine`,
            )
            .all(site) as { run_id: string; engine: EngineId; rate: number; n: number }[])
        : [];
      const engMap = new Map<
        string,
        Partial<Record<EngineId, { mentionRate: number; answers: number }>>
      >();
      for (const r of engRows) {
        const m = engMap.get(r.run_id) ?? {};
        m[r.engine] = { mentionRate: Number(r.rate), answers: Number(r.n) };
        engMap.set(r.run_id, m);
      }
      return {
        site,
        audits: audits.map((a) => ({
          ...a,
          bySeverity:
            sevMap.get(a.id) ??
            (Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>),
        })),
        visibility: vis.map((v) => ({ ...v, byEngine: engMap.get(v.id) ?? {} })),
      };
    },

    monthSpend(month) {
      const m = month ?? new Date().toISOString().slice(0, 7);
      const r = db
        .prepare('SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE substr(date, 1, 7) = ?')
        .get(m) as { total: number };
      return Number(r.total) || 0;
    },

    recordSpend(usd, o = {}) {
      if (!(usd > 0)) return;
      db.prepare('INSERT INTO spend (date, usd, kind, ref) VALUES (?, ?, ?, ?)').run(
        (o.date ?? new Date()).toISOString().slice(0, 10),
        usd,
        o.kind ?? 'visibility',
        o.ref ?? null,
      );
    },

    listSites() {
      const rows = db
        .prepare('SELECT id, url, created_at, last_audit_at FROM sites ORDER BY id')
        .all() as Record<string, unknown>[];
      return rows.map((r) => ({
        id: String(r.id),
        url: String(r.url),
        createdAt: String(r.created_at),
        lastAuditAt: (r.last_audit_at as string | null) ?? null,
      }));
    },

    deleteSite(site) {
      tx(() => {
        db.prepare(
          'DELETE FROM issues WHERE audit_id IN (SELECT id FROM audits WHERE site = ?)',
        ).run(site);
        db.prepare('DELETE FROM audits WHERE site = ?').run(site);
        db.prepare(
          'DELETE FROM visibility_answers WHERE run_id IN (SELECT id FROM visibility_runs WHERE site = ?)',
        ).run(site);
        db.prepare('DELETE FROM visibility_runs WHERE site = ?').run(site);
        db.prepare('DELETE FROM schedules WHERE site = ?').run(site);
        db.prepare('DELETE FROM alerts_sent WHERE site = ?').run(site);
        db.prepare('DELETE FROM sites WHERE id = ?').run(site);
        // Spend rows are kept: the monthly cap must still count money already spent.
      });
    },

    setSchedule(site, s) {
      const cur = store.getSchedule(site);
      db.prepare(
        `INSERT INTO schedules (site, audit_cron, visibility_cron, last_audit_run, last_visibility_run, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(site) DO UPDATE SET audit_cron = excluded.audit_cron,
           visibility_cron = excluded.visibility_cron, updated_at = excluded.updated_at`,
      ).run(
        site,
        s.audit !== undefined ? s.audit : (cur?.auditCron ?? null),
        s.visibility !== undefined ? s.visibility : (cur?.visibilityCron ?? null),
        cur?.lastAuditRun ?? null,
        cur?.lastVisibilityRun ?? null,
        new Date().toISOString(),
      );
    },

    getSchedule(site) {
      const r = db.prepare('SELECT * FROM schedules WHERE site = ?').get(site) as
        Record<string, unknown> | undefined;
      if (!r) return null;
      return {
        site: String(r.site),
        auditCron: (r.audit_cron as string | null) ?? null,
        visibilityCron: (r.visibility_cron as string | null) ?? null,
        lastAuditRun: (r.last_audit_run as string | null) ?? null,
        lastVisibilityRun: (r.last_visibility_run as string | null) ?? null,
      };
    },

    markScheduledRun(site, kind, at = new Date()) {
      if (!store.getSchedule(site)) store.setSchedule(site, {});
      const col = kind === 'audit' ? 'last_audit_run' : 'last_visibility_run';
      db.prepare(`UPDATE schedules SET ${col} = ? WHERE site = ?`).run(at.toISOString(), site);
    },

    alertSentWithin(key, hours, now = new Date()) {
      const since = new Date(now.getTime() - hours * 3600_000).toISOString();
      return !!db
        .prepare('SELECT 1 FROM alerts_sent WHERE key = ? AND at >= ? LIMIT 1')
        .get(key, since);
    },

    markAlertSent(key, site, rule, channel, at = new Date()) {
      db.prepare(
        'INSERT INTO alerts_sent (key, site, rule, at, channel) VALUES (?, ?, ?, ?, ?)',
      ).run(key, site, rule, at.toISOString(), channel ?? null);
    },

    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
  return store;
}
