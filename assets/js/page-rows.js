// Demo 2 — parse a large workbook in a worker, then import it in row batches.

import { $, el, fmtBytes, fmtDuration, fmtNum, Logger, wireFilePicker, downloadBlob } from './util.js';
import { COLUMNS } from './dataset.js';
import { generateXlsxFile, XLSX_MIME } from './filegen.js';
import { SheetReader } from './sheet-client.js';
import { RowIngestBackend } from './backend-rows.js';
import { BatchImporter, IMPORT_STATE } from './row-importer.js';
import { stashFile } from './idb.js';

const log = new Logger($('#log'));
const backend = new RowIngestBackend();
const reader = new SheetReader();

let file = null;
let sheet = null;          // { name, rows, cols }
let headerLabels = [];
let keys = [];             // field key per column, '' when unmapped
let dataRows = [];         // parsed rows, without the header
let importer = null;
let busy = false;

const LABEL_TO_KEY = new Map(COLUMNS.map((c) => [c.label.toLowerCase(), c.key]));

/* -------------------------------------------------------------- settings */

function bindRange(inputId, labelId, format, onChange) {
  const input = $(inputId);
  const label = $(labelId);
  const apply = () => {
    const v = Number(input.value);
    label.textContent = format ? format(v) : v;
    onChange?.(v);
  };
  input.addEventListener('input', apply);
  apply();
}

function syncBackend() {
  backend.configure({
    latencyMs: Number($('#optLat').value),
    msPerRow: Number($('#optRowCost').value) / 100,
    failureRate: Number($('#optFail').value) / 100,
    validate: $('#optValidate').checked,
  });
}

bindRange('#optConcurrency', '#optConcurrencyVal');
bindRange('#optRetries', '#optRetriesVal');
bindRange('#optLat', '#optLatVal', null, syncBackend);
bindRange('#optRowCost', '#optRowCostVal', (v) => (v / 100).toFixed(2), syncBackend);
bindRange('#optFail', '#optFailVal', null, syncBackend);
$('#optValidate').addEventListener('change', syncBackend);
syncBackend();

/* ------------------------------------------------------------ file input */

wireFilePicker({
  zone: $('#dropzone'),
  input: $('#fileInput'),
  accept: '.xlsx,.xlsm,.xls,.csv',
  onFile: (f) => loadFile(f),
});

