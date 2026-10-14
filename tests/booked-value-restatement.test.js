import assert from 'node:assert/strict';
import test from 'node:test';
import { createRestatementUploader, restateBookedValue } from '../lib/booked-value-restatement.js';

function fakeKv() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async set(k, v) { m.set(k, v); return 'OK'; }, m };
}

test('restatement sends RESTATEMENT keyed by booking_session with the real total', async () => {
  let body;
  const upload = createRestatementUploader({
    env: {},
    getToken: async () => 't',
    getDevToken: () => 'd',
    now: () => new Date('2026-10-13T20:00:00Z'),
    httpClient: { async post(url, payload) { body = payload; return { data: {} }; } },
  });
  const kv = fakeKv();
  const first = await restateBookedValue({ kv, bookingSession: 'sess-1', value: 289.5, upload, env: { BOOKED_VALUE_RESTATEMENT: 'on' } });
  assert.equal(first.outcome, 'restated');
  const adj = body.conversionAdjustments[0];
  assert.equal(adj.adjustmentType, 'RESTATEMENT');
  assert.equal(adj.orderId, 'sess-1');
  assert.equal(adj.conversionAction, 'customers/1287907452/conversionActions/6491204814');
  assert.deepEqual(adj.restatementValue, { adjustedValue: 289.5, currencyCode: 'USD' });
  assert.equal(adj.adjustmentDateTime, '2026-10-13 20:00:00+00:00');
  body = null;
  assert.equal((await restateBookedValue({ kv, bookingSession: 'sess-1', value: 289.5, upload, env: { BOOKED_VALUE_RESTATEMENT: 'on' } })).outcome, 'already_restated');
  assert.equal(body, null);
  assert.equal(JSON.stringify([...kv.m.keys()]).includes('sess-1'), false);
});

test('restatement skips missing values, is off unless enabled, and leaves not-found unmarked', async () => {
  const kv = fakeKv();
  let calls = 0;
  const upload = async () => { calls += 1; return { ok: false, codes: ['CONVERSION_NOT_FOUND'] }; };
  assert.equal((await restateBookedValue({ kv, bookingSession: 's', value: null, upload, env: { BOOKED_VALUE_RESTATEMENT: 'on' } })).outcome, 'no_value');
  assert.equal((await restateBookedValue({ kv, bookingSession: 's', value: 100, upload, env: {} })).outcome, 'disabled');
  assert.equal((await restateBookedValue({ kv, bookingSession: 's', value: 100, upload, env: { BOOKED_VALUE_RESTATEMENT: 'on' } })).outcome, 'conversion_not_found');
  assert.equal(calls, 1);
  assert.equal(kv.m.size, 0);
});
