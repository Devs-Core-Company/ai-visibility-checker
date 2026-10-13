#!/usr/bin/env node
// Generates a realistic 1,000-page static site for the performance suite.
//
//   node bench/gen-large-site.mjs <targetDir> [--pages 1000] [--seed 1]
//   node bench/serve.mjs --site <targetDir> --port 8900
//
// The site is a fictional garden-supplies shop ("Fernhill Garden Supply"): home, about, contact,
// category pages, product pages, articles and paginated article lists, with internal links,
// an XML sitemap, robots.txt, llms.txt, images and JSON-LD. Output is deterministic for a seed.
// A small share of pages carry common defects (missing alt, missing meta description, duplicate
// titles, broken internal links, thin content); they are listed in bench-manifest.json in the
// target directory. The {{ORIGIN}} placeholder is replaced by bench/serve.mjs at request time.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
if (!target) {
  console.error('usage: node bench/gen-large-site.mjs <targetDir> [--pages 1000] [--seed 1]');
  process.exit(2);
}
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
const TOTAL = opt('pages', 1000);
let seed = opt('seed', 1) >>> 0 || 1;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const O = '{{ORIGIN}}';
const BRAND = 'Fernhill Garden Supply';
const OUT = path.resolve(target);

// ---------------------------------------------------------------- vocabulary
const CATS = ['Seeds', 'Bulbs', 'Perennials', 'Shrubs', 'Fruit trees', 'Compost', 'Fertilisers', 'Hand tools', 'Pruning', 'Watering', 'Greenhouses', 'Raised beds', 'Pots and planters', 'Lawn care', 'Pest control', 'Wildlife', 'Garden furniture', 'Lighting', 'Paving', 'Gloves and clothing'];
const ADJ = ['Heritage', 'Compact', 'Organic', 'Hardy', 'Dwarf', 'Classic', 'Professional', 'Lightweight', 'Heavy-duty', 'Peat-free', 'Recycled', 'Galvanised', 'Cedar', 'Stoneware', 'Copper', 'Ash-handled', 'Self-watering', 'Frost-proof', 'Scented', 'Trailing'];
const NOUN = {
  Seeds: ['tomato seeds', 'sweet pea seeds', 'carrot seeds', 'wildflower mix', 'runner bean seeds', 'basil seeds'],
  Bulbs: ['tulip bulbs', 'allium bulbs', 'daffodil bulbs', 'crocus corms', 'snowdrop bulbs', 'lily bulbs'],
  Perennials: ['hardy geranium', 'salvia', 'echinacea', 'lavender', 'hosta', 'astrantia'],
  Shrubs: ['hydrangea', 'viburnum', 'pittosporum', 'box alternative', 'rose', 'hebe'],
  'Fruit trees': ['apple tree', 'pear tree', 'plum tree', 'cherry tree', 'fig tree', 'quince tree'],
  Compost: ['multi-purpose compost', 'seed compost', 'ericaceous compost', 'potting mix', 'leaf mould', 'soil improver'],
  Fertilisers: ['tomato feed', 'bone meal', 'seaweed feed', 'chicken manure pellets', 'rose feed', 'lawn feed'],
  'Hand tools': ['trowel', 'hand fork', 'dibber', 'weeder', 'bulb planter', 'transplanter'],
  Pruning: ['secateurs', 'loppers', 'pruning saw', 'shears', 'topiary shears', 'snips'],
  Watering: ['watering can', 'hose reel', 'spray gun', 'soaker hose', 'water butt', 'drip kit'],
  Greenhouses: ['lean-to greenhouse', 'cold frame', 'mini greenhouse', 'polytunnel', 'propagator', 'staging'],
  'Raised beds': ['raised bed kit', 'corner post set', 'bed liner', 'cloche hoop set', 'herb planter', 'tiered bed'],
  'Pots and planters': ['terracotta pot', 'window box', 'trough planter', 'hanging basket', 'glazed pot', 'grow bag frame'],
  'Lawn care': ['lawn rake', 'half-moon edger', 'aerator', 'grass seed', 'spreader', 'lawn shears'],
  'Pest control': ['slug trap', 'netting', 'fleece', 'sticky traps', 'copper tape', 'nematodes'],
  Wildlife: ['bird feeder', 'bee hotel', 'hedgehog house', 'bird bath', 'nest box', 'bug house'],
  'Garden furniture': ['bench', 'bistro set', 'lounger', 'parasol', 'folding chair', 'potting bench'],
  Lighting: ['solar lantern', 'string lights', 'spike light', 'wall light', 'path light', 'festoon set'],
  Paving: ['stepping stones', 'gravel', 'edging', 'sandstone slabs', 'brick pavers', 'weed membrane'],
  'Gloves and clothing': ['gardening gloves', 'thorn-proof gauntlets', 'kneeler', 'apron', 'wellington boots', 'sun hat'],
};
const SENT = [
  (n) => `The ${n} is chosen by our buyers after a full season of testing in our trial garden in Herefordshire.`,
  (n) => `Most customers use the ${n} in borders, patios and allotments, and it suits both new and experienced gardeners.`,
  (n) => `We pack every ${n} in recycled cardboard and ship it within two working days.`,
  (n) => `If the ${n} arrives damaged, send us a photograph within fourteen days and we will replace it free of charge.`,
  (n) => `For the best results, read the care notes below before you start, especially if your soil is heavy clay or very sandy.`,
  (n) => `Gardeners in colder, exposed areas should give the ${n} some shelter during its first winter.`,
  (n) => `Our customer team are keen gardeners themselves and can answer questions about the ${n} by phone or email.`,
  (n) => `The ${n} has been reviewed by more than a hundred customers, and the most common comment is that it is easy to use.`,
  (n) => `Pair the ${n} with a good peat-free compost and a slow-release feed for a strong start.`,
  (n) => `Spring and early autumn are the best times to start, when the soil is warm and moist.`,
  (n) => `Keep the ${n} out of reach of children and pets if you combine it with any feed or treatment.`,
  (n) => `We sell the ${n} individually and in multipacks, which work out cheaper for larger gardens.`,
  (n) => `All of our timber is from certified sustainable sources, and our plastics are at least half recycled.`,
  (n) => `Delivery is free on orders over forty pounds to most of mainland Britain.`,
  (n) => `The ${n} is covered by our two-year guarantee against manufacturing faults.`,
];
const TOPICS = ['planting bulbs for spring colour', 'starting seeds on a windowsill', 'pruning roses in late winter', 'making leaf mould', 'feeding tomatoes', 'choosing a greenhouse', 'building a raised bed', 'attracting bees', 'watering in a heatwave', 'protecting plants from frost', 'controlling slugs without pellets', 'planting a fruit tree', 'renovating a tired lawn', 'growing herbs in pots', 'mulching borders', 'saving seed', 'dividing perennials', 'planting a wildlife hedge', 'lighting a small garden', 'laying a gravel path'];
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const para = (n, k) => Array.from({ length: k }, () => pick(SENT)(n)).join(' ');

