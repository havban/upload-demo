# Working on upload-demo

Conventions and traps, so the next change does not rediscover them.

## Ground rules

- **No build step, no framework, no npm dependencies.** Pages are plain HTML with
  `<script type="module">`; everything is ES modules served as-is. `package.json` exists
  for scripts and metadata only — `npm install` installs nothing (Playwright is a dev
  extra you add yourself when running the tests).
- **Vendored libraries** live in `assets/vendor/` (SheetJS 0.18.5, pdf.js 4.8.69). Do not
  swap them for CDN links: the site must work offline and must not leak visitors to a
  third party.
- Keep `assets/js/pdf-writer.js`, `assets/js/xlsx-writer.js` and `assets/js/dataset.js`
  runnable in **both** the browser and Node — `tools/generate-samples.mjs` imports them
  directly. That means no DOM, no `Blob` in the writers themselves (they return arrays of
  `Uint8Array`; the caller decides what to wrap them in).
- British-to-American spelling is not policed, but match the surrounding file.

## The traps

- **`[hidden]` vs `.btn`.** `.btn` sets `display: inline-flex`, which beats the default
  `[hidden] { display: none }`. `app.css` has an explicit
  `[hidden] { display: none !important; }` near the top — keep it.
- **SheetJS 0.18.5 dense sheets** are stored as numeric keys on the sheet object
  (`ws[0]`, `ws[1]`, …), not under `ws['!data']` as in 0.19+. `xlsx.worker.js` handles
  both plus a sparse fallback. Changing the vendored version means revisiting `gridOf()`.
- **`crypto.subtle` cannot stream.** Never hash a whole 50 MB file; hash each part and
  combine (`manifestHash()` in `util.js`). The server does the same thing in
  `server/server.mjs` — if you change the format, change both or the integrity check
  starts failing for everyone.
- **Concurrent part uploads must not read-modify-write one shared record.** Both
  backends learned this the hard way: with several parts in flight, two requests read the
  same session snapshot and the second write drops the first, so the upload dies at
  completion with "missing parts: have 5 of 6". The server writes `<index>.sha256` per
  part; the simulated backend stores the digest inside the part record and derives
  `received` from the IndexedDB key range. Neither keeps a mutable `received` array.
  `tests/smoke-chunked.mjs` covers it with 21 parts and 8 in flight — the race only shows
  up on a fast link.
- **PDF content must stay ASCII.** `pdf-writer.js` tracks byte offsets using string
  lengths, which is only valid because `esc()` strips anything outside `\x20-\x7e`. If you
  add non-ASCII text, the xref table silently goes wrong.
- **Excel size targets.** `compress: false` stores the sheet, so raw XML bytes ≈ file
  bytes and a 50 MB target lands within ~0.1%. With `compress: true` the target is a
  guess — demo 2 asks for a row count instead, which is exact.
- **`Intl.NumberFormat`/`toLocaleString` in a hot loop** cost 10× a hand-rolled formatter.
  That single change took 50 MB PDF generation from 16 s to 1.3 s. Do not reintroduce it
  inside `rowLine()`.

## The backend contract

`assets/js/uploader.js` knows nothing about where bytes go. Anything with these methods
can be dropped in (`backend-simulated.js`, `backend-rest.js`, `server/server.mjs`):

```
createUpload(meta)                        -> { uploadId, received[], resumed }
getUpload(uploadId)                       -> { received[], completed }
uploadPart({uploadId, index, blob, checksum, onProgress, signal})
complete({uploadId, manifestHash})        -> { size, parts, manifestHash, manifestMatches }
abort(uploadId)
download(uploadId)                        -> Blob        (demo convenience)
```

Errors should carry `status` and `retryable` (see `HttpError`) — the uploader retries only
what is marked retryable, everything else fails the upload immediately.

Demo 2 has its own, smaller contract in `backend-rows.js`:
`createImport`, `postBatch`, `commit`.

## Analytics

`assets/js/analytics.js` is a port of rhino-rex's `js/analytics.js` without the
game-specific local tally. Two rules matter:

- **Every custom event goes through `event()` / `once()`**, which prefixes it with
  `upload-demo/`. The GoatCounter site is shared with `rhino-rex/` and
  `belajar-menulis/`; an unprefixed `export-csv` is indistinguishable from anything else
  on the dashboard. `tests/smoke-analytics.mjs` fails the build if an unprefixed event
  escapes, or if a page view is sent from the module (count.js already does that).
- **Never put user data in an event name.** Sizes and row counts go through
  `sizeBucket()` / `rowBucket()`; query strings are filtered to `KEEP_PARAMS` and
  truncated. An event name derived from something a visitor controls is an open door to
  minting unlimited dashboard rows.

Use `once()` for anything a visitor can trigger repeatedly (zoom, paging, search) and
`event()` for milestones (upload finished, import finished).

`count.js` ignores localhost, so local runs never reach the dashboard; the test helpers in
`tests/helpers.mjs` block the endpoint as well, and `stubAnalytics()` records what the
page *would* have sent.

## Testing

```bash
npm i -D playwright && npx playwright install chromium
npm test                 # spins up server/server.mjs on :8788 and runs every smoke test
npm test -- preview      # filter by filename
```

The suites drive the real pages and assert on rendered text, not internals. They write
screenshots to `/tmp/shot-*.png`, which are worth a look when a layout change lands.
If a run is interrupted, check nothing is still holding the port: `ss -lptn 'sport = :8788'`.

## Deploying

`.github/workflows/pages.yml` builds nothing — it checks the two generators still run
under Node, then uploads the repo root as the Pages artifact. `.nojekyll` is required
(without it, GitHub would skip nothing here, but it also stops Jekyll wasting a minute).

Commits in this environment need an explicit identity:

```bash
GIT_AUTHOR_NAME=havban GIT_AUTHOR_EMAIL=hidayat.febiansyah@gmail.com \
GIT_COMMITTER_NAME=havban GIT_COMMITTER_EMAIL=hidayat.febiansyah@gmail.com \
git commit -m "…"
```

## Do not commit

- 50 MB sample files. `samples/` holds a 2 MB PDF and a 20,000-row workbook; the browser
  generates the big ones on demand, and `tools/generate-samples.mjs --pdf 50` makes them
  locally if you need one on disk.
- `server/.uploads/` (gitignored) — it fills with whatever you uploaded while testing.
