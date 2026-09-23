// Demo 1 — chunked upload of a large file, wired up.

import { $, el, fmtBytes, fmtDuration, fmtNum, kindOf, Logger, wireFilePicker, downloadBlob } from './util.js';
import { SimulatedBackend } from './backend-simulated.js';
import { RestBackend } from './backend-rest.js';
import { ChunkedUploader, UPLOAD_STATE } from './uploader.js';
import { generatePdfFile, generateXlsxFile } from './filegen.js';
import { stashFile } from './idb.js';

const MB = 1024 * 1024;
const log = new Logger($('#log'));
const sim = new SimulatedBackend();

let file = null;
let uploader = null;
let busyGenerating = false;
let lastResult = null;

/* --------------------------------------------------------------- settings */

const settings = {
  chunkSize: 4 * MB,
  concurrency: 3,
  maxRetries: 4,
  hashParts: true,
  backend: 'sim',
  restUrl: 'http://localhost:8787',
};

/** Push the network sliders into the simulated backend — live, mid-upload included. */
function syncSim() {
  sim.configure({
    bandwidthMbps: Number($('#optBw').value),
    latencyMs: Number($('#optLat').value),
    failureRate: Number($('#optFail').value) / 100,
    verifyChecksums: settings.hashParts,
  });
}

function currentBackend() {
  if (settings.backend === 'rest') return new RestBackend($('#optRestUrl').value.trim());
  syncSim();
  return sim;
}

function bindRange(inputId, labelId, onChange) {
  const input = $(inputId);
  const label = $(labelId);
  const apply = () => { label.textContent = input.value; onChange?.(Number(input.value)); };
  input.addEventListener('input', apply);
  apply();
}

bindRange('#optConcurrency', '#optConcurrencyVal', (v) => { settings.concurrency = v; });
bindRange('#optRetries', '#optRetriesVal', (v) => { settings.maxRetries = v; });
bindRange('#optBw', '#optBwVal', syncSim);
bindRange('#optLat', '#optLatVal', syncSim);
bindRange('#optFail', '#optFailVal', syncSim);

$('#optChunk').addEventListener('change', (e) => {
  settings.chunkSize = Number(e.target.value);
  if (file) resetUploader();
});
$('#optHash').addEventListener('change', (e) => { settings.hashParts = e.target.checked; syncSim(); });

$('#optBackend').addEventListener('change', (e) => {
  settings.backend = e.target.value;
  $('#restBox').hidden = settings.backend !== 'rest';
  $('#backendBadge').textContent = settings.backend === 'rest'
    ? `REST · ${$('#optRestUrl').value}`
    : 'Simulated (in-browser)';
  if (file) resetUploader();
});

$('#btnPing').addEventListener('click', async () => {
  const out = $('#pingResult');
  out.textContent = 'Checking…';
  try {
    const info = await new RestBackend($('#optRestUrl').value.trim()).ping();
    out.innerHTML = `<span class="badge ok">online</span> ${info.service || 'server'} · ${info.sessions ?? 0} sessions`;
  } catch (err) {
    out.innerHTML = `<span class="badge err">unreachable</span> ${err.message}`;
  }
});

/* ------------------------------------------------------------ file picker */

wireFilePicker({
  zone: $('#dropzone'),
  input: $('#fileInput'),
  onFile: (f) => setFile(f),
});

function setFile(f) {
  file = f;
  lastResult = null;
  $('#result').hidden = true;
  $('#btnPreview').hidden = true;
  $('#btnDownload').disabled = true;
  const kind = kindOf(f);
  const chip = $('#fileChip');
  chip.hidden = false;
  chip.replaceChildren(el('div', { class: 'file-chip' },
    el('div', { class: `ficon ${kind}`, text: kind === 'pdf' ? 'PDF' : kind === 'xlsx' ? 'XLS' : 'BIN' }),
    el('div', {},
      el('div', { class: 'fname', text: f.name }),
      el('div', { class: 'fmeta', text: `${fmtBytes(f.size)} · ${f.type || 'application/octet-stream'}${f.meta?.pageCount ? ` · ${fmtNum(f.meta.pageCount)} pages` : ''}${f.meta?.rowCount ? ` · ${fmtNum(f.meta.rowCount)} rows` : ''}` }),
    ),
  ));
  log.info(`Selected ${f.name} (${fmtBytes(f.size)})`);
  resetUploader();
}

/* -------------------------------------------------------------- uploader */

