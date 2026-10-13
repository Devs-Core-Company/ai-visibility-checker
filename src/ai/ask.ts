/**
 * Ask questions about an audit in plain language ("what should I fix first?",
 * "why is the AI access score low?"). Uses your writer model (own key or AI
 * Gateway); without one, or in mock mode, answers from the audit's own ranked
 * priorities so it still works offline.
 */
import type { AvcConfig } from '../core/config.js';
import type { AuditResult } from '../core/types.js';
import { writerModel } from '../fixes/generate.js';

export interface AskResult {
  answer: string;
  source: 'model' | 'rules';
}

/** A compact, factual brief of an audit for the model (no page HTML, no secrets). */
export function auditBrief(result: AuditResult, maxChecks = 30): string {
  const counts = new Map<string, number>();
  for (const i of result.issues) counts.set(i.checkId, (counts.get(i.checkId) ?? 0) + 1);
  const top = [...counts.entries()]
    .map(([id, n]) => ({ id, n, d: result.checks[id] }))
    .filter((x) => x.d)
    .sort((a, b) => {
      const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
      return rank[a.d!.severity] - rank[b.d!.severity] || b.n - a.n;
    })
    .slice(0, maxChecks);
  const lines = [
    `Site: ${result.site} (stack: ${result.stack.id}${result.stack.seoPlugin ? `, ${result.stack.seoPlugin}` : ''})`,
    `Audit ${result.id} on ${result.at}: score ${result.score.overall}/100 (${result.score.grade}), ${result.pages.length} URLs, ${result.issues.length} issues.`,
    `Pillars: ${result.score.pillars.map((p) => `${p.pillar} ${p.score}`).join(', ')}.`,
    'Top problems (check id | severity | pages | title | fix):',
    ...top.map((x) => `- ${x.id} | ${x.d!.severity} | ${x.n} | ${x.d!.title} | ${x.d!.fix}`),
  ];
  if (result.priorities.length)
    lines.push(
      'Ranked priorities:',
      ...result.priorities
        .slice(0, 10)
        .map((p, i) => `${i + 1}. ${p.checkId} (${p.affected} affected)`),
    );
  if (result.visibility)
    lines.push(
      `AI visibility: mentioned in ${Math.round(result.visibility.summary.mentionRate * 100)}% of answers; competitor wins: ${result.visibility.summary.competitorWins.length}.`,
    );
  return lines.join('\n');
}

/** Rule-based answer: the ranked priorities with their first fix step. */
export function rulesAnswer(result: AuditResult): string {
  const p = result.priorities.slice(0, 5);
  if (!p.length)
    return `No open issues worth prioritising on ${result.site}. Score ${result.score.overall}/100.`;
  return [
    `Score ${result.score.overall}/100 (${result.score.grade}). Start with these, in order:`,
    ...p.map((x, i) => {
      const d = result.checks[x.checkId];
      return `${i + 1}. ${d?.title ?? x.checkId} — ${x.affected} affected. ${x.fix?.steps[0] ?? d?.fix ?? ''}`;
    }),
    'Add an AI key (or AI Gateway key) for free-form answers to other questions.',
  ].join('\n');
}

export async function askAboutAudit(
  result: AuditResult,
  question: string,
  config: Pick<AvcConfig, 'ai'>,
  opts: { model?: unknown; history?: { role: 'user' | 'assistant'; content: string }[] } = {},
): Promise<AskResult> {
  const model = opts.model ?? (await writerModel(config));
  if (!model) return { answer: rulesAnswer(result), source: 'rules' };
  const { generateText } = await import('ai');
  const res = await generateText({
    model: model as Parameters<typeof generateText>[0]['model'],
    system:
      "You are an SEO and AI-search analyst explaining an audit of the user's own website. Answer only from the audit brief; say when the brief does not contain the answer. Be specific: name check ids, numbers of pages and the next step. Plain British English, short paragraphs or numbered steps, no hype.",
    messages: [
      { role: 'user', content: `Audit brief:\n${auditBrief(result)}` },
      ...(opts.history ?? []).slice(-10),
      { role: 'user', content: question.slice(0, 2000) },
    ],
    maxOutputTokens: 800,
    maxRetries: 1,
  });
  return { answer: res.text.trim(), source: 'model' };
}
