// The same interface as SimulatedBackend, but talking to a real HTTP API.
//
// Point it at the tiny Node service in `server/` (`npm start` there, then paste the URL
// into the demo page) to watch the identical client code drive a real upload:
//
//   POST   {base}/uploads                      -> { uploadId, received }
//   GET    {base}/uploads/:id                  -> { received, completed }
//   PUT    {base}/uploads/:id/parts/:index     (body: raw chunk, header X-Chunk-SHA256)
//   POST   {base}/uploads/:id/complete         -> { size, manifestHash }
//   DELETE {base}/uploads/:id
//
// Part uploads go through XMLHttpRequest rather than fetch, because fetch still cannot
// report *upload* progress in any shipping browser — xhr.upload.onprogress can.

import { HttpError } from './backend-simulated.js';

export class RestBackend {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.label = `REST (${this.baseUrl})`;
  }

  configure() { /* nothing to tune — the network is the network */ }

  async #json(path, { method = 'GET', body, signal } = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => res.statusText));
    return res.status === 204 ? null : res.json();
  }

  async createUpload(meta, { signal } = {}) {
    const out = await this.#json('/uploads', { method: 'POST', body: meta, signal });
    return { uploadId: out.uploadId, received: out.received || [], resumed: !!out.resumed, meta };
  }

  getUpload(uploadId, { signal } = {}) {
    return this.#json(`/uploads/${encodeURIComponent(uploadId)}`, { signal });
  }

  uploadPart({ uploadId, index, blob, checksum, onProgress, signal }) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${this.baseUrl}/uploads/${encodeURIComponent(uploadId)}/parts/${index}`);
      xhr.responseType = 'json';
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      if (checksum) xhr.setRequestHeader('x-chunk-sha256', checksum);
      xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response || { index });
        else reject(new HttpError(xhr.status, xhr.statusText || 'part upload failed'));
      };
      xhr.onerror = () => reject(new HttpError(0, 'network error'));
      xhr.ontimeout = () => reject(new HttpError(0, 'timeout'));
      const onAbort = () => xhr.abort();
      xhr.onabort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      signal?.addEventListener('abort', onAbort, { once: true });
      xhr.send(blob);
    });
  }

  async complete({ uploadId, manifestHash, signal }) {
    const out = await this.#json(`/uploads/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST',
      body: { manifestHash },
      signal,
    });
    return { ok: true, uploadId, blob: null, ...out };
  }

  abort(uploadId) {
    return this.#json(`/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' });
  }

  async download(uploadId) {
    const res = await fetch(`${this.baseUrl}/uploads/${encodeURIComponent(uploadId)}/file`);
    if (!res.ok) throw new HttpError(res.status, res.statusText);
    return res.blob();
  }

  async ping() {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new HttpError(res.status, res.statusText);
    return res.json();
  }
}
