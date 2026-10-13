import type { Hono } from 'hono';
import { AI_BOTS } from '../../agentic/bots.js';
import { parseLlmsTxt } from '../../agentic/llms.js';
import { buildRobots } from '../../crawl/robots.js';
import { explainGaps } from '../../ai/gaps.js';
import type { TrackedPrompt } from '../../core/types.js';
import {
  engines,
  estimateVisibilityCost,
  generate,
  getConfig,
  getStore,
  monthSpend,
  parsePrompts,
  pickEngines,
  promptSuggestions,
  upsertUserSite,
  visibility,
  errMsg,
  type GenerateKind,
  type RobotsChoice,
} from '../../cli/services.js';
import { arr, back, form, str, type Deps, type ServerEnv } from '../app.js';
import { Badge, CopyButton, Empty, fmtDate, Layout, pct, siteHref, Sparkline } from '../ui.js';
import { auditFor, findSite, NoAudit } from './site.js';

const GENERATORS: [GenerateKind, string][] = [
  ['llms-txt', 'llms.txt'],
  ['robots', 'robots.txt'],
  ['schema', 'Organization JSON-LD'],
  ['agent-card', 'A2A agent card'],
];

function promptsToText(prompts: TrackedPrompt[]): string {
  return prompts
    .map(
      (p) =>
        `${p.kind === 'custom' ? '' : `[${p.kind}] `}${p.search ? '' : '[no-search] '}${p.text}`,
    )
    .join('\n');
}

function textToPrompts(text: string): TrackedPrompt[] {
  return parsePrompts(text).map((p, i) => {
    let t = p.text;
    let kind: TrackedPrompt['kind'] = 'custom';
    let search = true;
    for (;;) {
      const m = t.match(/^\[(brand|category|comparison|problem|custom|no-search)\]\s*/i);
      if (!m) break;
      const tag = m[1].toLowerCase();
      if (tag === 'no-search') search = false;
      else kind = tag as TrackedPrompt['kind'];
      t = t.slice(m[0].length);
    }
    return { id: `p${i + 1}`, text: t, kind, search };
  });
}

