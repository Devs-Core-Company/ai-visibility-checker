/**
 * `avc uninstall`: take AVC out of Claude Desktop, Claude Code and Cursor, delete the stored
 * API keys, and optionally the local data. The program itself is removed by the package
 * manager afterwards (a running program cannot cleanly delete itself), so the last step is
 * printed rather than run.
 *
 * Only files AVC creates are deleted, never a whole folder blindly: AVC_DATA_DIR may point at
 * a folder that holds other things too.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { userConfigPath } from '../../core/config.js';
import { resetSecretStore, secretStore } from '../../core/secrets.js';
import { confirm, interactive } from '../ask.js';
import { c, ok, warn } from '../output.js';
import { getConfig, resetStoreCache } from '../services.js';
import { SERVER_NAME, cmdSetupClaude, hasClaudeCli, packageRoot } from './setup-claude.js';
import { shortcutPaths } from './tools.js';

/** Everything AVC writes in its data folder. */
export const DATA_ENTRIES = [
  'avc.sqlite',
  'avc.sqlite-wal',
  'avc.sqlite-shm',
  'avc.sqlite-journal',
  'config.json',
  'secrets.json',
  'secrets.dpapi',
  'tokens',
  'rollback',
  'logs',
  '.keys-offered',
];

export interface CleanupResult {
  keysDeleted: number;
  keysWhere?: string;
  removed: string[];
  /** Other files left in the data folder (not AVC's). */
  leftover: string[];
}

/**
 * Folders where Claude Code has AVC at local scope (added with `claude mcp add` inside that
 * folder, without --scope user). `setup-claude --remove` only covers user scope, so these
 * would otherwise survive an uninstall. Read from ~/.claude.json; never written here.
 */
export function claudeCodeLocalEntries(home = homedir(), name = SERVER_NAME): string[] {
  try {
    const data = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    return Object.entries(data.projects ?? {})
      .filter(([, p]) => p?.mcpServers && name in p.mcpServers)
      .map(([path]) => path);
  } catch {
    return [];
  }
}

