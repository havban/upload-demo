// End-to-end against the real Node server in server/ (start it first).
import { chromium } from 'playwright';

const base = process.env.BASE || 'http://localhost:8787';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${base}/chunked-upload.html`, { waitUntil: 'networkidle' });
await page.selectOption('#optBackend', 'rest');
await page.fill('#optRestUrl', base);
await page.click('#btnPing');
await page.waitForTimeout(600);
console.log('ping:', await page.textContent('#pingResult'));

await page.selectOption('#genSize', '5');
await page.selectOption('#optChunk', '1048576');
await page.click('#genXlsx');
await page.waitForSelector('#fileChip:not([hidden])', { timeout: 90_000 });
console.log('file:', await page.textContent('#fileChip .fmeta'));

await page.click('#btnStart');
await page.waitForFunction(() => document.querySelector('#stateBadge').textContent === 'done', null, { timeout: 120_000 });
console.log('result:', (await page.textContent('#result')).slice(0, 160));
console.log('stats:', await page.textContent('#statBytes'), '|', await page.textContent('#statParts'), 'parts');
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
