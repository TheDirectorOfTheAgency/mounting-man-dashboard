import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOperatorLinks, verifyJobCapability } from '../lib/install-post-queue.mjs';
import { createInstallPostStore } from '../lib/install-post-store.mjs';
import { notifyQInstallPost } from '../pages/api/webhooks/square-payment.js';

const SECRET = 'test-capability-secret';
const BASE_URL = 'https://mounting-man-dashboard.vercel.app';
const KRONKITE_URL = 'https://kronkite.example/square-wake';

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

const TWO_TV_LINE_ITEMS = [
  {
    name: '65 Inch TV Mounting',
    variation_name: 'Samsung Over Stone Fireplace',
    quantity: '1',
    base_price_money: { amount: 45000 },
  },
  {
    name: '55 Inch TV Mounting',
    variation_name: 'Samsung Drywall',
    quantity: '1',
    base_price_money: { amount: 15000 },
  },
];

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

// ---------------------------------------------------------------------------
// Pure link building
// ---------------------------------------------------------------------------

test('buildOperatorLinks issues one distinct, job-bound link per TV', () => {
  const records = [
    { jobId: 'job_1111', seed: { city: 'Edina', 'tv-size': '65"', 'seed-index': 1, 'seed-count': 2 } },
    { jobId: 'job_2222', seed: { city: 'Edina', 'tv-size': '55"', 'seed-index': 2, 'seed-count': 2 } },
  ];

  const links = buildOperatorLinks({ records, secret: SECRET, baseUrl: BASE_URL, issuedAt: 1000, ttlSeconds: 600 });

  assert.equal(links.length, 2);
  assert.notEqual(links[0].url, links[1].url);
  assert.ok(links[0].label.includes('65"'));
  assert.ok(links[1].label.includes('55"'));

  for (const [index, link] of links.entries()) {
    const url = new URL(link.url);
    // The capability rides in the fragment, which no server, proxy, or access
    // log ever sees. The path and query must carry nothing at all.
    assert.equal(url.origin, BASE_URL);
    assert.equal(url.pathname, '/install-posts/open');
    assert.equal(url.search, '');

    const verified = verifyJobCapability(url.hash.slice(1), { secret: SECRET, now: 1200 });
    assert.equal(verified.ok, true);
    assert.equal(verified.jobId, records[index].jobId);
  }
});

test('no operator URL carries the capability anywhere a log could record it', () => {
  const records = [{ jobId: 'job_1111', seed: { city: 'Edina', 'tv-size': '65"' } }];
  const [link] = buildOperatorLinks({ records, secret: SECRET, baseUrl: BASE_URL, issuedAt: 1000 });

  const url = new URL(link.url);
  const capability = url.hash.slice(1);
  assert.ok(capability.length > 0);
  // Everything a request line, referrer, or access log would contain.
  assert.ok(!`${url.pathname}${url.search}`.includes(capability), url.href);
  assert.equal(url.href.indexOf(capability), url.href.indexOf('#') + 1);
  assert.equal(url.href.split('#').length, 2);
});

test('buildOperatorLinks returns nothing when it is not configured', () => {
  const records = [{ jobId: 'job_1', seed: { city: 'Edina' } }];
  assert.deepEqual(buildOperatorLinks({ records, secret: '', baseUrl: BASE_URL }), []);
  assert.deepEqual(buildOperatorLinks({ records, secret: SECRET, baseUrl: '' }), []);
});

// ---------------------------------------------------------------------------
// Phone-first handoff + Kronkite wake (no Discord install-thread)
// ---------------------------------------------------------------------------

async function runNotifier({ store, lineItems = TWO_TV_LINE_ITEMS } = {}) {
  const posts = [];
  const result = await notifyQInstallPost(
    {
      orderId: 'order-1',
      payment: { id: 'payment-1', team_member_id: 'TMSiHOOr7RGdl2Ki', source_type: 'CARD' },
      invoice: {},
      isInvoiceEvent: false,
      eventType: 'payment.created',
      firstName: 'Test',
      lastName: 'Customer',
      customer: CUSTOMER,
      amount: '600.00',
      amountCents: 60000,
    },
    {
      exists: async () => false,
      set: async () => true,
      rpush: async () => true,
      sadd: async () => true,
      installPostStore: store,
      capabilitySecret: SECRET,
      queueBaseUrl: BASE_URL,
      kronkiteUrl: KRONKITE_URL,
      kronkiteKey: 'kronkite-sender-key',
      httpClient: {
        async get() { return { data: { order: { id: 'order-1', line_items: lineItems } } }; },
        async post(url, body, config) { posts.push({ url, body, headers: config?.headers || {} }); return { data: {} }; },
      },
    },
  );
  return { posts, result };
}

test('the notifier stages one cloud job per TV without posting Discord', async () => {
  const store = createInstallPostStore(createFakeKv());
  const { posts, result } = await runNotifier({ store });

  const jobIds = await store.listJobIds();
  assert.equal(jobIds.length, 2);
  assert.equal(result.operatorLinks.length, 2);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, KRONKITE_URL);
  assert.equal(posts.some(({ url }) => String(url).includes('1485380804707090643')), false);

  const urls = result.operatorLinks.map((link) => link.url);
  assert.equal(new Set(urls).size, 2);

  const linkedJobIds = urls.map((url) => verifyJobCapability(new URL(url).hash.slice(1), {
    secret: SECRET,
    now: Date.now(),
  }).jobId);
  assert.deepEqual(linkedJobIds.slice().sort(), jobIds.slice().sort());
});

test('Kronkite payload and staged seeds carry safe labels and no customer identity', async () => {
  const store = createInstallPostStore(createFakeKv());
  const { posts, result } = await runNotifier({ store });

  const payload = JSON.stringify(posts[0].body);
  for (const forbidden of ['Test Customer', '4821', '55424', SECRET, 'kronkite-sender-key']) {
    assert.ok(!payload.includes(forbidden), `Kronkite payload leaked ${forbidden}`);
  }
  assert.equal(posts[0].body.streetName, 'Elm Street');
  assert.equal(posts[0].body.city, 'Edina');
  assert.ok(!payload.includes('@'), payload);

  const jobIds = await store.listJobIds();
  for (const jobId of jobIds) {
    const record = await store.loadRecord(jobId);
    const seed = JSON.stringify(record.seed);
    for (const forbidden of ['Test Customer', '4821', '55424', 'order-1', 'payment-1', SECRET]) {
      assert.ok(!seed.includes(forbidden), `job seed leaked ${forbidden}`);
    }
    assert.ok(seed.includes('Elm Street'), seed);
  }

  assert.ok(result.operatorLinks.every((link) => link.label.includes('65"') || link.label.includes('55"')));
});

test('the notifier still wakes Kronkite, without links, when the cloud queue is unconfigured', async () => {
  const { posts, result } = await runNotifier({ store: null });
  assert.deepEqual(result.operatorLinks, []);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, KRONKITE_URL);
  assert.equal(posts[0].body.paymentId, 'payment-1');
  assert.equal(posts.some(({ url }) => String(url).includes('discord.com')), false);
});

test('a webhook retry re-links the same jobs instead of creating new cards', async () => {
  const store = createInstallPostStore(createFakeKv());
  const first = await runNotifier({ store });
  const second = await runNotifier({ store });

  assert.equal((await store.listJobIds()).length, 2);
  const extract = ({ result }) => result.operatorLinks
    .map((link) => verifyJobCapability(new URL(link.url).hash.slice(1), { secret: SECRET, now: Date.now() }).jobId)
    .sort();
  assert.deepEqual(extract(first), extract(second));
});
