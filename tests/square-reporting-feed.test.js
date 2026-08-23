import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GET_MOUNTING_MAN_SQUARE_DETAIL,
  KNOWN_CASHIERS,
  chicagoDayBounds,
  getMountingManSquareDetail,
  resolveCashierName,
  sanitizePaymentDetail,
} from '../lib/square-reporting-feed.mjs';

const MIKE_ID = 'TMSiHOOr7RGdl2Ki';

function dirtyPayment(overrides = {}) {
  return {
    id: 'pay_mike_1',
    order_id: 'ord_mike_1',
    created_at: '2026-08-22T18:15:00.000Z',
    status: 'COMPLETED',
    location_id: 'LVNM3Z4RVRWDK',
    team_member_id: MIKE_ID,
    customer_id: 'CUSTOMER_DO_NOT_LEAK',
    buyer_email_address: 'jane.buyer@example.com',
    receipt_url: 'https://squareup.com/receipt/abc123',
    receipt_number: 'RCPT-999',
    amount_money: { amount: 30000, currency: 'USD' },
    tip_money: { amount: 9315, currency: 'USD' },
    total_money: { amount: 39315, currency: 'USD' },
    processing_fee: [
      { type: 'INITIAL', effective_at: '2026-08-22T18:16:00.000Z', amount_money: { amount: -141, currency: 'USD' } },
    ],
    card_details: {
      status: 'CAPTURED',
      card: { last_4: '4242', cardholder_name: 'Jane Buyer', fingerprint: 'fp_secret' },
    },
    billing_address: {
      address_line_1: '1847 Summit Ave',
      locality: 'St Paul',
      administrative_district_level_1: 'MN',
      postal_code: '55105',
    },
    shipping_address: { address_line_1: '1847 Summit Ave' },
    ...overrides,
  };
}

function dirtyOrder() {
  return {
    id: 'ord_mike_1',
    customer_id: 'CUSTOMER_DO_NOT_LEAK',
    fulfillments: [
      {
        type: 'PICKUP',
        pickup_details: {
          recipient: {
            display_name: 'Jane Buyer',
            phone_number: '+16515550184',
            email_address: 'jane.buyer@example.com',
            address: { address_line_1: '1847 Summit Ave' },
          },
        },
      },
    ],
    line_items: [
      {
        name: '65 Inch TV Mounting',
        quantity: '1',
        note: 'Call Jane at 651-555-0184 before arrival',
        base_price_money: { amount: 20000, currency: 'USD' },
        total_money: { amount: 20000, currency: 'USD' },
      },
      {
        name: 'Full Motion Bracket',
        quantity: '1',
        variation_name: 'Bought from us',
        base_price_money: { amount: 8000, currency: 'USD' },
        total_money: { amount: 8000, currency: 'USD' },
      },
      {
        name: 'Soundbar Mounting',
        quantity: '1',
        base_price_money: { amount: 10000, currency: 'USD' },
        total_money: { amount: 10000, currency: 'USD' },
      },
    ],
  };
}

const FORBIDDEN_STRINGS = [
  'Jane Buyer',
  'jane.buyer@example.com',
  'CUSTOMER_DO_NOT_LEAK',
  '1847 Summit',
  '1847',
  '55105',
  '+16515550184',
  '651-555-0184',
  'squareup.com/receipt',
  'RCPT-999',
  '4242',
  'fp_secret',
  'cardholder_name',
  'customer_id',
  'receipt_url',
];

test('sanitizer keeps tips, team_member_id, fees, and cashier name', () => {
  const detail = sanitizePaymentDetail({
    payment: dirtyPayment(),
    order: dirtyOrder(),
  });

  assert.equal(detail.payment_id, 'pay_mike_1');
  assert.equal(detail.order_id, 'ord_mike_1');
  assert.equal(detail.created_at, '2026-08-22T18:15:00.000Z');
  assert.equal(detail.status, 'COMPLETED');
  assert.equal(detail.team_member_id, MIKE_ID);
  assert.equal(detail.cashier_name, 'Michael Wenzel');
  assert.deepEqual(detail.amount_money, { amount: 30000, currency: 'USD' });
  assert.deepEqual(detail.tip_money, { amount: 9315, currency: 'USD' });
  assert.equal(detail.processing_fee.length, 1);
  assert.deepEqual(detail.processing_fee[0].amount_money, { amount: -141, currency: 'USD' });
});

