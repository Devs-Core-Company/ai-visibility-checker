/**
 * PDF document properties, read without a PDF library: the Info dictionary
 * (/Title, /Author, …), XMP metadata (dc:title, …) and the page count from the
 * page tree. Search engines index PDFs and use the Title property as the result
 * title, so these matter. Best effort: compressed object streams can hide the
 * Info dictionary, in which case the fields stay empty.
 */
import type { PdfInfo } from '../core/types.js';

export function isPdf(contentType: string | null | undefined, url = ''): boolean {
  if (/application\/pdf/i.test(contentType ?? '')) return true;
  return /\.pdf(?:$|[?#])/i.test(url) && !/text\/html/i.test(contentType ?? '');
}

/** Decode a PDF string literal "(…)" or hex string "<…>", including UTF-16BE with BOM. */
export function decodePdfString(raw: string): string {
  let bytes: number[] = [];
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/\s+/g, '');
    for (let i = 0; i < hex.length; i += 2)
      bytes.push(parseInt(hex.slice(i, i + 2).padEnd(2, '0'), 16));
  } else {
    const s = raw.slice(1, -1);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (ch !== '\\') {
        bytes.push(s.charCodeAt(i) & 0xff);
        continue;
      }
      const n = s[++i];
      if (n === undefined) break;
      const map: Record<string, number> = {
        n: 10,
        r: 13,
        t: 9,
        b: 8,
        f: 12,
        '(': 40,
        ')': 41,
        '\\': 92,
      };
      if (n in map) bytes.push(map[n]!);
      else if (/[0-7]/.test(n)) {
        let oct = n;
        while (oct.length < 3 && /[0-7]/.test(s[i + 1] ?? '')) oct += s[++i];
        bytes.push(parseInt(oct, 8) & 0xff);
      } else if (n === '\r' || n === '\n') {
        if (n === '\r' && s[i + 1] === '\n') i++;
      } else bytes.push(n.charCodeAt(0) & 0xff);
    }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2)
      out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    return out.replace(/\0/g, '').trim();
  }
  return Buffer.from(bytes).toString('latin1').replace(/\0/g, '').trim();
}

/** "D:20240131120000+01'00'" → ISO 8601, or the input when it does not parse. */
export function pdfDate(raw: string): string {
  const m = /D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/.exec(
    raw,
  );
  if (!m) return raw;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tz, th, tm] = m;
  const zone = !tz || tz === 'Z' ? 'Z' : `${tz}${th ?? '00'}:${tm ?? '00'}`;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`;
}

const INFO_KEYS: [keyof PdfInfo, string][] = [
  ['title', 'Title'],
  ['author', 'Author'],
  ['subject', 'Subject'],
  ['keywords', 'Keywords'],
  ['creator', 'Creator'],
  ['producer', 'Producer'],
  ['created', 'CreationDate'],
  ['modified', 'ModDate'],
];

/** Read what we can from the raw bytes of a PDF. */
export function extractPdfInfo(buf: Buffer | string): PdfInfo {
  const text = typeof buf === 'string' ? buf : buf.toString('latin1');
  const info: PdfInfo = {};
  for (const [key, name] of INFO_KEYS) {
    const re = new RegExp(`/${name}\\s*(\\((?:\\\\.|[^\\\\)])*\\)|<[0-9A-Fa-f\\s]*>)`);
    const m = re.exec(text);
    if (!m) continue;
    let v = decodePdfString(m[1]!);
    if (key === 'created' || key === 'modified') v = pdfDate(v);
    if (v) (info as Record<string, string>)[key] = v.slice(0, 500);
  }
  // XMP fallback for the title (often present when the Info dictionary is compressed).
  if (!info.title) {
    const x = /<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i.exec(text);
    if (x?.[1]?.trim()) info.title = x[1].trim().slice(0, 500);
  }
  if (!info.author) {
    const x = /<dc:creator>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/i.exec(text);
    if (x?.[1]?.trim()) info.author = x[1].trim().slice(0, 500);
  }
  // Page count: the largest /Count in a /Type /Pages node is the root's.
  let pages = 0;
  for (const m of text.matchAll(
    /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g,
  )) {
    pages = Math.max(pages, Number(m[1] ?? m[2]));
  }
  if (!pages) {
    const n = [...text.matchAll(/\/Type\s*\/Page\b(?!s)/g)].length;
    if (n) pages = n;
  }
  if (pages) info.pages = pages;
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(text)) info.encrypted = true;
  return info;
}
