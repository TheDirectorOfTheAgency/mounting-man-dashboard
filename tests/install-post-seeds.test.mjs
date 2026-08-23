import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInstallPostSeeds,
  formatInstallPostSubtotal,
  formatInstallSeedBlocks,
} from '../lib/install-post-seeds.mjs';
import { isUnmountSeed, stripPublicUnitNumber } from '../lib/install-post-copy.mjs';

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

test('Frame / Gallery soundbar bracket does not classify a standard TV as Samsung Frame', () => {
  const seeds = buildInstallPostSeeds({
    customer: {
      address: {
        address_line_1: '450 Ford Road',
        locality: 'Minneapolis',
        administrative_district_level_1: 'Minnesota',
        postal_code: '55426',
      },
    },
    payment: { id: 'payment-soundbar-frame-bracket', order_id: 'order-soundbar-frame-bracket' },
    order: {},
    lineItems: [
      line('TV Installation', '75"', 22500),
      line('TV Mount / Bracket', 'Standard Tilt', 2500),
      line('Soundbar Mounting', 'Yes', 10000),
      line('Soundbar Bracket (Frame / Gallery)', 'Yes - Premium Bracket', 4800),
      line('Cord Concealing', 'In-Wall w/ Power Bridge (Drywall)', 35000),
    ],
  });

  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]['tv-size'], '75"');
  assert.equal(seeds[0]['tv-brand'], undefined);
  assert.equal(seeds[0]['gallery-style'], false);
  assert.equal(seeds[0]['soundbar-mounting'], true);
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

test('mixed gallery and standard TV lines keep gallery classification on only the gallery TV', () => {
  const seeds = buildInstallPostSeeds({
    customer,
    payment: { id: 'payment-mixed-gallery', order_id: 'order-mixed-gallery' },
    order: {},
    lineItems: [
      line('Frame / Gallery TV Installation', '55"', 25000),
      line('TV Installation', '75"', 22500),
    ],
  });

  assert.equal(seeds.length, 2);
  assert.equal(seeds[0]['tv-brand'], 'Samsung Frame');
  assert.equal(seeds[0]['gallery-style'], true);
  assert.equal(seeds[1]['tv-brand'], undefined);
  assert.equal(seeds[1]['gallery-style'], false);
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

test('fallback seed uses verified order subtotal before tax and tip when line items are unavailable', () => {
  const seeds = buildInstallPostSeeds({
    customer,
    payment: {
      id: 'payment-tip-fallback',
      order_id: 'order-tip-fallback',
      amount_money: { amount: 47250, currency: 'USD' },
      total_money: { amount: 57250, currency: 'USD' },
      tip_money: { amount: 10000, currency: 'USD' },
    },
    order: {
      total_money: { amount: 57250, currency: 'USD' },
      total_tax_money: { amount: 2250, currency: 'USD' },
      total_tip_money: { amount: 10000, currency: 'USD' },
    },
    amountCents: 47250,
    orderId: 'order-tip-fallback',
    paymentId: 'payment-tip-fallback',
    lineItems: [],
  });

  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].price, '$450');
  assert.notEqual(seeds[0].price, '$472.50');
  assert.notEqual(seeds[0].price, '$572.50');
});

test('fallback seed omits public price when no pre-tax order subtotal can be verified', () => {
  const [seed] = buildInstallPostSeeds({
    customer,
    payment: {
      id: 'payment-unverified-fallback',
      amount_money: { amount: 47250, currency: 'USD' },
      total_money: { amount: 57250, currency: 'USD' },
      tip_money: { amount: 10000, currency: 'USD' },
    },
    order: {},
    amountCents: 47250,
    lineItems: [],
  });

  assert.equal(seed.price, undefined);
});

