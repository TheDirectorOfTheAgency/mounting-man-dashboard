import assert from 'node:assert/strict';
import test from 'node:test';

import { hashEmail, hashPhone } from '../lib/hash-pii.js';
import {
  createDailyUploadLedger,
  fetchSquareCustomers,
  runDailyOfflineConversions,
  SQUARE_MAX_ATTEMPTS,
} from '../lib/daily-offline-conversions.js';
import { deliverQAlert, redactAlertText, redactSquareCustomerIds, sanitizeAlertText } from '../lib/q-alert.js';
import { createOfflineConversionsHandler } from '../pages/api/cron/offline-conversions.js';
import { createResponse } from './webhook-test-helpers.js';

const noWait = async () => {};

const IDS = {
  good: 'goodcust',
  ca: 'cacustom',
  short: 'ab12',
  medium: 'cust8chr',
  square: 'JDKYHBWT1D4F8MFH63DBMEN8Y2',
  long: 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0',
};
const CUSTOMER_IDS = Object.values(IDS);
const LOCATION_ID = 'LVNM3Z4RVRWDK';
const LOCATION_26 = 'LOCIDXXX1D4F8MFH63DBMEN8Y2';
const LETTERS_26 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PHONE = '(612) 555-0199';
const EMAIL = 'validation.only@example.com';
const DEFERRED_ORDER_IDS = ['order-short', 'order-medium-a', 'order-medium-b', 'order-square', 'order-long'];

const usCustomer = {
  email_address: EMAIL,
  phone_number: PHONE,
  address: { country: 'US' },
};
const caCustomer = {
  email_address: 'canada.only@example.com',
  phone_number: '(713) 555-0144',
  address: { country: 'CA' },
};

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

function payment(overrides) {
  return {
    id: overrides.id,
    order_id: overrides.orderId,
    customer_id: overrides.customerId,
    location_id: 'LOC_A',
    status: 'COMPLETED',
    amount_money: { amount: 10000, currency: 'USD' },
    total_money: { amount: 10000, currency: 'USD' },
    refunded_money: { amount: 0, currency: 'USD' },
    updated_at: '2026-10-04T18:29:57.000Z',
    gclid: overrides.gclid || null,
    ...overrides,
  };
}

function scenarioPayments() {
  return [
    payment({ id: 'pay-short', orderId: 'order-short', customerId: IDS.short, gclid: 'click-short' }),
    payment({ id: 'pay-good', orderId: 'order-good', customerId: IDS.good }),
    payment({ id: 'pay-medium-a', orderId: 'order-medium-a', customerId: IDS.medium, gclid: 'click-medium-a' }),
    payment({ id: 'pay-medium-b', orderId: 'order-medium-b', customerId: IDS.medium, gclid: 'click-medium-b' }),
    payment({ id: 'pay-ca', orderId: 'order-ca', customerId: IDS.ca }),
    payment({ id: 'pay-square', orderId: 'order-square', customerId: IDS.square, gclid: 'click-square' }),
    payment({ id: 'pay-long', orderId: 'order-long', customerId: IDS.long, gclid: 'click-long' }),
  ];
}

function createFakeKv() {
  const values = new Map();
  const sets = new Map();
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
    async sadd(key, member) {
      const set = sets.get(key) || new Set();
      set.add(member);
      sets.set(key, set);
      return 1;
    },
    async smembers(key) {
      return [...(sets.get(key) || [])];
    },
    async expire() {
      return 1;
    },
  };
}

function squareClient({ recovered = false } = {}) {
  const attempts = {};
  const posts = [];
  return {
    attempts,
    posts,
    async get(url) {
      if (url === 'https://connect.squareup.com/v2/locations') {
        return { data: { locations: [{ id: 'LOC_A', name: 'Minneapolis', status: 'ACTIVE' }] } };
      }
      if (url.includes('/v2/payments')) return { data: { payments: scenarioPayments() } };
      const customerId = url.split('/v2/customers/')[1];
      attempts[customerId] = (attempts[customerId] || 0) + 1;
      if (customerId === IDS.ca) return { data: { customer: caCustomer } };
      if (recovered || customerId === IDS.good) return { data: { customer: usCustomer } };
      if (customerId === IDS.square) throw new Error(`upstream said ${customerId} missing`);
      if (customerId === IDS.short) throw timeoutError();
      throw httpStatusError(504);
    },
    async post(url, body) {
      posts.push({ url, body });
      if (url === 'https://oauth2.googleapis.com/token') {
        return { data: { access_token: 'access', expires_in: 3600 }, headers: {} };
      }
      return { data: {}, headers: { 'request-id': 'req-1' } };
    },
  };
}

