import assert from 'node:assert/strict';
import test from 'node:test';

import { INSTALL_POST_STATES } from '../lib/install-post-queue.mjs';
import {
  buildJobRecords,
  createInstallPostStore,
  decodeStoredRecord,
  importLegacyPendingRecord,
  installPostJobId,
} from '../lib/install-post-store.mjs';

const SOURCE_REFS = {
  orderId: 'ORDER-ABC-123',
  paymentId: 'PAY-XYZ-789',
  invoiceId: '',
  customerName: 'Jane Doe',
};

const TWO_TV_SEEDS = [
  {
    city: 'Edina',
    'tv-size': '65"',
    'tv-brand': 'Samsung',
    'wall-surface': 'Stone',
    price: '$450',
    'street-name': '4821 Elm Street',
    'seed-index': 1,
    'seed-count': 2,
    'source-order-id': 'ORDER-ABC-123',
    'source-payment-id': 'PAY-XYZ-789',
  },
  {
    city: 'Edina',
    'tv-size': '55"',
    'tv-brand': 'Samsung',
    'wall-surface': 'Drywall',
    price: '$150',
    'street-name': '4821 Elm Street',
    'seed-index': 2,
    'seed-count': 2,
    'source-order-id': 'ORDER-ABC-123',
    'source-payment-id': 'PAY-XYZ-789',
  },
];

function createFakeKv({ failOn = new Set() } = {}) {
  const values = new Map();
  const sets = new Map();
  return {
    values,
    sets,
    async get(key) {
      if (failOn.has('get')) throw new Error('kv unavailable');
      return values.has(key) ? values.get(key) : null;
    },
    async set(key, value, options = {}) {
      if (failOn.has('set')) throw new Error('kv unavailable');
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async del(key) {
      if (failOn.has('del')) throw new Error('kv unavailable');
      values.delete(key);
      return 1;
    },
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(member);
      return 1;
    },
    async srem(key, member) {
      sets.get(key)?.delete(member);
      return 1;
    },
    async smembers(key) {
      return [...(sets.get(key) || [])];
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy decoding
// ---------------------------------------------------------------------------

test('decodeStoredRecord unwraps repeatedly JSON-encoded Upstash values', () => {
  const record = { jobId: 'job_1', seed: { city: 'Edina' } };
  assert.deepEqual(decodeStoredRecord(record), record);
  assert.deepEqual(decodeStoredRecord(JSON.stringify(record)), record);
  assert.deepEqual(decodeStoredRecord(JSON.stringify(JSON.stringify(record))), record);
  assert.deepEqual(decodeStoredRecord(JSON.stringify(JSON.stringify(JSON.stringify(record)))), record);
  assert.equal(decodeStoredRecord(null), null);
  assert.equal(decodeStoredRecord('not json'), null);
});

// ---------------------------------------------------------------------------
// Opaque, deterministic job identity
// ---------------------------------------------------------------------------

test('installPostJobId is opaque, deterministic, and unique per TV', () => {
  const first = installPostJobId({ ...SOURCE_REFS, seedIndex: 1 });
  const second = installPostJobId({ ...SOURCE_REFS, seedIndex: 2 });

  assert.match(first, /^job_[0-9a-f]{16}$/);
  assert.notEqual(first, second);
  assert.equal(first, installPostJobId({ ...SOURCE_REFS, seedIndex: 1 }));
  assert.ok(!first.includes('ORDER'));
  assert.ok(!first.includes('PAY'));
});

// ---------------------------------------------------------------------------
// One normalized record per candidate TV
// ---------------------------------------------------------------------------

test('buildJobRecords stages exactly one unapproved record per TV', () => {
  const records = buildJobRecords({
    seeds: TWO_TV_SEEDS,
    sourceRefs: SOURCE_REFS,
    source: 'square-webhook',
    stagedAt: '2026-08-12T15:00:00.000Z',
  });

  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((r) => r.jobId)).size, 2);
  for (const record of records) {
    assert.equal(record.state, INSTALL_POST_STATES.AWAITING_PHOTO);
    assert.equal(record.approval, null);
    assert.equal(record.lease, null);
    assert.equal(record.image, null);
    assert.match(record.revision, /^[0-9a-f]{64}$/);
  }
  assert.equal(records[0].seed['tv-size'], '65"');
  assert.equal(records[1].seed['tv-size'], '55"');
  assert.notEqual(records[0].revision, records[1].revision);
});

test('staged records carry no customer, order, payment, or street-number data', () => {
  const records = buildJobRecords({
    seeds: TWO_TV_SEEDS,
    sourceRefs: SOURCE_REFS,
    source: 'square-webhook',
    stagedAt: '2026-08-12T15:00:00.000Z',
  });

  const serialized = JSON.stringify(records);
  for (const forbidden of ['ORDER-ABC-123', 'PAY-XYZ-789', 'Jane Doe', '4821']) {
    assert.ok(!serialized.includes(forbidden), `record leaked ${forbidden}`);
  }
  assert.equal(records[0].seed['street-name'], 'Elm Street');
});

test('historical pending records import as unapproved and never as published', () => {
  const legacy = JSON.stringify(JSON.stringify({
    seed: TWO_TV_SEEDS[0],
    seeds: TWO_TV_SEEDS,
    seedCount: 2,
    orderId: 'ORDER-ABC-123',
    paymentId: 'PAY-XYZ-789',
    customerName: 'Jane Doe',
    stagedAt: '2026-08-01T10:00:00.000Z',
    source: 'square-webhook',
  }));

  const records = importLegacyPendingRecord(legacy);
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.state, INSTALL_POST_STATES.AWAITING_PHOTO);
    assert.equal(record.approval, null);
    assert.equal(record.lease, null);
  }
  assert.ok(!JSON.stringify(records).includes('Jane Doe'));
});

