/**
 * CMS-specific recipes: WordPress hardening and index hygiene, Shopify auto-generated
 * collections, and platform defaults. Server-level variants (nginx, Apache, Cloudflare)
 * are given where the WordPress setting can also be enforced at the server.
 */
import { byStack, seoPluginLabel, templateFile, wpPlugin } from '../stacks.js';
import type { Recipe, RecipeInput, StackFix } from '../types.js';
import { evidenceStep, serverFix, urlsBlock, verifyStep } from './common.js';

function phpSnippet(code: string): StackFix['snippet'] {
  return { language: 'php', code };
}

/** SEO-plugin specific path to a setting. */
function seoSetting(input: RecipeInput, yoast: string, rankMath: string, aioseo: string): string {
  const p = wpPlugin(input.stack);
  return p === 'yoast'
    ? `Yoast SEO → ${yoast}`
    : p === 'rank-math'
      ? `Rank Math → ${rankMath}`
      : p === 'aioseo'
        ? `All in One SEO → ${aioseo}`
        : `your SEO plugin (Yoast: ${yoast}; Rank Math: ${rankMath})`;
}

// ---------------------------------------------------------------------------
// WordPress hardening
// ---------------------------------------------------------------------------

const wpHardening: Recipe = {
  id: 'wp-hardening',
  patterns: [
    /^cms\.wp-(version-exposed|readme-exposed|xmlrpc-enabled|user-enumeration|rest-users-exposed)$/,
  ],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    const id = input.def.id.replace('cms.wp-', '');
    let title = input.def.title;
    let lead = '';
    let php = '';
    let rules: Parameters<typeof serverFix>[1] = {};
    switch (id) {
      case 'version-exposed':
        title = 'Stop publishing the WordPress version';
        lead =
          'The generator meta tag and `?ver=` query strings reveal the exact WordPress version. Hide them — and, more importantly, keep WordPress updated.';
        php = `// functions.php (child theme) or a small mu-plugin
remove_action('wp_head', 'wp_generator');
add_filter('the_generator', '__return_empty_string');
// strip ?ver=<wp version> from core assets
add_filter('style_loader_src', 'avc_strip_wp_ver', 9999);
add_filter('script_loader_src', 'avc_strip_wp_ver', 9999);
function avc_strip_wp_ver($src) {
  return strpos($src, 'ver=' . get_bloginfo('version')) ? remove_query_arg('ver', $src) : $src;
}`;
        break;
      case 'readme-exposed':
        title = 'Remove or block readme.html';
        lead =
          'readme.html (and license.txt) confirm the site runs WordPress. Delete them from the web root; because updates restore them, also block them at the server.';
        rules = {
          nginx:
            'location ~* ^/(readme\\.html|license\\.txt|wp-config-sample\\.php)$ { deny all; return 404; }',
          apache:
            '# .htaccess\n<FilesMatch "^(readme\\.html|license\\.txt|wp-config-sample\\.php)$">\n  Require all denied\n</FilesMatch>',
          cloudflare:
            'Security → WAF → Custom rules\n  If: (http.request.uri.path in {"/readme.html" "/license.txt"})\n  Then: Block',
        };
        break;
      case 'xmlrpc-enabled':
        title = 'Disable XML-RPC';
        lead =
          'xmlrpc.php is a common target for password guessing and DDoS amplification. Disable it unless Jetpack or the WordPress mobile app needs it (Jetpack can be allowed by IP).';
        php = "// mu-plugin or functions.php\nadd_filter('xmlrpc_enabled', '__return_false');";
        rules = {
          nginx: 'location = /xmlrpc.php { deny all; return 403; }',
          apache: '# .htaccess\n<Files "xmlrpc.php">\n  Require all denied\n</Files>',
          cloudflare:
            'Security → WAF → Custom rules\n  If: (http.request.uri.path eq "/xmlrpc.php")\n  Then: Block',
        };
        break;
      case 'user-enumeration':
        title = 'Block username discovery through ?author=';
        lead =
          '`/?author=1` redirects to `/author/<username>/`, giving away half a login. Block `?author=` for visitors who are not logged in, and set display names (Users → Profile → “Display name publicly as”) that differ from usernames.';
        php = `// mu-plugin or functions.php
add_action('template_redirect', function () {
  if (!is_user_logged_in() && isset($_GET['author'])) {
    wp_safe_redirect(home_url('/'), 301);
    exit;
  }
});`;
        rules = {
          nginx: 'if ($args ~* "(^|&)author=\\d+") { return 403; }',
          apache:
            '# .htaccess\nRewriteEngine On\nRewriteCond %{QUERY_STRING} (^|&)author=\\d+ [NC]\nRewriteRule ^ - [F,L]',
          cloudflare:
            'Security → WAF → Custom rules\n  If: (http.request.uri.query contains "author=")\n  Then: Block',
        };
        break;
      default:
        title = 'Restrict the REST API users endpoint';
        lead =
          '`/wp-json/wp/v2/users` lists the usernames (slugs) of everyone who has published. Restrict it to logged-in users. Most security plugins have a switch; the filter below does the same.';
        php = `// mu-plugin or functions.php
add_filter('rest_endpoints', function ($endpoints) {
  if (!is_user_logged_in()) {
    unset($endpoints['/wp/v2/users'], $endpoints['/wp/v2/users/(?P<id>[\\\\d]+)']);
  }
  return $endpoints;
});`;
    }
    const server = Object.keys(rules).length ? serverFix(input, rules) : null;
    return {
      title,
      steps: [
        lead,
        ...evidenceStep(input),
        'Security plugins (Wordfence, Solid Security, All-In-One WP Security, Perfmatters) have a switch for this — use it if one is installed.',
        ...(php
          ? [
              'Or add the code below to a must-use plugin (`wp-content/mu-plugins/avc-hardening.php`) so a theme change does not undo it.',
            ]
          : []),
        ...(server ? ['At the server level instead:', ...server.steps] : []),
        verifyStep(input),
      ],
      files: [
        ...(php ? ['wp-content/mu-plugins/avc-hardening.php'] : []),
        ...(server?.files ?? []),
        'WordPress: security plugin',
      ],
      snippet: php ? phpSnippet(php) : server?.snippet,
    };
  },
};

