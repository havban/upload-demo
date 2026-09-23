// Simulated row-ingest API — the server side of demo 2.
//
// A large workbook is not really a file problem, it is a record problem: the interesting
// unit is the row, and the interesting failure is one bad row in the middle of a batch.
// This stand-in accepts batches, spends time roughly proportional to the row count,
// validates every row, and occasionally fails a whole batch so retries are visible.
//
//   POST /imports                    -> { importId }
//   POST /imports/:id/rows           -> { accepted, rejected: [{ rowNumber, problems }] }
//   POST /imports/:id/commit         -> { inserted, rejected, ms }

import { sleep } from './util.js';
import { validateRow } from './dataset.js';
import { HttpError } from './backend-simulated.js';

const rand = (min, max) => min + Math.random() * (max - min);

export class RowIngestBackend {
  constructor(opts = {}) {
    this.label = 'Simulated row API';
    this.options = {
      latencyMs: 70,       // per request round trip
      msPerRow: 0.35,      // "insert" cost per row
      failureRate: 0.04,   // chance a batch request dies
      validate: true,
      ...opts,
    };
    this.imports = new Map();
  }

  configure(patch) { Object.assign(this.options, patch); }

  async createImport(meta) {
    await sleep(this.options.latencyMs);
    const importId = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this.imports.set(importId, { importId, meta, inserted: 0, rejected: 0, startedAt: Date.now() });
    return { importId };
  }

  /**
   * @param {object} o
   * @param {string} o.importId
   * @param {number} o.batchIndex
   * @param {Array<{rowNumber:number, data:object}>} o.rows
   */
  async postBatch({ importId, batchIndex, rows, onProgress, signal }) {
    const session = this.imports.get(importId);
    if (!session) throw new HttpError(404, 'Unknown import', { retryable: false });

    const { latencyMs, msPerRow, failureRate } = this.options;
    await sleep(rand(latencyMs * 0.6, latencyMs * 1.4), signal);

    const workMs = rows.length * msPerRow;
    const steps = Math.min(20, Math.max(3, Math.ceil(workMs / 25)));
    const dieAt = Math.random() < failureRate ? Math.floor(rand(1, steps)) : -1;
    for (let i = 1; i <= steps; i++) {
      await sleep(workMs / steps, signal);
      onProgress?.(Math.round((rows.length * i) / steps));
      if (i === dieAt) throw new HttpError(503, 'Database timeout (simulated)');
    }

    const rejected = [];
    if (this.options.validate) {
      for (const { rowNumber, data } of rows) {
        const problems = validateRow(data);
        if (problems.length) rejected.push({ rowNumber, problems, data });
      }
    }
    const accepted = rows.length - rejected.length;
    session.inserted += accepted;
    session.rejected += rejected.length;
    return { batchIndex, received: rows.length, accepted, rejected };
  }

  async commit(importId) {
    await sleep(this.options.latencyMs);
    const session = this.imports.get(importId);
    if (!session) throw new HttpError(404, 'Unknown import', { retryable: false });
    session.committedAt = Date.now();
    return {
      importId,
      inserted: session.inserted,
      rejected: session.rejected,
      ms: session.committedAt - session.startedAt,
    };
  }
}