/** Remove local-scope entries through Claude Code itself, run from each folder. */
function removeClaudeCodeLocalEntries(): void {
  const folders = claudeCodeLocalEntries();
  if (!folders.length) return;
  if (!hasClaudeCli()) {
    warn(
      `Claude Code also has AVC set up in ${folders.length} folder(s), but the \`claude\` command was not found. In each folder run: claude mcp remove --scope local ${SERVER_NAME}`,
    );
    return;
  }
  for (const folder of folders) {
    if (!existsSync(folder)) {
      warn(
        `Claude Code lists AVC for ${folder}, which no longer exists. Remove it from ~/.claude.json by hand if it bothers you.`,
      );
      continue;
    }
    const r = spawnSync('claude', ['mcp', 'remove', '--scope', 'local', SERVER_NAME], {
      cwd: folder,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (r.status === 0) ok(`Removed from Claude Code in ${folder}.`);
    else warn(`Claude Code in ${folder}: ${(r.stderr || r.stdout || 'remove failed').trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Scheduled runs set up from `avc schedule`, and the `avc shortcut` app launcher
// ---------------------------------------------------------------------------

/** macOS: LaunchAgents saved from `avc schedule` (label com.devs-core.avc.<site>.<kind>). */
export function findLaunchAgents(home = homedir()): string[] {
  const dir = join(home, 'Library', 'LaunchAgents');
  try {
    return readdirSync(dir)
      .filter((f) => /^com\.devs-core\.avc\..+\.plist$/.test(f))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Linux/macOS cron: the lines `avc schedule` suggests (they run `avc monitor run`). */
export const isAvcCronLine = (line: string): boolean =>
  !line.trim().startsWith('#') && /\bavc(\.mjs)?["']?\s+monitor\s+run\b/.test(line);

/** Windows: task names from `schtasks /Query /FO CSV /NH` that `avc schedule` creates ("AVC <site> <kind>"). */
export function avcTaskNames(csv: string): string[] {
  const names = new Set<string>();
  for (const line of csv.split(/\r?\n/)) {
    const name = line.match(/^"([^"]+)"/)?.[1]?.replace(/^\\/, '');
    if (name && /^AVC \S+ (audit|visibility)$/.test(name)) names.add(name);
  }
  return [...names];
}

interface FoundSchedules {
  launchAgents: string[];
  cronLines: string[];
  cronText: string;
  tasks: string[];
}

function findSchedules(): FoundSchedules {
  const out: FoundSchedules = { launchAgents: [], cronLines: [], cronText: '', tasks: [] };
  if (process.platform === 'darwin') out.launchAgents = findLaunchAgents();
  if (process.platform === 'win32') {
    const r = spawnSync('schtasks', ['/Query', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status === 0) out.tasks = avcTaskNames(r.stdout);
  } else {
    const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
    if (r.status === 0) {
      out.cronText = r.stdout;
      out.cronLines = r.stdout.split('\n').filter(isAvcCronLine);
    }
  }
  return out;
}

function removeSchedules(found: FoundSchedules): void {
  for (const plist of found.launchAgents) {
    spawnSync('launchctl', ['unload', plist], { stdio: 'ignore' });
    rmSync(plist, { force: true });
    ok(`Removed the scheduled run ${plist}`);
  }
  if (found.cronLines.length) {
    const kept = found.cronText
      .split('\n')
      .filter((l) => !isAvcCronLine(l))
      .join('\n');
    const r = spawnSync('crontab', ['-'], { input: kept, encoding: 'utf8' });
    if (r.status === 0) ok(`Removed ${found.cronLines.length} AVC line(s) from your crontab.`);
    else
      warn(
        `Could not update your crontab: ${r.stderr.trim()}. Remove the avc lines with \`crontab -e\`.`,
      );
  }
  for (const task of found.tasks) {
    const r = spawnSync('schtasks', ['/Delete', '/TN', task, '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (r.status === 0) ok(`Removed the scheduled task "${task}".`);
    else warn(`Could not remove the task "${task}". Run: schtasks /Delete /TN "${task}" /F`);
  }
}

/** Refuse folders whose deletion would be a disaster even if AVC files sit in them. */
export function unsafeDataDir(dir: string, home = homedir()): string | null {
  const d = resolve(dir);
  const h = resolve(home);
  if (d === resolve('/') || /^[A-Za-z]:\\?$/.test(d)) return 'it is the root of the disk';
  if (d === h || h.startsWith(d + sep)) return 'it is your home folder or contains it';
  return null;
}

/** Delete stored keys and/or AVC's own files in the data folder. */
export function cleanupLocalData(opts: {
  dataDir: string;
  deleteKeys: boolean;
  deleteData: boolean;
}): CleanupResult {
  const out: CleanupResult = { keysDeleted: 0, removed: [], leftover: [] };
  if (opts.deleteKeys) {
    const store = secretStore();
    const ids = Object.keys(store.getAll());
    out.keysWhere = store.where;
    if (ids.length) store.setMany(Object.fromEntries(ids.map((id) => [id, ''])));
    out.keysDeleted = ids.length;
    resetSecretStore();
  }
  if (opts.deleteData && existsSync(opts.dataDir)) {
    const why = unsafeDataDir(opts.dataDir);
    if (why) throw new Error(`Not deleting files in ${opts.dataDir}: ${why}.`);
    resetStoreCache();
    // Keys kept: keep the key file too (it holds them where no OS keychain exists).
    const keyFiles = ['secrets.json', 'secrets.dpapi'];
    for (const name of DATA_ENTRIES) {
      if (!opts.deleteKeys && keyFiles.includes(name)) continue;
      const p = join(opts.dataDir, name);
      if (!existsSync(p)) continue;
      rmSync(p, { recursive: true, force: true });
      out.removed.push(p);
    }
    const remaining = readdirSync(opts.dataDir);
    out.leftover = remaining.filter((n) => !keyFiles.includes(n));
    if (!remaining.length) rmdirSync(opts.dataDir);
  }
  return out;
}

export interface UninstallOpts {
  yes?: boolean;
  keepKeys?: boolean;
  deleteData?: boolean;
  keepData?: boolean;
}

export async function cmdUninstall(opts: UninstallOpts): Promise<void> {
  const config = getConfig();
  const ask = interactive() && !opts.yes;
  console.log(c.bold('Uninstall AI Visibility Checker'));

  // 1. Claude Desktop, Claude Code and Cursor.
  console.log('\n' + c.bold('1. Disconnect from Claude and Cursor'));
  await cmdSetupClaude({ remove: true });
  removeClaudeCodeLocalEntries();
  console.log(
    c.dim(
      `  A repository with AVC in its own .mcp.json keeps it there; remove the "${SERVER_NAME}" entry from that file if you added one.`,
    ),
  );
  console.log(
    c.dim(
      '  Installed as a Claude Desktop extension? Remove it in Claude Desktop → Settings → Extensions → AI Visibility Checker → Uninstall.',
    ),
  );

  // 2. App shortcut and scheduled runs: they would point at a program that is gone.
  console.log('\n' + c.bold('2. App shortcut and scheduled runs'));
  const shortcuts = shortcutPaths().filter((p) => existsSync(p));
  for (const p of shortcuts) {
    rmSync(p, { recursive: true, force: true });
    ok(`Removed the app shortcut ${p}`);
  }
  const found = findSchedules();
  const scheduled = [...found.launchAgents, ...found.cronLines, ...found.tasks];
  if (scheduled.length) {
    console.log('  Scheduled AVC runs found:');
    for (const s of scheduled) console.log(c.dim(`    ${s}`));
    if (!ask || (await confirm('  Remove them? They fail once AVC is gone.', true)))
      removeSchedules(found);
    else console.log(c.dim('  Kept them.'));
  }
  if (!shortcuts.length && !scheduled.length) console.log(c.dim('  None found.'));

  // 3. Keys: deleted unless asked to keep them. Leftover keys are the privacy risk.
  console.log('\n' + c.bold('3. Stored API keys'));
  let storedKeys = 0;
  try {
    storedKeys = Object.keys(secretStore().getAll()).length;
  } catch (e) {
    warn(`Could not read stored keys: ${(e as Error).message}`);
  }
  let deleteKeys = false;
  if (!storedKeys) console.log(c.dim('  None stored.'));
  else if (opts.keepKeys) console.log(c.dim(`  Kept ${storedKeys} key(s) (--keep-keys).`));
  else if (ask)
    deleteKeys = await confirm(
      `  Delete ${storedKeys} stored API key(s) from ${secretStore().where}?`,
      true,
    );
  else if (opts.yes) deleteKeys = true;
  else
    console.log(
      c.dim(`  Kept ${storedKeys} key(s): no terminal to ask in. Pass --yes to delete them.`),
    );

  if (deleteKeys) {
    const k = cleanupLocalData({ dataDir: config.dataDir, deleteKeys: true, deleteData: false });
    ok(`Deleted ${k.keysDeleted} key(s) from ${k.keysWhere}.`);
  }

  // 4. Data: kept unless asked to delete it. It is the user's audit history.
  console.log('\n' + c.bold('4. Audit history and settings'));
  const present = DATA_ENTRIES.filter((n) => existsSync(join(config.dataDir, n)));
  let deleteData = false;
  if (!present.length) console.log(c.dim('  Nothing stored.'));
  else if (opts.keepData) console.log(c.dim(`  Kept ${config.dataDir} (--keep-data).`));
  else if (opts.deleteData) deleteData = true;
  else if (ask)
    deleteData = await confirm(
      `  Also delete your audits, settings, Google sign-in and WordPress rollback snapshots in ${config.dataDir}? (Undo for applied WordPress fixes is lost.)`,
      false,
    );
  else console.log(c.dim(`  Kept ${config.dataDir}. Pass --delete-data to delete it.`));

  // Key files go with the data only when the keys were deleted above.
  const r = cleanupLocalData({ dataDir: config.dataDir, deleteKeys: false, deleteData });
  if (deleteData) {
    ok(`Deleted ${r.removed.length} item(s) from ${config.dataDir}.`);
    if (r.leftover.length)
      console.log(
        c.dim(`  Left other files there untouched: ${r.leftover.slice(0, 5).join(', ')}`),
      );
  } else if (ask && present.length && !opts.keepData)
    console.log(c.dim(`  Kept ${config.dataDir} (config: ${userConfigPath()}).`));

  // 5. The program.
  console.log('\n' + c.bold('5. Remove the program'));
  const root = packageRoot();
  if (/[\\/]_npx[\\/]/.test(root)) console.log(c.dim('  Running through npx: nothing to remove.'));
  else if (/node_modules/.test(root)) {
    console.log('  Run this to finish:');
    console.log(`    ${c.cyan('npm uninstall -g @devs-core/ai-visibility-checker')}`);
  } else console.log(c.dim(`  Running from a checkout (${root}); delete that folder if you like.`));
  console.log(
    c.dim(
      '\nIf you used Claude Desktop, quit it fully and reopen it so AVC disappears from the tools list.',
    ),
  );
}
