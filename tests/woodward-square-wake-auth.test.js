// Regression: live Woodward desk accepts Authorization: Bearer only.
// x-webhook-secret alone is 401. A later x-webhook-secret-only edit must fail here.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWoodwardWakeHeaders,
  forwardWoodwardSquareWake,
  hasWoodwardBearerAuthorization,
  notifyQInstallPost,
  resetWoodwardMissingUrlLog,
  woodwardWebhookKey,
  woodwardWebhookUrl,
} from '../lib/notify-install-post.mjs';

const WAKE_URL = 'https://woodward.example/square-wake';
const SENDER_KEY = 'woodward-sender-key';

function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/** Same contract as the live webhook: Bearer required, secret header is not enough. */
function createWoodwardDeskLikeClient({ expectedKey } = {}) {
  const posts = [];
  return {
    posts,
    async get() {
      return { data: { order: { id: 'order-auth', line_items: [] } } };
    },
    async post(url, body, config) {
      const headers = config?.headers || {};
      posts.push({ url, body, headers });
      const auth = headerValue(headers, 'authorization');
      const accepted = typeof auth === 'string'
        && auth.startsWith('Bearer ')
        && (!expectedKey || auth === `Bearer ${expectedKey}`);
      if (!accepted) {
        const err = new Error('Unauthorized');
        err.response = { status: 401, data: { error: 'Unauthorized' } };
        throw err;
      }
      return { data: { ok: true } };
    },
  };
}

test('Woodward desk env prefers WOODWARD_* and reads pre-rename names only as a fallback', () => {
  const legacy = {
    KRONKITE_SQUARE_WEBHOOK_URL: 'https://legacy.example/wake',
    KRONKITE_SQUARE_WEBHOOK_KEY: 'legacy-key',
  };
  assert.equal(woodwardWebhookUrl(legacy), 'https://legacy.example/wake');
  assert.equal(woodwardWebhookKey(legacy), 'legacy-key');

  const both = { ...legacy, WOODWARD_SQUARE_WEBHOOK_URL: WAKE_URL, WOODWARD_SQUARE_WEBHOOK_KEY: SENDER_KEY };
  assert.equal(woodwardWebhookUrl(both), WAKE_URL);
  assert.equal(woodwardWebhookKey(both), SENDER_KEY);

  assert.equal(woodwardWebhookUrl({}), undefined);
});

test('buildWoodwardWakeHeaders always includes Authorization Bearer when a key exists', () => {
  const headers = buildWoodwardWakeHeaders(`  ${SENDER_KEY}  `);
  assert.equal(hasWoodwardBearerAuthorization(headers), true);
  assert.equal(headers.Authorization, `Bearer ${SENDER_KEY}`);
  assert.equal(headers['x-webhook-secret'], SENDER_KEY);
  assert.equal(buildWoodwardWakeHeaders(''), null);
  assert.equal(buildWoodwardWakeHeaders('   '), null);
  assert.equal(hasWoodwardBearerAuthorization({ 'x-webhook-secret': SENDER_KEY }), false);
  assert.equal(hasWoodwardBearerAuthorization({ Authorization: 'Bearer' }), false);
});

test('forwardWoodwardSquareWake is 401 on the live contract if Bearer is omitted', async () => {
  const client = createWoodwardDeskLikeClient({ expectedKey: SENDER_KEY });
  const secretOnly = await forwardWoodwardSquareWake({
    payload: { paymentId: 'payment-secret-only' },
    url: WAKE_URL,
    key: SENDER_KEY,
    httpClient: {
      async post(url, body) {
        return client.post(url, body, {
          headers: {
            'Content-Type': 'application/json',
            'x-webhook-secret': SENDER_KEY,
          },
        });
      },
    },
  });
  assert.equal(secretOnly.forwarded, false);
  assert.equal(secretOnly.error, true);

  const withBearer = await forwardWoodwardSquareWake({
    payload: { paymentId: 'payment-bearer' },
    url: WAKE_URL,
    key: SENDER_KEY,
    httpClient: client,
  });
  assert.equal(withBearer.forwarded, true);
  assert.equal(client.posts.length, 2);
  assert.equal(headerValue(client.posts[1].headers, 'authorization'), `Bearer ${SENDER_KEY}`);
});

test('paid-job notify POST forwards only when Authorization Bearer is present', async () => {
  const client = createWoodwardDeskLikeClient({ expectedKey: SENDER_KEY });
  const result = await notifyQInstallPost(
    {
      orderId: 'order-auth',
      payment: { id: 'payment-auth', source_type: 'CARD' },
      invoice: {},
      isInvoiceEvent: false,
      eventType: 'payment.created',
      firstName: 'Pat',
      lastName: 'Customer',
      customer: { address: { locality: 'Minneapolis' } },
      amount: '200.00',
      amountCents: 20000,
    },
    {
      exists: async () => false,
      set: async () => true,
      sadd: async () => true,
      woodwardUrl: WAKE_URL,
      woodwardKey: SENDER_KEY,
      httpClient: client,
    },
  );

  assert.equal(result.woodward.forwarded, true);
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].url, WAKE_URL);
  assert.equal(headerValue(client.posts[0].headers, 'authorization'), `Bearer ${SENDER_KEY}`);
  assert.ok(hasWoodwardBearerAuthorization(client.posts[0].headers));
});

test('wake with a URL but no key does not POST without Bearer', async () => {
  resetWoodwardMissingUrlLog();
  const logs = [];
  let posted = false;
  const result = await forwardWoodwardSquareWake({
    payload: { paymentId: 'payment-no-key' },
    url: WAKE_URL,
    key: '   ',
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
    httpClient: {
      async post() {
        posted = true;
        return { data: {} };
      },
    },
  });

  assert.equal(posted, false);
  assert.equal(result.skipped, 'missing_key');
  assert.equal(result.forwarded, undefined);
  assert.equal(
    logs.filter(([level, msg]) => level === 'warn' && String(msg).includes('refusing wake without Bearer auth')).length,
    1,
  );
});
