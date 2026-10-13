// Runs after `tsc` in `npm run compile`.
// - makes dist/cli.js executable and makes sure it starts with the node shebang
// - checks the dashboard assets in public/ are present (they are served from the
//   package root, so nothing needs copying)
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');

if (!existsSync(cli)) {
  console.error('postbuild: dist/cli.js not found. Did tsc run?');
  process.exit(1);
}

const shebang = '#!/usr/bin/env node';
const src = readFileSync(cli, 'utf8');
if (!src.startsWith('#!')) writeFileSync(cli, `${shebang}\n${src}`);

try {
  chmodSync(cli, 0o755);
} catch {
  // Windows: npm creates a .cmd shim, so the mode does not matter.
}

for (const asset of ['public/app.css', 'public/app.js']) {
  if (!existsSync(join(root, asset)))
    console.warn(`postbuild: ${asset} is missing; the dashboard will look unstyled.`);
}

console.log('postbuild: dist/cli.js is ready.');
