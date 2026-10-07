import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';

import {
  createDailyUploadLedger,
  debugScopeFromQuery,
  fetchActiveSquareLocations,
  fetchCompletedSquarePaymentsForLocations,
  resolveSquareLocations,
  runDailyOfflineConversions,
} from '../lib/daily-offline-conversions.js';
import cronHandler from '../pages/api/cron/offline-conversions.js';
import { createResponse } from './webhook-test-helpers.js';

function createFakeKv() {
  const values = new Map();
  return {
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, structuredClone(value));
      return 'OK';
    },
    async get(key) {
      const value = values.get(key);
      return value === undefined ? null : structuredClone(value);
    },
    async del(key) {
      return values.delete(key) ? 1 : 0;
    },
  };
}

function payment(overrides = {}) {
  return {
    id: 'payment-1',
    order_id: 'order-1',
    customer_id: 'customer-1',
    location_id: 'LOC_A',
    status: 'COMPLETED',
    amount_money: { amount: 10000, currency: 'USD' },
    total_money: { amount: 10000, currency: 'USD' },
    refunded_money: { amount: 0, currency: 'USD' },
    updated_at: '2026-10-04T18:29:57.000Z',
    ...overrides,
  };
}

const usCustomer = {
  email_address: 'validation.only@example.com',
  phone_number: '(612) 555-0123',
  address: { country: 'US' },
};

function squareHttpClient({ locations, paymentsByLocation, failLocations = false, calls = [] }) {
  return {
    async get(url) {
      calls.push(url);
      if (url === 'https://connect.squareup.com/v2/locations') {
        if (failLocations) throw new Error('locations down');
        return { data: { locations } };
      }
      const parsed = new URL(url);
      if (parsed.pathname === '/v2/payments') {
        const locationId = parsed.searchParams.get('location_id');
        const result = paymentsByLocation[locationId];
        if (result instanceof Error) throw result;
        return { data: { payments: result || [] } };
      }
      if (parsed.pathname.startsWith('/v2/customers/')) return { data: { customer: usCustomer } };
      throw new Error(`unexpected ${url}`);
    },
  };
}

test('only ACTIVE locations are returned from List Locations', async () => {
  const locations = await fetchActiveSquareLocations({
    token: 't',
    httpClient: squareHttpClient({
      locations: [
        { id: 'LOC_A', name: 'Minneapolis', status: 'ACTIVE' },
        { id: 'LOC_B', name: 'Old', status: 'INACTIVE' },
        { id: 'LOC_C', name: 'Houston', status: 'active' },
        { name: 'No id', status: 'ACTIVE' },
      ],
    }),
  });
  assert.deepEqual(locations, [
    { id: 'LOC_A', name: 'Minneapolis' },
    { id: 'LOC_C', name: 'Houston' },
  ]);
});

test('location resolution falls back to SQUARE_LOCATION_ID when the list call fails or has no ACTIVE entry', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const failed = await resolveSquareLocations({
      token: 't',
      fallbackLocationId: 'LOC_FALLBACK',
      httpClient: squareHttpClient({ failLocations: true }),
    });
    assert.deepEqual(failed.locations, [{ id: 'LOC_FALLBACK', name: null }]);
    assert.equal(failed.source, 'fallback_square_location_id');

    const none = await resolveSquareLocations({
      token: 't',
      fallbackLocationId: 'LOC_FALLBACK',
      httpClient: squareHttpClient({ locations: [{ id: 'LOC_X', status: 'INACTIVE' }] }),
    });
    assert.deepEqual(none.locations, [{ id: 'LOC_FALLBACK', name: null }]);

    const nothing = await resolveSquareLocations({
      token: 't',
      fallbackLocationId: '',
      httpClient: squareHttpClient({ failLocations: true }),
    });
    assert.deepEqual(nothing.locations, []);
  } finally {
    console.error = originalError;
  }
  const listed = await resolveSquareLocations({
    token: 't',
    fallbackLocationId: 'LOC_FALLBACK',
    httpClient: squareHttpClient({ locations: [{ id: 'LOC_A', status: 'ACTIVE' }] }),
  });
  assert.equal(listed.source, 'list_locations');
});

