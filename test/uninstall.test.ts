import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'avc-uninstall-'));
process.env.AVC_DATA_DIR = dataDir;
process.env.AVC_SECRET_STORE = 'file';

const { saveSecrets } = await import('../src/core/config.js');
const { resetSecretStore, secretStore } = await import('../src/core/secrets.js');
const { cleanupLocalData, unsafeDataDir } = await import('../src/cli/commands/uninstall.js');

function seed(dir = dataDir): void {
  mkdirSync(join(dir, 'tokens'), { recursive: true });
  mkdirSync(join(dir, 'rollback', 'example.com'), { recursive: true });
  writeFileSync(join(dir, 'avc.sqlite'), 'db');
  writeFileSync(join(dir, 'config.json'), '{}');
  writeFileSync(join(dir, 'tokens', 'google.json'), '{}');
  writeFileSync(join(dir, 'rollback', 'example.com', 'x.json'), '{}');
}

describe('avc uninstall cleanup', () => {
  beforeEach(() => {
    mkdirSync(dataDir, { recursive: true });
    resetSecretStore();
    seed();
    saveSecrets({ openai: 'sk-uninstall-test-0001', anthropic: 'sk-ant-uninstall-0001' });
  });

  it('deletes stored keys and keeps the data by default', () => {
    const r = cleanupLocalData({ dataDir, deleteKeys: true, deleteData: false });
    expect(r.keysDeleted).toBe(2);
    expect(secretStore().getAll()).toEqual({});
    expect(existsSync(join(dataDir, 'avc.sqlite'))).toBe(true);
  });

  it('deletes only AVC files with the data, and the folder once empty', () => {
    const r = cleanupLocalData({ dataDir, deleteKeys: true, deleteData: true });
    expect(r.removed.map((p) => p.slice(dataDir.length + 1)).sort()).toEqual([
      'avc.sqlite',
      'config.json',
      'rollback',
      'tokens',
    ]);
    expect(existsSync(dataDir)).toBe(false);
  });

  it('leaves files that are not AVC’s, and the folder holding them', () => {
    writeFileSync(join(dataDir, 'my-notes.txt'), 'keep me');
    const r = cleanupLocalData({ dataDir, deleteKeys: true, deleteData: true });
    expect(r.leftover).toEqual(['my-notes.txt']);
    expect(existsSync(join(dataDir, 'my-notes.txt'))).toBe(true);
    expect(existsSync(join(dataDir, 'avc.sqlite'))).toBe(false);
  });

  it('keeps the key file when keys are kept but data is deleted', () => {
    cleanupLocalData({ dataDir, deleteKeys: false, deleteData: true });
    resetSecretStore();
    expect(secretStore().get('openai')).toBe('sk-uninstall-test-0001');
    expect(existsSync(join(dataDir, 'avc.sqlite'))).toBe(false);
  });

  it('refuses to delete in the home folder or the disk root', () => {
    expect(unsafeDataDir('/Users/a', '/Users/a')).toMatch(/home folder/);
    expect(unsafeDataDir('/Users', '/Users/a')).toMatch(/home folder/);
    expect(unsafeDataDir('/', '/Users/a')).toMatch(/root/);
    expect(unsafeDataDir('/Users/a/.avc', '/Users/a')).toBeNull();
  });
});

describe('Claude Code local-scope entries', () => {
  it('finds every folder where AVC was added at local scope', async () => {
    const { claudeCodeLocalEntries } = await import('../src/cli/commands/uninstall.js');
    const home = mkdtempSync(join(tmpdir(), 'avc-home-'));
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { avc: {} },
        projects: {
          '/Users/a': { mcpServers: { avc: { command: 'npx' } } },
          '/Users/a/site': { mcpServers: { other: {} } },
          '/Users/a/empty': {},
        },
      }),
    );
    expect(claudeCodeLocalEntries(home)).toEqual(['/Users/a']);
    expect(claudeCodeLocalEntries(mkdtempSync(join(tmpdir(), 'avc-none-')))).toEqual([]);
  });
});

describe('scheduled runs from avc schedule', () => {
  it('finds only AVC LaunchAgents', async () => {
    const { findLaunchAgents } = await import('../src/cli/commands/uninstall.js');
    const home = mkdtempSync(join(tmpdir(), 'avc-la-'));
    const dir = join(home, 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    for (const f of [
      'com.devs-core.avc.example.com.audit.plist',
      'com.devs-core.avc.shop.example.visibility.plist',
      'com.google.keystone.agent.plist',
      'com.devs-core.other.plist',
    ])
      writeFileSync(join(dir, f), '');
    expect(
      findLaunchAgents(home)
        .map((p) => p.slice(dir.length + 1))
        .sort(),
    ).toEqual([
      'com.devs-core.avc.example.com.audit.plist',
      'com.devs-core.avc.shop.example.visibility.plist',
    ]);
  });

  it('matches only the cron lines avc schedule suggests', async () => {
    const { isAvcCronLine } = await import('../src/cli/commands/uninstall.js');
    expect(isAvcCronLine('0 9 * * 1 avc monitor run example.com >> ~/.avc/logs/a.log 2>&1')).toBe(
      true,
    );
    expect(isAvcCronLine('0 9 * * * /usr/bin/node /x/bin/avc.mjs monitor run example.com')).toBe(
      true,
    );
    expect(isAvcCronLine('# 0 9 * * * avc monitor run example.com')).toBe(false);
    expect(isAvcCronLine('0 3 * * * /usr/local/bin/backup.sh')).toBe(false);
    expect(isAvcCronLine('0 3 * * * echo "javc monitor running"')).toBe(false);
  });

  it('picks AVC tasks out of the Windows task list', async () => {
    const { avcTaskNames } = await import('../src/cli/commands/uninstall.js');
    const csv = [
      '"\\AVC example.com audit","16/10/2026 09:00:00","Ready"',
      '"\\AVC example.com visibility","N/A","Ready"',
      '"\\GoogleUpdateTaskMachineCore","16/10/2026 10:00:00","Ready"',
      '"\\AVC notes","N/A","Ready"',
    ].join('\r\n');
    expect(avcTaskNames(csv)).toEqual(['AVC example.com audit', 'AVC example.com visibility']);
  });
});
