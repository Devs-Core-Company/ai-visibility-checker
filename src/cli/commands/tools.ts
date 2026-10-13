/**
 * Smaller tools: snippet preview and AI writer, questions about an audit,
 * screenshots, Screaming Frog import, crawl presets, update check, an app
 * launcher, and feedback.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AuditResult } from '../../core/types.js';
import { APP_NAME, APP_VERSION } from '../../core/version.js';
import { serpRow, serpSummary, type SerpRow } from '../../report/serp.js';
import { c, fail, ok, table, warn } from '../output.js';
import { ExitError } from '../errors.js';
import { openPath } from '../open.js';
import { findAudit, getConfig, getStore, parseFormats, writeReports } from '../services.js';

export const REPO = 'Devs-Core-Company/ai-visibility-checker';

function needAudit(ref: string | undefined): AuditResult {
  const r = findAudit(ref, getConfig());
  if (!r)
    throw new ExitError(
      1,
      `No audit found for "${ref ?? 'latest'}". Run \`avc audit <url>\` first.`,
    );
  return r;
}

// ---------------------------------------------------------------------------
// avc serp — snippet preview, pixel widths, AI-written suggestions
// ---------------------------------------------------------------------------

export async function cmdSerp(
  ref: string | undefined,
  opts: { write?: boolean; all?: boolean; limit?: number; json?: boolean },
): Promise<void> {
  const result = needAudit(ref);
  const rows = result.pages
    .filter((p) => p.status === 200 && p.indexable)
    .map((p) => serpRow(p.url, p.title, p.metaDescription));
  const problems = (r: SerpRow) =>
    !r.title ||
    !r.description ||
    r.titleTruncated ||
    r.descriptionTruncated ||
    r.descriptionThinForAi;
  const shown = (opts.all ? rows : rows.filter(problems)).slice(0, opts.limit ?? 50);
  let suggestions: Awaited<ReturnType<typeof writeSuggestions>> = [];
  if (opts.write) suggestions = await writeSuggestions(shown, result);
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ summary: serpSummary(rows), rows: shown, suggestions }, null, 2) + '\n',
    );
    return;
  }
  const s = serpSummary(rows);
  console.log(
    c.bold(`Snippets for ${result.site}`) +
      c.dim(
        ` · ${s.pages} indexable pages · ${s.titleTruncated} titles cut off · ${s.descriptionTruncated} descriptions cut off · ${s.descriptionThinForAi} descriptions too thin for AI`,
      ),
  );
  for (const r of shown) {
    console.log(`\n${c.cyan(r.url)}`);
    console.log(
      `  ${c.blue(r.shownTitle || c.red('(no title)'))} ${c.dim(`${r.titlePx}px / 580`)}${r.titleTruncated ? c.yellow(' cut off') : ''}`,
    );
    console.log(
      `  ${r.shownDescription || c.red('(no description)')} ${c.dim(`${r.descriptionChars} chars, ${r.descriptionPx}px / 920`)}${r.descriptionThinForAi ? c.yellow(' thin for AI') : ''}`,
    );
    const sug = suggestions.find((x) => x.url === r.url);
    if (sug?.title) console.log(`  ${c.green('title →')} ${sug.title.suggested}`);
    if (sug?.description?.suggested)
      console.log(`  ${c.green('description →')} ${sug.description.suggested}`);
  }
  if (!shown.length) ok('No snippet problems found.');
  else if (!opts.write)
    console.log(
      c.dim(
        '\nAdd --write to draft new titles and descriptions (uses your AI key, or rules without one).',
      ),
    );
  else
    console.log(
      c.dim(
        '\nReview the drafts, then apply them in your CMS, or with `avc fix <site> --target wordpress`.',
      ),
    );
}

async function writeSuggestions(rows: SerpRow[], result: AuditResult) {
  const { generateMetaSuggestions } = await import('../../fixes/generate.js');
  const { createFetcher } = await import('../../core/http.js');
  const { extractPage } = await import('../../crawl/extract.js');
  const config = getConfig();
  const fetcher = createFetcher({
    userAgent: 'AVC writer',
    timeoutMs: 15_000,
    maxBytes: 2_000_000,
  });
  const brand = result.visibility?.brand.name;
  const out = [];
  for (const r of rows.slice(0, 25)) {
    const res = await fetcher.fetch(r.url);
    const page = extractPage(res, { origin: result.site, depth: 0 });
    out.push(
      await generateMetaSuggestions(
        {
          url: r.url,
          title: r.title || null,
          metaDescription: r.description || null,
          h1: page.headings.find((h) => h.level === 1)?.text ?? null,
          lead: page.lead,
          text: page.mainText ?? page.text,
        },
        { brand, config, force: r.descriptionThinForAi || r.titleTruncated },
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// avc ask — questions about an audit
// ---------------------------------------------------------------------------

export async function cmdAsk(
  question: string[],
  opts: { audit?: string; json?: boolean },
): Promise<void> {
  const q = question.join(' ').trim();
  if (!q) throw new ExitError(1, 'Ask a question, e.g. avc ask "what should I fix first?"');
  const result = needAudit(opts.audit);
  const { askAboutAudit } = await import('../../ai/ask.js');
  const r = await askAboutAudit(result, q, getConfig());
  if (opts.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }
  console.log(r.answer);
  if (r.source === 'rules')
    console.log(c.dim('\n(Answered from the audit’s priorities: no AI key set.)'));
}

// ---------------------------------------------------------------------------
// avc screenshot
// ---------------------------------------------------------------------------

export async function cmdScreenshot(
  url: string,
  opts: { mobile?: boolean; full?: boolean; out?: string; open?: boolean },
): Promise<void> {
  const { captureScreenshot } = await import('../../crawl/render.js');
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const r = await captureScreenshot(target, {
    device: opts.mobile ? 'mobile' : 'desktop',
    fullPage: opts.full,
  });
  if (!r.ok) throw new ExitError(1, r.error);
  const file = resolve(
    opts.out ??
      `avc-${new URL(target).host}-${opts.mobile ? 'mobile' : 'desktop'}-${Date.now()}.png`,
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, r.png);
  ok(file);
  if (opts.open) openPath(file);
}

// ---------------------------------------------------------------------------
// avc import — audit a Screaming Frog export
// ---------------------------------------------------------------------------

/** Checks that can be judged from a Screaming Frog "Internal: All" export. */
export const IMPORT_CHECKS = [
  'response.client-error',
  'response.server-error',
  'response.forbidden',
  'redirects.temporary',
  'onpage.title-*',
  'onpage.description-*',
  'headings.h1-*',
  'canonical.missing',
  'canonical.multiple',
  'canonical.points-elsewhere',
  'canonical.cross-domain',
  'canonical.relative',
  'crawlability.noindex',
  'crawlability.noindex-header',
  'crawlability.deep-page',
  'crawlability.robots-conflict',
  'crawlability.noindex-nofollow',
  'content.thin',
  'content.cannibalisation',
  'duplicates.title-and-description',
  'urls.*',
  'performance.ttfb-slow',
  'performance.html-heavy',
];

