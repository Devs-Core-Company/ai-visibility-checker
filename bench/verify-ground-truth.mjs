#!/usr/bin/env node
// Self-check for the benchmark ground truth: starts bench/serve.mjs on a free port, then
//  1. runs every machine-checkable assertion in ground-truth.json (`verify` on each defect), and
//  2. checks that every control page is clean on the basics (status, title, description,
//     canonical, lang, viewport, one h1, image alt/size, and that every internal link on it
//     resolves with 200 and no redirect).
// Exit code 1 if anything fails.
//
//   node bench/verify-ground-truth.mjs [--verbose]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBenchServer } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const gt = JSON.parse(fs.readFileSync(path.join(HERE, 'ground-truth.json'), 'utf8'));
const verbose = process.argv.includes('--verbose');
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 bench-verify';

const { url: origin, close } = await startBenchServer({ port: 0 });
const cache = new Map();
async function get(p, { ua = BROWSER_UA, accept = '*/*' } = {}) {
  const key = `${p}|${ua}|${accept}`;
  if (cache.has(key)) return cache.get(key);
  const t0 = Date.now();
  const res = await fetch(origin + p, { redirect: 'manual', headers: { 'user-agent': ua, accept, 'accept-encoding': 'gzip, deflate, br' } });
  const buf = Buffer.from(await res.arrayBuffer());
  const r = { status: res.status, headers: res.headers, body: buf.toString('utf8'), size: buf.length, ms: Date.now() - t0 };
  cache.set(key, r);
  return r;
}
const mainOf = (html) => {
  const m = html.match(/<(main|div) id="main">([\s\S]*?)<\/(main|div)>\s*<footer/);
  return m ? m[2] : '';
};
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
const words = (html) => textOf(html).split(/\s+/).filter(Boolean).length;
const pathOf = (loc) => { try { return new URL(loc, origin).pathname; } catch { return loc; } };
function xmlWellFormed(xml) {
  const body = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]);
  }
  return stack.length === 0;
}

