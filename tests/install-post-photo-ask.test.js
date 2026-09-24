import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PHOTO_ASK_KIND,
  buildPhotoAskText,
  buildPhotoAskWebhookPayload,
  deliverPhotoAsk,
  readPhotoAskConfig,
  resetPhotoAskMissingChannelLog,
} from '../lib/install-post-photo-ask.mjs';
import { HOLD_REASONS } from '../lib/install-post-confidence.mjs';
import { transitionRecord, verifyJobCapability } from '../lib/install-post-queue.mjs';
import { createInstallPostStore } from '../lib/install-post-store.mjs';
import { notifyQInstallPost } from '../lib/notify-install-post.mjs';

const SECRET = 'test-capability-secret';
const BASE_URL = 'https://mounting-man-dashboard.vercel.app';
const WOODWARD_URL = 'https://woodward.example/square-wake';
const PHOTO_ASK_URL = 'https://operator.example/photo-ask';
const TWILIO_SID = 'AC_test_sid';
const OPERATOR_PHONE = '+15555550100';

const CUSTOMER = {
  given_name: 'Test',
  family_name: 'Customer',
  address: {
    address_line_1: '4821 Elm Street',
    locality: 'Edina',
    administrative_district_level_1: 'MN',
    postal_code: '55424',
  },
};

const IMAGE = {
  sha256: 'a'.repeat(64),
  bytes: 320_000,
  contentType: 'image/webp',
  assetId: 'asset-1',
  hostedUrl: 'https://cdn.example.com/65-inch-samsung.webp',
  md5: 'b'.repeat(32),
};

const LINE_ITEMS = [{ name: '65" TV Installation', quantity: '1', base_price_money: { amount: 45000 } }];

function createFakeKv() {
  const values = new Map();
  const sets = new Map();
  return {
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async del(key) { values.delete(key); return 1; },
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(member);
      return 1;
    },
    async srem(key, member) { sets.get(key)?.delete(member); return 1; },
    async smembers(key) { return [...(sets.get(key) || [])]; },
  };
}

function createHttpClient({ failUrls = [] } = {}) {
  const posts = [];
  return {
    posts,
    async get() { return { data: { order: { id: 'order-1', line_items: LINE_ITEMS } } }; },
    async post(url, body, config) {
      posts.push({ url, body, headers: config?.headers || {} });
      if (failUrls.some((prefix) => String(url).startsWith(prefix))) {
        const err = new Error('boom');
        err.response = { status: 500 };
        throw err;
      }
      return { data: {} };
    },
  };
}

const quietLogger = { info() {}, warn() {}, error() {} };

async function runNotifier({ store, photoAskConfig, httpClient = createHttpClient(), firstName = 'Test' } = {}) {
  const result = await notifyQInstallPost(
    {
      orderId: 'order-1',
      payment: { id: 'payment-1', source_type: 'CARD' },
      invoice: {},
      isInvoiceEvent: false,
      eventType: 'payment.created',
      firstName,
      lastName: 'Customer',
      customer: CUSTOMER,
      amount: '450.00',
      amountCents: 45000,
    },
    {
      exists: async () => false,
      set: async () => true,
      sadd: async () => true,
      installPostStore: store === undefined ? createInstallPostStore(createFakeKv()) : store,
      capabilitySecret: SECRET,
      queueBaseUrl: BASE_URL,
      woodwardUrl: WOODWARD_URL,
      woodwardKey: 'woodward-sender-key',
      photoAskConfig,
      dispatcher: { async dispatch(payload) { return { dispatchId: payload.dispatchId }; } },
      httpClient,
      logger: quietLogger,
    },
  );
  return { result, posts: httpClient.posts };
}

const WEBHOOK_CONFIG = { webhookUrl: PHOTO_ASK_URL, webhookKey: 'photo-ask-key' };
const SMS_CONFIG = {
  smsTo: OPERATOR_PHONE,
  twilioSid: TWILIO_SID,
  twilioToken: 'twilio-token',
  twilioFrom: '+15555550199',
};

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

