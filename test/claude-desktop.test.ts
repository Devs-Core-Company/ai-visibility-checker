import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  configHasServer,
  desktopProcessQuery,
  guardDesktopWrite,
  parseDesktopRunning,
  verifyDesktopWrite,
} from '../src/cli/claude-desktop.js';

describe('desktopProcessQuery', () => {
  it('uses an exact process name on macOS, tasklist on Windows, pgrep -f on Linux', () => {
    expect(desktopProcessQuery('darwin')).toEqual({
      command: 'pgrep',
      args: ['-a', '-x', 'Claude'],
    });
    expect(desktopProcessQuery('win32').command).toBe('tasklist');
    expect(desktopProcessQuery('win32').args).toContain('IMAGENAME eq Claude.exe');
    expect(desktopProcessQuery('linux')).toEqual({
      command: 'pgrep',
      args: ['-f', 'claude-desktop'],
    });
  });
});

describe('parseDesktopRunning', () => {
  it('reads pgrep output', () => {
    expect(parseDesktopRunning('darwin', '4242\n', 0, 1)).toBe(true);
    expect(parseDesktopRunning('darwin', '', 1, 1)).toBe(false);
    expect(parseDesktopRunning('linux', '101\n202\n', 0, 1)).toBe(true);
  });

  it('ignores its own pid, so pgrep -f never matches AVC itself', () => {
    expect(parseDesktopRunning('linux', '777\n', 0, 777)).toBe(false);
  });

  it('reads tasklist CSV output', () => {
    const running =
      '"Claude.exe","1234","Console","1","150,000 K"\r\n"Claude.exe","5678","Console","1","80,000 K"\r\n';
    expect(parseDesktopRunning('win32', running, 0)).toBe(true);
    expect(
      parseDesktopRunning(
        'win32',
        'INFO: No tasks are running which match the specified criteria.\r\n',
        0,
      ),
    ).toBe(false);
  });
});

describe('guardDesktopWrite', () => {
  it('does nothing when the app is not running', async () => {
    const prompt = vi.fn();
    const r = await guardDesktopWrite('removing AVC', {
      isRunning: () => false,
      interactive: () => true,
      prompt,
    });
    expect(r).toEqual({ stillRunning: false });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('warns and goes ahead without a terminal', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await guardDesktopWrite('removing AVC', {
      isRunning: () => true,
      interactive: () => false,
    });
    expect(r).toEqual({ stillRunning: true });
    log.mockRestore();
    err.mockRestore();
  });

  it('re-checks after each Enter until the app has quit', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const states = [true, true, false];
    const prompt = vi.fn(async () => '');
    const r = await guardDesktopWrite('adding AVC', {
      isRunning: () => states.shift() ?? false,
      interactive: () => true,
      prompt,
    });
    expect(r).toEqual({ stillRunning: false });
    expect(prompt).toHaveBeenCalledTimes(2);
    log.mockRestore();
    err.mockRestore();
  });

  it('lets the user continue anyway', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await guardDesktopWrite('adding AVC', {
      isRunning: () => true,
      interactive: () => true,
      prompt: async () => 'C',
    });
    expect(r).toEqual({ stillRunning: true });
    log.mockRestore();
    err.mockRestore();
  });
});

describe('configHasServer and verifyDesktopWrite', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'avc-desktop-')), 'claude_desktop_config.json');

  it('reads whether the entry is there', () => {
    expect(configHasServer(file, 'avc')).toBe(false);
    writeFileSync(file, JSON.stringify({ mcpServers: { avc: { command: 'node' } } }));
    expect(configHasServer(file, 'avc')).toBe(true);
    writeFileSync(file, '{not json');
    expect(configHasServer(file, 'avc')).toBe(false);
  });

  it('reports when the app has written the old entry back', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(file, JSON.stringify({ mcpServers: { avc: { command: 'node' } } }));
    expect(await verifyDesktopWrite(file, 'avc', false, { delayMs: 0 })).toBe(false);
    writeFileSync(file, JSON.stringify({ mcpServers: {} }));
    expect(await verifyDesktopWrite(file, 'avc', false, { delayMs: 0 })).toBe(true);
    log.mockRestore();
    err.mockRestore();
  });
});
