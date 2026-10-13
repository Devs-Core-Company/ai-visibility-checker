/** Machine-readable exports: JSON, CSV and SARIF 2.1.0 (GitHub code scanning). */
import { createHash } from 'node:crypto';
import type { AuditResult, Severity } from '../core/types.js';
import { APP_VERSION } from '../core/version.js';
import { CHECKER_URL, issueSeverity } from './util.js';

export function toJson(result: AuditResult, opts: { pretty?: boolean } = {}): string {
  return JSON.stringify(result, null, opts.pretty === false ? undefined : 2);
}

/** RFC 4180 field. Leading = + - @ are prefixed so spreadsheets do not run them as formulas. */
export function csvField(v: unknown): string {
  let s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join(' ') : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

export function toCsv(result: AuditResult, kind: 'issues' | 'pages'): string {
  if (kind === 'pages') {
    const head = [
      'url',
      'final_url',
      'status',
      'depth',
      'indexable',
      'title',
      'meta_description',
      'h1',
      'word_count',
      'rendered_word_count',
      'canonical',
      'inlinks',
      'outlinks',
      'bytes',
      'ttfb_ms',
      'schema_types',
      'in_sitemap',
      'issues',
    ];
    return csv([
      head,
      ...result.pages.map((p) => [
        p.url,
        p.finalUrl,
        p.status,
        p.depth,
        p.indexable,
        p.title,
        p.metaDescription,
        p.h1,
        p.wordCount,
        p.renderedWordCount ?? '',
        p.canonical,
        p.inlinks,
        p.outlinks,
        p.bytes,
        p.ttfbMs,
        p.schemaTypes,
        p.inSitemap,
        p.issues,
      ]),
    ]);
  }
  const head = [
    'check_id',
    'title',
    'category',
    'pillar',
    'severity',
    'scope',
    'url',
    'message',
    'evidence',
    'fix',
  ];
  return csv([
    head,
    ...result.issues.map((i) => {
      const d = result.checks[i.checkId];
      return [
        i.checkId,
        d?.title,
        d?.category,
        d?.pillar,
        issueSeverity(i, result),
        d?.scope,
        i.url ?? '',
        i.message,
        i.evidence ?? '',
        d?.fix,
      ];
    }),
  ]);
}

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
  info: 'note',
};

/** Numeric severity GitHub uses to rank alerts (0–10). */
const RANK: Record<Severity, string> = {
  critical: '9.0',
  high: '7.0',
  medium: '5.0',
  low: '3.0',
  info: '1.0',
};

/**
 * SARIF 2.1.0. Each issue becomes a result located at its page URL (site issues
 * at the start URL). A partial fingerprint of check + URL lets GitHub track the
 * same alert across runs and close it once fixed.
 */
export function toSarif(result: AuditResult): string {
  const usedIds = [...new Set(result.issues.map((i) => i.checkId))];
  const ruleIndex = new Map(usedIds.map((id, n) => [id, n]));
  const rules = usedIds.map((id) => {
    const d = result.checks[id];
    const fix = result.priorities.find((p) => p.checkId === id)?.fix;
    const help = [
      d?.why,
      '',
      `Fix: ${d?.fix ?? ''}`,
      ...(fix?.steps.length ? ['', ...fix.steps.map((s, n) => `${n + 1}. ${s}`)] : []),
    ]
      .filter((x) => x !== undefined)
      .join('\n');
    return {
      id,
      name: id.replace(/[^a-z0-9]+(.)/gi, (_, c: string) => c.toUpperCase()),
      shortDescription: { text: d?.title ?? id },
      fullDescription: { text: d?.why ?? d?.title ?? id },
      help: { text: help, markdown: help },
      helpUri: d?.refs?.[0] ?? CHECKER_URL,
      defaultConfiguration: { level: LEVEL[d?.severity ?? 'info'] },
      properties: {
        tags: ['ai-visibility', d?.category, d?.pillar, ...(d?.tags ?? [])].filter(Boolean),
        precision: 'high',
        'problem.severity':
          LEVEL[d?.severity ?? 'info'] === 'note' ? 'recommendation' : LEVEL[d?.severity ?? 'info'],
        'security-severity': d?.category === 'security' ? RANK[d.severity] : undefined,
      },
    };
  });

  const results = result.issues.map((i) => {
    const sev = issueSeverity(i, result);
    const uri = i.url ?? result.startUrl ?? result.site;
    return {
      ruleId: i.checkId,
      ruleIndex: ruleIndex.get(i.checkId),
      level: LEVEL[sev],
      message: { text: i.evidence ? `${i.message} (${i.evidence.slice(0, 200)})` : i.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri },
            region: { startLine: 1 },
          },
        },
      ],
      partialFingerprints: {
        'avcIssue/v1': createHash('sha256')
          .update(`${i.checkId}|${i.url ?? ''}`)
          .digest('hex'),
      },
      properties: { severity: sev },
    };
  });

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'AI Visibility Checker',
            organization: 'Devs Core',
            version: result.version || APP_VERSION,
            semanticVersion: result.version || APP_VERSION,
            informationUri: CHECKER_URL,
            rules,
          },
        },
        automationDetails: { id: `avc/${new URL(result.site).host}/` },
        invocations: [{ executionSuccessful: true, endTimeUtc: result.at }],
        results,
        properties: { score: result.score.overall, grade: result.score.grade, site: result.site },
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
