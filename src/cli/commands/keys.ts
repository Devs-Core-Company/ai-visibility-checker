/**
 * `avc keys`: add, check and remove API keys. Keys are typed at a hidden prompt (or piped on
 * stdin), never passed as command-line arguments, and saved in the OS secret store on this
 * computer (see core/secrets.ts). Nothing here prints a key back.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveSecrets } from '../../core/config.js';
import { aiUnavailableReason } from '../../ai/availability.js';
import {
  SECRET_FIELDS,
  envValue,
  secretField,
  secretSource,
  secretStore,
  type SecretField,
  type SecretGroup,
} from '../../core/secrets.js';
import { askSecret, confirm, interactive } from '../ask.js';
import { ExitError } from '../errors.js';
import { c, ok, table, warn } from '../output.js';
import { getConfig } from '../services.js';

const GROUP_TITLE: Record<SecretGroup, string> = {
  ai: 'AI engines (for AI visibility: does ChatGPT, Claude, Gemini or Perplexity name you?)',
  data: 'Data sources (optional)',
  alerts: 'Alerts (optional)',
};

function sourceLabel(f: SecretField): string {
  const s = secretSource(f);
  if (s === 'env') return c.green(`set (env ${f.env.find((n) => process.env[n])})`);
  if (s === 'claude-desktop') return c.green('set (Claude Desktop extension settings)');
  if (s === 'store') return c.green('set');
  return c.dim('not set');
}

export function cmdKeysStatus(opts: { json?: boolean }): void {
  const store = secretStore();
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          store: store.backend,
          where: store.where,
          fallbackReason: store.fallbackReason,
          keys: SECRET_FIELDS.map((f) => ({
            id: f.id,
            label: f.label,
            group: f.group,
            source: secretSource(f),
          })),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  console.log(`${c.bold('Keys are stored in')} ${store.where}`);
  if (store.fallbackReason)
    warn(`The OS keychain could not be used (${store.fallbackReason}); using the file instead.`);
  for (const group of ['ai', 'data', 'alerts'] as SecretGroup[]) {
    console.log('\n' + c.bold(GROUP_TITLE[group]));
    console.log(
      table(
        SECRET_FIELDS.filter((f) => f.group === group).map((f) => [
          f.id,
          f.label,
          sourceLabel(f),
          c.dim(f.unlocks),
        ]),
      ),
    );
  }
  const reason = aiUnavailableReason(getConfig(true));
  console.log(
    '\n' +
      (reason
        ? c.yellow('No AI key yet: AI visibility runs are skipped. ') +
          c.cyan('avc keys setup') +
          ' adds one.'
        : c.green('AI visibility can run.')),
  );
  console.log(
    c.dim(
      'Add or change: avc keys set <id>   Remove: avc keys remove <id>   Environment variables override stored keys.',
    ),
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** Basic sanity check: catches pasting the wrong thing, not a real validation. */
export function looksLikeKey(value: string): string | null {
  if (!value) return 'empty';
  if (/\s/.test(value) && !/^smtps?:\/\//.test(value)) return 'contains spaces';
  if (value.length < 8) return 'too short';
  return null;
}

export async function cmdKeysSet(id: string, opts: { stdin?: boolean }): Promise<void> {
  const field = secretField(id);
  if (!field)
    throw new ExitError(
      1,
      `Unknown key "${id}". One of: ${SECRET_FIELDS.map((f) => f.id).join(', ')}.`,
    );
  let value = '';
  if (opts.stdin) value = await readStdin();
  else if (interactive()) value = await askSecret(`${field.label} key (hidden, Enter to cancel)`);
  else
    throw new ExitError(
      1,
      `No terminal to ask in. Pipe the key instead: avc keys set ${id} --stdin < keyfile`,
    );
  if (!value) {
    console.log(c.dim('Nothing saved.'));
    return;
  }
  const problem = looksLikeKey(value);
  if (problem) throw new ExitError(1, `That does not look like a key (${problem}). Nothing saved.`);
  saveSecrets({ [field.id]: value });
  ok(`Saved the ${field.label} key in ${secretStore().where}.`);
  if (envValue(field))
    warn(`${field.env[0]} is set in your environment, so it is used instead of the stored key.`);
}

export async function cmdKeysRemove(id: string): Promise<void> {
  const field = secretField(id);
  if (!field) throw new ExitError(1, `Unknown key "${id}".`);
  saveSecrets({ [field.id]: null });
  ok(`Removed the ${field.label} key from ${secretStore().where}.`);
  if (envValue(field)) warn(`${field.env[0]} is still set in your environment.`);
}

/**
 * Ask for each key in turn; Enter skips one. Returns how many were saved.
 * `group` limits it to the AI keys (what audits and visibility runs ask for).
 */
export async function keysSetup(opts: { group?: SecretGroup } = {}): Promise<number> {
  const store = secretStore();
  console.log(c.bold('Add API keys'));
  console.log(
    c.dim(
      `Keys stay on this computer, in ${store.where}. They are sent only to the provider they belong to, never to Devs Core, and never shown again. Press Enter to skip any key.`,
    ),
  );
  const groups: SecretGroup[] = opts.group ? [opts.group] : ['ai', 'data'];
  let saved = 0;
  for (const group of groups) {
    console.log('\n' + c.bold(GROUP_TITLE[group]));
    if (group === 'ai')
      console.log(
        c.dim(
          '  One Vercel AI Gateway key covers every engine. Or add a key per provider for the engines you want.',
        ),
      );
    for (const f of SECRET_FIELDS.filter((x) => x.group === group)) {
      const src = secretSource(f);
      if (src !== 'none') {
        console.log(`  ${f.label}: ${sourceLabel(f)}`);
        continue;
      }
      // A gateway key already covers every engine: per-provider keys are optional.
      if (
        group === 'ai' &&
        f.id === 'openai' &&
        secretSource(secretField('gateway')!) !== 'none' &&
        !(await confirm(
          '  The gateway key covers every engine. Add separate provider keys too?',
          false,
        ))
      )
        break;
      console.log(`  ${c.dim(f.unlocks)}${f.getAt ? c.dim(` Get one: ${f.getAt}`) : ''}`);
      const value = await askSecret(`  ${f.label} key (hidden, Enter to skip)`);
      if (!value) continue;
      const problem = looksLikeKey(value);
      if (problem) {
        warn(
          `That does not look like a key (${problem}); skipped. Run \`avc keys set ${f.id}\` to retry.`,
        );
        continue;
      }
      saveSecrets({ [f.id]: value });
      saved += 1;
      ok(`Saved ${f.label}.`);
    }
  }
  return saved;
}

export async function cmdKeysSetup(opts: { ai?: boolean }): Promise<void> {
  if (!interactive())
    throw new ExitError(
      1,
      'Key setup needs a terminal. Use `avc keys set <id> --stdin`, environment variables, or the dashboard (`avc ui` → Settings).',
    );
  await keysSetup({ group: opts.ai ? 'ai' : undefined });
  console.log('');
  cmdKeysStatus({});
}

/**
 * First audit on a machine with no AI key: offer key setup once (a marker in the data folder
 * remembers the answer). The audit itself never needs a key; this only explains what the key
 * adds. Later audits just list the AI steps under "Skipped".
 */
export async function offerKeysOnce(): Promise<void> {
  const config = getConfig(true);
  if (!interactive() || !aiUnavailableReason(config)) return;
  const marker = join(config.dataDir, '.keys-offered');
  if (existsSync(marker)) return;
  try {
    writeFileSync(marker, new Date().toISOString() + '\n');
  } catch {
    return; // read-only data folder: do not ask on every run
  }
  console.error(
    c.dim(
      'Audits need no keys. To also measure whether AI engines name you (--visibility), add an AI key; it stays on this computer.',
    ),
  );
  if (await confirm('Add an AI key now?', false)) await keysSetup({ group: 'ai' });
  else console.error(c.dim('Skipped. Run `avc keys setup` any time.'));
}

/**
 * Before an AI step: when no AI key is set, offer to add one now. Returns true when the AI
 * step can run. When the user skips (or there is no terminal), prints that the step is
 * skipped and why, and returns false.
 */
export async function ensureAiKeys(what: string): Promise<boolean> {
  const reason = aiUnavailableReason(getConfig(true));
  if (!reason) return true;
  if (interactive()) {
    console.error(
      `${c.yellow('!')} ${what} needs an AI API key, and none is set. You can add one now; it stays on this computer.`,
    );
    if (await confirm('Add a key now?', true)) {
      await keysSetup({ group: 'ai' });
      if (!aiUnavailableReason(getConfig(true))) return true;
    }
  }
  warn(`${what} skipped: ${reason.replace(/^Skipped: /, '')}`);
  return false;
}
