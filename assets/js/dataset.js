// Deterministic synthetic dataset — invented sales ledger rows.
//
// Nothing here is real: names, companies, emails and references are generated
// from a seeded PRNG so every run produces the same rows for the same seed.
// Runs unchanged in the browser and in Node (used by tools/generate-samples.mjs).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS = [
  ['APAC', ['Indonesia', 'Singapore', 'Japan', 'Australia', 'Vietnam', 'Malaysia']],
  ['EMEA', ['Germany', 'France', 'Spain', 'Netherlands', 'Kenya', 'United Kingdom']],
  ['AMER', ['United States', 'Canada', 'Brazil', 'Mexico', 'Chile']],
];

const FIRST = ['Ayu', 'Bima', 'Citra', 'Dewi', 'Eka', 'Farid', 'Gita', 'Hana', 'Indra', 'Joko',
  'Kirana', 'Luthfi', 'Maya', 'Nadia', 'Omar', 'Putri', 'Rangga', 'Sari', 'Tono', 'Umi',
  'Vera', 'Wawan', 'Yuni', 'Zaki', 'Lena', 'Marco', 'Nora', 'Pablo', 'Rosa', 'Sven'];
const LAST = ['Wibowo', 'Hartono', 'Nugroho', 'Santoso', 'Pratama', 'Halim', 'Kusuma', 'Mahendra',
  'Lestari', 'Firmansyah', 'Okafor', 'Lindqvist', 'Moreau', 'Rossi', 'Takahashi', 'Alvarez',
  'Nakamura', 'Bauer', 'Costa', 'Ivanov'];

const CATEGORIES = [
  ['Industrial Sensors', ['Thermal Probe TP-40', 'Vibration Node VN-12', 'Flow Meter FM-900', 'Pressure Cell PC-7']],
  ['Networking', ['Edge Router ER-220', 'Mesh Bridge MB-8', 'Fiber Patch FP-24', 'LoRa Gateway LG-3']],
  ['Power', ['Inverter INV-5kW', 'Battery Rack BR-48', 'Charge Controller CC-60', 'Solar Panel SP-450']],
  ['Software', ['Fleet Console (annual)', 'Telemetry Pack (annual)', 'Analytics Add-on', 'Support Plan Gold']],
  ['Logistics', ['Crate Pallet L', 'Cold Chain Liner', 'Shock Logger SL-2', 'RFID Tag Roll']],
];

const STATUSES = ['paid', 'pending', 'shipped', 'invoiced', 'refunded', 'cancelled'];
const CHANNELS = ['direct', 'reseller', 'marketplace', 'field-sales'];
const HEX = '0123456789abcdef';

/** Column contract shared by the XLSX writer, the PDF report and the validators. */
export const COLUMNS = [
  { key: 'row_id', label: 'Row ID', type: 'int', width: 9, pdf: 7 },
  { key: 'order_ref', label: 'Order Ref', type: 'text', width: 17, pdf: 17 },
  { key: 'order_date', label: 'Order Date', type: 'date', width: 12, pdf: 11 },
  { key: 'region', label: 'Region', type: 'text', width: 8, pdf: 6 },
  { key: 'country', label: 'Country', type: 'text', width: 15, pdf: 14 },
  { key: 'sales_rep', label: 'Sales Rep', type: 'text', width: 20, pdf: 18 },
  { key: 'customer_email', label: 'Customer Email', type: 'text', width: 30, pdf: 28 },
  { key: 'product', label: 'Product', type: 'text', width: 24, pdf: 22 },
  { key: 'category', label: 'Category', type: 'text', width: 19, pdf: 0 },
  { key: 'channel', label: 'Channel', type: 'text', width: 13, pdf: 0 },
  { key: 'quantity', label: 'Qty', type: 'int', width: 7, pdf: 5 },
  { key: 'unit_price', label: 'Unit Price', type: 'money', width: 12, pdf: 11 },
  { key: 'discount_pct', label: 'Disc %', type: 'num', width: 8, pdf: 0 },
  { key: 'line_total', label: 'Line Total', type: 'money', width: 13, pdf: 12 },
  { key: 'status', label: 'Status', type: 'text', width: 11, pdf: 9 },
  { key: 'batch_ref', label: 'Batch Ref', type: 'text', width: 26, pdf: 0 },
];

