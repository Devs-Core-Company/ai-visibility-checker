/**
 * Site structure and snippet tools: the internal link graph and depth tree, search
 * snippet previews (pixel widths, AI context) and questions about the audit.
 */
import type { Hono } from 'hono';
import type { AuditResult, PageSummary } from '../../core/types.js';
import { getConfig, errMsg } from '../../cli/services.js';
import { serpRow, serpSummary, TITLE_LIMIT_PX, DESCRIPTION_LIMIT_PX } from '../../report/serp.js';
import { form, str, type Deps, type ServerEnv } from '../app.js';
import { Badge, Empty, Layout } from '../ui.js';
import { auditFor, findSite, NoAudit } from './site.js';

/** Graph data for the canvas: nodes (url, depth, status, inlinks, issues) and edges. */
export function graphData(result: AuditResult, max = 1500) {
  const html = result.pages
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.status > 0)
    .sort((a, b) => b.p.inlinks - a.p.inlinks)
    .slice(0, max);
  const keep = new Map(html.map(({ i }, n) => [i, n]));
  const edges = (result.linkGraph?.edges ?? [])
    .filter(([a, b]) => keep.has(a) && keep.has(b))
    .map(([a, b]) => [keep.get(a)!, keep.get(b)!]);
  return {
    nodes: html.map(({ p }) => ({
      url: p.url,
      depth: p.depth,
      status: p.status,
      inlinks: p.inlinks,
      issues: p.issues,
      indexable: p.indexable,
    })),
    edges,
    truncated: Boolean(result.linkGraph?.truncated) || result.pages.length > max,
    hasEdges: Boolean(result.linkGraph),
  };
}

interface TreeNode {
  name: string;
  path: string;
  page?: PageSummary;
  children: Map<string, TreeNode>;
  count: number;
}

/** URL folder tree (path segments), with page counts per branch. */
export function urlTree(pages: PageSummary[]): TreeNode {
  const root: TreeNode = { name: '/', path: '/', children: new Map(), count: 0 };
  for (const p of pages) {
    if (p.status === 0) continue;
    let u: URL;
    try {
      u = new URL(p.url);
    } catch {
      continue;
    }
    const segs = u.pathname.split('/').filter(Boolean);
    let node = root;
    node.count++;
    let path = '';
    for (const s of segs) {
      path += `/${s}`;
      let next = node.children.get(s);
      if (!next) node.children.set(s, (next = { name: s, path, children: new Map(), count: 0 }));
      next.count++;
      node = next;
    }
    if (!segs.length) root.page = p;
    else node.page = p;
  }
  return root;
}

function Tree({ node, siteId, level }: { node: TreeNode; siteId: string; level: number }) {
  const kids = [...node.children.values()].sort((a, b) => b.count - a.count).slice(0, 200);
  const label = (
    <>
      <code>{node.name}</code>{' '}
      <span class="muted small">
        {node.count} page{node.count === 1 ? '' : 's'}
        {node.page ? ` · depth ${node.page.depth} · ${node.page.status}` : ''}
      </span>
      {node.page && node.page.issues ? (
        <Badge cls="v-differs">{`${node.page.issues} issues`}</Badge>
      ) : null}
    </>
  );
  if (!kids.length)
    return (
      <li>
        {node.page ? (
          <a
            href={`/s/${encodeURIComponent(siteId)}/page?url=${encodeURIComponent(node.page.url)}`}
          >
            {label}
          </a>
        ) : (
          label
        )}
      </li>
    );
  return (
    <li>
      <details open={level < 1}>
        <summary>{label}</summary>
        <ul class="tree">
          {kids.map((k) => (
            <Tree node={k} siteId={siteId} level={level + 1} />
          ))}
        </ul>
      </details>
    </li>
  );
}

