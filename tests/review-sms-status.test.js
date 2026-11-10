import assert from 'node:assert/strict';
import test from 'node:test';

import { isUrgentAlert } from '../lib/q-alert.js';
import {
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
