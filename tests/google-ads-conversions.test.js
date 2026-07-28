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
