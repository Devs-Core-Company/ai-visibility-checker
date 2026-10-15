#!/usr/bin/env node
/**
 * `avc`: the AI Visibility Checker command line.
 * Everything lives in ./cli/program.ts; this file only checks Node and starts it.
 */
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `AI Visibility Checker needs Node.js 22.5 or newer (you have ${process.versions.node}). Install it from https://nodejs.org.`,
  );
  process.exit(1);
}

// node:sqlite prints an ExperimentalWarning on every run; it is expected, so hide just that one.
const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : (warning as Error | undefined)?.message;
  if (text && /SQLite is an experimental feature/.test(text)) return;
  emitWarning(warning, ...rest);
}) as typeof process.emitWarning;

// `avc … | head` closes stdout early: exit quietly instead of crashing.
for (const stream of [process.stdout, process.stderr])
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw err;
  });

// Unfilled optional settings from the Claude Desktop extension must not look like keys.
const { dropUnfilledPlaceholders } = await import('./core/secrets.js');
dropUnfilledPlaceholders();

const { buildProgram } = await import('./cli/program.js');
await buildProgram().parseAsync(process.argv);
