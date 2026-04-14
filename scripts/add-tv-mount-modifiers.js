#!/usr/bin/env node
/**
 * add-tv-mount-modifiers.js
 *
 * Attaches 7 modifier groups to TV Wall Mount (replicates ZenBooker question flow):
 *   1. Wall Surface
 *   2. Going Above a Fireplace?
 *   3. TV Mounting Bracket
 *   4. Cord Concealing
 *   5. Unmount Needed?
 *   6. Soundbar Mounting
 *   7. Soundbar Bracket
 *
 * Samsung Frame gets 6 groups (no bracket — bracket comes with the TV).
 * MantelMount gets 4 groups (Cord, Unmount, Soundbar, Soundbar Bracket).
 * Standalone "Cord Concealing" service item is hidden (superseded by modifier).
 */

const https = require('https');

const TOKEN = process.env.SQUARE_TOKEN;
if (!TOKEN) { console.error('SQUARE_TOKEN not set'); process.exit(1); }

const TV_WALL_MOUNT_ITEM_ID = 'C4HUAFZSRIG6K45C7PWN6WBZ'; // created 2026-02-23

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

const money = (cents) => ({ amount: cents, currency: 'USD' });

// ── Modifier list definitions ─────────────────────────────────────────────────
const ML_DEFS = [
  {
    id: '#ml-surface',
    name: 'Wall Surface',
    modifiers: [
      { id: '#m-sur-drywall',   name: 'Normal Drywall',            price: 0      },
      { id: '#m-sur-plaster',   name: 'Plaster / Stucco',          price: 5000   },
      { id: '#m-sur-woodslat',  name: 'Wood Slats',                price: 10000  },
      { id: '#m-sur-brick',     name: 'Brick',                     price: 10000  },
      { id: '#m-sur-stone',     name: 'Stone / Faux Stone',        price: 15000  },
      { id: '#m-sur-tile',      name: 'Porcelain or Ceramic Tile', price: 15000  },
    ],
  },
  {
    id: '#ml-fireplace',
    name: 'Going Above a Fireplace?',
    modifiers: [
      { id: '#m-fp-no',  name: 'No',                     price: 0    },
      { id: '#m-fp-yes', name: 'Yes – Above a Fireplace', price: 5000 },
    ],
  },
  {
    id: '#ml-bracket',
    name: 'TV Mounting Bracket',
    modifiers: [
      { id: '#m-brk-own',      name: 'I Have My Own Bracket',       price: 0      },
      { id: '#m-brk-fixed',    name: 'Fixed Bracket',               price: 5000   },
      { id: '#m-brk-tilt',     name: 'Standard Tilt Bracket',       price: 7500   },
      { id: '#m-brk-fm',       name: 'Standard Full Motion Bracket',price: 10000  },
      { id: '#m-brk-flush',    name: 'Flush Mounting Bracket',      price: 13500  },
      { id: '#m-brk-corner',   name: 'Corner Mounting Bracket',     price: 10000  },
      { id: '#m-brk-4dtilt',   name: 'Premium 4D Tilt Bracket',     price: 10000  },
      { id: '#m-brk-premtilt', name: 'Premium Tilt Bracket',        price: 20000  },
      { id: '#m-brk-premfm',   name: 'Premium Full Motion Bracket', price: 20000  },
      { id: '#m-brk-100in',    name: '98" – 100" Tilt Bracket',     price: 25000  },
    ],
  },
  {
    id: '#ml-cord',
    name: 'Cord Concealing',
    modifiers: [
      { id: '#m-cord-none',     name: 'No Cord Concealing',                          price: 0      },
      { id: '#m-cord-conduit',  name: 'Through Existing Conduit',                    price: 5000   },
      { id: '#m-cord-ext',      name: 'Exterior Concealing',                         price: 7500   },
      { id: '#m-cord-extfp',    name: 'Exterior Around a Fireplace',                 price: 12500  },
      { id: '#m-cord-inwall',   name: 'In-Wall (Drywall)',                            price: 25000  },
      { id: '#m-cord-outlet',   name: 'In-Wall + New Outlet Behind TV',              price: 25000  },
      { id: '#m-cord-fpoutlet', name: 'In-Wall Around Fireplace + New Outlet',       price: 35000  },
      { id: '#m-cord-recessed', name: 'Recessed Box (Electrical)',                   price: 75000  },
      { id: '#m-cord-brick',    name: 'In-Wall Through Brick Fireplace',             price: 150000 },
    ],
  },
  {
    id: '#ml-unmount',
    name: 'Unmount Needed?',
    modifiers: [
      { id: '#m-um-no',  name: 'No Unmounting Needed',   price: 0     },
      { id: '#m-um-65',  name: 'Unmount TV 65" or Under', price: 7500  },
      { id: '#m-um-75',  name: 'Unmount TV 66" – 75"',   price: 10000 },
      { id: '#m-um-86',  name: 'Unmount TV 76" – 86"',   price: 12500 },
    ],
  },
  {
    id: '#ml-soundbar',
    name: 'Soundbar Mounting',
    modifiers: [
      { id: '#m-sb-no', name: 'No Soundbar',        price: 0     },
      { id: '#m-sb-1',  name: 'Mount 1 Soundbar',   price: 10000 },
      { id: '#m-sb-2',  name: 'Mount 2 Soundbars',  price: 20000 },
    ],
  },
  {
    id: '#ml-sbbracket',
    name: 'Soundbar Bracket',
    modifiers: [
      { id: '#m-sbb-no',   name: 'No Bracket / I Have My Own', price: 0     },
      { id: '#m-sbb-std',  name: 'Standard Soundbar Bracket',  price: 5000  },
      { id: '#m-sbb-prem', name: 'Premium Soundbar Bracket',   price: 10000 },
    ],
  },
];

