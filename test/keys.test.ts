import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const dataDir = mkdtempSync(join(tmpdir(), 'avc-keys-'));
process.env.AVC_DATA_DIR = dataDir;
process.env.AVC_SECRET_STORE = 'file';
delete process.env.AVC_LLM_MOCK;
for (const v of [
  'AI_GATEWAY_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'PERPLEXITY_API_KEY',
  'XAI_API_KEY',
])
  delete process.env[v];

const { loadConfig, saveSecrets, saveUserConfig, userConfigPath } =
  await import('../src/core/config.js');
const { resetSecretStore, secretStore, secretSource, secretField } =
  await import('../src/core/secrets.js');
const { patchUserConfig } = await import('../src/cli/services.js');
const { startKeyPage } = await import('../src/server/key-page.js');

const KEY = 'sk-test-0123456789abcdef';
const secretsFile = join(dataDir, 'secrets.json');

function reset(): void {
  writeFileSync(userConfigPath(), '{}');
  saveSecrets({ openai: null, anthropic: null, gateway: null, psi: null, smtp: null });
  resetSecretStore();
  loadConfig({ reload: true });
}

describe('secret store', () => {
  beforeEach(reset);

  it('saves keys outside config.json, in a file only the user can read', () => {
    saveUserConfig({ ai: { openaiKey: KEY, maxRunUsd: 5, maxMonthUsd: 30 } });
    const userFile = readFileSync(userConfigPath(), 'utf8');
    expect(userFile).not.toContain(KEY);
    expect(JSON.parse(userFile).ai.maxRunUsd).toBe(5);
    expect(readFileSync(secretsFile, 'utf8')).toContain(KEY);
    if (process.platform !== 'win32') expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
    expect(loadConfig({ reload: true }).ai.openaiKey).toBe(KEY);
    expect(secretSource(secretField('openai')!)).toBe('store');
  });

  it('moves keys an older version left in config.json into the store', () => {
    writeFileSync(
      userConfigPath(),
      JSON.stringify({ ai: { anthropicKey: KEY }, google: { psiKey: 'psi-key-123456' } }),
    );
    const config = loadConfig({ reload: true });
    expect(config.ai.anthropicKey).toBe(KEY);
    expect(config.google?.psiKey).toBe('psi-key-123456');
    expect(readFileSync(userConfigPath(), 'utf8')).not.toContain(KEY);
    expect(secretStore().get('anthropic')).toBe(KEY);
  });

  it('ignores keys in the project file, which gets committed', () => {
    const project = join(dataDir, 'avc.config.json');
    writeFileSync(project, JSON.stringify({ ai: { openaiKey: KEY } }));
    const config = loadConfig({ projectFile: project, reload: true });
    expect(config.ai.openaiKey).toBeUndefined();
  });

  it('lets environment variables win over stored keys', () => {
    saveSecrets({ openai: KEY });
    process.env.OPENAI_API_KEY = 'sk-from-env-000000';
    try {
      expect(loadConfig({ reload: true }).ai.openaiKey).toBe('sk-from-env-000000');
      expect(secretSource(secretField('openai')!)).toBe('env');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('removes a key when the dashboard clears it', () => {
    saveSecrets({ openai: KEY });
    patchUserConfig('ai', { openaiKey: '' });
    expect(secretStore().get('openai')).toBeUndefined();
    expect(loadConfig({ reload: true }).ai.openaiKey).toBeUndefined();
  });

  it('keeps alert email settings when the SMTP password moves to the store', () => {
    patchUserConfig('alerts', {
      email: { to: 'me@example.com', smtpUrl: 'smtps://u:p@smtp.example.com:465' },
    });
    const config = loadConfig({ reload: true });
    expect(config.alerts?.email).toMatchObject({
      to: 'me@example.com',
      smtpUrl: 'smtps://u:p@smtp.example.com:465',
    });
    expect(readFileSync(userConfigPath(), 'utf8')).not.toContain('smtps://');
  });
});

describe('key page', () => {
  beforeEach(reset);

  const post = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: new URL(url).origin,
        ...headers,
      },
      body: new URLSearchParams(body),
      redirect: 'manual',
    });

  it('saves keys typed on the page and never shows them back', async () => {
    saveSecrets({ anthropic: KEY });
    const page = await startKeyPage();
    try {
      expect(page.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/keys\/[\w-]{20,}$/);
      const form = await (await fetch(page.url)).text();
      expect(form).toContain('Your keys stay on this computer');
      expect(form).not.toContain(KEY);
      const r = await post(page.url, { action: 'save', openai: 'sk-typed-on-page-1234' });
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain('Saved');
      expect(html).not.toContain('sk-typed-on-page-1234');
      expect(await page.done).toBe('saved');
      expect(secretStore().get('openai')).toBe('sk-typed-on-page-1234');
      // One use only.
      expect((await fetch(page.url)).status).toBe(404);
    } finally {
      page.close();
    }
  });

  it('refuses a wrong token and a post from another origin', async () => {
    const page = await startKeyPage();
    try {
      const wrong = page.url.replace(/\/keys\/.*/, '/keys/not-the-token');
      expect((await fetch(wrong)).status).toBe(404);
      const cross = await post(
        page.url,
        { action: 'save', openai: 'sk-attacker-000000' },
        { Origin: 'https://evil.example' },
      );
      expect(cross.status).toBe(403);
      expect(secretStore().get('openai')).toBeUndefined();
    } finally {
      page.close();
    }
  });

  it('accepts Origin: null only when the browser says the post is same-origin', async () => {
    const page = await startKeyPage();
    try {
      const forged = await post(
        page.url,
        { action: 'save', openai: 'sk-attacker-000000' },
        { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' },
      );
      expect(forged.status).toBe(403);
      const ok = await post(
        page.url,
        { action: 'save', openai: 'sk-null-origin-ok-1234' },
        { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' },
      );
      expect(ok.status).toBe(200);
      expect(secretStore().get('openai')).toBe('sk-null-origin-ok-1234');
    } finally {
      page.close();
    }
  });

  it('reports a skip without saving anything', async () => {
    const page = await startKeyPage();
    try {
      await post(page.url, { action: 'skip', openai: 'sk-ignored-000000' });
      expect(await page.done).toBe('skipped');
      expect(secretStore().get('openai')).toBeUndefined();
    } finally {
      page.close();
    }
  });
});

describe('MCP without keys', () => {
  let client: Client;
  type TextResult = { content: { type: string; text: string }[]; isError?: boolean };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as TextResult;
    return { ...r, text: r.content.map((c) => c.text).join('\n') };
  };

  beforeAll(async () => {
    reset();
    const { buildMcpServer } = await import('../src/mcp/server.js');
    const server = buildMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(b);
  });
  afterAll(async () => {
    await client?.close();
  });

  it('skips an AI visibility run with the reason and a private link, never asking for the key in chat', async () => {
    const r = await call('ai_visibility', { site: 'https://example.com', run: true });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.text);
    expect(out).toMatchObject({ skipped: true, step: 'ai-visibility' });
    expect(out.reason).toMatch(/no AI API key/);
    expect(out.addKeys.link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/keys\//);
    expect(out.note).toMatch(/Never ask the user to paste an API key/);
  });

  it('reports which keys are set without revealing any value', async () => {
    saveSecrets({ gateway: KEY });
    const r = await call('keys_status');
    expect(r.text).not.toContain(KEY);
    const out = JSON.parse(r.text);
    expect(out.aiReady).toBe(true);
    expect(out.keys.find((k: { id: string }) => k.id === 'gateway').set).toBe(true);
  });

  it('tells the assistant how keys are handled', async () => {
    const { tools } = await client.listTools();
    const setup = tools.find((t) => t.name === 'setup_keys');
    expect(setup?.description).toMatch(/never pass through this chat/);
    expect(client.getInstructions()).toMatch(/Never ask the user to paste an API key/);
  });
});

it('never writes keys into the user config file', () => {
  expect(existsSync(userConfigPath()) ? readFileSync(userConfigPath(), 'utf8') : '').not.toContain(
    KEY,
  );
});
