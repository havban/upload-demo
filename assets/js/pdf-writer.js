// A small streaming PDF writer — no dependencies, works in the browser and Node.
//
// It emits a real PDF 1.7 file: catalog, page tree, three base-14 fonts, one content
// stream per page, xref table and trailer. Content streams are left uncompressed, which
// keeps the writer simple and — more usefully for this demo — makes the output size
// predictable, so "give me a 50 MB PDF" is a single pass with a progress bar.
//
// The document is a landscape synthetic sales ledger: a cover page plus as many table
// pages as the size target needs. Every name, email and figure in it is generated.

import { COLUMNS, rowStream } from './dataset.js';

const enc = new TextEncoder();

const PAGE_W = 841.89;   // A4 landscape
const PAGE_H = 595.28;
const MARGIN = 36;
const ROW_FONT = 7;
const ROW_LEADING = 11;
const ROWS_PER_PAGE = 40;
const TABLE_TOP = 505;

const PDF_COLUMNS = COLUMNS.filter((c) => c.pdf > 0);

/**
 * Writes objects in any order and keeps the byte offsets needed for the xref table.
 * Everything it emits is ASCII (see `esc`), so string length == byte length and the
 * offsets can be tracked without encoding each fragment separately — that keeps a
 * 50 MB document down to a few hundred TextEncoder calls instead of a few hundred
 * thousand.
 */