// ---------------------------------------------------------------- plan pages
const N_ART = 100;
const ART_PER_LIST = 10;
const N_LIST = Math.ceil(N_ART / ART_PER_LIST);
const fixed = 3; // home, about, contact
const N_PROD = TOTAL - fixed - CATS.length - N_ART - N_LIST;
if (N_PROD < CATS.length) throw new Error('--pages too small');

const products = [];
for (let i = 0; i < N_PROD; i++) {
  const cat = CATS[i % CATS.length];
  const noun = NOUN[cat][Math.floor(i / CATS.length) % NOUN[cat].length];
  const name = `${pick(ADJ)} ${noun}`;
  products.push({ i, cat, name, slug: `${slug(name)}-${1000 + i}`, price: (5 + Math.floor(rnd() * 240)) + 0.99 });
}
const articles = Array.from({ length: N_ART }, (_, i) => {
  const t = TOPICS[i % TOPICS.length];
  const part = Math.floor(i / TOPICS.length) + 1;
  return { i, topic: t, title: `${titleCase(t)}${part > 1 ? `, part ${part}` : ''}`, slug: `${slug(t)}${part > 1 ? `-part-${part}` : ''}`, date: new Date(Date.UTC(2026, 8, 30) - i * 3 * 86400000).toISOString().slice(0, 10) };
});

