/**
 * Claude Desktop keeps its MCP config in memory while it runs and writes that copy back to
 * claude_desktop_config.json later, undoing any edit made in the meantime (seen on macOS about
 * a minute after `avc uninstall`). So before AVC edits that file, it checks whether the app is
 * running and asks the user to quit it first.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { ask, interactive } from './ask.js';
import { c, ok, warn } from './output.js';

/** The command that lists a running Claude Desktop, per platform. */
export function desktopProcessQuery(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  // -a: macOS pgrep skips its own ancestors by default, which hides the app when AVC runs in
  // a terminal opened from Claude Desktop itself.
  if (platform === 'darwin') return { command: 'pgrep', args: ['-a', '-x', 'Claude'] };
  if (platform === 'win32')
    return { command: 'tasklist', args: ['/FI', 'IMAGENAME eq Claude.exe', '/FO', 'CSV', '/NH'] };
  // Linux has no official build; community packages run as claude-desktop.
  return { command: 'pgrep', args: ['-f', 'claude-desktop'] };
}

/**
 * Whether the query's output shows Claude Desktop running. pgrep prints one pid per line and
 * exits 1 when nothing matches; tasklist exits 0 either way and prints an "INFO:" line when
 * nothing matches. `selfPid` is ignored so `pgrep -f` never counts AVC itself.
 */
export function parseDesktopRunning(
  platform: NodeJS.Platform,
  stdout: string,
  status: number | null,
  selfPid: number = process.pid,
): boolean {
  if (platform === 'win32') return /^"Claude\.exe"/im.test(stdout);
  if (status !== 0) return false;
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => /^\d+$/.test(l) && Number(l) !== selfPid);
}

/** Whether Claude Desktop is running now. False when the check itself cannot run. */
export function isClaudeDesktopRunning(platform: NodeJS.Platform = process.platform): boolean {
  const q = desktopProcessQuery(platform);
  const r = spawnSync(q.command, q.args, { encoding: 'utf8', windowsHide: true });
  if (r.error) return false;
  return parseDesktopRunning(platform, r.stdout ?? '', r.status);
}

const quitKeys = (platform: NodeJS.Platform): string =>
  platform === 'darwin' ? '⌘Q' : platform === 'win32' ? 'File → Exit' : 'File → Quit';

export interface DesktopGuard {
  /** The app was still running when the config was written. */
  stillRunning: boolean;
}

/**
 * Call before editing the desktop config. Interactive: ask the user to quit the app and press
 * Enter, re-checking each time, or type "c" to go ahead anyway. Otherwise: warn and go ahead.
 */
export async function guardDesktopWrite(
  action: string,
  deps: {
    isRunning?: () => boolean;
    interactive?: () => boolean;
    prompt?: (q: string) => Promise<string>;
    platform?: NodeJS.Platform;
  } = {},
): Promise<DesktopGuard> {
  const isRunning = deps.isRunning ?? (() => isClaudeDesktopRunning());
  const tty = (deps.interactive ?? interactive)();
  const prompt = deps.prompt ?? ((q: string) => ask(q));
  const keys = quitKeys(deps.platform ?? process.platform);
  if (!isRunning()) return { stillRunning: false };

  warn(
    `Claude Desktop is running. It keeps its settings in memory and writes them back over the file, which would undo this (${action}).`,
  );
  if (!tty) {
    console.log(
      c.dim(
        `  Writing anyway. If the change does not stick: quit Claude Desktop (${keys}; closing the window is not enough), then run this command again.`,
      ),
    );
    return { stillRunning: true };
  }
  for (;;) {
    const a = (
      await prompt(
        `  Quit Claude Desktop now (${keys}; closing the window is not enough), then press Enter. Type c to continue anyway`,
      )
    ).toLowerCase();
    if (a === 'c' || a === 'continue') return { stillRunning: isRunning() };
    if (!isRunning()) {
      ok('Claude Desktop has quit.');
      return { stillRunning: false };
    }
    warn('Claude Desktop is still running.');
  }
}

/** Whether the config file has the named MCP server. */
export function configHasServer(file: string, name: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> };
    return Boolean(data.mcpServers && Object.hasOwn(data.mcpServers, name));
  } catch {
    return false;
  }
}

/**
 * After writing while the app was running: wait a little, re-read the file and warn when the
 * app has already put the old entry back (or taken the new one out). A clean re-read does not
 * prove the edit will last, so the warning about quitting stays either way.
 */
export async function verifyDesktopWrite(
  file: string,
  name: string,
  expectPresent: boolean,
  opts: { delayMs?: number; platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  const delayMs = opts.delayMs ?? 5000;
  const keys = quitKeys(opts.platform ?? process.platform);
  console.log(c.dim(`  Checking the file again in ${Math.round(delayMs / 1000)} s…`));
  await new Promise((r) => setTimeout(r, delayMs));
  const held = configHasServer(file, name) === expectPresent;
  if (!held)
    warn(
      `Claude Desktop has already written its old settings back: the "${name}" entry is ${expectPresent ? 'missing' : 'back'} in ${file}. Quit Claude Desktop (${keys}), then run this command again.`,
    );
  else
    console.log(
      c.dim(
        `  The change is still there, but Claude Desktop may still write its old copy back while it runs. Quit it (${keys}) and check ${file} if AVC ${expectPresent ? 'does not appear' : 'is still listed'}.`,
      ),
    );
  return held;
}
