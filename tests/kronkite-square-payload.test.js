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
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]['seed-index'], 1);
  assert.equal(seeds[0]['seed-count'], 1);
  assert.equal(seeds[0]['source-order-id'], 'order-plymouth');
  assert.equal(seeds[0]['source-payment-id'], 'payment-plymouth');

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
  assert.equal(result.seeds.length, 1);
  assert.equal(result.seeds[0]['seed-count'], 1);
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

test('invoice notify fills paymentId from order tenders when the webhook omitted it', async () => {
  const pendingWrites = [];
  const result = await notifyQInstallPost(
    {
      orderId: 'order-invoice',
      payment: {},
      invoice: { id: 'invoice-bloomington', order_id: 'order-invoice' },
      isInvoiceEvent: true,
      eventType: 'invoice.payment_made',
      firstName: 'Bloomington',
      lastName: 'Homeowner',
      customer: {
        ...PLYMOUTH_CUSTOMER,
        address: {
          address_line_1: '8600 International Drive, Bloomington, MN 55425, USA',
          locality: 'Twin Cities',
        },
      },
      amount: '350.00',
      amountCents: 35000,
    },
    {
      exists: async () => false,
      set: async (key, value) => {
        pendingWrites.push({ key, value });
        return true;
      },
      sadd: async () => true,
      kronkiteUrl: 'https://kronkite.example/square-wake',
      kronkiteKey: 'kronkite-sender-key',
      httpClient: {
        async get() {
          return {
            data: {
              order: {
                id: 'order-invoice',
                line_items: PLYMOUTH_LINE_ITEMS,
                tenders: [
                  { id: 'tender-1', type: 'CARD', payment_id: 'pay_from_tender' },
                ],
              },
            },
          };
        },
        async post() {
          return { data: {} };
        },
      },
    },
  );

  assert.equal(result.seeds.length, 1);
  assert.equal(result.seeds[0]['source-order-id'], 'order-invoice');
  assert.equal(result.seeds[0]['source-payment-id'], 'pay_from_tender');
  assert.equal(result.seeds[0]['source-invoice-id'], 'invoice-bloomington');
  assert.equal(result.seeds[0].city, 'Bloomington');
  assert.equal(result.seeds[0]['street-name'], 'International Drive');
  assert.equal(result.kronkitePayload.paymentId, 'pay_from_tender');
  assert.equal(result.kronkitePayload.orderId, 'order-invoice');

  const pending = pendingWrites.find((entry) => String(entry.key).includes('install-post:pending:'));
  assert.ok(pending, 'pending record was written');
  const decoded = JSON.parse(pending.value);
  assert.equal(decoded.orderId, 'order-invoice');
  assert.equal(decoded.paymentId, 'pay_from_tender');
  assert.equal(decoded.invoiceId, 'invoice-bloomington');
  assert.equal(decoded.seedCount, 1);
});

const GABLE_LN_GOOGLE_BLOB = {
  address_line_1: '4225 Gable Ln, Woodbury, MN 55129, USA',
  country: 'US',
};

test('invoice notify parses Gable Ln from primary_recipient when customer address is empty', async () => {
  const result = await notifyQInstallPost(
    {
      orderId: 'order-gable',
      payment: {},
      invoice: {
        id: 'invoice-gable',
        order_id: 'order-gable',
        primary_recipient: { customer_id: 'customer-gable', address: GABLE_LN_GOOGLE_BLOB },
      },
      isInvoiceEvent: true,
      eventType: 'invoice.payment_made',
      firstName: 'Gable',
      lastName: 'Homeowner',
      customer: { given_name: 'Gable', family_name: 'Homeowner', address: { country: 'US' } },
      amount: '150.00',
      amountCents: 15000,
    },
    {
      exists: async () => false,
      set: async () => true,
      sadd: async () => true,
      kronkiteUrl: 'https://kronkite.example/square-wake',
      kronkiteKey: 'kronkite-sender-key',
      httpClient: {
        async get() {
          return {
            data: {
              order: {
                id: 'order-gable',
                line_items: [PLYMOUTH_LINE_ITEMS[0]],
              },
            },
          };
        },
        async post() {
          return { data: {} };
        },
      },
    },
  );

  assert.equal(result.seeds[0].city, 'Woodbury');
  assert.equal(result.seeds[0]['street-name'], 'Gable Ln');
  assert.doesNotMatch(String(result.seeds[0]['street-name']), /4225|55129|USA|Woodbury/);
  assert.equal(result.kronkitePayload.city, 'Woodbury');
  assert.equal(result.kronkitePayload.streetName, 'Gable Ln');
});

test('appointment notify keeps structured locality city and street-only line1', async () => {
  const result = await notifyQInstallPost(
    {
      orderId: 'order-gable-appt',
      payment: { id: 'payment-gable-appt', source_type: 'CARD', order_id: 'order-gable-appt' },
      invoice: {},
      isInvoiceEvent: false,
      eventType: 'payment.updated',
      firstName: 'Gable',
      lastName: 'Homeowner',
      customer: {
        given_name: 'Gable',
        address: {
          address_line_1: '4225 Gable Ln',
          locality: 'Woodbury',
          administrative_district_level_1: 'MN',
          postal_code: '55129',
          country: 'US',
        },
      },
      amount: '150.00',
      amountCents: 15000,
    },
    {
      exists: async () => false,
      set: async () => true,
      sadd: async () => true,
      kronkiteUrl: 'https://kronkite.example/square-wake',
      kronkiteKey: 'kronkite-sender-key',
      httpClient: {
        async get() {
          return {
            data: {
              order: {
                id: 'order-gable-appt',
                line_items: [PLYMOUTH_LINE_ITEMS[0]],
              },
            },
          };
        },
        async post() {
          return { data: {} };
        },
      },
    },
  );

  assert.equal(result.seeds[0].city, 'Woodbury');
  assert.equal(result.seeds[0]['street-name'], 'Gable Ln');
  assert.equal(result.kronkitePayload.city, 'Woodbury');
  assert.equal(result.kronkitePayload.streetName, 'Gable Ln');
});
