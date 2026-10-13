/**
 * Accessibility, mobile and small on-page recipes (icons, meta keywords). Accessibility
 * fixes also help AI agents: they read the same names, roles and labels as screen readers.
 */
import { byStack, seoPluginLabel, templateFile } from '../stacks.js';
import type { Recipe, RecipeInput, StackFix } from '../types.js';
import { evidenceStep, urlsBlock, verifyStep } from './common.js';

interface Example {
  title: string;
  lead: string;
  html: string;
  jsx?: string;
  wp: string;
  shopify?: string;
}

/** Per-stack wrapper around a markup example. */
function markupFix(input: RecipeInput, ex: Example): StackFix {
  const jsx = ex.jsx ?? ex.html;
  const component = byStack(input, {
    'nextjs-app': () => ({
      steps: [
        'Fix it in the shared component that renders this markup (one change fixes every page), then in any page-specific JSX. `eslint-plugin-jsx-a11y` (included in `eslint-config-next`) flags most of these at build time.',
      ],
      files: ['components/*', 'app/<route>/page.tsx'],
      snippet: { language: 'tsx', code: jsx },
    }),
    'nextjs-pages': () => ({
      steps: [
        'Fix it in the shared component, then in page JSX. `eslint-plugin-jsx-a11y` (in `eslint-config-next`) flags most of these.',
      ],
      files: ['components/*', 'pages/<route>.tsx'],
      snippet: { language: 'tsx', code: jsx },
    }),
    nuxt: () => ({
      steps: [
        'Fix the Vue component that renders it; `eslint-plugin-vuejs-accessibility` flags most of these.',
      ],
      files: ['components/*.vue'],
      snippet: { language: 'html', code: ex.html },
    }),
    'vue-spa': () => ({
      steps: [
        'Fix the Vue component that renders it; `eslint-plugin-vuejs-accessibility` flags most of these.',
      ],
      files: ['src/components/*.vue'],
      snippet: { language: 'html', code: ex.html },
    }),
    'react-spa': () => ({
      steps: [
        'Fix the React component that renders it; `eslint-plugin-jsx-a11y` flags most of these.',
      ],
      files: ['src/components/*'],
      snippet: { language: 'tsx', code: jsx },
    }),
    wordpress: () => ({
      steps: [ex.wp],
      files: ['WordPress editor / page builder', 'theme templates (child theme)'],
      snippet: { language: 'html', code: ex.html },
    }),
    shopify: () => ({
      steps: [
        ex.shopify ??
          'Fix it in the theme section or snippet that renders the markup (Online Store → Themes → Edit code), or in the content editor’s HTML view for page content. Check app blocks too.',
      ],
      files: ['sections/*.liquid', 'snippets/*.liquid'],
      snippet: { language: 'html', code: ex.html },
    }),
    hosted: () => ({
      steps: [
        'Fix it in the site editor: element settings usually have fields for labels, alt text and ARIA labels. For custom code embeds, edit the HTML directly.',
      ],
      files: ['Site editor: element settings', 'custom code embeds'],
      snippet: { language: 'html', code: ex.html },
    }),
    unknown: () => ({
      steps: ['Fix the template or component that renders the markup:'],
      files: [templateFile(input)],
      snippet: { language: 'html', code: ex.html },
    }),
  });
  return {
    ...component,
    title: ex.title,
    steps: [
      ex.lead,
      ...evidenceStep(input),
      ...component.steps,
      ...urlsBlock(input),
      verifyStep(
        input,
        'Check with a screen reader or the browser’s accessibility tree (DevTools → Elements → Accessibility).',
      ),
    ],
  };
}

