// Batched row importer — the client half of demo 2.
//
// Takes the parsed sheet, walks it in batches of N rows, posts several batches in
// parallel, retries failures with backoff, and reports progress per batch (that is the
// point of the demo: the bar moves once per 100 / 500 / 1000 rows, not once per file).

import { sleep } from './util.js';

export const IMPORT_STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  DONE: 'done',
  ERROR: 'error',
  ABORTED: 'aborted',
};

export class BatchImporter {
  /**
   * @param {object} cfg
   * @param {any[][]} cfg.rows      data rows (no header), each an array of cell values
   * @param {string[]} cfg.keys     field name per column, aligned with `rows`
   * @param {object} cfg.backend    row-ingest API
   * @param {number} cfg.batchSize  rows per request
   * @param {number} cfg.concurrency batches in flight
   * @param {number} cfg.maxRetries attempts per batch
   * @param {boolean} cfg.stopOnError give up instead of skipping a batch that keeps failing
   * @param {number} cfg.firstRowNumber sheet row number of rows[0] (for error reports)
   */
  constructor({ rows, keys, backend, batchSize = 500, concurrency = 2, maxRetries = 4, stopOnError = false, firstRowNumber = 2, meta = {} }) {
    this.rows = rows;
    this.keys = keys;
    this.backend = backend;
    this.batchSize = batchSize;
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;
    this.stopOnError = stopOnError;
    this.firstRowNumber = firstRowNumber;
    this.meta = meta;

    this.totalBatches = Math.max(1, Math.ceil(rows.length / batchSize));
    this.batchStatus = new Array(this.totalBatches).fill('pending');
    this.inFlight = new Map();      // batchIndex -> rows acknowledged so far
    this.sentRows = 0;              // rows the API has committed
    this.accepted = 0;
    this.rejected = 0;
    this.rejections = [];           // { rowNumber, problems, data }
    this.retryCount = 0;
    this.failedBatches = [];
    this.state = IMPORT_STATE.IDLE;
    this.importId = null;
    this.startedAt = 0;

    this.#listeners = new Map();
  }

