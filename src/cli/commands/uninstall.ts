/**
 * `avc uninstall`: take AVC out of Claude Desktop, Claude Code and Cursor, delete the stored
 * API keys, and optionally the local data. The program itself is removed by the package
 * manager afterwards (a running program cannot cleanly delete itself), so the last step is
 * printed rather than run.
 *
 * Only files AVC creates are deleted, never a whole folder blindly: AVC_DATA_DIR may point at
 * a folder that holds other things too.
 */
import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { userConfigPath } from '../../core/config.js';
import { resetSecretStore, secretStore } from '../../core/secrets.js';
import { confirm, interactive } from '../ask.js';
import { c, ok, warn } from '../output.js';
import { getConfig, resetStoreCache } from '../services.js';
import { cmdSetupClaude, packageRoot } from './setup-claude.js';

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
  '.keys-offered',
];

export interface CleanupResult {
  keysDeleted: number;
  keysWhere?: string;
  removed: string[];
  /** Other files left in the data folder (not AVC's). */
  leftover: string[];
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
  console.log(
    c.dim(
      '  Installed as a Claude Desktop extension? Remove it in Claude Desktop → Settings → Extensions → AI Visibility Checker → Uninstall.',
    ),
  );

  // 2. Keys: deleted unless asked to keep them. Leftover keys are the privacy risk.
  console.log('\n' + c.bold('2. Stored API keys'));
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

  // 3. Data: kept unless asked to delete it. It is the user's audit history.
  console.log('\n' + c.bold('3. Audit history and settings'));
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

  // 4. The program.
  console.log('\n' + c.bold('4. Remove the program'));
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
