// Chunked upload client.
//
// Slices a File with Blob.slice (no bytes are read into memory until a part is actually
// sent), hashes each part, pushes N parts in parallel, retries the retryable failures
// with exponential backoff, and can pause, resume, survive a page reload and abort.
// The backend is injected — SimulatedBackend or RestBackend — so the same logic runs
// against the fake network and a real server.

import { SpeedMeter, sha256Hex, manifestHash, sleep, abortError } from './util.js';

export const MB = 1024 * 1024;

const STATE = /** @type {const} */ ({
  IDLE: 'idle',
  PREPARING: 'preparing',
  UPLOADING: 'uploading',
  PAUSED: 'paused',
  COMPLETING: 'completing',
  DONE: 'done',
  ERROR: 'error',
  ABORTED: 'aborted',
});

export class ChunkedUploader {
  /**
   * @param {object} cfg
   * @param {File|Blob} cfg.file
   * @param {object} cfg.backend         object implementing the upload API
   * @param {number} cfg.chunkSize       bytes per part
   * @param {number} cfg.concurrency     parts in flight at once
   * @param {number} cfg.maxRetries      attempts per part before giving up
   * @param {boolean} cfg.hashParts      compute a SHA-256 per part (integrity check)
   */
  constructor({ file, backend, chunkSize = 4 * MB, concurrency = 3, maxRetries = 4, hashParts = true, name }) {
    this.file = file;
    this.backend = backend;
    this.chunkSize = chunkSize;
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;
    this.hashParts = hashParts;
    this.name = name || file.name || 'upload.bin';

    this.totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
    this.sent = new Float64Array(this.totalChunks);
    this.status = new Array(this.totalChunks).fill('pending');
    this.digests = new Array(this.totalChunks).fill(null);
    this.attempts = new Array(this.totalChunks).fill(0);

    this.state = STATE.IDLE;
    this.uploadId = null;
    this.retryCount = 0;
    this.bytesOverWire = 0;   // includes bytes thrown away by failed attempts
    this.startedAt = 0;
    this.meter = new SpeedMeter(4000);
    this.#listeners = new Map();
  }

  #listeners;
  #queue = [];
  #controller = null;
  #stopping = false;
  #running = null;

