import type { VisibilityRun } from '../../core/types.js';
import { confirm, interactive } from '../ask.js';
import { c, fmtScore, ok, progressPrinter, table } from '../output.js';
import { ExitError } from '../errors.js';
import { ensureAiKeys } from './keys.js';
import {
  brandFor,
  engines,
  estimateVisibilityCost,
  getConfig,
  monthSpend,
  pickEngines,
  promptSuggestions,
  quickContext,
  readPromptsFile,
  resolveSite,
  suggestPromptsFor,
  upsertUserSite,
  visibility,
} from '../services.js';

interface VisOpts {
  prompts?: string;
  engines?: string[];
  repeats?: number;
  mock?: boolean;
  yes?: boolean;
  json?: boolean;
}

export async function cmdVisibility(target: string, opts: VisOpts): Promise<void> {
  if (opts.mock) process.env.AVC_LLM_MOCK = '1';
  // Without a key there is nothing to ask: offer to add one, else say it was skipped and why.
  if (!(await ensureAiKeys('AI visibility'))) return;
  const config = getConfig(true);
  const site = resolveSite(target, config);
  const engineIds = pickEngines(opts.engines, config);
  if (!engineIds.length)
    throw new ExitError(
      1,
      'None of the chosen engines has a key. See `avc keys` for which engines are ready.',
    );
  const repeats = opts.repeats ?? 1;
  const progress = progressPrinter({ json: opts.json });

  const context = await quickContext(site, progress.onProgress);
  progress.end();
  const prompts = opts.prompts
    ? readPromptsFile(opts.prompts)
    : site.prompts?.length
      ? site.prompts
      : await suggestPromptsFor(brandFor(site, context), context, config);

  const est = estimateVisibilityCost(engineIds, prompts, repeats, config);
  const spent = monthSpend(config);
  if (!opts.json) {
    const labels = engines(config).filter((e) => engineIds.includes(e.engine));
    console.error(
      `${c.bold('AI visibility')} ${site.id}: ${prompts.length} prompts × ${labels.map((l) => l.label).join(', ')} × ${repeats} = ${est.answers} answers`,
    );
    console.error(
      est.mock
        ? c.dim('  Mock mode: sample answers, no spend.')
        : `  Estimated cost up to ${c.bold('$' + est.total.toFixed(2))} · cap $${config.ai.maxRunUsd} a run · $${spent.toFixed(2)} of $${config.ai.maxMonthUsd} spent this month`,
    );
  }
  if (!est.mock && !opts.yes) {
    if (!interactive())
      throw new ExitError(
        1,
        'This run uses your AI keys. Pass --yes to confirm (or --mock to test).',
      );
    if (!(await confirm('Run it?', true))) throw new ExitError(1, 'Cancelled.');
  }

  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  let run: VisibilityRun;
  try {
    run = await visibility(
      {
        site,
        prompts,
        engines: engineIds,
        repeats,
        context,
        onProgress: progress.onProgress,
        signal: ac.signal,
      },
      config,
    );
  } finally {
    progress.end();
    process.off('SIGINT', stop);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(run, null, 2) + '\n');
    return;
  }
  printRun(run);
}

export function printRun(run: VisibilityRun): void {
  const s = run.summary;
  console.log(
    `\n${c.bold(run.brand.name)} is named in ${fmtScore(s.mentionRate * 100)}% of ${run.answers.length} answers ${c.dim(`(cost ~$${s.costUsd.toFixed(2)})`)}`,
  );
  console.log(
    '\n' +
      table(
        Object.entries(s.byEngine).map(([e, v]) => [
          e,
          `${Math.round(v.mentionRate * 100)}% named`,
          v.avgPosition ? `avg position ${v.avgPosition.toFixed(1)}` : c.dim('no position'),
          `${v.citedOwnSite} cites your site`,
          `${v.answers} answers`,
        ]),
        { header: ['engine', 'mentions', 'position', 'citations', ''] },
      ),
  );
  if (s.shareOfVoice.length) {
    console.log('\n' + c.bold('Share of voice'));
    for (const v of s.shareOfVoice.slice(0, 8))
      console.log(
        `  ${(v.isBrand ? c.cyan(v.name) : v.name).padEnd(30)} ${Math.round(v.share * 100)}% ${c.dim(`(${v.mentions})`)}`,
      );
  }
  if (s.competitorWins.length) {
    console.log('\n' + c.bold('Prompts where a competitor is named and you are not'));
    for (const w of s.competitorWins.slice(0, 8))
      console.log(
        `  ${c.red('•')} ${w.prompt} ${c.dim(`→ ${w.winner} (${w.engines.join(', ')})`)}`,
      );
  }
  if (s.topCitedDomains.length)
    console.log(
      '\n' +
        c.bold('Most cited sources') +
        '\n  ' +
        s.topCitedDomains
          .slice(0, 8)
          .map((d) => `${d.domain} (${d.count})`)
          .join(', '),
    );
  if (s.factIssues)
    console.log(
      `\n${c.yellow(`${s.factIssues} possible factual errors about you.`)} See the dashboard or --json.`,
    );
  console.log(
    c.dim(
      '\nAnswers are API samples; consumer apps can differ. Repeat runs (--repeats) show how stable they are.',
    ),
  );
}

export async function cmdPromptsSuggest(
  target: string,
  opts: { save?: boolean; json?: boolean },
): Promise<void> {
  const config = getConfig();
  const site = resolveSite(target, config);
  const prompts = await promptSuggestions(site, config);
  if (opts.json) process.stdout.write(JSON.stringify(prompts, null, 2) + '\n');
  else {
    console.log(
      table(
        prompts.map((p) => [c.dim(p.kind.padEnd(10)), p.text, p.search ? '' : c.dim('no search')]),
      ),
    );
  }
  if (opts.save) {
    upsertUserSite({ ...site, prompts });
    ok(
      `Saved ${prompts.length} prompts for ${site.id}. Edit them in ~/.avc/config.json or the dashboard.`,
    );
  }
}