test('photo ask text and webhook payload carry the label and upload link', () => {
  const links = [{ jobId: 'job_1', label: '65" Samsung · Elm Street, Edina', url: `${BASE_URL}/install-posts/open#cap` }];
  const text = buildPhotoAskText(links);
  assert.match(text, /^Add install photo & publish/);
  assert.ok(text.includes(`65" Samsung · Elm Street, Edina → ${BASE_URL}/install-posts/open#cap`));

  const payload = buildPhotoAskWebhookPayload(links);
  assert.equal(payload.kind, PHOTO_ASK_KIND);
  assert.equal(payload.deskAction, 'add_photo');
  assert.equal(payload.url, links[0].url);
  assert.equal(payload.defaultAction.url, links[0].url);
  assert.deepEqual(payload.links, [{ label: links[0].label, url: links[0].url }]);
  assert.equal(JSON.stringify(payload).includes('job_1'), false);
});

test('multi-TV photo ask lists one link per job', () => {
  const text = buildPhotoAskText([
    { label: '65"', url: 'https://a.example/1' },
    { label: '55"', url: 'https://a.example/2' },
  ]);
  assert.ok(text.includes('2 TVs, one link each'));
  assert.ok(text.includes('65" → https://a.example/1'));
  assert.ok(text.includes('55" → https://a.example/2'));
});

test('readPhotoAskConfig reads only the photo-ask and Twilio env names', () => {
  const config = readPhotoAskConfig({
    INSTALL_POST_PHOTO_ASK_URL: ` ${PHOTO_ASK_URL} `,
    INSTALL_POST_PHOTO_ASK_KEY: 'k',
    INSTALL_POST_PHOTO_ASK_SMS_TO: OPERATOR_PHONE,
    TWILIO_ACCOUNT_SID: TWILIO_SID,
    TWILIO_AUTH_TOKEN: 't',
  });
  assert.equal(config.webhookUrl, PHOTO_ASK_URL);
  assert.equal(config.smsTo, OPERATOR_PHONE);
  assert.equal(config.twilioFrom, '+19526496388');
});

test('deliverPhotoAsk reports no_channel once and never posts when unconfigured', async () => {
  resetPhotoAskMissingChannelLog();
  const warnings = [];
  const client = createHttpClient();
  const logger = { info() {}, warn: (msg) => warnings.push(msg) };
  const links = [{ label: '65"', url: 'https://a.example/1' }];
  const first = await deliverPhotoAsk({ links, httpClient: client, config: {}, logger });
  const second = await deliverPhotoAsk({ links, httpClient: client, config: {}, logger });
  assert.equal(first.delivered, false);
  assert.equal(first.skipped, 'no_channel');
  assert.equal(second.skipped, 'no_channel');
  assert.equal(client.posts.length, 0);
  assert.equal(warnings.length, 1);
});

// ---------------------------------------------------------------------------
// notifyQInstallPost: payment without photo
// ---------------------------------------------------------------------------

test('payment without photo sends the upload link by webhook and does not wake Woodward', async () => {
  const { result, posts } = await runNotifier({ photoAskConfig: WEBHOOK_CONFIG });

  assert.equal(posts.some(({ url }) => url === WOODWARD_URL), false, 'photo ask must not wake Woodward');
  assert.equal(result.woodward.skipped, 'photo_ask_delivered');
  assert.equal(result.woodwardPayload.deskAction, 'none');
  assert.equal(result.photoAsk.delivered, true);
  assert.equal(result.photoAsk.channels.webhook.forwarded, true);

  const asks = posts.filter(({ url }) => url === PHOTO_ASK_URL);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].headers.Authorization, 'Bearer photo-ask-key');
  assert.equal(asks[0].body.kind, PHOTO_ASK_KIND);
  assert.equal(asks[0].body.url, result.operatorLinks[0].url);
  const verified = verifyJobCapability(new URL(asks[0].body.url).hash.slice(1), { secret: SECRET, now: Date.now() });
  assert.equal(verified.ok, true);
  assert.equal(verified.jobId, result.operatorLinks[0].jobId);
});

