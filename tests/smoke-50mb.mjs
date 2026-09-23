// The headline path: generate 50 MB, upload it in chunks, hand it to the preview page.
import { chromium } from 'playwright';

const base = process.env.BASE || 'http://localhost:8787';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const setRange = (sel, value) => page.evaluate(([s, v]) => {
  const n = document.querySelector(s);
  n.value = v;
  n.dispatchEvent(new Event('input', { bubbles: true }));
}, [sel, value]);

await page.goto(`${base}/chunked-upload.html`, { waitUntil: 'networkidle' });
await page.selectOption('#genSize', '50');
await setRange('#optBw', '600');
await setRange('#optFail', '8');

let t = Date.now();
await page.click('#genPdf');
await page.waitForSelector('#fileChip:not([hidden])', { timeout: 180_000 });
console.log(`generated in ${((Date.now() - t) / 1000).toFixed(1)}s:`, await page.textContent('#fileChip .fmeta'));

t = Date.now();
await page.click('#btnStart');
await page.waitForFunction(() => document.querySelector('#stateBadge').textContent === 'done', null, { timeout: 300_000 });
console.log(`uploaded in ${((Date.now() - t) / 1000).toFixed(1)}s |`, await page.textContent('#statBytes'), '|', await page.textContent('#statParts'), 'parts |', await page.textContent('#statRetries'), 'retries');
console.log('result:', (await page.textContent('#result')).slice(0, 120));
await page.screenshot({ path: '/tmp/shot-50mb.png' });

// hand off to the preview page
t = Date.now();
await page.click('#btnPreview');
await page.waitForURL(/preview\.html/, { timeout: 60_000 });
await page.waitForSelector('#pdfStage canvas', { timeout: 180_000 });
console.log(`preview opened in ${((Date.now() - t) / 1000).toFixed(1)}s:`, await page.textContent('#pdfMeta'));
await page.fill('#pdfPage', '5000');
await page.dispatchEvent('#pdfPage', 'change');
await page.waitForTimeout(1500);
console.log('page 5000 ->', await page.textContent('#pdfStage .plabel'));
await page.screenshot({ path: '/tmp/shot-50mb-preview.png' });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
