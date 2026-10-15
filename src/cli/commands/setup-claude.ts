/**
 * `avc setup-claude`: register the AVC MCP server with the Claude desktop app, Claude Code
 * (user scope, so every folder) and, when present, Cursor.
 *
 * Why not `claude mcp add` alone: that only reaches Claude Code, at local scope by default
 * (one folder), and the desktop app keeps its own config. The desktop app also does not
 * inherit your shell's PATH, so a bare `npx` fails silently with nvm, conda or Homebrew.
 * The entry written here therefore uses absolute paths: the node binary running this
 * command and AVC's own launcher, plus a PATH that contains that node.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { c, fail, ok, warn } from '../output.js';
import { ExitError } from '../errors.js';

export const SERVER_NAME = 'avc';
const REPO_SPEC = 'github:Devs-Core-Company/ai-visibility-checker';

export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Where the Claude desktop app keeps its MCP config, per platform. */
export function desktopConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === 'darwin')
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32')
    return join(
      env.APPDATA || join(home, 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json',
    );
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

export function cursorConfigPath(home: string = homedir()): string {
  return join(home, '.cursor', 'mcp.json');
}

/** The package root (the folder holding bin/avc.mjs), from this file in src/ or dist/. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * How Claude should start the server. From a lasting install: this node binary plus
 * bin/avc.mjs, by absolute path. From a throwaway npx cache (which npm may clear): the
 * absolute npx next to this node, which fetches the package when needed.
 */
export function launchSpec(
  opts: {
    execPath?: string;
    root?: string;
    platform?: NodeJS.Platform;
  } = {},
): LaunchSpec {
  const execPath = opts.execPath ?? process.execPath;
  const root = opts.root ?? packageRoot();
  const platform = opts.platform ?? process.platform;
  const nodeDir = dirname(execPath);
  const env: Record<string, string> | undefined =
    platform === 'win32'
      ? undefined
      : {
          PATH: [nodeDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
            .filter((p, i, all) => all.indexOf(p) === i)
            .join(':'),
        };
  const fromNpxCache = /[\\/]_npx[\\/]/.test(root);
  if (fromNpxCache) {
    const npx = join(nodeDir, platform === 'win32' ? 'npx.cmd' : 'npx');
    return { command: existsSync(npx) ? npx : 'npx', args: ['-y', REPO_SPEC, 'mcp'], env };
  }
  return { command: execPath, args: [join(root, 'bin', 'avc.mjs'), 'mcp'], env };
}

/**
 * Merge (or remove) the server in an MCP config file's text, keeping every other key and
 * server. Throws on JSON the user would not want overwritten.
 */
export function mergeMcpConfig(
  existing: string | null,
  spec: LaunchSpec | null,
  name = SERVER_NAME,
): { text: string; changed: boolean } {
  let data: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    const parsed: unknown = JSON.parse(existing);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('the file is not a JSON object');
    data = parsed as Record<string, unknown>;
  }
  const servers =
    data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
      ? { ...(data.mcpServers as Record<string, unknown>) }
      : {};
  const before = JSON.stringify(servers[name] ?? null);
  if (spec)
    servers[name] = {
      command: spec.command,
      args: spec.args,
      ...(spec.env ? { env: spec.env } : {}),
    };
  else delete servers[name];
  const changed = JSON.stringify(servers[name] ?? null) !== before;
  return { text: `${JSON.stringify({ ...data, mcpServers: servers }, null, 2)}\n`, changed };
}

/** Writes a merged MCP config file, with a timestamped backup of the previous one. */
export function writeMcpConfig(
  file: string,
  spec: LaunchSpec | null,
  opts: { dryRun?: boolean; now?: Date } = {},
): { changed: boolean; backup?: string; text: string } {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
  let merged: { text: string; changed: boolean };
  try {
    merged = mergeMcpConfig(existing, spec);
  } catch (e) {
    throw new ExitError(
      1,
      `${file} is not valid JSON (${(e as Error).message}), so it was left untouched. Fix or remove it, then run this again.`,
    );
  }
  if (!merged.changed || opts.dryRun) return { changed: merged.changed, text: merged.text };
  let backup: string | undefined;
  if (existing !== null) {
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    backup = `${file}.avc-backup-${stamp}`;
    copyFileSync(file, backup);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, merged.text);
  return { changed: true, backup, text: merged.text };
}

export function hasClaudeCli(): boolean {
  const r = spawnSync('claude', ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return r.status === 0;
}

/** The Claude Code command that registers the server at user scope (every folder). */
export function claudeCodeAddArgs(spec: LaunchSpec, name = SERVER_NAME): string[] {
  const envArgs = Object.entries(spec.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  // The name goes before -e: -e takes several values and would swallow it.
  return ['mcp', 'add', '--scope', 'user', name, ...envArgs, '--', spec.command, ...spec.args];
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function cmdSetupClaude(opts: {
  desktop?: boolean;
  code?: boolean;
  cursor?: boolean;
  dryRun?: boolean;
  remove?: boolean;
}): Promise<void> {
  const explicit = Boolean(opts.desktop || opts.code || opts.cursor);
  const spec = opts.remove ? null : launchSpec();
  const verb = opts.remove ? 'Removed from' : 'Added to';
  let done = 0;

  if (spec) {
    console.log(c.dim(`Server command: ${[spec.command, ...spec.args].map(shellQuote).join(' ')}`));
    if (/[\\/]_npx[\\/]/.test(packageRoot()))
      warn(
        'Running from a temporary npx copy, so Claude will start AVC through npx (the first start downloads it). For a faster, offline-safe setup, install it first: npm i -g ' +
          REPO_SPEC,
      );
  }

  // Claude desktop app (chat).
  const desktopFile = desktopConfigPath();
  const desktopPresent = existsSync(dirname(desktopFile));
  if (opts.desktop || (!explicit && desktopPresent)) {
    const r = writeMcpConfig(desktopFile, spec, { dryRun: opts.dryRun });
    if (opts.dryRun) console.log(`${c.bold('Claude desktop app')} ${desktopFile}\n${r.text}`);
    else if (r.changed) {
      ok(`${verb} the Claude desktop app: ${desktopFile}`);
      if (r.backup) console.log(c.dim(`  Previous config saved to ${r.backup}`));
      done++;
    } else ok(`Claude desktop app already ${opts.remove ? 'had no AVC entry' : 'set up'}.`);
  } else if (!explicit) {
    console.log(
      c.dim('Claude desktop app not found; skipped (use --desktop to set it up anyway).'),
    );
  }

  // Claude Code (CLI and the app's Code tab), user scope so it works in every folder.
  if (opts.code || !explicit) {
    if (hasClaudeCli()) {
      const removeArgs = ['mcp', 'remove', '--scope', 'user', SERVER_NAME];
      if (opts.dryRun) {
        console.log(`${c.bold('Claude Code')}\n  claude ${removeArgs.join(' ')}`);
        if (spec) console.log(`  claude ${claudeCodeAddArgs(spec).map(shellQuote).join(' ')}`);
      } else {
        spawnSync('claude', removeArgs, { stdio: 'ignore', shell: process.platform === 'win32' });
        if (spec) {
          const r = spawnSync('claude', claudeCodeAddArgs(spec), {
            encoding: 'utf8',
            shell: process.platform === 'win32',
          });
          if (r.status === 0) {
            ok('Added to Claude Code at user scope (every folder).');
            done++;
          } else fail(`Claude Code: ${(r.stderr || r.stdout || 'claude mcp add failed').trim()}`);
        } else {
          ok('Removed from Claude Code.');
          done++;
        }
      }
    } else {
      const msg = 'Claude Code (the `claude` command) not found; skipped.';
      if (opts.code) warn(msg);
      else console.log(c.dim(msg));
      if (spec && opts.code)
        console.log(
          `  When it is installed: claude ${claudeCodeAddArgs(spec).map(shellQuote).join(' ')}`,
        );
    }
  }

  // Cursor, when it is installed (or asked for).
  const cursorFile = cursorConfigPath();
  if (opts.cursor || (!explicit && existsSync(dirname(cursorFile)))) {
    const r = writeMcpConfig(cursorFile, spec, { dryRun: opts.dryRun });
    if (opts.dryRun) console.log(`${c.bold('Cursor')} ${cursorFile}\n${r.text}`);
    else if (r.changed) {
      ok(`${verb} Cursor: ${cursorFile}`);
      done++;
    }
  }

  if (opts.dryRun) {
    console.log(c.dim('Dry run: nothing was written.'));
    return;
  }
  if (done && !opts.remove) {
    console.log('');
    console.log(
      `${c.bold('Next:')} fully quit the Claude app (${process.platform === 'darwin' ? '⌘Q' : 'File → Exit'}, closing the window is not enough) and open it again. In a new chat, AVC appears under the tools menu. Try: "Audit https://yoursite.com with avc".`,
    );
    console.log(
      c.dim(
        `If it does not appear, the app's log says why: ${
          process.platform === 'darwin'
            ? '~/Library/Logs/Claude/mcp-server-avc.log'
            : process.platform === 'win32'
              ? '%APPDATA%\\Claude\\logs\\mcp-server-avc.log'
              : '~/.config/Claude/logs/mcp-server-avc.log'
        }. If you later change Node versions, run \`avc setup-claude\` again.`,
      ),
    );
  }
}
