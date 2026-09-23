// An in-browser stand-in for a chunked-upload API.
//
// GitHub Pages serves static files only, so there is no server to POST to. This class
// implements exactly the interface a real one would expose — create / head / put part /
// complete / abort — and fakes the network in between: bandwidth, latency, jitter and
// a configurable failure rate, so retries and resumes are real code paths, not mock-ups.
//
// Received parts are written to IndexedDB, which is what makes "reload the page and
// resume" work: the ledger of which chunks arrived survives the reload, just like it
// would on a server.

import { sleep, sha256Hex, abortError } from './util.js';
import { STORES, idbGet, idbPut, idbDel, idbAll, idbDeletePrefix, idbGetPrefix, idbKeysPrefix, partKey } from './idb.js';

export class HttpError extends Error {
  constructor(status, message, { retryable = status >= 500 || status === 429 } = {}) {
    super(`${status} ${message}`);
    this.name = 'HttpError';
    this.status = status;
    this.retryable = retryable;
  }
}

const rand = (min, max) => min + Math.random() * (max - min);

export class SimulatedBackend {
  /**
   * @param {object} opts
   * @param {number} opts.bandwidthMbps  simulated link speed, megabits/second
   * @param {number} opts.latencyMs      per-request round trip before bytes flow
   * @param {number} opts.failureRate    0..1 chance a part request dies mid-flight
   * @param {number} opts.jitter         0..1 random spread applied to latency
   * @param {boolean} opts.verifyChecksums server-side SHA-256 check of every part
   */
  constructor(opts = {}) {
    this.label = 'Simulated (in-browser)';
    this.options = {
      bandwidthMbps: 80,
      latencyMs: 60,
      failureRate: 0.05,
      jitter: 0.4,
      verifyChecksums: true,
      ...opts,
    };
    /** Number of parts currently in flight — the simulated link is shared between them. */
    this.active = 0;
  }

  configure(patch) { Object.assign(this.options, patch); }

  get bytesPerSecond() { return (this.options.bandwidthMbps * 1_000_000) / 8; }

