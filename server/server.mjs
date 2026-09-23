#!/usr/bin/env node
/**
 * The real version of the upload API that the browser demo fakes.
 *
 * Zero dependencies, Node 18+. It serves the static site *and* the five upload routes,
 * so you can drive demo 1 against a genuine server:
 *
 *     node server/server.mjs                # http://localhost:8787
 *     open http://localhost:8787/chunked-upload.html
 *     # then: Backend -> "Real server (REST)", base URL http://localhost:8787
 *
 * Routes
 *   GET    /health
 *   POST   /uploads                     { fileName, fileSize, chunkSize, totalChunks, fingerprint }
 *   GET    /uploads/:id                 -> { received: [...] }   (resume support)
 *   PUT    /uploads/:id/parts/:index    raw body, header: x-chunk-sha256
 *   POST   /uploads/:id/complete        { manifestHash } -> stitches and verifies
 *   DELETE /uploads/:id
 *   GET    /uploads/:id/file            the stitched result
 *
 * Parts land in server/.uploads/<uploadId>/. Nothing is ever sent anywhere else.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { dirname, join, normalize, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const storeDir = join(here, '.uploads');
const port = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,x-chunk-sha256',
  'access-control-max-age': '86400',
};

const send = (res, status, body, headers = {}) => {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain',
    ...CORS,
    ...headers,
  });
  res.end(payload);
};

const readJson = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const sessionDir = (id) => join(storeDir, id.replace(/[^\w.-]/g, '_'));
const metaPath = (id) => join(sessionDir(id), 'meta.json');
const loadMeta = async (id) => JSON.parse(await readFile(metaPath(id), 'utf8'));
const saveMeta = (id, meta) => writeFile(metaPath(id), JSON.stringify(meta, null, 2));

async function receivedParts(id) {
  const names = await readdir(sessionDir(id)).catch(() => []);
  return names
    .filter((n) => n.endsWith('.part'))
    .map((n) => Number(n.slice(0, -5)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

async function findByFingerprint(fingerprint) {
  const ids = await readdir(storeDir).catch(() => []);
  for (const id of ids) {
    const meta = await loadMeta(id).catch(() => null);
    if (meta && meta.fingerprint === fingerprint && !meta.completed) return { id, meta };
  }
  return null;
}

/** Same construction as the browser: SHA-256 over the concatenated part digests. */
function manifestOf(digests) {
  const h = createHash('sha256');
  for (const hex of digests) h.update(Buffer.from(hex, 'hex'));
  return `${h.digest('hex')}-${digests.length}`;
}

