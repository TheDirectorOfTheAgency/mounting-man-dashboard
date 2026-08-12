import assert from 'node:assert/strict';
import test from 'node:test';

import { INSTALL_POST_STATES } from '../lib/install-post-queue.mjs';
import { createInstallPostStore } from '../lib/install-post-store.mjs';
import { migratePendingToCloud } from '../pages/api/install-post/pending.js';

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

const LEGACY_SEEDS = [
  { city: 'Edina', 'tv-size': '65"', 'street-name': '4821 Elm Street', 'seed-index': 1, 'seed-count': 2 },
  { city: 'Edina', 'tv-size': '55"', 'street-name': '4821 Elm Street', 'seed-index': 2, 'seed-count': 2 },
];

const LEGACY_RECORDS = {
  'install-post:pending:order-1': JSON.stringify(JSON.stringify({
    seed: LEGACY_SEEDS[0],
    seeds: LEGACY_SEEDS,
    orderId: 'order-1',
    paymentId: 'payment-1',
    customerName: 'Jane Doe',
    stagedAt: '2026-08-01T10:00:00.000Z',
  })),
  'install-post:pending:order-2': JSON.stringify({
    seed: { city: 'Hopkins', 'tv-size': '75"', 'seed-index': 1, 'seed-count': 1 },
    orderId: 'order-2',
    customerName: 'Other Person',
  }),
};

function legacyReaders(records = LEGACY_RECORDS) {
  return {
    listKeys: async () => Object.keys(records),
    readKey: async (key) => records[key] ?? null,
  };
}

test('legacy pending records migrate into the cloud queue as unapproved jobs', async () => {
  const store = createInstallPostStore(createFakeKv());
  const result = await migratePendingToCloud({ store, ...legacyReaders() });

  assert.equal(result.imported, 3);
  assert.equal(result.skipped, 0);

  const jobIds = await store.listJobIds();
  assert.equal(jobIds.length, 3);

  for (const jobId of jobIds) {
    const record = await store.loadRecord(jobId);
    assert.equal(record.state, INSTALL_POST_STATES.AWAITING_PHOTO);
    assert.equal(record.approval, null);
    assert.equal(record.lease, null);
    assert.equal(record.image, null);
  }
});

test('migration drops customer data and street numbers', async () => {
  const store = createInstallPostStore(createFakeKv());
  await migratePendingToCloud({ store, ...legacyReaders() });

  const records = await Promise.all((await store.listJobIds()).map((id) => store.loadRecord(id)));
  const serialized = JSON.stringify(records);
  for (const forbidden of ['Jane Doe', 'Other Person', 'order-1', 'payment-1', '4821']) {
    assert.ok(!serialized.includes(forbidden), `migration leaked ${forbidden}`);
  }
  assert.ok(serialized.includes('Elm Street'));
});

test('migration is idempotent and never overwrites in-progress work', async () => {
  const store = createInstallPostStore(createFakeKv());
  const first = await migratePendingToCloud({ store, ...legacyReaders() });

  const [jobId] = await store.listJobIds();
  const record = await store.loadRecord(jobId);
  await store.saveRecord({
    ...record,
    state: INSTALL_POST_STATES.READY,
    image: { sha256: 'a'.repeat(64), bytes: 100, contentType: 'image/webp' },
  });

  const second = await migratePendingToCloud({ store, ...legacyReaders() });
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, first.imported);
  assert.equal((await store.loadRecord(jobId)).state, INSTALL_POST_STATES.READY);
  assert.equal((await store.listJobIds()).length, 3);
});

test('migration tolerates expired and unreadable legacy keys', async () => {
  const store = createInstallPostStore(createFakeKv());
  const result = await migratePendingToCloud({
    store,
    listKeys: async () => ['a', 'b', 'c'],
    readKey: async (key) => (key === 'a' ? 'not json' : null),
  });
  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 0);
});
