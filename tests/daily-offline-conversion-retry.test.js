import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';

import {
  DAILY_CONVERSION_ACTION_ID,
  DAILY_SQUARE_LOOKBACK_DAYS,
  GOOGLE_TIMEOUT_MS,
  LOOKBACK_MS,
  SQUARE_MAX_ATTEMPTS,
  SQUARE_RETRY_BASE_MS,
  SQUARE_TIMEOUT_MS,
  createDailyGoogleUpload,
  fetchActiveSquareLocations,
  fetchCompletedSquarePaymentsForLocations,
  fetchSquareCustomers,
  isRetryableSquareError,
  resolveDailyLookbackMs,
  resolveSquareLocations,
} from '../lib/daily-offline-conversions.js';
import { createOfflineConversionsHandler, config as cronConfig } from '../pages/api/cron/offline-conversions.js';
import { createResponse } from './webhook-test-helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const noWait = async () => {};

function httpStatusError(status) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status };
  return error;
}

function timeoutError() {
  const error = new Error('timeout of 15000ms exceeded');
  error.code = 'ECONNABORTED';
  return error;
}

function payment(overrides = {}) {
  return {
    id: 'payment-1',
    order_id: 'order-1',
    customer_id: 'customer-1',
    location_id: 'LOC_A',
    status: 'COMPLETED',
    amount_money: { amount: 10000, currency: 'USD' },
    ...overrides,
  };
}

test('lookback default is 30 days and the env override replaces only that window', () => {
  assert.equal(DAILY_SQUARE_LOOKBACK_DAYS, 30);
  assert.equal(LOOKBACK_MS, 30 * DAY_MS);
  assert.equal(resolveDailyLookbackMs({}), LOOKBACK_MS);
  assert.equal(resolveDailyLookbackMs({ DAILY_OFFLINE_CONVERSION_LOOKBACK_DAYS: '' }), LOOKBACK_MS);
  assert.equal(resolveDailyLookbackMs({ DAILY_OFFLINE_CONVERSION_LOOKBACK_DAYS: '14' }), 14 * DAY_MS);
  assert.equal(resolveDailyLookbackMs({ DAILY_OFFLINE_CONVERSION_LOOKBACK_DAYS: '0' }), LOOKBACK_MS);
  assert.equal(resolveDailyLookbackMs({ DAILY_OFFLINE_CONVERSION_LOOKBACK_DAYS: 'nope' }), LOOKBACK_MS);
});

test('Square retries are limited to 429, 5xx, and network timeouts', () => {
  assert.equal(isRetryableSquareError(httpStatusError(504)), true);
  assert.equal(isRetryableSquareError(httpStatusError(429)), true);
  assert.equal(isRetryableSquareError(httpStatusError(500)), true);
  assert.equal(isRetryableSquareError(timeoutError()), true);
  assert.equal(isRetryableSquareError(httpStatusError(400)), false);
  assert.equal(isRetryableSquareError(httpStatusError(401)), false);
  assert.equal(isRetryableSquareError(new Error('square 500')), false);
});

