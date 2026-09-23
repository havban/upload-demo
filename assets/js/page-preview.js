// Demo 3 — preview a PDF or a workbook in the tab.

import { $, el, fmtBytes, fmtNum, kindOf, extOf, downloadBlob } from './util.js';
import { SheetReader } from './sheet-client.js';
import { listStashedFiles, idbGet, STORES } from './idb.js';
import { boot, event, once, sizeBucket } from './analytics.js';
import * as pdfjs from '../vendor/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

let current = null;      // { name, size, type, blob }
let reader = null;

/* ------------------------------------------------------------ file input */

const dropzone = $('#dropzone');
const input = $('#fileInput');
dropzone.addEventListener('click', (e) => { if (!e.target.closest('button,a')) input.click(); });
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) open(f);
});
input.addEventListener('change', () => { if (input.files?.[0]) open(input.files[0]); input.value = ''; });

$('#btnSamplePdf').addEventListener('click', () => {
  once('sample-pdf', 'Opened the sample PDF');
  openUrl('samples/synthetic-ledger-2mb.pdf', 'application/pdf');
});
$('#btnSampleXlsx').addEventListener('click', () => {
  once('sample-xlsx', 'Opened the sample workbook');
  openUrl('samples/orders-20000-rows.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

async function openUrl(url, type) {
  const name = url.split('/').pop();
  setStatus(`Fetching ${name}…`);
  const res = await fetch(url);
  if (!res.ok) { setStatus(`Could not load ${name}: ${res.status}`); return; }
  open(new File([await res.blob()], name, { type }));
}

async function open(file) {
  current = file;
  const kind = kindOf(file);
  $('#fileChip').hidden = false;
  $('#fileChip').replaceChildren(el('div', { class: 'file-chip' },
    el('div', { class: `ficon ${kind}`, text: kind === 'pdf' ? 'PDF' : kind === 'xlsx' ? 'XLS' : 'BIN' }),
    el('div', {},
      el('div', { class: 'fname', text: file.name }),
      el('div', { class: 'fmeta', text: `${fmtBytes(file.size)} · ${file.type || extOf(file.name) || 'unknown type'}` }),
    ),
  ));
  event(`preview-${kind}-${sizeBucket(file.size)}`, `Previewed a ${kind} of ${sizeBucket(file.size)}`);
  $('#emptyPane').hidden = true;
  $('#pdfPane').hidden = kind !== 'pdf';
  $('#sheetPane').hidden = kind !== 'xlsx';
  if (kind === 'pdf') await openPdf(file);
  else if (kind === 'xlsx') await openSheet(file);
  else {
    $('#emptyPane').hidden = false;
    $('#emptyPane').querySelector('.hint').textContent =
      `${file.name} is neither a PDF nor a spreadsheet, so there is nothing to render here.`;
  }
}

/* ---------------------------------------------------------- PDF renderer */

const pdfState = { doc: null, page: 1, scale: 1, fitWidth: true, perView: 1, rendering: false };

async function openPdf(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  pdfState.doc = await pdfjs.getDocument({ data: buf }).promise;
  pdfState.page = 1;
  const meta = await pdfState.doc.getMetadata().catch(() => null);
  $('#pdfCount').textContent = `of ${fmtNum(pdfState.doc.numPages)}`;
  $('#pdfPage').max = pdfState.doc.numPages;
  $('#pdfPage').value = 1;
  $('#pdfMeta').textContent = `${fmtNum(pdfState.doc.numPages)} pages · ${meta?.info?.Title || 'untitled'}`;
  await renderPdf();
}

async function renderPdf() {
  if (!pdfState.doc || pdfState.rendering) return;
  pdfState.rendering = true;
  const stage = $('#pdfStage');
  const count = pdfState.perView;
  const first = Math.min(pdfState.page, Math.max(1, pdfState.doc.numPages - count + 1));
  const frag = document.createDocumentFragment();

  for (let i = 0; i < count && first + i <= pdfState.doc.numPages; i++) {
    const pageNo = first + i;
    const page = await pdfState.doc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const scale = pdfState.fitWidth
      ? Math.min(2.5, (stage.clientWidth - 40) / base.width)
      : pdfState.scale;
    const viewport = page.getViewport({ scale });
    const canvas = el('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    await page.render({ canvasContext: ctx, viewport }).promise;
    frag.append(el('div', { class: 'pdf-page-wrap' }, canvas, el('span', { class: 'plabel', text: `${pageNo} / ${pdfState.doc.numPages}` })));
    if (!pdfState.fitWidth) pdfState.scale = scale;
    else $('#pdfZoomLabel').textContent = `${Math.round(scale * 100)}%`;
  }

  stage.replaceChildren(frag);
  stage.scrollTop = 0;
  $('#pdfPage').value = first;
  pdfState.page = first;
  pdfState.rendering = false;
}

const goPage = (n) => {
  if (!pdfState.doc) return;
  once('pdf-paged', 'Moved through a PDF');
  pdfState.page = Math.max(1, Math.min(pdfState.doc.numPages, n));
  renderPdf();
};
$('#pdfFirst').addEventListener('click', () => goPage(1));
$('#pdfPrev').addEventListener('click', () => goPage(pdfState.page - pdfState.perView));
$('#pdfNext').addEventListener('click', () => goPage(pdfState.page + pdfState.perView));
$('#pdfLast').addEventListener('click', () => goPage(pdfState.doc?.numPages || 1));
$('#pdfPage').addEventListener('change', (e) => goPage(Number(e.target.value)));
$('#pdfZoomIn').addEventListener('click', () => { once('pdf-zoom', 'Zoomed a PDF'); pdfState.fitWidth = false; pdfState.scale = Math.min(4, pdfState.scale * 1.25); $('#pdfZoomLabel').textContent = `${Math.round(pdfState.scale * 100)}%`; renderPdf(); });
$('#pdfZoomOut').addEventListener('click', () => { once('pdf-zoom', 'Zoomed a PDF'); pdfState.fitWidth = false; pdfState.scale = Math.max(0.2, pdfState.scale / 1.25); $('#pdfZoomLabel').textContent = `${Math.round(pdfState.scale * 100)}%`; renderPdf(); });
$('#pdfFit').addEventListener('click', () => { pdfState.fitWidth = true; renderPdf(); });
$('#pdfContinuous').addEventListener('change', (e) => { once('pdf-multipage', 'Switched the PDF to five pages at a time'); pdfState.perView = e.target.checked ? 5 : 1; renderPdf(); });
$('#pdfDownload').addEventListener('click', () => { once('pdf-download', 'Downloaded the open PDF'); current && downloadBlob(current, current.name); });
window.addEventListener('keydown', (e) => {
  if ($('#pdfPane').hidden || e.target.matches('input,select,textarea')) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') goPage(pdfState.page + pdfState.perView);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') goPage(pdfState.page - pdfState.perView);
});

/* -------------------------------------------------------- sheet renderer */

const BLOCK = 200;
const grid = {
  sheets: [],
  sheet: null,
  total: 0,          // data rows, header excluded
  width: 0,
  header: [],
  rowH: 26,
  cache: new Map(),  // block index -> rows
  inflight: new Set(),
  searchRow: 0,
  hit: -1,
};

const viewport = $('#sheetViewport');
const body = $('#sheetBody');

function setStatus(text) { $('#sheetStatus').textContent = text; }

async function openSheet(file) {
  reader?.terminate();
  reader = new SheetReader();
  grid.cache.clear();
  grid.inflight.clear();
  grid.hit = -1;
  body.replaceChildren();
  setStatus('Decoding workbook…');
  reader.onPhase = ({ detail }) => setStatus(detail);

  const t0 = performance.now();
  const { sheets, ms } = await reader.load(file);
  grid.sheets = sheets;
  renderTabs();
  await selectSheet(sheets[0].name);
  setStatus(`${file.name} — decoded in ${ms} ms (${((performance.now() - t0) / 1000).toFixed(1)}s total)`);
}

function renderTabs() {
  $('#sheetTabs').replaceChildren(...grid.sheets.map((s) => el('button', {
    type: 'button',
    'aria-selected': String(s.name === grid.sheet),
    onclick: () => selectSheet(s.name),
  }, `${s.name} (${fmtNum(Math.max(0, s.rows - 1))})`)));
}

async function selectSheet(name) {
  const info = grid.sheets.find((s) => s.name === name);
  grid.sheet = name;
  grid.total = Math.max(0, info.rows - 1);
  grid.width = info.cols;
  grid.cache.clear();
  renderTabs();

  const head = await reader.range({ sheet: name, mode: 'display', from: 0, count: 1 });
  grid.header = (head.rows[0] || []).map((v, i) => (v == null || v === '' ? `Column ${i + 1}` : String(v)));
  $('#sheetHead').replaceChildren(
    el('th', { class: 'rowno', text: '#' }),
    ...grid.header.map((label) => el('th', { text: label })),
  );
  $('#sheetMeta').textContent = `${fmtNum(grid.total)} rows × ${grid.width} columns`;
  $('#sheetGoto').max = grid.total;
  viewport.scrollTop = 0;
  await renderWindow(true);
}

function blockOf(rowIndex) { return Math.floor(rowIndex / BLOCK); }

async function fetchBlock(block) {
  if (grid.cache.has(block) || grid.inflight.has(block)) return;
  grid.inflight.add(block);
  try {
    const from = block * BLOCK + 1;                       // +1 skips the header row
    const count = Math.min(BLOCK, grid.total - block * BLOCK);
    const res = await reader.range({ sheet: grid.sheet, mode: 'display', from, count });
    grid.cache.set(block, res.rows);
    if (grid.cache.size > 400) {                          // keep memory bounded
      for (const key of [...grid.cache.keys()].slice(0, 100)) grid.cache.delete(key);
    }
    renderWindow();
  } finally {
    grid.inflight.delete(block);
  }
}

function rowAt(index) {
  const rows = grid.cache.get(blockOf(index));
  return rows ? rows[index % BLOCK] : null;
}

let renderQueued = false;
async function renderWindow(force = false) {
  if (renderQueued && !force) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    paintWindow();
  });
}

function paintWindow() {
  if (!grid.total) {
    body.replaceChildren(el('tr', {}, el('td', { colspan: grid.width + 1, class: 'hint', text: 'Sheet is empty.' })));
    return;
  }
  const visible = Math.ceil(viewport.clientHeight / grid.rowH) + 6;
  const first = Math.max(0, Math.floor(viewport.scrollTop / grid.rowH) - 3);
  const last = Math.min(grid.total, first + visible);

  for (let b = blockOf(first); b <= blockOf(Math.max(first, last - 1)); b++) fetchBlock(b);

  const frag = document.createDocumentFragment();
  frag.append(el('tr', { class: 'spacer' }, el('td', { colspan: grid.width + 1, style: `height:${first * grid.rowH}px` })));
  for (let i = first; i < last; i++) {
    const cells = rowAt(i);
    const tr = el('tr', i === grid.hit ? { class: 'hit' } : {});
    tr.append(el('td', { class: 'rowno', text: fmtNum(i + 2) }));   // +2: 1-based, past the header
    for (let c = 0; c < grid.width; c++) {
      const v = cells ? cells[c] : null;
      tr.append(el('td', {
        class: cells ? (typeof v === 'number' ? 'num' : '') : 'loading',
        text: cells ? (v == null ? '' : String(v)) : '…',
      }));
    }
    frag.append(tr);
  }
  frag.append(el('tr', { class: 'spacer' }, el('td', { colspan: grid.width + 1, style: `height:${Math.max(0, (grid.total - last) * grid.rowH)}px` })));
  body.replaceChildren(frag);

  // Trust the browser over the stylesheet: measure a real row once it exists.
  const sample = body.querySelector('tr:not(.spacer)');
  if (sample) {
    const h = sample.getBoundingClientRect().height;
    if (h && Math.abs(h - grid.rowH) > 0.5) { grid.rowH = h; renderWindow(true); }
  }
}

viewport.addEventListener('scroll', () => renderWindow());
window.addEventListener('resize', () => renderWindow());

$('#btnGoto').addEventListener('click', () => {
  once('sheet-goto', 'Jumped to a row');
  const n = Math.max(1, Math.min(grid.total, Number($('#sheetGoto').value) || 1));
  viewport.scrollTop = (n - 1) * grid.rowH;
  renderWindow(true);
});

$('#btnFind').addEventListener('click', doFind);
$('#sheetSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') doFind(); });

