import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  deliverQAlert,
  offlineConversionFailureAlert,
  Q_ALERT_SUBJECT_PREFIX,
} from '../lib/q-alert.js';
import { createSquarePaymentHandler } from '../pages/api/webhooks/square-payment.js';
import { createResponse } from './webhook-test-helpers.js';

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      files.push(...await filesUnder(full));
    } else if (/\.(js|mjs|jsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

test('routine alerts are log-only and urgent alerts post to Q', async () => {
  let calls = 0;
  const routine = await deliverQAlert({
    kind: 'booking_created',
    subject: 'New booking',
    body: 'booked',
    env: { Q_ALERT_WEBHOOK_URL: 'https://alerts.example/hook' },
    fetchImpl: async () => { calls += 1; return { ok: true }; },
  });
  assert.equal(routine.reason, 'routine');
  assert.equal(routine.urgent, false);
  assert.equal(calls, 0);

  const unset = await deliverQAlert({
    kind: 'webhook_unhandled_error',
    subject: 'Webhook error',
    body: 'boom',
    env: {},
    fetchImpl: async () => { calls += 1; return { ok: true }; },
  });
  assert.equal(unset.reason, 'not_configured');
  assert.equal(calls, 0);

  const posts = [];
  const delivered = await deliverQAlert({
    kind: 'square_payment_failed',
    subject: 'Square payment failed pay-1',
    body: 'declined',
    env: {
      Q_ALERT_WEBHOOK_URL: 'https://alerts.example/hook',
      Q_ALERT_WEBHOOK_AUTH: 'Bearer q-secret',
    },
    fetchImpl: async (url, init) => {
      posts.push({ url, init });
      return { ok: true };
    },
  });
  assert.equal(delivered.delivered, true);
  assert.equal(delivered.channel, 'webhook');
  assert.equal(posts[0].url, 'https://alerts.example/hook');
  assert.equal(posts[0].init.headers.Authorization, 'Bearer q-secret');
  const body = JSON.parse(posts[0].init.body);
  assert.equal(body.subject, `${Q_ALERT_SUBJECT_PREFIX} Square payment failed pay-1`);
  assert.equal(body.kind, 'square_payment_failed');
  assert.equal(body.urgent, true);
});

test('AgentMail is preferred over the alert webhook when a key and inbox are set', async () => {
  const urls = [];
  const result = await deliverQAlert({
    kind: 'offline_conversions_failed',
    subject: 'Offline conversions cron failed',
    body: 'upload failed',
    env: {
      AGENTMAIL_API_KEY: 'am-key',
      AGENTMAIL_INBOX_ID: 'inbox-1',
      Q_ALERT_WEBHOOK_URL: 'https://alerts.example/hook',
    },
    fetchImpl: async (url, init) => {
      urls.push(url);
      assert.equal(init.headers.Authorization, 'Bearer am-key');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.to, ['agency-q@agentmail.to']);
      assert.equal(body.subject.startsWith(Q_ALERT_SUBJECT_PREFIX), true);
      return { ok: true };
    },
  });
  assert.equal(result.channel, 'agentmail');
  assert.deepEqual(urls, ['https://api.agentmail.to/v0/inboxes/inbox-1/messages']);
});

test('offline conversion failures alert and successful runs do not', () => {
  assert.equal(offlineConversionFailureAlert({ errors: [], stoppedEarly: false }), null);
  assert.equal(
    offlineConversionFailureAlert({ errors: [{ orderId: 'order-1' }] }, { validateOnly: true }),
    null,
  );
  assert.equal(
    offlineConversionFailureAlert({ errors: [{ orderId: 'order-1' }] }).kind,
    'offline_conversions_failed',
  );
  assert.equal(
    offlineConversionFailureAlert(null, { thrown: new Error('Square payments fetch failed') }).kind,
    'offline_conversions_failed',
  );
});

test('failed Square payments alert Q and a normal payment does not', async () => {
  const alerts = [];
  const base = {
    readRawBody: async (req) => JSON.stringify(req.body),
    signatureKey: '',
    httpClient: {
      async get() {
        return {
          data: {
            customer: {
              given_name: 'Private',
              family_name: 'Customer',
              email_address: 'customer@example.com',
              phone_number: '+16125550123',
            },
          },
        };
      },
    },
    followUpClaim: async () => 'claimed',
    operationsNotifier: async () => {},
    installPostNotifier: async () => {},
    reviewRequestStager: async () => ({ status: 'staged' }),
    attributionCoordinator: { async registerPayment() { return { status: 'observed' }; } },
    alert: async (value) => { alerts.push(value); },
  };
  const failedRes = createResponse();
  await createSquarePaymentHandler(base)({
    method: 'POST',
    headers: {},
    body: {
      type: 'payment.updated',
      data: {
        object: {
          payment: {
            id: 'payment-failed',
            customer_id: 'customer-1',
            status: 'FAILED',
            amount_money: { amount: 10000, currency: 'USD' },
          },
        },
      },
    },
  }, failedRes);
  assert.equal(failedRes.body.status, 'ignored');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'square_payment_failed');

  const paidRes = createResponse();
  await createSquarePaymentHandler({
    ...base,
    alert: async () => { throw new Error('routine payment must not alert'); },
  })({
    method: 'POST',
    headers: {},
    body: {
      type: 'payment.updated',
      data: {
        object: {
          payment: {
            id: 'payment-ok',
            customer_id: 'customer-1',
            status: 'COMPLETED',
            amount_money: { amount: 10000, currency: 'USD' },
          },
        },
      },
    },
  }, paidRes);
  assert.equal(paidRes.body.status, 'payment_processed');
  assert.equal(alerts.length, 1);
});

test('application code does not call Discord', async () => {
  const hits = [];
  for (const root of ['lib', 'pages', 'components']) {
    for (const file of await filesUnder(root)) {
      const stripped = stripComments(await readFile(file, 'utf8'));
      if (/discord/i.test(stripped)) hits.push(file);
    }
  }
  assert.deepEqual(hits, []);
});
