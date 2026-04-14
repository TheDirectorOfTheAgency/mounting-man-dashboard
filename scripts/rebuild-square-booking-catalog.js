#!/usr/bin/env node
/**
 * rebuild-square-booking-catalog.js
 *
 * 1. Deletes the 20 wrong items created in the previous attempt
 * 2. Hides all old APPOINTMENTS_SERVICE items from the online booking widget
 *    (sets available_for_booking: false — does NOT break ZenBooker webhook,
 *     which creates bookings via API regardless of this flag)
 * 3. Creates 3 clean catalog categories + 4 service items
 *
 * Usage:
 *   SQUARE_TOKEN=$(grep NEXT_PUBLIC_SQUARE_ACCESS_TOKEN .env.local | cut -d= -f2) \
 *     node scripts/rebuild-square-booking-catalog.js
 */

const TOKEN = process.env.SQUARE_TOKEN;
if (!TOKEN) { console.error('SQUARE_TOKEN required'); process.exit(1); }

const BASE        = 'https://connect.squareup.com/v2';
const LOCATION_ID = 'LVNM3Z4RVRWDK';
const TEAM_MEMBERS = [
  'TMSiHOOr7RGdl2Ki', // Michael Wenzel
  'TMT84KWHegsrcWFB', // Garrison Gillard
  'TMY7unjtR-2XvVpg', // Marshall
  'TMmOwb6WS9cTplXu', // Crashon Traylor
];
const TAX_CC    = 'UYAEERACJE7W6FVVELNNF5GL'; // CC Processing Fee 3.5%

// Durations
const D60 = 3_600_000; // 60 min
const D1  =    60_000; // 1 min (cord concealing — add-on, minimal time impact)

// ─── Helper ──────────────────────────────────────────────────────────────────

async function sq(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-10-17',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok || data.errors?.length) {
    console.error('Square API error:', JSON.stringify(data.errors ?? data, null, 2));
    process.exit(1);
  }
  return data;
}

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── STEP 1: Delete the 20 wrong items ───────────────────────────────────────

async function deleteWrongItems() {
  console.log('\n── STEP 1: Finding and deleting wrong items (1st/2nd/3rd/4th TV)...');

  const wrongItemIds = [];
  for (const keyword of ['1st TV', '2nd TV', '3rd TV', '4th TV']) {
    const data = await sq('/catalog/search', 'POST', {
      object_types: ['ITEM'],
      query: { text_query: { keywords: [keyword] } },
    });
    const found = (data.objects ?? []).map(o => o.id);
    wrongItemIds.push(...found);
    await sleep(200);
  }

  const uniqueIds = [...new Set(wrongItemIds)];
  if (uniqueIds.length === 0) {
    console.log('  No wrong items found (already deleted or never created).');
    return;
  }

  console.log(`  Found ${uniqueIds.length} items to delete: ${uniqueIds.join(', ')}`);

  // Batch delete (up to 200 at a time)
  for (const batch of chunk(uniqueIds, 200)) {
    await sq('/catalog/batch-delete', 'POST', { object_ids: batch });
    await sleep(300);
  }
  console.log(`  ✓ Deleted ${uniqueIds.length} items.`);
}

// ─── STEP 2: Hide all old items from booking widget ───────────────────────────
// Sets available_for_booking: false on every variation of every old
// APPOINTMENTS_SERVICE item. This removes them from the customer-facing widget
// but does NOT affect ZenBooker webhook (which calls Bookings API directly).