test('importLegacyPendingRecord tolerates records with a single seed or none', () => {
  assert.equal(importLegacyPendingRecord({ seed: TWO_TV_SEEDS[0], orderId: 'O1' }).length, 1);
  assert.equal(importLegacyPendingRecord({ orderId: 'O1' }).length, 0);
  assert.equal(importLegacyPendingRecord(null).length, 0);
});

// ---------------------------------------------------------------------------
// Store round-trips and source-ref isolation
// ---------------------------------------------------------------------------

test('stageJobRecords persists records, indexes them, and isolates source refs', async () => {
  const kv = createFakeKv();
  const store = createInstallPostStore(kv);

  const records = await store.stageJobRecords({
    seeds: TWO_TV_SEEDS,
    sourceRefs: SOURCE_REFS,
    source: 'square-webhook',
    stagedAt: '2026-08-12T15:00:00.000Z',
  });

  assert.equal(records.length, 2);
  const jobIds = await store.listJobIds();
  assert.deepEqual(jobIds.sort(), records.map((r) => r.jobId).sort());

  const loaded = await store.loadRecord(records[0].jobId);
  assert.equal(loaded.jobId, records[0].jobId);
  assert.equal(loaded.seed['tv-size'], '65"');

  // Source refs live under a separate key that the mobile API never reads.
  const refs = await store.loadSourceRefs(records[0].jobId);
  assert.equal(refs.orderId, 'ORDER-ABC-123');

  const byPayment = await store.findRecordsBySource({ paymentId: 'PAY-XYZ-789' });
  assert.equal(byPayment.length, 2);
  const byOrder = await store.findRecordsBySource({ orderId: 'ORDER-ABC-123' });
  assert.equal(byOrder.length, 2);
  const missing = await store.findRecordsBySource({ paymentId: 'PAY-NONE' });
  assert.equal(missing.length, 0);
  const recordKeys = [...kv.values.keys()].filter((key) => key.includes(':job:'));
  for (const key of recordKeys) {
    assert.ok(!JSON.stringify(kv.values.get(key)).includes('ORDER-ABC-123'));
  }
});

