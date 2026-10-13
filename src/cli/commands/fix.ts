import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AuditResult } from '../../core/types.js';
import { confirm, interactive } from '../ask.js';
import { c, ok, sevLabel, warn } from '../output.js';
import { ExitError } from '../errors.js';
import {
  applyFixesFor,
  findAudit,
  getConfig,
  planFixes,
  resolveSite,
  rollbackSnapshot,
  type ApplyReport,
  type FixTarget,
} from '../services.js';

interface FixOpts {
  target?: FixTarget;
  repo?: string;
  only?: string[];
  dryRun?: boolean;
  apply?: boolean;
  yes?: boolean;
  json?: boolean;
  rollback?: string;
  wpHelper?: boolean;
}

export async function cmdFix(ref: string | undefined, opts: FixOpts): Promise<void> {
  if (opts.rollback) return cmdRollback(opts.rollback, { yes: opts.yes });
  if (opts.wpHelper) {
    const { WP_HELPER_PHP, WP_HELPER_INSTALL, WP_HELPER_FILENAME } =
      await import('../../fixes/apply/wp-helper.js');
    if (!process.stdout.isTTY) {
      process.stdout.write(WP_HELPER_PHP);
      return;
    }
    console.log(WP_HELPER_INSTALL.map((s, i) => `${i + 1}. ${s}`).join('\n'));
    console.log(c.dim(`\n--- wp-content/mu-plugins/${WP_HELPER_FILENAME} ---\n`));
    console.log(WP_HELPER_PHP);
    return;
  }
  const config = getConfig();
  const result = findAudit(ref, config);
  if (!result)
    throw new ExitError(
      1,
      `No audit found${ref ? ` for "${ref}"` : ''}. Run \`avc audit <url>\` first.`,
    );
  const site = resolveSite(result.startUrl || result.site, config);
  const fixes = planFixes(result, opts.only);

  if (!opts.target) {
    if (opts.json) {
      process.stdout.write(JSON.stringify(fixes, null, 2) + '\n');
      return;
    }
    printPlan(result, fixes);
    return;
  }

  const target = opts.target;
  if (target === 'repo') {
    const path = opts.repo ?? site.connections?.repoPath;
    if (!path)
      throw new ExitError(
        1,
        'Pass --repo <path> or set connections.repoPath (`avc connect repo`).',
      );
    if (!existsSync(path)) throw new ExitError(1, `Repo path not found: ${path}`);
    site.connections = { ...site.connections, repoPath: resolve(path) };
  } else if (!site.connections?.wordpress) {
    throw new ExitError(1, 'No WordPress connection. Run `avc connect wordpress` first.');
  }

  // Always preview first.
  const preview = await applyFixesFor({
    result,
    site,
    target,
    dryRun: true,
    only: opts.only,
    config,
  });
  if (opts.json && !opts.apply) {
    process.stdout.write(JSON.stringify(preview, null, 2) + '\n');
    return;
  }
  printApply(preview, true);
  if (!opts.apply) {
    console.log(c.dim('\nNothing changed. Add --apply to make these changes.'));
    return;
  }
  if (!preview.changes?.length) return;
  if (!opts.yes) {
    if (!interactive()) throw new ExitError(1, 'Pass --yes to apply without a prompt.');
    const where =
      target === 'wordpress' ? site.connections?.wordpress?.url : site.connections?.repoPath;
    if (!(await confirm(`Apply ${preview.changes.length} change(s) to ${where}?`, false)))
      throw new ExitError(1, 'Cancelled.');
  }
  const done = await applyFixesFor({
    result,
    site,
    target,
    dryRun: false,
    only: opts.only,
    config,
  });
  if (opts.json) {
    process.stdout.write(JSON.stringify(done, null, 2) + '\n');
    return;
  }
  printApply(done, false);
}

