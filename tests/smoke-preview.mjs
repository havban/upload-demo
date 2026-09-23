import { chromium } from 'playwright';
import { blockAnalytics } from './helpers.mjs';

const base = process.env.BASE || 'http://localhost:8787';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await blockAnalytics(page);
await page.goto(`${base}/preview.html`, { waitUntil: 'networkidle' });

// --- PDF ---
await page.click('#btnSamplePdf');
await page.waitForSelector('#pdfStage canvas', { timeout: 60_000 });
console.log('pdf meta:', await page.textContent('#pdfMeta'), '| count:', await page.textContent('#pdfCount'));
const c1 = await page.locator('#pdfStage canvas').first().boundingBox();
console.log('canvas:', Math.round(c1.width), 'x', Math.round(c1.height));
await page.click('#pdfNext');
await page.waitForTimeout(700);
console.log('after next, page input =', await page.inputValue('#pdfPage'), '| label:', await page.textContent('#pdfStage .plabel'));
await page.fill('#pdfPage', '200');
await page.dispatchEvent('#pdfPage', 'change');
await page.waitForTimeout(900);
console.log('jump to 200 ->', await page.textContent('#pdfStage .plabel'));
await page.screenshot({ path: '/tmp/shot-preview-pdf.png' });

// --- XLSX ---
await page.click('#btnSampleXlsx');
await page.waitForSelector('#sheetPane:not([hidden])');
await page.waitForFunction(() => document.querySelectorAll('#sheetBody tr:not(.spacer)').length > 5, null, { timeout: 60_000 });
await page.waitForTimeout(600);
console.log('sheet meta:', await page.textContent('#sheetMeta'), '| tabs:', await page.textContent('#sheetTabs'));
console.log('header:', (await page.textContent('#sheetHead')).slice(0, 90));
const rowText = await page.locator('#sheetBody tr:not(.spacer)').nth(1).textContent();
console.log('row sample:', rowText.slice(0, 110));
console.log('dom rows:', await page.locator('#sheetBody tr:not(.spacer)').count());

// scroll deep
await page.evaluate(() => { document.querySelector('#sheetViewport').scrollTop = 200000; });
await page.waitForTimeout(1200);
console.log('after deep scroll first row #:', await page.locator('#sheetBody tr:not(.spacer) td.rowno').first().textContent());
console.log('loading cells:', await page.locator('#sheetBody td.loading').count());

// goto + search
await page.fill('#sheetGoto', '12345');
await page.click('#btnGoto');
await page.waitForTimeout(800);
console.log('goto 12345 ->', await page.locator('#sheetBody tr:not(.spacer) td.rowno').first().textContent());
await page.fill('#sheetSearch', 'ORD-2026-00009999');
await page.click('#btnFind');
await page.waitForTimeout(1500);
console.log('search status:', await page.textContent('#sheetStatus'));
console.log('highlighted:', await page.locator('#sheetBody tr.hit').count());
await page.screenshot({ path: '/tmp/shot-preview-sheet.png' });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