test('Viking Drive-style payment publishes $150 line-item subtotal, not tax or tip', () => {
  const order = {
    total_money: { amount: 17077, currency: 'USD' },
    total_tax_money: { amount: 525, currency: 'USD' },
    total_tip_money: { amount: 1552, currency: 'USD' },
  };
  const seeds = buildInstallPostSeeds({
    customer,
    payment: {
      id: 'payment-viking',
      order_id: 'order-viking',
      amount_money: { amount: 15525, currency: 'USD' },
      total_money: { amount: 17077, currency: 'USD' },
      tip_money: { amount: 1552, currency: 'USD' },
    },
    order,
    amountCents: 15525,
    orderId: 'order-viking',
    paymentId: 'payment-viking',
    lineItems: [{
      name: 'TV Installation',
      variation_name: '55"',
      quantity: '1',
      base_price_money: { amount: 15000, currency: 'USD' },
      gross_sales_money: { amount: 15000, currency: 'USD' },
      total_tax_money: { amount: 525, currency: 'USD' },
      total_money: { amount: 15525, currency: 'USD' },
    }],
  });

  assert.equal(seeds[0].price, '$150');
  assert.equal(formatInstallPostSubtotal({ seeds, order }), '$150');
});

test('install post subtotal display sums seed prices instead of Square charged total', () => {
  const subtotal = formatInstallPostSubtotal({
    seeds: [{ price: '$400' }, { price: '$300' }],
    order: {
      total_money: { amount: 85000, currency: 'USD' },
      total_tax_money: { amount: 0, currency: 'USD' },
      total_tip_money: { amount: 15000, currency: 'USD' },
    },
  });

  assert.equal(subtotal, '$700');
  assert.notEqual(subtotal, '$850');
});

function unmountCustomer(overrides = {}) {
  return {
    address: {
      address_line_1: '86 2nd Street North Apt 4',
      locality: 'Oakdale',
      administrative_district_level_1: 'Minnesota',
      postal_code: '55128',
      ...overrides,
    },
  };
}

function assertUnmountCopy(seed) {
  assert.equal(isUnmountSeed(seed), true);
  assert.equal(seed['job-type'], 'unmount');
  assert.match(seed.title, /TV Unmounting/i);
  assert.doesNotMatch(seed.title, /\bTV Mounting\b/i);
  assert.doesNotMatch(seed.title, /TV Installation/i);
  assert.match(seed.slug, /tv-unmounting/);
  assert.doesNotMatch(seed.slug, /tv-mounting|tv-installation/);
  assert.match(seed['post-body'], /unmount|took down|take-down/i);
  assert.doesNotMatch(seed['post-body'], /We mounted this/i);
  assert.match(seed['post-body'], /professional TV mounting services/);
  assert.match(seed['post-body'], /themountingman\.com\/tv-mounting/);
  assert.match(seed['post-body'], /before shot/i);
  for (const field of ['title', 'slug', 'post-body', 'post-summary', 'street-name', 'local-reference']) {
    const value = String(seed[field] || '');
    assert.doesNotMatch(value, /\b(?:apt|apartment|unit|suite)\b/i, `${field} leaked a unit number: ${value}`);
    assert.doesNotMatch(value, /#\s*\w/, `${field} leaked a unit hash: ${value}`);
  }
}

test('an unmount line item is a first-class unmount seed, not a fake mount', () => {
  const seeds = buildInstallPostSeeds({
    customer: unmountCustomer(),
    payment: { id: 'payment-oakdale-unmount', order_id: 'order-oakdale-unmount' },
    order: {},
    lineItems: [
      line('TV Unmount', '86"', 12500),
    ],
  });

  assert.equal(seeds.length, 1);
  assertUnmountCopy(seeds[0]);
  assert.equal(seeds[0]['tv-size'], '86"');
  assert.equal(seeds[0].city, 'Oakdale');
  assert.equal(seeds[0]['street-name'], '2nd Street North');
  assert.match(seeds[0].title, /2nd Street North/);
  assert.match(seeds[0]['job-notes'], /TV Unmounting/);
  assert.equal(seeds[0]['wall-surface'], undefined);
  assert.doesNotMatch(seeds[0].title, /Drywall/);
  assert.doesNotMatch(String(seeds[0]['post-body']), /Drywall/);
});

test('dismount and take-down line names publish as TV unmounting', () => {
  for (const name of ['TV Dismount', 'TV Take Down', 'Taking Down']) {
    const [seed] = buildInstallPostSeeds({
      customer: unmountCustomer({ address_line_1: '200 2nd Street North Unit 12' }),
      payment: { id: `payment-${name}`, order_id: `order-${name}` },
      order: {},
      lineItems: [line(name, '75"', 10000)],
    });
    assertUnmountCopy(seed);
    assert.equal(seed['tv-size'], '75"');
    assert.equal(seed['street-name'], '2nd Street North');
  }
});

test('unmounting is not classified as a mount just because the word contains mounting', () => {
  const [seed] = buildInstallPostSeeds({
    customer: unmountCustomer(),
    payment: { id: 'payment-unmounting-word', order_id: 'order-unmounting-word' },
    order: {},
    lineItems: [line('TV Unmounting', '86"', 12500)],
  });
  assertUnmountCopy(seed);
  assert.doesNotMatch(seed['job-notes'], /TV Installation/);
});

test('unmount add-on on a mount stays on the mount and does not invent a second job', () => {
  const seeds = buildInstallPostSeeds({
    customer,
    payment: { id: 'payment-addon', order_id: 'order-addon' },
    order: {},
    lineItems: [
      line('TV Installation', '65"', 15000),
      line('Unmount Needed?', 'Unmount TV 65" or Under', 7500),
    ],
  });

  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]['job-type'], undefined);
  assert.equal(seeds[0].title, undefined);
  assert.equal(seeds[0]['tv-size'], '65"');
  assert.equal(seeds[0]['wall-surface'], 'Drywall');
  assert.match(seeds[0]['job-notes'], /TV Installation/);
  assert.equal(seeds[0].price, '$225');
});