// All variation IDs extracted from cached catalog snapshot (2026-02-23).
// These are the pre-existing items — everything except our new 4 items.
const OLD_VARIATION_IDS = [
  // Mount TV(s) Onto Normal Wall
  'MSEWPUMQAPKNXVCDFORQEZT4','IXC55U23GOFOBV4QKX25J5UG','YIEFTFIS4NDFW76SQLFQFRRP',
  'YNPKYJDD2Q4CA6SR73QC7QAW','TACDYFEPXTRYLK2OKWISCZZP','GAKCQWIEX4GC2TPJI33TQMWD',
  'Y2FGJ6BJK5I4MRBJTE6FY2XJ','FNVGIXRYY2FEEXVLLXJNX6J2','Z7NZW75OC7R4XM4AX5AWSZJR',
  'GISWJH3VSA4B64UW2IRJ7ACS',
  // Concealing Cords Behind Wall (old)
  'Z3VFNQG2B2P3YHJEVCRPA25Y','2MSGDUWYNKXDPE5ASDOY5VMP','NTUCCRY336EKXUJ64TKTB3CE',
  '3YA5OCUKT62WOPJ65WBUSZYT','SCZNVCMBWATWX5Q32VTL56OX',
  // Exterior Cord Concealing (old)
  'EDZUXBL35KCKIXYABD45EZIH','K7PIONW4FIKNB2XQHDUIGZKU','PJK5M3LGOF52PIU745TUBFXK',
  'AAJPHEPH4HRMXFJLHOPTHKV5',
  // Mount Soundbar
  'QE2L35UGBKKSE7H2RXQWRXOJ','TKA7RJLFZW4JXNZTAHLDTKTJ','KIQNKZPAXWHMXFQWWWGKIP5K',
  // Handyman Work ($150/hr old)
  'GNTJ47A6P5SGJNGA3MFUTNF7',
  // Special TV Mounting (old catch-all)
  'DAVYHUBAAAYLWSDNMVU7ZIT2','JQG3S3JWVSXYBITGE2CVJJFY','2RUUY5C3UM6P7FFRIWIGZ6VV',
  'EVFBJYSZZCDXAAUH5P2LQVN2','GL6SQ6EG5LLWHWM4MVZGYSA7','ZHUIVEVD2D7KHYG6O5S2R6QK',
  'S65JZ2FJ2MPGFKPXQM2LUJLF','UVMQIQKLWBZSZANWYA3GDRSD','S44MQYY5GZNNVY6LUBZ6S242',
  'IEELWIPUPD5D5UNIFWMQNZ5T','SB2WKA6VJTPUURRMJEPNQYZO','TMXQZIU4UPJ6P47LV4ISMZOV',
  'XN46W5VRXQF2HR4JLBP5U5OW','6V4LZSKCW2ZEAUCGN3HWM4AC','DUC4BK75EFUOFDPW7PQOX6GL',
  'SDA6XICYPAXVKIGGQ5YPNPA5','VN2S5JK3TC7KKPGILQEPSHVH',
  // Gaming Console
  'I325CHWLJYGSRNMDY6TM76RF',
  // Unmount TV
  'Z2PVGP2V2B7Q6QSG45RA7EHF','3YGHULE4WVYP55U2TTCKFJMA','AMJAZPZAV37TZR4SDP5RWMTT',
  // Video Wall
  'FQ5SHIRELD56T5JZEEN5PGCH',
  // Recessed Box
  '7L3H4YRBB55QCZMPBOIPYR53',
  // Samsung Frame Installation (old)
  'J5VRV7RJQK3N3JBWVLUTUGTL','3NUSWPK2M6CDAIKEAR3Z7I2Y','KYVHNHFOKLI6WB347H7ABEUG',
  'MHF6BQWNVGEFRL4RON6QJZ3B','S6Y5TM2V5HVCYC257YV4KJBF','ZSWDMGKHJNZHEY5TQU2HNNYL',
  // Hang Curtain Rod / Curtain Install
  'H2JM3WC2CXFPMVIZNFGLVOES','O3QB7A2O6NYYB3AOGK3MYLA7',
  // Mantel Mount Installation (old)
  'COJUJ7FGXPOHGCK5BSXE5BSK','TFKM6EDFK747TZQXVNRY6I5I','GJSQDBJMUO35O3LCW5E2DAIJ',
  'BLAUY7PCUVMCLYSACJG5NQYX',
  // General Mounting / Outlet / Storm Shell
  'J6I5W3D4F2EUHUKYHIA7B2SE','CGUI2YSAICV7PPUF4KPK3JU5','HOHISWDYWICVXD2C5LOI7SEW',
  // Surfaces (old)
  'V6FH6B2BS67I5SIQN44KLXWH','57SXSGSIUBQGZFNITOFNK6YH','K3TNI3OVGW6MVMUQ2JTUBHWQ',
  '6SNC2C4I7ZR4AHGKTYHMBFJS',
  // TV Mounting – Standard (ZenBooker webhook item)
  'ZRYVFRZ5UAQO75H5G2ZG6DU3','HMGSL34BHWHO7PAGLGM7DJJT','S4IRWJGHYNKWFQNPIKIWAH5B',
  'EVCVX2YUT54OBHUN673C6O3Z','OEIUGPSC7KNJZ7J6CC77CR5V','DJSMVMFZNNGCSWQOALO3QS5O',
  'LJGOOVS5KIIJR7M2I7PDR5RP','F7SWKR5TF3ECVVONYVGTFPI5','6XN6FG6NZHIGRB37O4536UP7',
  'T24XNGFILT5BRHCKKL7D6PAW',
  // TV Mounting – Samsung Frame (ZenBooker webhook item)
  'GMO57YE3IVREFPJYRGTY75KO','OMDLPMB7J5TSKHCY73OZZSOL','UFUF2QP3D54T7UKTYHZA25GD',
  'J34PODCQBCZ6Y32A6OKSSBNO','WGBLVCJSMZT4QEPBUAR34Z7W','5KNEPGCPHTDFG264XLVUY7S4',
  // TV Mounting – MantelMount (ZenBooker webhook item)
  'ODMRKTHXC3LGXFBPENJZQPCP','4CR3YWEXX2RBPSXXAYKURBMB','IT5W4UHB6OLYUEE6XI4346FQ',
  'MP6GKOABYJ5NYI66EL7VZBE4',
  // TV Unmount Service (ZenBooker webhook item)
  'PV7HL4JIHKYF2X4RFF4HXYS6','OZLOPB5BTXDKJZB7BXDKYCKR','PZMQG57A32MY54XF7EHJ3Q7T',
  // TV Mounting – Outdoor (ZenBooker webhook item)
  'X7IABYNS5VQRKBWTXGWGRPGQ',
  // TV Mounting – Special Situation (ZenBooker webhook item)
  'EE5SK4HAG4XOEEG5PLJJW5NG','YCSD2PKWUATKUZZIP4GHWGHP','EQBMVWE6FJFJHO3X5JALGLF7',
  'HUHIBLCIRCVL6WCCLMRV5APC','2PIQO6L3DPTUEC4UGLRLOVIW','NAGEB72SQIQ3TFOQQ7JTPD37',
  'MASBRGJC24DTBMVZX64KWHP5','LELAZHRFRWRH4X45DE6MSHZ4','AJF75HM2D2VTUIDS3QEJIEL3',
  // Handyman Work (ZenBooker webhook item)
  'O7KZ2JJUMZREVQJ6IDNSX66I',
  // General Mounting – Curtains (ZenBooker webhook item)
  '52U3P4QKMOZ3DVBR6NIQ6WVM',
  // Soundbar Mounting – Labor (ZenBooker webhook item)
  'HVB2FXY7J4DCLUFANSXPFD5K','7HOG7EI2MG6OILS3MAHXX25M',
  // Cord Concealing – In-Wall (ZenBooker webhook item)
  '3CARZMA4DWQROXSRPWJRCO3L','UNHHA5ESDCV7JUDH5EMHIFVZ','DM5VQTXV456O7QKI6KHVTDWG',
  'XYH7FSYYKZO6OF755ERB6BI3','WHX4TXZ5SZVO4NIDBMVUUY4C',
  // Cord Concealing – Exterior (ZenBooker webhook item)
  'IWQQAUULEAVV3AME5HSRB56Z','IBWPIY7NZVO4YLMB5Q5PNPKC',
  // Recessed Power Bridge (ZenBooker webhook item)
  'N4KBR74BGIRNIDYVSAI3YUNN',
  // Wall Surface Surcharge (ZenBooker webhook item)
  'VQOSFODLG5AGMD5XJ3OEWVJ3','IJI3Q75TILAX6EMMEUQZIHIE','OZCBEPL2WU6CUM5EOCU4ZYDC',
  '2RLFPQ6RSJXRZA2GXOAHYYTQ',
  // Bracket (Booking) items — ZenBooker webhook items
  'SRIT7AZ2GN2I5NVUFJTTANS3','HVVR4Q2NLHBUZCFK2V75GRM2','FQL3GBNHYWKQQ2EQXUYLZKNW',
  'BWTWSTU5RHFTIKHVVNDDG7C6','LAO6RXTQGV5HZBR3POAREOTH','JABXJZQ2573LGGUIVT3ZUUKK',
  'KJ3K557KLV7EO5KV5I2OHX7V','HS5VPELD5TQDZ4GWDLBQPSBM','HM6PCWKTECF2NTU53ZRFMWJT',
  // Fireplace + Wood Slat Surcharge (Booking) — ZenBooker webhook items
  'OSE2NKJVEXCBQATWPD2N6JJA','3ENU6PYKPKO3LS7J7SMBKZ5L',
];

