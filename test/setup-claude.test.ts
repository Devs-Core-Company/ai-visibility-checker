import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeCodeAddArgs,
  desktopConfigPath,
  launchSpec,
  mergeMcpConfig,
  writeMcpConfig,
} from '../src/cli/commands/setup-claude.js';

describe('desktopConfigPath', () => {
  it('uses the Claude desktop location for each platform', () => {
    expect(desktopConfigPath('darwin', {}, '/Users/a')).toBe(
      '/Users/a/Library/Application Support/Claude/claude_desktop_config.json',
    );
    expect(
      desktopConfigPath('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a'),
    ).toContain('Claude');
    expect(desktopConfigPath('linux', {}, '/home/a')).toBe(
      '/home/a/.config/Claude/claude_desktop_config.json',
    );
  });
});

describe('launchSpec', () => {
  it('uses absolute node and the bin file for a lasting install, with node on PATH', () => {
    const s = launchSpec({
      execPath: '/Users/a/.nvm/versions/node/v22.12.0/bin/node',
      root: '/Users/a/.nvm/versions/node/v22.12.0/lib/node_modules/@devs-core/ai-visibility-checker',
      platform: 'darwin',
    });
    expect(s.command).toBe('/Users/a/.nvm/versions/node/v22.12.0/bin/node');
    expect(s.args).toEqual([
      '/Users/a/.nvm/versions/node/v22.12.0/lib/node_modules/@devs-core/ai-visibility-checker/bin/avc.mjs',
      'mcp',
    ]);
    expect(s.env?.PATH.split(':')[0]).toBe('/Users/a/.nvm/versions/node/v22.12.0/bin');
    expect(s.env?.PATH).toContain('/usr/bin');
  });

  it('falls back to npx with the repo for a temporary npx copy', () => {
    const s = launchSpec({
      execPath: '/usr/local/bin/node',
      root: '/Users/a/.npm/_npx/abc123/node_modules/@devs-core/ai-visibility-checker',
      platform: 'darwin',
    });
    expect(s.args).toEqual(['-y', 'github:Devs-Core-Company/ai-visibility-checker', 'mcp']);
    expect(s.command.endsWith('npx')).toBe(true);
  });
});

describe('mergeMcpConfig', () => {
  const spec = {
    command: '/n/node',
    args: ['/p/bin/avc.mjs', 'mcp'],
    env: { PATH: '/n:/usr/bin' },
  };

  it('adds the server and keeps other servers and settings', () => {
    const existing = JSON.stringify({
      globalShortcut: 'Alt+Space',
      mcpServers: { other: { command: 'x', args: [] } },
    });
    const { text, changed } = mergeMcpConfig(existing, spec);
    const out = JSON.parse(text);
    expect(changed).toBe(true);
    expect(out.globalShortcut).toBe('Alt+Space');
    expect(out.mcpServers.other).toEqual({ command: 'x', args: [] });
    expect(out.mcpServers.avc).toEqual({ command: '/n/node', args: spec.args, env: spec.env });
  });

  it('creates the file content from nothing and reports no change when already set', () => {
    const first = mergeMcpConfig(null, spec);
    expect(JSON.parse(first.text).mcpServers.avc.command).toBe('/n/node');
    expect(mergeMcpConfig(first.text, spec).changed).toBe(false);
  });

  it('removes only its own entry', () => {
    const existing = JSON.stringify({
      mcpServers: { avc: { command: 'a' }, other: { command: 'b' } },
    });
    const out = JSON.parse(mergeMcpConfig(existing, null).text);
    expect(out.mcpServers).toEqual({ other: { command: 'b' } });
  });

  it('refuses a file that is not a JSON object', () => {
    expect(() => mergeMcpConfig('{ broken', spec)).toThrow();
    expect(() => mergeMcpConfig('[]', spec)).toThrow();
  });
});

describe('writeMcpConfig', () => {
  const spec = { command: '/n/node', args: ['/p/bin/avc.mjs', 'mcp'] };

  it('backs up the previous file and leaves invalid JSON untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avc-setup-'));
    const file = join(dir, 'Claude', 'claude_desktop_config.json');
    mkdirSync(join(dir, 'Claude'));
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const r = writeMcpConfig(file, spec, { now: new Date('2026-10-15T00:00:00Z') });
    expect(r.changed).toBe(true);
    expect(r.backup && readFileSync(r.backup, 'utf8')).toContain('other');
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.avc.command).toBe('/n/node');

    writeFileSync(file, '{ not json');
    expect(() => writeMcpConfig(file, spec)).toThrow(/left untouched/);
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('writes nothing on a dry run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avc-setup-'));
    const file = join(dir, 'Claude', 'claude_desktop_config.json');
    const r = writeMcpConfig(file, spec, { dryRun: true });
    expect(r.changed).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('claudeCodeAddArgs', () => {
  it('registers at user scope with env and the absolute command', () => {
    expect(
      claudeCodeAddArgs({ command: '/n/node', args: ['/p/avc.mjs', 'mcp'], env: { PATH: '/n' } }),
    ).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      'avc',
      '-e',
      'PATH=/n',
      '--',
      '/n/node',
      '/p/avc.mjs',
      'mcp',
    ]);
  });
});