test('payment without photo sends the upload link by SMS when Twilio is configured', async () => {
  const { result, posts } = await runNotifier({ photoAskConfig: SMS_CONFIG });

  assert.equal(posts.some(({ url }) => url === WOODWARD_URL), false);
  assert.equal(result.photoAsk.delivered, true);
  const sms = posts.filter(({ url }) => String(url).includes(`/Accounts/${TWILIO_SID}/Messages.json`));
  assert.equal(sms.length, 1);
  const form = new URLSearchParams(sms[0].body);
  assert.equal(form.get('To'), OPERATOR_PHONE);
  assert.ok(form.get('Body').includes(result.operatorLinks[0].url));
  assert.ok(form.get('Body').startsWith('Mounting Man — Add install photo'));
});

test('photo ask carries no customer identity and the status result carries no link', async () => {
  const { result, posts } = await runNotifier({ photoAskConfig: { ...WEBHOOK_CONFIG, ...SMS_CONFIG } });
  const outbound = JSON.stringify(posts.map(({ body }) => body));
  for (const forbidden of ['Test Customer', '4821', '55424', 'payment-1', 'order-1', SECRET]) {
    assert.ok(!outbound.includes(forbidden), `photo ask leaked ${forbidden}`);
  }
  const status = JSON.stringify(result.photoAsk);
  assert.equal(status.includes('install-posts/open'), false, status);
  assert.deepEqual(Object.keys(result.photoAsk.channels).sort(), ['sms', 'webhook']);
});

test('Woodward is the fallback when no photo-ask channel is configured', async () => {
  const { result, posts } = await runNotifier({ photoAskConfig: {} });
  assert.equal(result.photoAsk.skipped, 'no_channel');
  const wakes = posts.filter(({ url }) => url === WOODWARD_URL);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].body.deskAction, 'request_photo');
  assert.equal(JSON.stringify(wakes[0].body).includes('install-posts/open'), false);
});

test('Woodward is the fallback when every photo-ask channel fails', async () => {
  const httpClient = createHttpClient({ failUrls: [PHOTO_ASK_URL] });
  const { result, posts } = await runNotifier({ photoAskConfig: WEBHOOK_CONFIG, httpClient });
  assert.equal(result.photoAsk.delivered, false);
  assert.equal(result.photoAsk.channels.webhook.error, true);
  const wakes = posts.filter(({ url }) => url === WOODWARD_URL);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].body.deskAction, 'request_photo');
});

test('Woodward is the fallback when the cloud queue produced no operator link', async () => {
  const { result, posts } = await runNotifier({ store: null, photoAskConfig: WEBHOOK_CONFIG });
  assert.equal(result.photoAsk.skipped, 'no_operator_links');
  assert.equal(posts.filter(({ url }) => url === PHOTO_ASK_URL).length, 0);
  assert.equal(posts.filter(({ url }) => url === WOODWARD_URL).length, 1);
});

// ---------------------------------------------------------------------------
// notifyQInstallPost: photo already bound
// ---------------------------------------------------------------------------

test('confidence HOLD with a bound photo still wakes Woodward and sends no photo ask', async () => {
  const store = createInstallPostStore(createFakeKv());
  const [staged] = await store.stageJobRecords({
    seeds: [{ city: 'Twin Cities', 'tv-size': '65"', 'street-name': 'Elm Street', 'seed-index': 1, 'seed-count': 1 }],
    sourceRefs: { orderId: 'order-1', paymentId: 'payment-1' },
    source: 'square-webhook',
    stagedAt: '2026-09-20T15:00:00.000Z',
  });
  await store.saveRecord(transitionRecord(staged, { type: 'photo', image: IMAGE }).record);

  const { result, posts } = await runNotifier({ store, photoAskConfig: WEBHOOK_CONFIG });
  assert.equal(result.photoAsk.skipped, 'photo_present');
  assert.equal(posts.filter(({ url }) => url === PHOTO_ASK_URL).length, 0);
  const wakes = posts.filter(({ url }) => url === WOODWARD_URL);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].body.deskAction, 'needs_human');
  assert.ok(wakes[0].body.holdReasons.includes(HOLD_REASONS.METRO_PLACEHOLDER_CITY));
});
