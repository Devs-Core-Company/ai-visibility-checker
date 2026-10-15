/**
 * Keys page: add, replace, test and remove API keys. A saved key is shown only as a fixed
 * row of dots (the same length for every key, so not even its length shows) and is never
 * sent back to the browser. Keys are saved in the OS secret store on this computer.
 */
import type { Hono } from 'hono';
import { saveSecrets } from '../../core/config.js';
import { canTestKey, testKey } from '../../core/key-test.js';
import {
  SECRET_FIELDS,
  envValue,
  secretField,
  secretSource,
  secretStore,
  type SecretField,
  type SecretGroup,
  type SecretSource,
} from '../../core/secrets.js';
import { aiUnavailableReason } from '../../ai/availability.js';
import { getConfig } from '../../cli/services.js';
import { back, form, str, type Deps, type ServerEnv } from '../app.js';
import { Badge, Layout } from '../ui.js';

export const MASK = '••••••••';

const GROUPS: [SecretGroup, string, string][] = [
  [
    'ai',
    'AI engines',
    'Used to ask ChatGPT, Claude, Gemini and Perplexity about your brand. One Vercel AI Gateway key covers every engine; or add a key per provider.',
  ],
  ['data', 'Data sources', 'Optional. Each one adds checks; without it those checks are skipped.'],
  ['alerts', 'Alerts', 'Optional. For email alerts.'],
];

function sourceBadge(f: SecretField, src: SecretSource) {
  if (src === 'store') return <Badge cls="v-ok">saved</Badge>;
  if (src === 'claude-desktop') return <Badge cls="v-ok">Claude Desktop settings</Badge>;
  if (src === 'env')
    return <Badge cls="v-ok">env {f.env.find((n) => process.env[n]) ?? f.env[0]}</Badge>;
  return <Badge>not set</Badge>;
}

function KeyRow({ f }: { f: SecretField }) {
  const src = secretSource(f);
  const fromOutside = src === 'env' || src === 'claude-desktop';
  return (
    <div class="field" style="border-top:1px solid var(--line);padding-top:12px;margin-top:12px">
      <label for={`k-${f.id}`}>
        {f.label} {sourceBadge(f, src)}
      </label>
      <p class="muted" style="margin:2px 0 8px">
        {f.unlocks}
        {f.getAt ? (
          <>
            {' '}
            Get one at{' '}
            <a href={f.getAt} target="_blank" rel="noopener noreferrer">
              {f.getAt.replace(/^https:\/\//, '')}
            </a>
            .
          </>
        ) : null}
      </p>
      {src !== 'none' ? (
        <p class="mono" aria-label="Key saved, hidden" style="margin:0 0 6px;letter-spacing:2px">
          {MASK}
        </p>
      ) : null}
      {fromOutside ? (
        <p class="muted" style="margin:0 0 6px">
          {src === 'claude-desktop'
            ? 'Set in Claude Desktop → Settings → Extensions → AI Visibility Checker. Change it there.'
            : `Set by the ${f.env.find((n) => process.env[n])} environment variable, which wins over a saved key. Change it there.`}
        </p>
      ) : (
        <input
          id={`k-${f.id}`}
          name={f.id}
          type="password"
          autocomplete="off"
          spellcheck={false}
          placeholder={src === 'none' ? 'Paste the key' : 'Type a new key to replace it'}
        />
      )}
      <div class="row" style="margin-top:6px;gap:8px">
        {canTestKey(f.id) ? (
          <button class="btn small" type="submit" formaction={`/keys/test/${f.id}`}>
            Test
          </button>
        ) : null}
        {src === 'store' ? (
          <button class="btn small" type="submit" formaction={`/keys/remove/${f.id}`}>
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function registerKeysPages(app: Hono<ServerEnv>, deps: Deps): void {
  void deps;

  app.get('/keys', (c) => {
    const store = secretStore();
    const noAi = aiUnavailableReason(getConfig(true));
    return c.html(
      <Layout title="API keys" active="keys" flash={c.get('flash')}>
        <div class="card">
          <p>
            <strong>Your keys stay on this computer.</strong> They are saved in {store.where} and
            sent only to the provider each key belongs to, never to Devs Core. A saved key is shown
            as {MASK} and cannot be viewed or copied again, only replaced or removed.
          </p>
          {store.fallbackReason ? (
            <p class="notice warn">
              The OS keychain could not be used ({store.fallbackReason}), so keys are in a file only
              you can read.
            </p>
          ) : null}
          <p class={noAi ? 'notice warn' : 'muted'} role="status">
            {noAi
              ? 'No AI key yet: AI visibility runs are skipped until you add one. Audits work without keys.'
              : 'AI visibility can run.'}
          </p>
        </div>
        <form method="post" action="/keys" class="stack" autocomplete="off">
          {/* Enter submits the form's first button: make that Save, not a key's Test. */}
          <button type="submit" class="sr-only" tabindex={-1} aria-hidden="true">
            Save keys
          </button>
          {GROUPS.map(([group, title, intro]) => (
            <div class="card">
              <h2>{title}</h2>
              <p class="muted">{intro}</p>
              {SECRET_FIELDS.filter((f) => f.group === group).map((f) => (
                <KeyRow f={f} />
              ))}
            </div>
          ))}
          <div class="row">
            <button class="btn primary" type="submit">
              Save keys
            </button>
            <span class="muted">Empty fields keep the current key.</span>
          </div>
        </form>
      </Layout>,
    );
  });

  app.post('/keys', async (c) => {
    const f = await form(c);
    const values: Record<string, string> = {};
    for (const field of SECRET_FIELDS) {
      const v = str(f[field.id]);
      if (v) values[field.id] = v;
    }
    if (!Object.keys(values).length) return back(c, '/keys', 'Nothing to save.', 'info');
    const bad = Object.entries(values).find(([, v]) => /\s/.test(v) && !/^smtps?:\/\//.test(v));
    if (bad)
      return back(
        c,
        '/keys',
        `The ${secretField(bad[0])!.label} key contains spaces, so nothing was saved. Paste it again.`,
        'error',
      );
    saveSecrets(values);
    const labels = SECRET_FIELDS.filter((x) => values[x.id]).map((x) => x.label);
    const shadowed = SECRET_FIELDS.filter((x) => values[x.id] && envValue(x)).map((x) => x.label);
    return back(
      c,
      '/keys',
      `Saved ${labels.join(', ')}.` +
        (shadowed.length
          ? ` Note: an environment variable still overrides ${shadowed.join(', ')}.`
          : ''),
      shadowed.length ? 'warn' : 'ok',
    );
  });

  // Test the key typed in the field if there is one (without saving it), else the saved key.
  app.post('/keys/test/:id', async (c) => {
    const field = secretField(c.req.param('id'));
    if (!field) return back(c, '/keys', 'Unknown key.', 'error');
    const typed = str((await form(c))[field.id]);
    const key = typed || envValue(field) || secretStore().get(field.id) || '';
    const r = await testKey(field.id, key);
    const what = typed ? 'The key you typed (not saved yet): ' : '';
    return back(c, '/keys', what + r.message, r.ok ? 'ok' : r.ok === null ? 'info' : 'error');
  });

  app.post('/keys/remove/:id', (c) => {
    const field = secretField(c.req.param('id'));
    if (!field) return back(c, '/keys', 'Unknown key.', 'error');
    saveSecrets({ [field.id]: null });
    return back(c, '/keys', `Removed the ${field.label} key.`);
  });
}