const A11Y: Record<string, Example> = {
  'form-label-missing': {
    title: 'Label every form field',
    lead: 'Give every field a visible `<label for>` (or wrap the field in the label). Use `aria-label` only when a visible label is impossible. Placeholders are not labels: they vanish on typing and many tools ignore them.',
    html: '<label for="email">Email address</label>\n<input id="email" name="email" type="email" autocomplete="email" />',
    jsx: '<label htmlFor="email">Email address</label>\n<input id="email" name="email" type="email" autoComplete="email" />',
    wp: 'In form plugins (Contact Form 7, WPForms, Gravity Forms) keep the field label switched on — “hide label” settings often remove it from the markup. In Contact Form 7, wrap each tag: `<label>Email [email* your-email]</label>`.',
    shopify:
      'In `sections/contact-form.liquid`, `footer.liquid` (newsletter) and `main-search.liquid`, make sure each `<input>` has a `<label for>` matching its `id` (Dawn uses visually hidden labels; keep them).',
  },
  'link-name-missing': {
    title: 'Give icon and image links a name',
    lead: 'Links with only an icon or image have no accessible name. Add visible text, an `aria-label`, or alt text on the image that says where the link goes.',
    html: '<a href="https://www.linkedin.com/company/acme" aria-label="Acme on LinkedIn">\n  <svg aria-hidden="true" focusable="false">…</svg>\n</a>\n\n<a href="/"><img src="/logo.svg" alt="Acme home" /></a>',
    jsx: '<a href="https://www.linkedin.com/company/acme" aria-label="Acme on LinkedIn">\n  <LinkedInIcon aria-hidden="true" />\n</a>',
    wp: 'For social icon blocks, fill in the label for each icon (block settings → “Link label”). For image links, set the image alt text to describe the destination. Theme icon menus usually need a label per menu item.',
  },
  'button-name-missing': {
    title: 'Give icon buttons a name',
    lead: 'Buttons with only an icon are announced as “button”. Add visible text or an `aria-label` that says what the button does, and `alt` on `<input type="image">`.',
    html: '<button type="button" aria-label="Open menu" aria-expanded="false">\n  <svg aria-hidden="true" focusable="false">…</svg>\n</button>',
    jsx: '<button type="button" aria-label="Open menu" aria-expanded={open}>\n  <MenuIcon aria-hidden="true" />\n</button>',
    wp: 'Icon buttons usually come from the theme (menu toggle, search, cart) or a page builder. Page builders have an “aria-label” or “accessible name” field on buttons; for theme buttons, edit the template in a child theme.',
  },
  'iframe-title-missing': {
    title: 'Give each iframe a title',
    lead: 'Screen readers announce iframes by their title. Add a short one that says what it is.',
    html: '<iframe src="https://www.youtube-nocookie.com/embed/…" title="Video: how our boiler service works" loading="lazy"></iframe>',
    wp: 'The YouTube/Vimeo embed blocks add a title automatically; embeds pasted as HTML or from map/form plugins often do not. Edit the HTML and add `title="…"`.',
  },
  'svg-no-name': {
    title: 'Name meaningful SVGs, hide decorative ones',
    lead: 'SVGs with `role="img"` need a name. Add `aria-label` or a `<title>` child to meaningful ones, and `aria-hidden="true"` to decorative ones.',
    html: '<svg role="img" aria-labelledby="chart-title" viewBox="0 0 400 200">\n  <title id="chart-title">Enquiries per month, 2025</title>\n  …\n</svg>\n\n<svg aria-hidden="true" focusable="false">…</svg>',
    wp: 'Icon plugins and page builders usually have a “decorative” or “aria-hidden” toggle for icons; for meaningful SVGs, add a title in the SVG source before uploading.',
  },
  'clickable-div': {
    title: 'Use buttons and links, not clickable divs',
    lead: 'Elements with `onclick` that are not buttons or links cannot be reached by keyboard and are invisible as controls to screen readers and AI agents. Use `<button>` for actions and `<a href>` for navigation.',
    html: '<!-- before: <div class="card" onclick="openModal()">Book a call</div> -->\n<button type="button" class="card" onclick="openModal()">Book a call</button>',
    jsx: '// before: <div onClick={openModal}>Book a call</div>\n<button type="button" onClick={openModal}>Book a call</button>',
    wp: 'This usually comes from a page builder “click action” on a column or container. Use a button or link widget instead, or set the link on the heading inside the container.',
  },
  'main-landmark-missing': {
    title: 'Wrap the main content in <main>',
    lead: 'Wrap the primary content of every page in a single `<main>` element (outside the header, navigation and footer).',
    html: '<header>…</header>\n<main id="main">\n  <h1>…</h1>\n  …\n</main>\n<footer>…</footer>',
    jsx: '// app/layout.tsx\n<body>\n  <Header />\n  <main id="main">{children}</main>\n  <Footer />\n</body>',
    wp: 'Block themes: in the Site Editor, select the template’s content group and set Advanced → HTML element to `<main>`. Classic themes: edit `header.php`/`footer.php` (child theme) so the content area is wrapped in `<main id="main">`.',
    shopify:
      'In `layout/theme.liquid`, wrap `{{ content_for_layout }}` in `<main id="MainContent" role="main">` (Dawn already does).',
  },
  'main-landmark-multiple': {
    title: 'Keep one <main> per page',
    lead: 'Keep one `<main>` per page. Change the others to `<section>` or `<article>` (often a component that adds its own `<main>` inside the layout’s).',
    html: '<main id="main">\n  <article>…</article>\n  <section aria-labelledby="related">…</section>\n</main>',
    wp: 'Usually the theme wraps content in `<main>` and a block or page-builder section adds another. In the Site Editor set the inner group’s HTML element to `<section>`.',
  },
  'skip-link-missing': {
    title: 'Add a “Skip to main content” link',
    lead: 'Add a skip link as the first focusable element, visible on focus, pointing at the id of `<main>`.',
    html: '<a class="skip-link" href="#main">Skip to main content</a>\n<header>…</header>\n<main id="main" tabindex="-1">…</main>\n\n<style>\n.skip-link { position: absolute; left: -9999px; }\n.skip-link:focus { left: 1rem; top: 1rem; z-index: 1000; }\n</style>',
    jsx: '// app/layout.tsx\n<body>\n  <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4">\n    Skip to main content\n  </a>\n  <Header />\n  <main id="main" tabIndex={-1}>{children}</main>\n</body>',
    wp: 'Block themes add a skip link automatically when the template has a `<main>` element. Classic themes: add the link right after `wp_body_open()` in `header.php` (child theme).',
  },
  'duplicate-ids': {
    title: 'Make every id unique',
    lead: 'Each id must appear once per page. Components rendered more than once (cards, accordions, forms in header and footer) are the usual cause: generate the id per instance.',
    html: '<!-- render-time unique ids -->\n<label for="newsletter-footer-email">Email</label>\n<input id="newsletter-footer-email" />',
    jsx: 'import { useId } from \'react\';\n\nfunction EmailField() {\n  const id = useId();\n  return (\n    <>\n      <label htmlFor={id}>Email</label>\n      <input id={id} type="email" />\n    </>\n  );\n}',
    wp: 'Often the same form or widget appears twice (header and footer). Most form plugins add a unique suffix; for hand-written HTML blocks, rename the ids.',
    shopify:
      'Use `section.id` or `block.id` in ids: `id="Email-{{ section.id }}"`, so repeated sections stay unique.',
  },
  'positive-tabindex': {
    title: 'Remove positive tabindex values',
    lead: 'Use `tabindex="0"` (focusable in normal order) or `tabindex="-1"` (focusable by script only). Order elements in the HTML the way they should be reached instead of using positive values.',
    html: '<!-- before: <input tabindex="3"> -->\n<input />',
    wp: "Positive tabindex usually comes from a form plugin setting (Gravity Forms “tabindex”) or a theme. Turn it off: `add_filter( 'gform_tabindex', '__return_false' );`.",
  },
  'autoplay-audio': {
    title: 'Stop media playing sound on load',
    lead: 'Remove autoplay from media with sound, or mute it and show controls so visitors can start it.',
    html: '<video src="/intro.mp4" muted playsinline controls preload="metadata"></video>',
    jsx: '<video src="/intro.mp4" muted playsInline controls preload="metadata" />',
    wp: 'In the Video/Audio block settings, switch off Autoplay (or switch on Muted). For YouTube embeds, remove `autoplay=1` from the URL.',
  },
  'video-captions-missing': {
    title: 'Add captions and a transcript to videos',
    lead: 'Add a captions track to self-hosted videos and publish a transcript on the page. The transcript also gives search and AI engines the spoken content as text.',
    html: '<video controls src="/intro.mp4">\n  <track kind="captions" src="/intro.en.vtt" srclang="en" label="English" default />\n</video>\n<details>\n  <summary>Transcript</summary>\n  <p>…</p>\n</details>',
    jsx: '<video controls src="/intro.mp4">\n  <track kind="captions" src="/intro.en.vtt" srcLang="en" label="English" default />\n</video>',
    wp: 'Video block → “Text tracks” lets you upload a .vtt captions file. For YouTube, upload or check captions in YouTube Studio and add the transcript under the embed.',
  },
  'aria-hidden-focusable': {
    title: 'Do not hide focusable controls with aria-hidden',
    lead: 'Links or buttons inside `aria-hidden="true"` still take keyboard focus but are announced as nothing. Remove aria-hidden from containers with interactive content, or make the controls unfocusable with `inert` (preferred) or `tabindex="-1"`.',
    html: '<!-- closed off-canvas menu -->\n<nav id="mobile-menu" inert>\n  <a href="/services/">Services</a>\n</nav>',
    jsx: '<nav id="mobile-menu" inert={!open}>\n  <Link href="/services">Services</Link>\n</nav>',
    wp: 'Usually a theme’s closed mobile menu, a slider’s off-screen slides or a popup. Update the theme/plugin, or report it to the developer; carousels should use `inert` on hidden slides.',
  },
  'invalid-role': {
    title: 'Use valid ARIA roles (or the native element)',
    lead: 'Unknown role values are ignored. Use a valid WAI-ARIA role — or better, the native HTML element (`<button>`, `<nav>`, `<ul>`) and no role at all.',
    html: '<!-- before: <div role="nav"> -->\n<nav aria-label="Main">…</nav>',
    wp: 'Search the theme and HTML blocks for the role value shown in the evidence and correct it.',
  },
  'invalid-aria-attribute': {
    title: 'Correct misspelt aria-* attributes',
    lead: 'Unknown aria attributes do nothing. Correct the name — the usual ones are `aria-labelledby` (two Ls) and `aria-describedby`; there is no `aria-role` (use `role`).',
    html: '<!-- before: <section aria-labeledby="h"> -->\n<section aria-labelledby="h">\n  <h2 id="h">Services</h2>\n</section>',
    wp: 'Search the theme and HTML blocks for the attribute shown in the evidence and correct it.',
  },
  'broken-aria-reference': {
    title: 'Point labels and ARIA references at real ids',
    lead: '`for`, `aria-labelledby`, `aria-describedby` and `aria-controls` must reference an id that exists on the page. Add the id or point the attribute at the right element.',
    html: '<label for="phone">Phone</label>\n<input id="phone" type="tel" aria-describedby="phone-hint" />\n<p id="phone-hint">We only call about your booking.</p>',
    jsx: 'const id = useId();\n<label htmlFor={id}>Phone</label>\n<input id={id} type="tel" aria-describedby={`${id}-hint`} />\n<p id={`${id}-hint`}>We only call about your booking.</p>',
    wp: 'Form plugins generate matching ids; broken references usually come from hand-written HTML or a field whose id was changed. Fix the ids in the HTML block or form settings.',
  },
  'table-headers-missing': {
    title: 'Mark table header cells with <th>',
    lead: 'Mark header cells with `<th>` (with `scope="col"`/`"row"`) and add a `<caption>`. Use CSS grid, not tables, for layout.',
    html: '<table>\n  <caption>Prices from April 2026</caption>\n  <thead><tr><th scope="col">Service</th><th scope="col">Price</th></tr></thead>\n  <tbody><tr><th scope="row">Boiler service</th><td>£90</td></tr></tbody>\n</table>',
    wp: 'Table block → settings: switch on “Header section” and add a caption. Table plugins (TablePress) have a “first row is header” option.',
  },
  'list-structure': {
    title: 'Put list items inside a list',
    lead: 'Every `<li>` must sit directly inside `<ul>`, `<ol>` or `<menu>`.',
    html: '<ul>\n  <li>Boiler repair</li>\n  <li>Annual service</li>\n</ul>',
    wp: 'Usually from HTML blocks or a page builder widget that outputs `<li>` without a list. Use the List block, or correct the HTML.',
  },
  'obsolete-motion': {
    title: 'Replace <marquee> and <blink>',
    lead: 'Replace `<marquee>`/`<blink>` with static text. If you need motion, use CSS animation that can be paused and stops for `prefers-reduced-motion`.',
    html: '<p class="notice">Free delivery on orders over £50</p>\n\n<style>\n@media (prefers-reduced-motion: no-preference) {\n  .notice { animation: slide 20s linear infinite; }\n  .notice:hover, .notice:focus-within { animation-play-state: paused; }\n}\n</style>',
    wp: 'Usually an old “announcement bar” or ticker plugin. Replace it with a static notice block.',
  },
};