export function registerAiPages(app: Hono<ServerEnv>, deps: Deps) {
  // ---------------------------------------------------------------- AI crawlers
  app.get('/s/:id/crawlers', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const result = auditFor(c, site.id);
    if (!result)
      return c.html(
        <Layout title="AI crawlers" siteId={site.id} siteUrl={site.url} active="crawlers">
          <NoAudit site={site} />
        </Layout>,
      );
    const robots = buildRobots(`${result.site}/robots.txt`, result.robots.body ?? '', {
      status: result.robots.status,
      found: result.robots.found,
    });
    const home = result.startUrl || result.site + '/';
    const fetches = new Map(result.botFetches.map((b) => [b.token.toLowerCase(), b]));
    const logs = result.external.logs;
    const logBots = new Map((logs?.bots ?? []).map((b) => [b.token.toLowerCase(), b]));
    const bots = AI_BOTS.filter(
      (b) => b.robotsToken !== false || fetches.has(b.token.toLowerCase()),
    );
    return c.html(
      <Layout title="AI crawlers" siteId={site.id} siteUrl={site.url} active="crawlers">
        <p class="muted">
          What robots.txt says for each AI crawler, which line decides it, and what the site
          actually served when fetched with that crawler's user agent.
          {result.robots.found
            ? ''
            : ' No robots.txt was found, so every crawler is allowed by default.'}
        </p>
        <div class="field" style="max-width:320px">
          <label for="bot-q">Find a bot</label>
          <input
            id="bot-q"
            type="search"
            data-filter="#bots"
            placeholder="GPTBot, Anthropic, search…"
          />
        </div>
        <div class="table-wrap">
          <table data-sortable id="bots">
            <thead>
              <tr>
                {[
                  'Bot',
                  'Operator',
                  'Purpose',
                  'robots.txt',
                  'Deciding line',
                  'Live fetch',
                  'Real visits (logs)',
                ].map((h) => (
                  <th scope="col">
                    <button class="sort" type="button">
                      {h}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bots.map((b) => {
                const allowed = b.robotsToken === false ? null : robots.isAllowed(home, b.token);
                const line = b.robotsToken === false ? null : robots.decidingLine(home, b.token);
                const f = fetches.get(b.token.toLowerCase());
                const l = logBots.get(b.token.toLowerCase());
                return (
                  <tr data-row>
                    <td>
                      <strong>{b.token}</strong>
                      <div>
                        <small>{b.role}</small>
                      </div>
                    </td>
                    <td>{b.operator}</td>
                    <td>
                      <Badge>{b.purpose}</Badge>
                    </td>
                    <td>
                      {allowed === null ? (
                        <small>not a robots.txt token</small>
                      ) : allowed ? (
                        <Badge cls="v-ok">allowed</Badge>
                      ) : (
                        <Badge cls="v-blocked">blocked</Badge>
                      )}
                      {b.honoursRobots === false ? (
                        <div>
                          <small>operator says robots.txt is not generally applied</small>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {line ? (
                        <code>{line.line ? `${line.line}: ${line.rule}` : line.rule}</code>
                      ) : (
                        <small>default</small>
                      )}
                    </td>
                    <td>
                      {f ? (
                        <>
                          <Badge cls={`v-${f.verdict}`}>{f.verdict}</Badge>{' '}
                          <small>
                            {f.status} · {f.words} words
                            {f.challenge ? ` · ${f.challenge} challenge` : ''}
                          </small>
                        </>
                      ) : (
                        <small>not tested</small>
                      )}
                    </td>
                    <td data-v={String(l?.hits ?? -1)}>
                      {l ? (
                        <>
                          {l.hits} hits{' '}
                          <small>
                            ({l.verified} verified{l.spoofed ? `, ${l.spoofed} spoofed` : ''})
                          </small>
                        </>
                      ) : logs ? (
                        <small>none</small>
                      ) : (
                        <small>
                          <a href={siteHref(site.id, 'connections')}>connect logs</a>
                        </small>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {logs ? (
          <div class="grid grid-2" style="margin-top:16px">
            <div class="card">
              <h3>Errors served to AI bots</h3>
              {logs.errorsServedToBots.length ? (
                <ul>
                  {logs.errorsServedToBots.slice(0, 20).map((e) => (
                    <li>
                      <code>{e.status}</code> {e.path}{' '}
                      <small>
                        {e.bot} ×{e.hits}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="muted">None in the log window.</p>
              )}
            </div>
            <div class="card">
              <h3>Key pages no AI bot fetched</h3>
              {logs.neverFetched.length ? (
                <ul class="urls">
                  {logs.neverFetched.slice(0, 30).map((u) => (
                    <li>{u}</li>
                  ))}
                </ul>
              ) : (
                <p class="muted">Every key page was fetched at least once.</p>
              )}
            </div>
          </div>
        ) : null}
        <h2>robots.txt</h2>
        <div class="row spread">
          <small>{result.robots.found ? `HTTP ${result.robots.status}` : 'not found'}</small>
          <a class="btn small" href={`${siteHref(site.id, 'agentic')}#gen-robots`}>
            Generate a new robots.txt
          </a>
        </div>
        <pre>{result.robots.body || '(empty)'}</pre>
      </Layout>,
    );
  });

  // ---------------------------------------------------------------- agentic web
  app.get('/s/:id/agentic', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const result = auditFor(c, site.id);
    if (!result)
      return c.html(
        <Layout title="Agentic web" siteId={site.id} siteUrl={site.url} active="agentic">
          <NoAudit site={site} />
        </Layout>,
      );
    const llmsProbe = result.probes.find((p) => p.id === 'llms-txt' || /\/llms\.txt$/i.test(p.url));
    const llms =
      llmsProbe?.found && llmsProbe.body ? parseLlmsTxt(llmsProbe.body, llmsProbe.url) : null;
    const llmsChecks = Object.values(result.checks).filter(
      (d) => d.category === 'llms-txt' && d.status === 'ran',
    );
    const llmsFailing = llmsChecks.filter((d) => d.affected > 0);
    const agentChecks = Object.values(result.checks).filter((d) => d.pillar === 'agentic');
    const policy = (c.req.query('policy') as RobotsChoice) || 'allow-search';
    return c.html(
      <Layout title="Agentic web" siteId={site.id} siteUrl={site.url} active="agentic">
        <p class="muted">
          What AI agents find when they look for machine-readable entry points on your origin.
        </p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Probe</th>
                <th>URL</th>
                <th>Result</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {result.probes.map((p) => (
                <tr>
                  <td>
                    <code>{p.id}</code>
                  </td>
                  <td class="url">{p.url}</td>
                  <td>
                    {p.found ? <Badge cls="v-ok">found</Badge> : <Badge>not found</Badge>}{' '}
                    <small>{p.status ?? p.error ?? ''}</small>
                  </td>
                  <td>
                    <small>{p.contentType ?? ''}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div class="grid grid-2" style="margin-top:16px">
          <div class="card">
            <h3>llms.txt</h3>
            {llms ? (
              <>
                <p>
                  {llmsChecks.length - llmsFailing.length} of {llmsChecks.length} llms.txt checks
                  pass.
                </p>
                <dl class="kv">
                  <dt>Title</dt>
                  <dd>{llms.title ?? 'missing'}</dd>
                  <dt>Summary</dt>
                  <dd>{llms.summary ?? 'missing'}</dd>
                  <dt>Sections</dt>
                  <dd>{llms.sections.map((s) => `${s.name} (${s.links})`).join(', ') || 'none'}</dd>
                  <dt>Links</dt>
                  <dd>
                    {llms.links.length}
                    {llms.relativeLinks ? ` (${llms.relativeLinks} relative)` : ''}
                  </dd>
                  <dt>Size</dt>
                  <dd>
                    {llms.lines} lines, {Math.round(llms.bytes / 1024)} KB
                  </dd>
                </dl>
              </>
            ) : (
              <p>No llms.txt found. Generate one below from the pages crawled.</p>
            )}
            {llmsFailing.length ? (
              <ul>
                {llmsFailing.map((d) => (
                  <li>
                    <a href={`${siteHref(site.id, 'issues')}?check=${encodeURIComponent(d.id)}`}>
                      {d.title}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div class="card">
            <h3>Agentic checks</h3>
            <ul style="padding-left:18px">
              {agentChecks.map((d) => (
                <li>
                  {d.status === 'skipped' ? (
                    <Badge>skipped</Badge>
                  ) : d.affected ? (
                    <Badge cls="v-blocked">fails</Badge>
                  ) : (
                    <Badge cls="v-ok">passes</Badge>
                  )}{' '}
                  {d.affected ? (
                    <a href={`${siteHref(site.id, 'issues')}?check=${encodeURIComponent(d.id)}`}>
                      {d.title}
                    </a>
                  ) : (
                    d.title
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <h2>Generators</h2>
        <p class="muted">Built from the latest audit. Review before publishing.</p>
        {GENERATORS.map(([kind, label]) => {
          let g: ReturnType<typeof generate> | null = null;
          let error = '';
          try {
            g = generate(kind, result, site, { policy });
          } catch (e) {
            error = errMsg(e);
          }
          return (
            <div class="card" id={`gen-${kind}`}>
              <div class="row spread">
                <h3 style="margin:0">{label}</h3>
                {g ? (
                  <div class="row">
                    <CopyButton target={`#pre-${kind}`} />
                    <a
                      class="btn small"
                      href={`${siteHref(site.id, 'generate')}/${kind}?policy=${policy}${c.req.query('audit') ? `&audit=${c.req.query('audit')}` : ''}`}
                    >
                      Download
                    </a>
                  </div>
                ) : null}
              </div>
              {kind === 'robots' ? (
                <form
                  method="get"
                  action={`${siteHref(site.id, 'agentic')}#gen-robots`}
                  class="row"
                  style="margin:10px 0"
                >
                  <label for="policy" style="margin:0">
                    Policy
                  </label>
                  <select id="policy" name="policy" style="width:auto">
                    {(
                      [
                        ['allow-search', 'Allow AI search, block training'],
                        ['allow-all', 'Allow all AI crawlers'],
                        ['block-all', 'Block all AI crawlers'],
                      ] as const
                    ).map(([v, l]) => (
                      <option value={v} selected={policy === v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <button class="btn small" type="submit">
                    Preview
                  </button>
                </form>
              ) : null}
              {g ? (
                <>
                  <p class="muted" style="margin:8px 0">
                    {g.where}
                  </p>
                  <pre id={`pre-${kind}`}>{g.body}</pre>
                </>
              ) : (
                <p class="notice error">{error}</p>
              )}
            </div>
          );
        })}
      </Layout>,
    );
  });

  app.get('/s/:id/generate/:kind', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const result = auditFor(c, site.id);
    const kind = c.req.param('kind') as GenerateKind;
    if (!result || !GENERATORS.some(([k]) => k === kind)) return c.notFound();
    const g = generate(kind, result, site, {
      policy: (c.req.query('policy') as RobotsChoice) || 'allow-search',
    });
    return c.body(g.body, 200, {
      'Content-Type': g.contentType,
      'Content-Disposition': `attachment; filename="${g.filename}"`,
    });
  });

  // ---------------------------------------------------------------- AI visibility
  app.get('/s/:id/visibility', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const config = getConfig();
    const store = getStore();
    const runId = c.req.query('run');
    const run = (runId ? store.getVisibility(runId) : null) ?? store.latestVisibility(site.id);
    const history = store.listVisibility(site.id, 30);
    const status = engines(config);
    const prompts = site.prompts ?? [];
    const promptText = c.req.query('suggested')
      ? decodeURIComponent(c.req.query('suggested')!)
      : promptsToText(prompts);
    const avail = status.filter((s) => s.available);
    const est = estimateVisibilityCost(
      avail.map((s) => s.engine),
      [{ search: true }],
      1,
      config,
    );
    const gaps = run ? safeGaps(run) : [];
    const running = deps.jobs.running(site.id);
    return c.html(
      <Layout
        title="AI visibility"
        siteId={site.id}
        siteUrl={site.url}
        active="visibility"
        flash={c.get('flash')}
      >
        <p class="muted">
          Asks ChatGPT, Claude, Gemini and Perplexity (through their APIs, with your keys) the
          questions your customers ask, then measures whether you are named, who is named instead,
          and which pages are cited. API answers can differ from the consumer apps.
        </p>
        {run ? (
          <>
            <div class="grid grid-4">
              <div class="card">
                <div class="eyebrow">Named in</div>
                <div class="stat">{pct(run.summary.mentionRate)}</div>
                <small>of {run.answers.length} answers</small>
              </div>
              <div class="card">
                <div class="eyebrow">Share of voice</div>
                <div class="stat">
                  {pct(run.summary.shareOfVoice.find((s) => s.isBrand)?.share ?? 0)}
                </div>
                <small>of brand mentions</small>
              </div>
              <div class="card">
                <div class="eyebrow">Trend</div>
                <Sparkline
                  values={[...history].reverse().map((h) => h.mentionRate * 100)}
                  label="Mention rate"
                />
                <div>
                  <small>{history.length} runs</small>
                </div>
              </div>
              <div class="card">
                <div class="eyebrow">Run</div>
                <div>{fmtDate(run.at)}</div>
                <small>
                  cost ~${run.summary.costUsd.toFixed(2)} · {run.summary.factIssues} possible
                  factual errors
                </small>
              </div>
            </div>

            <div class="grid grid-2" style="margin-top:16px">
              <div class="card">
                <h3>By engine</h3>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Engine</th>
                        <th class="num">Named</th>
                        <th class="num">Avg position</th>
                        <th class="num">Cites you</th>
                        <th class="num">Answers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(run.summary.byEngine).map(([e, v]) => (
                        <tr>
                          <td>{e}</td>
                          <td class="num">{pct(v.mentionRate)}</td>
                          <td class="num">{v.avgPosition ? v.avgPosition.toFixed(1) : '-'}</td>
                          <td class="num">{v.citedOwnSite}</td>
                          <td class="num">{v.answers}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div class="card">
                <h3>Share of voice</h3>
                {run.summary.shareOfVoice.slice(0, 10).map((s) => (
                  <div class="pillar">
                    <span>{s.isBrand ? <strong>{s.name}</strong> : s.name}</span>
                    <div class={`bar ${s.isBrand ? '' : 'mid'}`}>
                      <span style={`width:${(s.share * 100).toFixed(1)}%`}></span>
                    </div>
                    <span class="num">{pct(s.share)}</span>
                  </div>
                ))}
              </div>
            </div>

            <h2>Where competitors win</h2>
            {run.summary.competitorWins.length ? (
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Prompt</th>
                      <th>Named instead</th>
                      <th>Engines</th>
                      <th>Sources they used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.summary.competitorWins.map((w) => (
                      <tr>
                        <td>{w.prompt}</td>
                        <td>{w.winner}</td>
                        <td>{w.engines.join(', ')}</td>
                        <td>
                          <small>{w.sources.slice(0, 5).join(', ')}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p class="muted">No prompt where a competitor was named and you were not.</p>
            )}

            {gaps.length ? (
              <>
                <h2>Why not you</h2>
                {gaps.slice(0, 12).map((g) => {
                  const prompt = run.prompts.find((p) => p.id === g.promptId)?.text ?? g.promptId;
                  return (
                    <details class="issue">
                      <summary>
                        <Badge>{g.engine}</Badge>
                        <span class="issue-title">{prompt}</span>
                      </summary>
                      <div class="body">
                        <ul>
                          {g.whyNotYou.map((w) => (
                            <li>{w}</li>
                          ))}
                        </ul>
                        {g.pagesToCreateOrImprove.length ? (
                          <>
                            <h4>Pages to create or improve</h4>
                            <ul>
                              {g.pagesToCreateOrImprove.map((p) => (
                                <li>
                                  {p.url ? <code>{p.url}</code> : null} {p.suggestion}
                                </li>
                              ))}
                            </ul>
                          </>
                        ) : null}
                      </div>
                    </details>
                  );
                })}
              </>
            ) : null}

            <div class="grid grid-2" style="margin-top:16px">
              <div class="card">
                <h3>Your pages cited</h3>
                {run.summary.ownPagesCited.length ? (
                  <ul class="urls">
                    {run.summary.ownPagesCited.map((p) => (
                      <li>
                        {p.url} <small>×{p.count}</small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p class="muted">None of your pages were cited.</p>
                )}
              </div>
              <div class="card">
                <h3>Most cited sources</h3>
                <ul>
                  {run.summary.topCitedDomains.slice(0, 15).map((d) => (
                    <li>
                      {d.domain} <small>×{d.count}</small>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <h2>Answers</h2>
            <div class="field" style="max-width:320px">
              <label for="ans-q">Find in answers</label>
              <input id="ans-q" type="search" data-filter="#answers" />
            </div>
            <div id="answers">
              {run.answers.slice(0, 200).map((a) => (
                <details class="issue" data-row>
                  <summary>
                    <Badge>{a.engine}</Badge>
                    {a.error ? (
                      <Badge cls="v-error">error</Badge>
                    ) : a.mentioned ? (
                      <Badge cls="v-ok">named{a.position ? ` #${a.position}` : ''}</Badge>
                    ) : (
                      <Badge cls="v-blocked">not named</Badge>
                    )}
                    <span class="issue-title">{a.prompt}</span>
                    {a.sentiment ? <small>{a.sentiment}</small> : null}
                  </summary>
                  <div class="body">
                    {a.error ? <p class="notice error">{a.error}</p> : null}
                    <pre>{a.answer}</pre>
                    {a.brandsNamed.length ? <p>Brands named: {a.brandsNamed.join(', ')}</p> : null}
                    {a.citations.length ? (
                      <ul class="urls">
                        {a.citations.map((ci) => (
                          <li>
                            {ci.ownSite ? (
                              <Badge cls="v-ok">yours</Badge>
                            ) : ci.competitor ? (
                              <Badge cls="v-differs">{ci.competitor}</Badge>
                            ) : null}{' '}
                            {ci.url}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {a.factIssues.length ? (
                      <>
                        <h4>Possible factual errors</h4>
                        <ul>
                          {a.factIssues.map((f) => (
                            <li>
                              <Badge cls="v-differs">{f.verdict}</Badge> {f.claim}
                              {f.siteSays ? <small> Site says: {f.siteSays}</small> : null}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    <small>
                      {a.model} · {a.ms} ms · ${a.costUsd.toFixed(4)}
                    </small>
                  </div>
                </details>
              ))}
            </div>
          </>
        ) : (
          <Empty>No AI visibility run yet. Set your prompts and engines below, then run it.</Empty>
        )}

        <h2>Run a check</h2>
        <form method="post" action={siteHref(site.id, 'visibility')} class="card">
          <div class="field">
            <label for="prompts">
              Prompts, one per line. Optional tags: [category] [comparison] [problem] [brand]
              [no-search]
            </label>
            <textarea id="prompts" name="prompts" style="min-height:180px">
              {promptText}
            </textarea>
            <div class="hint">
              Leave empty to use suggested prompts. Saved to this site when you run or save.
            </div>
          </div>
          <div class="row" style="margin-bottom:12px">
            <button
              class="btn small"
              type="submit"
              formaction={siteHref(site.id, 'prompts/suggest')}
            >
              Suggest prompts
            </button>
            <button class="btn small" type="submit" formaction={siteHref(site.id, 'prompts')}>
              Save prompts
            </button>
          </div>
          <fieldset>
            <legend>Engines</legend>
            {status.map((s) => (
              <label class="check" title={s.note ?? ''}>
                <input
                  type="checkbox"
                  name="engines"
                  value={s.engine}
                  checked={s.available && s.default}
                  disabled={!s.available}
                />{' '}
                {s.label}
                <small>{s.available ? ` (${s.via})` : ' (no key)'}</small>
              </label>
            ))}
          </fieldset>
          <div class="row">
            <div class="field" style="width:140px">
              <label for="repeats">Repeats</label>
              <input id="repeats" name="repeats" type="number" min="1" max="10" value="1" />
            </div>
            <p style="margin:0">
              <strong data-estimate={JSON.stringify(est.perAnswer)} aria-live="polite">
                {est.mock ? 'Mock mode: no spend.' : 'Pick engines to see an estimate.'}
              </strong>
              <br />
              <small>
                Upper-bound estimate from list prices. Spent this month: $
                {monthSpend(config).toFixed(2)} of ${config.ai.maxMonthUsd}. A run stops at $
                {config.ai.maxRunUsd}.
              </small>
            </p>
          </div>
          <label class="check">
            <input type="checkbox" name="confirm" required /> I understand this uses my AI keys and
            may cost money
          </label>
          <div>
            <button class="btn primary" type="submit" disabled={Boolean(running)}>
              {running ? 'Another job is running' : 'Run AI visibility check'}
            </button>
          </div>
        </form>
        {history.length ? (
          <>
            <h2>Past runs</h2>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th class="num">Named</th>
                    <th class="num">Share of voice</th>
                    <th class="num">Answers</th>
                    <th class="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr>
                      <td>
                        <a href={`${siteHref(site.id, 'visibility')}?run=${h.id}`}>
                          {fmtDate(h.at)}
                        </a>
                      </td>
                      <td class="num">{pct(h.mentionRate)}</td>
                      <td class="num">{pct(h.shareOfVoice)}</td>
                      <td class="num">{h.answers}</td>
                      <td class="num">${h.costUsd.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </Layout>,
    );
  });

  app.post('/s/:id/prompts', async (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const f = await form(c);
    const prompts = textToPrompts(str(f.prompts));
    upsertUserSite({ ...site, prompts });
    return back(c, siteHref(site.id, 'visibility'), `Saved ${prompts.length} prompts.`);
  });

  app.post('/s/:id/prompts/suggest', async (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    try {
      const prompts = await promptSuggestions(site, getConfig());
      return c.redirect(
        `${siteHref(site.id, 'visibility')}?suggested=${encodeURIComponent(promptsToText(prompts))}&msg=${encodeURIComponent('Suggested prompts loaded. Edit, then save or run.')}&kind=info`,
        303,
      );
    } catch (e) {
      return back(
        c,
        siteHref(site.id, 'visibility'),
        `Could not suggest prompts: ${errMsg(e)}`,
        'error',
      );
    }
  });

  app.post('/s/:id/visibility', async (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const f = await form(c);
    if (str(f.confirm) !== 'on')
      return back(c, siteHref(site.id, 'visibility'), 'Tick the box to confirm the run.', 'warn');
    if (deps.jobs.running(site.id))
      return back(
        c,
        siteHref(site.id, 'visibility'),
        'Another job is running for this site.',
        'warn',
      );
    let engineIds;
    try {
      engineIds = pickEngines(arr(f.engines));
    } catch (e) {
      return back(c, siteHref(site.id, 'visibility'), errMsg(e), 'error');
    }
    const prompts = textToPrompts(str(f.prompts));
    const updated = prompts.length ? { ...site, prompts } : site;
    if (prompts.length) upsertUserSite(updated);
    const repeats = Math.min(10, Math.max(1, Number(str(f.repeats)) || 1));
    const job = deps.jobs.start(
      'visibility',
      site.id,
      `AI visibility for ${site.id}`,
      async (onProgress, signal) => {
        const run = await visibility({
          site: updated,
          engines: engineIds,
          repeats,
          onProgress,
          signal,
        });
        return `${siteHref(site.id, 'visibility')}?run=${run.id}&msg=${encodeURIComponent(`Done: named in ${Math.round(run.summary.mentionRate * 100)}% of answers.`)}&kind=ok`;
      },
    );
    return c.redirect(`/jobs/${job.id}`, 303);
  });
}

function safeGaps(run: Parameters<typeof explainGaps>[0]) {
  try {
    return explainGaps(run);
  } catch {
    return [];
  }
}
