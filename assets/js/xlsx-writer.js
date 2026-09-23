// A small streaming .xlsx writer — no dependencies, works in the browser and Node.
//
// Why hand-rolled instead of SheetJS (which this repo also ships, for *reading*)?
// Two reasons this demo cares about:
//   1. It streams. Rows are encoded and flushed in blocks, so a 50 MB workbook can be
//      produced with a progress bar instead of one long frozen tab.
//   2. It can store parts uncompressed (`compress: false`), which is the only sane way
//      to hit an exact "50 MB file" target — a deflated sheet of repetitive sales rows
//      shrinks by ~20x, so you would need millions of rows to weigh 50 MB on disk.
//
// The output is an ordinary OOXML package: [Content_Types].xml, _rels/.rels,
// xl/workbook.xml (+rels), xl/styles.xml, xl/worksheets/sheet1.xml. Values are written
// as inline strings and numbers; dates go out as Excel serials with a date format.

import { COLUMNS, HEADER_LABELS, rowStream, toExcelSerial } from './dataset.js';

const enc = new TextEncoder();

/* ------------------------------------------------------------------ CRC32 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, seed = 0) {
  let c = ~seed >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/* -------------------------------------------------------------------- ZIP */

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time, day };
}

async function deflateRaw(parts) {
  if (typeof CompressionStream === 'function') {
    const stream = new Blob(parts).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { deflateRawSync } = await import('node:zlib');
  return new Uint8Array(deflateRawSync(Buffer.concat(parts.map((p) => Buffer.from(p)))));
}

/**
 * Builds a ZIP container. Entries are added as arrays of Uint8Array so large parts
 * never need to exist as a single contiguous buffer until the very end.
 */
export class ZipWriter {
  constructor({ compress = true } = {}) {
    this.compress = compress;
    this.parts = [];
    this.entries = [];
    this.offset = 0;
  }

  async add(name, chunks) {
    const nameBytes = enc.encode(name);
    let crc = 0;
    let rawSize = 0;
    for (const c of chunks) { crc = crc32(c, crc); rawSize += c.length; }

    let payload = chunks;
    let method = 0;
    let compSize = rawSize;
    if (this.compress && rawSize > 0) {
      const deflated = await deflateRaw(chunks);
      if (deflated.length < rawSize) {
        payload = [deflated];
        compSize = deflated.length;
        method = 8;
      }
    }

    const { time, day } = dosDateTime();
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);       // version needed
    header.setUint16(6, 0, true);        // flags
    header.setUint16(8, method, true);
    header.setUint16(10, time, true);
    header.setUint16(12, day, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, compSize, true);
    header.setUint32(22, rawSize, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true);       // extra length

    this.entries.push({ nameBytes, crc, compSize, rawSize, method, time, day, offset: this.offset });
    this.parts.push(new Uint8Array(header.buffer), nameBytes, ...payload);
    this.offset += 30 + nameBytes.length + compSize;
  }

  /** Returns the finished archive as an array of Uint8Array chunks. */
  finish() {
    const cdStart = this.offset;
    const cdParts = [];
    let cdSize = 0;
    for (const e of this.entries) {
      const dv = new DataView(new ArrayBuffer(46));
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);         // version made by
      dv.setUint16(6, 20, true);         // version needed
      dv.setUint16(8, 0, true);
      dv.setUint16(10, e.method, true);
      dv.setUint16(12, e.time, true);
      dv.setUint16(14, e.day, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.compSize, true);
      dv.setUint32(24, e.rawSize, true);
      dv.setUint16(28, e.nameBytes.length, true);
      dv.setUint32(42, e.offset, true);  // relative offset of local header
      cdParts.push(new Uint8Array(dv.buffer), e.nameBytes);
      cdSize += 46 + e.nameBytes.length;
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, this.entries.length, true);
    eocd.setUint16(10, this.entries.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, cdStart, true);
    return [...this.parts, ...cdParts, new Uint8Array(eocd.buffer)];
  }
}

