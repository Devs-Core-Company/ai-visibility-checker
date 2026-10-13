/**
 * Crawl presets per platform: URL patterns that waste crawl budget on that
 * platform (admin areas, carts, feeds, internal search, endless filters) and a
 * rendering default. `avc audit --preset auto` detects the platform from the
 * home page first and applies its preset.
 */
import type { CrawlOptions, StackId } from '../core/types.js';

export interface CrawlPreset {
  id: string;
  label: string;
  exclude: string[];
  render?: boolean | 'auto';
  /** Variants that add more exclusions (a WooCommerce shop, a blog). */
  variants?: Record<string, { label: string; exclude: string[] }>;
}

const COMMON = [String.raw`[?&](add-to-cart|add_to_wishlist|replytocom)=`, String.raw`\/cgi-bin\/`];

export const PRESETS: Record<string, CrawlPreset> = {
  wordpress: {
    id: 'wordpress',
    label: 'WordPress',
    render: 'auto',
    exclude: [
      ...COMMON,
      String.raw`\/wp-admin\/`,
      String.raw`\/wp-json\/`,
      String.raw`\/xmlrpc\.php`,
      String.raw`\/wp-login\.php`,
      String.raw`\/feed\/?$`,
      String.raw`\/trackback\/?$`,
      String.raw`\/comment-page-\d+`,
      String.raw`[?&]s=`,
    ],
    variants: {
      woocommerce: {
        label: 'WooCommerce shop',
        exclude: [
          String.raw`\/(cart|checkout|my-account)\/`,
          String.raw`[?&](orderby|filter_[a-z_]+|min_price|max_price)=`,
        ],
      },
      blog: {
        label: 'Blog',
        exclude: [String.raw`\/(\d{4})\/(\d{2})\/?$`, String.raw`\/author\/[^/]+\/page\/\d+`],
      },
    },
  },
  shopify: {
    id: 'shopify',
    label: 'Shopify',
    render: 'auto',
    exclude: [
      ...COMMON,
      String.raw`\/(cart|checkout|account)(\/|$)`,
      String.raw`\/collections\/[^/]+\/products\/`,
      String.raw`\/collections\/(vendors|types)\?`,
      String.raw`[?&](variant|sort_by|filter\.[a-z._]+|_pos|_sid|_ss)=`,
      String.raw`\/search\?`,
      String.raw`\/policies\/`,
    ],
  },
  magento: {
    id: 'magento',
    label: 'Magento / Adobe Commerce',
    exclude: [
      ...COMMON,
      String.raw`\/(checkout|customer|wishlist|catalogsearch|sendfriend)\/`,
      String.raw`[?&](dir|order|limit|mode|price|cat)=`,
    ],
  },
  drupal: {
    id: 'drupal',
    label: 'Drupal',
    exclude: [
      ...COMMON,
      String.raw`\/(user|admin|node\/add|search)\b`,
      String.raw`[?&]destination=`,
    ],
  },
  joomla: {
    id: 'joomla',
    label: 'Joomla',
    exclude: [
      ...COMMON,
      String.raw`\/administrator\/`,
      String.raw`[?&](option=com_users|tmpl=component|print=1)`,
    ],
  },
  laravel: {
    id: 'laravel',
    label: 'Laravel',
    exclude: [
      ...COMMON,
      String.raw`\/(login|register|logout|password|email\/verify|dashboard|admin)(\/|$)`,
      String.raw`\/(api|livewire|_debugbar|telescope|horizon)\/`,
    ],
  },
  nextjs: {
    id: 'nextjs',
    label: 'Next.js',
    render: 'auto',
    exclude: [String.raw`\/_next\/`, String.raw`\/api\/`, String.raw`[?&]_rsc=`],
  },
  spa: {
    id: 'spa',
    label: 'Single-page app (React, Vue, Angular)',
    render: true,
    exclude: [String.raw`\/api\/`],
  },
  hosted: {
    id: 'hosted',
    label: 'Hosted builder (Wix, Squarespace, Webflow)',
    exclude: [String.raw`\/(cart|checkout|account|members|blank)(\/|$)`, String.raw`[?&]lightbox=`],
  },
  static: { id: 'static', label: 'Static site', render: false, exclude: [] },
};

/** The preset that fits a detected stack, or null. */
export function presetForStack(id: StackId): CrawlPreset | null {
  switch (id) {
    case 'wordpress':
      return PRESETS.wordpress!;
    case 'shopify':
      return PRESETS.shopify!;
    case 'drupal':
      return PRESETS.drupal!;
    case 'joomla':
      return PRESETS.joomla!;
    case 'magento':
      return PRESETS.magento!;
    case 'laravel':
      return PRESETS.laravel!;
    case 'nextjs':
      return PRESETS.nextjs!;
    case 'react-spa':
    case 'vue-spa':
    case 'angular':
      return PRESETS.spa!;
    case 'wix':
    case 'squarespace':
    case 'webflow':
    case 'framer':
      return PRESETS.hosted!;
    case 'hugo':
    case 'jekyll':
    case 'static':
      return PRESETS.static!;
    default:
      return null;
  }
}

/** "wordpress" or "wordpress:woocommerce" → crawl option changes. Null for an unknown name. */
export function resolvePreset(name: string): Partial<CrawlOptions> | null {
  const [id, variant] = name.toLowerCase().split(':');
  const p = PRESETS[id ?? ''];
  if (!p) return null;
  const extra = variant ? p.variants?.[variant]?.exclude : undefined;
  if (variant && !extra) return null;
  return {
    exclude: [...p.exclude, ...(extra ?? [])],
    ...(p.render !== undefined ? { render: p.render } : {}),
  };
}

/** Merge a preset into explicit options: explicit excludes are kept and the preset's appended. */
export function withPreset(
  opts: Partial<CrawlOptions>,
  preset: Partial<CrawlOptions>,
): Partial<CrawlOptions> {
  return {
    ...opts,
    exclude: [...new Set([...(opts.exclude ?? []), ...(preset.exclude ?? [])])],
    render: opts.render ?? preset.render,
  };
}

export function listPresets(): { id: string; label: string; variants: string[] }[] {
  return Object.values(PRESETS).map((p) => ({
    id: p.id,
    label: p.label,
    variants: Object.keys(p.variants ?? {}),
  }));
}
