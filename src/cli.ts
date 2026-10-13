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

const { buildProgram } = await import('./cli/program.js');
await buildProgram().parseAsync(process.argv);