test('sanitizer strips buyer PII, card details, receipt URLs, and customer_id', () => {
  const detail = sanitizePaymentDetail({
    payment: dirtyPayment(),
    order: dirtyOrder(),
    teamMember: {
      id: MIKE_ID,
      given_name: 'Mike',
      family_name: 'Wenzel',
      email_address: 'mike-internal@example.com',
      phone_number: '+16125550000',
    },
  });

  const serialized = JSON.stringify(detail);
  for (const forbidden of FORBIDDEN_STRINGS) {
    assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
  }
  assert.equal(Object.hasOwn(detail, 'customer_id'), false);
  assert.equal(Object.hasOwn(detail, 'buyer_email_address'), false);
  assert.equal(Object.hasOwn(detail, 'card_details'), false);
  assert.equal(Object.hasOwn(detail, 'receipt_url'), false);
  assert.equal(Object.hasOwn(detail, 'billing_address'), false);
});

test('Bracket line items stay visible; MoneyPenny-style hardware is not dropped', () => {
  const detail = sanitizePaymentDetail({
    payment: dirtyPayment(),
    order: dirtyOrder(),
  });

  const names = detail.line_items.map((item) => item.name);
  assert.deepEqual(names, [
    '65 Inch TV Mounting',
    'Full Motion Bracket',
    'Soundbar Mounting',
  ]);
  const bracket = detail.line_items.find((item) => item.name === 'Full Motion Bracket');
  assert.deepEqual(bracket.base_price_money, { amount: 8000, currency: 'USD' });
  assert.equal(bracket.variation_name, 'Bought from us');
});

test('Mike staff id always resolves to Michael Wenzel', () => {
  assert.equal(resolveCashierName(MIKE_ID, { given_name: 'Mike', family_name: 'W' }), 'Michael Wenzel');
  assert.equal(KNOWN_CASHIERS[MIKE_ID], 'Michael Wenzel');
  assert.equal(
    sanitizePaymentDetail({ payment: dirtyPayment({ team_member_id: MIKE_ID }) }).cashier_name,
    'Michael Wenzel',
  );
});

test('missing tip becomes a present zero tip_money field', () => {
  const detail = sanitizePaymentDetail({
    payment: dirtyPayment({ tip_money: undefined }),
    order: { line_items: [] },
  });
  assert.deepEqual(detail.tip_money, { amount: 0, currency: 'USD' });
});

test('Chicago day bounds cover CDT and CST midnights', () => {
  assert.deepEqual(chicagoDayBounds('2026-08-22'), {
    date: '2026-08-22',
    timezone: 'America/Chicago',
    beginTime: '2026-08-22T05:00:00.000Z',
    endTime: '2026-08-23T05:00:00.000Z',
  });
  assert.deepEqual(chicagoDayBounds('2026-01-15'), {
    date: '2026-01-15',
    timezone: 'America/Chicago',
    beginTime: '2026-01-15T06:00:00.000Z',
    endTime: '2026-01-16T06:00:00.000Z',
  });
});

test('feed tool keeps COMPLETED payments for a Chicago day and drops pending + other locations', async () => {
  const calls = { payments: 0, orders: 0, team: [] };
  const client = {
    locationId: 'LVNM3Z4RVRWDK',
    async listPayments({ beginTime, endTime }) {
      calls.payments += 1;
      assert.equal(beginTime, '2026-08-22T05:00:00.000Z');
      assert.equal(endTime, '2026-08-23T05:00:00.000Z');
      return [
        dirtyPayment(),
        dirtyPayment({
          id: 'pay_pending',
          status: 'PENDING',
          tip_money: { amount: 1, currency: 'USD' },
        }),
        dirtyPayment({
          id: 'pay_houston',
          location_id: 'OTHERLOC',
        }),
      ];
    },
    async batchOrders(ids) {
      calls.orders += 1;
      assert.deepEqual(ids, ['ord_mike_1']);
      return { ord_mike_1: dirtyOrder() };
    },
    async getTeamMember(id) {
      calls.team.push(id);
      throw new Error('should use known cashier map for Mike');
    },
  };

  const feed = await getMountingManSquareDetail({ date: '2026-08-22' }, { client });
  assert.equal(GET_MOUNTING_MAN_SQUARE_DETAIL, 'get_mounting_man_square_detail');
  assert.equal(feed.payment_count, 1);
  assert.equal(feed.payments[0].cashier_name, 'Michael Wenzel');
  assert.equal(feed.payments[0].tip_money.amount, 9315);
  assert.equal(feed.payments.some((payment) => payment.payment_id === 'pay_pending'), false);
  const serialized = JSON.stringify(feed);
  for (const forbidden of FORBIDDEN_STRINGS) {
    assert.equal(serialized.includes(forbidden), false, `feed leaked ${forbidden}`);
  }
  assert.equal(serialized.includes('25%'), false);
  assert.equal(serialized.includes('27%'), false);
});