test('a real second job on the same visit still suffixes as its own unmount seed', () => {
  const seeds = buildInstallPostSeeds({
    customer: unmountCustomer(),
    payment: { id: 'payment-two-jobs', order_id: 'order-two-jobs' },
    order: {},
    lineItems: [
      line('TV Installation', '65"', 15000),
      line('TV Unmount', '86"', 12500),
    ],
  });

  assert.equal(seeds.length, 2);
  assert.equal(seeds[0]['tv-size'], '65"');
  assert.equal(seeds[0]['job-type'], undefined);
  assert.equal(seeds[0].title, undefined);
  assert.equal(seeds[1]['seed-index'], 2);
  assert.equal(seeds[1]['seed-count'], 2);
  assertUnmountCopy(seeds[1]);
  assert.equal(seeds[1]['tv-size'], '86"');
  assert.match(seeds[1].slug, /-2$/);
});

test('unmount wall type stays Square-only and never invents Drywall', () => {
  const [plain] = buildInstallPostSeeds({
    customer: unmountCustomer(),
    payment: { id: 'payment-no-wall', order_id: 'order-no-wall' },
    order: {},
    lineItems: [line('TV Unmount', '86"', 12500)],
  });
  assert.equal(plain['wall-surface'], undefined);

  const [withWall] = buildInstallPostSeeds({
    customer: unmountCustomer(),
    payment: { id: 'payment-brick-wall', order_id: 'order-brick-wall' },
    order: {},
    lineItems: [
      line('TV Unmount', '86"', 12500),
      line('Wall Type', 'Brick'),
    ],
  });
  assert.equal(withWall['wall-surface'], 'Brick');
  assert.match(withWall['job-notes'], /Brick — Wall Type/);
});

test('unmount pages never emit a unit or apartment number', () => {
  const [seed] = buildInstallPostSeeds({
    customer: unmountCustomer({ address_line_1: '86 2nd Street North, Unit 4B' }),
    payment: { id: 'payment-unit', order_id: 'order-unit' },
    order: {},
    lineItems: [line('TV Unmount Service', '86"', 12500)],
  });
  assertUnmountCopy(seed);
  assert.equal(stripPublicUnitNumber('2nd Street North #12'), '2nd Street North');
  const blob = JSON.stringify(seed);
  assert.doesNotMatch(blob, /Unit 4B/i);
  assert.doesNotMatch(blob, /\bApt 4\b/i);
});

test('No Unmounting Needed does not create an unmount seed', () => {
  const seeds = buildInstallPostSeeds({
    customer,
    payment: { id: 'payment-no-unmount', order_id: 'order-no-unmount' },
    order: {},
    lineItems: [
      line('TV Installation', '55"', 15000),
      line('Unmount Needed?', 'No Unmounting Needed', 0),
    ],
  });
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]['job-type'], undefined);
  assert.equal(seeds[0]['tv-size'], '55"');
});
