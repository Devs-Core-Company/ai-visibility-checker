import type { CheckDef } from '../../core/types.js';
import { c, pillarName, sevLabel, table } from '../output.js';
import { listChecks } from '../services.js';

export async function cmdChecks(opts: { category?: string; pillar?: string; search?: string; json?: boolean }): Promise<void> {
  const defs = listChecks(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(defs, null, 2) + '\n');
    return;
  }
  const byPillar = new Map<string, CheckDef[]>();
  for (const d of defs) byPillar.set(d.pillar, [...(byPillar.get(d.pillar) ?? []), d]);
  for (const [pillar, list] of byPillar) {
    console.log('\n' + c.bold(`${pillarName(pillar)} (${list.length})`));
    console.log(
      table(
        list.map((d) => [
          sevLabel(d.severity),
          c.cyan(d.id),
          d.title,
          c.dim(d.fixTier + (d.requires?.length ? ` · needs ${d.requires.join(', ')}` : '')),
        ]),
        { maxWidth: [8, 44, 70, 30] },
      ),
    );
  }
  const cats = new Set(defs.map((d) => d.category)).size;
  console.log(c.dim(`\n${defs.length} checks in ${cats} categories. Filter with --pillar, --category or --search; --json for everything.`));
}
