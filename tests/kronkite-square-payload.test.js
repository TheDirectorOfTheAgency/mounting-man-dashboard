import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildInstallFacts,
  buildInstallPostSeeds,
  parseTvSize,
} from '../lib/install-post-seeds.mjs';
import {
  buildKronkiteSquarePayload,
  notifyQInstallPost,
} from '../lib/notify-install-post.mjs';

const PLYMOUTH_LINE_ITEMS = [
  {
    name: '65" TV Installation',
    quantity: '1',
    base_price_money: { amount: 35000 },
    total_money: { amount: 35000 },
  },
  {
    name: '60" TV Installation',
    quantity: '1',
    base_price_money: { amount: 35000 },
    total_money: { amount: 35000 },
  },
];

const PLYMOUTH_CUSTOMER = {
  given_name: 'Plymouth',
  family_name: 'Homeowner',
  email_address: 'plymouth@example.com',
  phone_number: '+17635550199',
  address: {
    address_line_1: '18420 45th Avenue North',
    locality: 'Plymouth',
    administrative_district_level_1: 'MN',
    postal_code: '55446',
  },
};

function plymouthFacts(lineItems = PLYMOUTH_LINE_ITEMS) {
  return buildInstallFacts({
    lineItems,
    payment: { id: 'payment-plymouth', source_type: 'CARD' },
    order: { id: 'order-plymouth' },
    customer: PLYMOUTH_CUSTOMER,
  });
}

test('parseTvSize on a joined two-TV blob still returns only the first size', () => {
  assert.equal(parseTvSize('65" TV Installation | 60" TV Installation'), '65"');
});

test('buildKronkiteSquarePayload keeps both Plymouth TV lines and a count', () => {
  const facts = plymouthFacts();
  const seeds = buildInstallPostSeeds({
    lineItems: PLYMOUTH_LINE_ITEMS,
    payment: { id: 'payment-plymouth' },
    order: {},
    customer: PLYMOUTH_CUSTOMER,
    orderId: 'order-plymouth',
    paymentId: 'payment-plymouth',
  });

  assert.equal(facts.tvSize, '65"');
  assert.equal(seeds.length, 2);

  const payload = buildKronkiteSquarePayload({
    facts,
    seeds,
    lineItems: PLYMOUTH_LINE_ITEMS,
    payment: { id: 'payment-plymouth', source_type: 'CARD' },
    orderId: 'order-plymouth',
    eventType: 'invoice.payment_made',
    installSubtotal: '$700',
  });

  assert.equal(payload.tvSize, '65"');
  assert.equal(payload.tvCount, 2);
  assert.deepEqual(payload.tvSizes, ['65"', '60"']);
  assert.deepEqual(payload.tvLines, [
    { name: '65" TV Installation', size: '65"' },
    { name: '60" TV Installation', size: '60"' },
  ]);
  assert.deepEqual(payload.serviceLines, []);
  assert.equal(payload.city, 'Plymouth');
  assert.equal(payload.streetName, '45th Avenue North');
  assert.equal(payload.installationSubtotal, '$700');

  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    'Plymouth Homeowner',
    '18420',
    '55446',
    'plymouth@example.com',
    '+17635550199',
  ]) {
    assert.ok(!serialized.includes(forbidden), `sanitized payload leaked ${forbidden}`);
  }
});

test('buildKronkiteSquarePayload includes Square service lines beside both TVs', () => {
  const lineItems = [
    ...PLYMOUTH_LINE_ITEMS,
    {
      name: 'Wall Type',
      variation_name: 'Brick',
      quantity: '1',
      base_price_money: { amount: 5000 },
    },
    {
      name: 'Full Motion Bracket',
      quantity: '1',
      base_price_money: { amount: 10000 },
    },
  ];
  const facts = plymouthFacts(lineItems);
  const payload = buildKronkiteSquarePayload({
    facts,
    seeds: buildInstallPostSeeds({
      lineItems,
      payment: { id: 'payment-plymouth' },
      order: {},
      customer: PLYMOUTH_CUSTOMER,
    }),
    lineItems,
    payment: { id: 'payment-plymouth', source_type: 'CARD' },
    orderId: 'order-plymouth',
    installSubtotal: '$850',
  });

  assert.equal(payload.tvCount, 2);
  assert.deepEqual(payload.tvSizes, ['65"', '60"']);
  assert.ok(payload.serviceLines.some((line) => line.name.includes('Wall Type')));
  assert.ok(payload.serviceLines.some((line) => /full motion bracket/i.test(line.name)));
});

test('notify path sends one wake that still contains both TV lines', async () => {
  const posts = [];
  const result = await notifyQInstallPost(
    {
      orderId: 'order-plymouth',
      payment: { id: 'payment-plymouth', source_type: 'CARD' },
      invoice: { id: 'invoice-plymouth' },
      isInvoiceEvent: true,
      eventType: 'invoice.payment_made',
      firstName: 'Plymouth',
      lastName: 'Homeowner',
      customer: PLYMOUTH_CUSTOMER,
      amount: '700.00',
      amountCents: 70000,
    },
    {
      exists: async () => false,
      set: async () => true,
      sadd: async () => true,
      kronkiteUrl: 'https://kronkite.example/square-wake',
      kronkiteKey: 'kronkite-sender-key',
      httpClient: {
        async get() {
          return { data: { order: { id: 'order-plymouth', line_items: PLYMOUTH_LINE_ITEMS } } };
        },
        async post(url, body, config) {
          posts.push({ url, body, headers: config?.headers || {} });
          return { data: {} };
        },
      },
    },
  );

  assert.equal(result.skipped, null);
  assert.equal(result.seeds.length, 2);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://kronkite.example/square-wake');

  const payload = posts[0].body;
  assert.equal(payload.tvCount, 2);
  assert.deepEqual(payload.tvSizes, ['65"', '60"']);
  assert.deepEqual(payload.tvLines.map((line) => line.size), ['65"', '60"']);
  assert.ok(payload.tvLines.some((line) => line.name.includes('65"')));
  assert.ok(payload.tvLines.some((line) => line.name.includes('60"')));
  assert.equal(payload.tvSize, '65"');
  assert.equal(payload.city, 'Plymouth');
  assert.equal(payload.streetName, '45th Avenue North');
  assert.equal(payload, result.kronkitePayload);

  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    'Plymouth Homeowner',
    '18420',
    '55446',
    'plymouth@example.com',
    '+17635550199',
    'kronkite-sender-key',
  ]) {
    assert.ok(!serialized.includes(forbidden), `wake leaked ${forbidden}`);
  }
});