export function registerExplorePages(app: Hono<ServerEnv>, _deps: Deps) {
  // ------------------------------------------------------------ site graph
  app.get('/s/:id/graph', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const result = auditFor(c, site.id);
    if (!result)
      return c.html(
        <Layout title="Site graph" siteId={site.id} siteUrl={site.url} active="graph">
          <NoAudit site={site} />
        </Layout>,
      );
    const byDepth = new Map<number, number>();
    for (const p of result.pages)
      if (p.status > 0) byDepth.set(p.depth, (byDepth.get(p.depth) ?? 0) + 1);
    const depths = [...byDepth.entries()].sort(
      (a, b) => (a[0] < 0 ? 1e6 : a[0]) - (b[0] < 0 ? 1e6 : b[0]),
    );
    const maxN = Math.max(1, ...depths.map(([, n]) => n));
    const auditQ = c.req.query('audit')
      ? `?audit=${encodeURIComponent(c.req.query('audit')!)}`
      : '';
    return c.html(
      <Layout title="Site graph" siteId={site.id} siteUrl={site.url} active="graph">
        <div class="card">
          <h2>Internal link graph</h2>
          <p class="muted">
            Each dot is a page; lines are internal links. Bigger dots have more internal links
            pointing at them. Colour shows click depth (blue is close to the home page, orange is
            deep, red is an error). Drag to move, scroll to zoom, click a page to open it.
          </p>
          <canvas
            id="site-graph"
            width="1100"
            height="640"
            data-src={`/s/${encodeURIComponent(site.id)}/graph.json${auditQ}`}
            data-page={`/s/${encodeURIComponent(site.id)}/page?url=`}
            style="width:100%;height:auto;background:var(--surface,#101013);border-radius:10px;touch-action:none"
            role="img"
            aria-label="Internal link graph of the site"
          ></canvas>
          <p class="muted small" id="site-graph-status">
            Loading…
          </p>
        </div>
        <div class="card">
          <h2>Pages by click depth</h2>
          <table class="table">
            <thead>
              <tr>
                <th>Depth</th>
                <th>Pages</th>
                <th style="width:60%"></th>
              </tr>
            </thead>
            <tbody>
              {depths.map(([d, n]) => (
                <tr>
                  <td>{d < 0 ? 'Not linked (sitemap only)' : d}</td>
                  <td>{n}</td>
                  <td>
                    <div
                      class="bar"
                      style={`width:${Math.max(2, (n / maxN) * 100)}%;height:10px;background:${d < 0 ? '#f0616d' : d > 4 ? '#f2c14e' : '#0092d3'};border-radius:4px`}
                    ></div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="card">
          <h2>URL tree</h2>
          <ul class="tree">
            <Tree node={urlTree(result.pages)} siteId={site.id} level={0} />
          </ul>
        </div>
        <script src="/assets/graph.js" defer></script>
      </Layout>,
    );
  });

  app.get('/s/:id/graph.json', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const result = auditFor(c, site.id);
    if (!result) return c.json({ nodes: [], edges: [], truncated: false, hasEdges: false });
    return c.json(graphData(result));
  });

  // ------------------------------------------------------------ snippets
  app.get('/s/:id/serp', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const result = auditFor(c, site.id);
    if (!result)
      return c.html(
        <Layout title="Search snippets" siteId={site.id} siteUrl={site.url} active="serp">
          <NoAudit site={site} />
        </Layout>,
      );
    const rows = result.pages
      .filter((p) => p.status === 200 && p.indexable)
      .map((p) => serpRow(p.url, p.title, p.metaDescription));
    const all = c.req.query('all') === '1';
    const shown = (
      all
        ? rows
        : rows.filter(
            (r) =>
              !r.title ||
              !r.description ||
              r.titleTruncated ||
              r.descriptionTruncated ||
              r.descriptionThinForAi,
          )
    ).slice(0, 300);
    const s = serpSummary(rows);
    return c.html(
      <Layout title="Search snippets" siteId={site.id} siteUrl={site.url} active="serp">
        <div class="card">
          <p>
            {s.pages} indexable pages · <b>{s.titleTruncated}</b> titles wider than {TITLE_LIMIT_PX}
            px · <b>{s.descriptionTruncated}</b> descriptions wider than {DESCRIPTION_LIMIT_PX}px ·{' '}
            <b>{s.descriptionThinForAi}</b> descriptions too thin to give AI context (under 120
            characters).
          </p>
          <p class="muted small">
            Widths are measured in Arial like Google's desktop results; they are close estimates.{' '}
            {all ? <a href="?">Show problems only</a> : <a href="?all=1">Show every page</a>}. Draft
            better ones with <code>avc serp {site.id} --write</code>.
          </p>
        </div>
        {shown.length ? (
          shown.map((r) => (
            <div class="card serp">
              <div class="muted small">{r.url}</div>
              <div style="font-size:20px;color:#8ab4f8;line-height:1.3">
                {r.shownTitle || '(no title)'}
              </div>
              <div style="font-size:14px;color:#bdc1c6">
                {r.shownDescription || '(no description)'}
              </div>
              <div class="row small" style="margin-top:6px">
                <Badge
                  cls={r.titleTruncated || !r.title ? 'v-blocked' : 'v-ok'}
                >{`title ${r.titlePx}px`}</Badge>
                <Badge
                  cls={r.descriptionTruncated || !r.description ? 'v-blocked' : 'v-ok'}
                >{`description ${r.descriptionPx}px`}</Badge>
                {r.descriptionThinForAi ? <Badge cls="v-differs">thin for AI</Badge> : null}
              </div>
            </div>
          ))
        ) : (
          <Empty>
            <p>No snippet problems found.</p>
          </Empty>
        )}
      </Layout>,
    );
  });

  // ------------------------------------------------------------ resources
  app.get('/s/:id/resources', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const result = auditFor(c, site.id);
    if (!result)
      return c.html(
        <Layout title="Resources" siteId={site.id} siteUrl={site.url} active="resources">
          <NoAudit site={site} />
        </Layout>,
      );
    const type = c.req.query('type') ?? '';
    const party = c.req.query('party') ?? '';
    const rows = (result.resources ?? []).filter(
      (r) =>
        (!type || r.type === type) &&
        (!party || (party === 'third' ? r.thirdParty : !r.thirdParty)),
    );
    const kb = (n?: number) => (n === undefined ? '' : `${Math.round(n / 1024)} KB`);
    return c.html(
      <Layout title="Resources" siteId={site.id} siteUrl={site.url} active="resources">
        {!result.resources ? (
          <Empty>
            <p>Resource inventories are stored from this version on. Run the audit again.</p>
          </Empty>
        ) : (
          <>
            <form method="get" class="filters">
              <div class="field">
                <label for="r-type">Type</label>
                <select id="r-type" name="type">
                  <option value="">All</option>
                  {['script', 'stylesheet', 'image'].map((t) => (
                    <option value={t} selected={type === t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div class="field">
                <label for="r-party">Host</label>
                <select id="r-party" name="party">
                  <option value="">All</option>
                  <option value="first" selected={party === 'first'}>
                    This site
                  </option>
                  <option value="third" selected={party === 'third'}>
                    Third party
                  </option>
                </select>
              </div>
              <button class="btn" type="submit">
                Filter
              </button>
              <div class="field" style="flex:1 1 220px">
                <label for="r-q">Find in table</label>
                <input id="r-q" type="search" data-filter="#res-table" placeholder="URL" />
              </div>
            </form>
            <div class="card">
              <table class="table" id="res-table">
                <thead>
                  <tr>
                    <th>Resource</th>
                    <th>Type</th>
                    <th>Pages</th>
                    <th>Size</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 1000).map((r) => (
                    <tr>
                      <td style="word-break:break-all">
                        {r.url} {r.thirdParty ? <Badge>third party</Badge> : null}
                      </td>
                      <td>{r.type}</td>
                      <td>{r.pages}</td>
                      <td>{kb(r.bytes)}</td>
                      <td>{r.status ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p class="muted small">
                {rows.length} resources. Sizes and statuses are known for images (HEAD requests
                during the crawl).
              </p>
            </div>
          </>
        )}
      </Layout>,
    );
  });

  // ------------------------------------------------------------ screenshots
  app.get('/s/:id/screenshot', async (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const url = c.req.query('url') ?? site.url;
    // Only pages of this site: the dashboard must not become a browser for arbitrary URLs.
    try {
      if (new URL(url).host.replace(/^www\./, '') !== new URL(site.url).host.replace(/^www\./, ''))
        return c.text('Only pages of this site can be captured.', 400);
    } catch {
      return c.text('Bad URL.', 400);
    }
    const { captureScreenshot } = await import('../../crawl/render.js');
    const r = await captureScreenshot(url, {
      device: c.req.query('device') === 'mobile' ? 'mobile' : 'desktop',
    });
    if (!r.ok) return c.text(r.error, 500);
    return c.body(new Uint8Array(r.png), 200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
    });
  });

  // ------------------------------------------------------------ ask
  const askPage = (
    siteId: string,
    siteUrl: string,
    q: string,
    answer: { text: string; source: string } | null,
    error?: string,
  ) => (
    <Layout title="Ask about this audit" siteId={siteId} siteUrl={siteUrl} active="ask">
      <form method="post" class="card">
        <label for="ask-q">Your question</label>
        <textarea
          id="ask-q"
          name="q"
          rows={3}
          style="width:100%"
          placeholder="What should I fix first? Why is AI access low?"
        >
          {q}
        </textarea>
        <div class="row" style="margin-top:8px">
          <button class="btn primary" type="submit">
            Ask
          </button>
          <span class="muted small">
            Uses your writer model (own key or AI Gateway). Without one, answers from the ranked
            priorities.
          </span>
        </div>
      </form>
      {error ? <div class="notice error">{error}</div> : null}
      {answer ? (
        <div class="card">
          <h2>Answer</h2>
          <div style="white-space:pre-wrap">{answer.text}</div>
          <p class="muted small">
            {answer.source === 'model'
              ? 'Written by your AI model from the audit.'
              : 'From the audit’s ranked priorities.'}
          </p>
        </div>
      ) : null}
    </Layout>
  );

  app.get('/s/:id/ask', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    return c.html(askPage(site.id, site.url, '', null));
  });

  app.post('/s/:id/ask', async (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const q = str((await form(c)).q).slice(0, 2000);
    const result = auditFor(c, site.id);
    if (!result) return c.html(askPage(site.id, site.url, q, null, 'Run an audit first.'));
    if (!q) return c.html(askPage(site.id, site.url, q, null, 'Type a question.'));
    try {
      const { askAboutAudit } = await import('../../ai/ask.js');
      const r = await askAboutAudit(result, q, getConfig());
      return c.html(askPage(site.id, site.url, q, { text: r.answer, source: r.source }));
    } catch (e) {
      return c.html(askPage(site.id, site.url, q, null, errMsg(e)));
    }
  });
}
