// Main-thread wrapper around xlsx.worker.js.

export class SheetReader {
  constructor() {
    this.worker = new Worker(new URL('./xlsx.worker.js', import.meta.url));
    this.worker.onmessage = (ev) => this.#dispatch(ev.data);
    this.worker.onerror = (e) => this.#fail(new Error(e.message || 'worker crashed'));
    this.pending = null;
    this.queue = [];
    this.onPhase = null;
  }

  #dispatch(msg) {
    if (msg.type === 'phase') { this.onPhase?.(msg); return; }
    if (msg.type === 'error') { this.#fail(new Error(msg.message)); return; }
    const p = this.pending;
    if (!p) return;
    if (msg.type === 'chunk') { p.onChunk?.(msg); return; }
    this.pending = null;
    p.resolve(msg);
    this.#pump();
  }

  #fail(err) {
    const p = this.pending;
    this.pending = null;
    p ? p.reject(err) : console.error(err);
    this.#pump();
  }

  // One worker, one request at a time: scrolling the preview grid fires range requests
  // faster than they complete, so they queue instead of racing.
  #pump() {
    if (this.pending || !this.queue.length) return;
    const job = this.queue.shift();
    this.pending = job;
    this.worker.postMessage(job.msg, job.transfer);
  }

  #send(msg, { transfer = [], onChunk } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ msg, transfer, onChunk, resolve, reject });
      this.#pump();
    });
  }

  /** Parse a workbook. Accepts a Blob/File or an ArrayBuffer (which is transferred). */
  async load(source) {
    const buffer = source instanceof Blob ? await source.arrayBuffer() : source;
    return this.#send({ type: 'load', buffer }, { transfer: [buffer] });
  }

  /** Stream every row of a sheet back in chunks. */
  stream({ sheet, mode = 'value', chunkSize = 5000, maxRows = 0, onChunk }) {
    return this.#send({ type: 'stream', sheet, mode, chunkSize, maxRows }, { onChunk });
  }

  /** Fetch one window of rows — what the virtualised preview grid uses while scrolling. */
  range({ sheet, mode = 'display', from, count }) {
    return this.#send({ type: 'range', sheet, mode, from, count });
  }

  /** Scan a sheet for a substring, starting at `from`. Returns { row, col } or row -1. */
  find({ sheet, query, from = 0 }) {
    return this.#send({ type: 'find', sheet, query, from });
  }

  terminate() { this.worker.terminate(); }
}
