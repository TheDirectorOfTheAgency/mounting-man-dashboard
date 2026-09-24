import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  HOLD_REASONS,
  confidenceFactsFromSeed,
  evaluateInstallPostConfidence,
} from '../lib/install-post-confidence.mjs';
import {
  INSTALL_POST_LOCATIONS,
  installLocationSeedFields,
  lookupInstallLocation,
} from '../lib/install-post-locations.mjs';
import { transitionRecord } from '../lib/install-post-queue.mjs';
import { buildInstallPostSeeds } from '../lib/install-post-seeds.mjs';

const LOCATION_IDS_MD = readFileSync(
  new URL('../cloud/install-post-runner/references/location-ids.md', import.meta.url),
  'utf8',
);
const LOCATION_SLUGS = JSON.parse(readFileSync(
  new URL('../cloud/install-post-runner/references/location-slugs.json', import.meta.url),
  'utf8',
));

function referenceTables() {
  const ids = new Map();
  const metros = new Map();
  let section = '';
  for (const line of LOCATION_IDS_MD.split('\n')) {
    if (line.startsWith('## ')) section = line;
    if (!line.startsWith('|')) continue;
    const parts = line.replace(/^\||\|$/g, '').split('|').map((part) => part.trim());
    if (section.includes('Location ID') && /^[a-f0-9]{24}$/.test(parts[1])) ids.set(parts[0], parts[1]);
    if (section.includes('Metro Area') && parts[0].startsWith('**')) {
      const metro = parts[0].replace(/\*/g, '');
      for (const raw of parts[1].split(',')) metros.set(raw.trim().replace(/ only$/, ''), metro);
    }
  }
  return { ids, metros };
}

function squareSeed({ locality, state = 'MN', lineItems }) {
  const [seed] = buildInstallPostSeeds({
    customer: {
      address: {
        address_line_1: '4821 Elm Street',
        locality,
        administrative_district_level_1: state,
        postal_code: '55424',
      },
    },
    payment: { id: 'payment-loc' },
    order: {},
    orderId: 'order-loc',
    paymentId: 'payment-loc',
    lineItems: lineItems || [
      { name: 'TV Installation', variation_name: '65"', quantity: '1', total_money: { amount: 15000 } },
    ],
  });
  return seed;
}

test('every location-ids.md row matches the dashboard table, id and metro', () => {
  const { ids, metros } = referenceTables();
  assert.ok(ids.size > 90, 'reference table parsed');
  for (const [city, locationId] of ids) {
    const row = lookupInstallLocation(city);
    assert.ok(row, `${city} missing from dashboard table`);
    assert.equal(row.locationId, locationId, city);
    assert.equal(row.metroArea, metros.get(city) || '', city);
    assert.equal(row.state, 'MN', city);
  }
});

test('every location-slugs.json item id is in the dashboard table', () => {
  for (const [city, itemId] of Object.entries(LOCATION_SLUGS.item_ids)) {
    const row = lookupInstallLocation(city);
    assert.ok(row, `${city} missing from dashboard table`);
    assert.equal(row.locationId, itemId, city);
  }
});

test('every dashboard row comes from one of the two references', () => {
  const { ids } = referenceTables();
  for (const row of INSTALL_POST_LOCATIONS) {
    const referenceId = ids.get(row.city) || LOCATION_SLUGS.item_ids[row.city];
    assert.equal(row.locationId, referenceId, row.city);
  }
});

test('lookup normalizes Saint/St./case but never fuzzy-matches', () => {
  const stPaul = lookupInstallLocation('St. Paul').locationId;
  for (const spelling of ['st paul', 'Saint Paul', 'ST. PAUL', '  St.  Paul ']) {
    assert.equal(lookupInstallLocation(spelling)?.locationId, stPaul, spelling);
  }
  assert.notEqual(lookupInstallLocation('St. Paul Park')?.locationId, stPaul);
  for (const near of ['Paul', 'Edin', 'Minneapolis North', 'Twin Cities', '']) {
    assert.equal(lookupInstallLocation(near), null, near);
  }
});

test('known city seed carries location-id and metro-area', () => {
  const seed = squareSeed({ locality: 'Edina' });
  assert.equal(seed.city, 'Edina');
  assert.equal(seed['location-id'], lookupInstallLocation('Edina').locationId);
  assert.equal(seed['metro-area'], 'South Metro');
  assert.equal(evaluateInstallPostConfidence(confidenceFactsFromSeed(seed)).pass, true);
});

test('Saint Paul seed resolves to the St. Paul location', () => {
  const seed = squareSeed({ locality: 'Saint Paul' });
  assert.equal(seed['location-id'], lookupInstallLocation('St. Paul').locationId);
  assert.equal(seed['metro-area'], 'East Metro');
});

test('Houston-area seed carries location-id with no metro-area', () => {
  const seed = squareSeed({ locality: 'Katy', state: 'TX' });
  assert.equal(seed['location-id'], lookupInstallLocation('Katy').locationId);
  assert.equal(seed['metro-area'], undefined);
  assert.equal(evaluateInstallPostConfidence(confidenceFactsFromSeed(seed)).pass, true);
});

test('unknown city seed has no location fields and HOLDs as unknown_city', () => {
  const seed = squareSeed({ locality: 'Austin', state: 'TX' });
  assert.equal(seed.city, 'Austin');
  assert.equal(seed['location-id'], undefined);
  assert.equal(seed['metro-area'], undefined);
  const gate = evaluateInstallPostConfidence(confidenceFactsFromSeed(seed));
  assert.deepEqual(gate.reasons, [HOLD_REASONS.UNKNOWN_CITY]);
});

test('seed with no TV size HOLDs as missing_tv_size', () => {
  const seed = squareSeed({
    locality: 'Edina',
    lineItems: [{ name: 'TV Installation', quantity: '1', total_money: { amount: 15000 } }],
  });
  assert.equal(seed['tv-size'], undefined);
  const gate = evaluateInstallPostConfidence(confidenceFactsFromSeed(seed));
  assert.deepEqual(gate.reasons, [HOLD_REASONS.MISSING_TV_SIZE]);
});

test('correcting the city on the phone card refreshes location-id and metro-area', () => {
  const staged = transitionRecord({ jobId: 'job-loc', seed: { city: 'Twin Cities', 'tv-size': '65"' } }, {
    type: 'import',
  }).record;
  assert.equal(staged.seed['location-id'], undefined);

  const fixed = transitionRecord(staged, { type: 'correct', patch: { city: 'Woodbury' } }).record;
  assert.deepEqual(
    { id: fixed.seed['location-id'], metro: fixed.seed['metro-area'] },
    { id: lookupInstallLocation('Woodbury').locationId, metro: 'East Metro' },
  );

  const unknown = transitionRecord(fixed, { type: 'correct', patch: { city: 'Austin' } }).record;
  assert.equal(unknown.seed['location-id'], undefined);
  assert.equal(unknown.seed['metro-area'], undefined);

  const sizeOnly = transitionRecord(fixed, { type: 'correct', patch: { 'tv-size': '75"' } }).record;
  assert.equal(sizeOnly.seed['location-id'], fixed.seed['location-id']);
});

test('installLocationSeedFields returns blanks for an unknown city', () => {
  assert.deepEqual(installLocationSeedFields('Austin'), { 'location-id': '', 'metro-area': '' });
});