// Helper: build a modifier_list_info attachment entry
function mlInfo(id) {
  return { modifier_list_id: id, enabled: true, min_selected_modifiers: -1, max_selected_modifiers: -1 };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Adding modifier groups to TV mounting services…\n');

  // ── STEP 1: Create all 7 modifier lists ───────────────────────────────────
  console.log('── STEP 1: Creating 7 modifier lists…');

  const mlObjects = ML_DEFS.map((ml) => ({
    type: 'MODIFIER_LIST',
    id: ml.id,
    modifier_list_data: {
      name: ml.name,
      selection_type: 'SINGLE',
      modifiers: ml.modifiers.map((m) => ({
        type: 'MODIFIER',
        id: m.id,
        modifier_data: {
          name: m.name,
          on_by_default: false,
          ...(m.price > 0 ? { price_money: money(m.price) } : {}),
        },
      })),
    },
  }));

  const mlResult = await api('POST', '/catalog/batch-upsert', {
    idempotency_key: 'ml-tv-mount-modifiers-2026-02-23-v1',
    batches: [{ objects: mlObjects }],
  });

  // tempId → actualId
  const idMap = {};
  for (const m of mlResult.id_mappings || []) {
    idMap[m.client_object_id] = m.object_id;
  }

  const mlIds = {
    surface:    idMap['#ml-surface'],
    fireplace:  idMap['#ml-fireplace'],
    bracket:    idMap['#ml-bracket'],
    cord:       idMap['#ml-cord'],
    unmount:    idMap['#ml-unmount'],
    soundbar:   idMap['#ml-soundbar'],
    sbbracket:  idMap['#ml-sbbracket'],
  };

  const missing = Object.entries(mlIds).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing modifier list IDs: ${missing.join(', ')}`);

  console.log(`  ✓ 7 modifier lists created`);
  Object.entries(mlIds).forEach(([k, v]) => console.log(`    ${k}: ${v}`));

  // ── STEP 2: Find Samsung Frame, MantelMount, and Cord Concealing items ────
  console.log('\n── STEP 2: Locating Samsung Frame, MantelMount, Cord Concealing items…');

  const [sfRes, mmRes, cordRes] = await Promise.all([
    api('POST', '/catalog/search-items', { text_filter: 'Samsung Frame TV Installation' }),
    api('POST', '/catalog/search-items', { text_filter: 'MantelMount Installation' }),
    api('POST', '/catalog/search-items', { text_filter: 'Cord Concealing' }),
  ]);

  const sfItem   = sfRes.items?.find(i => i.item_data.name === 'Samsung Frame TV Installation');
  const mmItem   = mmRes.items?.find(i => i.item_data.name === 'MantelMount Installation');
  const cordItem = cordRes.items?.find(i => i.item_data.name === 'Cord Concealing');

  if (!sfItem)   throw new Error('Samsung Frame TV Installation not found in catalog');
  if (!mmItem)   throw new Error('MantelMount Installation not found in catalog');

  console.log(`  Samsung Frame TV Installation: ${sfItem.id}`);
  console.log(`  MantelMount Installation:      ${mmItem.id}`);
  if (cordItem) console.log(`  Cord Concealing (to hide):     ${cordItem.id}`);

  // ── STEP 3: Fetch full current state of all items ─────────────────────────
  console.log('\n── STEP 3: Fetching current item state…');

  const idsToFetch = [TV_WALL_MOUNT_ITEM_ID, sfItem.id, mmItem.id];
  if (cordItem) idsToFetch.push(cordItem.id);

  const batchGet = await api('POST', '/catalog/batch-retrieve', {
    object_ids: idsToFetch,
    include_related_objects: false,
  });

  const byId = {};
  for (const obj of batchGet.objects || []) byId[obj.id] = obj;

  const tvFull   = byId[TV_WALL_MOUNT_ITEM_ID];
  const sfFull   = byId[sfItem.id];
  const mmFull   = byId[mmItem.id];

  if (!tvFull) throw new Error('Could not fetch TV Wall Mount item');
  if (!sfFull) throw new Error('Could not fetch Samsung Frame item');
  if (!mmFull) throw new Error('Could not fetch MantelMount item');

  console.log('  ✓ Fetched all items');

  // ── STEP 4: Attach modifier lists to each item ────────────────────────────
  console.log('\n── STEP 4: Attaching modifier lists…');

  // Build a clean item_data (no variations, no computed channels)
  function cleanItemData(full, modifierListInfoArray) {
    const { variations, channels, ...rest } = full.item_data;
    return {
      ...rest,
      skip_modifier_screen: false,
      modifier_list_info: modifierListInfoArray,
    };
  }

  const updateObjects = [
    // TV Wall Mount — all 7 modifier groups
    {
      type: 'ITEM',
      id: TV_WALL_MOUNT_ITEM_ID,
      version: tvFull.version,
      present_at_all_locations: tvFull.present_at_all_locations,
      present_at_location_ids: tvFull.present_at_location_ids,
      item_data: cleanItemData(tvFull, [
        mlInfo(mlIds.surface),
        mlInfo(mlIds.fireplace),
        mlInfo(mlIds.bracket),
        mlInfo(mlIds.cord),
        mlInfo(mlIds.unmount),
        mlInfo(mlIds.soundbar),
        mlInfo(mlIds.sbbracket),
      ]),
    },
    // Samsung Frame — 6 groups (no bracket — comes with TV)
    {
      type: 'ITEM',
      id: sfItem.id,
      version: sfFull.version,
      present_at_all_locations: sfFull.present_at_all_locations,
      present_at_location_ids: sfFull.present_at_location_ids,
      item_data: cleanItemData(sfFull, [
        mlInfo(mlIds.surface),
        mlInfo(mlIds.fireplace),
        mlInfo(mlIds.cord),
        mlInfo(mlIds.unmount),
        mlInfo(mlIds.soundbar),
        mlInfo(mlIds.sbbracket),
      ]),
    },
    // MantelMount — 4 groups (no surface/fireplace — always over fireplace, bracket included)
    {
      type: 'ITEM',
      id: mmItem.id,
      version: mmFull.version,
      present_at_all_locations: mmFull.present_at_all_locations,
      present_at_location_ids: mmFull.present_at_location_ids,
      item_data: cleanItemData(mmFull, [
        mlInfo(mlIds.cord),
        mlInfo(mlIds.unmount),
        mlInfo(mlIds.soundbar),
        mlInfo(mlIds.sbbracket),
      ]),
    },
  ];

  const attachResult = await api('POST', '/catalog/batch-upsert', {
    idempotency_key: 'attach-ml-to-items-2026-02-23-v1',
    batches: [{ objects: updateObjects }],
  });

  console.log('  ✓ TV Wall Mount         — 7 modifier groups attached');
  console.log('  ✓ Samsung Frame TV      — 6 modifier groups attached (no bracket)');
  console.log('  ✓ MantelMount           — 4 modifier groups attached');

  // ── STEP 5: Hide standalone Cord Concealing service item ──────────────────
  if (cordItem) {
    console.log('\n── STEP 5: Hiding standalone Cord Concealing service item…');

    const cordFull = byId[cordItem.id];
    const hiddenVars = (cordFull.item_data.variations || []).map((v) => ({
      type: 'ITEM_VARIATION',
      id: v.id,
      version: v.version,
      present_at_all_locations: v.present_at_all_locations,
      present_at_location_ids: v.present_at_location_ids,
      item_variation_data: {
        ...v.item_variation_data,
        available_for_booking: false,
      },
    }));

    await api('POST', '/catalog/batch-upsert', {
      idempotency_key: 'hide-cord-concealing-service-2026-02-23-v1',
      batches: [{ objects: hiddenVars }],
    });

    console.log(`  ✓ Cord Concealing service item hidden from booking widget (${hiddenVars.length} variations)`);
  } else {
    console.log('\n── STEP 5: Cord Concealing standalone item not found (already hidden or deleted — OK)');
  }

  console.log('\n✅ Done!');
  console.log('   Check the live booking page:');
  console.log('   https://square.site/book/LVNM3Z4RVRWDK/the-mounting-man');
}

main().catch((err) => { console.error('\n❌ Error:', err.message); process.exit(1); });
