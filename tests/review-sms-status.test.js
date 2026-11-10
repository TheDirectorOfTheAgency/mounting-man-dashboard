import assert from 'node:assert/strict';
import test from 'node:test';

import { deliverQAlert, isUrgentAlert } from '../lib/q-alert.js';
import {
  createReviewSmsAlertClaim,
  createTwilioStatusHandler,
  expectedTwilioSignature,
  validateTwilioSignature,
} from '../lib/review-sms.js';
import { createResponse } from './webhook-test-helpers.js';

const AUTH_TOKEN = 'status-test-token';
const URL = 'https://mounting-man-dashboard.vercel.app/api/webhooks/twilio-status';

function form(fields) {
  return new URLSearchParams(fields).toString();
}

function signedRequest(fields, { token = AUTH_TOKEN, url = URL } = {}) {
  const body = form(fields);
  const params = Object.fromEntries(new URLSearchParams(body));
  return {
    method: 'POST',
    headers: { 'x-twilio-signature': expectedTwilioSignature(token, url, params) },
    body,
  };
}

test('matches the Twilio documented HMAC-SHA1 webhook example', () => {
  const params = {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+14158675310',
    Digits: '1234',
    From: '+14158675310',
    To: '+18005551212',
  };
  const url = 'https://example.com/myapp.php?foo=1&bar=2';
  assert.equal(expectedTwilioSignature('12345', url, params), 'L/OH5YylLD5NRKLltdqwSvS0BnU=');
  assert.equal(validateTwilioSignature({
    authToken: '12345',
    signature: 'L/OH5YylLD5NRKLltdqwSvS0BnU=',
    url,
    params,
  }), true);
  assert.equal(validateTwilioSignature({
    authToken: '12345',
    signature: 'L/OH5YylLD5NRKLltdqwSvS0BnU=',
    url,
    params: { ...params, Digits: '9999' },
  }), false);
});

test('status callback rejects a missing token and a bad signature before recording', async () => {
  const records = [];
  const alerts = [];
  const base = {
    signatureUrl: URL,
    record: async (entry) => { records.push(entry); },
    alert: async (entry) => { alerts.push(entry); },
    readRawBody: async (req) => req.body,
  };
  const unconfigured = createResponse();
  await createTwilioStatusHandler({
    ...base,
    authToken: '',
  })(signedRequest({ MessageSid: 'SM1', MessageStatus: 'delivered' }), unconfigured);
  assert.equal(unconfigured.statusCode, 401);

  const forged = signedRequest({ MessageSid: 'SM1', MessageStatus: 'delivered' });
  forged.headers['x-twilio-signature'] = 'not-a-valid-signature';
  const rejected = createResponse();
  await createTwilioStatusHandler({ ...base, authToken: AUTH_TOKEN })(forged, rejected);
  assert.equal(rejected.statusCode, 403);
  assert.equal(records.length, 0);
  assert.equal(alerts.length, 0);
});