// defects: deterministic subsets
const defects = [];
const every = (n, off) => (x) => x.i % n === off;
const missAlt = new Set(products.filter(every(37, 5)).map((p) => p.slug));
const missDesc = new Set(products.filter(every(41, 7)).map((p) => p.slug));
const dupTitle = new Set(products.filter(every(53, 11)).map((p) => p.slug));
const brokenLink = new Set(articles.filter(every(17, 3)).map((a) => a.slug));
const thin = new Set(products.filter(every(61, 13)).map((p) => p.slug));

// ---------------------------------------------------------------- templates
const files = new Map();
const pages = [];
const NAV = `<header class="h"><a href="/" class="logo">${BRAND}</a><nav aria-label="Main"><ul>${CATS.slice(0, 8).map((c) => `<li><a href="/c/${slug(c)}">${c}</a></li>`).join('')}<li><a href="/journal">Journal</a></li><li><a href="/about">About</a></li><li><a href="/contact">Contact</a></li></ul></nav></header>`;
const FOOT = `<footer class="f"><p>${BRAND}, Unit 4 Orchard Way, Ledbury HR8 2XX. Telephone 01632 960 811.</p><ul>${CATS.map((c) => `<li><a href="/c/${slug(c)}">${c}</a></li>`).join('')}</ul></footer>`;
function page(p, { title, desc, h1, body, schema = [], image }) {
  const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${desc ? `<meta name="description" content="${esc(desc)}">\n` : ''}<link rel="canonical" href="${O}${p}">
<link rel="stylesheet" href="/assets/site.css">
<meta property="og:title" content="${esc(title)}">
<meta property="og:url" content="${O}${p}">
<meta property="og:image" content="${O}${image || '/images/og.png'}">
${schema.map((s) => `<script type="application/ld+json">${JSON.stringify(s)}</script>`).join('\n')}
</head>
<body>
${NAV}
<main id="main">
<h1>${esc(h1)}</h1>
${body}
</main>
${FOOT}
</body>
</html>
`;
  files.set(p === '/' ? 'index.html' : `${p.slice(1)}.html`, html);
  pages.push(p);
}
const img = (n, alt) => `<img src="/images/p${n % 6}.png" ${alt === null ? '' : `alt="${esc(alt)}" `}width="400" height="300" loading="lazy">`;

// home
page('/', {
  title: `${BRAND} | Plants, Seeds and Garden Tools`, desc: 'Independent garden supplier in Herefordshire. Plants, seeds, bulbs, compost and tools chosen and tested by gardeners, delivered across Britain.',
  h1: 'Everything for the garden, tested by gardeners',
  schema: [{ '@context': 'https://schema.org', '@type': 'Store', name: BRAND, url: `${O}/`, telephone: '+44 1632 960811' }],
  body: `<p>${para('range', 4)}</p>\n<h2>Shop by category</h2>\n<ul>${CATS.map((c) => `<li><a href="/c/${slug(c)}">${c}</a></li>`).join('')}</ul>\n<h2>From the journal</h2>\n<ul>${articles.slice(0, 10).map((a) => `<li><a href="/journal/${a.slug}">${esc(a.title)}</a></li>`).join('')}</ul>`,
});
page('/about', { title: `About ${BRAND}`, desc: 'How Fernhill Garden Supply started, where our trial garden is, and how we choose every product we sell.', h1: `About ${BRAND}`, body: `<p>${para('business', 6)}</p><h2>Our trial garden</h2><p>${para('trial garden', 6)}</p>` });
page('/contact', { title: `Contact ${BRAND}`, desc: 'Phone, email and postal address for Fernhill Garden Supply customer service, open Monday to Saturday.', h1: 'Contact us', body: `<p>${para('team', 5)}</p><form action="/contact" method="post"><label for="e">Email</label> <input id="e" name="email" type="email" autocomplete="email"><label for="m">Message</label> <textarea id="m" name="m"></textarea><button type="submit">Send</button></form>` });

// categories
for (const c of CATS) {
  const list = products.filter((p) => p.cat === c);
  page(`/c/${slug(c)}`, {
    title: `${c} | ${BRAND}`, desc: `Shop ${c.toLowerCase()} at ${BRAND}: ${list.length} products chosen and tested by our gardeners, with free delivery over £40.`, h1: c,
    schema: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: c, url: `${O}/c/${slug(c)}` }],
    body: `<p>${para(c.toLowerCase(), 4)}</p>\n<ul class="grid">${list.map((p) => `<li><a href="/p/${p.slug}">${img(p.i, p.name)}<span>${esc(p.name)}</span></a> £${p.price.toFixed(2)}</li>`).join('\n')}</ul>`,
  });
}
// products
for (const p of products) {
  const rel = products.filter((q) => q.cat === p.cat && q.i !== p.i).slice(0, 4);
  const title = dupTitle.has(p.slug) ? `${p.cat} | ${BRAND}` : `${p.name} | ${BRAND}`;
  page(`/p/${p.slug}`, {
    title, desc: missDesc.has(p.slug) ? null : `${p.name} from ${BRAND}. £${p.price.toFixed(2)}, free delivery over £40 and a two-year guarantee. Tested in our trial garden.`, h1: p.name, image: `/images/p${p.i % 6}.png`,
    schema: [{ '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: `FH-${1000 + p.i}`, image: `${O}/images/p${p.i % 6}.png`, offers: { '@type': 'Offer', price: p.price.toFixed(2), priceCurrency: 'GBP', availability: 'https://schema.org/InStock' } }],
    body: thin.has(p.slug) ? `<p>£${p.price.toFixed(2)}. In stock.</p>` : `${img(p.i, missAlt.has(p.slug) ? null : `${p.name} in the trial garden`)}
<p><strong>£${p.price.toFixed(2)}</strong>. In stock, dispatched within two working days.</p>
<h2>About this product</h2><p>${para(p.name.toLowerCase(), 5)}</p>
<h2>Care and use</h2><p>${para(p.name.toLowerCase(), 4)}</p>
<h2>Delivery and returns</h2><p>${para(p.name.toLowerCase(), 3)}</p>
<h2>You may also like</h2><ul>${rel.map((q) => `<li><a href="/p/${q.slug}">${esc(q.name)}</a></li>`).join('')}</ul>
<p>Back to <a href="/c/${slug(p.cat)}">${p.cat}</a>.</p>`,
  });
}
// articles + lists
for (const a of articles) {
  const prods = products.filter((p) => p.cat === CATS[a.i % CATS.length]).slice(0, 3);
  page(`/journal/${a.slug}`, {
    title: `${a.title} | ${BRAND} Journal`, desc: `A practical guide to ${a.topic} from the ${BRAND} trial garden team, with step-by-step advice and the tools we use.`, h1: a.title,
    schema: [{ '@context': 'https://schema.org', '@type': 'Article', headline: a.title, datePublished: a.date, author: { '@type': 'Person', name: 'Hannah Pike' }, publisher: { '@type': 'Organization', name: BRAND } }],
    body: `<p class="by">By Hannah Pike · <time datetime="${a.date}">${a.date}</time></p>
${img(a.i, `Illustration for ${a.topic}`)}
<h2>Why it matters</h2><p>${para(a.topic, 5)}</p>
<h2>Step by step</h2><p>${para(a.topic, 5)}</p>
<h2>What you need</h2><ul>${prods.map((p) => `<li><a href="/p/${p.slug}">${esc(p.name)}</a></li>`).join('')}</ul>
${brokenLink.has(a.slug) ? `<p>See also our <a href="/journal/${a.slug}-old">earlier notes on ${esc(a.topic)}</a>.</p>` : ''}
<p>More in <a href="/journal">the journal</a>.</p>`,
  });
}
for (let n = 1; n <= N_LIST; n++) {
  const p = n === 1 ? '/journal' : `/journal/page-${n}`;
  const items = articles.slice((n - 1) * ART_PER_LIST, n * ART_PER_LIST);
  page(p, {
    title: n === 1 ? `Gardening Journal | ${BRAND}` : `Gardening Journal, Page ${n} | ${BRAND}`, desc: `Practical gardening guides from the ${BRAND} trial garden team${n > 1 ? `, page ${n} of ${N_LIST}` : ''}.`, h1: n === 1 ? 'Gardening journal' : `Gardening journal, page ${n}`,
    body: `<ul>${items.map((a) => `<li><a href="/journal/${a.slug}">${esc(a.title)}</a> (${a.date})</li>`).join('')}</ul>\n<nav aria-label="Pagination"><ul>${Array.from({ length: N_LIST }, (_, k) => k + 1).map((k) => `<li><a href="${k === 1 ? '/journal' : `/journal/page-${k}`}">Page ${k}</a></li>`).join('')}</ul></nav>`,
  });
}

// ---------------------------------------------------------------- support files
files.set('404.html', `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Page not found | ${BRAND}</title><meta name="robots" content="noindex"></head><body><h1>Page not found</h1><p><a href="/">Home</a></p></body></html>\n`);
files.set('410.html', files.get('404.html'));
files.set('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${O}/sitemap.xml\n`);
files.set('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((p) => `  <url><loc>${O}${p}</loc><lastmod>2026-09-30</lastmod></url>`).join('\n')}\n</urlset>\n`);
files.set('llms.txt', `# ${BRAND}\n\n> Independent garden supplier in Herefordshire selling plants, seeds, compost and tools tested in our own trial garden.\n\n## Shop\n\n${CATS.map((c) => `- [${c}](${O}/c/${slug(c)})`).join('\n')}\n\n## Guides\n\n- [Gardening journal](${O}/journal)\n`);
files.set('assets/site.css', 'body{font:16px/1.6 system-ui,sans-serif;margin:0;color:#1f2a1f}main{max-width:960px;margin:0 auto;padding:16px}.h,.f{background:#2f5233;color:#fff;padding:12px 16px}.h a,.f a{color:#fff}.h ul,.f ul{display:flex;flex-wrap:wrap;gap:12px;list-style:none;padding:0}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;list-style:none;padding:0}img{max-width:100%;height:auto}\n');

// images: tiny valid PNGs (solid colours) generated without dependencies
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, (_, y) => { const rr = Buffer.from(row); for (let x = 0; x < w; x++) rr[1 + x * 3 + 1] = (g + ((x * y) % 40)) & 0xff; return rr; }));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const colours = [[47, 82, 51], [120, 160, 90], [200, 170, 100], [90, 120, 160], [160, 90, 90], [110, 110, 110]];
colours.forEach((c, i) => files.set(`images/p${i}.png`, png(800, 600, c)));
files.set('images/og.png', png(1200, 630, [47, 82, 51]));

defects.push(
  { type: 'img-missing-alt', urls: [...missAlt].map((s) => `/p/${s}`) },
  { type: 'missing-meta-description', urls: [...missDesc].map((s) => `/p/${s}`) },
  { type: 'duplicate-title', urls: [...dupTitle].map((s) => `/p/${s}`) },
  { type: 'broken-internal-link', urls: [...brokenLink].map((s) => `/journal/${s}`) },
  { type: 'thin-content', urls: [...thin].map((s) => `/p/${s}`) },
);
files.set('bench-manifest.json', JSON.stringify({ generator: 'bench/gen-large-site.mjs', seed: opt('seed', 1), html_pages: pages.length, defects }, null, 2) + '\n');

if (fs.existsSync(OUT) && fs.readdirSync(OUT).length && !fs.existsSync(path.join(OUT, 'bench-manifest.json'))) {
  console.error(`Refusing to overwrite non-empty ${OUT} (no bench-manifest.json from a previous run).`);
  process.exit(1);
}
fs.rmSync(OUT, { recursive: true, force: true });
for (const [rel, content] of files) {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}
console.log(`Wrote ${pages.length} HTML pages (${files.size} files) to ${OUT}`);