async function doFind() {
  const query = $('#sheetSearch').value.trim();
  if (!query || !reader) return;
  once('sheet-search', 'Searched inside a sheet');
  setStatus(`Searching for “${query}”…`);
  const res = await reader.find({ sheet: grid.sheet, query, from: grid.searchRow + 1 });
  if (res.row < 0) {
    if (grid.searchRow > 0) { grid.searchRow = 0; setStatus('Reached the end — searching again from the top.'); return doFind(); }
    setStatus(`No cell contains “${query}”.`);
    grid.hit = -1;
    return;
  }
  grid.searchRow = res.row;
  grid.hit = res.row - 1;                       // sheet row -> data row index
  viewport.scrollTop = Math.max(0, (grid.hit - 4) * grid.rowH);
  renderWindow(true);
  setStatus(`Found “${query}” in row ${fmtNum(res.row + 1)}, column ${grid.header[res.col] || res.col + 1}.`);
}

$('#btnExportCsv').addEventListener('click', async () => {
  if (!reader) return;
  once('sheet-export-csv', 'Exported a sheet as CSV');
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  setStatus('Exporting…');
  await reader.stream({
    sheet: grid.sheet,
    mode: 'display',
    chunkSize: 5000,
    onChunk: ({ from, rows, total }) => {
      for (const r of rows) lines.push(r.map(esc).join(','));
      setStatus(`Exporting… ${fmtNum(Math.min(total, from + rows.length))} / ${fmtNum(total)} rows`);
    },
  });
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), `${current.name.replace(/\.[^.]+$/, '')}-${grid.sheet}.csv`);
  setStatus(`Exported ${fmtNum(lines.length)} rows as CSV.`);
});

/* -------------------------------------------- files handed over by demo 1/2 */

async function renderStash() {
  const files = await listStashedFiles();
  const box = $('#stashList');
  if (!files.length) return;
  box.replaceChildren(...files.slice(0, 4).map((f) => el('button', {
    class: 'btn small',
    style: 'margin:0 6px 6px 0',
    onclick: () => open(new File([f.blob], f.name, { type: f.type })),
  }, `${kindOf(f) === 'pdf' ? '📄' : '📊'} ${f.name} (${fmtBytes(f.size)})`)));
}

const stashId = new URLSearchParams(location.search).get('stash');
if (stashId) {
  once('opened-from-demo', 'Arrived from demo 1 or 2');
  idbGet(STORES.files, stashId).then((rec) => {
    if (rec) open(new File([rec.blob], rec.name, { type: rec.type }));
  });
}
renderStash();
boot();
