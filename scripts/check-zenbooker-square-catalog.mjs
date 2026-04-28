import fs from 'node:fs';
import { getMappedCatalogIds } from '../lib/zenbooker-square-mapper.mjs';

function loadLocalEnv() {
  if (!fs.existsSync('.env.local')) return;
  const lines = fs.readFileSync('.env.local', 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

loadLocalEnv();

const token = process.env.SQUARE_ACCESS_TOKEN || process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
if (!token) {
  console.error('Missing SQUARE_ACCESS_TOKEN or NEXT_PUBLIC_SQUARE_ACCESS_TOKEN');
  process.exit(1);
}

const ids = getMappedCatalogIds();
const response = await fetch('https://connect.squareup.com/v2/catalog/batch-retrieve', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Square-Version': '2024-01-18',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  body: JSON.stringify({ object_ids: ids, include_related_objects: true }),
});
const data = await response.json();
if (!response.ok) {
  console.error(JSON.stringify(data.errors || data, null, 2));
  process.exit(1);
}

const found = new Map((data.objects || []).map((object) => [object.id, object]));
let failures = 0;

for (const id of ids) {
  const object = found.get(id);
  if (!object) {
    console.error(`MISSING ${id}`);
    failures += 1;
    continue;
  }

  const variation = object.item_variation_data || {};
  if (object.type !== 'ITEM_VARIATION') {
    console.error(`NOT_VARIATION ${id} type=${object.type}`);
    failures += 1;
  }
  if (variation.available_for_booking !== true) {
    console.error(`NOT_BOOKABLE ${id} ${variation.name || ''}`);
    failures += 1;
  }
  if (!variation.service_duration) {
    console.error(`NO_DURATION ${id} ${variation.name || ''}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`Catalog check failed: ${failures} issue(s)`);
  process.exit(1);
}

console.log(`Catalog check passed: ${ids.length} mapped Square variation IDs are bookable and have durations.`);
