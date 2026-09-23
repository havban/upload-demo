import { chromium } from 'playwright';

const base = process.env.BASE || 'http://localhost:8787';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`${base}/chunked-upload.html`, { waitUntil: 'networkidle' });

// generate a small file
await page.selectOption('#genSize', '5');
await page.selectOption('#optChunk', '1048576');
await page.click('#genPdf');
await page.waitForSelector('#fileChip:not([hidden])', { timeout: 60_000 });
console.log('generated:', await page.textContent('#fileChip .fname'), '|', await page.textContent('#fileChip .fmeta'));

// fast network, some failures, to exercise retries
const setRange = async (sel, value) => page.evaluate(([s, v]) => {
  const n = document.querySelector(s);
  n.value = v;
  n.dispatchEvent(new Event('input', { bubbles: true }));
}, [sel, value]);
await setRange('#optBw', '8');
await setRange('#optFail', '20');

await page.click('#btnStart');
await page.waitForFunction(() => document.querySelector('#stateBadge').textContent === 'uploading', null, { timeout: 15000 });
await new Promise((r) => setTimeout(r, 900));
console.log('mid-upload pct:', await page.textContent('#progressPct'), 'parts:', await page.textContent('#statParts'));

// pause / resume
await page.click('#btnPause');
await page.waitForFunction(() => document.querySelector('#stateBadge').textContent === 'paused', null, { timeout: 8000 });
const pausedPct = await page.textContent('#progressPct');
await page.click('#btnResume');

await page.waitForFunction(() => document.querySelector('#stateBadge').textContent === 'done', null, { timeout: 90_000 });
console.log('paused at', pausedPct, '-> done');
console.log('result:', (await page.textContent('#result')).slice(0, 200));
console.log('stats:', await page.textContent('#statBytes'), '|', await page.textContent('#statRetries'), 'retries |', await page.textContent('#statWire'), 'over wire');
console.log('log tail:', (await page.textContent('#log')).split('\n').slice(-3).join(' // '));

await page.screenshot({ path: '/tmp/shot-chunked.png', fullPage: false });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