test('re-staging the same Square job is idempotent and preserves progress', async () => {
  const kv = createFakeKv();
  const store = createInstallPostStore(kv);
  const args = {
    seeds: TWO_TV_SEEDS,
    sourceRefs: SOURCE_REFS,
    source: 'square-webhook',
    stagedAt: '2026-08-12T15:00:00.000Z',
  };

  const first = await store.stageJobRecords(args);
  const image = { sha256: 'c'.repeat(64), bytes: 1000, contentType: 'image/webp' };
  await store.saveRecord({ ...first[0], image, state: INSTALL_POST_STATES.READY });

  const second = await store.stageJobRecords(args);
  assert.deepEqual(second.map((r) => r.jobId), first.map((r) => r.jobId));
  const reloaded = await store.loadRecord(first[0].jobId);
  assert.equal(reloaded.state, INSTALL_POST_STATES.READY);
  assert.equal(reloaded.image.sha256, image.sha256);
});

// ---------------------------------------------------------------------------
// Atomic publish lease
// ---------------------------------------------------------------------------

test('claimPublishLease admits one dispatch per revision', async () => {
  const kv = createFakeKv();
  const store = createInstallPostStore(kv);

  assert.equal(await store.claimPublishLease({ jobId: 'job_1', revision: 'rev1', dispatchId: 'd1' }), 'claimed');
  assert.equal(await store.claimPublishLease({ jobId: 'job_1', revision: 'rev1', dispatchId: 'd2' }), 'duplicate');
  // A different revision is a different approval, so it gets its own lease.
  assert.equal(await store.claimPublishLease({ jobId: 'job_1', revision: 'rev2', dispatchId: 'd3' }), 'claimed');
});

test('concurrent Publish taps produce exactly one claim', async () => {
  const kv = createFakeKv();
  const store = createInstallPostStore(kv);

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => store.claimPublishLease({
      jobId: 'job_1',
      revision: 'rev1',
      dispatchId: `d${i}`,
    })),
  );
  assert.equal(results.filter((r) => r === 'claimed').length, 1);
  assert.equal(results.filter((r) => r === 'duplicate').length, 4);
});

test('releasePublishLease only reopens a retryable revision', async () => {
  const kv = createFakeKv();
  const store = createInstallPostStore(kv);

  await store.claimPublishLease({ jobId: 'job_1', revision: 'rev1', dispatchId: 'd1' });
  await store.releasePublishLease({ jobId: 'job_1', revision: 'rev1' });
  assert.equal(await store.claimPublishLease({ jobId: 'job_1', revision: 'rev1', dispatchId: 'd2' }), 'claimed');
});

test('lease claims fail closed when the store is unreachable', async () => {
  const store = createInstallPostStore(createFakeKv({ failOn: new Set(['set']) }));
  assert.equal(await store.claimPublishLease({ jobId: 'job_1', revision: 'rev1', dispatchId: 'd1' }), 'unavailable');
});

// ---------------------------------------------------------------------------
// Serialized read-modify-write
// ---------------------------------------------------------------------------

test('withRecordLock serializes mutations and rejects a contended write', async () => {
  const kv = createFakeKv();
  const store = createInstallPostStore(kv);
  const [record] = await store.stageJobRecords({
    seeds: [TWO_TV_SEEDS[0]],
    sourceRefs: SOURCE_REFS,
    source: 'square-webhook',
    stagedAt: '2026-08-12T15:00:00.000Z',
  });

  let release;
  const held = new Promise((resolve) => { release = resolve; });

  const slow = store.withRecordLock(record.jobId, async (current) => {
    await held;
    return { ...current, state: INSTALL_POST_STATES.READY };
  });

  const contended = await store.withRecordLock(record.jobId, async (current) => current);
  assert.equal(contended.ok, false);
  assert.equal(contended.reason, 'locked');

  release();
  const done = await slow;
  assert.equal(done.ok, true);
  assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.READY);

  // Lock is released afterwards, so the next writer succeeds.
  const after = await store.withRecordLock(record.jobId, async (current) => current);
  assert.equal(after.ok, true);
});

test('withRecordLock reports a missing job rather than inventing one', async () => {
  const store = createInstallPostStore(createFakeKv());
  const result = await store.withRecordLock('job_missing', async (current) => current);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});
