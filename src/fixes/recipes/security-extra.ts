/**
 * Security recipes beyond response headers and HTTPS: exposed files, directory listing,
 * version disclosure, cookie flags, debug output, Subresource Integrity and
 * protocol-relative URLs. Most of these are web-server settings, so each recipe carries
 * nginx, Apache, Vercel, Netlify and Cloudflare variants.
 */
import { byStack, templateFile } from '../stacks.js';
import type { Recipe, RecipeInput, StackFix } from '../types.js';
import { evidenceStep, noServerAccess, serverFix, urlsBlock, verifyStep } from './common.js';

function hostedNote(input: RecipeInput, what: string): StackFix {
  return {
    steps: [
      `${what} is controlled by the platform here; you cannot change the server. If the finding persists, report it to the platform’s support with the evidence below.`,
      'If the domain is proxied through Cloudflare, a Transform Rule or WAF rule can cover it at the edge.',
    ],
    files: ['Platform support', 'Cloudflare rules (if proxied)'],
  };
}

// ---------------------------------------------------------------------------
// Exposed files and directory listing
// ---------------------------------------------------------------------------

const exposedFiles: Recipe = {
  id: 'exposed-files',
  patterns: [/^security\.exposed-files$/],
  impact: 'high',
  effort: 'minutes',
  build(input) {
    const rules = serverFix(
      input,
      {
        nginx: `# deny dotfiles (.git, .env, .htpasswd …) but keep /.well-known
location ~ /\\.(?!well-known/) {
    deny all;
    return 404;
}
# common backups and dumps
location ~* \\.(sql|bak|old|orig|swp|log|ini|env)$ { deny all; return 404; }`,
        apache: `# .htaccess (Apache 2.4)
RedirectMatch 404 /\\.(?!well-known/)
<FilesMatch "\\.(sql|bak|old|orig|swp|log|ini|env)$">
  Require all denied
</FilesMatch>`,
        vercel: `// Vercel serves only the build output: delete the files from public/ (or the output dir),
// add them to .gitignore / .vercelignore, then redeploy.
// .vercelignore
.env*
*.sql
*.bak`,
        netlify: `# Netlify serves only the publish directory: remove the files from it and redeploy.
# netlify.toml — belt and braces
[[redirects]]
  from = "/.env"
  to = "/404"
  status = 404
  force = true`,
        cloudflare: `Security → WAF → Custom rules → Create rule
  If: (http.request.uri.path matches "^/\\.(git|env|svn|hg|DS_Store|htpasswd)")
      or (http.request.uri.path matches "\\.(sql|bak|old|orig|swp)$")
  Then: Block`,
      },
      [
        'Treat this as urgent: automated scanners request /.git/config and /.env constantly.',
        '1. Rotate every secret the files contained (database passwords, API keys, mail and payment credentials) — assume they are already copied.',
        '2. Remove the files from the web root. Deploy from a build step or `git archive`, not by cloning the repository into the served folder.',
        '3. Block dotfiles and backup files at the server or CDN so a future mistake is not exposed.',
      ],
    );
    return {
      ...rules,
      title: 'Remove and block publicly readable sensitive files',
      steps: [
        ...evidenceStep(input),
        ...rules.steps,
        ...(input.stack.id === 'wordpress'
          ? [
              'WordPress: also remove `wp-config.php.bak`, `debug.log` in wp-content and database dumps left by backup plugins in the web root; keep backups off-server.',
            ]
          : []),
        `Check: \`curl -s -o /dev/null -w "%{http_code}" ${input.origin}/.env\` and \`${input.origin}/.git/config\` must return 403 or 404.`,
        verifyStep(input),
      ],
      acceptance: ['Requests for /.git/config, /.env and backup files return 403 or 404'],
    };
  },
};