function resetUploader() {
  if (uploader?.isActive) uploader.abort({ deleteServerSession: false });
  uploader = new ChunkedUploader({
    file,
    backend: currentBackend(),
    chunkSize: settings.chunkSize,
    concurrency: settings.concurrency,
    maxRetries: settings.maxRetries,
    hashParts: settings.hashParts,
  });

  uploader.on('log', ({ message, level }) => log.line(message, level));
  uploader.on('state', (state) => paintState(state));
  uploader.on('progress', paintProgress);
  uploader.on('chunk', paintChunk);
  uploader.on('done', onDone);
  uploader.on('error', () => { paintState(UPLOAD_STATE.ERROR); });

  buildChunkMap(uploader.totalChunks);
  paintState(UPLOAD_STATE.IDLE);
  paintProgress({
    loaded: 0, total: file.size, pct: 0, bps: 0, etaSec: Infinity,
    doneChunks: 0, totalChunks: uploader.totalChunks, retries: 0, overhead: 0,
  });
  $('#progressLabel').textContent = `${fmtNum(uploader.totalChunks)} parts × ${fmtBytes(settings.chunkSize)}`;
  $('#btnStart').disabled = false;
}

/* --------------------------------------------------------------- painting */

let cells = [];
function buildChunkMap(count) {
  const map = $('#chunkmap');
  const shown = Math.min(count, 4000);
  cells = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < shown; i++) {
    const cell = el('i', { class: 'pending', title: `part ${i}` });
    cells.push(cell);
    frag.append(cell);
  }
  map.replaceChildren(frag);
}

function paintChunk({ index, status, sent, size }) {
  const cell = cells[index];
  if (!cell) return;
  cell.className = status;
  if (status === 'active') cell.style.setProperty('--fill', `${Math.round((sent / size) * 100)}%`);
  else cell.style.removeProperty('--fill');
}

let rafPending = false;
let lastProgress = null;
function paintProgress(p) {
  lastProgress = p;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const q = lastProgress;
    $('#progressBar').style.width = `${q.pct.toFixed(2)}%`;
    $('#progressPct').textContent = `${q.pct.toFixed(1)}%`;
    $('#statBytes').textContent = `${fmtBytes(q.loaded)} / ${fmtBytes(q.total)}`;
    $('#statSpeed').textContent = q.bps > 0 ? `${fmtBytes(q.bps)}/s` : '–';
    $('#statEta').textContent = q.bps > 0 && q.pct < 100 ? fmtDuration(q.etaSec) : '–';
    $('#statParts').textContent = `${fmtNum(q.doneChunks)} / ${fmtNum(q.totalChunks)}`;
    $('#statRetries').textContent = fmtNum(q.retries);
    $('#statWire').textContent = fmtBytes(q.overhead);
  });
}

const STATE_CLASS = {
  [UPLOAD_STATE.DONE]: 'ok',
  [UPLOAD_STATE.ERROR]: 'err',
  [UPLOAD_STATE.ABORTED]: 'err',
  [UPLOAD_STATE.PAUSED]: 'warn',
};

function paintState(state) {
  const badge = $('#stateBadge');
  badge.textContent = state;
  badge.className = `badge ${STATE_CLASS[state] || (state === UPLOAD_STATE.UPLOADING ? 'accent' : '')}`;

  const outer = $('#progressOuter');
  outer.classList.toggle('busy', state === UPLOAD_STATE.UPLOADING || state === UPLOAD_STATE.COMPLETING);
  outer.classList.toggle('ok', state === UPLOAD_STATE.DONE);
  outer.classList.toggle('err', state === UPLOAD_STATE.ERROR || state === UPLOAD_STATE.ABORTED);

  const running = state === UPLOAD_STATE.UPLOADING || state === UPLOAD_STATE.COMPLETING || state === UPLOAD_STATE.PREPARING;
  const paused = state === UPLOAD_STATE.PAUSED || state === UPLOAD_STATE.ERROR;
  $('#btnStart').textContent = state === UPLOAD_STATE.DONE ? 'Upload again' : 'Start upload';
  $('#btnStart').disabled = running || paused || !file;
  $('#btnPause').disabled = !running;
  $('#btnPause').hidden = paused;
  $('#btnResume').hidden = !paused;
  $('#btnResume').disabled = !paused;
  $('#btnCancel').disabled = !(running || paused);
  if (state === UPLOAD_STATE.PAUSED) $('#progressLabel').textContent = 'Paused';
  if (state === UPLOAD_STATE.UPLOADING) $('#progressLabel').textContent = `Uploading ${file.name}`;
  if (state === UPLOAD_STATE.COMPLETING) $('#progressLabel').textContent = 'Finalising — server is stitching the parts';
  if (state === UPLOAD_STATE.DONE) $('#progressLabel').textContent = `Stored ${file.name}`;
  if (state === UPLOAD_STATE.ABORTED) $('#progressLabel').textContent = 'Cancelled';
}

