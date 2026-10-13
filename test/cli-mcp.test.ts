import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FixtureServer } from './fixtures/serve.js';

process.env.AVC_DATA_DIR = mkdtempSync(join(tmpdir(), 'avc-mcp-'));
process.env.AVC_LLM_MOCK = '1';

let client: Client;
let fixture: FixtureServer;

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as TextResult;
  return { ...r, text: r.content.map((c) => c.text).join('\n') };
};

beforeAll(async () => {
  const { startFixtureServer } = await import('./fixtures/serve.js');
  const { buildMcpServer } = await import('../src/mcp/server.js');
  fixture = await startFixtureServer();
  const server = buildMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(b);
});

afterAll(async () => {
  await client?.close();
  await fixture?.close();
});

describe('MCP server', () => {
  it('lists the tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      'audit_site',
      'get_issues',
      'get_page',
      'get_fix',
      'list_checks',
      'ai_visibility',
      'diff_audits',
      'generate_llms_txt',
      'generate_robots_txt',
      'generate_schema',
      'plan_fixes',
      'apply_fixes',
      'crawler_access',
      'agentic_readiness',
    ])
      expect(names).toContain(n);
  });

  it('audits, then answers questions about the audit', async () => {
    const audit = await call('audit_site', { url: fixture.url, max_pages: 20, render: false });
    expect(audit.isError, audit.text).toBeFalsy();
    const summary = JSON.parse(audit.text);
    expect(summary.score).toBeGreaterThanOrEqual(0);

    const issues = JSON.parse((await call('get_issues', { site: fixture.url, limit: 5 })).text);
    expect(issues.total).toBeGreaterThanOrEqual(issues.shown);

    const bots = JSON.parse((await call('crawler_access', { site: fixture.url })).text) as {
      token: string;
      robots: string;
    }[];
    expect(bots.find((b) => b.token === 'GPTBot')).toBeTruthy();

    const agentic = JSON.parse((await call('agentic_readiness', { site: fixture.url })).text);
    expect(Array.isArray(agentic.probes)).toBe(true);

    if (summary.priorities.length) {
      const fix = JSON.parse(
        (await call('get_fix', { site: fixture.url, check_id: summary.priorities[0].checkId }))
          .text,
      );
      expect(fix.check.id).toBe(summary.priorities[0].checkId);
    }
    const llms = await call('generate_llms_txt', { site: fixture.url });
    expect(llms.text).toMatch(/^# /);
  }, 120_000);

  it('apply_fixes is a dry run unless confirmed', async () => {
    const r = await call('apply_fixes', { site: fixture.url, target: 'repo' });
    // No repo connected: an error, and certainly no change.
    expect(r.isError || JSON.parse(r.text).dryRun).toBe(true);
  });

  it('returns a clear error for an unknown audit', async () => {
    const r = await call('get_issues', { audit_id: 'missing', site: 'nothing.example' });
    expect(r.isError).toBe(true);
  });
});
