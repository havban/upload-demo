#!/usr/bin/env node
/**
 * Writes the committed sample files in samples/.
 *
 * The browser demos generate their own files, so these exist only so the repo has
 * something to open immediately — which is why they are a few MB rather than 50.
 *
 *   node tools/generate-samples.mjs                 # the committed defaults
 *   node tools/generate-samples.mjs --pdf 50        # a 50 MB PDF
 *   node tools/generate-samples.mjs --xlsx-rows 250000
 *   node tools/generate-samples.mjs --xlsx-stored 50   # a 50 MB uncompressed workbook
 *
 * Everything it produces is synthetic — see assets/js/dataset.js.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPdf } from '../assets/js/pdf-writer.js';
import { buildWorkbook } from '../assets/js/xlsx-writer.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'samples');
const MB = 1024 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

const fmt = (n) => `${(n / MB).toFixed(2)} MB`;
const bar = (label) => {
  let last = 0;
  return ({ bytes }) => {
    if (bytes - last < 4 * MB) return;
    last = bytes;
    process.stdout.write(`\r  ${label}: ${fmt(bytes)}          `);
  };
};

async function write(name, parts) {
  const path = join(outDir, name);
  await writeFile(path, Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))));
  const size = parts.reduce((n, p) => n + p.length, 0);
  console.log(`\r  wrote samples/${name} — ${fmt(size)}            `);
}

await mkdir(outDir, { recursive: true });

const pdfMb = arg('pdf', 2);
const xlsxRows = arg('xlsx-rows', 20000);
const xlsxStoredMb = arg('xlsx-stored', 0);

console.log(`Generating samples into ${outDir}`);

{
  const t0 = Date.now();
  const { parts, pageCount } = await buildPdf({ targetBytes: pdfMb * MB, onProgress: bar('pdf') });
  await write(`synthetic-ledger-${pdfMb}mb.pdf`, parts);
  console.log(`    ${pageCount.toLocaleString()} pages in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

{
  const t0 = Date.now();
  const { parts, rowCount } = await buildWorkbook({ rowCount: xlsxRows, compress: true, onProgress: bar('xlsx') });
  await write(`orders-${xlsxRows}-rows.xlsx`, parts);
  console.log(`    ${rowCount.toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (xlsxStoredMb) {
  const { parts, rowCount } = await buildWorkbook({
    targetBytes: xlsxStoredMb * MB,
    compress: false,
    onProgress: bar('xlsx-stored'),
  });
  await write(`orders-${xlsxStoredMb}mb.xlsx`, parts);
  console.log(`    ${rowCount.toLocaleString()} rows, stored uncompressed`);
}

console.log('Done.');
