#!/usr/bin/env node
/**
 * create-square-standard-tv-catalog.js
 * Creates the Standard TV Mounting category (1st–4th TV) in Square Appointments
 * for The Mounting Man (Minneapolis location).
 *
 * Usage:
 *   SQUARE_TOKEN="..." node create-square-standard-tv-catalog.js
 *   -- or --
 *   SQUARE_TOKEN=$(op read "op://Personal/tl7u4r5blboi2z3qfjxxphc2pi/Production Access Token") \
 *     node create-square-standard-tv-catalog.js
 */

const TOKEN = process.env.SQUARE_TOKEN;
if (!TOKEN) {
  console.error('Error: SQUARE_TOKEN environment variable is required');
  process.exit(1);
}

const BASE_URL     = 'https://connect.squareup.com/v2';
const LOCATION_ID  = 'LVNM3Z4RVRWDK';
const TEAM_MEMBERS = [
  'TMSiHOOr7RGdl2Ki', // Michael Wenzel
  'TMT84KWHegsrcWFB', // Garrison Gillard
  'TMY7unjtR-2XvVpg', // Marshall
  'TMmOwb6WS9cTplXu', // Crashon Traylor
];
const TAX_CC    = 'UYAEERACJE7W6FVVELNNF5GL'; // CC Processing Fee 3.5%
const TAX_SALES = 'T2SCKRERNHFSIU7S4TBXVYEE'; // Sales Tax 8.03%

// Service durations in milliseconds
const D60 = 3_600_000; // 60 min – 1st TV main mount
const D45 = 2_700_000; // 45 min – 2nd TV main mount
const D20 = 1_200_000; // 20 min – 3rd/4th TV main mount
const D1  =    60_000; // 1 min  – all add-on items (surface, bracket, fireplace, cord)

// ─── Service Variations Data ────────────────────────────────────────────────

// Standard wall mount sizes + pricing
const TV_SIZES = [
  { name: 'Under 50"',   price: 15000 },
  { name: '50"',         price: 15000 },
  { name: '55"',         price: 15000 },
  { name: '60"',         price: 15000 },
  { name: '65"',         price: 15000 },
  { name: '70"',         price: 20000 },
  { name: '75"',         price: 22500 },
  { name: '80"',         price: 25000 },
  { name: '85" / 86"',  price: 25000 },
  { name: '87" – 100"', price: 50000 },
];

// Wall surface options — $0 for drywall so customer confirms their surface type
const SURFACES = [
  { name: 'Drywall / Normal Wall',    price:     0 },
  { name: 'Plaster / Stucco',         price:  5000 },
  { name: 'Brick Wall',               price: 10000 },
  { name: 'Stone / Faux Brick',       price: 15000 },
  { name: 'Porcelain / Ceramic Tile', price: 15000 },
  { name: 'Wood Slat Wall',           price: 10000 },
];

// Bracket options (hardware — taxed at CC + Sales Tax)
const BRACKETS = [
  { name: 'Fixed Mounting Bracket',       price:  5000 },
  { name: 'Standard Tilt Bracket',        price:  7500 },
  { name: 'Standard Full Motion Bracket', price: 10000 },
  { name: 'Flush Mounting Bracket',       price: 13500 },
  { name: 'Premium 4D Tilt Bracket',      price: 10000 },
  { name: 'Premium Tilt Bracket',         price: 20000 },
  { name: 'Premium Full Motion Bracket',  price: 20000 },
  { name: 'Soundbar Bracket',             price:  5000 },
  { name: 'Premium Soundbar Bracket',     price: 10000 },
];

// Cord concealing options (full set — in-wall + exterior)
const CORD_CONCEALING = [
  { name: 'Exterior – Not Around Fireplace',  price:  7500 },
  { name: 'Exterior – Around Fireplace',      price: 12500 },
  { name: 'In-Wall (Drywall)',                price: 25000 },
  { name: 'In-Wall + New Outlet',             price: 25000 },
  { name: 'In-Wall (Brick / Fireplace Wall)', price: 35000 },
  { name: 'In-Wall with Soundbar Cords',      price: 30000 },
  { name: 'Through Existing Conduit',         price:  5000 },
];

// ─── Builder Helpers ─────────────────────────────────────────────────────────

let _uidCounter = 0;
const uid = (prefix) => `#${prefix}_${++_uidCounter}`;

