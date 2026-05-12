import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInstallPostSeeds,
  formatInstallSeedBlocks,
} from '../lib/install-post-seeds.mjs';

const customer = {
  address: {
    address_line_1: '4123 West Lake Harriet Parkway',
    locality: 'Minneapolis',
    administrative_district_level_1: 'Minnesota',
    postal_code: '55410',
  },
};

function line(name, variationName, amountCents = 0, quantity = '1') {
  return {
    name,
    variation_name: variationName,
    quantity,
    total_money: { amount: amountCents, currency: 'USD' },
  };
}

test('multi-TV Square job creates one seed JSON per TV and does not repeat the whole payment total', () => {
  const seeds = buildInstallPostSeeds({
    customer,
    payment: {
      id: 'payment-123',
      order_id: 'order-123',
      team_member_id: 'TMY7unjtR-2XvVpg',
    },
    order: {},
    amountCents: 69862,
    orderId: 'order-123',
    paymentId: 'payment-123',
    triggerStatus: 'Square webhook succeeded',
    triggerSourceCode: 'square-webhook',
    triggerEvent: 'payment.updated',
    lineItems: [
      line('TV Installation', '50"', 20000),
      line('TV Installation', '75"', 25000),
      line('TV Installation Over Fireplace', '65"', 24862),
      line('Wall Type', 'Brick'),
      line('Wall Type', 'Wood Slats'),
    ],
  });

  assert.equal(seeds.length, 3);
  assert.deepEqual(seeds.map((seed) => seed['tv-size']), ['50"', '75"', '65"']);
  assert.deepEqual(seeds.map((seed) => seed.price), ['$200', '$250', '$248.62']);
  assert.equal(seeds[0]['wall-surface'], 'Wood Slats');
  assert.equal(seeds[1]['wall-surface'], 'Wood Slats');
  assert.equal(seeds[2]['wall-surface'], 'Brick');
  assert.equal(seeds[2]['fireplace-type'], 'Fireplace');
  assert.equal(seeds[0]['performed-by'], 'Marshall');
  assert.equal(seeds[0]['street-name'], 'West Lake Harriet Parkway');
  assert.ok(seeds.every((seed) => seed.price !== '$698.62'));
});

test('add-ons grouped after a TV stay inside that TV seed and subtotal', () => {
  const seeds = buildInstallPostSeeds({
    customer,
    payment: { id: 'payment-456', order_id: 'order-456' },
    order: { created_by_team_member_id: 'TMY7unjtR-2XvVpg' },
    amountCents: 70500,
    orderId: 'order-456',
    paymentId: 'payment-456',
    triggerStatus: 'Square webhook succeeded',
    triggerSourceCode: 'square-webhook',
    triggerEvent: 'payment.updated',
    lineItems: [
      line('TV Installation Over Fireplace', '65"', 30000),
      line('Full Motion Bracket', '', 8000),
      line('Soundbar Mounting', '', 7500),
      line('Exterior Cord Concealing', '', 10000),
      line('Wall Type', 'Brick'),
      line('TV Installation', '75"', 15000),
    ],
  });

  assert.equal(seeds.length, 2);
  assert.equal(seeds[0]['tv-size'], '65"');
  assert.equal(seeds[0]['wall-surface'], 'Brick');
  assert.equal(seeds[0]['bracket-type'], 'Full Motion Bracket (Bought from us)');
  assert.equal(seeds[0]['soundbar-mounting'], true);
  assert.equal(seeds[0]['cable-management'], 'Exterior Concealment');
  assert.equal(seeds[0].price, '$555');
  assert.match(seeds[0]['job-notes'], /65" — TV Installation Over Fireplace/);
  assert.match(seeds[0]['job-notes'], /Soundbar Mounting/);
  assert.match(seeds[0]['job-notes'], /Exterior Concealment/);

  assert.equal(seeds[1]['tv-size'], '75"');
  assert.equal(seeds[1].price, '$150');
  assert.equal(seeds[1]['soundbar-mounting'], undefined);
});

test('formatted Discord copy exposes multiple copyable seed blocks', () => {
  const blocks = formatInstallSeedBlocks([
    { 'tv-size': '50"', 'wall-surface': 'Wood Slats', price: '$200' },
    { 'tv-size': '65"', 'wall-surface': 'Brick', 'fireplace-type': 'Fireplace', price: '$248.62' },
  ]);

  assert.match(blocks, /Suggested seed JSON 1 of 2/);
  assert.match(blocks, /Suggested seed JSON 2 of 2/);
  assert.equal((blocks.match(/```json/g) || []).length, 2);
});