async function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(root, rel === '/' ? 'index.html' : rel);
  if (!filePath.startsWith(root)) return send(res, 403, 'Forbidden');
  let info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) {
    filePath = join(filePath, 'index.html');
    info = await stat(filePath).catch(() => null);
  }
  if (!info) return send(res, 404, 'Not found');
  res.writeHead(200, {
    'content-type': MIME[extname(filePath)] || 'application/octet-stream',
    'content-length': info.size,
    ...CORS,
  });
  return pipeline(createReadStream(filePath), res).catch(() => {});
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  try {
    if (method === 'OPTIONS') return send(res, 204, '');

    if (path === '/health') {
      const ids = await readdir(storeDir).catch(() => []);
      return send(res, 200, { service: 'upload-demo server', version: 1, sessions: ids.length });
    }

    if (path === '/uploads' && method === 'POST') {
      const meta = await readJson(req);
      const existing = meta.fingerprint ? await findByFingerprint(meta.fingerprint) : null;
      if (existing) {
        return send(res, 200, { uploadId: existing.id, received: await receivedParts(existing.id), resumed: true });
      }
      const uploadId = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      await mkdir(sessionDir(uploadId), { recursive: true });
      await saveMeta(uploadId, { ...meta, uploadId, createdAt: Date.now(), completed: false });
      console.log(`[${uploadId}] start ${meta.fileName} — ${meta.totalChunks} parts`);
      return send(res, 201, { uploadId, received: [], resumed: false });
    }

    const m = /^\/uploads\/([\w.-]+)(?:\/(parts\/(\d+)|complete|file))?$/.exec(path);
    if (m) {
      const [, id, tail, partIndex] = m;
      const meta = await loadMeta(id).catch(() => null);
      if (!meta) return send(res, 404, { error: 'unknown upload' });

      if (!tail && method === 'GET') {
        return send(res, 200, { uploadId: id, received: await receivedParts(id), completed: !!meta.completed, meta });
      }

      if (!tail && method === 'DELETE') {
        await rm(sessionDir(id), { recursive: true, force: true });
        console.log(`[${id}] aborted`);
        return send(res, 204, '');
      }

      if (partIndex !== undefined && method === 'PUT') {
        const index = Number(partIndex);
        const tmp = join(sessionDir(id), `${index}.tmp`);
        const hash = createHash('sha256');
        let size = 0;
        const out = createWriteStream(tmp);
        req.on('data', (c) => { hash.update(c); size += c.length; });
        await pipeline(req, out);
        const digest = hash.digest('hex');
        const claimed = req.headers['x-chunk-sha256'];
        if (claimed && claimed !== digest) {
          await rm(tmp, { force: true });
          return send(res, 422, { error: 'checksum mismatch', expected: claimed, actual: digest });
        }
        const { rename } = await import('node:fs/promises');
        await rename(tmp, join(sessionDir(id), `${index}.part`));
        // One small file per digest rather than a field in meta.json: parts arrive
        // concurrently, and read-modify-write on a shared file loses updates.
        await writeFile(join(sessionDir(id), `${index}.sha256`), digest);
        return send(res, 200, { index, size, sha256: digest });
      }

      if (tail === 'complete' && method === 'POST') {
        const body = await readJson(req);
        const parts = await receivedParts(id);
        if (parts.length !== meta.totalChunks) {
          return send(res, 409, { error: `missing parts: have ${parts.length} of ${meta.totalChunks}` });
        }
        const target = join(sessionDir(id), meta.fileName.replace(/[/\\]/g, '_'));
        const out = createWriteStream(target);
        out.setMaxListeners(meta.totalChunks + 10); // one pipeline() per part on one stream
        for (const index of parts) {
          await pipeline(createReadStream(join(sessionDir(id), `${index}.part`)), out, { end: false });
        }
        await new Promise((r) => out.end(r));
        const info = await stat(target);
        const digests = [];
        for (const index of parts) {
          digests.push(await readFile(join(sessionDir(id), `${index}.sha256`), 'utf8').catch(() => ''));
        }
        const serverManifest = manifestOf(digests.filter(Boolean));
        meta.completed = true;
        meta.completedAt = Date.now();
        meta.storedAs = target;
        await saveMeta(id, meta);
        for (const index of parts) {
          await rm(join(sessionDir(id), `${index}.part`), { force: true });
          await rm(join(sessionDir(id), `${index}.sha256`), { force: true });
        }
        console.log(`[${id}] complete — ${info.size} bytes, manifest ${serverManifest}`);
        return send(res, 200, {
          uploadId: id,
          size: info.size,
          parts: parts.length,
          manifestHash: serverManifest,
          manifestMatches: !body.manifestHash || body.manifestHash === serverManifest,
          url: `/uploads/${id}/file`,
        });
      }

      if (tail === 'file' && method === 'GET') {
        if (!meta.storedAs) return send(res, 409, { error: 'upload not completed' });
        const info = await stat(meta.storedAs);
        res.writeHead(200, {
          'content-type': meta.fileType || 'application/octet-stream',
          'content-length': info.size,
          'content-disposition': `inline; filename="${meta.fileName}"`,
          ...CORS,
        });
        return pipeline(createReadStream(meta.storedAs), res).catch(() => {});
      }
    }

    return serveStatic(req, res, path);
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: err.message });
  }
});

await mkdir(storeDir, { recursive: true });
server.listen(port, () => {
  console.log(`upload-demo server on http://localhost:${port}`);
  console.log(`  static site   → ${root}`);
  console.log(`  upload store  → ${storeDir}`);
});
