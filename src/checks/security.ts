/**
 * Security signals visible to crawlers and visitors: HTTPS, headers,
 * mixed content, forms, cookies, leaked versions and exposed files.
 */
import type { Issue, PageData, SiteContext } from '../core/types.js';
import {
  REF,
  header,
  homePage,
  htmlPages,
  isHtml200,
  isHttpsSite,
  list,
  pageCheck,
  pathOf,
  plural,
  safeUrl,
  siteCheck,
  truncate,
} from './_util.js';
import * as cu from './_util.js';

export const HSTS_MIN_MAX_AGE = 15_552_000; // 180 days
export const PROBE_TIMEOUT_MS = 8000;
/** Response headers that commonly carry server software versions. */
const VERSION_HEADERS = [
  'server',
  'x-powered-by',
  'x-aspnet-version',
  'x-aspnetmvc-version',
  'x-generator',
];

const T = 'technical' as const;

const SESSION_COOKIE =
  /^(sess|session|sid|phpsessid|jsessionid|asp\.net_sessionid|connect\.sid|laravel_session|wordpress_logged_in|wp-settings|_session|auth|token)/i;

function cookies(page: PageData): string[] {
  const raw = header(page, 'set-cookie');
  if (!raw) return [];
  // Headers are joined by the fetcher; split on commas that start a new name=value.
  return raw
    .split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** The HTML pages that represent the site for header checks (home first). */
function samplePages(site: SiteContext, n = 20): PageData[] {
  const home = homePage(site);
  const rest = htmlPages(site).filter((p) => p !== home);
  return (home && isHtml200(home) ? [home, ...rest] : rest).slice(0, n);
}

/** Most sampled pages report at most this many pages individually. */
export const HEADER_PAGE_REPORT_LIMIT = 50;

/**
 * A response header missing from HTML pages. When every page lacks it, one site-wide finding
 * (on the home page). When only some pages lack it while the others send it, the server or
 * CDN config misses those routes, so each page is reported. Plain-HTTP pages are included
 * (these headers protect over HTTP too) unless `httpsOnly`.
 */
function headerCheckIssue(
  site: SiteContext,
  checkId: string,
  missing: (p: PageData) => boolean,
  msg: string,
  httpsOnly = false,
): Issue | Issue[] | null {
  const pages = htmlPages(site).filter((p) => !httpsOnly || p.finalUrl.startsWith('https:'));
  if (!pages.length) return null;
  const bad = pages.filter(missing);
  if (!bad.length) return null;
  if (bad.length === pages.length) {
    const home = homePage(site);
    return {
      checkId,
      url: home && bad.includes(home) ? home.url : bad[0].url,
      message: pages.length === 1 ? msg : `${msg} on any page`,
      data: { pages: bad.length },
    };
  }
  return bad.slice(0, HEADER_PAGE_REPORT_LIMIT).map((p) => ({
    checkId,
    url: p.url,
    message: `${msg} on this page, although ${pages.length - bad.length} of ${pages.length} pages send it`,
    data: { pages: bad.length },
  }));
}

async function probe(site: SiteContext, path: string) {
  try {
    return await site.fetcher.fetch(site.origin + path, {
      followRedirects: false,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: 20_000,
    });
  } catch {
    return null;
  }
}

/** RFC 9116 problems in a security.txt body (signed files are read from the cleartext). */
export function securityTxtProblems(body: string, now: number): string[] {
  const fields = new Map<string, string[]>();
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-----')) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1]!.toLowerCase();
    fields.set(k, [...(fields.get(k) ?? []), m[2]!.trim()]);
  }
  const out: string[] = [];
  if (!fields.get('contact')?.length) out.push('no Contact field (required)');
  const expires = fields.get('expires') ?? [];
  if (!expires.length) out.push('no Expires field (required)');
  else if (expires.length > 1) out.push('Expires appears more than once (allowed once)');
  else {
    const t = Date.parse(expires[0]!);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(expires[0]!) || !Number.isFinite(t))
      out.push(`Expires "${expires[0]}" is not an RFC 3339 date-time`);
    else if (t < now) out.push(`Expires ${expires[0]} has passed`);
    else if (t - now > 366 * 86_400_000)
      out.push(`Expires ${expires[0]} is more than a year ahead (RFC 9116 recommends less)`);
  }
  for (const f of ['preferred-languages']) {
    if ((fields.get(f)?.length ?? 0) > 1) out.push(`${f} appears more than once`);
  }
  return out;
}