test('payments are pulled per location, tagged with the location, and deduped by payment id', async () => {
  const calls = [];
  const { payments, perLocation, failures } = await fetchCompletedSquarePaymentsForLocations({
    token: 't',
    locations: [{ id: 'LOC_A', name: 'A' }, { id: 'LOC_B', name: 'B' }, { id: 'LOC_C', name: 'C' }],
    beginTime: '2026-07-01T00:00:00.000Z',
    httpClient: squareHttpClient({
      calls,
      paymentsByLocation: {
        LOC_A: [payment(), payment({ id: 'payment-dup', order_id: 'order-dup' })],
        LOC_B: [
          payment({ id: 'payment-2', order_id: 'order-2', location_id: undefined }),
          payment({ id: 'payment-dup', order_id: 'order-dup' }),
          payment({ id: 'payment-void', order_id: 'order-void', status: 'CANCELED' }),
        ],
        LOC_C: new Error('square 500'),
      },
    }),
  });
  assert.deepEqual(perLocation.map((row) => [row.locationId, row.paymentCount]), [['LOC_A', 2], ['LOC_B', 1]]);
  assert.deepEqual(failures, [{ locationId: 'LOC_C', error: 'square 500' }]);
  assert.deepEqual(payments.map((p) => p.id), ['payment-1', 'payment-dup', 'payment-2']);
  assert.equal(payments.find((p) => p.id === 'payment-2').location_id, 'LOC_B');
  assert.equal(calls.filter((url) => url.includes('/v2/payments')).length, 3);
});

test('run summary reports per-location counts and never uploads one order twice', async () => {
  const uploads = [];
  const result = await runDailyOfflineConversions({
    payments: [
      payment(),
      payment({ id: 'payment-1b', order_id: 'order-1' }),
      payment({ id: 'payment-2', order_id: 'order-2', location_id: 'LOC_B' }),
      payment({ id: 'payment-3', order_id: 'order-3', location_id: 'LOC_B', customer_id: 'customer-ca' }),
    ],
    customersById: {
      'customer-1': usCustomer,
      'customer-ca': { ...usCustomer, address: { country: 'CA' } },
    },
    ledger: createDailyUploadLedger(createFakeKv()),
    uploadConversion: async (value) => {
      uploads.push(value.orderId);
      return { success: true, googleRequestId: 'r' };
    },
  });
  assert.deepEqual(uploads.sort(), ['order-1', 'order-2']);
  assert.deepEqual(result.locationCounts, {
    LOC_A: { orders: 1, eligible: 1, uploaded: 1, skipped: 0, rejected: 0, errors: 0 },
    LOC_B: { orders: 2, eligible: 1, uploaded: 1, skipped: 0, rejected: 1, errors: 0 },
  });
});

async function callCron(query, { square, env = {} } = {}) {
  const previous = { ...process.env };
  Object.assign(process.env, {
    CRON_SECRET: 'cron-secret',
    SQUARE_ACCESS_TOKEN: 'square-token',
    SQUARE_LOCATION_ID: 'LOC_A',
    ...env,
  });
  for (const key of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'Q_ALERT_WEBHOOK_URL', 'Q_ALERT_WEBHOOK_AUTH', 'AGENTMAIL_API_KEY', 'AGENTMAIL_INBOX_ID']) {
    delete process.env[key];
  }
  const original = axios.get;
  axios.get = square.get;
  const postOriginal = axios.post;
  const posts = [];
  axios.post = async (url, body) => {
    posts.push({ url, body });
    if (url === 'https://oauth2.googleapis.com/token') return { data: { access_token: 'access' } };
    return square.googleResponse ? square.googleResponse(body) : { data: {}, headers: { 'request-id': 'req-1' } };
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    const res = createResponse();
    await cronHandler({
      method: 'GET',
      headers: { authorization: 'Bearer cron-secret' },
      query,
    }, res);
    return { res, posts, logs };
  } finally {
    console.log = originalLog;
    axios.get = original;
    axios.post = postOriginal;
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
}

