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