export async function cmdImport(
  file: string,
  opts: { site?: string; format: string; out: string; save?: boolean; json?: boolean },
): Promise<void> {
  if (!existsSync(file)) throw new ExitError(1, `${file} does not exist.`);
  const { siteFromScreamingFrog } = await import('../../crawl/import-csv.js');
  const { runAudit } = await import('../../audit/index.js');
  const config = getConfig();
  const site = siteFromScreamingFrog(file, { startUrl: opts.site });
  const result = await runAudit(
    { url: site.startUrl, config, only: IMPORT_CHECKS },
    {
      crawlSite: async () => site,
      runAgenticProbes: async () => {},
      fetchAsBots: async () => {},
      collectExternal: async () => {},
    },
  );
  if (opts.save !== false) getStore(config).saveAudit(result, site.host.replace(/^www\./, ''));
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  const files = await writeReports(result, parseFormats(opts.format, ['html', 'json']), opts.out);
  ok(
    `Imported ${site.pages.size} URLs from ${file}: score ${result.score.overall} (${result.score.grade}), ${result.issues.length} issues from ${IMPORT_CHECKS.length} check groups.`,
  );
  for (const f of files) console.log(`  ${c.dim('report')} ${f}`);
  console.log(
    c.dim(
      'Imported data has no full HTML, headers or live requests, so only on-page, status, canonical and URL checks run. Run `avc audit` for everything.',
    ),
  );
}

