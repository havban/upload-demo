/**
 * Shared Playwright helpers.
 *
 * Every suite blocks the analytics network by default: the pages carry a real
 * GoatCounter tag, and a test run must not show up on the dashboard as traffic.
 */

/**
 * Answer count.js and the pixel endpoint locally with empty 200s.
 * Fulfilling rather than aborting keeps `net::ERR_FAILED` noise out of the console
 * assertions each suite makes.
 */
export async function blockAnalytics(page) {
  const empty = (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  await page.route('**/gc.zgo.at/**', empty);
  await page.route('**/havban.goatcounter.com/**', empty);
}

/**
 * Replace count.js with a stub that records what the page sends.
 * Read the result with `await page.evaluate(() => window.__gcCalls)`.
 */
export async function stubAnalytics(page) {
  await page.route('**/havban.goatcounter.com/**', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('**/gc.zgo.at/count.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: `
      window.goatcounter = window.goatcounter || {};
      window.__gcCalls = [];
      window.goatcounter.count = function (o) { window.__gcCalls.push(o); };
    `,
  }));
}

export const eventPaths = (page) =>
  page.evaluate(() => (window.__gcCalls || []).filter((c) => c.event).map((c) => c.path));
