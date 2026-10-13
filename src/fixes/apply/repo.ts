/**
 * Local repository patches. Detects the stack from the files, plans repo-applicable fixes
 * as a reviewable unified diff, and writes files only on apply, after saving a backup under
 * `<dataDir>/rollback/`. Never runs git; for git repos it suggests a branch name.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { parseHTML } from 'linkedom';
import type { AuditResult, StackId } from '../../core/types.js';
import {
  addSitemapLines,
  generateLlmsTxt,
  generateRobotsTxt,
  generateSiteGraphJsonLd,
  inferBrandName,
  suggestMetaRules,
  type RobotsPolicy,
} from '../generate.js';
import { defaultPolicy, nextRobotsTs } from '../recipes/ai-access.js';
import { findRecipe } from '../recipes/index.js';
import { headersForCheck } from '../recipes/technical.js';
import { headerConfig } from '../stacks.js';
import type { BrandFacts, NextRouter } from '../types.js';
import { unifiedDiff } from './diff.js';
import { readJson, sha1, snapshotPath, writeJson } from './snapshot.js';

export interface RepoInfo {
  path: string;
  stack: StackId;
  router: NextRouter;
  /** Folder served at the site root, relative to the repo ('' = repo root). */
  publicDir: string;
  /** Next.js app directory ('app' or 'src/app'). */
  appDir: string | null;
  host: 'vercel' | 'netlify' | 'cloudflare' | null;
  isGit: boolean;
  signals: string[];
}

export interface RepoChange {
  path: string; // relative, posix
  action: 'create' | 'modify';
  before: string | null;
  after: string;
  diff: string;
  checkIds: string[];
  description: string[];
}

export interface RepoPlan {
  target: 'repo';
  site: string;
  repoPath: string;
  createdAt: string;
  info: RepoInfo;
  changes: RepoChange[];
  skipped: { checkId: string; reason: string }[];
  /** All changes as one patch (git apply compatible). */
  diff: string;
  branchSuggestion?: string;
  notes: string[];
}

export interface RepoFileResult {
  path: string;
  status: 'written' | 'skipped' | 'planned' | 'restored' | 'deleted' | 'failed';
  reason?: string;
}

export interface RepoOutcome {
  dryRun: boolean;
  snapshotFile?: string;
  results: RepoFileResult[];
}