async function hideOldItems() {
  console.log(`\n── STEP 2: Hiding ${OLD_VARIATION_IDS.length} old variations from booking widget...`);
  console.log('   (ZenBooker webhook is unaffected — it calls Bookings API directly)');

  // We need the parent item_id for each variation. Batch-retrieve the variations.
  // Square batch-retrieve accepts up to 1000 object IDs.
  const varChunks = chunk(OLD_VARIATION_IDS, 100);
  const allVarObjects = [];

  for (let i = 0; i < varChunks.length; i++) {
    const data = await sq('/catalog/batch-retrieve', 'POST', {
      object_ids: varChunks[i],
    });
    allVarObjects.push(...(data.objects ?? []));
    await sleep(200);
  }

  console.log(`  Retrieved ${allVarObjects.length} variation objects.`);

  // Build update payloads preserving all existing fields, just flipping available_for_booking
  const updates = allVarObjects.map(v => ({
    type: 'ITEM_VARIATION',
    id: v.id,
    version: v.version,
    present_at_location_ids: v.present_at_location_ids,
    present_at_all_locations: v.present_at_all_locations,
    item_variation_data: {
      ...v.item_variation_data,
      available_for_booking: false,
    },
  }));

  // Batch upsert in groups of 10
  const updateChunks = chunk(updates, 10);
  for (let i = 0; i < updateChunks.length; i++) {
    await sq('/catalog/batch-upsert', 'POST', {
      idempotency_key: `hide-old-items-v2-chunk-${i}`,
      batches: [{ objects: updateChunks[i] }],
    });
    if (i < updateChunks.length - 1) await sleep(300);
  }

  console.log(`  ✓ ${updates.length} variations hidden from booking widget.`);
}

