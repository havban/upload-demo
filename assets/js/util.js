// Small shared helpers. Plain ES module, no dependencies.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) {
    if (signal.aborted) { clearTimeout(t); reject(abortError()); return; }
    signal.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
  }
});

export function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

export function fmtBytes(bytes, digits = 1) {
  if (!Number.isFinite(bytes)) return '–';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
}

export function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}

export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  if (seconds < 1) return '<1s';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}m ${String(rest).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function fmtTime(d = new Date()) {
  return d.toTimeString().slice(0, 8);
}

export function pct(part, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

export function toHex(buffer) {
  const view = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
  return out;
}

/** SHA-256 of an ArrayBuffer / TypedArray / Blob, as lowercase hex. */
export async function sha256Hex(data) {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return toHex(digest);
}

/**
 * Manifest hash: SHA-256 over the concatenated per-chunk digests, in order.
 * crypto.subtle has no streaming API, so this is how you fingerprint a file
 * that you never hold in memory all at once — the same trick S3 multipart uses.
 */
export async function manifestHash(chunkHexDigests) {
  const bytes = new Uint8Array(chunkHexDigests.length * 32);
  chunkHexDigests.forEach((hex, i) => {
    for (let b = 0; b < 32; b++) bytes[i * 32 + b] = parseInt(hex.substr(b * 2, 2), 16);
  });
  return `${await sha256Hex(bytes.buffer)}-${chunkHexDigests.length}`;
}

/** Exponentially weighted throughput meter (bytes/second). */
export class SpeedMeter {
  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
    this.samples = [];
  }
  push(totalBytes, now = performance.now()) {
    this.samples.push([now, totalBytes]);
    while (this.samples.length > 2 && now - this.samples[0][0] > this.windowMs) this.samples.shift();
  }
  bytesPerSecond() {
    if (this.samples.length < 2) return 0;
    const [t0, b0] = this.samples[0];
    const [t1, b1] = this.samples[this.samples.length - 1];
    const dt = (t1 - t0) / 1000;
    if (dt <= 0) return 0;
    return Math.max(0, (b1 - b0) / dt);
  }
  reset() { this.samples = []; }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function extOf(name = '') {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

export function kindOf(file) {
  const ext = extOf(file.name || '');
  if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf';
  if (['xlsx', 'xlsm', 'xls', 'csv'].includes(ext)) return 'xlsx';
  return 'other';
}

/** Rolling log panel. */
export class Logger {
  constructor(node, limit = 400) {
    this.node = node;
    this.limit = limit;
  }
  line(msg, level = 'info') {
    if (!this.node) return;
    const atBottom = this.node.scrollTop + this.node.clientHeight >= this.node.scrollHeight - 30;
    const row = el('div', { class: `l-${level}` },
      el('span', { class: 't', text: `${fmtTime()}  ` }), msg);
    this.node.append(row);
    while (this.node.childElementCount > this.limit) this.node.firstElementChild.remove();
    if (atBottom) this.node.scrollTop = this.node.scrollHeight;
  }
  info(m) { this.line(m, 'info'); }
  ok(m) { this.line(m, 'ok'); }
  warn(m) { this.line(m, 'warn'); }
  err(m) { this.line(m, 'err'); }
  net(m) { this.line(m, 'net'); }
  clear() { if (this.node) this.node.textContent = ''; }
}

/** Wire a drop target + hidden file input to one callback. */
export function wireFilePicker({ zone, input, onFile, accept }) {
  const pick = () => input.click();
  zone.addEventListener('click', (e) => { if (!e.target.closest('button,a,label')) pick(); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) onFile(f);
    input.value = '';
  });
  if (accept) input.accept = accept;
  return { pick };
}

/** Yield to the event loop so progress paints during long synchronous work. */
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