function uploadPosts(client) {
  return client.posts.filter((post) => String(post.url).includes('uploadClickConversions'));
}

function assertNoCustomerIds(label, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const id of CUSTOMER_IDS) {
    assert.equal(text.includes(id), false, `${label} leaked customer id ${id}`);
  }
  assert.equal(text.includes(PHONE), false, `${label} leaked a phone number`);
  assert.equal(text.includes(hashPhone(PHONE)), false, `${label} leaked a phone hash`);
}

async function withCronEnv(run) {
  const previous = { ...process.env };
  Object.assign(process.env, {
    CRON_SECRET: 'cron-secret',
    SQUARE_ACCESS_TOKEN: 'square-token',
    SQUARE_LOCATION_ID: 'LOC_A',
    GOOGLE_ADS_CLIENT_ID: 'client',
    GOOGLE_ADS_CLIENT_SECRET: 'secret',
    GOOGLE_ADS_REFRESH_TOKEN: 'refresh',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'developer',
    Q_ALERT_WEBHOOK_URL: 'https://alerts.example/hook',
    Q_ALERT_WEBHOOK_AUTH: 'Bearer q-secret',
    AGENTMAIL_API_KEY: 'am-key',
    AGENTMAIL_INBOX_ID: 'inbox-1',
  });
  for (const key of ['KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[key];
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args);
  console.error = (...args) => errors.push(args);
  try {
    return await run({ logs, errors });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
}

function alertRecorder() {
  const payloads = [];
  const deliveries = [];
  const alert = async (failure) => {
    payloads.push(failure);
    await deliverQAlert({
      ...failure,
      env: process.env,
      fetchImpl: async (url, init) => {
        deliveries.push({ url: String(url), body: String(init?.body || '') });
        if (String(url).includes('agentmail')) return { ok: false, status: 502 };
        return { ok: true };
      },
    });
  };
  return { payloads, deliveries, alert };
}

test('a failed Square customer lookup defers only that customer\'s orders and the rest of the batch continues', async () => {
  const calls = [];
  const fetched = await fetchSquareCustomers([IDS.short, IDS.good, IDS.square], {
    token: 't',
    sleep: noWait,
    random: () => 0,
    httpClient: {
      async get(url) {
        const customerId = url.split('/v2/customers/')[1];
        calls.push(customerId);
        if (customerId === IDS.short) throw timeoutError();
        if (customerId === IDS.square) throw new Error(`upstream said ${customerId} missing`);
        return { data: { customer: { ...usCustomer, id: customerId } } };
      },
    },
  });
  assert.deepEqual(calls, [
    IDS.short, IDS.short, IDS.short,
    IDS.good,
    IDS.square,
  ]);
  assert.equal(fetched.customersById[IDS.good].email_address, EMAIL);
  assert.equal(fetched.customersById[IDS.short], undefined);
  assert.equal(fetched.customersById[IDS.square], undefined);
  assert.equal(fetched.failures.length, 2);
  for (const failure of fetched.failures) {
    assert.equal(failure.error.includes(failure.customerId), false);
    assert.match(failure.error, /^Square customer fetch failed/);
  }

  const kv = createFakeKv();
  const client = squareClient();
  const { payloads, deliveries, alert } = alertRecorder();
  await withCronEnv(async ({ logs, errors }) => {
    const res = createResponse();
    await createOfflineConversionsHandler({
      alert,
      loadKv: async () => kv,
      httpClient: client,
      squareRetry: { sleep: noWait, random: () => 0 },
    })({
      method: 'GET',
      headers: { authorization: 'Bearer cron-secret' },
      query: {},
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(client.attempts[IDS.short], SQUARE_MAX_ATTEMPTS);
    assert.equal(client.attempts[IDS.medium], SQUARE_MAX_ATTEMPTS);
    assert.equal(client.attempts[IDS.long], SQUARE_MAX_ATTEMPTS);
    assert.equal(client.attempts[IDS.square], 1);
    assert.equal(client.attempts[IDS.good], 1);
    assert.equal(client.attempts[IDS.ca], 1);
    const posts = uploadPosts(client);
    assert.deepEqual(posts.map((post) => post.body.conversions[0].orderId), ['order-good']);
    assert.equal(res.body.uploadedCount, 1);
    assert.equal(res.body.gclidCount, 0);
    assert.equal(res.body.rejectedCount, 1);
    assert.deepEqual(
      res.body.errors.map((row) => row.orderId).sort(),
      [...DEFERRED_ORDER_IDS].sort(),
    );
    assert.equal(res.body.orders.some((row) => DEFERRED_ORDER_IDS.includes(row.orderId)), false);
    assert.equal(res.body.orders.some((row) => row.orderId === 'order-ca'), false);
    assert.equal(res.body.locations[0].uploaded, 1);
    assert.equal(res.body.locations[0].errors, DEFERRED_ORDER_IDS.length);
    assertNoCustomerIds('response', res.body);
    assertNoCustomerIds('logs', logs);
    assertNoCustomerIds('error logs', errors);
    assert.equal(payloads.length, 1);
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries.some((row) => row.url.includes('agentmail')));
    assert.ok(deliveries.some((row) => row.url === 'https://alerts.example/hook'));
    assert.match(payloads[0].body, /Square customer fetch failed/);
    assert.match(payloads[0].body, /order-square/);
    assertNoCustomerIds('notify alert', payloads);
    assertNoCustomerIds('q-alert deliveries', deliveries);
  });
});

test('deferred customer-lookup orders are not uploaded, are not replaced with a blank customer, and stay eligible for a later run', async () => {
  const kv = createFakeKv();
  const ledger = createDailyUploadLedger(kv);
  const client = squareClient();
  const { alert } = alertRecorder();
  await withCronEnv(async () => {
    const first = createResponse();
    const handler = createOfflineConversionsHandler({
      alert,
      loadKv: async () => kv,
      httpClient: client,
      squareRetry: { sleep: noWait, random: () => 0 },
    });
    await handler({
      method: 'GET',
      headers: { authorization: 'Bearer cron-secret' },
      query: {},
    }, first);
    assert.equal(first.statusCode, 200);
    assert.equal(await ledger.has('order-good'), true);
    for (const orderId of DEFERRED_ORDER_IDS) {
      assert.equal(await ledger.has(orderId), false, `${orderId} was marked uploaded`);
    }
    assert.equal(await ledger.has('order-ca'), false);

    const recovered = squareClient({ recovered: true });
    const secondPayloads = [];
    const second = createResponse();
    await createOfflineConversionsHandler({
      alert: async (failure) => { secondPayloads.push(failure); },
      loadKv: async () => kv,
      httpClient: recovered,
      squareRetry: { sleep: noWait, random: () => 0 },
    })({
      method: 'GET',
      headers: { authorization: 'Bearer cron-secret' },
      query: {},
    }, second);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(secondPayloads, []);
    assert.deepEqual(
      uploadPosts(recovered).map((post) => post.body.conversions[0].orderId).sort(),
      [...DEFERRED_ORDER_IDS].sort(),
    );
    for (const orderId of DEFERRED_ORDER_IDS) {
      assert.equal(await ledger.has(orderId), true, `${orderId} did not retry`);
    }
    assert.equal(await ledger.has('order-ca'), false);
    assert.equal(uploadPosts(recovered).some((post) => post.body.conversions[0].orderId === 'order-good'), false);
  });

  const blankId = IDS.square;
  const uploads = [];
  const isolatedLedger = createDailyUploadLedger(createFakeKv());
  const first = await runDailyOfflineConversions({
    payments: [
      payment({ id: 'pay-blank', orderId: 'order-blank', customerId: blankId, gclid: 'click-blank' }),
      payment({ id: 'pay-good', orderId: 'order-good', customerId: IDS.good }),
    ],
    customersById: {
      [blankId]: {},
      [IDS.good]: usCustomer,
    },
    customerLookupFailures: [{
      customerId: blankId,
      error: `Square customer fetch failed for ${blankId}: timeout`,
    }],
    ledger: isolatedLedger,
    uploadConversion: async (value) => {
      uploads.push(value);
      return { success: true, googleRequestId: 'req-1' };
    },
  });
  assert.deepEqual(uploads.map((row) => row.orderId), ['order-good']);
  assert.equal(await isolatedLedger.has('order-blank'), false);
  assert.equal(JSON.stringify(first.errors).includes(blankId), false);
  assert.equal(first.debug, undefined);

  uploads.length = 0;
  const second = await runDailyOfflineConversions({
    payments: [payment({ id: 'pay-blank', orderId: 'order-blank', customerId: blankId, gclid: 'click-blank' })],
    customersById: { [blankId]: usCustomer },
    ledger: isolatedLedger,
    uploadConversion: async (value) => {
      uploads.push(value);
      return { success: true, googleRequestId: 'req-2' };
    },
  });
  assert.deepEqual(uploads.map((row) => row.orderId), ['order-blank']);
  assert.equal(second.uploadedCount, 1);
  assert.equal(await isolatedLedger.has('order-blank'), true);
  assert.equal(uploads[0].consentStatus, 'GRANTED');
});

test('customer lookup failures keep consent denial and do not hash or upload phone numbers', async () => {
  const kv = createFakeKv();
  const client = squareClient();
  await withCronEnv(async () => {
    const res = createResponse();
    await createOfflineConversionsHandler({
      alert: async () => {},
      loadKv: async () => kv,
      httpClient: client,
      squareRetry: { sleep: noWait, random: () => 0 },
    })({
      method: 'GET',
      headers: { authorization: 'Bearer cron-secret' },
      query: {},
    }, res);
    const posts = uploadPosts(client);
    assert.equal(posts.length, 1);
    const conversion = posts[0].body.conversions[0];
    assert.equal(conversion.orderId, 'order-good');
    assert.deepEqual(conversion.consent, { adUserData: 'GRANTED' });
    assert.deepEqual(conversion.userIdentifiers, [{
      userIdentifierSource: 'FIRST_PARTY',
      hashedEmail: hashEmail(EMAIL),
    }]);
    assert.equal(JSON.stringify(posts[0].body).includes('hashedPhone'), false);
    assert.equal(JSON.stringify(posts[0].body).includes(PHONE), false);
    assert.equal(JSON.stringify(posts[0].body).includes(hashPhone(PHONE)), false);
    assert.equal(JSON.stringify(posts[0].body).includes('+16125550199'), false);
    assert.equal(res.body.orders.some((row) => row.orderId === 'order-ca'), false);
    assert.deepEqual(res.body.orders[0].identifierTypes, ['hashed_email']);
  });

  const uploads = [];
  const denied = await runDailyOfflineConversions({
    payments: [
      payment({ id: 'pay-denied', orderId: 'order-denied', customerId: 'customer-denied' }),
      payment({ id: 'pay-good', orderId: 'order-good', customerId: IDS.good }),
    ],
    customersById: {
      'customer-denied': usCustomer,
      [IDS.good]: usCustomer,
    },
    store: {
      async listPendingJobs(customerId) {
        if (customerId !== 'customer-denied') return [];
        return [{ consentStatus: 'DENIED' }];
      },
    },
    ledger: createDailyUploadLedger(createFakeKv()),
    uploadConversion: async (value) => {
      uploads.push(value);
      return { success: true };
    },
  });
  assert.deepEqual(uploads.map((row) => row.orderId), ['order-good']);
  assert.equal(uploads[0].phone, PHONE);
  assert.deepEqual(uploads[0] && denied.orders[0].identifierTypes, ['hashed_email']);
  assert.equal(denied.rejected.find((row) => row.orderId === 'order-denied').reason, 'consent_denied');
  assert.equal(denied.uploadedCount, 1);
});

test('thrown, logged, and alerted customer-lookup failures omit customer ids of every length', async () => {
  const kv = createFakeKv();
  const client = squareClient();
  const directFetches = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    directFetches.push(args);
    throw new Error('unexpected fetch');
  };
  const { payloads, deliveries, alert } = alertRecorder();
  try {
    await withCronEnv(async ({ logs, errors }) => {
      const res = createResponse();
      await createOfflineConversionsHandler({
        alert,
        loadKv: async () => kv,
        httpClient: client,
        squareRetry: { sleep: noWait, random: () => 0 },
      })({
        method: 'GET',
        headers: { authorization: 'Bearer cron-secret' },
        query: {},
      }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(directFetches.length, 0);
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0].kind, 'offline_conversions_failed');
      assert.equal(deliveries.length, 2);
      const surfaces = [res.body, logs, errors, payloads, deliveries.map((row) => row.body)];
      for (const surface of surfaces) assertNoCustomerIds('customer lookup surface', surface);
      assert.match(errors.map((entry) => JSON.stringify(entry)).join('\n'), /Square customer fetch failed/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dry-run offline conversion cron sends no alerts when a customer lookup fails', async () => {
  const kv = createFakeKv();
  const ledger = createDailyUploadLedger(kv);
  const client = squareClient();
  const { payloads, deliveries, alert } = alertRecorder();
  const directFetches = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    directFetches.push(args);
    return { ok: true };
  };
  try {
    await withCronEnv(async () => {
      const res = createResponse();
      await createOfflineConversionsHandler({
        alert,
        loadKv: async () => kv,
        httpClient: client,
        squareRetry: { sleep: noWait, random: () => 0 },
      })({
        method: 'GET',
        headers: { authorization: 'Bearer cron-secret' },
        query: { validateOnly: '1' },
      }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.validateOnly, true);
      assert.deepEqual(uploadPosts(client).map((post) => post.body.conversions[0].orderId), ['order-good']);
      assert.equal(uploadPosts(client)[0].body.validateOnly, true);
      assert.equal(payloads.length, 0);
      assert.equal(deliveries.length, 0);
      assert.equal(directFetches.length, 0);
      assert.equal(await ledger.has('order-good'), false);
      for (const orderId of DEFERRED_ORDER_IDS) assert.equal(await ledger.has(orderId), false);
      assert.deepEqual(res.body.errors.map((row) => row.orderId).sort(), [...DEFERRED_ORDER_IDS].sort());
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('q-alert redacts Square-style customer ids, including a 26-character id, and still shows location ids', async () => {
  const token32 = 'a'.repeat(32);
  const leaked = [
    `Square customer fetch failed for ${IDS.square}: 504`,
    `bare ${LETTERS_26}`,
    `location ${LOCATION_ID}: 504`,
    `location ${LOCATION_26}: 504`,
    `secret ${token32}`,
    `GET https://connect.squareup.com/v2/customers/${IDS.short}`,
    `GET https://connect.squareup.com/v2/customers/${IDS.long}`,
  ].join(' ');
  const sanitized = redactAlertText(leaked);
  assert.equal(sanitizeAlertText(leaked).includes(IDS.square), false);
  assert.equal(sanitized.includes(IDS.square), false);
  assert.equal(sanitized.includes(LETTERS_26), false);
  assert.equal(sanitized.includes(IDS.short), false);
  assert.equal(sanitized.includes(IDS.long), false);
  assert.equal(sanitized.includes(token32), false);
  assert.match(sanitized, new RegExp(LOCATION_ID));
  assert.match(sanitized, new RegExp(LOCATION_26));
  assert.match(sanitized, /\[customer\]/);
  assert.match(sanitized, /\[token\]/);
  assert.equal(
    redactSquareCustomerIds('customers/1287907452/conversionActions/7509313857'),
    'customers/1287907452/conversionActions/7509313857',
  );

  const posts = [];
  const result = await deliverQAlert({
    kind: 'offline_conversions_failed',
    subject: 'Offline conversions cron failed',
    body: `failed ${IDS.square} ${LETTERS_26} location ${LOCATION_ID} /v2/customers/${IDS.short}`,
    env: {
      AGENTMAIL_API_KEY: 'am-key',
      AGENTMAIL_INBOX_ID: 'inbox-1',
      Q_ALERT_WEBHOOK_URL: 'https://alerts.example/hook',
    },
    fetchImpl: async (url, init) => {
      posts.push({ url: String(url), body: String(init.body) });
      if (String(url).includes('agentmail')) return { ok: false, status: 502 };
      return { ok: true };
    },
  });
  assert.equal(result.channel, 'webhook');
  assert.equal(posts.length, 2);
  assert.match(posts[0].url, /agentmail/);
  assert.equal(posts[1].url, 'https://alerts.example/hook');
  for (const post of posts) {
    assert.equal(post.body.includes(IDS.square), false);
    assert.equal(post.body.includes(LETTERS_26), false);
    assert.equal(post.body.includes(IDS.short), false);
    assert.match(post.body, new RegExp(LOCATION_ID));
  }
});