// ---------------------------------------------------------------------------
// WordPress index hygiene
// ---------------------------------------------------------------------------

const wpIndex: Recipe = {
  id: 'wp-index-hygiene',
  patterns: [/^cms\.wp-(attachment-page|thin-archive|replytocom|comment-pages)$/],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    const id = input.def.id.replace('cms.wp-', '');
    let title = input.def.title;
    let steps: string[] = [];
    let php = '';
    switch (id) {
      case 'attachment-page':
        title = 'Redirect media attachment pages';
        steps = [
          'WordPress creates a thin page for every uploaded file. Redirect them to the file or parent post.',
          `Set it in ${seoSetting(input, 'Settings → Advanced → Media pages → off', 'Titles & Meta → Misc Pages / General Settings → Links → “Redirect attachments”', 'Search Appearance → Image SEO / Media → “Redirect attachment URLs”')}.`,
          'WordPress 6.4+ has the option `wp_attachment_pages_enabled`; on older sites set it to 0 with the code below.',
        ];
        php =
          "// one-off: run once with WP-CLI\n// wp option update wp_attachment_pages_enabled 0\n\n// or in a mu-plugin\nadd_action('template_redirect', function () {\n  if (is_attachment()) {\n    $parent = wp_get_post_parent_id(get_the_ID());\n    wp_safe_redirect($parent ? get_permalink($parent) : wp_get_attachment_url(get_the_ID()), 301);\n    exit;\n  }\n});";
        break;
      case 'thin-archive':
        title = 'Noindex thin tag, date and author archives';
        steps = [
          `Noindex tag archives, date archives and (on single-author sites) author archives in ${seoSetting(input, 'Settings → Content types / Taxonomies / Advanced → Author & Date archives', 'Titles & Meta → Tags / Misc Pages', 'Search Appearance → Taxonomies / Archives')}.`,
          'Keep category archives indexable only where they have a written introduction and enough posts to be useful.',
          'Merge tags used once or twice into broader ones (Posts → Tags), and 301 the old tag URLs.',
        ];
        break;
      case 'replytocom':
        title = 'Remove ?replytocom= duplicate URLs';
        steps = [
          'Every comment “Reply” link without JavaScript creates a crawlable `?replytocom=` copy of the post.',
          `Yoast removes them (Settings → Advanced → Crawl optimisation → “Remove replytocom variables”); otherwise use the filter below. Settings → Discussion → threaded comments must stay on for the JavaScript reply form to work.`,
          'Add `Disallow: /*?replytocom=` to robots.txt only after the URLs have dropped out of the index.',
        ];
        php =
          "// mu-plugin: make reply links JavaScript-only\nadd_filter('comment_reply_link', function ($link) {\n  return preg_replace('/href=\\'[^\\']*replytocom=[^\\']*\\'/', \"href='#respond'\", $link);\n});";
        break;
      default:
        title = 'Stop indexing paginated comment pages';
        steps = [
          'Settings → Discussion: untick “Break comments into pages” so all comments stay on the post.',
          `If you must paginate, make sure /comment-page-N/ URLs canonicalise to the post (${seoPluginLabel(input.stack)} does this by default) or noindex them.`,
        ];
    }
    return {
      title,
      steps: [...steps, ...evidenceStep(input), ...urlsBlock(input, 5), verifyStep(input)],
      files: [
        'WordPress: SEO plugin settings',
        'Settings → Discussion',
        ...(php ? ['wp-content/mu-plugins/'] : []),
      ],
      ...(php ? { snippet: phpSnippet(php) } : {}),
    };
  },
};

