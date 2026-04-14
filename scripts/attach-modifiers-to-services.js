#!/usr/bin/env node
/**
 * attach-modifiers-to-services.js
 *
 * Modifier lists already created (2026-02-23 run):
 *   surface:   6NS4KLOS6O6DI7OPL6SOB5ZN
 *   fireplace: RJAC55FEJWKF2TFHLSMGBVZM
 *   bracket:   JBEXX6FL4C5MLC4JVPKOCB6I
 *   cord:      62V7TND6SVT6FT37JWJVUTT6
 *   unmount:   YMPI7BYJIF2TKDY6WMAOG2KU
 *   soundbar:  6TUIDA5DBLVNM7OM3CBOB4SP
 *   sbbracket: FN4GFRDYHA3BUY6BJEPQ4LAM
 *
 * This script:
 *   1. Fetches current state of the 3 clean service items
 *   2. Attaches modifier lists to each
 *   3. Finds and hides the standalone Cord Concealing service item
 */

const https = require('https');

const TOKEN = process.env.SQUARE_TOKEN;
if (!TOKEN) { console.error('SQUARE_TOKEN not set'); process.exit(1); }

// ── Hardcoded IDs ─────────────────────────────────────────────────────────────
const ITEMS = {
  tvWallMount:  'C4HUAFZSRIG6K45C7PWN6WBZ',
  samsungFrame: 'IV6XZIAO5XLXVANQLSLTW2UG',
  mantelMount:  '4B7ZEZGIX3J6OWAXGQTW446M',
};

const ML = {
  surface:   '6NS4KLOS6O6DI7OPL6SOB5ZN',
  fireplace: 'RJAC55FEJWKF2TFHLSMGBVZM',
  bracket:   'JBEXX6FL4C5MLC4JVPKOCB6I',
  cord:      '62V7TND6SVT6FT37JWJVUTT6',
  unmount:   'YMPI7BYJIF2TKDY6WMAOG2KU',
  soundbar:  '6TUIDA5DBLVNM7OM3CBOB4SP',
  sbbracket: 'FN4GFRDYHA3BUY6BJEPQ4LAM',
};