test('valid callbacks record delivered and undelivered, and alert on 30034, 30007, and 21610', async () => {
  const records = [];
  const alerts = [];
  const claimed = [];
  const handler = createTwilioStatusHandler({
    authToken: AUTH_TOKEN,
    signatureUrl: URL,
    readRawBody: async (req) => req.body,
    record: async (entry) => { records.push(entry); },
    alert: async (entry) => { alerts.push(entry); },
    claimAlert: async (key) => {
      if (claimed.includes(key)) return false;
      claimed.push(key);
      return true;
    },
  });

  const delivered = createResponse();
  await handler(signedRequest({
    MessageSid: 'SM_delivered',
    MessageStatus: 'delivered',
    To: '+15555550100',
  }), delivered);
  assert.equal(delivered.statusCode, 200);
  assert.equal(delivered.body.messageStatus, 'delivered');
  assert.equal(records[0].messageStatus, 'delivered');
  assert.equal(records[0].errorCode, null);
  assert.equal(alerts.length, 0);

  for (const errorCode of ['30034', '30007', '21610']) {
    const res = createResponse();
    await handler(signedRequest({
      MessageSid: `SM_${errorCode}`,
      MessageStatus: 'undelivered',
      ErrorCode: errorCode,
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(records.at(-1).messageStatus, 'undelivered');
    assert.equal(records.at(-1).errorCode, errorCode);
    assert.equal(alerts.at(-1).kind, 'review_sms_delivery_failed');
    assert.match(alerts.at(-1).body, new RegExp(errorCode));
    assert.equal(alerts.at(-1).body.includes('+1555'), false);
  }
  assert.equal(alerts.length, 3);

  const duplicate = createResponse();
  await handler(signedRequest({
    MessageSid: 'SM_30034',
    MessageStatus: 'undelivered',
    ErrorCode: '30034',
  }), duplicate);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(alerts.length, 3);
});

test('review SMS delivery failure is an urgent alert kind', () => {
  assert.equal(isUrgentAlert('review_sms_delivery_failed'), true);
  assert.equal(isUrgentAlert('review_sms_delivered'), false);
});

test('status callback rejects non-POST', async () => {
  const res = createResponse();
  await createTwilioStatusHandler({ authToken: AUTH_TOKEN })({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 405);
});

function memoryKv() {
  const values = new Map();
  return {
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async del(key) {
      return values.delete(key) ? 1 : 0;
    },
  };
}

function alertHandler({ alert, kv = memoryKv() }) {
  const claim = createReviewSmsAlertClaim({ kv });
  return {
    kv,
    handler: createTwilioStatusHandler({
      authToken: AUTH_TOKEN,
      signatureUrl: URL,
      readRawBody: async (req) => req.body,
      alert,
      claimAlert: (key) => claim.claimAlert(key),
      finalizeAlert: (key) => claim.finalizeAlert(key),
      releaseAlert: (key) => claim.releaseAlert(key),
    }),
  };
}

const FAILED_CALLBACK = {
  MessageSid: 'SM_retry',
  MessageStatus: 'undelivered',
  ErrorCode: '30034',
};

test('a returned alert failure stays retryable and success suppresses the duplicate', async () => {
  const fetches = [];
  let ok = false;
  const { handler, kv } = alertHandler({
    alert: (entry) => deliverQAlert({
      kind: entry.kind,
      subject: entry.subject,
      body: entry.body,
      env: { Q_ALERT_WEBHOOK_URL: 'https://alerts.example/hook' },
      fetchImpl: async () => {
        fetches.push(ok);
        return { ok, status: ok ? 200 : 503 };
      },
    }),
  });

  const failed = createResponse();
  await handler(signedRequest(FAILED_CALLBACK), failed);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.error, 'alert_failed');
  assert.equal(failed.body.retryable, true);
  assert.deepEqual(fetches, [false]);
  assert.equal(await kv.get('review-sms:alert:SM_retry:undelivered:30034'), null);

  ok = true;
  const delivered = createResponse();
  await handler(signedRequest(FAILED_CALLBACK), delivered);
  assert.equal(delivered.statusCode, 200);
  assert.deepEqual(fetches, [false, true]);
  assert.equal(await kv.get('review-sms:alert:SM_retry:undelivered:30034'), 'sent');

  const duplicate = createResponse();
  await handler(signedRequest(FAILED_CALLBACK), duplicate);
  assert.equal(duplicate.statusCode, 200);
  assert.deepEqual(fetches, [false, true]);
});

test('a thrown alert failure releases the claim so a later success can be suppressed', async () => {
  let mode = 'throw';
  let calls = 0;
  const { handler, kv } = alertHandler({
    alert: async () => {
      calls += 1;
      if (mode === 'throw') throw new Error('delivery down');
      return { delivered: true };
    },
  });
  const fields = { MessageSid: 'SM_throw', MessageStatus: 'failed', ErrorCode: '30007' };
  const thrown = createResponse();
  await handler(signedRequest(fields), thrown);
  assert.equal(thrown.statusCode, 500);
  assert.equal(thrown.body.error, 'alert_failed');
  assert.equal(thrown.body.retryable, true);
  assert.equal(await kv.get('review-sms:alert:SM_throw:failed:30007'), null);

  mode = 'ok';
  const delivered = createResponse();
  await handler(signedRequest(fields), delivered);
  assert.equal(delivered.statusCode, 200);
  assert.equal(calls, 2);

  const duplicate = createResponse();
  await handler(signedRequest(fields), duplicate);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(calls, 2);
  assert.equal(await kv.get('review-sms:alert:SM_throw:failed:30007'), 'sent');
});

test('an in-flight alert does not acknowledge a concurrent callback as delivered', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { handler } = alertHandler({
    alert: async () => {
      calls += 1;
      await gate;
      return { delivered: true };
    },
  });
  const fields = { MessageSid: 'SM_race', MessageStatus: 'undelivered', ErrorCode: '21610' };
  const first = createResponse();
  const firstDone = handler(signedRequest(fields), first);
  await new Promise((resolve) => { setImmediate(resolve); });
  const second = createResponse();
  await handler(signedRequest(fields), second);
  assert.equal(second.statusCode, 503);
  assert.equal(second.body.error, 'alert_in_progress');
  assert.equal(calls, 1);
  release();
  await firstDone;
  assert.equal(first.statusCode, 200);
  const third = createResponse();
  await handler(signedRequest(fields), third);
  assert.equal(third.statusCode, 200);
  assert.equal(calls, 1);
});

test('a legacy alert claim stays suppressed', async () => {
  const kv = memoryKv();
  await kv.set('review-sms:alert:SM_old:failed:21610', '1');
  const claim = createReviewSmsAlertClaim({ kv });
  assert.equal(await claim.claimAlert('SM_old:failed:21610'), 'duplicate');
});
