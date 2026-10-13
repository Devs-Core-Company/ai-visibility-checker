import type { AuditDiff, VisibilityRun } from '../core/types.js';
import { validAnswers } from './run.js';
import { sameBrand } from './util.js';

/**
 * What changed between two visibility runs. Prompts are matched by id
 * (stable for the same kind and text), falling back to the prompt text.
 * A prompt is "won" when the brand is named in at least half its answers.
 * `lostPrompts` and `wonPrompts` hold the prompt texts.
 */
export function compareRuns(
  prev: VisibilityRun,
  next: VisibilityRun,
): NonNullable<AuditDiff['visibility']> {
  const brandShare = (r: VisibilityRun) =>
    r.summary.shareOfVoice.find((s) => s.isBrand)?.share ?? 0;

  const prevCompetitors = prev.summary.shareOfVoice.filter((s) => !s.isBrand && s.mentions > 0);
  const newCompetitors = next.summary.shareOfVoice
    .filter((s) => !s.isBrand && s.mentions > 0)
    .filter((s) => !prevCompetitors.some((p) => sameBrand(p.name, s.name)))
    .map((s) => s.name);

  const winning = (r: VisibilityRun) => {
    const out = new Map<string, boolean>();
    const valid = validAnswers(r.answers);
    for (const p of r.prompts) {
      const xs = valid.filter((a) => a.promptId === p.id);
      if (!xs.length) continue;
      const key = p.text.toLowerCase().trim();
      out.set(key, xs.filter((a) => a.mentioned).length / xs.length >= 0.5);
    }
    return out;
  };
  const before = winning(prev);
  const after = winning(next);
  const texts = new Map(next.prompts.map((p) => [p.text.toLowerCase().trim(), p.text]));
  const lostPrompts: string[] = [];
  const wonPrompts: string[] = [];
  for (const [key, won] of after) {
    const was = before.get(key);
    if (was === undefined) continue;
    if (was && !won) lostPrompts.push(texts.get(key) ?? key);
    if (!was && won) wonPrompts.push(texts.get(key) ?? key);
  }

  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return {
    mentionRateDelta: round(next.summary.mentionRate - prev.summary.mentionRate),
    shareOfVoiceDelta: round(brandShare(next) - brandShare(prev)),
    newCompetitors,
    lostPrompts,
    wonPrompts,
  };
}
