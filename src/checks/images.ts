/**
 * Images: alt text, weight, formats, dimensions, loading.
 */
import type { ImageRef, PageData } from '../core/types.js';
import {
  REF,
  findPage,
  getImageStatuses,
  isHtml200,
  isIndexable,
  list,
  pageCheck,
  pathOf,
  plural,
  truncate,
} from './_util.js';
import * as cu from './_util.js';

export const IMAGE_LARGE_BYTES = 200 * 1024;
export const IMAGE_HUGE_BYTES = 1024 * 1024;
export const LEGACY_FORMAT_MIN_BYTES = 50 * 1024;
export const SRCSET_MIN_BYTES = 100 * 1024;
export const ALT_MAX = 125;
export const ABOVE_FOLD_IMAGES = 2;
export const LAZY_MIN_IMAGES = 6;
export const MAX_IMAGES = 150;
export const INLINE_DATA_URI_BYTES = 10 * 1024;

const C = 'content' as const;
const T = 'technical' as const;

const FILENAME_ALT =
  /^(img|image|dsc|dscn|photo|pic|screenshot|screen shot|untitled|whatsapp image)?[\s_-]*[\w-]*\d{3,}[\w-]*(\.(jpe?g|png|gif|webp|avif|svg))?$|\.(jpe?g|png|gif|webp|avif|svg)$/i;
const GENERIC_ALT = new Set([
  'image',
  'photo',
  'picture',
  'img',
  'graphic',
  'icon',
  'banner',
  'placeholder',
  'alt',
  'alt text',
  'untitled',
  'logo image',
]);

function realImages(page: PageData): ImageRef[] {
  return page.images.filter((i) => i.src && !i.src.startsWith('data:'));
}

/**
 * Images whose inline style fixes both dimensions or an aspect ratio, so the browser can
 * reserve space without width/height attributes (as Lighthouse allows).
 */
function cssSizedImages(page: PageData): Set<string> {
  const out = new Set<string>();
  for (const m of (page.html || '').matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const style = /\bstyle\s*=\s*["']([^"']*)/i.exec(tag)?.[1] ?? '';
    const sized =
      /aspect-ratio\s*:/i.test(style) ||
      (/(^|;)\s*width\s*:/i.test(style) && /(^|;)\s*height\s*:/i.test(style));
    if (!sized) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)/i.exec(tag)?.[1];
    if (!src) continue;
    try {
      out.add(new URL(src, page.finalUrl || page.url).toString());
    } catch {
      /* ignore */
    }
  }
  return out;
}

function isTracking(img: ImageRef): boolean {
  return (
    (img.width === 1 && img.height === 1) ||
    /\/(pixel|tracking|beacon)|facebook\.com\/tr|\/collect\?/i.test(img.src)
  );
}

function ext(src: string): string {
  return (/\.([a-z0-9]+)(?:$|\?)/i.exec(pathOf(src))?.[1] || '').toLowerCase();
}

