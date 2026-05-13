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
  assert.deepEqual(seeds.map((seed) => seed.price), ['$200', '$225', '$250']);
  assert.equal(seeds[0]['wall-surface'], 'Wood Slats');
  assert.equal(seeds[1]['wall-surface'], 'Drywall');
  assert.match(seeds[1]['job-notes'], /Drywall — Wall Type/);
  assert.equal(seeds[2]['wall-surface'], 'Brick');
  assert.equal(seeds[2]['fireplace-type'], 'Fireplace');
  assert.equal(seeds[0]['performed-by'], 'Marshall');
  assert.equal(seeds[0]['street-name'], 'West Lake Harriet Parkway');
  assert.ok(seeds.every((seed) => seed.price !== '$698.62'));
});

test('line-item prices use Square gross line amounts, ignoring taxes, fees, tips, and discounts', () => {
  const seeds = buildInstallPostSeeds({
    customer,
    payment: { id: 'payment-tax', order_id: 'order-tax' },
    order: {},
    lineItems: [
      {
        name: 'TV Installation',
        variation_name: '50"',
        quantity: '1',
        gross_sales_money: { amount: 15000 },
        total_money: { amount: 13522 },
        total_tax_money: { amount: 457 },
        total_discount_money: { amount: 1935 },
        total_service_charge_money: { amount: 0 },
        total_card_surcharge_money: { amount: 0 },
        note: 'Wood Slats',
      },
      {
        name: 'TV Installation',
        variation_name: '75"',
        quantity: '1',
        gross_sales_money: { amount: 22500 },
        total_money: { amount: 20283 },
        total_tax_money: { amount: 686 },
        total_discount_money: { amount: 2903 },
        total_card_surcharge_money: { amount: 0 },
      },
      {
        name: 'TV Installation Over Fireplace',
        variation_name: '65"',
        quantity: '1',
        gross_sales_money: { amount: 20000 },
        total_money: { amount: 18029 },
        total_tax_money: { amount: 610 },
        total_discount_money: { amount: 2581 },
        total_card_surcharge_money: { amount: 0 },
        note: 'Brick',
      },
      {
        name: 'Wall Type',
        variation_name: 'Brick',
        quantity: '1',
        gross_sales_money: { amount: 10000 },
        total_money: { amount: 9015 },
        total_tax_money: { amount: 305 },
        total_discount_money: { amount: 1290 },
      },
      {
        name: 'Wall Type',
        variation_name: 'Wood Slats',
        quantity: '1',
        gross_sales_money: { amount: 10000 },
        total_money: { amount: 9013 },
        total_tax_money: { amount: 304 },
        total_discount_money: { amount: 1291 },
      },
    ],
  });

  assert.deepEqual(seeds.map((seed) => seed['wall-surface']), ['Wood Slats', 'Drywall', 'Brick']);
  assert.deepEqual(seeds.map((seed) => seed.price), ['$250', '$225', '$300']);
  assert.ok(seeds.every((seed) => !['$195.97', '$261.29'].includes(seed.price)));
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
  assert.equal(seeds[0].price, '$525');
  assert.match(seeds[0]['job-notes'], /65" — TV Installation Over Fireplace/);
  assert.match(seeds[0]['job-notes'], /Soundbar Mounting/);
  assert.match(seeds[0]['job-notes'], /Exterior Concealment/);

  assert.equal(seeds[1]['tv-size'], '75"');
  assert.equal(seeds[1].price, '$225');
  assert.equal(seeds[1]['soundbar-mounting'], undefined);
});

test('formatted Discord copy exposes multiple copyable seed blocks', () => {
  const blocks = formatInstallSeedBlocks([
    { 'tv-size': '50"', 'wall-surface': 'Wood Slats', price: '$200' },
    { 'tv-size': '65"', 'wall-surface': 'Brick', 'fireplace-type': 'Fireplace', price: '$250' },
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
  assert.equal(seeds[0].price, '$200');
  assert.equal(seeds[1]['bracket-type'], 'Full Motion Bracket (Bought from us)');
  assert.equal(seeds[1].price, '$250');
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
  assert.equal(seeds[0].price, '$150');
  assert.equal(seeds[1].price, '$150');
});

test('frame gallery multi-TV job assigns concealment by index and excludes extension cord supply', () => {
  const chisagoCustomer = {
    address: {
      address_line_1: '29330 Kenwood Way',
      locality: 'Chisago City',
      administrative_district_level_1: 'Minnesota',
      postal_code: '55013',
    },
  };

  const seeds = buildInstallPostSeeds({
    customer: chisagoCustomer,
    payment: {
      id: 'bFEWFQIA3Tu9WKnzoHtusKOyk3cZY',
      order_id: 'MxkwIXQPszMiRM9zTAKkzS2ZkNAZY',
      customer_id: 'HJM6W7HMKY79D2WWCP21W4NKWC',
      amount_money: { amount: 115522, currency: 'USD' },
      tip_money: { amount: 11552, currency: 'USD' },
    },
    order: {},
    orderId: 'MxkwIXQPszMiRM9zTAKkzS2ZkNAZY',
    paymentId: 'bFEWFQIA3Tu9WKnzoHtusKOyk3cZY',
    triggerStatus: 'Square webhook succeeded',
    triggerSourceCode: 'square-webhook',
    triggerEvent: 'payment.updated',
    lineItems: [
      line('Frame / Gallery TV Installation', '43"', 25875),
      line('Frame / Gallery TV Installation', '55"', 25875),
      line('Frame / Gallery TV Installation', '55"', 25875),
      line('Cord Concealing (Frame / Gallery)', 'In-Wall (Normal Wall)', 15525),
      line('Cord Concealing (Frame / Gallery)', 'In-Wall (Normal Wall)', 15525),
      line('Cord Concealing', 'Through Existing Conduit', 5175),
      line('15’ Extension Cord', '', 1672),
    ],
  });

  assert.equal(seeds.length, 3);
  assert.deepEqual(seeds.map((seed) => seed['tv-size']), ['43"', '55"', '55"']);
  assert.deepEqual(seeds.map((seed) => seed['cable-management']), [
    'In-Wall Concealment',
    'In-Wall Concealment',
    'Existing Conduit',
  ]);
  assert.deepEqual(seeds.map((seed) => seed.price), ['$400', '$400', '$300']);
  assert.ok(seeds.every((seed) => !seed['job-notes'].includes('Extension Cord')));
  assert.ok(seeds.every((seed) => seed.price !== '$1155.22'));
});

test('gallery seed uses Square line amount over fallback catalog price', () => {
  const seeds = buildInstallPostSeeds({
    customer: {
      address: {
        address_line_1: '123 Maple Plain Road',
        locality: 'Maple Plain',
        administrative_district_level_1: 'Minnesota',
        postal_code: '55359',
      },
    },
    payment: {
      id: 'payment-gallery-400',
      order_id: 'order-gallery-400',
      amount_money: { amount: 44000, currency: 'USD' },
      tip_money: { amount: 4000, currency: 'USD' },
    },
    order: {},
    orderId: 'order-gallery-400',
    paymentId: 'payment-gallery-400',
    triggerStatus: 'Square webhook succeeded',
    triggerSourceCode: 'square-webhook',
    triggerEvent: 'payment.updated',
    lineItems: [
      {
        name: 'Frame / Gallery TV Installation',
        variation_name: '75"',
        quantity: '1',
        gross_sales_money: { amount: 40000, currency: 'USD' },
        base_price_money: { amount: 40000, currency: 'USD' },
        total_money: { amount: 40000, currency: 'USD' },
      },
    ],
  });

  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]['tv-brand'], 'Samsung Frame');
  assert.equal(seeds[0]['gallery-style'], true);
  assert.equal(seeds[0].price, '$400');
  assert.notEqual(seeds[0].price, '$350');
});

test('mantelmount seed preserves model, category flag, and Square line amount', () => {
  const seeds = buildInstallPostSeeds({
    customer,
    payment: { id: 'payment-mm700', order_id: 'order-mm700' },
    order: {},
    orderId: 'order-mm700',
    paymentId: 'payment-mm700',
    triggerStatus: 'Square webhook succeeded',
    triggerSourceCode: 'square-webhook',
    triggerEvent: 'payment.updated',
    lineItems: [
      {
        name: 'MantelMount Installation',
        variation_name: 'MM700 75"',
        quantity: '1',
        gross_sales_money: { amount: 80000, currency: 'USD' },
        base_price_money: { amount: 80000, currency: 'USD' },
        total_money: { amount: 80000, currency: 'USD' },
      },
    ],
  });

  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]['tv-size'], '75"');
  assert.equal(seeds[0].mantelmount, true);
  assert.equal(seeds[0]['mount-type'], 'MantelMount MM700');
  assert.match(seeds[0]['job-notes'], /75" — MantelMount MM700 Installation/);
  assert.equal(seeds[0].price, '$800');
});