function printPlan(result: AuditResult, fixes: ReturnType<typeof planFixes>): void {
  console.log(
    `${c.bold(`${fixes.length} fixes`)} for ${result.site} ${c.dim(`(stack: ${result.stack.id}, audit ${result.id})`)}\n`,
  );
  const order = new Map(result.priorities.map((p, i) => [p.checkId, i]));
  const sorted = [...fixes].sort(
    (a, b) => (order.get(a.checkId) ?? 999) - (order.get(b.checkId) ?? 999),
  );
  for (const f of sorted.slice(0, 30)) {
    const def = result.checks[f.checkId];
    console.log(
      `${sevLabel(def?.severity ?? 'info')} ${c.bold(f.title)} ${c.dim(`${f.checkId} · ${f.autoApplicable ? 'auto-apply' : f.tier} · ${f.effort} · ${f.impact} impact`)}`,
    );
    for (const s of f.steps.slice(0, 4)) console.log(`    ${c.dim('-')} ${s}`);
    if (f.files.length) console.log(`    ${c.dim('files:')} ${f.files.join(', ')}`);
  }
  if (sorted.length > 30)
    console.log(
      c.dim(`\n…and ${sorted.length - 30} more (--json for all, with snippets and agent prompts).`),
    );
  const auto = fixes.filter((f) => f.autoApplicable).length;
  if (auto)
    console.log(
      `\n${auto} can be applied automatically: ${c.cyan('avc fix --target wordpress')} or ${c.cyan('avc fix --target repo --repo <path>')}`,
    );
}

export function printApply(r: ApplyReport, preview: boolean): void {
  const changes = r.changes ?? [];
  console.log(
    c.bold(
      preview ? `\nPreview: ${changes.length} change(s)` : `\nApplied ${changes.length} change(s)`,
    ),
  );
  for (const ch of changes) {
    const label = ch.title ?? ch.description ?? ch.checkId ?? 'change';
    const where = ch.file ?? ch.url ?? '';
    const status = ch.error
      ? c.red(` failed: ${ch.error}`)
      : ch.status
        ? c.dim(` ${ch.status}`)
        : '';
    console.log(
      `  ${preview ? c.cyan('~') : c.green('✓')} ${label}${where ? c.dim(' ' + where) : ''}${status}`,
    );
    if (ch.diff) console.log(colourDiff(ch.diff));
    else if (ch.before !== undefined || ch.after !== undefined)
      console.log(
        `      ${c.red('- ' + JSON.stringify(ch.before))}\n      ${c.green('+ ' + JSON.stringify(ch.after))}`,
      );
  }
  for (const s of r.skipped ?? [])
    console.log(c.dim(`  - skipped ${s.checkId ?? ''}: ${s.reason ?? ''}`));
  for (const e of r.errors ?? []) warn(e);
  for (const n of r.notes ?? []) console.log(c.dim(`  note: ${n}`));
  const snap = r.snapshotFile ?? r.snapshot;
  if (!preview && snap) ok(`Rollback snapshot: ${snap}\n  Undo with: avc rollback "${snap}"`);
  if (preview && r.patch && r.target === 'repo')
    console.log(
      c.dim('\nThe whole patch is in --json (field "patch"); it applies with `git apply`.'),
    );
}

function colourDiff(d: string): string {
  return d
    .split('\n')
    .slice(0, 80)
    .map(
      (l) => '      ' + (l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : c.dim(l)),
    )
    .join('\n');
}

export async function cmdRollback(file: string, opts: { yes?: boolean }): Promise<void> {
  if (!existsSync(file)) throw new ExitError(1, `Snapshot not found: ${file}`);
  if (!opts.yes && interactive() && !(await confirm(`Restore the values saved in ${file}?`, false)))
    throw new ExitError(1, 'Cancelled.');
  const out = await rollbackSnapshot(file);
  ok('Rolled back.');
  if (out && typeof out === 'object') console.log(c.dim(JSON.stringify(out, null, 2)));
}