async function onDone(result) {
  lastResult = result;
  const box = $('#result');
  box.hidden = false;
  const verified = result.manifestMatches !== false;
  box.replaceChildren(el('div', { class: `alert ${verified ? 'ok' : 'err'}` },
    verified
      ? `Stored ${fmtBytes(result.size ?? file.size)} in ${result.parts ?? uploader.totalChunks} parts in ${result.elapsed.toFixed(1)}s. `
        + `Integrity check passed — the manifest hash the server computed from the parts it stored matches the one the client computed before sending.`
      : 'The server stitched the file but its manifest hash does not match the client’s. The stored file is not byte-identical.',
  ));
  if (result.clientManifest) {
    box.append(el('p', { class: 'hint' }, el('code', { class: 'inline', text: result.clientManifest })));
  }
  $('#btnDownload').disabled = !result.blob && settings.backend !== 'rest';
  $('#btnPreview').hidden = false;
  $('#btnPreview').onclick = async (e) => {
    e.preventDefault();
    const blob = result.blob || await uploader.backend.download(uploader.uploadId);
    const id = await stashFile({ name: file.name, type: file.type, size: blob.size, blob, source: 'chunked upload' });
    location.href = `preview.html?stash=${encodeURIComponent(id)}`;
  };
  refreshSessions();
}

/* ---------------------------------------------------------------- buttons */

$('#btnStart').addEventListener('click', () => {
  log.clear();
  // A finished upload gets a fresh session, otherwise the server would just say
  // "I already have every part" and finish instantly.
  if (uploader.state === UPLOAD_STATE.DONE) resetUploader();
  uploader.start();
});
$('#btnPause').addEventListener('click', () => uploader.pause());
$('#btnResume').addEventListener('click', () => uploader.resume());
$('#btnCancel').addEventListener('click', async () => {
  await uploader.abort();
  log.warn('Upload cancelled — server session deleted');
  buildChunkMap(uploader.totalChunks);
  refreshSessions();
});
$('#btnClearLog').addEventListener('click', () => log.clear());

$('#btnDownload').addEventListener('click', async () => {
  const blob = lastResult?.blob || await uploader.backend.download(uploader.uploadId);
  downloadBlob(blob, `stored-${file.name}`);
});

$('#btnPurge').addEventListener('click', async () => {
  const n = await sim.purge();
  log.warn(`Purged ${n} stored session(s)`);
  refreshSessions();
});

/* ------------------------------------------------------------- generators */

async function generate(kind) {
  if (busyGenerating) return;
  busyGenerating = true;
  const targetBytes = Number($('#genSize').value) * MB;
  const box = $('#genProgress');
  box.hidden = false;
  $('#genLabel').textContent = `Generating a ${$('#genSize').value} MB ${kind === 'pdf' ? 'PDF' : 'workbook'}…`;
  $('#genBar').style.width = '0%';
  $('#genPdf').disabled = $('#genXlsx').disabled = true;
  const t0 = performance.now();

  const onProgress = ({ pct, detail }) => {
    $('#genBar').style.width = `${pct.toFixed(1)}%`;
    $('#genPct').textContent = `${pct.toFixed(0)}%`;
    $('#genLabel').textContent = detail;
  };

  try {
    const generated = kind === 'pdf'
      ? await generatePdfFile({ targetBytes, onProgress })
      // Stored (not deflated): a compressed sheet of repetitive rows would need millions
      // of rows to weigh 50 MB, which is a different demo — that one is demo 2.
      : await generateXlsxFile({ targetBytes, compress: false, onProgress });
    log.ok(`Generated ${generated.name} — ${fmtBytes(generated.size)} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    setFile(generated);
  } catch (err) {
    log.err(`Generation failed: ${err.message}`);
  } finally {
    busyGenerating = false;
    $('#genPdf').disabled = $('#genXlsx').disabled = false;
    setTimeout(() => { box.hidden = true; }, 600);
  }
}

$('#genPdf').addEventListener('click', () => generate('pdf'));
$('#genXlsx').addEventListener('click', () => generate('xlsx'));

$('#btnSample').addEventListener('click', async () => {
  const btn = $('#btnSample');
  btn.disabled = true;
  try {
    const res = await fetch('samples/synthetic-ledger-2mb.pdf');
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const blob = await res.blob();
    setFile(new File([blob], 'synthetic-ledger-2mb.pdf', { type: 'application/pdf' }));
  } catch (err) {
    log.err(`Could not load the sample: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

/* -------------------------------------------------------- stored sessions */

async function refreshSessions() {
  const list = $('#sessionList');
  const sessions = await sim.listSessions();
  if (!sessions.length) {
    list.replaceChildren(el('p', { class: 'hint', text: 'Nothing stored.' }));
    return;
  }
  list.replaceChildren(...sessions.slice(0, 5).map((s) => el('div', { class: 'file-chip', style: 'margin-bottom:8px' },
    el('div', { class: `ficon ${kindOf({ name: s.meta.fileName, type: s.meta.fileType })}`, text: s.completed ? '✓' : '…' }),
    el('div', {},
      el('div', { class: 'fname', style: 'font-size:13px', text: s.meta.fileName }),
      el('div', { class: 'fmeta', text: `${s.received.length}/${s.meta.totalChunks} parts · ${fmtBytes(s.meta.fileSize)}${s.completed ? ' · complete' : ' · resumable'}` }),
    ),
  )));
}

refreshSessions();
log.info('Ready. Generate a file or drop one in, then press Start upload.');
