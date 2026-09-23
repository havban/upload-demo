import { chromium } from 'playwright';
import { blockAnalytics } from './helpers.mjs';

const base = process.env.BASE || 'http://localhost:8787';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await blockAnalytics(page);
await page.goto(`${base}/row-upload.html`, { waitUntil: 'networkidle' });

await page.selectOption('#genRows', '10000');
await page.click('#genXlsx');
await page.waitForFunction(() => document.querySelector('#parseBadge').textContent === 'ready', null, { timeout: 120_000 });
console.log('file:', await page.textContent('#fileChip .fmeta'));
console.log('parse:', await page.textContent('#parseMeta'));
console.log('mapping rows:', await page.locator('#mapping > div').count(), 'unmapped:', await page.locator('#mapping .badge.warn').count());

await page.selectOption('#optBatch', '500');
await page.click('#btnStart');
await page.waitForFunction(() => document.querySelector('#importBadge').textContent === 'running', null, { timeout: 10_000 });
await new Promise((r) => setTimeout(r, 1200));
console.log('mid pct:', await page.textContent('#importPct'), '| batches', await page.textContent('#statBatches'), '| rate', await page.textContent('#statRate'));
await page.click('#btnPause');
await page.waitForFunction(() => document.querySelector('#importBadge').textContent === 'paused', null, { timeout: 8000 });
await page.click('#btnResume');

await page.waitForFunction(() => document.querySelector('#importBadge').textContent === 'done', null, { timeout: 180_000 });
console.log('result:', await page.textContent('#importResult'));
console.log('stats:', await page.textContent('#statRows'), 'rows |', await page.textContent('#statAccepted'), 'ok |', await page.textContent('#statRejected'), 'rejected |', await page.textContent('#statRetries'), 'retries');
console.log('reject table rows:', await page.locator('#rejectTable tbody tr').count());
console.log('first reject:', await page.locator('#rejectTable tbody tr').first().textContent());
await page.screenshot({ path: '/tmp/shot-rows.png' });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
