import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPaymentSource, buildWoodwardSquarePayload } from '../lib/notify-install-post.mjs';
import { fetchRecentCompletedPayments } from '../pages/api/cron/square-install-post-seed.js';

test('every tender type is labeled, none dropped', () => {
  assert.equal(classifyPaymentSource({ source_type: 'CARD' }), 'CARD');
  assert.equal(classifyPaymentSource({ source_type: 'CASH', cash_details: {} }), 'CASH');
  assert.equal(classifyPaymentSource({ source_type: 'EXTERNAL', external_details: { type: 'CHECK' } }), 'EXTERNAL/CHECK');
  assert.equal(classifyPaymentSource({ source_type: 'EXTERNAL', external_details: { type: 'OTHER_GIFT_CARD' } }), 'EXTERNAL/OTHER_GIFT_CARD');
  assert.equal(classifyPaymentSource({ source_type: 'WALLET' }), 'WALLET');
  assert.equal(classifyPaymentSource({}), 'UNKNOWN');
});

test('cash payment without card_details builds camelCase wake', () => {
  const p = buildWoodwardSquarePayload({ payment: { id: 'P1', order_id: 'O1', source_type: 'CASH', cash_details: {} } });
  assert.equal(p.paymentSource, 'CASH');
  assert.equal(p.paymentId, 'P1');
});

test('cron scans all locations and pages, keeps cash/check', async () => {
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    if (url.includes('location_id=A') && !url.includes('cursor')) return { data: { payments: [{ id: '1', status: 'COMPLETED', source_type: 'CARD' }], cursor: 'c' } };
    if (url.includes('location_id=A')) return { data: { payments: [{ id: '2', status: 'COMPLETED', source_type: 'CASH' }] } };
    return { data: { payments: [{ id: '3', status: 'COMPLETED', source_type: 'EXTERNAL' }, { id: '4', status: 'FAILED' }] } };
  };
  const out = await fetchRecentCompletedPayments({ get, locationIds: ['A', 'B'] });
  assert.deepEqual(out.map((p) => p.id), ['1', '2', '3']);
  assert.equal(calls.length, 3);
});