  #listeners;
  #queue = [];
  #controller = null;
  #stopping = false;

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return this;
  }
  #emit(event, payload) { for (const fn of this.#listeners.get(event) || []) fn(payload); }
  #log(message, level = 'info') { this.#emit('log', { message, level }); }
  #setState(state) { this.state = state; this.#emit('state', state); }

  batchRange(index) {
    const start = index * this.batchSize;
    return [start, Math.min(start + this.batchSize, this.rows.length)];
  }

  get elapsed() { return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0; }

  #progress() {
    let partial = 0;
    for (const n of this.inFlight.values()) partial += n;
    const processed = this.sentRows + partial;
    const rate = this.elapsed > 0 ? this.sentRows / this.elapsed : 0;
    this.#emit('progress', {
      processed,
      total: this.rows.length,
      pct: this.rows.length ? (processed / this.rows.length) * 100 : 0,
      accepted: this.accepted,
      rejected: this.rejected,
      rate,
      etaSec: rate > 0 ? (this.rows.length - processed) / rate : Infinity,
      doneBatches: this.batchStatus.filter((s) => s === 'done').length,
      totalBatches: this.totalBatches,
      retries: this.retryCount,
      elapsed: this.elapsed,
    });
  }

  #markBatch(index, status, extra = {}) {
    this.batchStatus[index] = status;
    this.#emit('batch', { index, status, ...extra });
  }

  async start() {
    if (this.state === IMPORT_STATE.RUNNING) return;
    this.#stopping = false;
    this.startedAt = this.startedAt || performance.now();
    this.#controller = new AbortController();

    try {
      if (!this.importId) {
        const { importId } = await this.backend.createImport({
          rowCount: this.rows.length,
          batchSize: this.batchSize,
          ...this.meta,
        });
        this.importId = importId;
        this.#log(`POST /imports → ${importId} (${this.totalBatches.toLocaleString()} batches × ${this.batchSize} rows)`, 'net');
      }

      this.#queue = [];
      for (let i = 0; i < this.totalBatches; i++) {
        if (this.batchStatus[i] !== 'done' && this.batchStatus[i] !== 'failed') this.#queue.push(i);
      }
      this.#setState(IMPORT_STATE.RUNNING);
      this.#progress();

      await Promise.all(
        Array.from({ length: Math.min(this.concurrency, this.#queue.length || 1) }, () => this.#worker()),
      );
      if (this.#stopping) return;

      const summary = await this.backend.commit(this.importId);
      this.#setState(IMPORT_STATE.DONE);
      this.#progress();
      this.#emit('done', { ...summary, failedBatches: this.failedBatches.length, elapsed: this.elapsed });
      this.#log(`POST /imports/:id/commit — ${summary.inserted.toLocaleString()} inserted, ${summary.rejected.toLocaleString()} rejected`, 'ok');
    } catch (err) {
      if (err.name === 'AbortError') return;
      this.#setState(IMPORT_STATE.ERROR);
      this.#log(`Import stopped: ${err.message}`, 'err');
      this.#emit('error', err);
    }
  }

  async #worker() {
    while (!this.#stopping) {
      const index = this.#queue.shift();
      if (index === undefined) return;
      try {
        await this.#sendBatch(index);
      } catch (err) {
        this.inFlight.delete(index);
        if (err.name === 'AbortError') {
          this.#markBatch(index, 'pending');
          this.#queue.unshift(index);
          return;
        }
        this.#markBatch(index, 'failed');
        this.failedBatches.push(index);
        if (this.stopOnError) {
          this.#stopping = true;
          throw err;
        }
        const [start, end] = this.batchRange(index);
        this.#log(`Batch ${index} abandoned after ${this.maxRetries} attempts — rows ${start + this.firstRowNumber}–${end + this.firstRowNumber - 1} not imported`, 'err');
      }
    }
  }

  #buildBatch(index) {
    const [start, end] = this.batchRange(index);
    const out = new Array(end - start);
    for (let r = start; r < end; r++) {
      const src = this.rows[r];
      const data = {};
      for (let c = 0; c < this.keys.length; c++) {
        if (this.keys[c]) data[this.keys[c]] = src[c];
      }
      out[r - start] = { rowNumber: r + this.firstRowNumber, data };
    }
    return out;
  }

  async #sendBatch(index) {
    const batch = this.#buildBatch(index);
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        this.#markBatch(index, 'active');
        this.inFlight.set(index, 0);
        const t0 = performance.now();
        const res = await this.backend.postBatch({
          importId: this.importId,
          batchIndex: index,
          rows: batch,
          signal: this.#controller.signal,
          onProgress: (n) => {
            this.inFlight.set(index, n);
            this.#emit('batch', { index, status: 'active', done: n, size: batch.length });
            this.#progress();
          },
        });
        this.inFlight.delete(index);
        this.sentRows += batch.length;
        this.accepted += res.accepted;
        this.rejected += res.rejected.length;
        if (res.rejected.length) this.rejections.push(...res.rejected);
        this.#markBatch(index, 'done', { accepted: res.accepted, rejected: res.rejected.length });
        this.#emit('rejections', res.rejected);
        this.#progress();
        this.#log(
          `POST /imports/:id/rows #${index} — ${batch.length} rows, ${res.accepted} accepted`
          + `${res.rejected.length ? `, ${res.rejected.length} rejected` : ''} (${Math.round(performance.now() - t0)}ms)`,
          res.rejected.length ? 'warn' : 'net',
        );
        return;
      } catch (err) {
        this.inFlight.delete(index);
        if (err.name === 'AbortError') throw err;
        if (err.retryable === false || attempt >= this.maxRetries) throw err;
        this.retryCount++;
        this.#markBatch(index, 'retry');
        const backoff = Math.min(6000, 200 * 2 ** (attempt - 1)) * (0.7 + Math.random() * 0.6);
        this.#log(`Batch ${index} ${err.message} — retry ${attempt}/${this.maxRetries - 1} in ${Math.round(backoff)}ms`, 'warn');
        this.#progress();
        await sleep(backoff, this.#controller.signal);
      }
    }
  }

  pause() {
    if (this.state !== IMPORT_STATE.RUNNING) return;
    this.#stopping = true;
    this.#controller?.abort();
    this.inFlight.clear();
    this.#setState(IMPORT_STATE.PAUSED);
    this.#log('Paused — batches in flight were dropped and will be resent', 'warn');
  }

  async resume() {
    if (this.state !== IMPORT_STATE.PAUSED) return;
    this.#log('Resuming', 'info');
    await this.start();
  }

  abort() {
    this.#stopping = true;
    this.#controller?.abort();
    this.inFlight.clear();
    this.#setState(IMPORT_STATE.ABORTED);
    this.#log('Import cancelled', 'warn');
  }

  /** CSV of every rejected row, ready to hand back to whoever supplied the file. */
  errorReportCsv() {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['sheet_row,order_ref,problems'];
    for (const r of this.rejections) {
      lines.push([r.rowNumber, esc(r.data?.order_ref ?? ''), esc(r.problems.join('; '))].join(','));
    }
    return lines.join('\n');
  }
}