async function check(d, a) {
  const p = a.url || d.url;
  const r = await get(p, { ua: a.ua, accept: a.accept });
  const html = r.body;
  if ('status' in a && r.status !== a.status) return `status ${r.status}, expected ${a.status}`;
  if (a.redirect) {
    if (r.status !== a.redirect.status) return `status ${r.status}, expected redirect ${a.redirect.status}`;
    if (pathOf(r.headers.get('location')) !== a.redirect.location) return `Location ${r.headers.get('location')}, expected ${a.redirect.location}`;
  }
  if (a.header) { const v = r.headers.get(a.header) || ''; if (!new RegExp(a.match, 'i').test(v)) return `header ${a.header}="${v}" does not match ${a.match}`; }
  if (a.headerAbsent && r.headers.get(a.headerAbsent)) return `header ${a.headerAbsent} present`;
  if (a.html && !new RegExp(a.html, 'm').test(html)) return `body lacks /${a.html}/`;
  if (a.htmlNot && new RegExp(a.htmlNot, 'mi').test(html)) return `body unexpectedly matches /${a.htmlNot}/`;
  if (a.count) {
    const n = html.split(a.count).length - 1;
    if ('equals' in a && n !== a.equals) return `"${a.count}" occurs ${n}×, expected ${a.equals}`;
    if ('min' in a && n < a.min) return `"${a.count}" occurs ${n}×, expected ≥ ${a.min}`;
  }
  if (a.minMs && r.ms < a.minMs) return `responded in ${r.ms} ms, expected ≥ ${a.minMs}`;
  if (a.sizeMin && r.size < a.sizeMin) return `size ${r.size} < ${a.sizeMin}`;
  if (a.noContentEncoding && r.headers.get('content-encoding')) return `content-encoding ${r.headers.get('content-encoding')}`;
  if (a.jsonInvalid) { try { JSON.parse(html); return 'body is valid JSON'; } catch { /* expected */ } }
  if (a.jsonMissing) {
    let j; try { j = JSON.parse(html); } catch { return 'body is not JSON'; }
    const present = a.jsonMissing.filter((k) => k in j);
    if (present.length) return `keys present: ${present.join(', ')}`;
  }
  if (a.xmlInvalid && xmlWellFormed(html)) return 'XML is well-formed';
  if (a.jsonLdInvalid) {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    if (!blocks.some((b) => { try { JSON.parse(b); return false; } catch { return true; } })) return 'all JSON-LD blocks parse';
  }
  if (a.mainWordsMax != null && words(mainOf(html)) > a.mainWordsMax) return `main has ${words(mainOf(html))} words > ${a.mainWordsMax}`;
  if (a.mainWordsMin != null && words(mainOf(html)) < a.mainWordsMin) return `main has ${words(mainOf(html))} words < ${a.mainWordsMin}`;
  if (a.mainHeadingsMax != null) { const n = (mainOf(html).match(/<h[2-6][\s>]/g) || []).length; if (n > a.mainHeadingsMax) return `${n} subheadings in main`; }
  if (a.titleLenMin) { const t = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || ''; if (t.length < a.titleLenMin) return `title length ${t.length}`; }
  if (a.descLenMin) { const t = (html.match(/name="description" content="([^"]*)"/) || [])[1] || ''; if (t.length < a.descLenMin) return `description length ${t.length}`; }
  if (a.visibleTextNot && textOf(html).includes(a.visibleTextNot)) return `visible text contains "${a.visibleTextNot}"`;
  return null;
}

let fails = 0;
let checks = 0;
for (const d of gt.defects) {
  for (const a of d.verify || []) {
    checks++;
    const err = await check(d, a).catch((e) => `error: ${e.message}`);
    if (err) { fails++; console.log(`FAIL ${d.id} ${d.type} ${a.url || d.url}: ${err}`); } else if (verbose) console.log(`ok   ${d.id} ${d.type} ${a.url || d.url}`);
  }
  if (!d.verify || !d.verify.length) console.log(`WARN ${d.id} has no verify assertions`);
}

// controls
const linkStatus = new Map();
for (const c of gt.controls) {
  const r = await get(c);
  const html = r.body;
  const problems = [];
  if (r.status !== 200) problems.push(`status ${r.status}`);
  const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
  if (titles.length !== 1 || titles[0].length < 30 || titles[0].length > 60) problems.push(`title ${JSON.stringify(titles)}`);
  const descs = [...html.matchAll(/name="description" content="([^"]*)"/g)].map((m) => m[1]);
  if (descs.length !== 1 || descs[0].length < 70 || descs[0].length > 160) problems.push(`description lengths ${descs.map((x) => x.length)}`);
  const canon = [...html.matchAll(/rel="canonical" href="([^"]*)"/g)].map((m) => m[1]);
  if (canon.length !== 1 || canon[0] !== origin + c) problems.push(`canonical ${JSON.stringify(canon)}`);
  if (!/^<!doctype html>\n<html lang="en-GB">/i.test(html)) problems.push('doctype/lang');
  if (!/<meta charset="utf-8">/.test(html) || !/name="viewport" content="width=device-width, initial-scale=1"/.test(html)) problems.push('charset/viewport');
  if ((html.match(/<h1[\s>]/g) || []).length !== 1) problems.push('h1 count');
  if (/name="robots"/.test(html) || r.headers.get('x-robots-tag')) problems.push('robots directive');
  if (!r.headers.get('content-security-policy') || r.headers.get('content-encoding') !== 'gzip') problems.push('headers');
  if (r.ms > 1000) problems.push(`slow ${r.ms}ms`);
  for (const m of html.matchAll(/<img\b[^>]*>/g)) if (!/\balt="[^"]+"/.test(m[0]) || !/\bwidth="\d+"/.test(m[0]) || !/\bheight="\d+"/.test(m[0])) problems.push(`img ${m[0].slice(0, 60)}`);
  for (const b of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) { try { JSON.parse(b[1]); } catch { problems.push('invalid JSON-LD'); } }
  if (words(mainOf(html)) < 250) problems.push(`main words ${words(mainOf(html))}`);
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = m[1];
    if (!textOf(m[2]).trim() && !/alt="[^"]+"/.test(m[2])) problems.push(`link without text ${href}`);
    if (/rel="[^"]*nofollow/.test(m[0])) problems.push(`nofollow ${href}`);
    if (/^(tel:|mailto:|#)/.test(href)) continue;
    const u = new URL(href.replace('{{ORIGIN}}', origin), origin + c);
    if (u.origin !== origin) { problems.push(`external link ${href}`); continue; }
    if (!linkStatus.has(u.pathname)) linkStatus.set(u.pathname, (await get(u.pathname)).status);
    if (linkStatus.get(u.pathname) !== 200) problems.push(`link ${u.pathname} → ${linkStatus.get(u.pathname)}`);
  }
  checks++;
  if (problems.length) { fails++; console.log(`FAIL control ${c}: ${[...new Set(problems)].join('; ')}`); } else if (verbose) console.log(`ok   control ${c}`);
}

await close();
console.log(`\n${checks - fails}/${checks} checks passed (${gt.defects.length} defects, ${gt.controls.length} controls).`);
process.exit(fails ? 1 : 0);