export const checks = [
  pageCheck(
    {
      id: 'security.not-https',
      category: 'security',
      pillar: T,
      title: 'Page served over plain HTTP',
      why: 'HTTPS is a Google ranking signal and browsers mark HTTP pages "Not secure". Many AI agents and browsers refuse to submit forms over HTTP.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Serve the site over HTTPS with a valid certificate and 301-redirect every HTTP URL to its HTTPS version.',
      refs: [REF.https],
    },
    (page) =>
      isHtml200(page) && page.finalUrl.startsWith('http:')
        ? { checkId: 'security.not-https', message: 'Page loads over http://' }
        : null,
  ),
  pageCheck(
    {
      id: 'security.mixed-content',
      category: 'security',
      pillar: T,
      title: 'HTTPS page loads HTTP resources',
      why: 'Browsers block insecure scripts and styles on HTTPS pages (breaking the page) and warn about insecure images.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Change resource URLs to https:// (or protocol-relative to root paths). Add "Content-Security-Policy: upgrade-insecure-requests" as a safety net.',
      refs: ['https://web.dev/articles/what-is-mixed-content'],
    },
    (page) => {
      if (!isHtml200(page) || !page.mixedContent.length) return null;
      const active = page.mixedContent.filter(
        (u) =>
          /\.(js|css)(\?|$)/i.test(u) ||
          page.scripts.some((s) => s.src === u) ||
          page.stylesheets.some((s) => s.href === u),
      );
      return {
        checkId: 'security.mixed-content',
        severity: active.length ? 'high' : 'medium',
        message: `${plural(page.mixedContent.length, 'insecure resource')}${active.length ? ` (${active.length} scripts or stylesheets, which browsers block)` : ''}`,
        evidence: list(page.mixedContent, 3),
      };
    },
  ),
  pageCheck(
    {
      id: 'security.insecure-form',
      category: 'security',
      pillar: T,
      title: 'Form submits over HTTP',
      why: 'A form that posts to http:// sends what people type in clear text. Browsers warn users and agents should refuse to submit it.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Point the form action at an https:// URL (or a relative path on an HTTPS page).',
      refs: [REF.https],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = page.forms.filter(
        (f) =>
          f.action.startsWith('http:') ||
          (page.finalUrl.startsWith('http:') && f.inputs > 0 && /password/i.test(page.html || '')),
      );
      return bad.length
        ? {
            checkId: 'security.insecure-form',
            message: `${plural(bad.length, 'form')} submit over HTTP`,
            evidence: list(
              bad.map((f) => f.action || page.finalUrl),
              3,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'security.protocol-relative',
      category: 'security',
      pillar: T,
      title: 'Protocol-relative resource URLs',
      why: '"//host/file.js" URLs inherit the page protocol. On an HTTPS site that is harmless but outdated; if a copy of the page is ever served over HTTP, the resources load insecurely too.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Use explicit https:// URLs.',
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const n = (page.html.match(/\b(?:src|href)=["']\/\/[a-z0-9]/gi) || []).length;
      return n
        ? {
            checkId: 'security.protocol-relative',
            message: `${plural(n, 'protocol-relative URL')}`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'security.cookie-not-secure',
      category: 'security',
      pillar: T,
      title: 'Cookies set without the Secure flag',
      why: 'On an HTTPS site, cookies without Secure can be sent over an HTTP request and intercepted. SameSite=None cookies without Secure are rejected by browsers.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add Secure to every cookie the site sets (and HttpOnly to session cookies).',
      refs: [
        'https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies#restrict_access_to_cookies',
      ],
    },
    (page) => {
      if (!page.finalUrl.startsWith('https:')) return null;
      const bad = cookies(page).filter((c) => !/;\s*secure\b/i.test(c));
      return bad.length
        ? {
            checkId: 'security.cookie-not-secure',
            message: `${plural(bad.length, 'cookie')} without Secure`,
            evidence: list(
              bad.map((c) => c.split('=')[0]),
              4,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'security.cookie-not-httponly',
      category: 'security',
      pillar: T,
      title: 'Session cookie readable by JavaScript',
      why: 'Session cookies without HttpOnly can be stolen by any injected script.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add HttpOnly to session and authentication cookies.',
      refs: ['https://owasp.org/www-community/HttpOnly'],
    },
    (page) => {
      const bad = cookies(page).filter((c) => SESSION_COOKIE.test(c) && !/;\s*httponly\b/i.test(c));
      return bad.length
        ? {
            checkId: 'security.cookie-not-httponly',
            message: `${plural(bad.length, 'session cookie')} without HttpOnly`,
            evidence: list(
              bad.map((c) => c.split('=')[0]),
              4,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'security.debug-output',
      category: 'security',
      pillar: T,
      title: 'Server errors or debug output shown on the page',
      why: 'PHP warnings, stack traces and debug dumps leak file paths and versions to attackers, and crawlers index them as page content.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Turn off display of errors in production (for example WP_DEBUG_DISPLAY false, display_errors Off) and log them instead. Fix the underlying error.',
    },
    (page) => {
      if (!page.isHtml || !page.html) return null;
      const m =
        /(<b>(Warning|Fatal error|Notice|Deprecated|Parse error)<\/b>:\s.{0,200}? on line <b>\d+<\/b>|(Warning|Fatal error|Notice|Deprecated): .{0,200}? in \/[\w/.-]+ on line \d+|Traceback \(most recent call last\)|Whoops! There was an error|Stack trace:\s*#0 \/|at [\w$.]+ \(\/[\w/.-]+\.js:\d+:\d+\)|Server Error in '\/' Application)/.exec(
          page.html,
        );
      return m
        ? {
            checkId: 'security.debug-output',
            message: 'Error or debug output visible in the HTML',
            evidence: truncate(m[0].replace(/<[^>]+>/g, ''), 200),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'security.directory-listing',
      category: 'security',
      pillar: T,
      title: 'Directory listing enabled',
      why: 'An "Index of /" page exposes every file in a folder, including backups and files you never linked.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Disable directory listing (Options -Indexes in Apache, autoindex off in nginx) and add an index file.',
    },
    (page) =>
      page.isHtml && page.status === 200 && /^index of \//i.test(page.title || '')
        ? {
            checkId: 'security.directory-listing',
            message: `Directory listing at ${pathOf(page.url)}`,
            evidence: page.title!,
          }
        : null,
  ),
  pageCheck(
    {
      id: 'security.sri-missing',
      category: 'security',
      pillar: T,
      title: 'CDN scripts loaded without integrity checks',
      why: 'If a public CDN file is tampered with, every site loading it runs the attacker’s code. Subresource Integrity makes the browser refuse a changed file.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add integrity="sha384-…" and crossorigin="anonymous" to scripts loaded from public CDNs at fixed versions.',
      refs: ['https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity'],
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const tags = [
        ...page.html.matchAll(
          /<script\b[^>]*\bsrc=["']?(https?:)?\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|code\.jquery\.com|stackpath\.bootstrapcdn\.com|maxcdn\.bootstrapcdn\.com)[^>]*>/gi,
        ),
      ].map((m) => m[0]);
      const bad = tags.filter((t) => !/\bintegrity=/i.test(t));
      return bad.length
        ? {
            checkId: 'security.sri-missing',
            message: `${plural(bad.length, 'CDN script')} without integrity`,
            evidence: truncate(bad[0], 200),
          }
        : null;
    },
  ),

  // -------------------------------------------------------------------------
  // Headers (site, sampled)
  // -------------------------------------------------------------------------
  siteCheck(
    {
      id: 'security.hsts-missing',
      category: 'security',
      pillar: T,
      title: 'No HSTS header',
      why: 'Strict-Transport-Security tells browsers to always use HTTPS, closing the window where a first HTTP request can be intercepted.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Send "Strict-Transport-Security: max-age=31536000; includeSubDomains" on HTTPS responses once every subdomain supports HTTPS.',
      refs: [REF.mdnHeaders + '/Strict-Transport-Security'],
    },
    (site) =>
      isHttpsSite(site)
        ? headerCheckIssue(
            site,
            'security.hsts-missing',
            (p) => !header(p, 'strict-transport-security'),
            'No Strict-Transport-Security header',
            true,
          )
        : null,
  ),
  siteCheck(
    {
      id: 'security.hsts-short',
      category: 'security',
      pillar: T,
      title: 'HSTS max-age is short',
      why: `A max-age under about six months gives little protection between visits and does not qualify for browser preload lists.`,
      severity: 'low',
      fixTier: 'guided',
      fix: 'Raise max-age to at least 31536000 (one year).',
      refs: ['https://hstspreload.org/'],
    },
    (site) => {
      const home = samplePages(site)[0];
      const v = home ? header(home, 'strict-transport-security') : null;
      if (!v) return null;
      const age = Number(/max-age\s*=\s*"?(\d+)/i.exec(v)?.[1] ?? 0);
      return age < HSTS_MIN_MAX_AGE
        ? {
            checkId: 'security.hsts-short',
            url: home!.url,
            message: `HSTS max-age is ${age} seconds`,
            evidence: v,
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'security.csp-missing',
      category: 'security',
      pillar: T,
      title: 'No Content-Security-Policy',
      why: 'A CSP limits where scripts can load from, which blunts cross-site scripting and injected malware that could otherwise hijack pages and their rankings.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Start with a Content-Security-Policy-Report-Only header, review reports, then enforce it.',
      refs: [REF.mdnHeaders + '/Content-Security-Policy'],
    },
    (site) =>
      headerCheckIssue(
        site,
        'security.csp-missing',
        (p) =>
          !header(p, 'content-security-policy') &&
          !header(p, 'content-security-policy-report-only') &&
          !/<meta[^>]+http-equiv=["']?content-security-policy/i.test(p.html || ''),
        'No Content-Security-Policy',
      ),
  ),
  siteCheck(
    {
      id: 'security.csp-unsafe',
      category: 'security',
      pillar: T,
      title: 'CSP allows unsafe inline scripts or eval',
      why: "'unsafe-inline' and 'unsafe-eval' in script-src remove most of the protection a CSP gives against injected scripts.",
      severity: 'low',
      fixTier: 'guided',
      fix: "Use nonces or hashes for inline scripts and remove 'unsafe-eval'. Keep 'unsafe-inline' only as a fallback alongside a nonce or 'strict-dynamic'.",
      refs: ['https://web.dev/articles/strict-csp'],
    },
    (site) => {
      const p = samplePages(site)[0];
      const csp = p ? header(p, 'content-security-policy') : null;
      if (!csp) return null;
      const script =
        /(?:^|;)\s*script-src\s+([^;]+)/i.exec(csp)?.[1] ??
        /(?:^|;)\s*default-src\s+([^;]+)/i.exec(csp)?.[1] ??
        '';
      const unsafe = ["'unsafe-inline'", "'unsafe-eval'"].filter((u) => script.includes(u));
      if (
        !unsafe.length ||
        (unsafe.length === 1 &&
          unsafe[0] === "'unsafe-inline'" &&
          /'nonce-|'sha(256|384|512)-|'strict-dynamic'/.test(script))
      )
        return null;
      return {
        checkId: 'security.csp-unsafe',
        url: p!.url,
        message: `script-src allows ${list(unsafe)}`,
      };
    },
  ),
  siteCheck(
    {
      id: 'security.nosniff-missing',
      category: 'security',
      pillar: T,
      title: 'No X-Content-Type-Options: nosniff',
      why: 'Without nosniff, browsers may guess a file’s type and run an uploaded file as a script.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Send "X-Content-Type-Options: nosniff" on all responses.',
      refs: [REF.mdnHeaders + '/X-Content-Type-Options'],
    },
    (site) =>
      headerCheckIssue(
        site,
        'security.nosniff-missing',
        (p) => !/nosniff/i.test(header(p, 'x-content-type-options') || ''),
        'No X-Content-Type-Options: nosniff',
      ),
  ),
  siteCheck(
    {
      id: 'security.frame-protection-missing',
      category: 'security',
      pillar: T,
      title: 'Pages can be framed by any site',
      why: 'Without X-Frame-Options or CSP frame-ancestors, other sites can embed your pages invisibly and trick people into clicking (clickjacking).',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Send "Content-Security-Policy: frame-ancestors \'self\'" (or X-Frame-Options: SAMEORIGIN).',
      refs: [REF.mdnHeaders + '/Content-Security-Policy/frame-ancestors'],
    },
    (site) =>
      headerCheckIssue(
        site,
        'security.frame-protection-missing',
        (p) =>
          !header(p, 'x-frame-options') &&
          !/frame-ancestors/i.test(header(p, 'content-security-policy') || ''),
        'No X-Frame-Options or frame-ancestors',
      ),
  ),
  siteCheck(
    {
      id: 'security.referrer-policy-missing',
      category: 'security',
      pillar: T,
      title: 'No Referrer-Policy',
      why: 'Browsers now default to a safe referrer policy, but an explicit one guarantees full URLs (which can contain tokens or search terms) are not leaked to other sites.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Send "Referrer-Policy: strict-origin-when-cross-origin".',
      refs: [REF.mdnHeaders + '/Referrer-Policy'],
    },
    (site) =>
      headerCheckIssue(
        site,
        'security.referrer-policy-missing',
        (p) => !header(p, 'referrer-policy') && !/<meta[^>]+name=["']?referrer/i.test(p.html || ''),
        'No Referrer-Policy',
      ),
  ),
  siteCheck(
    {
      id: 'security.version-disclosure',
      category: 'security',
      pillar: T,
      title: 'Server software versions exposed in headers',
      why: 'Headers such as "Server: Apache/2.4.29" or "X-Powered-By: PHP/7.2" tell attackers exactly which known vulnerabilities to try.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Hide version numbers (ServerTokens Prod, server_tokens off, expose_php Off) and remove X-Powered-By.',
      refs: ['https://owasp.org/www-project-secure-headers/'],
    },
    (site) => {
      const leaksOf = (p: PageData) =>
        VERSION_HEADERS.map((h) => [h, header(p, h)] as const)
          .filter(([, v]) => v && /\d+\.\d+/.test(v))
          .map(([h, v]) => `${h}: ${v}`);
      const pages = samplePages(site, Infinity);
      const leaking = pages.map((p) => ({ p, leaks: leaksOf(p) })).filter((x) => x.leaks.length);
      if (!leaking.length) return null;
      // The same leak on every page is one server-wide setting: report it once.
      const first = leaking[0]!.leaks.join(' | ');
      if (leaking.length === pages.length && leaking.every((x) => x.leaks.join(' | ') === first))
        return {
          checkId: 'security.version-disclosure',
          url: leaking[0]!.p.url,
          message: `${plural(leaking[0]!.leaks.length, 'header')} reveal software versions on every page`,
          evidence: list(leaking[0]!.leaks),
        };
      return leaking.slice(0, HEADER_PAGE_REPORT_LIMIT).map(({ p, leaks }) => ({
        checkId: 'security.version-disclosure',
        url: p.url,
        message: `${plural(leaks.length, 'header')} reveal software versions`,
        evidence: list(leaks),
      }));
    },
  ),
  siteCheck(
    {
      id: 'security.security-txt-invalid',
      category: 'security',
      pillar: T,
      title: 'security.txt is missing required fields',
      why: 'RFC 9116 requires at least one Contact and exactly one Expires field. Researchers and automated tools ignore a security.txt without them, or one that has expired, so vulnerability reports may never reach you.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Serve /.well-known/security.txt as text/plain with "Contact: mailto:…" (or an https URL) and "Expires: <date-time less than a year ahead, e.g. 2027-06-30T23:00:00Z>", and renew Expires before it passes.',
      refs: ['https://www.rfc-editor.org/rfc/rfc9116', 'https://securitytxt.org/'],
    },
    (site) => {
      const p = site.probes?.get('security-txt');
      if (!p?.found || !p.body) return null;
      const problems = securityTxtProblems(p.body, Date.now());
      return problems.length
        ? {
            checkId: 'security.security-txt-invalid',
            message: `security.txt: ${list(problems, 4)}`,
            evidence: truncate(p.body, 300),
            data: { url: p.url, problems },
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'security.exposed-files',
      category: 'security',
      pillar: T,
      title: 'Sensitive files are publicly readable',
      why: 'An exposed .git folder or .env file can reveal source code, passwords and API keys. Automated scanners look for these constantly.',
      severity: 'critical',
      fixTier: 'guided',
      fix: 'Block access to dotfiles at the server or CDN (deny /\\.(git|env)), remove the files from the web root and rotate any secrets they contained.',
      refs: ['https://owasp.org/www-project-web-security-testing-guide/'],
    },
    async (site) => {
      const found: string[] = [];
      const git = await probe(site, '/.git/HEAD');
      if (git && git.status === 200 && /^ref:\s*refs\//.test(git.body.trim()))
        found.push('/.git/HEAD');
      const env = await probe(site, '/.env');
      if (
        env &&
        env.status === 200 &&
        !/<html|<!doctype/i.test(env.body.slice(0, 500)) &&
        /^[A-Z][A-Z0-9_]+=.+$/m.test(env.body)
      )
        found.push('/.env');
      return found.length
        ? { checkId: 'security.exposed-files', message: `${list(found)} can be downloaded` }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'security.http-pages',
      category: 'security',
      pillar: T,
      title: 'Some pages still served over HTTP',
      why: 'On an HTTPS site, internal pages that load over http:// are duplicates and show browser warnings.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Redirect all http:// URLs to https:// and update internal links.',
      refs: [REF.https],
    },
    (site) => {
      if (!isHttpsSite(site)) return null;
      const http = htmlPages(site).filter(
        (p) =>
          p.finalUrl.startsWith('http:') &&
          safeUrl(p.finalUrl)?.hostname.replace(/^www\./, '') === site.host.replace(/^www\./, ''),
      );
      return http.length
        ? {
            checkId: 'security.http-pages',
            message: `${plural(http.length, 'page')} served over HTTP`,
            evidence: list(
              http.map((p) => p.url),
              4,
            ),
          }
        : null;
    },
  ),
];

// ---------------------------------------------------------------------------
// Added for feature parity: TLS certificate health
// ---------------------------------------------------------------------------

export const TLS_WARN_DAYS = 21;

const TLS_REF = 'https://developers.google.com/search/docs/crawling-indexing/https';

checks.push(
  cu.siteCheck(
    {
      id: 'security.tls-expired',
      category: 'security',
      pillar: T,
      title: 'TLS certificate has expired',
      why: 'Browsers show a full-page security warning for an expired certificate, most visitors leave, and crawlers may stop fetching the site. AI agents and search bots treat it as an error.',
      severity: 'critical',
      fixTier: 'guided',
      fix: 'Renew the certificate now (or fix the automatic renewal of your Let’s Encrypt / host certificate) and reload the web server.',
      refs: [TLS_REF],
    },
    (site) => {
      const t = site.tls;
      if (!t?.validTo || t.daysLeft === undefined || t.daysLeft >= 0) return null;
      return {
        checkId: 'security.tls-expired',
        message: `The certificate for ${t.host} expired on ${t.validTo.slice(0, 10)}`,
        evidence: [t.issuer, t.subject].filter(Boolean).join(' | '),
      };
    },
  ),
  cu.siteCheck(
    {
      id: 'security.tls-expiring',
      category: 'security',
      pillar: T,
      title: 'TLS certificate expires soon',
      why: 'When the certificate runs out, the whole site shows a security warning. Automatic renewal usually happens about 30 days before expiry, so a certificate this close to the end suggests renewal is failing.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Check the automatic renewal (certbot, your host or CDN dashboard) and renew now. Add a monitor for certificate expiry.',
      refs: [TLS_REF],
    },
    (site) => {
      const t = site.tls;
      if (!t?.validTo || t.daysLeft === undefined) return null;
      if (t.daysLeft < 0 || t.daysLeft > TLS_WARN_DAYS) return null;
      return {
        checkId: 'security.tls-expiring',
        severity: t.daysLeft <= 7 ? 'critical' : 'high',
        message: `The certificate for ${t.host} expires in ${cu.plural(t.daysLeft, 'day')} (${t.validTo.slice(0, 10)})`,
        evidence: t.issuer ?? '',
      };
    },
  ),
  cu.siteCheck(
    {
      id: 'security.tls-invalid',
      category: 'security',
      pillar: T,
      title: 'Browsers do not trust the TLS certificate',
      why: 'A certificate for the wrong host name, a self-signed certificate or a missing intermediate certificate makes browsers, crawlers and AI agents refuse the connection or warn visitors.',
      severity: 'critical',
      fixTier: 'guided',
      fix: 'Install a certificate that covers this host name, with the full chain (leaf plus intermediates). SSL Labs’ server test shows exactly what is wrong.',
      refs: [TLS_REF, 'https://www.ssllabs.com/ssltest/'],
    },
    (site) => {
      const t = site.tls;
      // Only judge a certificate we actually received; connection failures are inconclusive.
      if (!t?.validTo || t.authorized || (t.daysLeft !== undefined && t.daysLeft < 0)) return null;
      return {
        checkId: 'security.tls-invalid',
        message: `The certificate for ${t.host} is not trusted: ${t.error ?? 'unknown reason'}`,
        evidence: [t.subject, t.issuer, (t.altNames ?? []).slice(0, 5).join(', ')]
          .filter(Boolean)
          .join(' | '),
      };
    },
  ),
);