// ─── STEP 3: Create clean categories + service items ─────────────────────────

// New service data
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

const FRAME_SIZES = [
  { name: '43"',        price: 25000 },
  { name: '50"',        price: 25000 },
  { name: '55"',        price: 25000 },
  { name: '65"',        price: 25000 },
  { name: '75"',        price: 35000 },
  { name: '85" / 86"', price: 40000 },
];

const MANTEL_SIZES = [
  { name: '65" or Under', price:  50000 },
  { name: '70" – 75"',   price:  60000 },
  { name: '76" – 80"',   price:  75000 },
  { name: '81" – 88"',   price: 100000 },
];

const CORD_OPTIONS = [
  { name: 'Exterior – Not Around Fireplace',  price:  7500 },
  { name: 'Exterior – Around Fireplace',      price: 12500 },
  { name: 'In-Wall (Drywall)',                price: 25000 },
  { name: 'In-Wall + New Outlet',             price: 25000 },
  { name: 'In-Wall (Brick / Fireplace Wall)', price: 35000 },
  { name: 'In-Wall with Soundbar Cords',      price: 30000 },
  { name: 'Through Existing Conduit',         price:  5000 },
];

let _uid = 0;
const uid = (p) => `#${p}_${++_uid}`;

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

function mkItem(idPrefix, name, categoryTempId, variations) {
  return {
    type: 'ITEM',
    id: uid(idPrefix),
    present_at_location_ids: [LOCATION_ID],
    item_data: {
      name,
      product_type: 'APPOINTMENTS_SERVICE',
      tax_ids: [TAX_CC],
      category_id: categoryTempId,
      variations,
    },
  };
}

async function createNewCatalog() {
  console.log('\n── STEP 3: Creating 3 categories + 4 service items...');

  // Category objects
  const catTvMount  = { type: 'CATEGORY', id: uid('cat'), category_data: { name: 'TV Mounting' } };
  const catFrame    = { type: 'CATEGORY', id: uid('cat'), category_data: { name: 'Samsung Frame TV' } };
  const catMantel   = { type: 'CATEGORY', id: uid('cat'), category_data: { name: 'MantelMount' } };

  // Service items
  const tvMount = mkItem('tv_mount', 'TV Wall Mount',
    catTvMount.id,
    TV_SIZES.map(s => mkVar('tv_mount', s.name, s.price, D60))
  );

  const cordConcealing = mkItem('cord', 'Cord Concealing',
    catTvMount.id,
    CORD_OPTIONS.map(c => mkVar('cord', c.name, c.price, D1))
  );

  const frameMounting = mkItem('frame', 'Samsung Frame TV Installation',
    catFrame.id,
    FRAME_SIZES.map(s => mkVar('frame', s.name, s.price, D60))
  );

  const mantelMounting = mkItem('mantel', 'MantelMount Installation',
    catMantel.id,
    MANTEL_SIZES.map(s => mkVar('mantel', s.name, s.price, D60))
  );

  const allObjects = [catTvMount, catFrame, catMantel, tvMount, cordConcealing, frameMounting, mantelMounting];

  await sq('/catalog/batch-upsert', 'POST', {
    idempotency_key: 'mm-clean-catalog-v1',
    batches: [{ objects: allObjects }],
  });

  console.log('  ✓ 3 categories created: TV Mounting, Samsung Frame TV, MantelMount');
  console.log('  ✓ 4 service items created: TV Wall Mount, Cord Concealing, Samsung Frame TV Installation, MantelMount Installation');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Rebuilding Square Appointments booking catalog...');

  await deleteWrongItems();
  await hideOldItems();
  await createNewCatalog();

  console.log('\n✅ Done! Your booking page now shows 4 clean services in 3 categories.');
  console.log('   Check: https://book.squareup.com/appointments/prr9s7gqigudfz/location/LVNM3Z4RVRWDK/services');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
