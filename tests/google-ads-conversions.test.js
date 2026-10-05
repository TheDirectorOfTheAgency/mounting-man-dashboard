import assert from 'node:assert/strict';
import test from 'node:test';

import { uploadOfflineConversion } from '../lib/google-ads-conversions.js';

function conversionInput() {
  return {
    email: 'private.customer@example.com',
    phone: '+16125550123',
    conversionValue: 500,
    conversionDateTime: '2026-07-10T15:30:00.000Z',
    orderId: 'opaque-job-ref',
    consentStatus: 'GRANTED',
  };
}

function installEnv(t) {
  const previous = process.env.GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID;
  process.env.GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID = '7509313857';
  t.after(() => {
    if (previous === undefined) delete process.env.GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID;
    else process.env.GOOGLE_ADS_OFFLINE_CONVERSION_ACTION_ID = previous;
  });
}

test('Google conversion writes retain direct-owner headers and omit login-customer-id', async (t) => {
  installEnv(t);
  let request;
  const result = await uploadOfflineConversion(conversionInput(), {
    getAccessToken: async () => 'access-token',
    getDeveloperToken: () => 'developer-token',
    httpClient: {
      async post(url, payload, config) {
        request = { url, payload, config };
        return { data: { jobId: 'google-job' }, headers: { 'request-id': 'request-1' } };
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(request.config.headers['developer-token'], 'developer-token');
  assert.equal(request.config.headers.Authorization, 'Bearer access-token');
  assert.equal('login-customer-id' in request.config.headers, false);
  assert.equal(request.payload.validateOnly, false);
  assert.deepEqual(request.payload.conversions[0].consent, { adUserData: 'GRANTED' });
  assert.equal(request.payload.conversions[0].consent.adPersonalization, undefined);
  assert.equal(request.payload.conversions[0].gclid, undefined);
  assert.equal(request.payload.debugEnabled, undefined);
});

test('debugEnabled is sent only when the single-order canary asks for it', async (t) => {
  installEnv(t);
  let request;
  await uploadOfflineConversion({
    ...conversionInput(),
    debugEnabled: true,
  }, {
    getAccessToken: async () => 'access-token',
    getDeveloperToken: () => 'developer-token',
    httpClient: {
      async post(url, payload) {
        request = { url, payload };
        return { data: {}, headers: {} };
      },
    },
  });
  assert.equal(request.payload.debugEnabled, true);
  assert.equal(request.payload.validateOnly, false);
});

test('gclid is sent when present and gbraid is omitted alongside it', async (t) => {
  installEnv(t);
  let request;
  await uploadOfflineConversion({
    ...conversionInput(),
    gclid: 'click-1',
    gbraid: 'braid-1',
  }, {
    getAccessToken: async () => 'access-token',
    getDeveloperToken: () => 'developer-token',
    httpClient: {
      async post(url, payload) {
        request = { url, payload };
        return { data: {}, headers: {} };
      },
    },
  });
  assert.equal(request.payload.conversions[0].gclid, 'click-1');
  assert.equal(request.payload.conversions[0].gbraid, undefined);
  assert.equal(request.payload.conversions[0].wbraid, undefined);
  assert.equal(
    request.payload.conversions[0].conversionAction,
    'customers/1287907452/conversionActions/7509313857',
  );
});

test('wbraid is sent only when gclid and gbraid are absent', async (t) => {
  installEnv(t);
  let request;
  await uploadOfflineConversion({
    ...conversionInput(),
    wbraid: 'web-braid-1',
  }, {
    getAccessToken: async () => 'access-token',
    getDeveloperToken: () => 'developer-token',
    httpClient: {
      async post(url, payload) {
        request = { url, payload };
        return { data: {}, headers: {} };
      },
    },
  });
  assert.equal(request.payload.conversions[0].gclid, undefined);
  assert.equal(request.payload.conversions[0].gbraid, undefined);
  assert.equal(request.payload.conversions[0].wbraid, 'web-braid-1');
});

test('Google partial failure is retryable when the returned status is transient', async (t) => {
  installEnv(t);
  const result = await uploadOfflineConversion(conversionInput(), {
    getAccessToken: async () => 'access-token',
    getDeveloperToken: () => 'developer-token',
    httpClient: {
      async post() {
        return {
          data: {
            partialFailureError: {
              code: 13,
              status: 'INTERNAL',
              message: 'Transient server error',
            },
          },
          headers: {},
        };
      },
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.retryable, true);
  assert.equal(result.errorCode, 'GOOGLE_PARTIAL_FAILURE');
});
