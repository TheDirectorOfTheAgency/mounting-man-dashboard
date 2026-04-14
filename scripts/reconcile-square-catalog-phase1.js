#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const BASE = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-10-17';
const TAX_CC = 'UYAEERACJE7W6FVVELNNF5GL';
const TAX_SALES = 'T2SCKRERNHFSIU7S4TBXVYEE';
const DRY_RUN = process.argv.includes('--dry-run');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!process.env[key]) {
      process.env[key] = rest.join('=');
    }
  }
}

loadEnvFile(path.join(process.cwd(), '.env.local'));

const TOKEN = process.env.SQUARE_TOKEN || process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('SQUARE_TOKEN or NEXT_PUBLIC_SQUARE_ACCESS_TOKEN is required');
  process.exit(1);
}

async function sq(pathname, method = 'GET', body = null) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json();
  if (!response.ok || data.errors?.length) {
    throw new Error(`Square API error for ${pathname}: ${JSON.stringify(data.errors || data, null, 2)}`);
  }
  return data;
}

async function fetchAllItems() {
  const objects = [];
  const relatedObjects = [];
  let cursor = null;

  do {
    const payload = {
      object_types: ['ITEM'],
      include_related_objects: true,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    };
    const data = await sq('/catalog/search', 'POST', payload);
    objects.push(...(data.objects || []));
    relatedObjects.push(...(data.related_objects || []));
    cursor = data.cursor || null;
  } while (cursor);

  return { objects, relatedObjects };
}

