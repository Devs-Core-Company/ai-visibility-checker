/**
 * Rollback snapshots: `<dataDir>/rollback/<site>/<timestamp>.json`. Written before any change
 * is made, updated with per-change status afterwards.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

export function timestamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export function siteSlug(site: string): string {
  try {
    return new URL(site).host
      .replace(/^www\./, '')
      .replace(/[^a-z0-9.-]/gi, '-')
      .toLowerCase();
  } catch {
    return site.replace(/[^a-z0-9.-]/gi, '-').toLowerCase() || 'site';
  }
}

export function snapshotPath(dataDir: string, site: string, at = new Date()): string {
  return join(dataDir, 'rollback', siteSlug(site), `${timestamp(at)}.json`);
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
