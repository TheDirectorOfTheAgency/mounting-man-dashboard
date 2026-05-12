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
  assert.equal(seeds[1]['wall-surface'], 'Drywall');
  assert.match(seeds[1]['job-notes'], /Drywall — Wall Type/);
  assert.equal(seeds[2]['wall-surface'], 'Brick');
  assert.equal(seeds[2]['fireplace-type'], 'Fireplace');
  assert.equal(seeds[0]['performed-by'], 'Marshall');
  assert.equal(seeds[0]['street-name'], 'West Lake Harriet Parkway');
  assert.ok(seeds.every((seed) => seed.price !== '$698.62'));
});

test('line-item prices use subtotal before tax and tip, with drywall inferred when no surcharge exists', () => {
  const seeds = buildInstallPostSeeds({
    customer,
    payment: { id: 'payment-tax', order_id: 'order-tax' },
    order: {},
    lineItems: [
      {
        name: 'TV Installation',
        variation_name: '50"',
        quantity: '1',
        total_money: { amount: 13522 },
        total_tax_money: { amount: 457 },
      },
      {
        name: 'TV Installation',
        variation_name: '75"',
        quantity: '1',
        total_money: { amount: 20283 },
        total_tax_money: { amount: 686 },
      },
      {
        name: 'TV Installation Over Fireplace',
        variation_name: '65"',
        quantity: '1',
        total_money: { amount: 18029 },
        total_tax_money: { amount: 610 },
      },
      {
        name: 'Wall Type',
        variation_name: 'Brick',
        quantity: '1',
        total_money: { amount: 9015 },
        total_tax_money: { amount: 305 },
      },
      {
        name: 'Wall Type',
        variation_name: 'Wood Slats',
        quantity: '1',
        total_money: { amount: 9013 },
        total_tax_money: { amount: 304 },
      },
    ],
  });

  assert.deepEqual(seeds.map((seed) => seed['wall-surface']), ['Wood Slats', 'Drywall', 'Brick']);
  assert.deepEqual(seeds.map((seed) => seed.price), ['$217.74', '$195.97', '$261.29']);
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

test('same-count brackets after all TVs map by index instead of piling onto the last TV', () => {
  const seeds = buildInstallPostSeeds({
    customer,
    payment: { id: 'payment-789', order_id: 'order-789' },
    order: {},
    lineItems: [
      line('TV Installation', '55"', 18000),
      line('TV Installation', '65"', 22000),
      line('Fixed Bracket', '', 4000),
      line('Full Motion Bracket', '', 8000),
    ],
  });

  assert.equal(seeds.length, 2);
  assert.equal(seeds[0]['bracket-type'], 'Fixed Bracket (Bought from us)');
  assert.equal(seeds[0].price, '$220');
  assert.equal(seeds[1]['bracket-type'], 'Full Motion Bracket (Bought from us)');
  assert.equal(seeds[1].price, '$300');
});

test('single add-on after all TVs is omitted when it cannot be tied to a specific TV', () => {
  const seeds = buildInstallPostSeeds({
    customer,
    payment: { id: 'payment-999', order_id: 'order-999' },
    order: {},
    lineItems: [
      line('TV Installation', '55"', 18000),
      line('TV Installation', '65"', 22000),
      line('Soundbar Mounting', '', 7500),
    ],
  });

  assert.equal(seeds.length, 2);
  assert.equal(seeds[0]['soundbar-mounting'], undefined);
  assert.equal(seeds[1]['soundbar-mounting'], undefined);
  assert.equal(seeds[0].price, '$180');
  assert.equal(seeds[1].price, '$220');
});