// ── API helper ────────────────────────────────────────────────────────────────
function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'connect.squareup.com',
      path: `/v2${path}`,
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Square-Version': '2025-01-23',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        const parsed = JSON.parse(buf);
        if (parsed.errors?.length) reject(new Error(JSON.stringify(parsed.errors, null, 2)));
        else resolve(parsed);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function mlInfo(id) {
  return { modifier_list_id: id, enabled: true, min_selected_modifiers: -1, max_selected_modifiers: -1 };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Attaching modifier groups to TV mounting services…\n');

  // ── STEP 1: Find Cord Concealing item ─────────────────────────────────────
  console.log('── STEP 1: Finding Cord Concealing standalone service item…');
  const cordSearch = await api('POST', '/catalog/search', {
    object_types: ['ITEM'],
    query: { text_query: { keywords: ['Cord', 'Concealing'] } },
  });
  const cordItem = (cordSearch.objects || []).find(
    (o) => o.item_data?.name === 'Cord Concealing' && !o.is_deleted
  );
  if (cordItem) {
    console.log(`  Found: ${cordItem.id} — will hide from booking widget`);
  } else {
    console.log('  Not found (already hidden or deleted — OK)');
  }

  // ── STEP 2: Fetch full current state of all 3 service items ───────────────
  console.log('\n── STEP 2: Fetching current item state…');
  const idsToFetch = Object.values(ITEMS);
  if (cordItem) idsToFetch.push(cordItem.id);

  const batchGet = await api('POST', '/catalog/batch-retrieve', {
    object_ids: idsToFetch,
    include_related_objects: false,
  });

  const byId = {};
  for (const obj of batchGet.objects || []) byId[obj.id] = obj;

  const tvFull = byId[ITEMS.tvWallMount];
  const sfFull = byId[ITEMS.samsungFrame];
  const mmFull = byId[ITEMS.mantelMount];

  if (!tvFull) throw new Error('TV Wall Mount not found');
  if (!sfFull) throw new Error('Samsung Frame TV Installation not found');
  if (!mmFull) throw new Error('MantelMount Installation not found');

  console.log(`  TV Wall Mount:              version ${tvFull.version}`);
  console.log(`  Samsung Frame Installation: version ${sfFull.version}`);
  console.log(`  MantelMount Installation:   version ${mmFull.version}`);

  // ── STEP 3: Attach modifier lists to each item ────────────────────────────
  console.log('\n── STEP 3: Attaching modifier lists…');

  function buildItemUpdate(full, modifierListInfoArray, nameOverride) {
    const d = full.item_data;
    return {
      type: 'ITEM',
      id: full.id,
      version: full.version,
      present_at_all_locations: full.present_at_all_locations,
      present_at_location_ids: full.present_at_location_ids,
      item_data: {
        name: nameOverride || d.name,
        is_taxable: d.is_taxable,
        tax_ids: d.tax_ids,
        product_type: d.product_type || 'APPOINTMENTS_SERVICE',
        ecom_visibility: d.ecom_visibility,
        is_archived: d.is_archived,
        variations: d.variations, // MUST include — omitting deletes all variations
        skip_modifier_screen: false,
        modifier_list_info: modifierListInfoArray,
      },
    };
  }

  const updateObjects = [
    // TV Wall Mount — all 7 modifier groups
    buildItemUpdate(tvFull, [
      mlInfo(ML.surface),
      mlInfo(ML.fireplace),
      mlInfo(ML.bracket),
      mlInfo(ML.cord),
      mlInfo(ML.unmount),
      mlInfo(ML.soundbar),
      mlInfo(ML.sbbracket),
    ]),
    // Samsung Frame TV — 6 groups (no bracket; bracket comes with TV)
    buildItemUpdate(sfFull, [
      mlInfo(ML.surface),
      mlInfo(ML.fireplace),
      mlInfo(ML.cord),
      mlInfo(ML.unmount),
      mlInfo(ML.soundbar),
      mlInfo(ML.sbbracket),
    ]),
    // MantelMount — 4 groups (no surface/bracket; always over fireplace, bracket included)
    buildItemUpdate(mmFull, [
      mlInfo(ML.cord),
      mlInfo(ML.unmount),
      mlInfo(ML.soundbar),
      mlInfo(ML.sbbracket),
    ]),
  ];

  await api('POST', '/catalog/batch-upsert', {
    idempotency_key: 'attach-ml-to-items-2026-02-23-v2',
    batches: [{ objects: updateObjects }],
  });

  console.log('  ✓ TV Wall Mount         — 7 modifier groups (Surface, Fireplace, Bracket, Cord, Unmount, Soundbar, SB Bracket)');
  console.log('  ✓ Samsung Frame TV      — 6 modifier groups (Surface, Fireplace, Cord, Unmount, Soundbar, SB Bracket)');
  console.log('  ✓ MantelMount           — 4 modifier groups (Cord, Unmount, Soundbar, SB Bracket)');

  // ── STEP 4: Hide standalone Cord Concealing service item ──────────────────
  if (cordItem) {
    console.log('\n── STEP 4: Hiding standalone Cord Concealing service item…');
    const cordFull = byId[cordItem.id];
    const hiddenVars = (cordFull.item_data.variations || []).map((v) => ({
      type: 'ITEM_VARIATION',
      id: v.id,
      version: v.version,
      present_at_all_locations: v.present_at_all_locations,
      present_at_location_ids: v.present_at_location_ids,
      item_variation_data: { ...v.item_variation_data, available_for_booking: false },
    }));
    await api('POST', '/catalog/batch-upsert', {
      idempotency_key: 'hide-cord-concealing-2026-02-23-v2',
      batches: [{ objects: hiddenVars }],
    });
    console.log(`  ✓ Hidden (${hiddenVars.length} variations)`);
  }

  console.log('\n✅ Done!');
  console.log('   Live booking page: https://square.site/book/LVNM3Z4RVRWDK/the-mounting-man');
}

main().catch((err) => { console.error('\n❌', err.message); process.exit(1); });