const wpPerformance: Recipe = {
  id: 'wp-performance',
  patterns: [/^cms\.wp-(emoji-script|many-plugins)$/],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    const emoji = input.def.id.endsWith('emoji-script');
    return emoji
      ? {
          title: 'Remove the WordPress emoji script',
          steps: [
            '`wp-emoji-release.min.js` adds a request and inline script on every page to support emoji in very old browsers.',
            'Performance plugins (Perfmatters, WP Rocket, Autoptimize, LiteSpeed Cache) have a “disable emojis” switch; or add the code below as a must-use plugin.',
            verifyStep(input),
          ],
          files: ['wp-content/mu-plugins/avc-no-emoji.php', 'performance plugin'],
          snippet: phpSnippet(`<?php
// wp-content/mu-plugins/avc-no-emoji.php
remove_action('wp_head', 'print_emoji_detection_script', 7);
remove_action('admin_print_scripts', 'print_emoji_detection_script');
remove_action('wp_print_styles', 'print_emoji_styles');
remove_action('admin_print_styles', 'print_emoji_styles');
remove_filter('the_content_feed', 'wp_staticize_emoji');
remove_filter('comment_text_rss', 'wp_staticize_emoji');
remove_filter('wp_mail', 'wp_staticize_emoji_for_email');
add_filter('emoji_svg_url', '__return_false');`),
        }
      : {
          title: 'Load plugin assets only where they are used',
          steps: [
            'Assets from many plugins load on this page. List them: view source and group the `/wp-content/plugins/<name>/` URLs by plugin.',
            'Deactivate and delete plugins nobody uses (Plugins → Installed; check “last used” with the site owner).',
            'For the rest, unload assets on pages that do not need them with an asset manager (Perfmatters Script Manager, Asset CleanUp, WP Rocket’s “Remove unused CSS”), or with `wp_dequeue_script` (below).',
            'Measure before and after with PageSpeed Insights on the same URL.',
            ...urlsBlock(input, 5),
          ],
          files: [
            'Plugins → Installed plugins',
            'asset manager plugin',
            'functions.php (child theme)',
          ],
          snippet:
            phpSnippet(`// functions.php: e.g. load Contact Form 7 assets only on the contact page
add_action('wp_enqueue_scripts', function () {
  if (!is_page('contact')) {
    wp_dequeue_script('contact-form-7');
    wp_dequeue_style('contact-form-7');
  }
}, 100);`),
        };
  },
};