export const HEADER_LABELS = COLUMNS.map((c) => c.label);

/** Days since 1899-12-30 (the Excel epoch) for a JS Date. */
export function toExcelSerial(date) {
  return Math.floor((date.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
}

const EPOCH = Date.UTC(2025, 0, 1);

/**
 * Build one synthetic row.
 * Roughly one row in `defectEvery` carries a deliberate data problem so the
 * row-validation demo has something to report. Pass defectEvery = 0 for clean data.
 */
export function makeRow(i, rnd, defectEvery = 150) {
  const [region, countries] = REGIONS[Math.floor(rnd() * REGIONS.length)];
  const country = countries[Math.floor(rnd() * countries.length)];
  const first = FIRST[Math.floor(rnd() * FIRST.length)];
  const last = LAST[Math.floor(rnd() * LAST.length)];
  const [category, products] = CATEGORIES[Math.floor(rnd() * CATEGORIES.length)];
  const product = products[Math.floor(rnd() * products.length)];
  const dayOffset = Math.floor(rnd() * 640);
  const date = new Date(EPOCH + dayOffset * 86400000);
  const quantity = 1 + Math.floor(rnd() * 240);
  const unitPrice = Math.round((4 + rnd() * 1850) * 100) / 100;
  const discount = Math.round(rnd() * 22 * 10) / 10;
  let batch = '';
  for (let b = 0; b < 24; b++) batch += HEX[Math.floor(rnd() * 16)];

  const row = {
    row_id: i,
    order_ref: `ORD-${date.getUTCFullYear()}-${String(i).padStart(8, '0')}`,
    order_date: date,
    region,
    country,
    sales_rep: `${first} ${last}`,
    customer_email: `${first.toLowerCase()}.${last.toLowerCase()}${i % 97}@example-${region.toLowerCase()}.test`,
    product,
    category,
    channel: CHANNELS[Math.floor(rnd() * CHANNELS.length)],
    quantity,
    unit_price: unitPrice,
    discount_pct: discount,
    line_total: Math.round(quantity * unitPrice * (1 - discount / 100) * 100) / 100,
    status: STATUSES[Math.floor(rnd() * STATUSES.length)],
    batch_ref: `BR-${batch}`,
  };

  if (defectEvery > 0 && i % defectEvery === 0 && i > 0) {
    // Five recurring, realistic import problems.
    switch ((i / defectEvery) % 5) {
      case 0: row.quantity = 0; break;                              // zero quantity
      case 1: row.customer_email = `${first.toLowerCase()}.at.example`; break; // malformed email
      case 2: row.sales_rep = ''; break;                            // missing required field
      case 3: row.unit_price = 'N/A'; break;                        // non-numeric price
      default: row.line_total = Math.round(row.line_total * 1.35 * 100) / 100; break; // total ≠ qty × price
    }
  }
  return row;
}

/** Cheap generator over `count` rows without materialising them all. */
export function* rowStream(count, { seed = 20260923, defectEvery = 150, startAt = 1 } = {}) {
  const rnd = mulberry32(seed);
  for (let i = startAt; i < startAt + count; i++) yield makeRow(i, rnd, defectEvery);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Validate one row object (keys per COLUMNS). Returns an array of problems.
 * Used by the batched row-upload demo to show server-side rejections.
 */
export function validateRow(row) {
  const problems = [];
  const qty = Number(row.quantity);
  const price = Number(row.unit_price);
  const total = Number(row.line_total);
  const disc = Number(row.discount_pct);

  if (!row.order_ref) problems.push('order_ref is required');
  if (!String(row.sales_rep || '').trim()) problems.push('sales_rep is required');
  if (!EMAIL_RE.test(String(row.customer_email || ''))) problems.push('customer_email is not a valid address');
  if (!Number.isFinite(qty) || qty <= 0) problems.push('quantity must be a positive number');
  if (!Number.isFinite(price) || price <= 0) problems.push('unit_price must be numeric');
  if (Number.isFinite(qty) && Number.isFinite(price) && Number.isFinite(total) && Number.isFinite(disc)) {
    const expected = qty * price * (1 - disc / 100);
    if (Math.abs(expected - total) > Math.max(0.05, expected * 0.001)) {
      problems.push(`line_total ${total.toFixed(2)} ≠ expected ${expected.toFixed(2)}`);
    }
  }
  return problems;
}
