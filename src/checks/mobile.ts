/**
 * Mobile friendliness from markup: viewport, zoom, fixed widths, plugins.
 */
import {
  REF,
  doc,
  homePage,
  isHtml200,
  isIndexable,
  list,
  pageCheck,
  plural,
  rawHead,
  siteCheck,
  truncate,
} from './_util.js';

export const MAX_FIXED_WIDTH_PX = 640;
export const MIN_FONT_PX = 12;
export const SMALL_FONT_MIN_OCCURRENCES = 5;
export const MIN_MAX_SCALE = 2;

const T = 'technical' as const;
const C = 'content' as const;

export const checks = [
  pageCheck(
    {
      id: 'mobile.viewport-missing',
      category: 'mobile',
      pillar: T,
      title: 'No viewport meta tag',
      why: 'Without a viewport tag, phones render the page at desktop width and shrink it. Google indexes the mobile version, so this affects every page’s rankings.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head>.',
      refs: [REF.mobile, 'https://developer.mozilla.org/en-US/docs/Web/HTML/Viewport_meta_tag'],
    },
    (page) =>
      isHtml200(page) && !page.viewport
        ? { checkId: 'mobile.viewport-missing', message: 'No <meta name="viewport">' }
        : null,
  ),
  pageCheck(
    {
      id: 'mobile.viewport-not-responsive',
      category: 'mobile',
      pillar: T,
      title: 'Viewport is not set to the device width',
      why: 'A fixed viewport width (width=1024) or missing width=device-width forces a desktop layout on phones.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Use content="width=device-width, initial-scale=1" and make the layout responsive with CSS.',
      refs: [REF.mobile],
    },
    (page) => {
      const v = (page.viewport || '').toLowerCase().replace(/\s/g, '');
      if (!isHtml200(page) || !v || v.includes('width=device-width')) return null;
      return {
        checkId: 'mobile.viewport-not-responsive',
        message: 'Viewport does not use width=device-width',
        evidence: page.viewport!,
      };
    },
  ),
  pageCheck(
    {
      id: 'mobile.zoom-disabled',
      category: 'mobile',
      pillar: C,
      title: 'Pinch-zoom is disabled',
      why: 'user-scalable=no or a low maximum-scale stops people with low vision from zooming. It fails WCAG 1.4.4.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove user-scalable=no and maximum-scale from the viewport tag.',
      refs: ['https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html'],
      tags: ['wcag-1.4.4'],
    },
    (page) => {
      const v = (page.viewport || '').toLowerCase().replace(/\s/g, '');
      if (!isHtml200(page) || !v) return null;
      const noScale = /user-scalable=(no|0)/.test(v);
      const max = /maximum-scale=([\d.]+)/.exec(v);
      if (!noScale && !(max && Number(max[1]) < MIN_MAX_SCALE)) return null;
      return {
        checkId: 'mobile.zoom-disabled',
        message: 'Viewport prevents zooming',
        evidence: page.viewport!,
      };
    },
  ),
  pageCheck(
    {
      id: 'mobile.viewport-multiple',
      category: 'mobile',
      pillar: T,
      title: 'More than one viewport tag',
      why: 'Several viewport tags conflict and browsers use the last one, which may not be the one you meant.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Keep one viewport meta tag.',
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const n = (rawHead(page.html).match(/<meta[^>]+name=["']?viewport/gi) || []).length;
      return n > 1 ? { checkId: 'mobile.viewport-multiple', message: `${n} viewport tags` } : null;
    },
  ),
  pageCheck(
    {
      id: 'mobile.plugins',
      category: 'mobile',
      pillar: T,
      title: 'Content needs a browser plugin',
      why: 'Flash, Java applets and similar plugin content does not run on phones or modern browsers, and crawlers cannot read it.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Replace plugin content with HTML5 video, images or plain HTML.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const els = Array.from(doc(page).querySelectorAll('object, embed, applet')).filter((e) =>
        /flash|shockwave|java|\.swf|silverlight/i.test(
          `${e.getAttribute('type') || ''} ${e.getAttribute('data') || ''} ${e.getAttribute('src') || ''} ${e.tagName}`,
        ),
      );
      return els.length
        ? {
            checkId: 'mobile.plugins',
            message: `${plural(els.length, 'plugin element')} (Flash, Java or Silverlight)`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'mobile.fixed-width',
      category: 'mobile',
      pillar: T,
      title: 'Elements with fixed widths wider than a phone',
      why: `Inline widths above ${MAX_FIXED_WIDTH_PX}px force sideways scrolling on phones.`,
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use max-width: 100% or relative units instead of fixed pixel widths on tables, iframes and containers.',
      refs: [REF.mobile],
    },
    (page) => {
      if (!isHtml200(page) || !page.viewport) return null;
      const hits: string[] = [];
      for (const el of Array.from(
        doc(page).querySelectorAll(
          '[style*="width"], table[width], iframe[width], img[width], div[width]',
        ),
      )) {
        const style = el.getAttribute('style') || '';
        if (/max-width/i.test(style)) continue;
        const m = /(?:^|;)\s*(?:min-)?width\s*:\s*(\d+)px/i.exec(style);
        const w = m
          ? Number(m[1])
          : el.tagName.toLowerCase() === 'img'
            ? 0
            : Number(el.getAttribute('width') || 0);
        if (w > MAX_FIXED_WIDTH_PX) hits.push(`<${el.tagName.toLowerCase()}> ${w}px`);
      }
      return hits.length
        ? {
            checkId: 'mobile.fixed-width',
            message: `${plural(hits.length, 'element')} wider than ${MAX_FIXED_WIDTH_PX}px`,
            evidence: list(hits, 4),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'mobile.small-text',
      category: 'mobile',
      pillar: C,
      title: 'Text set below 12px',
      why: `Text smaller than ${MIN_FONT_PX}px is hard to read on phones without zooming.`,
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use a base font size of at least 16px for body text and avoid sizes under 12px.',
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const small = [...page.html.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)]
        .map((m) => Number(m[1]))
        .filter((n) => n > 0 && n < MIN_FONT_PX);
      return small.length >= SMALL_FONT_MIN_OCCURRENCES
        ? {
            checkId: 'mobile.small-text',
            message: `${small.length} font sizes under ${MIN_FONT_PX}px in inline styles`,
            evidence: `smallest ${Math.min(...small)}px`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'mobile.input-types',
      category: 'mobile',
      pillar: C,
      title: 'Email or phone fields use a plain text input',
      why: 'type="email" and type="tel" bring up the right keyboard on phones and help browsers and AI agents fill the form correctly.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Set type="email" on email fields and type="tel" on phone fields, with matching autocomplete values.',
      refs: ['https://web.dev/learn/forms/autofill'],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const bad = Array.from(
        doc(page).querySelectorAll('input:not([type]), input[type="text"]'),
      ).filter((i) =>
        /e-?mail|phone|tel(ephone)?\b|mobile/i.test(
          `${i.getAttribute('name') || ''} ${i.getAttribute('id') || ''} ${i.getAttribute('placeholder') || ''}`,
        ),
      );
      return bad.length
        ? {
            checkId: 'mobile.input-types',
            message: `${plural(bad.length, 'field')} for email or phone use type="text"`,
            evidence: truncate(
              bad.map((b) => b.getAttribute('name') || b.getAttribute('id') || '').join(', '),
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'mobile.separate-mobile-urls',
      category: 'mobile',
      pillar: T,
      title: 'Separate mobile URLs (m-dot) in use',
      why: 'Separate mobile URLs need rel=alternate and rel=canonical annotations in both directions and full content parity. Google indexes the mobile version, so any gap costs rankings.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Prefer a responsive site. If you keep m-dot URLs, check alternate/canonical pairs and that mobile pages have the same content and structured data.',
      refs: [
        'https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing#separate-urls',
      ],
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const m = /<link[^>]+rel=["']?alternate["']?[^>]+media=["'][^"']*max-width[^>]*>/i.exec(
        rawHead(page.html),
      );
      return m
        ? {
            checkId: 'mobile.separate-mobile-urls',
            message: 'Page declares a separate mobile URL',
            evidence: truncate(m[0]),
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'mobile.touch-icon-missing',
      category: 'mobile',
      pillar: C,
      title: 'No apple-touch-icon',
      why: 'The touch icon is used when people save the site to a phone home screen and by some apps for link previews.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add <link rel="apple-touch-icon" href="/apple-touch-icon.png"> (180×180 PNG).',
    },
    (site) => {
      const home = homePage(site);
      if (!home || !isHtml200(home) || /rel=["']?apple-touch-icon/i.test(home.html || ''))
        return null;
      return {
        checkId: 'mobile.touch-icon-missing',
        url: home.url,
        message: 'Home page has no apple-touch-icon link',
      };
    },
  ),
];
