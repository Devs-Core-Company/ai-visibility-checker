/**
 * Text helpers shared by raw extraction and rendering, so raw and rendered
 * word counts are measured the same way.
 */
import { createHash } from 'node:crypto';

/** Elements whose content is never visible text. */
const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'head',
  'title',
  'meta',
  'link',
  'select',
  'option',
  'datalist',
  'math',
]);

const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'br',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
  'button',
  'label',
]);

interface MinimalNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<MinimalNode>;
  getAttribute?(name: string): string | null;
  hasAttribute?(name: string): boolean;
}

function hiddenEl(el: MinimalNode): boolean {
  if (!el.getAttribute) return false;
  if (el.hasAttribute?.('hidden')) return true;
  const style = el.getAttribute('style');
  if (style && /(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) return true;
  return false;
}

/**
 * Visible text of a node: hidden and non-content elements skipped, block
 * elements separated by newlines, other whitespace collapsed.
 */
export function visibleText(root: MinimalNode | null | undefined, skipTags?: Set<string>): string {
  if (!root) return '';
  const parts: string[] = [];
  const walk = (node: MinimalNode) => {
    if (node.nodeType === 3) {
      const t = node.textContent;
      if (t) parts.push(t);
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    const tag = node.nodeName.toLowerCase();
    if (SKIP.has(tag) || skipTags?.has(tag)) return;
    if (node.nodeType === 1 && hiddenEl(node)) return;
    if (skipTags && node.getAttribute) {
      const role = node.getAttribute('role');
      if (role && skipTags.has(`role:${role}`)) return;
    }
    if (tag === 'img') {
      return; // alt text is not body copy
    }
    const block = BLOCK.has(tag);
    if (block) parts.push('\n');
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) walk(kids[i]!);
    if (block) parts.push('\n');
  };
  walk(root);
  return tidy(parts.join(''));
}

/** Collapse runs of spaces; keep single newlines between blocks. */
export function tidy(s: string): string {
  return s
    .replace(/ /g, ' ')
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Single-line whitespace-collapsed text. */
export function oneLine(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;

/** Word count: letter/number runs, plus one per CJK character. */
export function countWords(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = cjk ? text.replace(CJK, ' ') : text;
  const words = rest.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu)?.length ?? 0;
  return words + cjk;
}

export function normaliseForHash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function fnv32(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // final avalanche (murmur3 fmix)
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * 64-bit simhash (16 hex chars) over word 3-shingles. Near-duplicate pages
 * differ in only a few bits: use `hammingDistance` (≤ 3 is very close).
 */
export function simhash(text: string): string {
  const words = normaliseForHash(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return '0'.repeat(16);
  const v = new Int32Array(64);
  const k = words.length < 3 ? 1 : 3;
  for (let i = 0; i + k <= words.length; i++) {
    const shingle = words.slice(i, i + k).join(' ');
    const hi = fnv32(shingle, 0x9e3779b9);
    const lo = fnv32(shingle, 0x7f4a7c15);
    for (let b = 0; b < 32; b++) {
      v[b] += (hi >>> b) & 1 ? 1 : -1;
      v[b + 32] += (lo >>> b) & 1 ? 1 : -1;
    }
  }
  let hi = 0;
  let lo = 0;
  for (let b = 0; b < 32; b++) {
    if (v[b]! > 0) hi |= 1 << b;
    if (v[b + 32]! > 0) lo |= 1 << b;
  }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

/** Number of differing bits between two 64-bit hex simhashes. */
export function hammingDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < 16; i += 8) {
    let x = (parseInt(a.slice(i, i + 8) || '0', 16) ^ parseInt(b.slice(i, i + 8) || '0', 16)) >>> 0;
    while (x) {
      x &= x - 1;
      d++;
    }
  }
  return d;
}
