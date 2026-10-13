import { writeFileSync } from 'node:fs';
import { c, ok, progressPrinter } from '../output.js';
import {
  audit,
  findAudit,
  generate,
  getConfig,
  resolveSite,
  type GenerateKind,
  type RobotsChoice,
} from '../services.js';

export async function cmdGenerate(
  kind: GenerateKind,
  target: string,
  opts: { out?: string; policy?: RobotsChoice; fresh?: boolean },
): Promise<void> {
  const config = getConfig();
  let result = opts.fresh ? null : findAudit(target, config);
  const site = resolveSite(result?.startUrl ?? target, config);
  if (!result) {
    const progress = progressPrinter();
    console.error(c.dim(`No audit for ${site.id} yet; crawling up to 100 pages first…`));
    try {
      result = await audit(
        { url: site.url, site, maxPages: 100, render: false, onProgress: progress.onProgress },
        config,
      );
    } finally {
      progress.end();
    }
  }
  const g = generate(kind, result, site, { policy: opts.policy });
  if (opts.out) {
    writeFileSync(opts.out, g.body);
    ok(`Wrote ${opts.out}`);
    console.error(c.dim(g.where));
  } else {
    process.stdout.write(g.body.endsWith('\n') ? g.body : g.body + '\n');
    if (process.stderr.isTTY) console.error(c.dim(`\n${g.where}`));
  }
}