// ---------------------------------------------------------------------------
// avc presets
// ---------------------------------------------------------------------------

export async function cmdPresets(opts: { json?: boolean }): Promise<void> {
  const { PRESETS } = await import('../../crawl/presets.js');
  if (opts.json) {
    process.stdout.write(JSON.stringify(PRESETS, null, 2) + '\n');
    return;
  }
  console.log(
    table(
      Object.values(PRESETS).map((p) => [
        c.cyan(p.id),
        p.label,
        `${p.exclude.length} exclusions`,
        Object.keys(p.variants ?? {})
          .map((v) => `${p.id}:${v}`)
          .join(', '),
      ]),
    ),
  );
  console.log(
    c.dim('\nUse with `avc audit <url> --preset auto` (detects the platform) or --preset <id>.'),
  );
}

// ---------------------------------------------------------------------------
// avc update — check for (and install) a newer version
// ---------------------------------------------------------------------------

export function compareVersions(a: string, b: string): number {
  const pa = a
    .replace(/^v/, '')
    .split(/[.-]/)
    .map((x) => Number(x) || 0);
  const pb = b
    .replace(/^v/, '')
    .split(/[.-]/)
    .map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export async function latestVersion(f: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await f(`https://raw.githubusercontent.com/${REPO}/main/package.json`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

export async function cmdUpdate(opts: { check?: boolean; yes?: boolean }): Promise<void> {
  const latest = await latestVersion();
  if (!latest) throw new ExitError(1, 'Could not read the latest version from GitHub.');
  const cmp = compareVersions(latest, APP_VERSION);
  if (cmp <= 0) {
    ok(`You have the latest version (${APP_VERSION}).`);
    return;
  }
  console.log(`${APP_NAME} ${c.bold(latest)} is available (you have ${APP_VERSION}).`);
  const install = ['i', '-g', `github:${REPO}`];
  if (opts.check) {
    console.log(c.dim(`Update with: avc update   (runs npm ${install.join(' ')})`));
    return;
  }
  if (process.env.AVC_DATA_DIR === '/data' && existsSync('/.dockerenv')) {
    warn('In Docker, rebuild the image instead: docker build -t avc <repo URL>.');
    return;
  }
  const npm = platform() === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, install, { stdio: 'inherit', shell: platform() === 'win32' });
  if (r.status !== 0) {
    fail(`npm exited with ${r.status}. Run \`npm ${install.join(' ')}\` yourself.`);
    throw new ExitError(1);
  }
  ok(`Updated to ${latest}. Run \`avc doctor\` to check the setup.`);
}

// ---------------------------------------------------------------------------
// avc shortcut — an app launcher for the dashboard
// ---------------------------------------------------------------------------

/** The command that starts the dashboard from a launcher. */
export function launchCommand(): { node: string; bin: string } {
  return { node: process.execPath, bin: resolve(process.argv[1] ?? 'avc') };
}

export function shortcutPaths(home = homedir(), os = platform()): string[] {
  if (os === 'darwin') return [join(home, 'Applications', `${APP_NAME}.app`)];
  if (os === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return [join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`)];
  }
  return [join(home, '.local', 'share', 'applications', 'avc-dashboard.desktop')];
}

/** Linux .desktop entry text. */
export function desktopEntry(node: string, bin: string): string {
  return `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=Audit your site for Google and AI engines (local dashboard)
Exec="${node}" "${bin}" ui
Terminal=false
Categories=Development;Network;
Keywords=SEO;AI;audit;
`;
}

export async function cmdShortcut(opts: { remove?: boolean }): Promise<void> {
  const os = platform();
  const [path] = shortcutPaths();
  if (!path) throw new ExitError(1, 'Unsupported platform.');
  if (opts.remove) {
    rmSync(path, { recursive: true, force: true });
    ok(`Removed ${path}`);
    return;
  }
  const { node, bin } = launchCommand();
  if (os === 'darwin') {
    const macos = join(path, 'Contents', 'MacOS');
    mkdirSync(macos, { recursive: true });
    writeFileSync(
      join(path, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>${APP_NAME}</string>
<key>CFBundleIdentifier</key><string>com.devs-core.avc</string>
<key>CFBundleExecutable</key><string>avc-ui</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${APP_VERSION}</string>
</dict></plist>
`,
    );
    const script = join(macos, 'avc-ui');
    writeFileSync(script, `#!/bin/sh\nexec "${node}" "${bin}" ui\n`);
    chmodSync(script, 0o755);
  } else if (os === 'win32') {
    mkdirSync(dirname(path), { recursive: true });
    const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${path.replace(/'/g, "''")}');$s.TargetPath='${node.replace(/'/g, "''")}';$s.Arguments='"${bin.replace(/'/g, "''")}" ui';$s.Description='${APP_NAME}';$s.Save()`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    if (r.status !== 0) throw new ExitError(1, 'Could not create the Start Menu shortcut.');
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, desktopEntry(node, bin));
    chmodSync(path, 0o755);
  }
  ok(`Added ${APP_NAME} to your apps: ${path}`);
  console.log(
    c.dim('It opens the local dashboard (avc ui). Remove it with `avc shortcut --remove`.'),
  );
}

