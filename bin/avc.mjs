#!/usr/bin/env node
// Launcher for `avc`. Uses the compiled build (dist/) when it exists and is up to date, as
// in Docker or after `npm run compile`. Otherwise it runs the TypeScript source through tsx,
// so installing straight from GitHub needs no build step, and editing src/ in a checkout
// never silently runs an older build.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, 'dist', 'cli.js');
const src = join(root, 'src');

// History lives in SQLite through node:sqlite. Node 22.5 to 22.12 ship it behind the
// --experimental-sqlite flag (it is on by default from 22.13 and 23.4), so on those versions
// the launcher starts Node again with the flag instead of failing later with
// "No such built-in module: node:sqlite". stdio is passed straight through, so this also
// works for `avc mcp`, where stdin/stdout carry the MCP protocol.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `AI Visibility Checker needs Node.js 22.5 or newer (you have ${process.versions.node}). Install Node 24 LTS from https://nodejs.org.`,
  );
  process.exit(1);
}
if (!sqliteAvailable()) {
  if (process.env.AVC_SQLITE_FLAG_TRIED === '1') {
    console.error(
      `AI Visibility Checker could not load node:sqlite on Node ${process.versions.node}, even with --experimental-sqlite. Install Node 24 LTS from https://nodejs.org.`,
    );
    process.exit(1);
  }
  const child = spawn(
    process.execPath,
    [
      '--experimental-sqlite',
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, AVC_SQLITE_FLAG_TRIED: '1' } },
  );
  // Ctrl+C reaches the child through the shared process group; forward the rest.
  for (const signal of ['SIGTERM', 'SIGHUP'])
    process.on(signal, () => {
      if (child.exitCode === null) child.kill(signal);
    });
  process.on('SIGINT', () => {});
  child.on('error', (err) => {
    console.error(`Could not start Node with --experimental-sqlite: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      // End this process the same way, so the caller sees the real cause.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  });
} else {
  await start();
}

/** Whether node:sqlite loads in this process (no ExperimentalWarning is printed on failure). */
function sqliteAvailable() {
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  } finally {
    process.emitWarning = emit;
  }
}

/** Newest modification time of any file under dir (ms), or 0. */
function newest(dir) {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return max;
}

async function start() {
  const useBuilt =
    existsSync(built) && (!existsSync(src) || statSync(built).mtimeMs >= newest(src));
  if (useBuilt) {
    await import(pathToFileURL(built).href);
  } else {
    const { register } = await import('tsx/esm/api');
    register({ tsconfig: join(root, 'tsconfig.json') });
    await import(pathToFileURL(join(src, 'cli.ts')).href);
  }
}