const wpContent: Recipe = {
  id: 'wp-content-cleanup',
  patterns: [/^cms\.wp-(uncategorized|default-content)$/],
  impact: 'low',
  effort: 'minutes',
  tier: 'manual',
  build(input) {
    const uncategorized = input.def.id.endsWith('uncategorized');
    return {
      title: uncategorized
        ? 'Replace the “Uncategorized” category'
        : 'Remove WordPress sample content',
      steps: uncategorized
        ? [
            'Posts → Categories: rename “Uncategorized” to a real topic (and change its slug), or create proper categories and move the posts into them (bulk edit on Posts → All posts).',
            'Settings → Writing → Default post category: set a real category so new posts do not land in Uncategorized.',
            `If the empty archive remains, noindex it in ${seoPluginLabel(input.stack)} or 301 it to the blog.`,
            ...urlsBlock(input, 5),
          ]
        : [
            'Delete the “Hello world!” post and “Sample Page” (Posts / Pages → Trash, then empty the trash), and 301 their URLs if they were ever indexed.',
            'Settings → General → Tagline: replace “Just another WordPress site” with a short description of the business (or leave it empty).',
            'Delete the default “A WordPress Commenter” comment.',
            ...evidenceStep(input),
          ],
      files: uncategorized
        ? ['Posts → Categories', 'Settings → Writing']
        : ['Posts / Pages', 'Settings → General'],
    };
  },
};

const wpSeoConflict: Recipe = {
  id: 'wp-seo-plugin-conflict',
  patterns: [/^cms\.wp-seo-plugin-conflict$/],
  impact: 'high',
  effort: 'hours',
  build(input) {
    return {
      title: 'Keep one SEO plugin',
      steps: [
        'Two SEO plugins are printing titles, canonicals and schema on the same page, so search engines get contradicting tags.',
        ...evidenceStep(input),
        'Pick the one you keep. Use its import tool to bring over titles, descriptions and redirects from the other (Rank Math → Status & Tools → Import & Export; AIOSEO → Tools → Import/Export; Yoast → Tools → Import and Export → Import from other SEO plugins).',
        'Deactivate the other plugin, then check a few pages: one `<title>`, one canonical, one robots tag, one JSON-LD graph.',
        'Also check the theme does not print its own SEO tags (some themes have “SEO” options that must be switched off).',
        verifyStep(input),
      ],
      files: ['Plugins → Installed plugins', 'SEO plugin import tool', 'theme options'],
    };
  },
};

// ---------------------------------------------------------------------------
// Shopify and platform defaults
// ---------------------------------------------------------------------------

const shopifyVendorPages: Recipe = {
  id: 'shopify-vendor-type-pages',
  patterns: [/^cms\.shopify-vendor-type-pages$/],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    return {
      title: 'Noindex automatic vendor and type collections',
      steps: [
        'Shopify generates /collections/vendors?q=… and /collections/types?q=… pages automatically: thin and duplicate. Add a noindex for them in `layout/theme.liquid` (below).',
        'If a vendor or type deserves a page, build a real collection with a description and link to that instead.',
        'Theme links that use `| link_to_vendor` or `| link_to_type` create these URLs; replace them with links to real collections or plain text.',
        ...urlsBlock(input, 5),
        verifyStep(input),
      ],
      files: ['layout/theme.liquid', 'snippets/*.liquid (link_to_vendor / link_to_type)'],
      snippet: {
        language: 'liquid',
        code: `{%- comment -%} layout/theme.liquid, inside <head> {%- endcomment -%}
{%- if request.path contains '/collections/vendors' or request.path contains '/collections/types' -%}
  <meta name="robots" content="noindex, follow">
{%- endif -%}`,
      },
    };
  },
};

