import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInstallPostSeeds,
  describeInstallOrderLines,
  normalizeLineItems,
} from '../lib/install-post-seeds.mjs';

const customer = {
  address: {
    address_line_1: '123 Main Street',
    locality: 'Hopkins',
    administrative_district_level_1: 'MN',
    postal_code: '55343',
  },
};

// Hopkins-shaped Square order: Frame install $300 + paid option $50, soundbar $100 = $450.
function hopkinsLineItems({ grossIncludesModifiers = true } = {}) {
  return [
    {
      name: 'TV Installation',
      variation_name: '65" Samsung Frame',
      quantity: '1',
      base_price_money: { amount: 30000, currency: 'USD' },
      ...(grossIncludesModifiers
        ? { gross_sales_money: { amount: 35000, currency: 'USD' }, total_money: { amount: 35000, currency: 'USD' } }
        : {}),
      modifiers: [
        {
          name: 'Existing Conduit Concealment',
          base_price_money: { amount: 5000, currency: 'USD' },
          total_price_money: { amount: 5000, currency: 'USD' },
        },
      ],
    },
    {
      name: 'Soundbar Mounting',
      quantity: '1',
      base_price_money: { amount: 10000, currency: 'USD' },
      gross_sales_money: { amount: 10000, currency: 'USD' },
    },
  ];
}

