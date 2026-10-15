/**
 * Whether the AI steps can run. Kept free of provider SDK imports so the audit pipeline
 * can ask cheaply.
 */
import type { AvcConfig } from '../core/config.js';

export function hasAnyKey(config: AvcConfig): boolean {
  const a = config.ai;
  return Boolean(
    a.gatewayKey || a.openaiKey || a.anthropicKey || a.googleKey || a.perplexityKey || a.xaiKey,
  );
}

/**
 * Mock only when asked for (--mock, AVC_LLM_MOCK, or the dashboard switch). Missing keys
 * never turn into sample answers silently: the AI steps are skipped and say why.
 */
export function isMock(config: AvcConfig): boolean {
  return Boolean(config.ai.mock);
}

/** Why AI steps cannot run, or null when they can (a key is set, or mock is on). */
export const NO_AI_KEY_REASON =
  'Skipped: no AI API key is set. Add one with `avc keys setup` (it stays on this computer, in your OS keychain), or run with --mock for sample answers.';

export function aiUnavailableReason(config: AvcConfig): string | null {
  return isMock(config) || hasAnyKey(config) ? null : NO_AI_KEY_REASON;
}

/** Thrown when an AI step is asked for and no key is set; each surface turns it into a prompt or a skip. */
export class AiKeysMissingError extends Error {
  readonly code = 'AI_KEYS_MISSING';
  constructor(message = NO_AI_KEY_REASON) {
    super(message);
    this.name = 'AiKeysMissingError';
  }
}

export function assertAiAvailable(config: AvcConfig): void {
  const reason = aiUnavailableReason(config);
  if (reason) throw new AiKeysMissingError(reason);
}