const a11y: Recipe = {
  id: 'accessibility',
  patterns: [new RegExp(`^accessibility\\.(${Object.keys(A11Y).join('|')})$`)],
  impact: 'low',
  effort: 'hours',
  build(input) {
    const key = input.def.id.replace('accessibility.', '');
    return markupFix(
      input,
      A11Y[key] ?? {
        title: input.def.title,
        lead: input.def.fix,
        html: '<!-- use the native element with a visible label -->\n<button type="button">Open menu</button>',
        wp: 'Fix it in the block or page-builder settings, or in a child-theme template.',
      },
    );
  },
};

// ---------------------------------------------------------------------------
// Readability: contrast and small text
// ---------------------------------------------------------------------------

const readability: Recipe = {
  id: 'readability',
  patterns: [/^accessibility\.low-contrast-inline$/, /^mobile\.(small-text|fixed-width)$/],
  impact: 'low',
  effort: 'hours',
  build(input) {
    const id = input.def.id;
    const contrast = id.endsWith('contrast-inline');
    const width = id.endsWith('fixed-width');
    const css = contrast
      ? `/* text colour vs background: at least 4.5:1 (3:1 for large text) */
:root { --text: #1f2933; --muted: #52606d; --bg: #ffffff; }
body { color: var(--text); background: var(--bg); }
.muted { color: var(--muted); } /* 6.4:1 on white */`
      : width
        ? `img, video, iframe, table { max-width: 100%; }
img, video { height: auto; }
.table-wrap { overflow-x: auto; }   /* wrap wide tables */
.container { width: min(100% - 2rem, 70rem); margin-inline: auto; }`
        : `html { font-size: 100%; }          /* 16px, respects user settings */
body { font-size: 1rem; line-height: 1.5; }
small, .caption { font-size: 0.875rem; } /* 14px, nothing under 12px */`;
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Remove the inline `style={{ … }}` values and use your CSS (or Tailwind theme tokens) instead, so one change fixes every page.',
        ],
        files: ['app/globals.css', 'tailwind config / theme tokens', 'components/*'],
      }),
      wordpress: () => ({
        steps: [
          contrast
            ? 'Inline colours come from block colour settings or the page builder. Pick palette colours with enough contrast (the editor warns “This colour combination may be hard to read”), and fix the theme palette in Appearance → Editor → Styles.'
            : width
              ? 'Fixed widths usually come from tables, embeds or page-builder columns set in px. Set them to 100% / auto, and wrap wide tables in a scroll container.'
              : 'Font sizes come from the block typography settings or the theme. Set body text to at least 16px in Appearance → Editor → Styles → Typography (or the Customizer).',
        ],
        files: ['Appearance → Editor → Styles', 'Additional CSS'],
      }),
      shopify: () => ({
        steps: [
          contrast
            ? 'Adjust colour schemes in Online Store → Themes → Customize → Theme settings → Colors, and remove inline colours from rich-text content.'
            : 'Adjust typography in Theme settings, and override remaining sizes in `assets/base.css` (or a custom CSS block).',
        ],
        files: ['Theme settings', 'assets/base.css'],
      }),
      hosted: () => ({
        steps: [
          'Adjust the site’s colour and typography styles in the designer; avoid one-off overrides on individual elements.',
        ],
        files: ['Site designer: styles'],
      }),
      unknown: () => ({
        steps: ['Replace the inline styles with stylesheet rules:'],
        files: ['main stylesheet', templateFile(input)],
      }),
    });
    return {
      ...fix,
      title: contrast
        ? 'Raise text contrast to at least 4.5:1'
        : width
          ? 'Remove fixed widths wider than a phone'
          : 'Use readable text sizes on mobile',
      snippet: { language: 'css', code: css },
      steps: [
        contrast
          ? 'Some text has a contrast ratio below 4.5:1 with its background (3:1 is enough for text 24px+ or 19px bold). Darken the text or lighten the background. Check pairs with the WebAIM contrast checker.'
          : width
            ? 'Elements with inline widths over about 640px force sideways scrolling on phones. Use `max-width: 100%` or relative units.'
            : 'Text below 12px is hard to read on phones. Use at least 16px for body text and nothing under 12px.',
        ...evidenceStep(input),
        ...fix.steps,
        ...urlsBlock(input),
        verifyStep(input),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Mobile
// ---------------------------------------------------------------------------

const zoom: Recipe = {
  id: 'zoom-disabled',
  patterns: [/^mobile\.zoom-disabled$/],
  impact: 'medium',
  effort: 'minutes',
  build(input) {
    const tag = '<meta name="viewport" content="width=device-width, initial-scale=1" />';
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          'Export `viewport` from `app/layout.tsx` without `maximumScale` or `userScalable: false` (Next.js already outputs a sensible default if you export nothing).',
        ],
        files: ['app/layout.tsx'],
        snippet: {
          language: 'ts',
          code: `import type { Viewport } from 'next';\n\nexport const viewport: Viewport = { width: 'device-width', initialScale: 1 };`,
        },
      }),
      wordpress: () => ({
        steps: [
          'The viewport tag comes from the theme’s `header.php` (or a plugin). Override it in a child theme, removing `maximum-scale` and `user-scalable=no`.',
        ],
        files: ['header.php (child theme)'],
        snippet: { language: 'html', code: tag },
      }),
      shopify: () => ({
        steps: ['Edit the viewport meta tag in `layout/theme.liquid`.'],
        files: ['layout/theme.liquid'],
        snippet: { language: 'html', code: tag },
      }),
      hosted: () => ({
        steps: [
          'The platform outputs the viewport tag. If custom head code adds a second one with `user-scalable=no`, remove it.',
        ],
        files: ['Custom code (head)'],
      }),
      unknown: () => ({
        steps: ['Use this viewport tag in the shared layout:'],
        files: [templateFile(input)],
        snippet: { language: 'html', code: tag },
      }),
    });
    return {
      ...fix,
      title: 'Allow pinch-zoom',
      steps: [
        '`user-scalable=no` or a low `maximum-scale` stops people with low vision from zooming (WCAG 1.4.4). Remove both.',
        ...evidenceStep(input),
        ...fix.steps,
        verifyStep(input),
      ],
    };
  },
};

