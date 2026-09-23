// Browser-side wrappers around the PDF and XLSX writers.
//
// Both writers await their progress callback between blocks, so the callbacks here hand
// the main thread back to the browser — that is what keeps the generation progress bar
// moving instead of freezing the tab for a few seconds.

import { buildPdf, PDF_MIME } from './pdf-writer.js';
import { buildWorkbook, XLSX_MIME } from './xlsx-writer.js';
import { fmtBytes } from './util.js';

const breathe = () => new Promise((r) => setTimeout(r, 0));

const sizeTag = (bytes) => {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb)}mb` : `${Math.round(bytes / 1024)}kb`;
};

/**
 * @param {object} o
 * @param {number} [o.targetBytes] stop once the document is about this big
 * @param {number} [o.pages]       …or produce exactly this many pages
 * @param {(p: {phase: string, bytes: number, pct: number, detail: string}) => void} [o.onProgress]
 * @returns {Promise<File>}
 */
export async function generatePdfFile({ targetBytes = 0, pages = 0, onProgress, signal, name } = {}) {
  const result = await buildPdf({
    targetBytes,
    pages,
    signal,
    async onProgress({ pages: pageCount, bytes }) {
      onProgress?.({
        phase: 'pdf',
        bytes,
        pct: targetBytes ? Math.min(99, (bytes / targetBytes) * 100) : Math.min(99, (pageCount / pages) * 100),
        detail: `${pageCount.toLocaleString()} pages · ${fmtBytes(bytes)}`,
      });
      await breathe();
    },
  });
  const blob = new Blob(result.parts, { type: PDF_MIME });
  onProgress?.({ phase: 'pdf', bytes: blob.size, pct: 100, detail: `${result.pageCount.toLocaleString()} pages · ${fmtBytes(blob.size)}` });
  const file = new File([blob], name || `synthetic-ledger-${sizeTag(blob.size)}.pdf`, { type: PDF_MIME });
  file.meta = { pageCount: result.pageCount };
  return file;
}

/**
 * @param {object} o
 * @param {number} [o.targetBytes] stop once the workbook is about this big
 * @param {number} [o.rowCount]    …or produce exactly this many data rows
 * @param {boolean} [o.compress]   deflate the sheet (small file) or store it (big file)
 * @returns {Promise<File>}
 */
export async function generateXlsxFile({
  targetBytes = 0,
  rowCount = 0,
  compress = true,
  defectEvery = 150,
  onProgress,
  signal,
  name,
} = {}) {
  const result = await buildWorkbook({
    targetBytes,
    rowCount,
    compress,
    defectEvery,
    signal,
    async onProgress({ rows, bytes }) {
      onProgress?.({
        phase: 'xlsx',
        bytes,
        pct: rowCount ? Math.min(99, (rows / rowCount) * 100) : Math.min(99, (bytes * (compress ? 0.09 : 0.985)) / targetBytes * 100),
        detail: `${rows.toLocaleString()} rows${compress ? '' : ` · ${fmtBytes(bytes)}`}`,
      });
      await breathe();
    },
  });
  const blob = new Blob(result.parts, { type: XLSX_MIME });
  onProgress?.({ phase: 'xlsx', bytes: blob.size, pct: 100, detail: `${result.rowCount.toLocaleString()} rows · ${fmtBytes(blob.size)}` });
  const fileName = name
    || (rowCount
      ? `orders-${result.rowCount.toLocaleString('en-US').replace(/,/g, '')}-rows.xlsx`
      : `orders-${sizeTag(blob.size)}.xlsx`);
  const file = new File([blob], fileName, { type: XLSX_MIME });
  file.meta = { rowCount: result.rowCount };
  return file;
}

export { PDF_MIME, XLSX_MIME };
