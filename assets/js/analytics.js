/**
 * Aggregate counters, sent to GoatCounter.
 *
 * The official snippet lives in every page's <head>:
 *
 *   <script data-goatcounter="https://havban.goatcounter.com/count"
 *           async src="//gc.zgo.at/count.js"></script>
 *
 * That script counts the page view by itself. This module adds the custom events
 * (which file was generated, whether an upload finished, which batch size was used)
 * through window.goatcounter.count(), queueing anything logged before the script
 * finishes loading, and falling back to the pixel endpoint if an ad blocker eats it.
 * The endpoint is read from the tag, so it is configured in exactly one place.
 *
 * Only counters are sent — no ids, no cookies, no file names, no file contents, nothing
 * about the data you drop into the demos — and Do Not Track is honoured. Delete the tag
 * from the HTML to turn all of it off; every page keeps working. To route the events
 * somewhere else instead, set window.__udTrack = (path, title, isEvent) => {...}.
 *
 * Dashboard: https://havban.goatcounter.com — shared with the other pages on this
 * account, which is why every event below is namespaced.
 *
 * Ported from rhino-rex's js/analytics.js, minus the game-specific local tally.
 */

const SITE_TITLE = 'Upload Demo';
const SCRIPT_TIMEOUT = 6000;     // if count.js never arrives, fall back to a pixel

/**
 * Every custom event is namespaced. The GoatCounter site is shared with other apps on
 * this account, and an unprefixed `upload-done` or `export-csv` is indistinguishable
 * from anything else that happens to send the same name. A path-shaped prefix also
 * means the dashboard can filter this demo in or out with one term — the same
 * convention as `rhino-rex/` and `belajar-menulis/`.
 *
 * Page views are *not* prefixed: their path is the real URL, which is how GoatCounter
 * tells the four pages apart already.
 */
const EVENT_PREFIX = 'upload-demo/';

let blocked = false;
const queue = [];

const doNotTrack = () =>
  navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;

/** The /count URL, taken from the GoatCounter script tag in the page. */
function endpoint() {
  const tag = document.querySelector('script[data-goatcounter]');
  return tag ? tag.getAttribute('data-goatcounter') : '';
}

const scriptReady = () => typeof window.goatcounter?.count === 'function';

// Last-ditch path: the script was blocked, so hit the endpoint directly.
function pixel(path, title, isEvent) {
  const url = endpoint();
  if (!url || doNotTrack()) return;
  try {
    const u = new URL(url);
    u.searchParams.set('p', path);
    u.searchParams.set('t', title || path);
    if (isEvent) u.searchParams.set('e', 'true');
    u.searchParams.set('r', document.referrer || '');
    u.searchParams.set('s', [screen.width, screen.height, devicePixelRatio || 1].join(','));
    u.searchParams.set('rnd', Math.random().toString(36).slice(2, 10));
    new Image().src = u.toString();
  } catch { /* analytics must never break the page */ }
}

function send(path, title, isEvent) {
  if (window.__udTrack) window.__udTrack(path, title, isEvent);
  else if (scriptReady()) window.goatcounter.count({ path, title: title || path, event: isEvent });
  else pixel(path, title, isEvent);
}

function deliver(path, title, isEvent) {
  if (window.__udTrack || scriptReady() || blocked) { send(path, title, isEvent); return; }
  queue.push([path, title, isEvent]);
}

function flush() {
  while (queue.length) send(...queue.shift());
}

/** Waits for count.js, then drains anything the page logged while it loaded. */
export function install() {
  if (scriptReady()) { flush(); return; }
  const started = Date.now();
  const tick = () => {
    if (scriptReady()) { flush(); return; }
    if (Date.now() - started > SCRIPT_TIMEOUT) {
      blocked = true;                 // ad blocker, offline, or no tag at all
      if (endpoint() && !window.__udTrack) pixel(location.pathname || '/', document.title || SITE_TITLE, false);
      flush();
      return;
    }
    setTimeout(tick, 250);
  };
  tick();
}

/**
 * The query string, tracked separately and on purpose.
 *
 * Page views are counted with the query **stripped** (see the `goatcounter.path`
 * callback in each page's head), so `preview.html?stash=f_abc123` stays one row instead
 * of minting a new page per hand-off. That would lose the query entirely, so the useful
 * part comes back here as its own event — an event, not a second page view, because a
 * second page view would double every visit figure on the dashboard.
 *
 * Only known parameters survive, and their values are truncated. An arbitrary query
 * would let anyone mint unlimited event names just by sharing a link.
 */
const KEEP_PARAMS = ['ref', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];

export function landing() {
  let q = '';
  try {
    const src = new URLSearchParams(location.search);
    const keep = new URLSearchParams();
    for (const k of KEEP_PARAMS) if (src.has(k)) keep.set(k, String(src.get(k)).slice(0, 40));
    q = keep.toString();
  } catch { /* analytics must never break the page */ }
  // Nothing is sent for a plain URL: the page-view count is already the number of loads,
  // so a `url` event on every one of them would add no information.
  if (q) event(`url?${q}`, `Opened with parameters: ?${q}`);
}

export function event(name, title) {
  deliver(EVENT_PREFIX + name, title || name, true);
}

/** The namespace the dashboard filters on. Exported for the tests. */
export const prefix = EVENT_PREFIX;

// Events that describe a session rather than a moment — which page was opened, which
// controls were tried — must fire at most once per page load, or somebody clicking
// around the demo for a minute would drown the dashboard.
const fired = new Set();
export function once(name, title) {
  if (fired.has(name)) return false;
  fired.add(name);
  event(name, title);
  return true;
}

/* ------------------------------------------------------------------ buckets */
// Sent as event names, so the dashboard shows a distribution rather than a long tail
// of unique numbers.

const MB = 1024 * 1024;

export const sizeBucket = (bytes) =>
  bytes >= 60 * MB ? '60mb-plus'
    : bytes >= 25 * MB ? '25-60mb'
      : bytes >= 5 * MB ? '5-25mb'
        : bytes >= MB ? '1-5mb' : 'under-1mb';

export const rowBucket = (rows) =>
  rows >= 200_000 ? '200k-plus'
    : rows >= 100_000 ? '100k-200k'
      : rows >= 25_000 ? '25k-100k'
        : rows >= 5_000 ? '5k-25k' : 'under-5k';

/** Start the queue and record the landing parameters. Call once per page. */
export function boot() {
  install();
  landing();
}