for (const grossIncludesModifiers of [true, false]) {
  test(`Hopkins order keeps the paid modifier and totals $450 (gross_sales_money=${grossIncludesModifiers})`, () => {
    const normalized = normalizeLineItems(hopkinsLineItems({ grossIncludesModifiers }));
    assert.deepEqual(
      normalized.map((item) => [item.label, item.amountCents]),
      [
        ['65" Samsung Frame — TV Installation', 30000],
        ['Existing Conduit Concealment (+$50.00)', 5000],
        ['Soundbar Mounting', 10000],
      ],
    );
    assert.equal(normalized.reduce((sum, item) => sum + item.amountCents, 0), 45000);

    const [seed, ...rest] = buildInstallPostSeeds({
      lineItems: hopkinsLineItems({ grossIncludesModifiers }),
      customer,
      order: {},
      payment: { id: 'payment-hopkins', order_id: 'order-hopkins' },
      orderId: 'order-hopkins',
    });
    assert.equal(rest.length, 0);
    assert.equal(seed.price, '$450');
    assert.equal(seed['tv-size'], '65"');
    assert.equal(seed['gallery-style'], true);
    assert.equal(seed['soundbar-mounting'], true);
    assert.match(seed['job-notes'], /65" — TV Installation/);
    assert.match(seed['job-notes'], /Existing Conduit Concealment \(\+\$50\.00\)/);
    assert.match(seed['job-notes'], /Soundbar Mounting/);
    assert.deepEqual(seed['service-lines'], [
      {
        name: '65" Samsung Frame — TV Installation',
        quantity: 1,
        amount: '$300',
        modifiers: [{ name: 'Existing Conduit Concealment', total_price_money: { amount: 5000, currency: 'USD' } }],
      },
      { name: 'Soundbar Mounting', quantity: 1, amount: '$100' },
    ]);
  });
}

test('modifiers do not create extra TV units or TV lines', () => {
  const described = describeInstallOrderLines(hopkinsLineItems());
  assert.equal(described.tvCount, 1);
  assert.deepEqual(described.tvSizes, ['65"']);
  assert.deepEqual(
    described.serviceLines.map((line) => line.name),
    ['Existing Conduit Concealment (+$50.00)', 'Soundbar Mounting'],
  );
});

test('orders without modifiers keep their seed shape (no service-lines)', () => {
  const items = hopkinsLineItems().map(({ modifiers, ...rest }) => ({ ...rest, gross_sales_money: rest.base_price_money }));
  const [seed] = buildInstallPostSeeds({ lineItems: items, customer, order: {}, payment: {} });
  assert.equal(seed['service-lines'], undefined);
  assert.equal(seed.price, '$400');
});

// Declined Square choices ($0 modifiers / $0 lines) must never become service claims.
function negativeChoiceLineItems() {
  const items = hopkinsLineItems();
  items[0].modifiers.push(
    { name: 'No Soundbar', base_price_money: { amount: 0, currency: 'USD' }, total_price_money: { amount: 0, currency: 'USD' } },
    { name: 'No Cord Concealing', base_price_money: { amount: 0, currency: 'USD' }, total_price_money: { amount: 0, currency: 'USD' } },
  );
  items.push({ name: 'No Soundbar', quantity: '1', base_price_money: { amount: 0, currency: 'USD' } });
  return items;
}

test('negative $0 modifiers (No Soundbar, No Cord Concealing) are dropped; paid $50 option kept; total $450', () => {
  const normalized = normalizeLineItems(negativeChoiceLineItems());
  assert.deepEqual(
    normalized.map((item) => [item.label, item.amountCents]),
    [
      ['65" Samsung Frame — TV Installation', 30000],
      ['Existing Conduit Concealment (+$50.00)', 5000],
      ['Soundbar Mounting', 10000],
    ],
  );
  const [seed] = buildInstallPostSeeds({
    lineItems: negativeChoiceLineItems(),
    customer,
    order: {},
    payment: { id: 'payment-neg', order_id: 'order-neg' },
    orderId: 'order-neg',
  });
  assert.equal(seed.price, '$450');
  const serialized = JSON.stringify(seed);
  assert.doesNotMatch(serialized, /No Soundbar|No Cord Concealing/i);
  assert.deepEqual(seed['service-lines'][0].modifiers, [
    { name: 'Existing Conduit Concealment', total_price_money: { amount: 5000, currency: 'USD' } },
  ]);
});

test('only declined modifiers present: no add-on lines, no soundbar/cord claims', () => {
  const items = [
    {
      name: 'TV Installation',
      variation_name: '65" Samsung Frame',
      quantity: '1',
      base_price_money: { amount: 30000, currency: 'USD' },
      gross_sales_money: { amount: 30000, currency: 'USD' },
      modifiers: [
        { name: 'No Soundbar', total_price_money: { amount: 0, currency: 'USD' } },
        { name: 'No Cord Concealing', total_price_money: { amount: 0, currency: 'USD' } },
      ],
    },
  ];
  const normalized = normalizeLineItems(items);
  assert.deepEqual(normalized.map((item) => item.label), ['65" Samsung Frame — TV Installation']);
  const [seed] = buildInstallPostSeeds({ lineItems: items, customer, order: {}, payment: {} });
  assert.equal(seed.price, '$300');
  assert.equal(seed['service-lines'], undefined);
  assert.notEqual(seed['soundbar-mounting'], true);
  assert.doesNotMatch(JSON.stringify(seed), /Soundbar|Cord Conceal/i);
});

test('a priced but negatively named modifier is never emitted, and its price stays in the total', () => {
  const items = hopkinsLineItems();
  items[0].modifiers.push({ name: 'Without Cord Cover', total_price_money: { amount: 2500, currency: 'USD' } });
  items[0].gross_sales_money = { amount: 37500, currency: 'USD' };
  const normalized = normalizeLineItems(items);
  assert.ok(!normalized.some((item) => /Without/i.test(item.label)));
  assert.equal(normalized.reduce((sum, item) => sum + item.amountCents, 0), 47500);
});

test('a $0 customer-supplied bracket answer line is kept (not a declined service claim)', () => {
  const items = [...hopkinsLineItems(), { name: 'No bracket needed', quantity: '1', base_price_money: { amount: 0, currency: 'USD' } }];
  assert.ok(normalizeLineItems(items).some((item) => item.label === 'No bracket needed'));
});
