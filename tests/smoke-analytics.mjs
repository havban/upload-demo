// Every custom event must be namespaced and must actually fire.
import { chromium } from 'playwright';
import { stubAnalytics, eventPaths } from './helpers.mjs';

const base = process.env.BASE || 'http://localhost:8787';
const PREFIX = 'upload-demo/';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await stubAnalytics(page);

const problems = [];
const expect = (list, name) => {
  if (!list.includes(PREFIX + name)) problems.push(`missing event: ${name}`);
};

const setRange = (sel, value) => page.evaluate(([s, v]) => {
  const n = document.querySelector(s);
  n.value = v;
  n.dispatchEvent(new Event('input', { bubbles: true }));
}, [sel, value]);

/* ---------------------------------------------------------- demo 1 */
await page.goto(`${base}/chunked-upload.html`, { waitUntil: 'networkidle' });
await page.selectOption('#genSize', '5');
await page.selectOption('#optChunk', '1048576');
await setRange('#optBw', '600');
await setRange('#optFail', '0');
await page.click('#genPdf');
await page.waitForSelector('#fileChip:not([hidden])', { timeout: 90_000 });
await page.click('#btnStart');
await page.waitForFunction(() => document.querySelector('#stateBadge').textContent === 'done', null, { timeout: 120_000 });
const one = await eventPaths(page);
console.log('demo 1:', one.join(' '));
expect(one, 'generate-pdf-5-25mb');
expect(one, 'upload-start');
expect(one, 'chunk-1mb');
expect(one, 'upload-done-5-25mb');
expect(one, 'verify-ok');

/* ---------------------------------------------------------- demo 2 */
await page.goto(`${base}/row-upload.html`, { waitUntil: 'networkidle' });
await page.selectOption('#genRows', '10000');
await setRange('#optRowCost', '2');
await page.click('#genXlsx');
await page.waitForFunction(() => document.querySelector('#parseBadge').textContent === 'ready', null, { timeout: 120_000 });
await page.click('#btnStart');
await page.waitForFunction(() => document.querySelector('#importBadge').textContent === 'done', null, { timeout: 180_000 });
await page.click('#btnExportErrors');
const two = await eventPaths(page);
console.log('demo 2:', two.join(' '));
expect(two, 'generate-rows-5k-25k');
expect(two, 'parse-5k-25k');
expect(two, 'import-start');
expect(two, 'batch-500');
expect(two, 'import-done-5k-25k');
expect(two, 'import-rejects');
expect(two, 'export-error-csv');

/* ---------------------------------------------------------- demo 3 */
await page.goto(`${base}/preview.html?utm_source=test&stash=ignored`, { waitUntil: 'networkidle' });
await page.click('#btnSamplePdf');
await page.waitForSelector('#pdfStage canvas', { timeout: 90_000 });
await page.click('#pdfNext');
await page.waitForTimeout(500);
await page.click('#btnSampleXlsx');
await page.waitForFunction(() => document.querySelectorAll('#sheetBody tr:not(.spacer)').length > 5, null, { timeout: 90_000 });
await page.fill('#sheetSearch', 'Kenya');
await page.click('#btnFind');
await page.waitForTimeout(800);
const three = await eventPaths(page);
console.log('demo 3:', three.join(' '));
expect(three, 'sample-pdf');
expect(three, 'preview-pdf-1-5mb');
expect(three, 'pdf-paged');
expect(three, 'sample-xlsx');
expect(three, 'preview-xlsx-1-5mb');
expect(three, 'sheet-search');
expect(three, 'url?utm_source=test');
if (three.some((p) => p.includes('stash'))) problems.push('a random query value leaked into an event name');

/* ------------------------------------------------- invariants + views */
const all = await page.evaluate(() => window.__gcCalls || []);
const stray = all.filter((c) => c.event && !c.path.startsWith(PREFIX)).map((c) => c.path);
if (stray.length) problems.push(`unprefixed events: ${stray.join(', ')}`);
const views = all.filter((c) => !c.event);
if (views.length) problems.push(`page views should come from count.js, not the module: ${views.map((v) => v.path).join(', ')}`);

console.log('total events:', all.length, '| all prefixed:', !stray.length);
console.log('errors:', errors.length ? errors : 'none');
if (problems.length) {
  console.log('FAILURES:\n - ' + problems.join('\n - '));
  await browser.close();
  process.exit(1);
}
console.log('analytics OK');
await browser.close();