const inputTypes: Recipe = {
  id: 'input-types',
  patterns: [/^mobile\.input-types$/],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    return markupFix(input, {
      title: 'Use email and tel input types',
      lead: 'Set `type="email"` on email fields and `type="tel"` on phone fields, with matching `autocomplete` values. Phones show the right keyboard, and browsers and AI agents can fill the form correctly.',
      html: '<label for="email">Email</label>\n<input id="email" name="email" type="email" autocomplete="email" />\n<label for="tel">Phone</label>\n<input id="tel" name="tel" type="tel" autocomplete="tel" />',
      jsx: '<input id="email" name="email" type="email" autoComplete="email" />\n<input id="tel" name="tel" type="tel" autoComplete="tel" />',
      wp: 'In the form plugin, use the dedicated Email and Phone field types rather than a single-line text field (Contact Form 7: `[email]` and `[tel]` tags).',
    });
  },
};

const plugins: Recipe = {
  id: 'browser-plugins',
  patterns: [/^mobile\.plugins$/],
  impact: 'medium',
  effort: 'days',
  tier: 'manual',
  build(input) {
    return markupFix(input, {
      title: 'Replace plugin-based content',
      lead: 'Flash, Java applets, Silverlight and similar `<object>`/`<embed>` content no longer runs in browsers and cannot be read by crawlers. Replace it with HTML5 video, images or plain HTML; rebuild interactive pieces in JavaScript.',
      html: '<!-- before: <object data="tour.swf"></object> -->\n<video controls src="/tour.mp4" poster="/tour.jpg">\n  <track kind="captions" src="/tour.en.vtt" srclang="en" label="English" />\n</video>\n<p>Text description of what the tour shows…</p>',
      wp: 'Remove old Flash/embed shortcodes and replace them with the Video, Image or Gallery blocks. Convert old .swf/.flv files to MP4 first.',
    });
  },
};

