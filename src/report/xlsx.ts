/**
 * A small Excel (.xlsx) writer with no dependencies: Office Open XML sheets of
 * inline strings and numbers, packed in an uncompressed ZIP. Enough for the
 * issue, page and custom-extraction tables; opens in Excel, Numbers, LibreOffice
 * and Google Sheets.
 */
import { crc32 } from 'node:zlib';
import type { AuditResult } from '../core/types.js';
import { issueSeverity } from './util.js';

export type Cell = string | number | boolean | null | undefined;
export interface Sheet {
  name: string;
  rows: Cell[][];
}

function xml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(rows: Cell[][]): string {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          if (v === null || v === undefined || v === '') return '';
          if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
          if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
          const text = String(v).slice(0, 32_000);
          return `<c r="${ref}" t="inlineStr"${r === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${body}</sheetData></worksheet>`;
}

function safeSheetName(name: string, used: Set<string>): string {
  let n = name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
  let i = 2;
  while (used.has(n.toLowerCase())) n = `${n.slice(0, 28)} ${i++}`;
  used.add(n.toLowerCase());
  return n;
}

/** Pack files into a ZIP archive (stored, no compression). */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, f.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + f.data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** A workbook with one worksheet per sheet. */
export function toXlsx(sheets: Sheet[]): Buffer {
  const used = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: safeSheetName(s.name, used) }));
  const files: { name: string; data: Buffer }[] = [];
  const add = (name: string, s: string) => files.push({ name, data: Buffer.from(s, 'utf8') });
  add(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
  );
  add(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  add(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${named.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
  );
  add(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  add(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
  );
  named.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)));
  return zip(files);
}

/** Issues, pages and (when present) custom extraction as one workbook. */
export function auditToXlsx(result: AuditResult): Buffer {
  const issues: Cell[][] = [
    ['Check', 'Title', 'Category', 'Pillar', 'Severity', 'URL', 'Message', 'Evidence', 'Fix'],
    ...result.issues.map((i) => {
      const d = result.checks[i.checkId];
      return [
        i.checkId,
        d?.title,
        d?.category,
        d?.pillar,
        issueSeverity(i, result),
        i.url ?? '',
        i.message,
        i.evidence ?? '',
        d?.fix,
      ];
    }),
  ];
  const pages: Cell[][] = [
    [
      'URL',
      'Status',
      'Depth',
      'Indexable',
      'Title',
      'Meta description',
      'H1',
      'Words',
      'Canonical',
      'Inlinks',
      'Outlinks',
      'Bytes',
      'TTFB ms',
      'Schema',
      'In sitemap',
      'Issues',
    ],
    ...result.pages.map((p) => [
      p.url,
      p.status,
      p.depth,
      p.indexable,
      p.title,
      p.metaDescription,
      p.h1,
      p.wordCount,
      p.canonical,
      p.inlinks,
      p.outlinks,
      p.bytes,
      p.ttfbMs,
      p.schemaTypes.join(' '),
      p.inSitemap,
      p.issues,
    ]),
  ];
  const sheets: Sheet[] = [
    { name: 'Issues', rows: issues },
    { name: 'Pages', rows: pages },
  ];
  const extract = extractionRows(result);
  if (extract) sheets.push({ name: 'Extraction', rows: extract });
  if (result.resources?.length)
    sheets.push({
      name: 'Resources',
      rows: [
        ['URL', 'Type', 'Pages', 'Third party', 'Bytes', 'Status'],
        ...result.resources.map((r) => [r.url, r.type, r.pages, r.thirdParty, r.bytes, r.status]),
      ],
    });
  const summary: Cell[][] = [
    ['Site', result.site],
    ['Date', result.at],
    ['Score', result.score.overall],
    ['Grade', result.score.grade],
    ...result.score.pillars.map((p) => [`Pillar: ${p.pillar}`, p.score] as Cell[]),
  ];
  sheets.unshift({ name: 'Summary', rows: summary });
  return toXlsx(sheets);
}

/** Header + one row per page for custom extraction results, or null when there are none. */
export function extractionRows(result: AuditResult): Cell[][] | null {
  const withData = result.pages.filter((p) => p.extracted && Object.keys(p.extracted).length);
  if (!withData.length) return null;
  const names = [...new Set(withData.flatMap((p) => Object.keys(p.extracted!)))];
  return [
    ['URL', ...names],
    ...withData.map((p) => [
      p.url,
      ...names.map((n) => {
        const v = p.extracted![n];
        return Array.isArray(v) ? v.join(' | ') : (v ?? '');
      }),
    ]),
  ];
}
