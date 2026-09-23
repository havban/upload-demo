# upload-demo

Three self-contained demos of the same awkward problem — a file that is too big to POST
in one go — built as a **static site with no build step**.

**Live: <https://havban.github.io/upload-demo/>**

| | Demo | What it shows |
|---|---|---|
| 1 | [Chunked upload](https://havban.github.io/upload-demo/chunked-upload.html) | A 50 MB PDF or workbook sliced into parts, hashed, uploaded several at a time with a live progress bar, retries with backoff, pause/resume, resume after a reload, and a SHA-256 integrity check at the end. |
| 2 | [Row batches](https://havban.github.io/upload-demo/row-upload.html) | A workbook of up to 250,000 rows parsed in a Web Worker, then imported in batches of 100 / 500 / 1000 rows — progress advances per batch, and rows that fail validation come back with the reason. |
| 3 | [Preview](https://havban.github.io/upload-demo/preview.html) | PDF paging with pdf.js and a virtualised sheet grid that stays smooth at a quarter of a million rows, with search, go-to-row and CSV export. |

Everything runs in the tab. Nothing is uploaded anywhere.

---

## How there is an "upload" with no server

GitHub Pages serves static files, so the API is a stand-in that lives in the browser:
[`assets/js/backend-simulated.js`](assets/js/backend-simulated.js). It implements the five
calls a real service would expose and fakes the network in between — bandwidth, latency,
jitter, and a failure rate you control with a slider:

```
POST   /uploads                    → { uploadId, received[] }
GET    /uploads/:id                → which parts already landed  (resume)
PUT    /uploads/:id/parts/:index   → one chunk + its SHA-256
POST   /uploads/:id/complete       → stitch, verify, finish
DELETE /uploads/:id                → discard the session
```

Accepted parts are written to IndexedDB, which is why reloading mid-upload resumes instead
of starting over — the ledger of what arrived survives, exactly as it would on a server.

The retry, resume, checksum and progress logic in
[`assets/js/uploader.js`](assets/js/uploader.js) is not aware of any of this. Point it at
the real thing instead:

```bash
node server/server.mjs           # http://localhost:8787, zero dependencies
```

then open <http://localhost:8787/chunked-upload.html>, switch **Backend** to
*Real server (REST)*, and the identical client code drives a genuine upload.
[`server/server.mjs`](server/server.mjs) implements the same five routes, stores parts
under `server/.uploads/`, verifies every chunk's SHA-256, stitches the file and compares
the manifest hash.

### Why a manifest hash, not a file hash

`crypto.subtle` has no streaming API, so hashing a 50 MB file means holding 50 MB in
memory. Instead each part is hashed as it is sent, and the "whole file" fingerprint is
`SHA-256(digest₀ ‖ digest₁ ‖ … ) - partCount` — the same shape as an S3 multipart ETag.
Client and server compute it independently and the result is compared at completion.

## The sample files are generated, not collected

No real data is used or needed. Both writers are hand-rolled and live in this repo:

- **[`assets/js/pdf-writer.js`](assets/js/pdf-writer.js)** emits a real PDF 1.7 — catalog,
  page tree, base-14 fonts, one uncompressed content stream per page, xref table. A 50 MB
  document is ≈5,800 landscape ledger pages and builds in about 1.5 seconds. Content
  streams are left uncompressed on purpose: it makes the finished size predictable, so
  "give me exactly 50 MB" is one pass with a progress bar.
- **[`assets/js/xlsx-writer.js`](assets/js/xlsx-writer.js)** emits a real OOXML workbook
  (`[Content_Types].xml`, rels, styles, one worksheet), streaming rows in blocks. It can
  *store* the sheet instead of deflating it, which is the only sane way to reach a 50 MB
  target — deflate squeezes repetitive ledger rows about 8×, so a compressed 50 MB
  workbook would need millions of rows.
- **[`assets/js/dataset.js`](assets/js/dataset.js)** is the invented ledger: a seeded PRNG,
  fictional names and companies, `example-*.test` email addresses, and a deliberate data
  defect roughly every 150 rows so demo 2 has something to reject.

Pre-built copies live in [`samples/`](samples/) (2 MB PDF, 20,000-row workbook) and open
with one click on the preview page. Rebuild or resize them with:

```bash
node tools/generate-samples.mjs --pdf 50 --xlsx-rows 250000 --xlsx-stored 50
```

## Running it locally

```bash
git clone https://github.com/havban/upload-demo.git
cd upload-demo
node server/server.mjs            # serves the site *and* the upload API on :8787
# or, static only:
python3 -m http.server 8899
```

There is nothing to install and nothing to build — the pages are plain ES modules, and
SheetJS and pdf.js are vendored under `assets/vendor/`.

## Tests

Playwright drives the real pages end to end:

```bash
npm i -D playwright && npx playwright install chromium
npm test                # every smoke test against a freshly started server
npm test -- 50mb        # just the 50 MB generate → upload → preview run
```

| suite | covers |
|---|---|
| `smoke-chunked` | generate → chunked upload → pause → resume → retries → integrity check, plus 21 parts with 8 in flight |
| `smoke-rows` | generate → worker parse → batched import → validation report |
| `smoke-preview` | sample PDF paging, virtualised grid, deep scroll, go-to-row, search |
| `smoke-server` | the same upload client against the real Node server |
| `smoke-50mb` | 50 MB end to end, including the hand-off into the preview page |
| `smoke-analytics` | every custom event fires, is namespaced, and leaks no query values |

## Layout

```
index.html  chunked-upload.html  row-upload.html  preview.html
assets/
  css/app.css
  js/
    util.js idb.js dataset.js          shared helpers, IndexedDB, synthetic data
    pdf-writer.js xlsx-writer.js       the file generators (browser + Node)
    filegen.js                         browser wrappers with progress
    uploader.js                        chunked upload client
    backend-simulated.js backend-rest.js   the two interchangeable "servers"
    row-importer.js backend-rows.js    batched row import (demo 2)
    xlsx.worker.js sheet-client.js     workbook parsing off the main thread
    analytics.js                       GoatCounter events, namespaced upload-demo/
    page-*.js                          one controller per page
  vendor/                              SheetJS 0.18.5, pdf.js 4.8.69
server/server.mjs                      real implementation of the upload API
tools/generate-samples.mjs             writes samples/
tests/                                 Playwright smoke tests
```

## Analytics

The pages carry [GoatCounter](https://www.goatcounter.com/) — cookie-less, no personal
data, Do Not Track honoured:

```html
<script data-goatcounter="https://havban.goatcounter.com/count"
        async src="//gc.zgo.at/count.js"></script>
```

`count.js` counts the page view itself. [`assets/js/analytics.js`](assets/js/analytics.js)
adds the custom events — which file was generated, whether an upload finished and
verified, which chunk or batch size was used, which preview controls were tried — through
`window.goatcounter.count()`, queueing anything logged before the script loads and falling
back to the pixel endpoint if an ad blocker eats it.

What is **not** sent: file names, file contents, row values, or anything about a file you
drop in. Only counters, and sizes as buckets (`upload-done-25-60mb`), never exact figures.

Every custom event is namespaced **`upload-demo/`**, because the dashboard is shared with
other apps on the same account. Page views keep their real path; the query string is
stripped from them (so `preview.html?stash=…` is one row) and the useful parameters come
back as a single `url?utm_source=…` event.

`count.js` ignores `localhost`, so running the demo locally never reaches the dashboard,
and the Playwright suites block the endpoint outright. To turn analytics off entirely,
delete the two `<script>` tags from the four HTML pages — everything else keeps working.

## Known edges

- A byte target with `compress: true` is an estimate (deflate ratios are data dependent);
  stored workbooks land within ~0.1% of the requested size.
- Generating and parsing a 250,000-row workbook takes ~20 s in total — the progress bars
  are honest about it, but it is not instant.
- The simulated backend keeps parts in IndexedDB. It prunes old sessions, and the
  **Delete all stored parts** button clears everything.
- `CompressionStream('deflate-raw')` is used for compressed workbooks (Chrome 80+,
  Firefox 113+, Safari 16.4+). Uncompressed generation works everywhere.

## Licence

MIT — see [LICENSE](LICENSE).