class PdfWriter {
  constructor(flushBytes = 1 << 19) {
    this.parts = [];
    this.buf = [];
    this.bufLen = 0;
    this.flushBytes = flushBytes;
    this.offset = 0;
    this.offsets = new Map();
    this.nextObj = 1;
  }
  reserve() { return this.nextObj++; }
  /** Append ASCII text. */
  raw(str) {
    this.buf.push(str);
    this.bufLen += str.length;
    this.offset += str.length;
    if (this.bufLen >= this.flushBytes) this.flush();
  }
  /** Append raw bytes (used only for the binary comment in the header). */
  rawBytes(bytes) {
    this.flush();
    this.parts.push(bytes);
    this.offset += bytes.length;
  }
  flush() {
    if (!this.bufLen) return;
    this.parts.push(enc.encode(this.buf.join('')));
    this.buf = [];
    this.bufLen = 0;
  }
  obj(num, body) {
    this.offsets.set(num, this.offset);
    this.raw(`${num} 0 obj\n${body}\nendobj\n`);
  }
  stream(num, dict, content) {
    this.offsets.set(num, this.offset);
    this.raw(`${num} 0 obj\n<< ${dict}${dict ? ' ' : ''}/Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  }
  finish(rootObj, infoObj) {
    const max = this.nextObj;
    const startxref = this.offset;
    const xref = [`xref\n0 ${max}\n0000000000 65535 f \n`];
    for (let i = 1; i < max; i++) {
      xref.push(`${String(this.offsets.get(i) ?? 0).padStart(10, '0')} 00000 n \n`);
    }
    this.raw(xref.join(''));
    this.raw(`trailer\n<< /Size ${max} /Root ${rootObj} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${startxref}\n%%EOF\n`);
    this.flush();
    return this.parts;
  }
}

const esc = (s) => String(s)
  .replace(/[^\x20-\x7e]/g, '?')
  .replace(/([\\()])/g, '\\$1');

// Hand-rolled thousands separator: Intl.NumberFormat is ~10x slower and this runs
// a few hundred thousand times when building a 50 MB document.
function money(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  const fixed = num.toFixed(2);
  const dot = fixed.length - 3;
  let head = fixed.slice(0, dot);
  const neg = head.startsWith('-');
  if (neg) head = head.slice(1);
  let out = '';
  for (let i = head.length; i > 3; i -= 3) out = `,${head.slice(i - 3, i)}${out}`;
  out = head.slice(0, head.length > 3 ? ((head.length - 1) % 3) + 1 : head.length) + out;
  return (neg ? '-' : '') + out + fixed.slice(dot);
}

function fit(text, width, align = 'left') {
  let s = String(text ?? '');
  if (s.length > width) s = `${s.slice(0, Math.max(1, width - 1))}~`;
  return align === 'right' ? s.padStart(width) : s.padEnd(width);
}

function rowLine(row) {
  return PDF_COLUMNS.map((c) => {
    const v = c.key === 'order_date'
      ? (row[c.key] instanceof Date ? row[c.key].toISOString().slice(0, 10) : row[c.key])
      : (c.type === 'money' ? money(row[c.key]) : row[c.key]);
    return fit(v, c.pdf, c.type === 'money' || c.type === 'int' ? 'right' : 'left');
  }).join(' ');
}

const headerLine = () => PDF_COLUMNS
  .map((c) => fit(c.label, c.pdf, c.type === 'money' || c.type === 'int' ? 'right' : 'left'))
  .join(' ');

function pageContent({ pageNo, rows, title, period }) {
  const parts = [];
  // Top banner
  parts.push(`0.18 0.43 0.96 rg 0 ${PAGE_H - 44} ${PAGE_W} 44 re f`);
  parts.push(`1 1 1 rg BT /F2 13 Tf ${MARGIN} ${PAGE_H - 29} Td (${esc(title)}) Tj ET`);
  parts.push(`1 1 1 rg BT /F1 9 Tf ${PAGE_W - MARGIN - 150} ${PAGE_H - 29} Td (${esc(`Page ${pageNo}  |  ${period}`)}) Tj ET`);
  // Column header strip
  parts.push(`0.90 0.93 0.98 rg ${MARGIN - 4} ${TABLE_TOP + 9} ${PAGE_W - 2 * (MARGIN - 4)} 16 re f`);
  parts.push(`0.10 0.12 0.18 rg BT /F3 ${ROW_FONT} Tf ${MARGIN} ${TABLE_TOP + 14} Td (${esc(headerLine())}) Tj ET`);
  // Zebra striping behind every other row
  for (let i = 1; i < rows.length; i += 2) {
    const y = TABLE_TOP - i * ROW_LEADING - 2.5;
    parts.push(`0.965 0.972 0.980 rg ${MARGIN - 4} ${y} ${PAGE_W - 2 * (MARGIN - 4)} ${ROW_LEADING} re f`);
  }
  // Rows, one text object using TL/T* to keep the stream compact
  parts.push(`0.13 0.15 0.2 rg BT /F3 ${ROW_FONT} Tf ${ROW_LEADING} TL ${MARGIN} ${TABLE_TOP} Td`);
  for (const r of rows) parts.push(`(${esc(rowLine(r))}) Tj T*`);
  parts.push('ET');
  // Footer
  parts.push(`0.45 0.48 0.55 rg BT /F1 7.5 Tf ${MARGIN} 22 Td (${esc('Synthetic data generated by upload-demo - every name, email and figure here is fictional.')}) Tj ET`);
  parts.push(`0.45 0.48 0.55 rg BT /F1 7.5 Tf ${PAGE_W - MARGIN - 60} 22 Td (${esc(`- ${pageNo} -`)}) Tj ET`);
  return parts.join('\n');
}

function coverContent({ title, period, generatedAt, note }) {
  const lines = [
    ['F2', 30, PAGE_H - 150, title],
    ['F1', 13, PAGE_H - 182, `Reporting period: ${period}`],
    ['F1', 13, PAGE_H - 202, `Generated: ${generatedAt}`],
    ['F1', 13, PAGE_H - 222, note],
    ['F2', 11, PAGE_H - 280, 'About this document'],
    ['F1', 10, PAGE_H - 300, 'This PDF was produced in the browser by a hand-written PDF writer (assets/js/pdf-writer.js).'],
    ['F1', 10, PAGE_H - 316, 'It exists to give the chunked-upload demo a genuinely large, genuinely valid file to move.'],
    ['F1', 10, PAGE_H - 332, 'Content streams are uncompressed so the finished file lands on the requested size target.'],
    ['F1', 10, PAGE_H - 356, 'Every following page holds 40 rows of an invented order ledger: order reference, date,'],
    ['F1', 10, PAGE_H - 372, 'region, country, sales representative, customer email, product, quantity and totals.'],
    ['F2', 10, PAGE_H - 404, 'No part of this document describes a real company, person, transaction or price.'],
  ];
  const parts = [
    `0.18 0.43 0.96 rg 0 ${PAGE_H - 70} ${PAGE_W} 70 re f`,
    `1 1 1 rg BT /F2 20 Tf ${MARGIN} ${PAGE_H - 44} Td (${esc('upload-demo / sample document')}) Tj ET`,
    `0.13 0.15 0.2 rg`,
  ];
  for (const [font, size, y, text] of lines) {
    parts.push(`BT /${font} ${size} Tf ${MARGIN} ${y} Td (${esc(text)}) Tj ET`);
  }
  parts.push(`0.18 0.43 0.96 rg ${MARGIN} ${PAGE_H - 430} 240 3 re f`);
  return parts.join('\n');
}

/**
 * Build a PDF of synthetic ledger pages.
 * Give it `pages` or `targetBytes` (it keeps adding pages until the size target is met).
 *
 * @returns {Promise<{parts: Uint8Array[], bytes: number, pageCount: number}>}
 */
export async function buildPdf({
  pages = 0,
  targetBytes = 0,
  title = 'Quarterly Order Ledger (synthetic)',
  period = 'FY2026 Q1-Q4',
  seed = 20260923,
  onProgress = null,
  signal = null,
  progressEvery = 40,
} = {}) {
  if (!pages && !targetBytes) throw new Error('buildPdf needs pages or targetBytes');

  const w = new PdfWriter();
  const catalogObj = w.reserve();
  const pagesObj = w.reserve();
  const fontRegular = w.reserve();
  const fontBold = w.reserve();
  const fontMono = w.reserve();
  const infoObj = w.reserve();

  w.raw('%PDF-1.7\n');
  w.rawBytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment
  w.obj(fontRegular, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  w.obj(fontBold, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  w.obj(fontMono, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');

  const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
  w.obj(infoObj, `<< /Title (${esc(title)}) /Author (upload-demo generator) /Subject (Synthetic sample data) /Creator (upload-demo pdf-writer.js) /Producer (upload-demo) >>`);

  const resources = `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R /F3 ${fontMono} 0 R >> >>`;
  const mediaBox = `/MediaBox [0 0 ${PAGE_W} ${PAGE_H}]`;
  const kids = [];

  const addPage = (content) => {
    const pageObj = w.reserve();
    const contentObj = w.reserve();
    w.obj(pageObj, `<< /Type /Page /Parent ${pagesObj} 0 R ${mediaBox} ${resources} /Contents ${contentObj} 0 R >>`);
    w.stream(contentObj, '', content);
    kids.push(`${pageObj} 0 R`);
  };

  addPage(coverContent({
    title,
    period,
    generatedAt,
    note: 'All data below is synthetic - generated, not collected.',
  }));

  const limit = pages || Number.MAX_SAFE_INTEGER;
  const gen = rowStream(Number.MAX_SAFE_INTEGER, { seed, defectEvery: 0 });
  let pageNo = 1;
  let buffer = [];
  while (pageNo < limit) {
    buffer.length = 0;
    for (let i = 0; i < ROWS_PER_PAGE; i++) buffer.push(gen.next().value);
    pageNo++;
    addPage(pageContent({ pageNo, rows: buffer, title, period }));

    // The xref table costs ~20 bytes per object (2 objects per page), so aim slightly
    // under the target and let the trailer bring it home.
    if (targetBytes && w.offset + 40 * pageNo + 200 >= targetBytes) break;
    if (pageNo % progressEvery === 0) {
      if (onProgress) await onProgress({ pages: pageNo, bytes: w.offset });
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    }
  }

  w.obj(pagesObj, `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`);
  w.obj(catalogObj, `<< /Type /Catalog /Pages ${pagesObj} 0 R /PageLayout /SinglePage >>`);
  const parts = w.finish(catalogObj, infoObj);
  const bytes = parts.reduce((n, p) => n + p.length, 0);
  if (onProgress) await onProgress({ pages: kids.length, bytes, done: true });
  return { parts, bytes, pageCount: kids.length };
}

export const PDF_MIME = 'application/pdf';
