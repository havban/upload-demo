#!/usr/bin/env node
/**
 * Runs every smoke test against a freshly started server.
 *
 *   npm test                 # all of them
 *   npm test -- 50mb         # only tests whose name contains "50mb"
 *
 * Needs Playwright (`npm i -D playwright && npx playwright install chromium`).
 */

import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = process.env.PORT || 8788;
const base = `http://localhost:${PORT}`;
const filter = process.argv[2] || '';

const server = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
  env: { ...process.env, PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`  [server] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

// If the runner is interrupted, take the server with it — a survivor holds the port
// and every later run fails with EADDRINUSE.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.kill(); process.exit(1); });
}

const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
};

const run = (file) => new Promise((resolveRun) => {
  const child = spawn(process.execPath, [join(here, file)], {
    env: { ...process.env, BASE: base },
    stdio: 'inherit',
    cwd: root,
  });
  child.on('exit', (code) => resolveRun(code === 0));
});

try {
  await waitForServer();
  const files = (await readdir(here))
    .filter((f) => f.startsWith('smoke-') && f.endsWith('.mjs'))
    .filter((f) => f.includes(filter))
    .sort();

  let failures = 0;
  for (const file of files) {
    console.log(`\n── ${file} ${'─'.repeat(Math.max(0, 60 - file.length))}`);
    const ok = await run(file);
    if (!ok) { failures++; console.log(`   FAILED: ${file}`); }
  }
  console.log(`\n${files.length - failures}/${files.length} suites passed`);
  process.exitCode = failures ? 1 : 0;
} finally {
  server.kill();
  await rm(join(root, 'server', '.uploads'), { recursive: true, force: true });
}