test('a Square 5xx then success is retried and the payment is kept', async () => {
  const calls = [];
  const delays = [];
  const fetched = await fetchCompletedSquarePaymentsForLocations({
    token: 'square-token',
    locations: [{ id: 'LOC_A', name: 'Minneapolis' }],
    beginTime: '2026-09-19T00:00:00.000Z',
    sleep: async (ms) => delays.push(ms),
    random: () => 0,
    httpClient: {
      async get(url, config) {
        calls.push({ url, timeout: config?.timeout, headers: config?.headers });
        if (calls.length === 1) throw httpStatusError(504);
        return { data: { payments: [payment()] } };
      },
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].timeout, SQUARE_TIMEOUT_MS);
  assert.equal(calls[0].headers.Authorization, 'Bearer square-token');
  assert.equal(calls[0].headers['Square-Version'], '2024-01-18');
  assert.deepEqual(delays, [SQUARE_RETRY_BASE_MS]);
  assert.deepEqual(fetched.failures, []);
  assert.deepEqual(fetched.perLocation, [{ locationId: 'LOC_A', name: 'Minneapolis', paymentCount: 1 }]);
  assert.equal(fetched.payments[0].id, 'payment-1');
});

test('a persistent Square 5xx fails that location only and names Square', async () => {
  const calls = [];
  const delays = [];
  const fetched = await fetchCompletedSquarePaymentsForLocations({
    token: 't',
    locations: [
      { id: 'LOC_A', name: 'Minneapolis' },
      { id: 'LOC_B', name: 'Houston' },
    ],
    beginTime: '2026-09-19T00:00:00.000Z',
    sleep: async (ms) => delays.push(ms),
    random: () => 0.5,
    httpClient: {
      async get(url) {
        const locationId = new URL(url).searchParams.get('location_id');
        calls.push(locationId);
        if (locationId === 'LOC_B') throw httpStatusError(504);
        return { data: { payments: [payment()] } };
      },
    },
  });
  assert.deepEqual(calls.filter((id) => id === 'LOC_A'), ['LOC_A']);
  assert.equal(calls.filter((id) => id === 'LOC_B').length, SQUARE_MAX_ATTEMPTS);
  assert.deepEqual(delays, [
    SQUARE_RETRY_BASE_MS + Math.floor(0.5 * SQUARE_RETRY_BASE_MS),
    (SQUARE_RETRY_BASE_MS * 2) + Math.floor(0.5 * SQUARE_RETRY_BASE_MS * 2),
  ]);
  assert.deepEqual(fetched.perLocation.map((row) => row.locationId), ['LOC_A']);
  assert.deepEqual(fetched.payments.map((row) => row.id), ['payment-1']);
  assert.deepEqual(fetched.failures, [{
    locationId: 'LOC_B',
    error: 'Square payments fetch failed for location LOC_B: 504',
  }]);
});

test('Square locations and customers retry 504 then succeed, and a dead list still falls back', async () => {
  let locationCalls = 0;
  const locations = await fetchActiveSquareLocations({
    token: 't',
    sleep: noWait,
    random: () => 0,
    httpClient: {
      async get() {
        locationCalls += 1;
        if (locationCalls === 1) throw httpStatusError(504);
        return { data: { locations: [{ id: 'LOC_A', name: 'Minneapolis', status: 'ACTIVE' }] } };
      },
    },
  });
  assert.equal(locationCalls, 2);
  assert.deepEqual(locations, [{ id: 'LOC_A', name: 'Minneapolis' }]);

  let customerCalls = 0;
  const customers = await fetchSquareCustomers(['customer-1'], {
    token: 't',
    sleep: noWait,
    random: () => 0,
    httpClient: {
      async get(url, config) {
        customerCalls += 1;
        assert.equal(config.timeout, SQUARE_TIMEOUT_MS);
        if (customerCalls === 1) throw timeoutError();
        return { data: { customer: { id: 'customer-1', email_address: 'a@example.com' } } };
      },
    },
  });
  assert.equal(customerCalls, 2);
  assert.equal(customers.customersById['customer-1'].email_address, 'a@example.com');
  assert.deepEqual(customers.failures, []);

  const callsByCustomer = {};
  const failed = await fetchSquareCustomers(['customer-9', 'customer-ok'], {
    token: 't',
    sleep: noWait,
    random: () => 0,
    httpClient: {
      async get(url) {
        const customerId = url.split('/v2/customers/')[1];
        callsByCustomer[customerId] = (callsByCustomer[customerId] || 0) + 1;
        if (customerId === 'customer-9') throw httpStatusError(504);
        return { data: { customer: { id: customerId, email_address: 'ok@example.com' } } };
      },
    },
  });
  assert.equal(callsByCustomer['customer-9'], SQUARE_MAX_ATTEMPTS);
  assert.equal(callsByCustomer['customer-ok'], 1);
  assert.equal(failed.customersById['customer-ok'].email_address, 'ok@example.com');
  assert.equal(failed.customersById['customer-9'], undefined);
  assert.deepEqual(failed.failures, [{
    customerId: 'customer-9',
    error: 'Square customer fetch failed: 504',
  }]);

  const originalError = console.error;
  console.error = () => {};
  try {
    let attempts = 0;
    const resolved = await resolveSquareLocations({
      token: 't',
      fallbackLocationId: 'LOC_FALLBACK',
      sleep: noWait,
      random: () => 0,
      httpClient: {
        async get() {
          attempts += 1;
          throw httpStatusError(504);
        },
      },
    });
    assert.equal(attempts, SQUARE_MAX_ATTEMPTS);
    assert.equal(resolved.source, 'fallback_square_location_id');
    assert.deepEqual(resolved.locations, [{ id: 'LOC_FALLBACK', name: null }]);
  } finally {
    console.error = originalError;
  }
});

test('the Google access token is fetched once per run and refreshed only after it expires', async () => {
  let clock = 1_700_000_000_000;
  let tokenCalls = 0;
  const uploads = [];
  const env = {
    GOOGLE_ADS_CLIENT_ID: 'client',
    GOOGLE_ADS_CLIENT_SECRET: 'secret',
    GOOGLE_ADS_REFRESH_TOKEN: 'refresh',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'developer',
  };
  const upload = createDailyGoogleUpload(env, {
    async post(url, body, config) {
      if (url === 'https://oauth2.googleapis.com/token') {
        tokenCalls += 1;
        assert.equal(config.timeout, GOOGLE_TIMEOUT_MS);
        return { data: { access_token: `token-${tokenCalls}`, expires_in: 3600 } };
      }
      uploads.push({ url, body, timeout: config.timeout, authorization: config.headers.Authorization });
      return { data: { jobId: 'job-1' }, headers: { 'request-id': 'req-1' } };
    },
  }, { now: () => clock });

  const order = (orderId, conversionValue) => upload({
    email: 'validation.only@example.com',
    conversionValue,
    conversionDateTime: '2026-10-04T18:29:57.000Z',
    orderId,
    consentStatus: 'GRANTED',
  });

  await Promise.all([order('order-1', 100), order('order-2', 80)]);
  assert.equal(tokenCalls, 1);
  assert.equal(uploads.length, 2);
  assert.ok(uploads.every((row) => row.authorization === 'Bearer token-1'));
  assert.ok(uploads.every((row) => row.timeout === GOOGLE_TIMEOUT_MS));
  assert.ok(uploads.every((row) => (
    row.body.conversions[0].conversionAction
      === `customers/1287907452/conversionActions/${DAILY_CONVERSION_ACTION_ID}`
  )));
  assert.deepEqual(
    uploads.map((row) => [row.body.conversions[0].orderId, row.body.conversions[0].conversionValue]).sort(),
    [['order-1', 100], ['order-2', 80]],
  );

  clock += (3600 * 1000) - 60_000;
  await order('order-3', 40);
  assert.equal(tokenCalls, 2);
  assert.equal(uploads[2].authorization, 'Bearer token-2');
  assert.equal(uploads[2].body.conversions[0].conversionValue, 40);
});

test('a failed Google token fetch is not repeated for later orders in the same run', async () => {
  let tokenCalls = 0;
  const upload = createDailyGoogleUpload({
    GOOGLE_ADS_CLIENT_ID: 'client',
    GOOGLE_ADS_CLIENT_SECRET: 'secret',
    GOOGLE_ADS_REFRESH_TOKEN: 'refresh',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'developer',
  }, {
    async post(url) {
      tokenCalls += 1;
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      throw httpStatusError(503);
    },
  });
  const order = {
    email: 'validation.only@example.com',
    conversionValue: 100,
    conversionDateTime: '2026-10-04T18:29:57.000Z',
    orderId: 'order-1',
    consentStatus: 'GRANTED',
  };
  await assert.rejects(() => upload(order), /Google OAuth token fetch failed: 503/);
  await assert.rejects(() => upload({ ...order, orderId: 'order-2' }), /Google OAuth token fetch failed: 503/);
  assert.equal(tokenCalls, 1);
});

test('the cron route allows 300s and asks Square for the 30 day window', async () => {
  assert.equal(cronConfig.maxDuration, 300);
  const previous = { ...process.env };
  Object.assign(process.env, {
    CRON_SECRET: 'cron-secret',
    SQUARE_ACCESS_TOKEN: 'square-token',
    SQUARE_LOCATION_ID: 'LOC_A',
    GOOGLE_ADS_CLIENT_ID: 'c',
    GOOGLE_ADS_CLIENT_SECRET: 's',
    GOOGLE_ADS_REFRESH_TOKEN: 'r',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'd',
  });
  for (const key of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'DAILY_OFFLINE_CONVERSION_LOOKBACK_DAYS']) {
    delete process.env[key];
  }
  const urls = [];
  const originalGet = axios.get;
  const originalPost = axios.post;
  axios.get = async (url) => {
    urls.push(url);
    if (url === 'https://connect.squareup.com/v2/locations') {
      return { data: { locations: [{ id: 'LOC_A', status: 'ACTIVE' }] } };
    }
    return { data: { payments: [] } };
  };
  axios.post = async () => ({ data: { access_token: 'access', expires_in: 3600 }, headers: {} });
  const started = Date.now();
  try {
    const res = createResponse();
    await createOfflineConversionsHandler({ alert: async () => {} })({
      method: 'GET',
      headers: { authorization: 'Bearer cron-secret' },
      query: { validateOnly: '1' },
    }, res);
    assert.equal(res.statusCode, 200);
    const paymentsUrl = urls.find((url) => url.includes('/v2/payments'));
    const begin = Date.parse(new URL(paymentsUrl).searchParams.get('begin_time'));
    const age = started - begin;
    assert.ok(Math.abs(age - LOOKBACK_MS) < 5000);
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});

test('a Square 504 on every location fails the cron with a Square payments message', async () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    CRON_SECRET: 'cron-secret',
    SQUARE_ACCESS_TOKEN: 'square-token',
    SQUARE_LOCATION_ID: 'LVNM3Z4RVRWDK',
  });
  for (const key of ['KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[key];
  const originalGet = axios.get;
  const originalError = console.error;
  console.error = () => {};
  axios.get = async (url) => {
    if (url === 'https://connect.squareup.com/v2/locations') {
      return { data: { locations: [{ id: 'LVNM3Z4RVRWDK', status: 'ACTIVE', name: 'Minneapolis' }] } };
    }
    throw httpStatusError(504);
  };
  const alerts = [];
  try {
    const res = createResponse();
    await createOfflineConversionsHandler({
      alert: async (failure) => alerts.push(failure),
    })({
      method: 'GET',
      headers: { authorization: 'Bearer cron-secret' },
      query: { validateOnly: '1' },
    }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Square payments fetch failed for location LVNM3Z4RVRWDK: 504');
    assert.equal(alerts.length, 0);
  } finally {
    console.error = originalError;
    axios.get = originalGet;
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});
