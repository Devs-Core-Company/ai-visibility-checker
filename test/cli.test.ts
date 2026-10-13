import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureServer } from './fixtures/serve.js';

const root = join(import.meta.dirname, '..');
const tsx = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
const dataDir = mkdtempSync(join(tmpdir(), 'avc-cli-'));
const outDir = mkdtempSync(join(tmpdir(), 'avc-out-'));
process.env.AVC_DATA_DIR = dataDir;

/** Run the CLI from source. Async, so the fixture server in this process keeps serving. */
function avc(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', tsx, join(root, 'src/cli.ts'), ...args], {
      cwd: outDir,
      env: {
        ...process.env,
        AVC_DATA_DIR: dataDir,
        AVC_LLM_MOCK: '1',
        NO_COLOR: '1',
        CI: '1',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

let fixture: FixtureServer;
beforeAll(async () => {
  const { startFixtureServer } = await import('./fixtures/serve.js');
  fixture = await startFixtureServer();
});
afterAll(async () => {
  await fixture?.close();
});

describe('helpers', () => {
  it('parses prompts files', async () => {
    const { parsePrompts } = await import('../src/cli/services.js');
    expect(
      parsePrompts('# comment\nbest joiners\n\nkitchen fitters near me\n').map((p) => p.text),
    ).toEqual(['best joiners', 'kitchen fitters near me']);
    const json = parsePrompts('["a", {"text": "b", "kind": "comparison", "search": false}]');
    expect(json[1]).toMatchObject({ text: 'b', kind: 'comparison', search: false });
  });

  it('parses formats and rejects unknown ones', async () => {
    const { parseFormats } = await import('../src/cli/services.js');
    expect(parseFormats('html,markdown,csv')).toEqual(['html', 'md', 'csv']);
    expect(() => parseFormats('pdf')).toThrow(/Unknown format/);
  });

  it('expands check selectors (ids, categories, pillars)', async () => {
    const { selectChecks } = await import('../src/cli/services.js');
    const { ALL_CHECKS } = await import('../src/checks/index.js');
    expect(selectChecks()).toBeUndefined();
    const ai = selectChecks(['ai-access'])!;
    expect(ai.length).toBeGreaterThan(0);
    expect(
      ai.every((id) => ALL_CHECKS.find((c) => c.def.id === id)!.def.pillar === 'ai-access'),
    ).toBe(true);
    const skipped = selectChecks(undefined, ['ai-access'])!;
    expect(skipped.length).toBe(ALL_CHECKS.length - ai.length);
  });

  it('normalises URLs', async () => {
    const { toUrl, isUrlish } = await import('../src/cli/services.js');
    expect(toUrl('example.com')).toBe('https://example.com/');
    expect(isUrlish('example.com/path')).toBe(true);
    expect(isUrlish('my-site')).toBe(false);
  });

  it('registers every command', async () => {
    const { buildProgram } = await import('../src/cli/program.js');
    const names = buildProgram().commands.map((c) => c.name());
    for (const n of [
      'init',
      'audit',
      'visibility',
      'prompts',
      'fix',
      'rollback',
      'generate',
      'connect',
      'logs',
      'diff',
      'history',
      'report',
      'sites',
      'monitor',
      'schedule',
      'ui',
      'mcp',
      'checks',
      'doctor',
    ])
      expect(names).toContain(n);
  });
});

describe('avc (end to end, mock AI)', () => {
  it('prints the version', async () => {
    const r = await avc(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('lists checks as JSON', async () => {
    const r = await avc(['checks', '--json']);
    expect(r.code).toBe(0);
    const defs = JSON.parse(r.stdout) as { id: string }[];
    expect(defs.length).toBeGreaterThan(50);
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
  });

  it('audits the fixture site, writes every report format and honours --fail-under', async () => {
    const out = join(outDir, 'reports');
    const r = await avc([
      'audit',
      fixture.url,
      '--max-pages',
      '30',
      '--no-render',
      '--visibility',
      '--format',
      'html,json,md,csv,sarif',
      '--out',
      out,
      '--fail-under',
      '101',
    ]);
    expect(r.code, r.stderr).toBe(2);
    expect(r.stdout).toContain('AI Visibility Score');
    expect(r.stdout).toContain('priorities');
    const files = readdirSync(out);
    for (const ext of ['.html', '.json', '.md', '-issues.csv', '-pages.csv', '.sarif'])
      expect(
        files.some((f) => f.endsWith(ext)),
        ext,
      ).toBe(true);
    const json = JSON.parse(
      readFileSync(
        join(
          out,
          files.find((f) => f.endsWith('.json'))!,
        ),
        'utf8',
      ),
    );
    expect(json.visibility?.answers?.length).toBeGreaterThan(0);
  }, 180_000);

  it('passes --fail-under when the score is high enough and diffs two audits as Markdown', async () => {
    const r = await avc([
      'audit',
      fixture.url,
      '--max-pages',
      '30',
      '--no-render',
      '--format',
      'json',
      '--out',
      join(outDir, 'r2'),
      '--fail-under',
      '0',
      '-q',
    ]);
    expect(r.code, r.stderr).toBe(0);
    const d = await avc(['diff', fixture.url, '--md']);
    expect(d.code, d.stderr).toBe(0);
    expect(d.stdout.length).toBeGreaterThan(20);
    const h = await avc(['history', '--json']);
    expect(h.code).toBe(0);
    const hist = JSON.parse(h.stdout) as Record<string, { audits: unknown[] }>;
    expect(Object.values(hist).some((s) => s.audits.length >= 2)).toBe(true);
  }, 180_000);

  it('writes reports for a stored audit', async () => {
    const r = await avc(['report', 'latest', '--format', 'md', '--out', join(outDir, 'r3')]);
    expect(r.code, r.stderr).toBe(0);
    expect(readdirSync(join(outDir, 'r3')).some((f) => f.endsWith('.md'))).toBe(true);
  });

  it('generates llms.txt and robots.txt from the latest audit', async () => {
    const llms = await avc(['generate', 'llms-txt', fixture.url]);
    expect(llms.code, llms.stderr).toBe(0);
    expect(llms.stdout).toMatch(/^# /);
    const robots = await avc(['generate', 'robots', fixture.url, '--policy', 'allow-search']);
    expect(robots.code, robots.stderr).toBe(0);
    expect(robots.stdout).toContain('GPTBot');
  });

  it('prints the fix plan', async () => {
    const r = await avc(['fix', fixture.url, '--json']);
    expect(r.code, r.stderr).toBe(0);
    const fixes = JSON.parse(r.stdout) as { checkId: string; agentPrompt: string }[];
    expect(Array.isArray(fixes)).toBe(true);
    if (fixes.length) expect(fixes[0].agentPrompt.length).toBeGreaterThan(10);
  });

  it('runs a mock visibility check with a prompts file', async () => {
    const file = join(outDir, 'prompts.txt');
    writeFileSync(file, 'best joiners in Leeds\nbespoke kitchens Yorkshire\n');
    const r = await avc([
      'visibility',
      fixture.url,
      '--prompts',
      file,
      '--engines',
      'chatgpt,claude',
      '--json',
    ]);
    expect(r.code, r.stderr).toBe(0);
    const run = JSON.parse(r.stdout);
    expect(run.answers.length).toBe(4);
    expect(run.summary).toHaveProperty('mentionRate');
  }, 120_000);

  it('init writes a project config without asking when --yes', async () => {
    const r = await avc([
      'init',
      '--url',
      'https://example.org',
      '--brand',
      'Example',
      '--competitors',
      'Rival,rival.example',
      '--yes',
    ]);
    expect(r.code, r.stderr).toBe(0);
    const cfg = JSON.parse(readFileSync(join(outDir, 'avc.config.json'), 'utf8'));
    expect(cfg.sites[0]).toMatchObject({ id: 'example.org', brand: { name: 'Example' } });
    expect(JSON.stringify(cfg)).not.toMatch(/key/i);
  });

  it('doctor reports as JSON', async () => {
    const r = await avc(['doctor', '--json']);
    const out = JSON.parse(r.stdout) as { items: { name: string; status: string }[] };
    expect(out.items.find((i) => i.name === 'Node.js')?.status).toBe('ok');
    expect(out.items.find((i) => i.name === 'Data folder')?.status).toBe('ok');
  });

  it('fails cleanly on an unknown site id', async () => {
    const r = await avc(['audit', 'not-a-site']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No site called');
    expect(existsSync(join(outDir, 'avc-reports'))).toBe(false);
  });
});