  /* -------------------------------------------------- tiny event emitter */

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return this;
  }
  #emit(event, payload) {
    for (const fn of this.#listeners.get(event) || []) fn(payload);
  }
  #log(message, level = 'info') { this.#emit('log', { message, level }); }
  #setState(state) {
    this.state = state;
    this.#emit('state', state);
  }

  /* ------------------------------------------------------------- getters */

  get loaded() {
    let total = 0;
    for (let i = 0; i < this.sent.length; i++) total += this.sent[i];
    return total;
  }
  get doneChunks() { return this.status.reduce((n, s) => n + (s === 'done' ? 1 : 0), 0); }
  get isActive() { return this.state === STATE.UPLOADING || this.state === STATE.COMPLETING || this.state === STATE.PREPARING; }

  chunkRange(index) {
    const start = index * this.chunkSize;
    return [start, Math.min(start + this.chunkSize, this.file.size)];
  }

  /** Identifies this exact file + chunking, so an interrupted upload can be found again. */
  get fingerprint() {
    const lm = this.file.lastModified || 0;
    return `${this.name}|${this.file.size}|${lm}|${this.chunkSize}`;
  }

  #emitProgress(extra = {}) {
    const loaded = this.loaded;
    this.meter.push(loaded);
    const bps = this.meter.bytesPerSecond();
    const remaining = Math.max(0, this.file.size - loaded);
    this.#emit('progress', {
      loaded,
      total: this.file.size,
      pct: this.file.size ? (loaded / this.file.size) * 100 : 0,
      bps,
      etaSec: bps > 0 ? remaining / bps : Infinity,
      doneChunks: this.doneChunks,
      totalChunks: this.totalChunks,
      retries: this.retryCount,
      overhead: this.bytesOverWire,
      ...extra,
    });
  }

  #markChunk(index, status) {
    this.status[index] = status;
    this.#emit('chunk', { index, status, sent: this.sent[index], size: this.chunkRange(index)[1] - this.chunkRange(index)[0] });
  }

  /* --------------------------------------------------------------- flow */

  async start() {
    if (this.isActive) return;
    this.#stopping = false;
    this.startedAt = this.startedAt || performance.now();
    this.#setState(STATE.PREPARING);

    try {
      if (!this.uploadId) {
        const meta = {
          fileName: this.name,
          fileSize: this.file.size,
          fileType: this.file.type || 'application/octet-stream',
          chunkSize: this.chunkSize,
          totalChunks: this.totalChunks,
          fingerprint: this.fingerprint,
        };
        this.#log(`POST /uploads  (${this.totalChunks} parts × ${(this.chunkSize / MB).toFixed(0)} MB)`, 'net');
        const session = await this.backend.createUpload(meta);
        this.uploadId = session.uploadId;
        this.#emit('session', session);
        if (session.resumed && session.received?.length) {
          for (const i of session.received) {
            if (i < this.totalChunks) {
              const [s, e] = this.chunkRange(i);
              this.sent[i] = e - s;
              this.#markChunk(i, 'done');
            }
          }
          this.#log(`Resumed ${session.uploadId} — server already holds ${session.received.length}/${this.totalChunks} parts`, 'ok');
        } else {
          this.#log(`Session ${session.uploadId} created`, 'ok');
        }
      }

      this.#queue = [];
      for (let i = 0; i < this.totalChunks; i++) {
        if (this.status[i] !== 'done') { this.#queue.push(i); this.status[i] = 'pending'; }
      }
      this.#controller = new AbortController();
      this.#setState(STATE.UPLOADING);
      this.#emitProgress();

      this.#running = Promise.all(
        Array.from({ length: Math.min(this.concurrency, this.#queue.length || 1) }, () => this.#worker()),
      );
      await this.#running;

      if (this.#stopping) return;
      if (this.doneChunks !== this.totalChunks) return; // an error already surfaced

      this.#setState(STATE.COMPLETING);
      const manifest = this.hashParts && this.digests.every(Boolean)
        ? await manifestHash(this.digests)
        : null;
      this.#log('POST /uploads/:id/complete', 'net');
      const result = await this.backend.complete({ uploadId: this.uploadId, manifestHash: manifest });
      const elapsed = (performance.now() - this.startedAt) / 1000;
      this.#setState(STATE.DONE);
      this.#emitProgress();
      this.#emit('done', { ...result, clientManifest: manifest, elapsed });
      this.#log(`Upload complete in ${elapsed.toFixed(1)}s — ${result.parts ?? this.totalChunks} parts, ${this.retryCount} retries`, 'ok');
    } catch (err) {
      if (err.name === 'AbortError') return;
      this.#setState(STATE.ERROR);
      this.#log(`Upload failed: ${err.message}`, 'err');
      this.#emit('error', err);
    }
  }

  async #worker() {
    while (!this.#stopping) {
      const index = this.#queue.shift();
      if (index === undefined) return;
      try {
        await this.#sendChunk(index);
      } catch (err) {
        if (err.name === 'AbortError') {
          // Paused or cancelled: hand the part back so a resume picks it up.
          this.sent[index] = 0;
          this.#markChunk(index, 'pending');
          this.#queue.unshift(index);
          return;
        }
        this.#markChunk(index, 'failed');
        this.#stopping = true;
        throw err;
      }
    }
  }

  async #sendChunk(index) {
    const [start, end] = this.chunkRange(index);
    const size = end - start;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      this.attempts[index] = attempt;
      const blob = this.file.slice(start, end);
      try {
        if (this.hashParts && !this.digests[index]) {
          this.digests[index] = await sha256Hex(blob);
        }
        this.#markChunk(index, 'active');
        await this.backend.uploadPart({
          uploadId: this.uploadId,
          index,
          blob,
          checksum: this.digests[index],
          signal: this.#controller.signal,
          onProgress: (loaded) => {
            this.sent[index] = Math.min(loaded, size);
            this.#emit('chunk', { index, status: 'active', sent: this.sent[index], size });
            this.#emitProgress();
          },
        });
        this.sent[index] = size;
        this.bytesOverWire += size;
        this.#markChunk(index, 'done');
        this.#emitProgress();
        return;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        this.bytesOverWire += this.sent[index];
        this.sent[index] = 0;
        this.#emitProgress();
        const retryable = err.retryable !== false && attempt < this.maxRetries;
        if (!retryable) {
          this.#log(`Part ${index} failed permanently: ${err.message}`, 'err');
          throw err;
        }
        this.retryCount++;
        this.#markChunk(index, 'retry');
        const backoff = Math.min(8000, 250 * 2 ** (attempt - 1)) * (0.7 + Math.random() * 0.6);
        this.#log(`Part ${index} ${err.message} — retry ${attempt}/${this.maxRetries - 1} in ${Math.round(backoff)}ms`, 'warn');
        await sleep(backoff, this.#controller.signal);
      }
    }
  }

  pause() {
    if (this.state !== STATE.UPLOADING) return;
    this.#stopping = true;
    this.#controller?.abort();
    this.#setState(STATE.PAUSED);
    this.#log('Paused — in-flight parts dropped, completed parts kept', 'warn');
  }

  async resume() {
    if (this.state !== STATE.PAUSED && this.state !== STATE.ERROR) return;
    this.#log('Resuming', 'info');
    this.meter.reset();
    await this.start();
  }

  async abort({ deleteServerSession = true } = {}) {
    this.#stopping = true;
    this.#controller?.abort();
    this.#setState(STATE.ABORTED);
    if (deleteServerSession && this.uploadId) {
      try {
        await this.backend.abort(this.uploadId);
        this.#log(`DELETE /uploads/${this.uploadId} — server session discarded`, 'net');
      } catch { /* the session may never have existed */ }
    }
    this.uploadId = null;
    this.sent.fill(0);
    this.status.fill('pending');
    this.digests.fill(null);
    this.#emitProgress();
  }
}

export { STATE as UPLOAD_STATE };