/* ------------------------------------------------------------------- XML */

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeXml = (s) => String(s).replace(/[&<>"]/g, (c) => XML_ESCAPES[c]);

export function colName(index) { // 1 -> A
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const STYLE = { plain: 0, header: 1, date: 2, money: 3, decimal: 4 };

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.0"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17794B"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const workbookXml = (sheetName) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<fileVersion appName="upload-demo"/>
<workbookPr date1904="false"/>
<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const coreXml = (title) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>upload-demo generator</dc:creator>
<cp:lastModifiedBy>upload-demo generator</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created>
</cp:coreProperties>`;

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>upload-demo</Application><Company>Synthetic Data Co (fictional)</Company>
</Properties>`;

function cellXml(ref, value, type) {
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
  switch (type) {
    case 'int':
      return Number.isFinite(Number(value))
        ? `<c r="${ref}"><v>${Number(value)}</v></c>`
        : `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    case 'money':
    case 'num': {
      const n = Number(value);
      return Number.isFinite(n)
        ? `<c r="${ref}" s="${type === 'money' ? STYLE.money : STYLE.decimal}"><v>${n}</v></c>`
        : `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    }
    case 'date':
      return `<c r="${ref}" s="${STYLE.date}"><v>${toExcelSerial(value instanceof Date ? value : new Date(value))}</v></c>`;
    default:
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
  }
}

/**
 * Generate a workbook of synthetic sales rows.
 *
 * Stop condition is either `rowCount` or `targetBytes` (whichever is given; with
 * targetBytes the writer keeps appending rows until the *archive* is about that big).
 *
 * @returns {Promise<{parts: Uint8Array[], bytes: number, rowCount: number}>}
 */
export async function buildWorkbook({
  rowCount = 0,
  targetBytes = 0,
  compress = true,
  sheetName = 'Orders',
  seed = 20260923,
  defectEvery = 150,
  columns = COLUMNS,
  onProgress = null,
  signal = null,
  flushEvery = 2000,
} = {}) {
  if (!rowCount && !targetBytes) throw new Error('buildWorkbook needs rowCount or targetBytes');

  // Stored parts land byte-for-byte, so the raw sheet size is the file size. Deflate
  // squeezes these repetitive rows to about an eighth, which is only an estimate — a
  // byte target with compress:true is approximate by nature.
  const ratio = compress ? 0.125 : 1;
  const targetSheetBytes = targetBytes ? Math.max(4096, (targetBytes - 6000) / ratio) : 0;

  const lastCol = colName(columns.length);
  const body = [];
  let bodyBytes = 0;
  let buf = [];

  const headerCells = columns
    .map((c, i) => `<c r="${colName(i + 1)}1" s="${STYLE.header}" t="inlineStr"><is><t>${escapeXml(c.label)}</t></is></c>`)
    .join('');
  buf.push(`<row r="1" ht="18" customHeight="1">${headerCells}</row>`);

  const flush = async (rowsSoFar, done = false) => {
    if (buf.length) {
      const bytes = enc.encode(buf.join(''));
      body.push(bytes);
      bodyBytes += bytes.length;
      buf = [];
    }
    if (onProgress) await onProgress({ rows: rowsSoFar, bytes: bodyBytes, done });
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
  };

  let written = 0;
  // When a byte target is given the exact row count is unknown up front, so the writer
  // measures its own average row size at each flush and works out how many rows are
  // still missing. That lands within a fraction of a percent of the requested size.
  let hardStop = rowCount || 0;
  const gen = rowStream(Number.MAX_SAFE_INTEGER, { seed, defectEvery });
  for (const row of gen) {
    const r = written + 2; // row 1 is the header
    let cells = '';
    for (let i = 0; i < columns.length; i++) {
      cells += cellXml(`${colName(i + 1)}${r}`, row[columns[i].key], columns[i].type);
    }
    buf.push(`<row r="${r}">${cells}</row>`);
    written++;
    if (written % flushEvery === 0) {
      await flush(written);
      if (targetSheetBytes) {
        const avgRow = bodyBytes / written;
        const remaining = Math.round((targetSheetBytes - bodyBytes) / avgRow);
        if (remaining <= flushEvery) hardStop = written + Math.max(0, remaining);
      }
    }
    if (hardStop && written >= hardStop) break;
  }
  await flush(written, true);

  const colsXml = columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`)
    .join('');
  const lastRow = written + 1;
  const prefix = enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${colsXml}</cols>
<sheetData>`);
  const suffix = enc.encode(`</sheetData><autoFilter ref="A1:${lastCol}${lastRow}"/></worksheet>`);

  const zip = new ZipWriter({ compress });
  await zip.add('[Content_Types].xml', [enc.encode(CONTENT_TYPES)]);
  await zip.add('_rels/.rels', [enc.encode(ROOT_RELS)]);
  await zip.add('docProps/core.xml', [enc.encode(coreXml(`${sheetName} — synthetic data`))]);
  await zip.add('docProps/app.xml', [enc.encode(APP_XML)]);
  await zip.add('xl/workbook.xml', [enc.encode(workbookXml(sheetName))]);
  await zip.add('xl/_rels/workbook.xml.rels', [enc.encode(WORKBOOK_RELS)]);
  await zip.add('xl/styles.xml', [enc.encode(STYLES)]);
  await zip.add('xl/worksheets/sheet1.xml', [prefix, ...body, suffix]);

  const parts = zip.finish();
  const bytes = parts.reduce((n, p) => n + p.length, 0);
  return { parts, bytes, rowCount: written };
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
