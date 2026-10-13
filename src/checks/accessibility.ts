/**
 * Accessibility: a WCAG 2.2 subset that also helps AI agents, which read pages
 * through the same names, labels, roles and landmarks as assistive technology.
 */
import type { PageData } from '../core/types.js';
import { hreflangProblem } from './hreflang.js';
import {
  accessibleName,
  doc,
  isHtml200,
  isIndexable,
  list,
  pageCheck,
  plural,
  truncate,
} from './_util.js';
import * as cu from './_util.js';

export const CONTRAST_MIN = 4.5;
export const CONTRAST_MIN_LARGE = 3;

const C = 'content' as const;
const U = (sc: string) => `https://www.w3.org/WAI/WCAG22/Understanding/${sc}.html`;

const ROLES = new Set(
  'alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img image insertion link list listbox listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem doc-abstract doc-acknowledgments doc-afterword doc-appendix doc-backlink doc-biblioentry doc-bibliography doc-biblioref doc-chapter doc-colophon doc-conclusion doc-cover doc-credit doc-credits doc-dedication doc-endnote doc-endnotes doc-epigraph doc-epilogue doc-errata doc-example doc-footnote doc-foreword doc-glossary doc-glossref doc-index doc-introduction doc-noteref doc-notice doc-pagebreak doc-pagelist doc-part doc-preface doc-prologue doc-pullquote doc-qna doc-subtitle doc-tip doc-toc graphics-document graphics-object graphics-symbol'.split(
    ' ',
  ),
);
const ARIA_ATTRS = new Set(
  'activedescendant atomic autocomplete braillelabel brailleroledescription busy checked colcount colindex colindextext colspan controls current describedby description details disabled dropeffect errormessage expanded flowto grabbed haspopup hidden invalid keyshortcuts label labelledby level live modal multiline multiselectable orientation owns placeholder posinset pressed readonly relevant required roledescription rowcount rowindex rowindextext rowspan selected setsize sort valuemax valuemin valuenow valuetext'.split(
    ' ',
  ),
);
const FOCUSABLE =
  'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** The DOM to check: the rendered one when the page was rendered (closer to what users and
 * assistive technology get), else the raw HTML. */
function adoc(page: PageData): Document {
  return cu.renderedDoc(page) ?? doc(page);
}

function els(page: PageData, sel: string): Element[] {
  return Array.from(adoc(page).querySelectorAll(sel));
}

function snippet(e: Element): string {
  return truncate(e.outerHTML.replace(/>[\s\S]*$/, '>'), 120);
}

function luminance(hex: string): number | null {
  let h = hex.replace('#', '').toLowerCase();
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseColour(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(s)) return s;
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s);
  if (m)
    return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return ({ white: '#ffffff', black: '#000000' } as Record<string, string>)[s] ?? null;
}