const mobileUrls: Recipe = {
  id: 'separate-mobile-urls',
  patterns: [/^mobile\.separate-mobile-urls$/],
  impact: 'medium',
  effort: 'days',
  tier: 'manual',
  build(input) {
    const m = input.host.replace(/^www\./, 'm.');
    return {
      title: 'Move from m-dot URLs to a responsive site',
      steps: [
        'Google indexes the mobile version of each page, and separate m-dot sites need perfect annotations and content parity. A single responsive site removes that risk.',
        'Long term: serve one responsive site on the main domain and 301-redirect every m-dot URL to its equivalent (page to page, not all to the home page).',
        'Until then: every desktop page needs `<link rel="alternate" media="only screen and (max-width: 640px)">` to its mobile URL, and every mobile page needs `<link rel="canonical">` back to the desktop URL. The mobile page must carry the same content, structured data, titles and descriptions.',
        'Detect phones the same way for all user agents (including Googlebot Smartphone) and send `Vary: User-Agent` if you redirect by device.',
        ...urlsBlock(input),
      ],
      files: [templateFile(input), 'server redirect rules'],
      snippet: {
        language: 'html',
        code: `<!-- desktop page -->
<link rel="alternate" media="only screen and (max-width: 640px)" href="https://${m}/page/" />

<!-- mobile page -->
<link rel="canonical" href="${input.origin}/page/" />`,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Icons and meta keywords
// ---------------------------------------------------------------------------

const icons: Recipe = {
  id: 'site-icons',
  patterns: [/^onpage\.favicon-missing$/, /^mobile\.touch-icon-missing$/],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    const touch = input.def.id.startsWith('mobile.');
    const tags = touch
      ? '<link rel="apple-touch-icon" href="/apple-touch-icon.png" /> <!-- 180×180 PNG -->'
      : '<link rel="icon" href="/favicon.ico" sizes="any" />\n<link rel="icon" href="/icon.svg" type="image/svg+xml" />\n<link rel="apple-touch-icon" href="/apple-touch-icon.png" />';
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: [
          touch
            ? 'Add `app/apple-icon.png` (180×180). Next.js generates the `<link rel="apple-touch-icon">` tag from it.'
            : 'Add `app/favicon.ico` and `app/icon.png` (or `icon.svg`, at least 48×48 and square). Next.js generates the `<link rel="icon">` tags from these files.',
        ],
        files: touch ? ['app/apple-icon.png'] : ['app/favicon.ico', 'app/icon.png'],
      }),
      wordpress: () => ({
        steps: [
          'Appearance → Customize → Site Identity → Site Icon (or Settings → General → Site Icon in block themes): upload a square image at least 512×512. WordPress outputs the favicon and apple-touch-icon tags.',
        ],
        files: ['WordPress: Site Icon'],
      }),
      shopify: () => ({
        steps: [
          'Online Store → Themes → Customize → Theme settings → Logo → Favicon: upload a square image (at least 180×180, so it doubles as the touch icon). Add an apple-touch-icon link in `layout/theme.liquid` if the theme does not.',
        ],
        files: ['Theme settings → Favicon', 'layout/theme.liquid'],
      }),
      hosted: () => ({
        steps: [
          'Upload the favicon and webclip/touch icon in the site settings (Webflow: Site settings → General → Favicon and Webclip; Wix: Settings → Favicon; Squarespace: Design → Browser icon).',
        ],
        files: ['Site settings → Favicon / Webclip'],
      }),
      unknown: () => ({
        steps: ['Put the icon files at the site root and add the tags to the shared `<head>`:'],
        files: ['favicon.ico', 'icon.svg', 'apple-touch-icon.png', templateFile(input)],
        snippet: { language: 'html', code: tags },
      }),
    });
    return {
      ...fix,
      title: touch ? 'Add an apple-touch-icon' : 'Add a favicon',
      steps: [
        touch
          ? 'The touch icon is used when people save the site to a phone home screen and by some apps for link previews.'
          : 'Google shows the favicon beside your result, and AI tools show it beside citations. Use a square image at least 48×48 on a stable URL that Googlebot may crawl.',
        ...fix.steps,
        verifyStep(input),
      ],
    };
  },
};

