import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGclidReceiverHandler,
  extractClickCapture,
} from '../pages/api/attribution/gclid.js';
import { createResponse } from './webhook-test-helpers.js';

const SECRET = 'test-gclid-secret';
const RAW_GCLID = 'Cj0KCQjw_ZC2BhDqARIsAAfvjKzTEST-click_id.value';

function request(overrides = {}) {
  return {
    method: 'POST',
    query: { secret: SECRET },
    headers: {},
    body: {
      customer_id: 'zen-customer-1',
      booking_session: 'booking-session-1',
      gclid: RAW_GCLID,
      clicked_at: '2026-08-18T15:04:05Z',
    },
    ...overrides,
  };
}

function collector() {
  const saved = [];
  return {
    saved,
    store: {
      async saveClickIdentifier(value) {
        saved.push(value);
        return value;
      },
    },
  };
}

function silentLogger(sink = []) {
  return {
    sink,
    info: (...args) => sink.push(args),
    warn: (...args) => sink.push(args),
    error: (...args) => sink.push(args),
  };
}

test.beforeEach(() => {
  process.env.ZENBOOKER_GCLID_SECRET = SECRET;
});

test('captures the raw click identifier against the booking', async () => {
  const { saved, store } = collector();
  const handler = createGclidReceiverHandler({ attributionStore: store, logger: silentLogger() });
  const res = createResponse();
  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.captured, true);
  assert.equal(res.body.clickType, 'gclid');
  assert.match(res.body.bookingRef, /^[a-f0-9]{12}$/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].clickId, RAW_GCLID);
  assert.equal(saved[0].clickType, 'gclid');
  assert.equal(saved[0].zenCustomerId, 'zen-customer-1');
  assert.equal(saved[0].bookingSession, 'booking-session-1');
});

test('never echoes or logs the raw click identifier', async () => {
  const { store } = collector();
  const sink = [];
  const handler = createGclidReceiverHandler({
    attributionStore: store,
    logger: silentLogger(sink),
  });
  const res = createResponse();
  await handler(request(), res);

  assert.ok(!JSON.stringify(res.body).includes(RAW_GCLID));
  assert.ok(!JSON.stringify(sink).includes(RAW_GCLID));
});

test('rejects a wrong secret with 401 and stores nothing', async () => {
  const { saved, store } = collector();
  const handler = createGclidReceiverHandler({ attributionStore: store, logger: silentLogger() });
  const res = createResponse();
  await handler(request({ query: { secret: 'wrong-secret' } }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(saved.length, 0);
});

test('rejects a secret of a different length without throwing', async () => {
  const { saved, store } = collector();
  const handler = createGclidReceiverHandler({ attributionStore: store, logger: silentLogger() });
  const res = createResponse();
  await handler(request({ query: { secret: 'short' } }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(saved.length, 0);
});

test('rejects non-POST with 405', async () => {
  const handler = createGclidReceiverHandler({ attributionStore: collector().store });
  const res = createResponse();
  await handler(request({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
});

test('returns 500 when the receiver secret is unset', async () => {
  delete process.env.ZENBOOKER_GCLID_SECRET;
  const handler = createGclidReceiverHandler({
    attributionStore: collector().store,
    logger: silentLogger(),
  });
  const res = createResponse();
  await handler(request(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.errorCode, 'RECEIVER_NOT_CONFIGURED');
});

test('every post-auth outcome answers 200 so ZenBooker keeps the hook enabled', async () => {
  const { store } = collector();
  const handler = createGclidReceiverHandler({ attributionStore: store, logger: silentLogger() });

  for (const body of [
    {},
    { customer_id: 'zen-1', booking_session: 'b-1' },
    { customer_id: 'zen-1', booking_session: 'b-1', gclid: 'short' },
    { customer_id: 'bad id!', booking_session: 'b-1', gclid: RAW_GCLID },
  ]) {
    const res = createResponse();
    await handler(request({ body }), res);
    assert.equal(res.statusCode, 200, `expected 200 for ${JSON.stringify(body)}`);
    assert.equal(res.body.captured, false);
  }
});

test('a store failure answers 200 and marks the capture retryable', async () => {
  const handler = createGclidReceiverHandler({
    attributionStore: {
      async saveClickIdentifier() { throw new Error('kv down'); },
    },
    logger: silentLogger(),
  });
  const res = createResponse();
  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.captured, false);
  assert.equal(res.body.retryable, true);
  assert.equal(res.body.errorCode, 'CLICK_CAPTURE_FAILED');
});

test('reports the store as unavailable when KV is not configured', async () => {
  const handler = createGclidReceiverHandler({ kvClient: null, logger: silentLogger() });
  const res = createResponse();
  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.errorCode, 'ATTRIBUTION_STORE_UNAVAILABLE');
  assert.equal(res.body.retryable, true);
});

test('accepts the ZenBooker data/job wrapper and tracking block', () => {
  const capture = extractClickCapture({
    event: 'booking.created',
    data: {
      job: {
        customer: { id: 'zen-9' },
        booking_session: 'sess-9',
        tracking: { gclid: RAW_GCLID },
      },
    },
  });
  assert.equal(capture.zenCustomerId, 'zen-9');
  assert.equal(capture.bookingSession, 'sess-9');
  assert.equal(capture.clickType, 'gclid');
  assert.equal(capture.clickId, RAW_GCLID);
});

test('prefers gclid, then gbraid, then wbraid', () => {
  assert.equal(extractClickCapture({ gclid: 'a'.repeat(20), gbraid: 'b'.repeat(20) }).clickType, 'gclid');
  assert.equal(extractClickCapture({ gbraid: 'b'.repeat(20), wbraid: 'c'.repeat(20) }).clickType, 'gbraid');
  assert.equal(extractClickCapture({ wbraid: 'c'.repeat(20) }).clickType, 'wbraid');
  assert.equal(extractClickCapture({ utm_source: 'google' }).clickType, null);
});

test('the receiver performs no Google Ads upload', async () => {
  const { store } = collector();
  const handler = createGclidReceiverHandler({ attributionStore: store, logger: silentLogger() });
  const res = createResponse();
  await handler(request(), res);

  // The handler is constructed with no upload dependency at all; a captured
  // response must not claim any conversion side effect.
  assert.equal(res.body.captured, true);
  assert.equal(res.body.uploaded, undefined);
  assert.equal(res.body.conversion, undefined);
});