export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la == null || lb == null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const checks = [
  pageCheck(
    {
      id: 'accessibility.lang-missing',
      category: 'accessibility',
      pillar: C,
      title: 'Page language not declared',
      why: 'Without <html lang>, screen readers guess the pronunciation and translation tools and AI engines may misjudge the page language.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add the language to the root element, for example <html lang="en-GB">.',
      refs: [U('language-of-page')],
      tags: ['wcag-3.1.1'],
    },
    (page) =>
      isHtml200(page) && !page.lang?.trim()
        ? { checkId: 'accessibility.lang-missing', message: 'No lang attribute on <html>' }
        : null,
  ),
  pageCheck(
    {
      id: 'accessibility.lang-invalid',
      category: 'accessibility',
      pillar: C,
      title: 'Invalid page language code',
      why: 'An invalid lang value (such as "english" or "en_UK") is ignored by assistive technology and parsers.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use a valid BCP 47 code: en, en-GB, fr-CA, zh-Hant.',
      refs: [U('language-of-page')],
      tags: ['wcag-3.1.1'],
    },
    (page) => {
      const l = page.lang?.trim();
      if (!isHtml200(page) || !l) return null;
      const p = hreflangProblem(l);
      return p ? { checkId: 'accessibility.lang-invalid', message: `lang="${l}": ${p}` } : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.form-label-missing',
      category: 'accessibility',
      pillar: C,
      title: 'Form fields without labels',
      why: 'Fields without a label are announced as "edit text" with no purpose. AI agents filling forms rely on the same labels to know what goes where.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Give every field a visible <label for="…">, or aria-label / aria-labelledby when a visible label is not possible. Placeholders do not count.',
      refs: [U('labels-or-instructions'), U('info-and-relationships')],
      tags: ['wcag-1.3.1', 'wcag-4.1.2', 'agentic'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const d = adoc(page);
      const fields = els(
        page,
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea',
      );
      const bad = fields.filter((f) => {
        if (accessibleName(f, d)) return false;
        const id = f.getAttribute('id');
        if (id && d.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`)?.textContent?.trim())
          return false;
        if (f.closest('label')?.textContent?.trim()) return false;
        return true;
      });
      return bad.length
        ? {
            checkId: 'accessibility.form-label-missing',
            message: `${plural(bad.length, 'form field')} without a label`,
            evidence: list(bad.map(snippet), 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.link-name-missing',
      category: 'accessibility',
      pillar: C,
      title: 'Links without an accessible name',
      why: 'An icon or image link with no text or alt is announced as just "link". Search engines and AI agents also get no anchor text for it.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add text, an aria-label, or alt text on the image inside the link that says where it goes.',
      refs: [U('link-purpose-in-context'), U('name-role-value')],
      tags: ['wcag-2.4.4', 'wcag-4.1.2', 'agentic'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const d = adoc(page);
      const bad = els(page, 'a[href]').filter(
        (a) => a.getAttribute('aria-hidden') !== 'true' && !accessibleName(a, d),
      );
      return bad.length
        ? {
            checkId: 'accessibility.link-name-missing',
            message: `${plural(bad.length, 'link')} with no accessible name`,
            evidence: list(
              bad.map((a) => a.getAttribute('href') || ''),
              4,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.button-name-missing',
      category: 'accessibility',
      pillar: C,
      title: 'Buttons without an accessible name',
      why: 'Icon-only buttons with no label are announced as "button". Agents trying to act on the page cannot tell "search" from "close".',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add visible text or an aria-label to each button (and alt text to input type="image").',
      refs: [U('name-role-value')],
      tags: ['wcag-4.1.2', 'agentic'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const d = adoc(page);
      const bad = els(
        page,
        'button, [role="button"], input[type="image"], input[type="submit"]:not([value=""]), input[type="button"]',
      ).filter((b) => {
        if (b.getAttribute('aria-hidden') === 'true') return false;
        const tag = b.tagName.toLowerCase();
        if (tag === 'input') {
          const t = b.getAttribute('type');
          if (t === 'image') return !(b.getAttribute('alt') || b.getAttribute('aria-label'));
          if (t === 'submit') return false; // browsers supply "Submit"
          return !(b.getAttribute('value') || accessibleName(b, d));
        }
        return !accessibleName(b, d);
      });
      return bad.length
        ? {
            checkId: 'accessibility.button-name-missing',
            message: `${plural(bad.length, 'button')} with no accessible name`,
            evidence: list(bad.map(snippet), 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.clickable-div',
      category: 'accessibility',
      pillar: C,
      title: 'Clickable elements that are not buttons or links',
      why: 'A <div> or <span> with an onclick handler cannot be reached by keyboard and is invisible as a control to screen readers and AI agents.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Use <button> for actions and <a href> for navigation. If you must keep the element, add role, tabindex="0" and keyboard handlers.',
      refs: [U('keyboard'), U('name-role-value')],
      tags: ['wcag-2.1.1', 'agentic'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = els(
        page,
        'div[onclick], span[onclick], li[onclick], td[onclick], img[onclick]',
      ).filter((e) => !e.getAttribute('role') && !e.hasAttribute('tabindex'));
      return bad.length
        ? {
            checkId: 'accessibility.clickable-div',
            message: `${plural(bad.length, 'element')} with onclick but no role or keyboard access`,
            evidence: list(bad.map(snippet), 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.main-landmark-missing',
      category: 'accessibility',
      pillar: C,
      title: 'No main landmark',
      why: 'A <main> element lets screen-reader users jump straight to the content, and helps parsers and agents separate content from navigation.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Wrap the primary content in a single <main> element.',
      refs: ['https://www.w3.org/WAI/ARIA/apg/practices/landmark-regions/'],
      tags: ['wcag-1.3.1'],
    },
    (page) =>
      isIndexable(page) && !els(page, 'main, [role="main"]').length
        ? { checkId: 'accessibility.main-landmark-missing', message: 'No <main> or role="main"' }
        : null,
  ),
  pageCheck(
    {
      id: 'accessibility.main-landmark-multiple',
      category: 'accessibility',
      pillar: C,
      title: 'More than one main landmark',
      why: 'A page should have one visible main region. Several confuse landmark navigation and content extraction.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Keep one <main> and use <section> or <article> for the other regions.',
      tags: ['wcag-1.3.1'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const n = els(page, 'main:not([hidden]), [role="main"]').length;
      return n > 1
        ? { checkId: 'accessibility.main-landmark-multiple', message: `${n} main landmarks` }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.skip-link-missing',
      category: 'accessibility',
      pillar: C,
      title: 'No skip link before a long navigation',
      why: 'Keyboard users have to tab through every menu item on every page without a "skip to content" link.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add a "Skip to main content" link as the first focusable element, pointing to the id of <main>.',
      refs: [U('bypass-blocks')],
      tags: ['wcag-2.4.1'],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const navLinks = els(page, 'nav a[href], header a[href]').length;
      if (navLinks < 15) return null;
      const first = els(page, 'a[href]').slice(0, 3);
      if (
        first.some(
          (a) =>
            (a.getAttribute('href') || '').startsWith('#') &&
            (a.getAttribute('href') || '').length > 1,
        )
      )
        return null;
      return {
        checkId: 'accessibility.skip-link-missing',
        message: `${navLinks} navigation links and no skip link`,
      };
    },
  ),
  pageCheck(
    {
      id: 'accessibility.duplicate-ids',
      category: 'accessibility',
      pillar: C,
      title: 'Duplicate id attributes',
      why: 'Labels, aria-labelledby and in-page links point at ids. When an id is used twice, they may point at the wrong element.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Make every id unique on the page (components rendered more than once often repeat them).',
      refs: [U('parsing')],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const counts = new Map<string, number>();
      for (const e of els(page, '[id]')) {
        const id = e.getAttribute('id') || '';
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const dups = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
      if (!dups.length) return null;
      const referenced = new Set(
        els(page, '[for], [aria-labelledby], [aria-describedby], [aria-controls]').flatMap((e) =>
          `${e.getAttribute('for') || ''} ${e.getAttribute('aria-labelledby') || ''} ${e.getAttribute('aria-describedby') || ''} ${e.getAttribute('aria-controls') || ''}`.split(
            /\s+/,
          ),
        ),
      );
      const hot = dups.filter((d) => referenced.has(d));
      return {
        checkId: 'accessibility.duplicate-ids',
        severity: hot.length ? 'medium' : 'low',
        message: `${plural(dups.length, 'duplicated id')}${hot.length ? `, ${hot.length} used by labels or ARIA` : ''}`,
        evidence: list(dups, 5),
      };
    },
  ),
  pageCheck(
    {
      id: 'accessibility.positive-tabindex',
      category: 'accessibility',
      pillar: C,
      title: 'Positive tabindex values',
      why: 'tabindex above 0 changes the keyboard order away from the visual order, which disorients keyboard and switch users.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use tabindex="0" or "-1" only, and order elements in the HTML the way they should be reached.',
      refs: [U('focus-order')],
      tags: ['wcag-2.4.3'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = els(page, '[tabindex]').filter((e) => Number(e.getAttribute('tabindex')) > 0);
      return bad.length
        ? {
            checkId: 'accessibility.positive-tabindex',
            message: `${plural(bad.length, 'element')} with tabindex > 0`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.iframe-title-missing',
      category: 'accessibility',
      pillar: C,
      title: 'Iframes without a title',
      why: 'Screen readers announce iframes by their title. Without one, users cannot tell a video from a map or a form.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add a short title to each iframe, for example title="Map of our office".',
      refs: [U('name-role-value')],
      tags: ['wcag-4.1.2'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = els(page, 'iframe').filter(
        (f) =>
          !(f.getAttribute('title') || f.getAttribute('aria-label')) &&
          f.getAttribute('aria-hidden') !== 'true' &&
          !/display:\s*none/i.test(f.getAttribute('style') || '') &&
          f.getAttribute('width') !== '0',
      );
      return bad.length
        ? {
            checkId: 'accessibility.iframe-title-missing',
            message: `${plural(bad.length, 'iframe')} without a title`,
            evidence: list(
              bad.map((f) => f.getAttribute('src') || ''),
              3,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.autoplay-audio',
      category: 'accessibility',
      pillar: C,
      title: 'Media that plays sound automatically',
      why: 'Audio that starts on its own talks over screen readers and startles visitors. Browsers usually block it anyway.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove autoplay, or add muted and provide visible controls.',
      refs: [U('audio-control')],
      tags: ['wcag-1.4.2'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = els(page, 'video[autoplay], audio[autoplay]').filter(
        (m) => !m.hasAttribute('muted'),
      );
      return bad.length
        ? {
            checkId: 'accessibility.autoplay-audio',
            message: `${plural(bad.length, 'media element')} autoplay with sound`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.video-captions-missing',
      category: 'accessibility',
      pillar: C,
      title: 'Videos without captions',
      why: 'Captions are needed by deaf and hard-of-hearing visitors, and give search and AI engines the spoken content as text.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Add <track kind="captions"> to self-hosted videos, and publish a transcript on the page.',
      refs: [U('captions-prerecorded')],
      tags: ['wcag-1.2.2'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = els(page, 'video').filter(
        (v) =>
          !v.hasAttribute('muted') &&
          !v.querySelector('track[kind="captions"], track[kind="subtitles"]'),
      );
      return bad.length
        ? {
            checkId: 'accessibility.video-captions-missing',
            message: `${plural(bad.length, 'video')} without a captions track`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.aria-hidden-focusable',
      category: 'accessibility',
      pillar: C,
      title: 'Focusable elements hidden from assistive technology',
      why: 'Links or buttons inside aria-hidden="true" can still receive keyboard focus, but screen readers announce nothing, so users land on a silent control.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove aria-hidden from containers with interactive content, or add tabindex="-1"/inert to the controls inside.',
      refs: [U('name-role-value')],
      tags: ['wcag-4.1.2'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = els(page, '[aria-hidden="true"]')
        .flatMap((h) => [h, ...Array.from(h.querySelectorAll(FOCUSABLE))])
        .filter(
          (e) =>
            e.matches(FOCUSABLE) &&
            !e.closest('[inert]') &&
            e.getAttribute('tabindex') !== '-1' &&
            !e.hasAttribute('disabled'),
        );
      return bad.length
        ? {
            checkId: 'accessibility.aria-hidden-focusable',
            message: `${plural(bad.length, 'focusable element')} inside aria-hidden`,
            evidence: list(bad.map(snippet), 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.invalid-role',
      category: 'accessibility',
      pillar: C,
      title: 'Unknown ARIA role values',
      why: 'An invalid role is ignored, so the element is exposed as something else and assistive technology and agents misread it.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use a valid WAI-ARIA role, or better, the native HTML element.',
      refs: ['https://www.w3.org/TR/wai-aria-1.2/#role_definitions'],
      tags: ['wcag-4.1.2'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = new Set<string>();
      for (const e of els(page, '[role]'))
        for (const r of (e.getAttribute('role') || '').trim().toLowerCase().split(/\s+/))
          if (r && !ROLES.has(r)) bad.add(r);
      return bad.size
        ? { checkId: 'accessibility.invalid-role', message: `Unknown roles: ${list([...bad])}` }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.invalid-aria-attribute',
      category: 'accessibility',
      pillar: C,
      title: 'Misspelled or unknown aria-* attributes',
      why: 'An aria attribute that does not exist (aria-labeledby, aria-role) does nothing, so the label or state you intended is never exposed.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Correct the attribute name (for example aria-labelledby, with two Ls).',
      refs: ['https://www.w3.org/TR/wai-aria-1.2/#state_prop_def'],
      tags: ['wcag-4.1.2'],
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const bad = new Set<string>();
      for (const m of page.html.matchAll(/\saria-([a-z]+)\s*=/gi))
        if (!ARIA_ATTRS.has(m[1].toLowerCase())) bad.add(`aria-${m[1].toLowerCase()}`);
      return bad.size
        ? {
            checkId: 'accessibility.invalid-aria-attribute',
            message: `Unknown attributes: ${list([...bad])}`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.broken-aria-reference',
      category: 'accessibility',
      pillar: C,
      title: 'Labels or ARIA references point at missing ids',
      why: 'label for, aria-labelledby and aria-describedby must reference an existing id. Broken references leave the control unnamed.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Make the referenced ids exist, or point the attribute at the right element.',
      refs: [U('info-and-relationships')],
      tags: ['wcag-1.3.1'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const d = adoc(page);
      const missing = new Set<string>();
      for (const e of els(page, 'label[for], [aria-labelledby], [aria-describedby]')) {
        const ids =
          `${e.getAttribute('for') || ''} ${e.getAttribute('aria-labelledby') || ''} ${e.getAttribute('aria-describedby') || ''}`
            .split(/\s+/)
            .filter(Boolean);
        for (const id of ids) if (!d.getElementById(id)) missing.add(id);
      }
      return missing.size
        ? {
            checkId: 'accessibility.broken-aria-reference',
            message: `${plural(missing.size, 'referenced id')} not found`,
            evidence: list([...missing], 5),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.svg-no-name',
      category: 'accessibility',
      pillar: C,
      title: 'Meaningful SVG images without a name',
      why: 'An SVG marked role="img" needs a <title> or aria-label, or it is announced as an unnamed image.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add aria-label or a <title> child to SVGs with role="img"; add aria-hidden="true" to decorative ones.',
      refs: [U('non-text-content')],
      tags: ['wcag-1.1.1'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = els(page, 'svg[role="img"]').filter(
        (s) =>
          !(
            s.getAttribute('aria-label') ||
            s.getAttribute('aria-labelledby') ||
            s.querySelector('title')?.textContent?.trim()
          ),
      );
      return bad.length
        ? {
            checkId: 'accessibility.svg-no-name',
            message: `${plural(bad.length, 'SVG image')} without a name`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.table-headers-missing',
      category: 'accessibility',
      pillar: C,
      title: 'Data tables without header cells',
      why: 'Without <th>, screen readers cannot say which column or row a value belongs to, and AI engines lose the structure of the data.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Mark header cells with <th> (and scope="col"/"row" where needed). Use CSS, not tables, for layout.',
      refs: [U('info-and-relationships')],
      tags: ['wcag-1.3.1'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = els(page, 'table').filter(
        (t) =>
          t.getAttribute('role') !== 'presentation' &&
          t.querySelectorAll('tr').length >= 3 &&
          t.querySelectorAll('tr')[0]?.querySelectorAll('td').length >= 2 &&
          !t.querySelector('th'),
      );
      return bad.length
        ? {
            checkId: 'accessibility.table-headers-missing',
            message: `${plural(bad.length, 'table')} with no <th> cells`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.list-structure',
      category: 'accessibility',
      pillar: C,
      title: 'List items outside a list',
      why: '<li> elements must sit inside <ul>, <ol> or <menu>. Stray items break the list semantics screen readers announce.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Wrap list items in a <ul> or <ol>.',
      refs: [U('info-and-relationships')],
      tags: ['wcag-1.3.1'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = els(page, 'li').filter((li) => {
        const p = li.parentElement;
        const tag = p?.tagName.toLowerCase();
        return (
          !p ||
          !(tag === 'ul' || tag === 'ol' || tag === 'menu' || p.getAttribute('role') === 'list')
        );
      });
      return bad.length
        ? {
            checkId: 'accessibility.list-structure',
            message: `${plural(bad.length, '<li>')} not inside a list`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'accessibility.obsolete-motion',
      category: 'accessibility',
      pillar: C,
      title: 'Blinking or scrolling text elements',
      why: '<marquee> and <blink> move content that users cannot pause, which fails WCAG and distracts people with attention or vestibular conditions.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Replace them with static text, or CSS animation that respects prefers-reduced-motion and can be paused.',
      refs: [U('pause-stop-hide')],
      tags: ['wcag-2.2.2'],
    },
    (page) =>
      isHtml200(page) && els(page, 'marquee, blink').length
        ? { checkId: 'accessibility.obsolete-motion', message: 'Page uses <marquee> or <blink>' }
        : null,
  ),
  pageCheck(
    {
      id: 'accessibility.low-contrast-inline',
      category: 'accessibility',
      pillar: C,
      title: 'Low colour contrast in inline styles',
      why: `Text below a ${CONTRAST_MIN}:1 contrast ratio with its background is hard to read for many people. This check only sees colours set inline in the HTML.`,
      severity: 'low',
      fixTier: 'guided',
      fix: `Darken the text or lighten the background until the ratio is at least ${CONTRAST_MIN}:1 (${CONTRAST_MIN_LARGE}:1 for large text).`,
      refs: [U('contrast-minimum')],
      tags: ['wcag-1.4.3'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad: string[] = [];
      for (const e of els(page, '[style*="color"]')) {
        const style = e.getAttribute('style') || '';
        const fg = /(?:^|;)\s*color\s*:\s*([^;!]+)/i.exec(style)?.[1];
        const bg = /background(?:-color)?\s*:\s*([^;!]+)/i.exec(style)?.[1];
        if (!fg || !bg || !(e.textContent || '').trim()) continue;
        const a = parseColour(fg);
        const b = parseColour(bg.split(/\s+/)[0]);
        if (!a || !b) continue;
        const r = contrastRatio(a, b);
        if (r != null && r < CONTRAST_MIN)
          bad.push(`${a} on ${b} (${r.toFixed(1)}:1) "${truncate(e.textContent, 30)}"`);
      }
      return bad.length
        ? {
            checkId: 'accessibility.low-contrast-inline',
            message: `${plural(bad.length, 'element')} below ${CONTRAST_MIN}:1 contrast`,
            evidence: list(bad, 3),
          }
        : null;
    },
  ),
];

// ---------------------------------------------------------------------------
// Added for feature parity: rendered contrast and ARIA role nesting
// ---------------------------------------------------------------------------

/** Roles that only make sense inside a given parent role (WAI-ARIA required context). */
export const REQUIRED_CONTEXT: Record<string, string[]> = {
  listitem: ['list', 'group', 'directory'],
  option: ['listbox', 'group'],
  tab: ['tablist'],
  menuitem: ['menu', 'menubar', 'group'],
  menuitemcheckbox: ['menu', 'menubar', 'group'],
  menuitemradio: ['menu', 'menubar', 'group'],
  treeitem: ['tree', 'group'],
  row: ['table', 'grid', 'treegrid', 'rowgroup'],
  cell: ['row'],
  gridcell: ['row'],
  columnheader: ['row'],
  rowheader: ['row'],
};

const IMPLICIT_ROLE: Record<string, string> = {
  ul: 'list',
  ol: 'list',
  menu: 'list',
  table: 'table',
  tr: 'row',
  thead: 'rowgroup',
  tbody: 'rowgroup',
  tfoot: 'rowgroup',
  select: 'listbox',
  datalist: 'listbox',
  optgroup: 'group',
};

function roleOf(el: Element): string | null {
  const r = el.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase();
  return r || IMPLICIT_ROLE[el.tagName.toLowerCase()] || null;
}

checks.push(
  cu.pageCheck(
    {
      id: 'accessibility.role-nesting',
      category: 'accessibility',
      pillar: C,
      title: 'ARIA roles used outside their required parent',
      why: 'Roles such as tab, option, menuitem and row only work inside their container role (tablist, listbox, menu, table). Out of place, screen readers and AI agents that read the accessibility tree cannot tell what the control belongs to.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Wrap the elements in the container role (for example role="tablist" around role="tab"), or remove the role if the element is not that kind of control.',
      refs: [
        'https://www.w3.org/TR/wai-aria-1.2/#scope',
        'https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html',
      ],
      tags: ['wcag-1.3.1', 'agentic'],
    },
    (page) => {
      if (!cu.isHtml200(page)) return null;
      const bad: string[] = [];
      for (const el of Array.from(adoc(page).querySelectorAll('[role]'))) {
        const role = roleOf(el);
        const need = role ? REQUIRED_CONTEXT[role] : undefined;
        if (!need) continue;
        let ok = false;
        for (let p = el.parentElement; p && !ok; p = p.parentElement) {
          const pr = roleOf(p);
          if (pr && need.includes(pr)) ok = true;
          // Stop at the first ancestor that has a role of its own (other than generic wrappers).
          else if (
            p.getAttribute('role') &&
            p.getAttribute('role') !== 'presentation' &&
            p.getAttribute('role') !== 'none'
          )
            break;
        }
        if (!ok) bad.push(`role="${role}" in <${el.parentElement?.tagName.toLowerCase() ?? '?'}>`);
        if (bad.length >= 20) break;
      }
      return bad.length
        ? {
            checkId: 'accessibility.role-nesting',
            message: `${cu.plural(bad.length, 'element')} with a role outside its required container`,
            evidence: list(bad, 4),
          }
        : null;
    },
  ),
  cu.pageCheck(
    {
      id: 'accessibility.low-contrast-rendered',
      category: 'accessibility',
      pillar: C,
      title: 'Low colour contrast in the rendered page',
      why: 'Text below 4.5:1 contrast (3:1 for large text) is hard to read for many people and in bright light. Measured from the computed colours in a browser render, including stylesheets, not only inline styles.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Darken the text or lighten the background in your stylesheet until each listed sample reaches 4.5:1 (3:1 for text of 24px, or 18.66px bold, and larger).',
      requires: ['render'],
      refs: [U('contrast-minimum')],
      tags: ['wcag-1.4.3'],
    },
    (page) => {
      const low = page.rendered?.layout?.lowContrast ?? [];
      if (low.length < 2) return null;
      return {
        checkId: 'accessibility.low-contrast-rendered',
        message: `${cu.plural(low.length, 'text sample')} below the WCAG AA contrast ratio`,
        evidence: list(
          low.map((l) => `"${truncate(l.text, 30)}" ${l.ratio}:1 (${l.fg} on ${l.bg})`),
          4,
        ),
      };
    },
  ),
);