function buildMaps(objects) {
  const itemsById = new Map();
  const variationsById = new Map();

  for (const item of objects) {
    itemsById.set(item.id, item);
    for (const variation of item?.item_data?.variations || []) {
      variationsById.set(variation.id, variation);
    }
  }

  return { itemsById, variationsById };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeItemUpdate(item, mutate) {
  const updated = clone(item);
  mutate(updated);
  return updated;
}

function makeVariationUpdate(variation, mutate) {
  const updated = clone(variation);
  mutate(updated);
  return updated;
}

function makeNewVariation(tempId, itemId, sourceVariation, { name, amount, ordinal }) {
  const source = clone(sourceVariation.item_variation_data);
  return {
    type: 'ITEM_VARIATION',
    id: tempId,
    present_at_all_locations: true,
    item_variation_data: {
      ...source,
      item_id: itemId,
      name,
      ordinal,
      pricing_type: 'FIXED_PRICING',
      price_money: {
        amount,
        currency: 'USD',
      },
      available_for_booking: true,
    },
  };
}

function makeNewItem(tempId, name, taxIds, sourceVariation, variations) {
  return {
    type: 'ITEM',
    id: tempId,
    present_at_all_locations: true,
    item_data: {
      name,
      product_type: 'APPOINTMENTS_SERVICE',
      is_taxable: true,
      tax_ids: taxIds,
      skip_modifier_screen: false,
      ecom_visibility: 'VISIBLE',
      variations: variations.map((variation, index) => ({
        type: 'ITEM_VARIATION',
        id: `#var_${tempId.replace('#', '')}_${index + 1}`,
        item_variation_data: {
          ...clone(sourceVariation.item_variation_data),
          item_id: tempId,
          name: variation.name,
          ordinal: index,
          pricing_type: 'FIXED_PRICING',
          price_money: { amount: variation.amount, currency: 'USD' },
          available_for_booking: true,
        },
      })),
    },
  };
}

function queueItemUpdate(map, item, mutate) {
  const existing = map.get(item.id) || clone(item);
  mutate(existing);
  map.set(item.id, existing);
}

function queueVariationUpdate(map, variation, mutate) {
  const existing = map.get(variation.id) || clone(variation);
  mutate(existing);
  map.set(variation.id, existing);
}

async function upsertObjects(objects, label) {
  if (objects.length === 0) return;

  if (DRY_RUN) {
    console.log(`DRY RUN: would upsert ${objects.length} object(s) for ${label}`);
    return;
  }

  await sq('/catalog/batch-upsert', 'POST', {
    idempotency_key: `mm-catalog-phase1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    batches: [{ objects }],
  });
  console.log(`Updated ${objects.length} object(s): ${label}`);
}

async function main() {
  const snapshot = await fetchAllItems();
  const backupPath = '/tmp/mm_square_catalog_backup_before_phase1_2026-03-15.json';
  fs.writeFileSync(backupPath, JSON.stringify(snapshot, null, 2));
  console.log(`Backed up live catalog snapshot to ${backupPath}`);

  const { itemsById, variationsById } = buildMaps(snapshot.objects);
  const itemUpdates = new Map();
  const variationUpdates = new Map();
  const createObjects = [];

  const itemRenames = new Map([
    ['FHZANUTIBZHNTOIJPAEM526L', 'TV Installation'],
    ['2CDBRPVTCDNZSU3KXYDH7FT6', 'Frame / Gallery TV Installation'],
    ['4DYXFZHFPZG3IHABDJMHMRXX', 'MantelMount Installation'],
    ['TFMJ3NPQS5HO7MKRBUL6H576', 'Outdoor TV Installation'],
    ['EGAEWO6HZTLTN2O22WMX3K43', 'Special TV Installation'],
    ['5LMQCZPBPRJJX4M52KRE7KWR', 'TV Unmount'],
    ['PFVBZCBVBGMAGZDGJLHVQET4', 'Soundbar Mounting (Labor Only)'],
    ['CDMC4GCCSNNMMC3SXUQJWKYK', 'ZZ Legacy Sync - Wall Type'],
    ['WTOJ5OLNW7MULFPYRNQW56F3', 'ZZ Legacy Sync - Cord Concealing - In-Wall'],
    ['M6VI2UEOR462UOYAR43ZZZCJ', 'ZZ Legacy Sync - Cord Concealing - Exterior'],
    ['BJKRV645JPTTHROHCYQNKP64', 'ZZ Legacy Sync - Cord Concealing - Recessed Power Bridge'],
    ['5CLTNDTZMQZ7ITPWOBQZADOS', 'ZZ Legacy Sync - Above Fireplace'],
    ['57XGNN7MD55Y262FR3YS6UQH', 'Wall Type'],
    ['HWQSCHXQE7MEJTRALGTEUNBQ', 'ZZ Legacy Sync - Wall Type (MantelMount)'],
    ['LPNVDFYEKC6GIMTUSF76PNMY', 'Wall Type (Frame / Gallery)'],
    ['Q4PYMLGUOUSKIMV7EXU5RAX6', 'Soundbar Bracket'],
    ['LGQIGIEX6QJFCKQUPTJ4QCCS', 'Soundbar Bracket (Frame / Gallery)'],
    ['NGUJAMMDSKZZOYBFSOZZXSL5', 'Soundbar Mounting'],
    ['RTHC3CZRM2VN7SR7SRMFPJKF', 'Cord Concealing'],
    ['XBDG52GXX7U5XAHDBEFY5YLD', 'ZZ Legacy Sync - Cord Concealing (MantelMount)'],
    ['UZRIVK7LFVI6STUNZIWFZCF3', 'Cord Concealing (Frame / Gallery)'],
    ['YOKN7KJD6VKTTRF6KUBOCWCK', 'ZZ Legacy Sync - TV Unmount Add-On'],
    ['4WOKTWSZMPOKFRKJ3NCTUIII', 'Handyman Work'],
    ['PEKGKWPWHP3SGZFR2RHNUPB6', 'General Mounting'],
  ]);

  for (const [id, name] of itemRenames) {
    const item = itemsById.get(id);
    if (!item) throw new Error(`Missing item ${id}`);
    queueItemUpdate(itemUpdates, item, (updated) => {
      updated.item_data.name = name;
    });
  }

  const taxFixItems = [
    'Q4PYMLGUOUSKIMV7EXU5RAX6',
    'LGQIGIEX6QJFCKQUPTJ4QCCS',
  ];
  for (const id of taxFixItems) {
    const item = itemsById.get(id);
    queueItemUpdate(itemUpdates, item, (updated) => {
      updated.item_data.tax_ids = [TAX_CC, TAX_SALES];
      updated.item_data.is_taxable = true;
    });
  }

  const variationRenames = new Map([
    ['ZRYVFRZ5UAQO75H5G2ZG6DU3', 'Under 50"'],
    ['HMGSL34BHWHO7PAGLGM7DJJT', '50"'],
    ['S4IRWJGHYNKWFQNPIKIWAH5B', '55"'],
    ['EVCVX2YUT54OBHUN673C6O3Z', '60"'],
    ['OEIUGPSC7KNJZ7J6CC77CR5V', '65"'],
    ['DJSMVMFZNNGCSWQOALO3QS5O', '70"'],
    ['LJGOOVS5KIIJR7M2I7PDR5RP', '75"'],
    ['F7SWKR5TF3ECVVONYVGTFPI5', '80"'],
    ['6XN6FG6NZHIGRB37O4536UP7', '85" / 86"'],
    ['T24XNGFILT5BRHCKKL7D6PAW', '87" - 100"'],
    ['GMO57YE3IVREFPJYRGTY75KO', '43"'],
    ['OMDLPMB7J5TSKHCY73OZZSOL', '50"'],
    ['UFUF2QP3D54T7UKTYHZA25GD', '55"'],
    ['J34PODCQBCZ6Y32A6OKSSBNO', '65"'],
    ['WGBLVCJSMZT4QEPBUAR34Z7W', '75"'],
    ['5KNEPGCPHTDFG264XLVUY7S4', '85" / 86"'],
    ['ODMRKTHXC3LGXFBPENJZQPCP', '65" or Under'],
    ['4CR3YWEXX2RBPSXXAYKURBMB', '70" - 75"'],
    ['IT5W4UHB6OLYUEE6XI4346FQ', '76" - 80"'],
    ['MP6GKOABYJ5NYI66EL7VZBE4', '81" - 88"'],
    ['OZLOPB5BTXDKJZB7BXDKYCKR', '66" - 75"'],
    ['PZMQG57A32MY54XF7EHJ3Q7T', '76" - 86"'],
    ['VQOSFODLG5AGMD5XJ3OEWVJ3', 'Plaster / Stucco'],
    ['OZCBEPL2WU6CUM5EOCU4ZYDC', 'Stone / Faux Brick'],
    ['2RLFPQ6RSJXRZA2GXOAHYYTQ', 'Tile / Porcelain / Ceramic'],
    ['3CARZMA4DWQROXSRPWJRCO3L', 'In-Wall (Drywall)'],
    ['UNHHA5ESDCV7JUDH5EMHIFVZ', 'In-Wall + New Outlet'],
    ['DM5VQTXV456O7QKI6KHVTDWG', 'In-Wall Through Fireplace'],
    ['XYH7FSYYKZO6OF755ERB6BI3', 'In-Wall With Soundbar Cords'],
    ['WHX4TXZ5SZVO4NIDBMVUUY4C', 'Through Existing Conduit'],
    ['IWQQAUULEAVV3AME5HSRB56Z', 'Exterior'],
    ['IBWPIY7NZVO4YLMB5Q5PNPKC', 'Exterior Around Fireplace'],
    ['N4KBR74BGIRNIDYVSAI3YUNN', 'Recessed Power Bridge'],
    ['IOXKOMS7T56KQD5O6MSUV5DF', 'Drywall / Normal Wall'],
    ['UH4KYZ5VHDNPV2V57VE4J2GC', 'Plaster / Stucco'],
    ['AKARFSUH7CSBYJLNNZGWCRRR', 'Brick'],
    ['6X7VHWLJLHGNEJKIYFBQ2M4M', 'Stone / Faux Brick'],
    ['FIBV6ASXYHJFR7T4PS62QYYQ', 'Tile / Porcelain / Ceramic'],
    ['L3XWVVLMT2UUHTOD4DPBXEKU', 'No'],
    ['I5WNVCE7GOGWNIOPNLI3C7W2', 'Yes'],
    ['ZAUCONJZQCWTC74GV5YGX7K5', 'No'],
    ['3Q23ZPDYQLJYLM6NVGBUVG6K', 'Yes - Standard Bracket'],
    ['ARXV4EQUKYK7CYK4ARTHIDHN', 'Yes - Premium Bracket'],
    ['SSA4L7DQ757QOSHOWMN22GF5', 'No'],
    ['AUTBSM7QKINDZEXJIXZZDFDJ', 'Yes - 65" or Under'],
    ['CJ5IP2HBPSWK2626BEDFRUWZ', 'Yes - 66" - 86"'],
    ['VRBE23QUVCMPLWMAMBV4DIWD', 'No'],
    ['UXQ6MF63SGKNPKXJHOH6TVNC', 'Through Existing Conduit'],
    ['NVQPYMKHEFSM45FIJTXBDP2Q', 'Exterior'],
    ['VYDX7EYT4TTEKELJVHT65FLW', 'Exterior Around Fireplace'],
    ['MRYFWOHANW7NL4XGMV5SMIOG', 'In-Wall (Drywall)'],
    ['BBKPIPW7ZL7O2XMO25Q535LV', 'In-Wall + New Outlet'],
    ['HWHVY252QHA5JZJI5NMP5WU2', 'In-Wall With Soundbar Cords'],
    ['MYOL5QYOWAVRKNE77FAHN2CG', 'In-Wall Through Fireplace'],
    ['7DVPGCFPKYANLK7ZHDZLKIEH', 'Recessed Power Bridge'],
    ['FYATSSQNW45NBUZSYUBRONCG', 'Drywall / Normal Wall'],
    ['NXNCQJK2EUBQNHK5YBDYGPTH', 'Drywall / Normal Wall'],
    ['SWNAVW6UAOKR2DV4FBEJRUOT', 'Yes'],
    ['QNOTHYFNCQDYMBFGUSTLFG5I', 'No'],
    ['GXXNF5LYKK3XFUBNJRNSG3PX', 'Yes - Standard Bracket'],
    ['FOHMU7CUZEULKPW63KMVEW6C', 'Yes - Premium Bracket'],
  ]);

  for (const [id, name] of variationRenames) {
    const variation = variationsById.get(id);
    if (!variation) throw new Error(`Missing variation ${id}`);
    queueVariationUpdate(variationUpdates, variation, (updated) => {
      updated.item_variation_data.name = name;
    });
  }

  const variationPriceFixes = new Map([
    ['AKARFSUH7CSBYJLNNZGWCRRR', 10000],
    ['6X7VHWLJLHGNEJKIYFBQ2M4M', 15000],
  ]);
  for (const [id, amount] of variationPriceFixes) {
    const variation = variationsById.get(id);
    queueVariationUpdate(variationUpdates, variation, (updated) => {
      updated.item_variation_data.price_money.amount = amount;
      updated.item_variation_data.available_for_booking = true;
    });
  }

  const tileVariation = variationsById.get('FIBV6ASXYHJFR7T4PS62QYYQ');
  queueVariationUpdate(variationUpdates, tileVariation, (updated) => {
    updated.item_variation_data.available_for_booking = true;
    updated.item_variation_data.price_money.amount = 15000;
  });

  const genericSurfaceItem = itemsById.get('57XGNN7MD55Y262FR3YS6UQH');
  const hasWoodSlatsVariation = (genericSurfaceItem?.item_data?.variations || []).some((variation) => (
    variation.item_variation_data?.name === 'Wood Slats'
  ));
  if (!hasWoodSlatsVariation) {
    const helperSourceVariation = variationsById.get('IOXKOMS7T56KQD5O6MSUV5DF');
    createObjects.push(makeNewVariation('#wall_surface_wood_slats', '57XGNN7MD55Y262FR3YS6UQH', helperSourceVariation, {
      name: 'Wood Slats',
      amount: 10000,
      ordinal: 5,
    }));
  }

  const hasWallMountHelper = snapshot.objects.some((item) => (
    !item.item_data?.is_archived && item.item_data?.name === 'TV Mount / Bracket'
  ));
  if (!hasWallMountHelper) {
    const bracketSourceVariation = variationsById.get('MSYLXUIRC2FE6DNPMTYEGNMX');
    createObjects.push(makeNewItem('#wall_mount_helper', 'TV Mount / Bracket', [TAX_CC, TAX_SALES], bracketSourceVariation, [
      { name: 'No - I Already Have One', amount: 0 },
      { name: 'Fixed', amount: 5000 },
      { name: 'Standard Tilt', amount: 7500 },
      { name: 'Standard Full Motion', amount: 10000 },
      { name: 'Flush', amount: 13500 },
      { name: 'Premium 4D Tilt', amount: 10000 },
      { name: 'Premium Tilt', amount: 20000 },
      { name: 'Premium Full Motion', amount: 20000 },
    ]));
  }

  const archiveItemIds = [
    'V4WHF7B4NI7PZ2JPWRPZED4B',
    'C4HUAFZSRIG6K45C7PWN6WBZ',
    'XWYBPZE4LFNTDLTT24QMGJGT',
    'QT2VN7OL2Y34P44EOPM6S4VY',
    'IV6XZIAO5XLXVANQLSLTW2UG',
    'WVAJZWV33OU2SQNHIWI6SFUL',
    '4B7ZEZGIX3J6OWAXGQTW446M',
    'V7TMGD7UV34IBCFAGLBU4DF3',
    'TODNPCYXIY5J2LZX6BVVZB2U',
    '47JMWM7X66CBGS7XBJ2J2DLA',
    'SGYOIX74MYPC4J6IQT46QMYA',
    'TB24EMHG76SPXRED5SNDF5JB',
    'G4OZOJB7TNXOHYAQPMIVMJH5',
    'GYGBZ2GNGW3UCJ33GU5ZA2LI',
    'UFUGO7ZN74XASJ5TGTNFLLJA',
    'MLOVL3XBV4G5PJPZP7G3LV74',
    'QFNBZDJ7OQWNDOQK7QXFJBX7',
    'YOKN7KJD6VKTTRF6KUBOCWCK',
    'HWQSCHXQE7MEJTRALGTEUNBQ',
    'XBDG52GXX7U5XAHDBEFY5YLD',
  ];
  for (const id of archiveItemIds) {
    const item = itemsById.get(id);
    if (!item) continue;
    queueItemUpdate(itemUpdates, item, (updated) => {
      updated.item_data.is_archived = true;
    });
  }

  await upsertObjects([...itemUpdates.values()], 'item renames / tax fixes / archives');
  await upsertObjects([...variationUpdates.values()], 'variation renames / pricing fixes');
  await upsertObjects(createObjects, 'new helper items / variations');

  console.log(DRY_RUN ? 'Dry run complete.' : 'Phase 1 Square catalog reconciliation complete.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