const metaKeywords: Recipe = {
  id: 'meta-keywords',
  patterns: [/^onpage\.meta-keywords$/],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    const fix = byStack(input, {
      'nextjs-app': () => ({
        steps: ['Remove `keywords` from `metadata` in `app/layout.tsx` and the page files.'],
        files: ['app/layout.tsx', 'app/<route>/page.tsx'],
      }),
      'nextjs-pages': () => ({
        steps: ['Remove `<meta name="keywords">` from `next/head` / your SEO component.'],
        files: ['components/seo.tsx', 'pages/_document.tsx'],
      }),
      wordpress: () => ({
        steps: [
          `Turn off meta keywords in ${seoPluginLabel(input.stack)} (All in One SEO: Search Appearance → Advanced → “Use Meta Keywords”) or remove the tag from the theme’s header.php.`,
        ],
        files: ['WordPress: SEO plugin settings', 'header.php'],
      }),
      shopify: () => ({
        steps: [
          'Remove the `<meta name="keywords">` line from `layout/theme.liquid` or the SEO snippet.',
        ],
        files: ['layout/theme.liquid', 'snippets/meta-tags.liquid'],
      }),
      unknown: () => ({
        steps: ['Delete the `<meta name="keywords">` tag from the shared layout.'],
        files: [templateFile(input)],
      }),
    });
    return {
      ...fix,
      title: 'Remove the meta keywords tag',
      steps: [
        'Google and Bing ignore meta keywords; the tag only shows competitors which terms you target.',
        ...fix.steps,
        verifyStep(input),
      ],
    };
  },
};

export const recipes: Recipe[] = [
  a11y,
  readability,
  zoom,
  inputTypes,
  plugins,
  mobileUrls,
  icons,
  metaKeywords,
];