export const checks = [
  pageCheck(
    {
      id: 'images.alt-missing',
      category: 'images',
      pillar: C,
      title: 'Images without an alt attribute',
      why: 'Alt text is how screen readers, image search and AI crawlers understand an image. Without the attribute, screen readers may read the file name instead.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Add alt text describing what the image shows and why it is there. Use alt="" for purely decorative images.',
      refs: [REF.images, 'https://www.w3.org/WAI/tutorials/images/'],
      tags: ['wcag-1.1.1'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const missing = realImages(page).filter((i) => i.alt === null && !isTracking(i));
      return missing.length
        ? {
            checkId: 'images.alt-missing',
            message: `${plural(missing.length, 'image')} with no alt attribute`,
            evidence: list(
              missing.map((i) => pathOf(i.src)),
              4,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'images.alt-unhelpful',
      category: 'images',
      pillar: C,
      title: 'Alt text is a file name or a generic word',
      why: 'Alt text like "IMG_2041.jpg" or "image" gives no information to screen-reader users or to search and AI engines.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Replace it with a short description of the image content.',
      refs: [REF.images],
      tags: ['wcag-1.1.1'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = realImages(page).filter((i) => {
        const a = (i.alt || '').trim();
        return a && (FILENAME_ALT.test(a) || GENERIC_ALT.has(a.toLowerCase()));
      });
      return bad.length
        ? {
            checkId: 'images.alt-unhelpful',
            message: `${plural(bad.length, 'image')} with unhelpful alt text`,
            evidence: list([...new Set(bad.map((i) => `"${i.alt}"`))], 4),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'images.alt-too-long',
      category: 'images',
      pillar: C,
      title: 'Alt text is very long',
      why: 'Very long alt text is tiring for screen-reader users and often stuffed with keywords.',
      severity: 'low',
      fixTier: 'manual',
      fix: `Keep alt text under about ${ALT_MAX} characters. Put longer explanations in a caption or the body text.`,
      refs: [REF.images],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const long = realImages(page).filter((i) => (i.alt || '').length > ALT_MAX);
      return long.length
        ? {
            checkId: 'images.alt-too-long',
            message: `${plural(long.length, 'image')} with alt text over ${ALT_MAX} characters`,
            evidence: truncate(long[0].alt, 160),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'images.alt-stuffed',
      category: 'images',
      pillar: C,
      title: 'Alt text looks keyword-stuffed',
      why: 'Comma-separated keyword lists in alt text are a spam pattern and useless to screen-reader users.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Write alt text as a natural sentence fragment describing the image.',
      refs: [REF.images, REF.spam],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = realImages(page).filter((i) => {
        const a = (i.alt || '').toLowerCase();
        if ((a.match(/,/g) || []).length >= 4) return true;
        const ws = a.split(/\W+/).filter((w) => w.length > 3);
        return ws.length >= 6 && new Set(ws).size <= ws.length / 2;
      });
      return bad.length
        ? {
            checkId: 'images.alt-stuffed',
            message: `${plural(bad.length, 'image')} with keyword-list alt text`,
            evidence: truncate(bad[0].alt, 160),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'images.dimensions-missing',
      category: 'images',
      pillar: T,
      title: 'Images without width and height',
      why: 'Without width and height the browser cannot reserve space, so the layout jumps when images load (Cumulative Layout Shift).',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add width and height attributes matching the image’s aspect ratio. CSS can still make it responsive.',
      refs: [REF.cls],
      tags: ['core-web-vitals'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const sizedByCss = cssSizedImages(page);
      const miss = realImages(page).filter(
        (i) =>
          (!i.width || !i.height) &&
          ext(i.src) !== 'svg' &&
          !isTracking(i) &&
          !sizedByCss.has(i.src),
      );
      // Lighthouse's unsized-images audit fails on any such image, so one is enough.
      return miss.length >= 1
        ? {
            checkId: 'images.dimensions-missing',
            message: `${plural(miss.length, 'image')} without width and height`,
            evidence: list(
              miss.map((i) => pathOf(i.src)),
              3,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'images.large',
      category: 'images',
      pillar: T,
      title: 'Heavy image files',
      why: 'Large images are the most common cause of slow Largest Contentful Paint, especially on mobile data.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Resize to the displayed size, compress, and serve WebP or AVIF. Most CMSs and image CDNs can do this automatically.',
      refs: [REF.lcp, 'https://web.dev/articles/serve-images-webp'],
      tags: ['core-web-vitals'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const big = realImages(page).filter((i) => (i.bytes ?? 0) > IMAGE_LARGE_BYTES);
      if (!big.length) return null;
      const huge = big.some((i) => (i.bytes ?? 0) > IMAGE_HUGE_BYTES);
      return {
        checkId: 'images.large',
        severity: huge ? 'high' : 'medium',
        message: `${plural(big.length, 'image')} over ${IMAGE_LARGE_BYTES / 1024} KB`,
        evidence: list(
          big
            .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
            .map((i) => `${pathOf(i.src)} (${Math.round((i.bytes ?? 0) / 1024)} KB)`),
          3,
        ),
      };
    },
  ),
  pageCheck(
    {
      id: 'images.legacy-format',
      category: 'images',
      pillar: T,
      title: 'Large images in JPEG, PNG or GIF',
      why: 'WebP and AVIF are typically 25–50% smaller than JPEG or PNG at the same quality, and every current browser supports WebP.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Serve WebP or AVIF, using <picture> with a fallback if you need one, or turn on format conversion in your image CDN.',
      refs: ['https://web.dev/articles/serve-images-webp'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const legacy = realImages(page).filter((i) => {
        const ct = (i.contentType || '').toLowerCase();
        const legacyType = ct
          ? /jpeg|png|gif|bmp/.test(ct)
          : ['jpg', 'jpeg', 'png', 'gif', 'bmp'].includes(ext(i.src));
        return (
          legacyType &&
          (i.bytes ?? 0) > LEGACY_FORMAT_MIN_BYTES &&
          !/\.(webp|avif)/i.test(i.srcset || '')
        );
      });
      return legacy.length
        ? {
            checkId: 'images.legacy-format',
            message: `${plural(legacy.length, 'image')} over ${LEGACY_FORMAT_MIN_BYTES / 1024} KB not in WebP/AVIF`,
            evidence: list(
              legacy.map((i) => pathOf(i.src)),
              3,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'images.no-srcset',
      category: 'images',
      pillar: T,
      title: 'Large images without responsive sizes',
      why: 'Without srcset, phones download the same large file as desktops.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Provide srcset and sizes (or use your framework’s image component) so each device gets a suitably sized file.',
      refs: ['https://web.dev/articles/serve-responsive-images'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const hits = realImages(page).filter(
        (i) => (i.bytes ?? 0) > SRCSET_MIN_BYTES && !i.srcset && ext(i.src) !== 'svg',
      );
      return hits.length
        ? {
            checkId: 'images.no-srcset',
            message: `${plural(hits.length, 'large image')} without srcset`,
            evidence: list(
              hits.map((i) => pathOf(i.src)),
              3,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'images.lazy-above-fold',
      category: 'images',
      pillar: T,
      title: 'First images are lazy-loaded',
      why: 'Lazy-loading the hero image delays the Largest Contentful Paint, because the browser waits for layout before fetching it.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove loading="lazy" from the first one or two images and add fetchpriority="high" to the main one.',
      refs: ['https://web.dev/articles/lcp-lazy-loading'],
      tags: ['core-web-vitals'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const first = realImages(page)
        .filter((i) => !isTracking(i))
        .slice(0, ABOVE_FOLD_IMAGES);
      const lazy = first.filter((i) => (i.loading || '').toLowerCase() === 'lazy');
      return lazy.length
        ? {
            checkId: 'images.lazy-above-fold',
            message: `${plural(lazy.length, 'of the first images')} uses loading="lazy"`,
            evidence: list(lazy.map((i) => pathOf(i.src))),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'images.no-lazy-loading',
      category: 'images',
      pillar: T,
      title: 'Many images and none lazy-loaded',
      why: 'Loading every image up front competes with the content people see first and wastes data on images they may never scroll to.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add loading="lazy" to images below the first screen.',
      refs: ['https://web.dev/articles/browser-level-image-lazy-loading'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const imgs = realImages(page).filter((i) => !isTracking(i));
      if (
        imgs.length < LAZY_MIN_IMAGES ||
        imgs.some((i) => (i.loading || '').toLowerCase() === 'lazy')
      )
        return null;
      return {
        checkId: 'images.no-lazy-loading',
        message: `${imgs.length} images and none use loading="lazy"`,
      };
    },
  ),
  pageCheck(
    {
      id: 'images.lcp-priority',
      category: 'images',
      pillar: T,
      title: 'Hero image is not prioritised',
      why: 'fetchpriority="high" (or a preload) on the main above-the-fold image lets the browser fetch it first, which often improves LCP noticeably.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add fetchpriority="high" to the hero image, or preload it with <link rel="preload" as="image">.',
      refs: ['https://web.dev/articles/fetch-priority'],
      tags: ['core-web-vitals'],
    },
    (page) => {
      if (!isIndexable(page) || !page.html) return null;
      const first = realImages(page).find(
        (i) => !isTracking(i) && ext(i.src) !== 'svg' && (i.bytes ?? 0) > 50 * 1024,
      );
      if (!first) return null;
      if (
        /fetchpriority=["']?high/i.test(page.html) ||
        /<link[^>]+rel=["']?preload["']?[^>]+as=["']?image/i.test(page.html)
      )
        return null;
      return {
        checkId: 'images.lcp-priority',
        message: 'No image on the page has fetchpriority="high" or a preload',
        evidence: pathOf(first.src),
      };
    },
  ),
  pageCheck(
    {
      id: 'images.broken',
      category: 'images',
      pillar: C,
      title: 'Broken images',
      why: 'Missing images show as empty boxes, look neglected and are dropped from image search.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Fix the image path, restore the file, or remove the reference.',
      refs: [REF.images],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const st = getImageStatuses(site);
      const bad = realImages(page).filter((i) => {
        const s = st.get(i.src) ?? findPage(site, i.src)?.status;
        return s !== undefined && (s >= 400 || s === 0);
      });
      return bad.length
        ? {
            checkId: 'images.broken',
            message: `${plural(bad.length, 'image')} failed to load`,
            evidence: list(
              bad.map((i) => pathOf(i.src)),
              4,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'images.wrong-content-type',
      category: 'images',
      pillar: T,
      title: 'Image URL does not return an image',
      why: 'An <img> whose URL returns HTML or text (often an error page) will not display and cannot be indexed.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Point the image at a real image file and make the server send an image/* Content-Type.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = realImages(page).filter(
        (i) =>
          i.contentType && !/^image\//i.test(i.contentType) && !/octet-stream/i.test(i.contentType),
      );
      return bad.length
        ? {
            checkId: 'images.wrong-content-type',
            message: `${plural(bad.length, 'image')} served as ${bad[0].contentType}`,
            evidence: list(
              bad.map((i) => pathOf(i.src)),
              3,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'images.empty-src',
      category: 'images',
      pillar: T,
      title: 'Images with an empty src',
      why: 'An empty src makes some browsers request the page itself again, and the image never shows for crawlers that do not run JavaScript.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Set a real src in the HTML. If a lazy-load script swaps data-src, include a <noscript> fallback or use native loading="lazy".',
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const n = (page.html.match(/<img\b(?![^>]*\bsrc=["']?[^"'\s>])[^>]*>/gi) || []).length;
      return n
        ? {
            checkId: 'images.empty-src',
            message: `${plural(n, '<img> element')} without a usable src`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'images.inline-data-heavy',
      category: 'images',
      pillar: T,
      title: 'Large images embedded as data URIs',
      why: 'Base64 images inside the HTML cannot be cached separately and inflate every page download.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Serve large images as separate files. Keep data URIs for tiny icons or placeholders only.',
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const big = [...page.html.matchAll(/data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)/g)].filter(
        (m) => m[1].length * 0.75 > INLINE_DATA_URI_BYTES,
      );
      if (!big.length) return null;
      const kb = Math.round(big.reduce((n, m) => n + m[1].length * 0.75, 0) / 1024);
      return {
        checkId: 'images.inline-data-heavy',
        message: `${plural(big.length, 'inline image')} adding about ${kb} KB to the HTML`,
      };
    },
  ),
  pageCheck(
    {
      id: 'images.too-many',
      category: 'images',
      pillar: T,
      title: 'Very many images on one page',
      why: 'Hundreds of images mean hundreds of requests and a heavy page, even with lazy loading.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Paginate galleries, use thumbnails, and remove decorative images that add little.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const n = new Set(realImages(page).map((i) => i.src)).size;
      return n > MAX_IMAGES
        ? { checkId: 'images.too-many', message: `${n} distinct images` }
        : null;
    },
  ),
];

// ---------------------------------------------------------------------------
// Added for feature parity: images much larger than they are displayed
// ---------------------------------------------------------------------------

/** Rendered width at or below this share of the intrinsic width counts as oversized. */
export const OVERSIZE_RATIO = 0.5;
/** …and only when the file is at least this heavy, or the declared width this wide. */
export const OVERSIZE_MIN_BYTES = 100 * 1024;
export const OVERSIZE_MIN_WIDTH = 800;

checks.push(
  cu.pageCheck(
    {
      id: 'images.oversized-rendered',
      category: 'images',
      pillar: T,
      title: 'Images far larger than they are displayed',
      why: 'An image shown 300 pixels wide but delivered 2,000 pixels wide downloads several times more data than needed, which slows Largest Contentful Paint on phones. Measured in a real browser render.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Serve images close to their displayed size: add srcset and sizes so phones get smaller files, or use your CMS or image CDN resizing.',
      requires: ['render'],
      refs: ['https://web.dev/articles/serve-responsive-images'],
      tags: ['core-web-vitals'],
    },
    (page) => {
      const layout = page.rendered?.layout;
      if (!layout || !cu.isHtml200(page)) return null;
      const bySrc = new Map(page.images.map((i) => [i.src, i]));
      const hits: string[] = [];
      for (const box of layout.images) {
        if (box.width < 16 || box.height < 16) continue; // hidden or icon
        const img = bySrc.get(box.src);
        if (!img || img.srcset) continue; // responsive images let the browser choose
        const declared = img.width ?? 0;
        const heavy = (img.bytes ?? 0) >= OVERSIZE_MIN_BYTES;
        const wide = declared >= OVERSIZE_MIN_WIDTH;
        const ratio = declared ? box.width / declared : null;
        if ((wide && ratio !== null && ratio <= OVERSIZE_RATIO) || (heavy && box.width <= 400))
          hits.push(
            `${cu.pathOf(box.src)} shown at ${box.width}px${declared ? ` (file ${declared}px)` : ''}${img.bytes ? `, ${Math.round(img.bytes / 1024)} KB` : ''}`,
          );
      }
      if (!hits.length) return null;
      return {
        checkId: 'images.oversized-rendered',
        message: `${cu.plural(hits.length, 'image')} delivered much larger than displayed`,
        evidence: cu.list(hits, 3),
      };
    },
  ),
);