function mkVar(idPrefix, name, priceCents, durationMs) {
  return {
    type: 'ITEM_VARIATION',
    id: uid(idPrefix),
    present_at_location_ids: [LOCATION_ID],
    item_variation_data: {
      name,
      pricing_type: 'FIXED_PRICING',
      price_money: { amount: priceCents, currency: 'USD' },
      service_duration: durationMs,
      available_for_booking: true,
      team_member_ids: TEAM_MEMBERS,
    },
  };
}

function mkItem(idPrefix, name, taxIds, variations) {
  return {
    type: 'ITEM',
    id: uid(idPrefix),
    present_at_location_ids: [LOCATION_ID],
    item_data: {
      name,
      product_type: 'APPOINTMENTS_SERVICE',
      tax_ids: taxIds,
      variations,
    },
  };
}

// ─── Build One TV Slot ───────────────────────────────────────────────────────
// Returns the 5 items for one TV slot (mount, surface, bracket, fireplace, cord).

function buildTvSlot(prefix, label, mountDuration) {
  return [
    mkItem(
      `${prefix}_mount`,
      `${label} – Wall Mount`,
      [TAX_CC],
      TV_SIZES.map(s => mkVar(`${prefix}_mount`, s.name, s.price, mountDuration))
    ),
    mkItem(
      `${prefix}_surface`,
      `${label} – Wall Surface`,
      [TAX_CC],
      SURFACES.map(s => mkVar(`${prefix}_surface`, s.name, s.price, D1))
    ),
    mkItem(
      `${prefix}_bracket`,
      `${label} – Bracket`,
      [TAX_CC, TAX_SALES], // Hardware — taxed at CC fee + sales tax
      BRACKETS.map(b => mkVar(`${prefix}_bracket`, b.name, b.price, D1))
    ),
    mkItem(
      `${prefix}_fireplace`,
      `${label} – Fireplace Surcharge`,
      [TAX_CC],
      [mkVar(`${prefix}_fireplace`, 'Above Fireplace (+$50)', 5000, D1)]
    ),
    mkItem(
      `${prefix}_cord`,
      `${label} – Cord Concealing`,
      [TAX_CC],
      CORD_CONCEALING.map(c => mkVar(`${prefix}_cord`, c.name, c.price, D1))
    ),
  ];
}

// ─── Build All 4 TV Slots ────────────────────────────────────────────────────

const allObjects = [
  ...buildTvSlot('tv1', '1st TV', D60),
  ...buildTvSlot('tv2', '2nd TV', D45),
  ...buildTvSlot('tv3', '3rd TV', D20),
  ...buildTvSlot('tv4', '4th TV', D20),
];

console.log(`\nStandard TV Mounting catalog: ${allObjects.length} items to create`);
console.log('  4 slots × 5 items each (mount, surface, bracket, fireplace, cord)\n');

// ─── Square API ───────────────────────────────────────────────────────────────

async function batchUpsert(objects, batchNum) {
  const res = await fetch(`${BASE_URL}/catalog/batch-upsert`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-10-17',
    },
    body: JSON.stringify({
      idempotency_key: `mm-standard-tv-catalog-v1-batch-${batchNum}`,
      batches: [{ objects }],
    }),
  });

  const data = await res.json();

  if (!res.ok || data.errors?.length) {
    console.error(`❌ Batch ${batchNum} failed:`);
    console.error(JSON.stringify(data.errors ?? data, null, 2));
    process.exit(1);
  }

  const count = data.id_mappings?.length ?? '?';
  console.log(`  ✓ Batch ${batchNum}: ${count} objects created`);
  return data;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Split into batches of 10 (Square's recommended batch size)
  const BATCH_SIZE = 10;
  const batches = [];
  for (let i = 0; i < allObjects.length; i += BATCH_SIZE) {
    batches.push(allObjects.slice(i, i + BATCH_SIZE));
  }

  console.log(`Submitting ${batches.length} batches of ≤${BATCH_SIZE} items...\n`);

  for (let i = 0; i < batches.length; i++) {
    await batchUpsert(batches[i], i + 1);
    // Small pause between batches to be a good API citizen
    if (i < batches.length - 1) await new Promise(r => setTimeout(r, 400));
  }

  console.log('\n✅ Done! Standard TV Mounting catalog created successfully.');
  console.log('   Visit Square Dashboard → Appointments → Services to verify.\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