$('#genXlsx').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  const rowCount = Number($('#genRows').value);
  const box = $('#genProgress');
  box.hidden = false;
  $('#genBar').style.width = '0%';
  $('#genXlsx').disabled = true;
  const t0 = performance.now();
  try {
    const generated = await generateXlsxFile({
      rowCount,
      compress: true,     // a realistic .xlsx: deflated, so 250k rows is ~30 MB not 200 MB
      onProgress: ({ pct, detail }) => {
        $('#genBar').style.width = `${pct.toFixed(1)}%`;
        $('#genPct').textContent = `${pct.toFixed(0)}%`;
        $('#genLabel').textContent = detail;
      },
    });
    log.ok(`Generated ${generated.name} — ${fmtNum(rowCount)} rows, ${fmtBytes(generated.size)} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    await loadFile(generated);
  } catch (err) {
    log.err(`Generation failed: ${err.message}`);
  } finally {
    busy = false;
    $('#genXlsx').disabled = false;
    setTimeout(() => { box.hidden = true; }, 600);
  }
});

$('#btnSaveXlsx').addEventListener('click', () => file && downloadBlob(file, file.name));

$('#btnPreview').addEventListener('click', async (e) => {
  e.preventDefault();
  const id = await stashFile({ name: file.name, type: file.type || XLSX_MIME, size: file.size, blob: file, source: 'row import' });
  location.href = `preview.html?stash=${encodeURIComponent(id)}`;
});

/* ----------------------------------------------------------- parse phase */

async function loadFile(f) {
  file = f;
  $('#btnSaveXlsx').disabled = false;
  $('#btnPreview').hidden = false;
  $('#fileChip').hidden = false;
  $('#fileChip').replaceChildren(el('div', { class: 'file-chip' },
    el('div', { class: 'ficon xlsx', text: 'XLS' }),
    el('div', {},
      el('div', { class: 'fname', text: f.name }),
      el('div', { class: 'fmeta', text: `${fmtBytes(f.size)} · ${f.type || 'spreadsheet'}` }),
    ),
  ));
  await parseFile();
}

function setParseProgress(pct, label) {
  $('#parseBar').style.width = `${pct.toFixed(1)}%`;
  $('#parsePct').textContent = `${pct.toFixed(0)}%`;
  if (label) $('#parseLabel').textContent = label;
}

async function parseFile() {
  $('#parseBadge').textContent = 'parsing';
  $('#parseBadge').className = 'badge accent';
  $('#parseOuter').classList.add('busy');
  $('#btnStart').disabled = true;
  dataRows = [];
  const t0 = performance.now();

  reader.onPhase = ({ detail }) => setParseProgress(5, detail);
  try {
    setParseProgress(2, 'Reading file…');
    const { sheets, ms } = await reader.load(file);
    sheet = sheets[0];
    log.info(`Workbook decoded in ${ms}ms — ${sheets.length} sheet(s), first is "${sheet.name}" with ${fmtNum(sheet.rows)} rows × ${sheet.cols} cols`);

    const header = await reader.range({ sheet: sheet.name, mode: 'display', from: 0, count: 1 });
    headerLabels = (header.rows[0] || []).map((v) => String(v ?? ''));
    keys = headerLabels.map((label) => LABEL_TO_KEY.get(label.trim().toLowerCase()) || '');
    renderMapping();

    const total = Math.max(0, sheet.rows - 1);
    dataRows = new Array(total);
    let filled = 0;
    await reader.stream({
      sheet: sheet.name,
      mode: 'value',
      chunkSize: 5000,
      onChunk: ({ from, rows }) => {
        for (let i = 0; i < rows.length; i++) {
          const target = from + i - 1;         // drop the header row
          if (target >= 0) { dataRows[target] = rows[i]; filled++; }
        }
        setParseProgress(Math.min(99, (filled / Math.max(1, total)) * 100), `Extracting rows… ${fmtNum(filled)} / ${fmtNum(total)}`);
      },
    });
    dataRows.length = Math.max(0, filled);

    const secs = (performance.now() - t0) / 1000;
    setParseProgress(100, `${fmtNum(dataRows.length)} data rows ready`);
    $('#parseMeta').textContent = `${fmtNum(dataRows.length)} rows · ${headerLabels.length} columns · ${secs.toFixed(1)}s`;
    $('#parseBadge').textContent = 'ready';
    $('#parseBadge').className = 'badge ok';
    $('#parseOuter').classList.remove('busy');
    $('#parseOuter').classList.add('ok');
    log.ok(`Parsed ${fmtNum(dataRows.length)} rows in ${secs.toFixed(1)}s`);
    prepareImport();
  } catch (err) {
    $('#parseBadge').textContent = 'failed';
    $('#parseBadge').className = 'badge err';
    $('#parseOuter').classList.remove('busy');
    setParseProgress(100, err.message);
    log.err(`Parse failed: ${err.message}`);
  }
}

function renderMapping() {
  const box = $('#mapping');
  box.replaceChildren(...headerLabels.map((label, i) => el('div', {
    class: 'row tight',
    style: 'justify-content:space-between;font-size:12.5px;padding:3px 0;border-bottom:1px solid var(--line-2)',
  },
    el('span', { text: label || `(column ${i + 1})` }),
    keys[i]
      ? el('code', { class: 'inline', text: keys[i] })
      : el('span', { class: 'badge warn', text: 'unmapped' }),
  )));
  const unmapped = keys.filter((k) => !k).length;
  if (unmapped) log.warn(`${unmapped} column(s) did not match a known field and will be sent as-is`);
}

/* ---------------------------------------------------------- import phase */

let batchCells = [];

function prepareImport() {
  importer = new BatchImporter({
    rows: dataRows,
    keys,
    backend,
    batchSize: Number($('#optBatch').value),
    concurrency: Number($('#optConcurrency').value),
    maxRetries: Number($('#optRetries').value),
    stopOnError: $('#optStopOnError').checked,
    meta: { fileName: file.name, sheet: sheet?.name },
  });

  importer.on('log', ({ message, level }) => log.line(message, level));
  importer.on('state', paintImportState);
  importer.on('progress', paintImportProgress);
  importer.on('batch', paintBatch);
  importer.on('rejections', addRejections);
  importer.on('done', onImportDone);

  buildBatchMap(importer.totalBatches);
  resetRejectTable();
  $('#importResult').hidden = true;
  $('#batchLabel').textContent = `${fmtNum(importer.totalBatches)} batches × ${fmtNum(importer.batchSize)} rows`;
  $('#importLabel').textContent = `${fmtNum(dataRows.length)} rows ready to import`;
  $('#importBar').style.width = '0%';
  $('#importPct').textContent = '0%';
  $('#importOuter').classList.remove('ok', 'err');
  $('#btnStart').disabled = dataRows.length === 0;
  paintImportState(IMPORT_STATE.IDLE);
  paintImportProgress({
    processed: 0, total: dataRows.length, pct: 0, accepted: 0, rejected: 0,
    rate: 0, etaSec: Infinity, doneBatches: 0, totalBatches: importer.totalBatches, retries: 0,
  });
}

$('#optBatch').addEventListener('change', () => dataRows.length && prepareImport());
$('#optConcurrency').addEventListener('change', () => dataRows.length && prepareImport());
$('#optRetries').addEventListener('change', () => dataRows.length && prepareImport());
$('#optStopOnError').addEventListener('change', () => dataRows.length && prepareImport());

function buildBatchMap(count) {
  const map = $('#batchmap');
  batchCells = [];
  const frag = document.createDocumentFragment();
  const shown = Math.min(count, 4000);
  for (let i = 0; i < shown; i++) {
    const cell = el('i', { class: 'pending', title: `batch ${i}` });
    batchCells.push(cell);
    frag.append(cell);
  }
  map.replaceChildren(frag);
  if (count > shown) map.append(el('span', { class: 'hint', text: `+${fmtNum(count - shown)} more` }));
}

function paintBatch({ index, status, done, size }) {
  const cell = batchCells[index];
  if (cell) {
    cell.className = status;
    if (status === 'active' && size) cell.style.setProperty('--fill', `${Math.round((done / size) * 100)}%`);
    else cell.style.removeProperty('--fill');
  }
  if (status === 'active' && size) {
    $('#batchBar').style.width = `${(done / size) * 100}%`;
    $('#currentBatchLabel').textContent = `Batch ${fmtNum(index + 1)} of ${fmtNum(importer.totalBatches)}`;
    $('#currentBatchRows').textContent = `${fmtNum(done)} / ${fmtNum(size)} rows`;
  }
}

let rafPending = false;
let latest = null;
function paintImportProgress(p) {
  latest = p;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const q = latest;
    $('#importBar').style.width = `${q.pct.toFixed(2)}%`;
    $('#importPct').textContent = `${q.pct.toFixed(1)}%`;
    $('#statRows').textContent = `${fmtNum(Math.round(q.processed))}`;
    $('#statAccepted').textContent = fmtNum(q.accepted);
    $('#statRejected').textContent = fmtNum(q.rejected);
    $('#statRate').textContent = q.rate > 0 ? fmtNum(Math.round(q.rate)) : '–';
    $('#statBatches').textContent = `${fmtNum(q.doneBatches)} / ${fmtNum(q.totalBatches)}`;
    $('#statRetries').textContent = fmtNum(q.retries);
    if (importer?.state === IMPORT_STATE.RUNNING) {
      $('#importLabel').textContent = `Importing ${file.name} — ETA ${fmtDuration(q.etaSec)}`;
    }
  });
}

function paintImportState(state) {
  const badge = $('#importBadge');
  badge.textContent = state;
  badge.className = `badge ${{ done: 'ok', error: 'err', aborted: 'err', paused: 'warn', running: 'accent' }[state] || ''}`;
  const outer = $('#importOuter');
  outer.classList.toggle('busy', state === IMPORT_STATE.RUNNING);
  outer.classList.toggle('ok', state === IMPORT_STATE.DONE);
  outer.classList.toggle('err', state === IMPORT_STATE.ERROR || state === IMPORT_STATE.ABORTED);

  const running = state === IMPORT_STATE.RUNNING;
  const paused = state === IMPORT_STATE.PAUSED;
  $('#btnStart').textContent = state === IMPORT_STATE.DONE ? 'Import again' : 'Start import';
  $('#btnStart').disabled = running || paused || !dataRows.length;
  $('#btnPause').disabled = !running;
  $('#btnPause').hidden = paused;
  $('#btnResume').hidden = !paused;
  $('#btnCancel').disabled = !(running || paused);
  if (state === IMPORT_STATE.PAUSED) $('#importLabel').textContent = 'Paused';
  if (state === IMPORT_STATE.ABORTED) $('#importLabel').textContent = 'Cancelled';
}

/* ------------------------------------------------------------ rejections */

let rejectRowsShown = 0;
function resetRejectTable() {
  rejectRowsShown = 0;
  $('#rejectTable').tBodies[0].replaceChildren(
    el('tr', {}, el('td', { colspan: 3, class: 'hint', style: 'padding:12px', text: 'No rejections yet.' })),
  );
  $('#rejectCount').textContent = '0';
  $('#btnExportErrors').disabled = true;
}

function addRejections(list) {
  if (!list.length) return;
  const body = $('#rejectTable').tBodies[0];
  if (rejectRowsShown === 0) body.replaceChildren();
  for (const r of list) {
    if (rejectRowsShown >= 200) break;
    body.append(el('tr', { class: 'bad' },
      el('td', { class: 'num', text: fmtNum(r.rowNumber) }),
      el('td', { text: String(r.data?.order_ref ?? '—') }),
      el('td', { text: r.problems.join('; ') }),
    ));
    rejectRowsShown++;
  }
  $('#rejectCount').textContent = fmtNum(importer.rejections.length);
  $('#btnExportErrors').disabled = false;
}

$('#btnExportErrors').addEventListener('click', () => {
  const csv = importer.errorReportCsv();
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `rejected-rows-${file.name.replace(/\.[^.]+$/, '')}.csv`);
});

function onImportDone(summary) {
  const box = $('#importResult');
  box.hidden = false;
  const failed = summary.failedBatches;
  box.replaceChildren(el('div', { class: `alert ${failed ? 'warn' : 'ok'}` },
    `${fmtNum(summary.inserted)} rows inserted, ${fmtNum(summary.rejected)} rejected by validation`
    + `${failed ? `, ${failed} batch(es) abandoned after repeated failures` : ''} — `
    + `${summary.elapsed.toFixed(1)}s at ${fmtNum(Math.round(summary.inserted / Math.max(0.001, summary.elapsed)))} rows/sec.`,
  ));
  $('#importLabel').textContent = `Imported ${file.name}`;
}

/* --------------------------------------------------------------- buttons */

$('#btnStart').addEventListener('click', () => {
  if (importer.state === IMPORT_STATE.DONE || importer.state === IMPORT_STATE.ABORTED) prepareImport();
  log.clear();
  importer.start();
});
$('#btnPause').addEventListener('click', () => importer.pause());
$('#btnResume').addEventListener('click', () => importer.resume());
$('#btnCancel').addEventListener('click', () => importer.abort());
$('#btnClearLog').addEventListener('click', () => log.clear());

log.info('Ready. Generate a workbook (or drop one in) — it will be parsed, then imported in batches.');