const directoryListing: Recipe = {
  id: 'directory-listing',
  patterns: [/^security\.directory-listing$/],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    const rules = noServerAccess(input)
      ? hostedNote(input, 'Directory listing')
      : serverFix(
          input,
          {
            nginx: `# nginx: autoindex is off by default; remove any "autoindex on;"
autoindex off;`,
            apache: `# .htaccess (or the vhost <Directory> block)
Options -Indexes`,
            vercel: `// Vercel never lists directories. A listing here means a page in your build renders one
// (e.g. a "serve-index" middleware or a static export of a folder index). Remove it.`,
            netlify:
              '# Netlify never lists directories. A listing means your build output contains a generated index page: remove it.',
            cloudflare: `Cloudflare cannot switch listing off at the origin. As a stopgap, block folder URLs:
Security → WAF → Custom rules
  If: (starts_with(http.request.uri.path, "/uploads/") and ends_with(http.request.uri.path, "/"))
  Then: Block`,
          },
          [
            'Turn off automatic directory indexes on the web server, and add an empty `index.html` to folders that must stay reachable.',
          ],
        );
    return {
      ...rules,
      title: 'Turn off directory listing',
      steps: [
        'An “Index of /” page exposes every file in the folder, including backups and files you never linked.',
        ...evidenceStep(input),
        ...rules.steps,
        ...(input.stack.id === 'wordpress'
          ? [
              'WordPress: the usual folders are /wp-content/uploads/ and /wp-content/plugins/. Most security plugins (Wordfence, Solid Security) have a “disable directory browsing” switch that writes `Options -Indexes`.',
            ]
          : []),
        ...urlsBlock(input),
        verifyStep(input),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Version disclosure
// ---------------------------------------------------------------------------

const versionDisclosure: Recipe = {
  id: 'version-disclosure',
  patterns: [/^security\.version-disclosure$/],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    const app = byStack(input, {
      nextjs: () => ({
        steps: [
          'Next.js: set `poweredByHeader: false` in `next.config.ts` to drop `X-Powered-By: Next.js`.',
        ],
        files: ['next.config.ts'],
        snippet: {
          language: 'ts',
          code: 'const nextConfig: NextConfig = { poweredByHeader: false };',
        },
      }),
      wordpress: () => ({
        steps: [
          'PHP: set `expose_php = Off` in php.ini (or ask the host; many control panels have a PHP settings page) to drop `X-Powered-By: PHP/x.y`.',
        ],
        files: ['php.ini / host PHP settings'],
      }),
      unknown: () => ({
        steps: [
          'Application frameworks: Express `app.disable("x-powered-by")`; PHP `expose_php = Off`; ASP.NET `<httpRuntime enableVersionHeader="false" />` and remove X-AspNet-Version.',
        ],
        files: ['app server config'],
      }),
    });
    const rules = noServerAccess(input)
      ? hostedNote(input, 'The Server header')
      : serverFix(input, {
          nginx: `# http block
server_tokens off;
# with headers-more: more_clear_headers Server X-Powered-By;
proxy_hide_header X-Powered-By;
fastcgi_hide_header X-Powered-By;`,
          apache: `# httpd.conf / apache2.conf (not .htaccess)
ServerTokens Prod
ServerSignature Off
# .htaccess
<IfModule mod_headers.c>
  Header always unset X-Powered-By
</IfModule>`,
          cloudflare: `Rules → Transform Rules → Modify Response Header
  Remove: X-Powered-By
  Remove: X-AspNet-Version`,
          netlify: `[[headers]]\n  for = "/*"\n  [headers.values]\n    X-Powered-By = ""`,
        });
    return {
      title: 'Hide server software versions',
      steps: [
        'Headers such as `Server: Apache/2.4.29` or `X-Powered-By: PHP/7.2` tell attackers which known vulnerabilities to try. Hide the versions — and keep the software updated, which matters more.',
        ...evidenceStep(input),
        ...app.steps,
        ...rules.steps,
        `Check: \`curl -sI ${input.origin} | grep -iE "^(server|x-powered-by)"\` should show no version numbers.`,
      ],
      files: [...new Set([...app.files, ...rules.files])],
      snippet: rules.snippet ?? app.snippet,
    };
  },
};

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

const cookies: Recipe = {
  id: 'cookie-flags',
  patterns: [/^security\.cookie-not-(secure|httponly)$/],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const httpOnly = input.def.id.endsWith('httponly');
    const names = input.issues
      .flatMap((i) => (i.evidence ?? '').match(/\b[\w.-]+(?==)/g) ?? [])
      .slice(0, 5);
    const app = byStack(input, {
      nextjs: () => ({
        steps: [
          'Set the flags where the cookie is created: `cookies().set()` in Server Actions/route handlers, `NextResponse.cookies.set()` in `proxy.ts`, or your auth library’s cookie options (Auth.js sets them correctly by default on HTTPS).',
        ],
        files: ['app/**/route.ts', 'app/actions/*.ts', 'proxy.ts', 'auth config'],
        snippet: {
          language: 'ts',
          code: `import { cookies } from 'next/headers';

(await cookies()).set('session', token, {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 60 * 60 * 24 * 7,
});`,
        },
      }),
      wordpress: () => ({
        steps: [
          "WordPress login cookies are HttpOnly and get Secure when the site URL is https:// — check Settings → General uses https for both addresses, and add `define('FORCE_SSL_ADMIN', true);` to wp-config.php.",
          'PHP session cookies (set by plugins): set `session.cookie_secure = 1`, `session.cookie_httponly = 1` and `session.cookie_samesite = "Lax"` in php.ini or the host’s PHP settings.',
          'Other cookies come from plugins (forms, carts, consent tools): update them, or flag them at the server (below).',
        ],
        files: ['wp-config.php', 'php.ini / host PHP settings'],
        snippet: {
          language: 'ini',
          code: '; php.ini\nsession.cookie_secure = 1\nsession.cookie_httponly = 1\nsession.cookie_samesite = "Lax"',
        },
      }),
      shopify: () => ({
        steps: [
          'Shopify sets its own cookies with the right flags. Cookies without them come from apps or theme scripts that write `document.cookie`: find the app (the cookie name usually gives it away) and ask its developer, or remove it.',
        ],
        files: ['Shopify apps', 'theme scripts'],
      }),
      hosted: () => ({
        steps: [
          'Platform cookies are set by the platform. Cookies without flags usually come from embedded third-party scripts; check which script sets them and update or remove it.',
        ],
        files: ['Custom code embeds'],
      }),
      unknown: () => ({
        steps: [
          'Set the flags where the application creates the cookie — e.g. Express `res.cookie(name, value, { secure: true, httpOnly: true, sameSite: "lax" })`, PHP `session.cookie_secure`/`session.cookie_httponly`, Django `SESSION_COOKIE_SECURE = True`.',
        ],
        files: ['application cookie / session config'],
      }),
    });
    const edge = noServerAccess(input)
      ? null
      : serverFix(input, {
          nginx: `# nginx 1.19.3+: add flags to cookies from the upstream app
proxy_cookie_flags ~ secure${httpOnly ? ' httponly' : ''} samesite=lax;`,
          apache: `# Apache (mod_headers): add flags to every Set-Cookie
Header always edit Set-Cookie ^(.*)$ "$1; Secure${httpOnly ? '; HttpOnly' : ''}; SameSite=Lax"`,
        });
    return {
      title: httpOnly ? 'Mark session cookies HttpOnly' : 'Mark cookies Secure',
      steps: [
        httpOnly
          ? 'Session and authentication cookies must carry `HttpOnly`, so injected scripts cannot read them. Leave it off only for cookies your own JavaScript needs to read (consent state, UI preferences) — never for sessions.'
          : 'Every cookie on an HTTPS site should carry `Secure`, so it is never sent over plain HTTP. Browsers reject `SameSite=None` cookies without it.',
        ...(names.length ? [`Cookies flagged: ${names.join(', ')}.`] : evidenceStep(input)),
        ...app.steps,
        ...(edge
          ? [
              'If you cannot change the code that sets them, add the flags at the server:',
              ...edge.steps,
            ]
          : []),
        `Check in DevTools → Application → Cookies, or \`curl -sI ${input.urls[0] ?? input.origin} | grep -i set-cookie\`.`,
      ],
      files: [...new Set([...app.files, ...(edge?.files ?? [])])],
      snippet: app.snippet ?? edge?.snippet,
    };
  },
};

// ---------------------------------------------------------------------------
// Debug output
// ---------------------------------------------------------------------------

const debugOutput: Recipe = {
  id: 'debug-output',
  patterns: [/^security\.debug-output$/],
  impact: 'high',
  effort: 'hours',
  build(input) {
    const fix = byStack(input, {
      nextjs: () => ({
        steps: [
          'Make sure production runs `next build` + `next start` (or your host’s production build), never `next dev`.',
          'Do not render `error.message` or stack traces in `error.tsx` / API responses; log them on the server and show a generic message.',
        ],
        files: ['app/error.tsx', 'app/**/route.ts'],
        snippet: {
          language: 'tsx',
          code: `'use client';
// app/error.tsx
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <p>Please try again. Reference: {error.digest}</p>
      <button onClick={reset}>Try again</button>
    </main>
  );
}`,
        },
      }),
      wordpress: () => ({
        steps: [
          'In wp-config.php, keep errors in a log, not on the page (below). Then fix the warning itself — usually an outdated plugin or theme on a newer PHP version.',
          'Check the host’s PHP settings for `display_errors = On` as well.',
        ],
        files: ['wp-config.php', 'host PHP settings'],
        snippet: {
          language: 'php',
          code: "// wp-config.php\ndefine('WP_DEBUG', false);          // or true with the two lines below while investigating\ndefine('WP_DEBUG_LOG', true);       // writes wp-content/debug.log (block it from the web)\ndefine('WP_DEBUG_DISPLAY', false);\n@ini_set('display_errors', '0');",
        },
      }),
      unknown: () => ({
        steps: [
          'Turn off error display in production and log instead: PHP `display_errors = Off`, Laravel `APP_DEBUG=false`, Django `DEBUG = False`, Rails `config.consider_all_requests_local = false`, Node `NODE_ENV=production`.',
          'Then fix the error that produced the output.',
        ],
        files: ['php.ini / .env / settings.py'],
        snippet: {
          language: 'ini',
          code: '; php.ini (production)\ndisplay_errors = Off\nlog_errors = On',
        },
      }),
    });
    return {
      ...fix,
      title: 'Hide errors and debug output in production',
      steps: [
        'PHP warnings, stack traces and debug dumps leak file paths and versions, and crawlers index them as page content.',
        ...evidenceStep(input),
        ...fix.steps,
        'Purge the page cache afterwards so cached copies with the error text are gone.',
        ...urlsBlock(input),
        verifyStep(input),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Subresource Integrity and protocol-relative URLs
// ---------------------------------------------------------------------------

const sri: Recipe = {
  id: 'sri',
  patterns: [/^security\.sri-missing$/],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    const src =
      input.issues
        .map((i) => /https?:\/\/[^\s"'|]+\.(?:js|css)\b[^\s"'|]*/.exec(i.evidence ?? '')?.[0])
        .find(Boolean) ?? 'https://cdn.jsdelivr.net/npm/library@1.2.3/dist/library.min.js';
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Best: install the library from npm and import it, so it is bundled and served from your own domain.',
          'If it must come from the CDN, pass `integrity` and `crossOrigin` to `next/script` (pinned version only).',
        ],
        files: ['package.json', 'app/layout.tsx'],
        snippet: {
          language: 'tsx',
          code: `<Script\n  src="${src}"\n  integrity="sha384-…"\n  crossOrigin="anonymous"\n  strategy="afterInteractive"\n/>`,
        },
      }),
      wordpress: () => ({
        steps: [
          'Scripts enqueued from a CDN by the theme or a plugin can get integrity attributes through the `script_loader_tag` filter (below). Many plugins load CDN copies optionally: switching them to a local copy is simpler.',
        ],
        files: ['functions.php (child theme)'],
        snippet: {
          language: 'php',
          code: `add_filter('script_loader_tag', function ($tag, $handle) {
  $sri = [ 'library' => 'sha384-…' ]; // handle => hash
  if (isset($sri[$handle])) {
    $tag = str_replace(' src=', ' integrity="' . $sri[$handle] . '" crossorigin="anonymous" src=', $tag);
  }
  return $tag;
}, 10, 2);`,
        },
      }),
      unknown: () => ({
        steps: ['Add the attributes to each pinned CDN script and stylesheet:'],
        files: [templateFile(input)],
        snippet: {
          language: 'html',
          code: `<script src="${src}"\n        integrity="sha384-…" crossorigin="anonymous"></script>`,
        },
      }),
    });
    return {
      ...fix,
      title: 'Add Subresource Integrity to CDN scripts',
      steps: [
        'If a public CDN file is tampered with, every site loading it runs the attacker’s code. An `integrity` hash makes the browser refuse a changed file. Use it only for URLs pinned to an exact version (a “latest” URL changes and would break).',
        `Get the hash: \`curl -s ${src} | openssl dgst -sha384 -binary | openssl base64 -A\` (prefix it with \`sha384-\`), or copy it from the CDN’s “copy HTML + SRI” button.`,
        ...evidenceStep(input),
        ...fix.steps,
        'Scripts that change by design (Google Tag Manager, analytics, chat widgets) cannot use SRI; that is expected.',
        verifyStep(input),
      ],
    };
  },
};

const protocolRelative: Recipe = {
  id: 'protocol-relative',
  patterns: [/^security\.protocol-relative$/],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    const fix = byStack(input, {
      wordpress: () => ({
        steps: [
          'Search-replace `src="//` and `href="//` in the database with WP-CLI (dry run first), and check theme files for hard-coded `//` URLs.',
        ],
        files: ['WordPress database', 'theme files'],
        snippet: {
          language: 'bash',
          code: "wp search-replace 'src=\"//' 'src=\"https://' --all-tables --precise --dry-run",
        },
      }),
      shopify: () => ({
        steps: [
          'Search the theme code for `"//` (Edit code → search). Liquid filters such as `asset_url` already output protocol-relative URLs; those are fine on Shopify, which is HTTPS-only. Fix hard-coded third-party URLs.',
        ],
        files: ['layout/theme.liquid', 'sections/*.liquid'],
      }),
      unknown: () => ({
        steps: ['Replace `//host/file` with `https://host/file` in templates and content:'],
        files: [templateFile(input)],
        snippet: {
          language: 'bash',
          code: `grep -rnE '(src|href)="//' src public content\n# then replace with https://`,
        },
      }),
    });
    return {
      ...fix,
      title: 'Use explicit https:// resource URLs',
      steps: [
        '`//host/file.js` inherits the page protocol. Harmless on an HTTPS-only site, but outdated; write `https://` explicitly.',
        ...evidenceStep(input),
        ...fix.steps,
        ...urlsBlock(input),
      ],
    };
  },
};

export const recipes: Recipe[] = [
  exposedFiles,
  directoryListing,
  versionDisclosure,
  cookies,
  debugOutput,
  sri,
  protocolRelative,
];
