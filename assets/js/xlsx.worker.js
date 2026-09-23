/* Workbook parsing worker.
 *
 * SheetJS is synchronous and a 250k-row sheet takes seconds to decode, so it runs here
 * instead of on the main thread. The worker holds the parsed workbook, then streams rows
 * back in chunks — which is what gives both demo 2 and the preview page an honest
 * progress bar rather than a spinner over a frozen tab.
 *
 * Messages in:
 *   { type: 'load',  buffer }                         -> 'loaded'  { sheets: [{name, rows, cols}] }
 *   { type: 'stream', sheet, mode, chunkSize, maxRows } -> many 'chunk' then 'end'
 *   { type: 'range', sheet, mode, from, count }       -> 'range'   { rows, from }
 *
 * mode: 'value'   raw typed values (numbers stay numbers) — for validation
 *       'display' formatted text as Excel would show it   — for the preview grid
 */

/* global XLSX */
importScripts('../vendor/xlsx.full.min.js');

let wb = null;
/** @type {Record<string, any[][]>} dense cell grid per sheet */
const grids = Object.create(null);

function gridOf(name) {
  if (grids[name]) return grids[name];
  const ws = wb.Sheets[name];
  // Dense sheets keep one array per row. SheetJS 0.18 hangs them off numeric keys on the
  // sheet itself; 0.19+ moved them to ws['!data']. Support both, then fall back to
  // walking !ref cell by cell for a sparse sheet (a workbook from somewhere else).
  let data = ws['!data'];
  if (!data && Array.isArray(ws[0])) {
    const r0 = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    data = [];
    for (let r = r0.s.r; r <= r0.e.r; r++) data[r] = ws[r] || [];
  }
  if (!data) {
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    data = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        row[c] = ws[XLSX.utils.encode_cell({ r, c })];
      }
      data[r] = row;
    }
  }
  grids[name] = data;
  return data;
}

function cellValue(cell, mode) {
  if (!cell) return null;
  if (mode === 'display') {
    if (cell.w !== undefined) return cell.w;
    if (cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
    return cell.v === undefined ? null : cell.v;
  }
  return cell.v === undefined ? null : cell.v;
}

function rowsSlice(name, mode, from, count, width) {
  const data = gridOf(name);
  const out = [];
  const end = Math.min(from + count, data.length);
  for (let r = from; r < end; r++) {
    const src = data[r] || [];
    const row = new Array(width);
    for (let c = 0; c < width; c++) row[c] = cellValue(src[c], mode);
    out.push(row);
  }
  return out;
}

function sheetDims(name) {
  const ws = wb.Sheets[name];
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  return { name, rows: range.e.r + 1, cols: range.e.c + 1 };
}

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') {
      const t0 = Date.now();
      postMessage({ type: 'phase', phase: 'decode', detail: 'Decoding workbook…' });
      wb = XLSX.read(new Uint8Array(msg.buffer), {
        type: 'array',
        dense: true,
        cellDates: false,
        cellStyles: false,
        cellHTML: false,
      });
      for (const k of Object.keys(grids)) delete grids[k];
      postMessage({
        type: 'loaded',
        sheets: wb.SheetNames.map(sheetDims),
        ms: Date.now() - t0,
      });
      return;
    }

    if (msg.type === 'stream') {
      const name = msg.sheet || wb.SheetNames[0];
      const dims = sheetDims(name);
      const width = dims.cols;
      const total = msg.maxRows ? Math.min(dims.rows, msg.maxRows) : dims.rows;
      const chunkSize = msg.chunkSize || 5000;
      postMessage({ type: 'phase', phase: 'extract', detail: `Extracting ${total.toLocaleString()} rows…` });
      for (let from = 0; from < total; from += chunkSize) {
        const rows = rowsSlice(name, msg.mode || 'value', from, Math.min(chunkSize, total - from), width);
        postMessage({ type: 'chunk', from, rows, total, width });
      }
      postMessage({ type: 'end', total, width, sheet: name });
      return;
    }

    if (msg.type === 'find') {
      const name = msg.sheet || wb.SheetNames[0];
      const data = gridOf(name);
      const needle = String(msg.query || '').toLowerCase();
      let hit = { row: -1, col: -1 };
      if (needle) {
        for (let r = msg.from || 0; r < data.length && hit.row < 0; r++) {
          const row = data[r] || [];
          for (let c = 0; c < row.length; c++) {
            const cell = row[c];
            if (!cell) continue;
            const text = String(cell.w !== undefined ? cell.w : cell.v).toLowerCase();
            if (text.indexOf(needle) > -1) { hit = { row: r, col: c }; break; }
          }
        }
      }
      postMessage({ type: 'found', ...hit, sheet: name });
      return;
    }

    if (msg.type === 'range') {
      const name = msg.sheet || wb.SheetNames[0];
      const width = sheetDims(name).cols;
      postMessage({
        type: 'range',
        from: msg.from,
        rows: rowsSlice(name, msg.mode || 'display', msg.from, msg.count, width),
        width,
      });
      return;
    }
  } catch (err) {
    postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
