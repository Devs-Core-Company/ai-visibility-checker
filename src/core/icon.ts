/**
 * The AVC logo as a data URI, for clients that show an MCP server's icon (serverInfo.icons).
 * Read from public/icon-128.png next to src/ or dist/; null when it is not there.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null | undefined;

export function iconDataUri(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const p = join(dir, 'public', 'icon-128.png');
    if (existsSync(p)) {
      cached = `data:image/png;base64,${readFileSync(p).toString('base64')}`;
      break;
    }
    dir = dirname(dir);
  }
  return cached;
}