  async #roundTrip(signal) {
    const { latencyMs, jitter } = this.options;
    await sleep(rand(latencyMs * (1 - jitter), latencyMs * (1 + jitter)), signal);
  }

  /**
   * Move `bytes` over the fake wire, reporting cumulative progress as it goes.
   * The link is shared: with three parts in flight each gets a third of the bandwidth,
   * so raising the parallelism hides latency but never beats the pipe — same as reality.
   */
  async #transfer(bytes, onProgress, signal) {
    this.active++;
    try {
      const nominalMs = (bytes / this.bytesPerSecond) * 1000;
      const steps = Math.min(60, Math.max(4, Math.ceil(nominalMs / 40)));
      const dieAt = Math.random() < this.options.failureRate ? Math.floor(rand(1, steps)) : -1;
      for (let i = 1; i <= steps; i++) {
        await sleep((nominalMs / steps) * Math.max(1, this.active), signal);
        onProgress?.(Math.round((bytes * i) / steps));
        if (i === dieAt) {
          const status = Math.random() < 0.5 ? 503 : 500;
          throw new HttpError(status, status === 503 ? 'Service Unavailable (simulated)' : 'Internal Server Error (simulated)');
        }
      }
    } finally {
      this.active--;
    }
  }

  /**
   * Which parts does the store already hold?
   *
   * Derived from the part keys rather than kept as a field on the session, because
   * parts arrive concurrently: a read-modify-write of one shared record loses updates,
   * and the upload then fails at completion with "missing parts". The real server in
   * server/ has the same constraint and solves it the same way.
   */
  async #received(uploadId) {
    const keys = await idbKeysPrefix(STORES.parts, `${uploadId}#`);
    return keys.map((k) => Number(String(k).split('#')[1])).sort((a, b) => a - b);
  }

  /** POST /uploads — start a session, or hand back the one matching this fingerprint. */
  async createUpload(meta, { signal } = {}) {
    await this.#roundTrip(signal);
    const sessions = await idbAll(STORES.sessions);
    const existing = sessions.find((s) => s.fingerprint === meta.fingerprint && !s.completed);
    if (existing) {
      return {
        uploadId: existing.uploadId,
        received: await this.#received(existing.uploadId),
        resumed: true,
        meta: existing.meta,
      };
    }
    // Keep at most two finished uploads around; 50 MB files add up fast in IndexedDB.
    const finished = sessions.filter((s) => s.completed).sort((a, b) => b.createdAt - a.createdAt);
    for (const old of finished.slice(2)) await this.abort(old.uploadId);

    const uploadId = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const session = {
      uploadId,
      fingerprint: meta.fingerprint,
      meta,
      createdAt: Date.now(),
      completed: false,
    };
    await idbPut(STORES.sessions, uploadId, session);
    return { uploadId, received: [], resumed: false, meta };
  }

  /** GET /uploads/:id — which parts does the server already hold? */
  async getUpload(uploadId, { signal } = {}) {
    await this.#roundTrip(signal);
    const session = await idbGet(STORES.sessions, uploadId);
    if (!session) throw new HttpError(404, 'Unknown upload session', { retryable: false });
    return { uploadId, received: await this.#received(uploadId), meta: session.meta, completed: session.completed };
  }

  /** PUT /uploads/:id/parts/:index */
  async uploadPart({ uploadId, index, blob, checksum, onProgress, signal }) {
    if (signal?.aborted) throw abortError();
    const session = await idbGet(STORES.sessions, uploadId);
    if (!session) throw new HttpError(404, 'Unknown upload session', { retryable: false });

    await this.#roundTrip(signal);
    await this.#transfer(blob.size, onProgress, signal);

    if (this.options.verifyChecksums && checksum) {
      const actual = await sha256Hex(blob);
      if (actual !== checksum) {
        // A real API answers 422 here: the bytes arrived but they are not the bytes
        // the client said it was sending. The client's response is to resend the part.
        throw new HttpError(422, 'Checksum mismatch for part', { retryable: true });
      }
    }

    // The digest travels with the part, so no two concurrent requests ever write the
    // same record.
    await idbPut(STORES.parts, partKey(uploadId, index), { blob, checksum, size: blob.size });
    const received = await this.#received(uploadId);
    return { index, size: blob.size, received: received.length };
  }

  /** POST /uploads/:id/complete — stitch the parts and verify the whole file. */
  async complete({ uploadId, manifestHash, signal }) {
    await this.#roundTrip(signal);
    const session = await idbGet(STORES.sessions, uploadId);
    if (!session) throw new HttpError(404, 'Unknown upload session', { retryable: false });
    const expected = session.meta.totalChunks;
    const parts = await idbGetPrefix(STORES.parts, `${uploadId}#`); // key order == chunk order
    if (parts.length !== expected) {
      throw new HttpError(409, `Missing parts: have ${parts.length} of ${expected}`, { retryable: false });
    }
    const file = new Blob(parts.map((p) => p.blob), { type: session.meta.fileType || 'application/octet-stream' });
    if (file.size !== session.meta.fileSize) {
      throw new HttpError(409, `Assembled size ${file.size} ≠ declared ${session.meta.fileSize}`, { retryable: false });
    }
    const serverManifest = await this.#manifestOf(parts);
    session.completed = true;
    session.completedAt = Date.now();
    await idbPut(STORES.sessions, uploadId, session);
    return {
      ok: true,
      uploadId,
      size: file.size,
      parts: parts.length,
      manifestHash: serverManifest,
      manifestMatches: !manifestHash || manifestHash === serverManifest,
      blob: file, // a real API would return a URL; here the file never left the tab
    };
  }

  async #manifestOf(parts) {
    const digests = parts.map((p) => p.checksum).filter(Boolean);
    if (digests.length !== parts.length) return null;
    const { manifestHash } = await import('./util.js');
    return manifestHash(digests);
  }

  /** DELETE /uploads/:id */
  async abort(uploadId) {
    await idbDeletePrefix(STORES.parts, `${uploadId}#`);
    await idbDel(STORES.sessions, uploadId);
  }

  /** Demo-only: hand back the reassembled file so the page can preview or download it. */
  async download(uploadId) {
    const session = await idbGet(STORES.sessions, uploadId);
    if (!session) throw new HttpError(404, 'Unknown upload session', { retryable: false });
    const parts = await idbGetPrefix(STORES.parts, `${uploadId}#`);
    return new Blob(parts.map((p) => p.blob), { type: session.meta.fileType || 'application/octet-stream' });
  }

  /** Housekeeping so the demo does not slowly fill the user's disk. */
  async purge() {
    const sessions = await idbAll(STORES.sessions);
    for (const s of sessions) await this.abort(s.uploadId);
    return sessions.length;
  }

  async listSessions() {
    const all = await idbAll(STORES.sessions);
    const withCounts = await Promise.all(all.map(async (s) => ({ ...s, received: await this.#received(s.uploadId) })));
    return withCounts.sort((a, b) => b.createdAt - a.createdAt);
  }
}