test('cron dry run reads every ACTIVE location and reports per-location counts', async () => {
  const { res, posts } = await callCron({ validateOnly: '1' }, {
    env: {
      GOOGLE_ADS_CLIENT_ID: 'c', GOOGLE_ADS_CLIENT_SECRET: 's', GOOGLE_ADS_REFRESH_TOKEN: 'r',
      GOOGLE_ADS_DEVELOPER_TOKEN: 'd',
    },
    square: {
      get: squareHttpClient({
        locations: [
          { id: 'LOC_A', name: 'Minneapolis', status: 'ACTIVE' },
          { id: 'LOC_B', name: 'Houston', status: 'ACTIVE' },
          { id: 'LOC_OLD', status: 'INACTIVE' },
        ],
        paymentsByLocation: {
          LOC_A: [payment()],
          LOC_B: [payment({ id: 'payment-2', order_id: 'order-2', location_id: 'LOC_B' })],
          LOC_OLD: [payment({ id: 'payment-old', order_id: 'order-old' })],
        },
      }).get,
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.validateOnly, true);
  assert.equal(res.body.locationSource, 'list_locations');
  assert.deepEqual(res.body.locations.map((row) => [row.locationId, row.paymentCount, row.orders, row.uploaded]), [
    ['LOC_A', 1, 1, 1],
    ['LOC_B', 1, 1, 1],
  ]);
  assert.equal(res.body.uploadedCount, 2);
  assert.deepEqual(res.body.locationErrors, []);
  assert.equal(posts.filter((post) => post.url.includes('uploadClickConversions')).every((post) => post.body.validateOnly), true);
});

test('cron falls back to SQUARE_LOCATION_ID when List Locations fails', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const { res } = await callCron({ validateOnly: '1' }, {
      env: {
        GOOGLE_ADS_CLIENT_ID: 'c', GOOGLE_ADS_CLIENT_SECRET: 's', GOOGLE_ADS_REFRESH_TOKEN: 'r',
        GOOGLE_ADS_DEVELOPER_TOKEN: 'd',
      },
      square: {
        get: squareHttpClient({ failLocations: true, paymentsByLocation: { LOC_A: [payment()] } }).get,
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.locationSource, 'fallback_square_location_id');
    assert.deepEqual(res.body.locations.map((row) => row.locationId), ['LOC_A']);
    assert.equal(res.body.uploadedCount, 1);
  } finally {
    console.error = originalError;
  }
});

test('onlyOrder without a debug order is rejected before any Square call', async () => {
  for (const query of [{ onlyOrder: '1' }, { onlyOrder: '1', debug_enabled: '1' }, { onlyOrder: '1', debugOrderId: 'order-1' }]) {
    const { res } = await callCron(query, { square: { get: async () => assert.fail('no Square call') } });
    assert.equal(res.statusCode, 400);
  }
});

test('onlyOrder validate run touches only the named order and returns the Google row', async () => {
  const { res, posts } = await callCron(
    { validateOnly: '1', debug_enabled: '1', debugOrderId: 'order-2', onlyOrder: '1' },
    {
      env: {
        GOOGLE_ADS_CLIENT_ID: 'c', GOOGLE_ADS_CLIENT_SECRET: 's', GOOGLE_ADS_REFRESH_TOKEN: 'r',
        GOOGLE_ADS_DEVELOPER_TOKEN: 'd',
      },
      square: {
        get: squareHttpClient({
          locations: [{ id: 'LOC_A', status: 'ACTIVE' }, { id: 'LOC_B', status: 'ACTIVE' }],
          paymentsByLocation: {
            LOC_A: [payment()],
            LOC_B: [payment({ id: 'payment-2', order_id: 'order-2', location_id: 'LOC_B' })],
          },
        }).get,
        googleResponse: () => ({
          data: {
            partialFailureError: {
              code: 3,
              message: 'Multiple errors',
              details: [{
                errors: [{
                  errorCode: { conversionUploadError: 'CLICK_NOT_FOUND' },
                  message: 'click not found',
                }],
              }],
            },
          },
          headers: { 'request-id': 'req-debug' },
        }),
      },
    },
  );
  const uploads = posts.filter((post) => post.url.includes('uploadClickConversions'));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body.conversions[0].orderId, 'order-2');
  assert.equal(uploads[0].body.debugEnabled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.onlyOrder, true);
  assert.equal(res.body.uploadedCount, 0);
  assert.equal(res.body.debug.orderId, 'order-2');
  assert.equal(res.body.debug.outcome, 'google_partial_failure');
  assert.equal(res.body.debug.googleRequestId, 'req-debug');
  assert.deepEqual(res.body.debug.partialFailureErrors, [
    { category: 'conversionUploadError', code: 'CLICK_NOT_FOUND', message: 'click not found' },
  ]);
  assert.equal(res.body.errors[0].orderId, 'order-2');
});

test('debugScopeFromQuery requires both flags and an order id for scoped mode', () => {
  assert.deepEqual(debugScopeFromQuery({}), { debugOrderId: null, onlyOrderRequested: false, onlyOrder: false });
  assert.equal(debugScopeFromQuery({ debug_enabled: '1', debugOrderId: 'o', onlyOrder: 'true' }).onlyOrder, true);
  assert.equal(debugScopeFromQuery({ onlyOrder: '1', debugOrderId: 'o' }).onlyOrder, false);
});

const debugRunArgs = (ledger, uploadConversion, extra = {}) => ({
  payments: [
    payment(),
    payment({ id: 'payment-2', order_id: 'order-2', location_id: 'LOC_B' }),
  ],
  customersById: { 'customer-1': usCustomer },
  ledger,
  uploadConversion,
  debugOrderId: 'order-2',
  ...extra,
});

test('scoped debug run uploads only the named order and reports success with the request id', async () => {
  const ledger = createDailyUploadLedger(createFakeKv());
  const calls = [];
  const result = await runDailyOfflineConversions(debugRunArgs(ledger, async (value) => {
    calls.push(value);
    return { success: true, googleRequestId: 'req-ok', googleJobId: 'job-9' };
  }, { onlyOrder: true }));
  assert.deepEqual(calls.map((call) => [call.orderId, call.debugEnabled]), [['order-2', true]]);
  assert.equal(result.uploadedCount, 1);
  assert.equal(result.debug.outcome, 'uploaded');
  assert.equal(result.debug.googleRequestId, 'req-ok');
  assert.equal(result.debug.googleJobId, 'job-9');
  assert.equal(result.debug.onlyOrder, true);
  assert.equal(result.debug.alreadyInLedger, false);
  assert.equal(await ledger.has('order-2'), true);
  assert.equal(await ledger.has('order-1'), false);
});

test('scoped debug run on an order already in the ledger is an explicit no-op', async () => {
  const ledger = createDailyUploadLedger(createFakeKv());
  await ledger.record('order-2', { status: 'uploaded' });
  let calls = 0;
  const result = await runDailyOfflineConversions(debugRunArgs(ledger, async () => {
    calls += 1;
    return { success: true };
  }, { onlyOrder: true }));
  assert.equal(calls, 0);
  assert.equal(result.uploadedCount, 0);
  assert.equal(result.debug.outcome, 'skipped_already_uploaded');
  assert.equal(result.debug.alreadyInLedger, true);
  assert.match(result.debug.note, /already in the upload ledger/);
});

test('scoped debug validate-only run flags that the order is already in the ledger', async () => {
  const ledger = createDailyUploadLedger(createFakeKv());
  await ledger.record('order-2', { status: 'uploaded' });
  const result = await runDailyOfflineConversions(debugRunArgs(ledger, async () => ({ success: true, googleRequestId: 'v' }), {
    onlyOrder: true,
    validateOnly: true,
  }));
  assert.equal(result.debug.outcome, 'validated');
  assert.equal(result.debug.alreadyInLedger, true);
  assert.match(result.debug.note, /did not consult the ledger/);
  assert.equal(await ledger.has('order-2'), true);
});

test('scoped debug run reports an unknown or ineligible order without calling Google', async () => {
  const ledger = createDailyUploadLedger(createFakeKv());
  const upload = async () => assert.fail('must not upload');
  const unknown = await runDailyOfflineConversions({
    ...debugRunArgs(ledger, upload, { onlyOrder: true }),
    debugOrderId: 'order-missing',
  });
  assert.equal(unknown.debug.outcome, 'order_not_found');
  assert.equal(unknown.uploadedCount, 0);
  assert.deepEqual(unknown.locationCounts, {});

  const ineligible = await runDailyOfflineConversions({
    ...debugRunArgs(ledger, upload, { onlyOrder: true }),
    customersById: { 'customer-1': { ...usCustomer, address: { country: 'CA' } } },
    debugOrderId: 'order-1',
  });
  assert.equal(ineligible.debug.outcome, 'rejected');
  assert.equal(ineligible.debug.reason, 'not_us_paid');
});

test('unscoped debug run keeps uploading the other orders', async () => {
  const calls = [];
  const result = await runDailyOfflineConversions(debugRunArgs(
    createDailyUploadLedger(createFakeKv()),
    async (value) => {
      calls.push([value.orderId, value.debugEnabled]);
      return { success: true };
    },
  ));
  assert.deepEqual(calls.sort(), [['order-1', false], ['order-2', true]]);
  assert.equal(result.debug.onlyOrder, false);
});