const defaultTitle: Recipe = {
  id: 'platform-default-title',
  patterns: [/^cms\.default-title$/],
  impact: 'medium',
  effort: 'minutes',
  tier: 'manual',
  build(input) {
    const fix = byStack(input, {
      wordpress: () => ({
        steps: [
          'Settings → General → Site Title: set the business name. Then check the title template in your SEO plugin (`%%title%% %%sep%% %%sitename%%`) and the home page title.',
        ],
        files: ['Settings → General', `WordPress: ${seoPluginLabel(input.stack)} titles`],
      }),
      shopify: () => ({
        steps: [
          'Online Store → Preferences → Title and meta description: set the store name and a real home page title. Settings → General → Store name too.',
        ],
        files: ['Online Store → Preferences', 'Settings → General'],
      }),
      hosted: () => ({
        steps: [
          'Set the site name and home page SEO title in the site settings (Squarespace: Settings → Website → Site name and SEO; Wix: Settings → Website; Webflow: Site settings → General and the home page’s SEO settings).',
        ],
        files: ['Site settings → General / SEO'],
      }),
      'nextjs-app': () => ({
        steps: [
          'Replace “Create Next App” (or a starter template’s name) in `app/layout.tsx` metadata with your title template.',
        ],
        files: ['app/layout.tsx'],
        snippet: {
          language: 'ts',
          code: `export const metadata: Metadata = {\n  title: { default: 'Brand – what you do', template: '%s – Brand' },\n};`,
        },
      }),
      unknown: () => ({
        steps: [
          'Replace the default site name in the shared layout’s `<title>` and Open Graph site name.',
        ],
        files: [templateFile(input)],
      }),
    });
    return {
      ...fix,
      title: 'Replace the platform’s default site name',
      steps: [
        'Titles such as “My WordPress Website”, “My Store” or “My Site” are platform defaults. They appear in search results, browser tabs and AI citations.',
        ...evidenceStep(input),
        ...fix.steps,
        ...urlsBlock(input, 5),
      ],
    };
  },
};

const thinTaxonomy: Recipe = {
  id: 'thin-taxonomy-share',
  patterns: [/^cms\.thin-taxonomy-share$/],
  impact: 'medium',
  effort: 'hours',
  build(input) {
    const fix = byStack(input, {
      wordpress: () => ({
        steps: [
          `Noindex tag archives in ${seoSetting(input, 'Settings → Taxonomies → Tags → “Show tags in search results”: off', 'Titles & Meta → Tags → Robots Meta: noindex', 'Search Appearance → Taxonomies → Tags: Show in search results off')}. Noindexed tags drop out of the sitemap automatically.`,
          'Merge rarely used tags (Posts → Tags; plugins such as “Term Management Tools” merge them) and 301 the old URLs.',
          'Keep category archives that have a written introduction (Posts → Categories → description, shown by most themes).',
        ],
        files: ['WordPress: SEO plugin taxonomy settings', 'Posts → Tags / Categories'],
      }),
      ghost: () => ({
        steps: [
          'Ghost: give important tags a description and meta data (Tags → edit), and add `{{#is "tag"}}<meta name="robots" content="noindex, follow">{{/is}}` in `default.hbs` for the rest (or only for tags with few posts).',
        ],
        files: ['content/themes/<theme>/default.hbs'],
      }),
      unknown: () => ({
        steps: [
          'Add `noindex, follow` to tag and thin category listing templates, drop them from the sitemap, and give the archives you keep a written introduction.',
        ],
        files: ['tag / category templates', 'sitemap generator'],
      }),
    });
    return {
      ...fix,
      title: 'Cut thin tag and category archives from the index',
      steps: [
        'Indexable archive pages outnumber real content, so the site looks thin and crawlers spend their time on lists.',
        ...evidenceStep(input),
        ...fix.steps,
        verifyStep(input),
      ],
    };
  },
};

export const recipes: Recipe[] = [
  wpHardening,
  wpIndex,
  wpPerformance,
  wpContent,
  wpSeoConflict,
  shopifyVendorPages,
  defaultTitle,
  thinTaxonomy,
];