// ---------------------------------------------------------------------------
// avc feedback — a prefilled issue, sent only when you submit it
// ---------------------------------------------------------------------------

export function feedbackUrl(message: string): string {
  const body = `${message}\n\n---\nAVC ${APP_VERSION} · ${platform()} ${release()} · Node ${process.versions.node}`;
  const q = new URLSearchParams({ title: message.slice(0, 80) || 'Feedback', body });
  return `https://github.com/${REPO}/issues/new?${q}`;
}

export async function cmdFeedback(words: string[], opts: { email?: boolean }): Promise<void> {
  const message = words.join(' ').trim();
  if (opts.email) {
    const url = `mailto:contact@devs-core.com?subject=${encodeURIComponent('AVC feedback')}&body=${encodeURIComponent(message)}`;
    openPath(url);
    console.log(url);
    return;
  }
  const url = feedbackUrl(message);
  openPath(url);
  ok('Opened a prefilled GitHub issue in your browser. Nothing is sent until you submit it.');
  console.log(c.dim(url));
}

// ---------------------------------------------------------------------------
// avc redirect — add a redirect on a connected WordPress site
// ---------------------------------------------------------------------------

export async function cmdRedirect(
  siteRef: string,
  from: string,
  to: string,
  opts: { code?: number; apply?: boolean },
): Promise<void> {
  const { resolveSite } = await import('../services.js');
  const { addWordPressRedirect } = await import('../../fixes/apply/index.js');
  const config = getConfig();
  const site = resolveSite(siteRef, config);
  const code = (opts.code ?? 301) as 301 | 302 | 307 | 308;
  if (![301, 302, 307, 308].includes(code))
    throw new ExitError(1, '--code must be 301, 302, 307 or 308.');
  const r = await addWordPressRedirect({ config, site, from, to, code, dryRun: !opts.apply });
  console.log(r.summary);
  if (r.plan.skipped.length) throw new ExitError(1);
}