export interface RepoSnapshot {
  kind: 'repo';
  version: 1;
  site: string;
  repoPath: string;
  createdAt: string;
  backupDir: string;
  files: {
    path: string;
    action: 'create' | 'modify';
    before: string | null;
    afterSha1: string;
    written: boolean;
  }[];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function read(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function firstExisting(root: string, candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(join(root, c))) return c;
  return null;
}

export function detectRepoStack(repoPath: string): RepoInfo {
  const root = resolve(repoPath);
  const signals: string[] = [];
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(read(join(root, 'package.json')) ?? '{}');
  } catch {
    /* ignore */
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (d: string) => d in deps;
  let stack: StackId = 'unknown';
  const byDep: [string[], StackId][] = [
    [['next'], 'nextjs'],
    [['astro'], 'astro'],
    [['nuxt', 'nuxt3'], 'nuxt'],
    [['@sveltejs/kit'], 'sveltekit'],
    [['gatsby'], 'gatsby'],
    [['@remix-run/react', '@remix-run/node', '@react-router/dev'], 'remix'],
    [['@angular/core'], 'angular'],
    [['vue'], 'vue-spa'],
    [['react'], 'react-spa'],
  ];
  for (const [names, id] of byDep) {
    const hit = names.find(has);
    if (hit) {
      stack = id;
      signals.push(`package.json: ${hit}`);
      break;
    }
  }
  if (stack === 'unknown') {
    if (
      firstExisting(root, ['hugo.toml', 'hugo.yaml', 'hugo.json']) ||
      (existsSync(join(root, 'config.toml')) && isDir(join(root, 'archetypes')))
    ) {
      stack = 'hugo';
      signals.push('hugo config');
    } else if (
      existsSync(join(root, '_config.yml')) &&
      /jekyll/i.test(read(join(root, 'Gemfile')) ?? 'jekyll')
    ) {
      stack = 'jekyll';
      signals.push('_config.yml');
    } else if (existsSync(join(root, 'wp-config.php')) || isDir(join(root, 'wp-content'))) {
      stack = 'wordpress';
      signals.push('wp-config.php / wp-content');
    } else if (firstExisting(root, ['index.html', 'public/index.html', 'docs/index.html'])) {
      stack = 'static';
      signals.push('index.html');
    }
  }
  const cfg = firstExisting(root, [
    'next.config.ts',
    'next.config.mjs',
    'next.config.js',
    'astro.config.mjs',
    'astro.config.ts',
    'nuxt.config.ts',
    'svelte.config.js',
    'gatsby-config.js',
    'gatsby-config.ts',
  ]);
  if (cfg) signals.push(cfg);
  let router: NextRouter = null;
  let appDir: string | null = null;
  if (stack === 'nextjs') {
    appDir = firstExisting(root, ['src/app', 'app']);
    router = appDir ? 'app' : firstExisting(root, ['src/pages', 'pages']) ? 'pages' : null;
    if (router) signals.push(`${router} router`);
  }
  const publicDir = (() => {
    switch (stack) {
      case 'sveltekit':
      case 'gatsby':
      case 'hugo':
        return 'static';
      case 'jekyll':
      case 'wordpress':
        return '';
      case 'angular':
        return isDir(join(root, 'public')) ? 'public' : 'src';
      case 'static':
        return existsSync(join(root, 'index.html'))
          ? ''
          : isDir(join(root, 'public'))
            ? 'public'
            : 'docs';
      case 'unknown':
        return isDir(join(root, 'public')) ? 'public' : '';
      default:
        return 'public';
    }
  })();
  const host =
    existsSync(join(root, 'vercel.json')) || isDir(join(root, '.vercel'))
      ? 'vercel'
      : existsSync(join(root, 'netlify.toml'))
        ? 'netlify'
        : firstExisting(root, ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'])
          ? 'cloudflare'
          : null;
  if (host) signals.push(`host: ${host}`);
  return {
    path: root,
    stack,
    router,
    publicDir,
    appDir,
    host,
    isGit: existsSync(join(root, '.git')),
    signals,
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface RepoPlanOptions {
  only?: string[];
  robotsPolicy?: RobotsPolicy;
  brand?: BrandFacts;
}

const p = (...parts: string[]) => posix.join(...parts.filter(Boolean));

function wanted(only: string[] | undefined, checkId: string, recipeId: string): boolean {
  if (!only?.length) return true;
  return only.some((o) => {
    const re = new RegExp(
      '^' +
        o
          .split('*')
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    );
    return re.test(checkId) || re.test(recipeId);
  });
}

function insertAfterImports(src: string, line: string): string {
  const lines = src.split('\n');
  let last = -1;
  let inImport = false;
  lines.forEach((l, i) => {
    if (/^import\s/.test(l)) {
      inImport = !/;\s*$|from\s+['"][^'"]+['"]\s*;?\s*$/.test(l);
      last = i;
    } else if (inImport) {
      last = i;
      if (/from\s+['"][^'"]+['"]\s*;?\s*$/.test(l)) inImport = false;
    }
  });
  if (last === -1) {
    // keep 'use client' / directives first
    const d = lines.findIndex((l) => !/^\s*(['"]use [a-z]+['"];?)?\s*$/.test(l));
    lines.splice(Math.max(0, d), 0, line);
  } else lines.splice(last + 1, 0, line);
  return lines.join('\n');
}

function urlToHtmlFile(root: string, publicDir: string, url: string): string | null {
  const path = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '');
  const candidates =
    path === ''
      ? ['index.html']
      : [`${path.slice(1)}.html`, `${path.slice(1)}/index.html`, path.slice(1)];
  for (const c of candidates) {
    const rel = p(publicDir, c);
    if (c.endsWith('.html') && existsSync(join(root, rel))) return rel;
  }
  return null;
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function setHtmlTitle(html: string, title: string): string {
  const t = `<title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>`;
  if (/<title[^>]*>[\s\S]*?<\/title>/i.test(html))
    return html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, t);
  return html.replace(/<\/head>/i, `  ${t}\n</head>`);
}

export function setHtmlDescription(html: string, desc: string): string {
  const tag = `<meta name="description" content="${escAttr(desc)}" />`;
  const re = /<meta\s+[^>]*name=["']description["'][^>]*>/i;
  if (re.test(html)) return html.replace(re, tag);
  return html.replace(/<\/head>/i, `  ${tag}\n</head>`);
}

export async function planRepoFixes(
  result: AuditResult,
  repoPath: string,
  opts: RepoPlanOptions = {},
): Promise<RepoPlan> {
  const info = detectRepoStack(repoPath);
  const root = info.path;
  const pending = new Map<
    string,
    { before: string | null; after: string; checkIds: Set<string>; description: string[] }
  >();
  const skipped: RepoPlan['skipped'] = [];
  const notes: string[] = [];
  const current = (rel: string): string | null => pending.get(rel)?.after ?? read(join(root, rel));
  const edit = (
    rel: string,
    checkId: string,
    desc: string,
    fn: (cur: string | null) => string | null,
  ) => {
    const cur = current(rel);
    const next = fn(cur);
    if (next === null || next === cur) return false;
    const entry = pending.get(rel) ?? {
      before: read(join(root, rel)),
      after: next,
      checkIds: new Set<string>(),
      description: [],
    };
    entry.after = next;
    entry.checkIds.add(checkId);
    if (!entry.description.includes(desc)) entry.description.push(desc);
    pending.set(rel, entry);
    return true;
  };
  const sitemaps = result.sitemaps
    .filter((s) => s.found)
    .map((s) => s.url)
    .slice(0, 5);
  const sitemapList = sitemaps.length ? sitemaps : [`${new URL(result.site).origin}/sitemap.xml`];
  const liveRobots = result.robots.found ? result.robots.body : '';
  const brand: BrandFacts = { name: inferBrandName(result), ...opts.brand };
  const byCheck = new Map<string, number>();
  for (const i of result.issues) byCheck.set(i.checkId, (byCheck.get(i.checkId) ?? 0) + 1);
  const ids = [...byCheck.keys()].filter((id) => result.checks[id]?.status !== 'skipped');

  // ---- robots.txt ----------------------------------------------------------
  const robotsTs = info.appDir
    ? firstExisting(
        root,
        ['ts', 'js', 'tsx'].map((e) => `${info.appDir}/robots.${e}`),
      )
    : null;
  const robotsTxt = p(info.publicDir, 'robots.txt');
  const robotsRecipes = ['robots-missing', 'ai-robots', 'content-signal', 'robots-sitemap-line'];
  const robotsIds = ids
    .map((id) => ({ id, recipe: findRecipe(id).id }))
    .filter((x) => robotsRecipes.includes(x.recipe) && wanted(opts.only, x.id, x.recipe))
    .sort((a, b) => robotsRecipes.indexOf(a.recipe) - robotsRecipes.indexOf(b.recipe));
  if (robotsIds.length) {
    if (robotsTs) {
      for (const x of robotsIds)
        skipped.push({
          checkId: x.id,
          reason: `robots.txt comes from \`${robotsTs}\`; edit its rules by hand (see the guided fix)`,
        });
    } else if (
      info.stack === 'nextjs' &&
      info.router === 'app' &&
      !existsSync(join(root, robotsTxt)) &&
      !robotsIds.some((x) => x.recipe === 'content-signal')
    ) {
      const policy = opts.robotsPolicy ?? defaultPolicy(liveRobots);
      const rel = p(info.appDir!, 'robots.ts');
      for (const x of robotsIds)
        edit(rel, x.id, 'Generate robots.txt from app/robots.ts with rules for AI crawlers', () =>
          nextRobotsTs(sitemapList[0], policy),
        );
      notes.push(
        `Review the PRIVATE paths in ${rel}: copy any Disallow rules your live robots.txt had.`,
      );
    } else {
      for (const x of robotsIds) {
        edit(robotsTxt, x.id, descFor(x.recipe), (cur) => {
          const base = cur ?? (liveRobots || 'User-agent: *\nAllow: /\n');
          const policy = opts.robotsPolicy ?? defaultPolicy(base);
          switch (x.recipe) {
            case 'robots-missing':
              return cur ? null : generateRobotsTxt(base, policy, { sitemaps: sitemapList });
            case 'ai-robots':
              return generateRobotsTxt(base, policy, { sitemaps: sitemapList });
            case 'content-signal':
              return generateRobotsTxt(base, policy, {
                sitemaps: sitemapList,
                contentSignal: {
                  search: 'yes',
                  'ai-input': 'yes',
                  'ai-train': policy === 'allow-all-ai' ? 'yes' : 'no',
                },
              });
            default:
              return addSitemapLines(base, sitemapList);
          }
        });
      }
    }
  }

  for (const id of ids) {
    const recipe = findRecipe(id);
    if (
      !recipe.auto?.repo ||
      robotsRecipes.includes(recipe.id) ||
      !wanted(opts.only, id, recipe.id)
    )
      continue;

    // ---- llms.txt ----------------------------------------------------------
    if (recipe.id === 'llms-txt') {
      const route = firstExisting(root, [
        ...(info.appDir ? ['ts', 'js'].map((e) => `${info.appDir}/llms.txt/route.${e}`) : []),
        'src/pages/llms.txt.ts',
        'server/routes/llms.txt.ts',
        'src/routes/llms.txt/+server.ts',
      ]);
      if (route) {
        skipped.push({
          checkId: id,
          reason: `llms.txt is served by \`${route}\`; update it there`,
        });
        continue;
      }
      edit(
        p(info.publicDir, 'llms.txt'),
        id,
        'Add llms.txt generated from the crawl (name, summary, main pages by section)',
        () => generateLlmsTxt(result, { name: brand.name, summary: brand.description }),
      );
      continue;
    }

    // ---- Organization / WebSite JSON-LD -----------------------------------------
    if (recipe.id === 'schema-organization' || recipe.id === 'entity-same-as') {
      if (recipe.id === 'entity-same-as' && !brand.sameAs?.length) {
        skipped.push({
          checkId: id,
          reason: 'needs your official profile URLs (brand.sameAs in avc.config.json)',
        });
        continue;
      }
      const ld = generateSiteGraphJsonLd(result, brand);
      const r = addSiteJsonLd(info, ld, id, edit, current);
      if (r) skipped.push({ checkId: id, reason: r });
      continue;
    }

    // ---- security headers -----------------------------------------------------
    if (recipe.id === 'security-headers') {
      const r = addHeaders(info, headersForCheck(id), id, edit, current, result.stack.host);
      if (r) skipped.push({ checkId: id, reason: r });
      continue;
    }

    // ---- titles / descriptions -------------------------------------------------
    if (recipe.id === 'titles' || recipe.id === 'descriptions') {
      const field = recipe.id === 'titles' ? 'title' : 'description';
      if (info.stack === 'static') {
        const urls = [
          ...new Set(result.issues.filter((i) => i.checkId === id && i.url).map((i) => i.url!)),
        ].slice(0, 100);
        let done = 0;
        for (const u of urls) {
          const rel = urlToHtmlFile(root, info.publicDir, u);
          if (!rel) continue;
          const html = current(rel) ?? '';
          const { document } = parseHTML(html);
          const h1 = document.querySelector('h1')?.textContent?.trim() ?? null;
          const lead = Array.from(document.querySelectorAll('main p, article p, body p'))
            .map((n) => (n as Element).textContent?.trim() ?? '')
            .filter((t) => t.length > 40)
            .slice(0, 3)
            .join(' ');
          const s = suggestMetaRules(
            {
              url: u,
              title: document.querySelector('title')?.textContent?.trim() || null,
              metaDescription:
                document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
              h1,
              lead,
            },
            { brand: brand.name, force: true },
          );
          const v = field === 'title' ? s.title?.suggested : s.description?.suggested;
          if (!v) continue;
          if (
            edit(
              rel,
              id,
              `Set the ${field} (draft from the page's own H1/text — review the wording)`,
              (cur) =>
                field === 'title' ? setHtmlTitle(cur ?? '', v) : setHtmlDescription(cur ?? '', v),
            )
          )
            done++;
        }
        if (!done)
          skipped.push({ checkId: id, reason: 'no matching HTML files, or no text to draft from' });
      } else if (info.stack === 'nextjs' && info.router === 'app') {
        const layout = firstExisting(
          root,
          ['tsx', 'jsx', 'js'].map((e) => `${info.appDir}/layout.${e}`),
        );
        const src = layout ? current(layout) : null;
        if (!layout || !src) {
          skipped.push({ checkId: id, reason: 'no root layout found' });
        } else if (/export\s+(const\s+metadata|(async\s+)?function\s+generateMetadata)/.test(src)) {
          skipped.push({
            checkId: id,
            reason:
              'metadata is already exported; set per-page titles in each page.tsx (see the guided fix)',
          });
        } else {
          const home = result.pages.find((x) => new URL(x.finalUrl || x.url).pathname === '/');
          const desc = home?.metaDescription ?? brand.description ?? null;
          const ts = layout.endsWith('.tsx');
          edit(
            layout,
            id,
            'Add a root metadata export with a title template (pages can then set their own title)',
            (cur) => {
              const meta = `\n${ts ? 'export const metadata: Metadata = {' : 'export const metadata = {'}\n  metadataBase: new URL(${JSON.stringify(new URL(result.site).origin)}),\n  title: { default: ${JSON.stringify(home?.title ?? brand.name ?? '')}, template: ${JSON.stringify(`%s – ${brand.name}`)} },\n${desc ? `  description: ${JSON.stringify(desc)},\n` : ''}};\n`;
              let out =
                ts && !/import\s+type\s+\{\s*Metadata\s*\}/.test(cur!)
                  ? insertAfterImports(cur!, "import type { Metadata } from 'next';")
                  : cur!;
              const lines = out.split('\n');
              let lastImport = -1;
              lines.forEach((l, i) => {
                if (/^import\s/.test(l) || /from\s+['"][^'"]+['"];?\s*$/.test(l)) lastImport = i;
              });
              lines.splice(lastImport + 1, 0, meta);
              out = lines.join('\n');
              return out;
            },
          );
        }
      } else {
        skipped.push({
          checkId: id,
          reason: `per-page ${field}s on ${info.stack} come from your content; use the guided fix`,
        });
      }
    }
  }

  const changes: RepoChange[] = [...pending.entries()]
    .filter(([, e]) => e.after !== e.before)
    .map(([path, e]) => ({
      path,
      action: e.before === null ? 'create' : 'modify',
      before: e.before,
      after: e.after,
      diff: unifiedDiff(path, e.before, e.after),
      checkIds: [...e.checkIds],
      description: e.description,
    }));
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const branchSuggestion = info.isGit ? `avc/ai-visibility-fixes-${date}` : undefined;
  if (branchSuggestion)
    notes.unshift(
      `This is a git repository: create a branch first (\`git switch -c ${branchSuggestion}\`), then review with \`git diff\` after applying. AVC does not run git.`,
    );
  return {
    target: 'repo',
    site: result.site,
    repoPath: root,
    createdAt: new Date().toISOString(),
    info,
    changes,
    skipped,
    diff: changes.map((c) => c.diff).join(''),
    branchSuggestion,
    notes,
  };
}

function descFor(recipe: string): string {
  return recipe === 'robots-missing'
    ? 'Create robots.txt'
    : recipe === 'ai-robots'
      ? 'Allow AI search and assistant crawlers in robots.txt (other rules kept)'
      : recipe === 'content-signal'
        ? 'Add a Content-Signal line to robots.txt'
        : 'List the sitemap in robots.txt';
}

type EditFn = (
  rel: string,
  checkId: string,
  desc: string,
  fn: (cur: string | null) => string | null,
) => boolean;

/** Returns a skip reason, or null when a change was planned. */
function addSiteJsonLd(
  info: RepoInfo,
  ld: unknown,
  checkId: string,
  edit: EditFn,
  current: (rel: string) => string | null,
): string | null {
  const root = info.path;
  const json = JSON.stringify(ld, null, 2);
  const desc = 'Add Organization + WebSite JSON-LD to every page';
  if (info.stack === 'nextjs' && info.router === 'app' && info.appDir) {
    const layout = firstExisting(
      root,
      ['tsx', 'jsx', 'js'].map((e) => `${info.appDir}/layout.${e}`),
    );
    const src = layout ? current(layout) : null;
    if (!layout || !src) return 'no root layout found';
    if (src.includes('application/ld+json') || src.includes('SiteJsonLd'))
      return 'the root layout already outputs JSON-LD; extend it by hand';
    if (!/<body\b[^>]*>/.test(src)) return 'could not find <body> in the root layout';
    const compDir = info.appDir.startsWith('src/') ? 'src/components' : 'components';
    const ext = layout.endsWith('.tsx') ? 'tsx' : 'jsx';
    const compRel = `${compDir}/avc-site-json-ld.${ext}`;
    let importPath = posix.relative(posix.dirname(layout), compRel.replace(/\.(t|j)sx$/, ''));
    if (!importPath.startsWith('.')) importPath = './' + importPath;
    edit(
      compRel,
      checkId,
      desc,
      () =>
        `// Generated by AI Visibility Checker from your site's crawl. Edit freely.\nconst data = ${json};\n\nexport function SiteJsonLd() {\n  return (\n    <script\n      type="application/ld+json"\n      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\\\u003c') }}\n    />\n  );\n}\n`,
    );
    edit(layout, checkId, desc, (cur) => {
      const withImport = insertAfterImports(cur!, `import { SiteJsonLd } from '${importPath}';`);
      return withImport.replace(/(<body\b[^>]*>)/, '$1\n        <SiteJsonLd />');
    });
    return null;
  }
  if (info.stack === 'astro') {
    const dir = join(root, 'src/layouts');
    const files = isDir(dir) ? readdirSync(dir).filter((f) => f.endsWith('.astro')) : [];
    files.sort((a, b) => Number(/base|layout/i.test(b)) - Number(/base|layout/i.test(a)));
    const rel = files
      .map((f) => `src/layouts/${f}`)
      .find((f) => /<\/head>/i.test(current(f) ?? ''));
    if (!rel) return 'no layout with a <head> found in src/layouts';
    if ((current(rel) ?? '').includes('application/ld+json'))
      return `${rel} already outputs JSON-LD`;
    edit(rel, checkId, desc, (cur) =>
      cur!.replace(
        /<\/head>/i,
        `  <script type="application/ld+json" set:html={JSON.stringify(${json.replace(/\n/g, '\n    ')})} />\n  </head>`,
      ),
    );
    return null;
  }
  const tag = `<script type="application/ld+json">\n${json}\n</script>`;
  const target =
    info.stack === 'static'
      ? p(info.publicDir, 'index.html')
      : info.stack === 'hugo'
        ? 'layouts/partials/head.html'
        : info.stack === 'jekyll'
          ? '_includes/head.html'
          : null;
  if (!target || !existsSync(join(root, target)))
    return `no ${target ?? 'shared head template'} to patch on ${info.stack}; use the guided fix`;
  if ((current(target) ?? '').includes('application/ld+json'))
    return `${target} already has JSON-LD`;
  edit(
    target,
    checkId,
    info.stack === 'static' ? 'Add Organization + WebSite JSON-LD to the home page' : desc,
    (cur) =>
      /<\/head>/i.test(cur!)
        ? cur!.replace(/<\/head>/i, `${tag}\n</head>`)
        : `${cur!.trimEnd()}\n${tag}\n`,
  );
  return null;
}

function addHeaders(
  info: RepoInfo,
  wantedHeaders: Record<string, string>,
  checkId: string,
  edit: EditFn,
  current: (rel: string) => string | null,
  liveHost?: string,
): string | null {
  const root = info.path;
  const desc = `Add ${Object.keys(wantedHeaders).join(', ')}`;
  const missingIn = (text: string) =>
    Object.fromEntries(
      Object.entries(wantedHeaders).filter(([k]) => !text.toLowerCase().includes(k.toLowerCase())),
    );
  const vercel =
    existsSync(join(root, 'vercel.json')) ||
    info.host === 'vercel' ||
    /vercel/i.test(liveHost ?? '');
  if (vercel) {
    const cur = current('vercel.json');
    let cfg: { headers?: { source: string; headers: { key: string; value: string }[] }[] } & Record<
      string,
      unknown
    >;
    try {
      cfg = cur ? JSON.parse(cur) : {};
    } catch {
      return 'vercel.json is not valid JSON';
    }
    const add = missingIn(cur ?? '');
    if (!Object.keys(add).length) return 'vercel.json already sets these headers';
    edit('vercel.json', checkId, desc, () => {
      const headers = cfg.headers ?? [];
      let all = headers.find((h) => h.source === '/(.*)');
      if (!all) {
        all = { source: '/(.*)', headers: [] };
        headers.push(all);
      }
      for (const [key, value] of Object.entries(add)) all.headers.push({ key, value });
      return JSON.stringify({ ...cfg, headers }, null, 2) + '\n';
    });
    return null;
  }
  if (existsSync(join(root, 'netlify.toml'))) {
    const add = missingIn(current('netlify.toml') ?? '');
    if (!Object.keys(add).length) return 'netlify.toml already sets these headers';
    edit(
      'netlify.toml',
      checkId,
      desc,
      (cur) => `${cur!.trimEnd()}\n\n${headerConfig('netlify', add)}\n`,
    );
    return null;
  }
  const headersFile = firstExisting(root, [
    p(info.publicDir, '_headers'),
    '_headers',
    'static/_headers',
  ]);
  if (headersFile) {
    const add = missingIn(current(headersFile) ?? '');
    if (!Object.keys(add).length) return `${headersFile} already sets these headers`;
    edit(
      headersFile,
      checkId,
      desc,
      (cur) => `${cur!.trimEnd()}\n\n${headerConfig('headers-file', add)}\n`,
    );
    return null;
  }
  if (info.stack === 'nextjs') {
    const cfgFile = firstExisting(root, ['next.config.ts', 'next.config.mjs', 'next.config.js']);
    const src = cfgFile ? current(cfgFile) : null;
    if (!cfgFile || !src) return 'no next.config file found';
    if (/\bheaders\s*\(/.test(src))
      return `${cfgFile} already has a headers() function; add the headers there by hand`;
    const m = /(const\s+nextConfig[^=]*=\s*\{|module\.exports\s*=\s*\{|export\s+default\s+\{)/.exec(
      src,
    );
    if (!m) return `could not find the config object in ${cfgFile}`;
    const block = `\n  async headers() {\n    return [\n      {\n        source: '/:path*',\n        headers: [\n${Object.entries(
      wantedHeaders,
    )
      .map(([k, v]) => `          { key: ${JSON.stringify(k)}, value: ${JSON.stringify(v)} },`)
      .join('\n')}\n        ],\n      },\n    ];\n  },`;
    edit(cfgFile, checkId, desc, (cur) => cur!.replace(m[0], m[0] + block));
    return null;
  }
  return 'no host config file (vercel.json, netlify.toml, _headers, next.config) found; set the headers on your server or CDN (guided fix)';
}

// ---------------------------------------------------------------------------
// Apply and rollback
// ---------------------------------------------------------------------------

function safeJoin(root: string, rel: string): string {
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep))
    throw new Error(`refusing to write outside the repo: ${rel}`);
  return abs;
}

export function applyRepoPlan(
  plan: RepoPlan,
  opts: { dryRun: boolean; dataDir: string },
): RepoOutcome {
  if (opts.dryRun)
    return {
      dryRun: true,
      results: plan.changes.map((c) => ({ path: c.path, status: 'planned' })),
    };
  const root = plan.repoPath;
  const results: RepoFileResult[] = [];
  const ok: RepoChange[] = [];
  for (const c of plan.changes) {
    const now = read(safeJoin(root, c.path));
    if (now !== c.before) {
      results.push({
        path: c.path,
        status: 'skipped',
        reason:
          c.before === null
            ? 'file was created since the plan'
            : 'file changed since the plan; re-run the plan',
      });
      continue;
    }
    ok.push(c);
  }
  const snapshotFile = snapshotPath(opts.dataDir, plan.site);
  const backupDir = snapshotFile.replace(/\.json$/, '');
  const snapshot: RepoSnapshot = {
    kind: 'repo',
    version: 1,
    site: plan.site,
    repoPath: root,
    createdAt: new Date().toISOString(),
    backupDir,
    files: ok.map((c) => ({
      path: c.path,
      action: c.action,
      before: c.before,
      afterSha1: sha1(c.after),
      written: false,
    })),
  };
  for (const c of ok) {
    if (c.before === null) continue;
    const dest = join(backupDir, 'files', c.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, c.before);
  }
  writeJson(snapshotFile, snapshot);
  for (const c of ok) {
    try {
      const abs = safeJoin(root, c.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, c.after);
      snapshot.files.find((f) => f.path === c.path)!.written = true;
      results.push({ path: c.path, status: 'written' });
    } catch (e) {
      results.push({ path: c.path, status: 'failed', reason: (e as Error).message });
    }
  }
  writeJson(snapshotFile, snapshot);
  return { dryRun: false, snapshotFile, results };
}

export function rollbackRepo(
  snapshotFile: string,
  opts: { force?: boolean; dryRun?: boolean } = {},
): RepoFileResult[] {
  const snap = readJson<RepoSnapshot>(snapshotFile);
  if (snap.kind !== 'repo') throw new Error(`${snapshotFile} is not a repo snapshot`);
  const out: RepoFileResult[] = [];
  for (const f of [...snap.files].reverse()) {
    if (!f.written) continue;
    const abs = safeJoin(snap.repoPath, f.path);
    const now = read(abs);
    if (!opts.force && (now === null || sha1(now) !== f.afterSha1)) {
      out.push({
        path: f.path,
        status: 'skipped',
        reason: 'changed since AVC wrote it; use --force to restore anyway',
      });
      continue;
    }
    if (opts.dryRun) {
      out.push({ path: f.path, status: 'planned' });
      continue;
    }
    if (f.before === null) {
      rmSync(abs, { force: true });
      out.push({ path: f.path, status: 'deleted' });
    } else {
      writeFileSync(abs, f.before);
      out.push({ path: f.path, status: 'restored' });
    }
  }
  return out;
}

export function renderRepoPlan(plan: RepoPlan, outcome?: RepoOutcome): string {
  const lines = [
    `Repository: ${plan.repoPath} (${plan.info.stack}${plan.info.router ? `, ${plan.info.router} router` : ''}${plan.info.host ? `, ${plan.info.host}` : ''})`,
    `${plan.changes.length} file change(s), ${plan.skipped.length} skipped`,
    ...plan.notes,
    '',
  ];
  for (const c of plan.changes) {
    const r = outcome?.results.find((x) => x.path === c.path);
    lines.push(
      `${r ? `[${r.status}] ` : ''}${c.action} ${c.path} — ${c.description.join('; ')} (${c.checkIds.join(', ')})`,
    );
    if (r?.reason) lines.push(`  ${r.reason}`);
  }
  if (plan.skipped.length) {
    lines.push('', 'Skipped:');
    for (const s of plan.skipped) lines.push(`  ${s.checkId}: ${s.reason}`);
  }
  if (plan.diff) lines.push('', plan.diff);
  return lines.join('\n');
}
