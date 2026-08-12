import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { createChatGptInstallationService } from '../lib/install-post-chatgpt-service.mjs';
import { DESTINATION_DEFINITIONS } from '../lib/install-post-chatgpt.mjs';
import { normalizeInstallationPhoto } from '../lib/install-post-chatgpt-photo.mjs';
import { canonicalRevision } from '../lib/install-post-queue.mjs';

const NOW = Date.parse('2026-08-12T18:00:00.000Z');
const ACTOR = { sub: 'owner-subject' };

function makeRecord(jobId, seed, minutesAgo = 1) {
  const image = null;
  return {
    jobId,
    seed,
    image,
    revision: canonicalRevision({ seed, image }),
    state: 'AWAITING_PHOTO',
    approval: null,
    chatgptPreview: null,
    lease: null,
    result: null,
    createdAt: new Date(NOW - minutesAgo * 60000).toISOString(),
    updatedAt: new Date(NOW - minutesAgo * 60000).toISOString(),
  };
}

function fakeStore(records) {
  const map = new Map(records.map((entry) => [entry.jobId, structuredClone(entry)]));
  const leases = new Set();
  return {
    map,
    async listJobIds() { return [...map.keys()]; },
    async loadRecord(id) { return map.has(id) ? structuredClone(map.get(id)) : null; },
    async withRecordLock(id, mutator) {
      const current = await this.loadRecord(id);
      if (!current) return { ok: false, reason: 'not_found' };
      const next = await mutator(current);
      if (!next) return { ok: false, reason: 'aborted', record: current };
      map.set(id, structuredClone(next));
      return { ok: true, record: structuredClone(next) };
    },
    async claimPublishLease({ jobId, revision }) {
      const key = `${jobId}:${revision}`;
      if (leases.has(key)) return 'duplicate';
      leases.add(key);
      return 'claimed';
    },
    async releasePublishLease({ jobId, revision }) { return leases.delete(`${jobId}:${revision}`); },
  };
}

function previewer() {
  return {
    async preview({ noNetwork }) {
      assert.equal(noNetwork, true);
      return {
        website: { title: 'Synthetic installation', body: '<p>Synthetic only</p>' },
        destinations: Object.fromEntries(DESTINATION_DEFINITIONS
          .filter((entry) => entry.id !== 'website')
          .map((entry) => [entry.id, `${entry.label} synthetic caption`])),
      };
    },
  };
}

function auditLog() {
  const entries = [];
  return { entries, async assertAvailable() {}, async record(entry) { entries.push(entry); } };
}

test('lists stable privacy-safe pages and resolves ambiguity without guessing', async () => {
  const store = fakeStore([
    makeRecord('job_111111aaaaaa', { 'street-name': 'Susan Drive', city: 'Austin', 'tv-size': '65-inch' }, 1),
    makeRecord('job_222222bbbbbb', { 'street-name': 'Susan Drive', city: 'Austin', 'tv-size': '55-inch' }, 2),
  ]);
  const service = createChatGptInstallationService({ store, now: () => NOW });
  const first = await service.listPendingInstallations({ limit: 1 });
  assert.equal(first.installations.length, 1);
  assert.ok(first.nextCursor);
  const second = await service.listPendingInstallations({ limit: 1, cursor: first.nextCursor });
  assert.notEqual(second.installations[0].jobId, first.installations[0].jobId);
  assert.equal((await service.resolveInstallationReference({ reference: 'Susan Drive' })).status, 'ambiguous');
});

test('file descriptor download, normalization, storage, and binding are server controlled', async () => {
  const record = makeRecord('job_111111aaaaaa', { city: 'Austin', 'tv-size': '65-inch' });
  const store = fakeStore([record]);
  const audit = auditLog();
  const jpeg = await sharp({
    create: { width: 32, height: 24, channels: 3, background: 'blue' },
  }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const service = createChatGptInstallationService({
    store,
    audit,
    allowedFileHosts: ['files.openai.example'],
    now: () => NOW,
    async lookupImpl() { return [{ address: '203.0.113.10', family: 4 }]; },
    async fetchImpl() { return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }); },
    photoStore: {
      normalize: normalizeInstallationPhoto,
      async store({ normalized }) {
        return {
          sha256: normalized.sha256,
          bytes: normalized.bytes,
          contentType: normalized.contentType,
          hostedUrl: 'https://cdn.example.test/synthetic.webp',
        };
      },
    },
  });
  const attached = await service.attachInstallationPhoto({
    jobId: record.jobId,
    revision: record.revision,
    actor: ACTOR,
    photo: {
      download_url: 'https://files.openai.example/opaque',
      file_id: 'file_synthetic',
      mime_type: 'image/jpeg',
    },
  });
  assert.equal(attached.job.state, 'READY');
  assert.match(attached.job.image.sha256, /^[0-9a-f]{64}$/);
  assert.equal(audit.entries[0].actorHash.length, 64);
  assert.equal(JSON.stringify(audit.entries).includes('owner-subject'), false);
});

test('preview stores a nonce hash, rejects replay after mutation, and publish fails closed', async () => {
  const original = makeRecord('job_111111aaaaaa', { city: 'Austin', 'gallery-style': true });
  original.image = {
    sha256: 'a'.repeat(64), bytes: 100, contentType: 'image/webp', hostedUrl: 'https://cdn.example.test/a.webp',
  };
  original.revision = canonicalRevision({ seed: original.seed, image: original.image });
  original.state = 'READY';
  const store = fakeStore([original]);
  const audit = auditLog();
  const service = createChatGptInstallationService({
    store,
    audit,
    previewer: previewer(),
    now: () => NOW,
    nonceFactory: () => 'returned-once-only',
  });
  const result = await service.previewInstallationPost({
    jobId: original.jobId, revision: original.revision, actor: ACTOR,
  });
  assert.equal(result.approvalNonce, 'returned-once-only');
  assert.doesNotMatch(JSON.stringify(store.map.get(original.jobId)), /returned-once-only/);
  assert.equal((await service.getInstallationPublishStatus({
    jobId: original.jobId, manifestId: result.preview.manifestId,
  })).destinations.length, 8);
  await assert.rejects(service.publishInstallationEverywhere({
    jobId: original.jobId,
    manifestId: result.preview.manifestId,
    approvalNonce: result.approvalNonce,
    actor: ACTOR,
  }), /production_publish_disabled/);
});

test('Webflow verification does not conceal a failed social destination', async () => {
  const record = makeRecord('job_111111aaaaaa', { city: 'Austin' });
  record.result = {
    destinations: DESTINATION_DEFINITIONS.map((entry) => ({
      id: entry.id,
      required: entry.id !== 'reddit_samsung_frame_mounting',
      status: entry.id === 'website' ? 'VERIFIED'
        : (entry.id === 'linkedin' ? 'TRANSIENT_FAILURE'
          : (entry.id === 'reddit_samsung_frame_mounting' ? 'SKIPPED' : 'POSTED')),
    })),
  };
  const service = createChatGptInstallationService({ store: fakeStore([record]), now: () => NOW });
  const status = await service.getInstallationPublishStatus({ jobId: record.jobId });
  assert.equal(status.overall, 'PARTIAL');
  assert.deepEqual(status.retryableDestinationIds, ['linkedin']);
});

test('a failed dispatch consumes approval and cannot dispatch the same manifest twice', async () => {
  const record = makeRecord('job_111111aaaaaa', { city: 'Austin' });
  record.image = {
    sha256: 'a'.repeat(64), bytes: 100, contentType: 'image/webp', hostedUrl: 'https://cdn.example.test/a.webp',
  };
  record.revision = canonicalRevision({ seed: record.seed, image: record.image });
  record.state = 'READY';
  const store = fakeStore([record]);
  let calls = 0;
  const service = createChatGptInstallationService({
    store,
    audit: auditLog(),
    previewer: previewer(),
    publishEnabled: true,
    now: () => NOW,
    nonceFactory: () => 'single-use-approval',
    publisher: { async dispatch() { calls += 1; throw new Error('uncertain network result'); } },
  });
  const preview = await service.previewInstallationPost({
    jobId: record.jobId, revision: record.revision, actor: ACTOR,
  });
  const input = {
    jobId: record.jobId,
    manifestId: preview.preview.manifestId,
    approvalNonce: preview.approvalNonce,
    actor: ACTOR,
  };
  await assert.rejects(service.publishInstallationEverywhere(input), /canonical_dispatch_indeterminate/);
  const replay = await service.publishInstallationEverywhere(input);
  assert.equal(replay.status, 'DISPATCH_INDETERMINATE');
  assert.equal(calls, 1);
  assert.ok(store.map.get(record.jobId).chatgptPreview.approvalConsumedAt);
});

test('retry requires a fresh destination-bound nonce and consumes it once', async () => {
  const record = makeRecord('job_111111aaaaaa', { city: 'Austin' });
  record.image = {
    sha256: 'a'.repeat(64), bytes: 100, contentType: 'image/webp', hostedUrl: 'https://cdn.example.test/a.webp',
  };
  record.revision = canonicalRevision({ seed: record.seed, image: record.image });
  record.state = 'RETRYABLE_FAILURE';
  record.chatgptPreview = {
    manifestId: 'manifest_' + 'a'.repeat(64),
    approvalNonceHash: 'consumed',
    approvalExpiresAt: new Date(NOW + 60_000).toISOString(),
    approvalConsumedAt: new Date(NOW - 60_000).toISOString(),
    binding: {
      jobId: record.jobId,
      recordRevision: record.revision,
      photoSha256: record.image.sha256,
      destinationManifestVersion: 'installation-post-destinations-v1',
      destinationManifest: DESTINATION_DEFINITIONS.map((entry) => ({
        id: entry.id, expected: !entry.conditional, required: !entry.conditional,
      })),
    },
  };
  record.result = {
    destinations: DESTINATION_DEFINITIONS.map((entry) => ({
      id: entry.id,
      status: entry.id === 'website' ? 'VERIFIED'
        : (entry.id === 'linkedin' ? 'TRANSIENT_FAILURE'
          : (entry.conditional ? 'SKIPPED' : 'POSTED')),
    })),
  };
  const store = fakeStore([record]);
  const calls = [];
  const service = createChatGptInstallationService({
    store,
    audit: auditLog(),
    publishEnabled: true,
    now: () => NOW,
    nonceFactory: () => 'fresh-retry-approval',
    publisher: { async retry(payload) { calls.push(payload); } },
  });
  const request = {
    jobId: record.jobId,
    manifestId: record.chatgptPreview.manifestId,
    destinationIds: ['linkedin'],
    actor: ACTOR,
  };
  const challenge = await service.retryFailedDestinations(request);
  assert.equal(challenge.status, 'REAPPROVAL_REQUIRED');
  assert.equal(challenge.approvalNonce, 'fresh-retry-approval');
  const sent = await service.retryFailedDestinations({
    ...request, approvalNonce: challenge.approvalNonce,
  });
  assert.equal(sent.status, 'DISPATCHED');
  const replay = await service.retryFailedDestinations({
    ...request, approvalNonce: challenge.approvalNonce,
  });
  assert.equal(replay.status, 'ALREADY_DISPATCHED');
  assert.equal(calls.length, 1);
});

test('audit failure after a publish claim prevents external dispatch and consumes the nonce safely', async () => {
  const record = makeRecord('job_111111aaaaaa', { city: 'Austin' });
  record.image = {
    sha256: 'a'.repeat(64), bytes: 100, contentType: 'image/webp', hostedUrl: 'https://cdn.example.test/a.webp',
  };
  record.revision = canonicalRevision({ seed: record.seed, image: record.image });
  record.state = 'READY';
  const store = fakeStore([record]);
  let dispatched = false;
  const service = createChatGptInstallationService({
    store,
    audit: {
      async assertAvailable() {},
      async record(entry) {
        if (entry.result === 'dispatch_claimed') throw new Error('audit unavailable');
      },
    },
    previewer: previewer(),
    publishEnabled: true,
    now: () => NOW,
    nonceFactory: () => 'single-use-approval',
    publisher: { async dispatch() { dispatched = true; } },
  });
  const preview = await service.previewInstallationPost({
    jobId: record.jobId, revision: record.revision, actor: ACTOR,
  });
  await assert.rejects(service.publishInstallationEverywhere({
    jobId: record.jobId,
    manifestId: preview.preview.manifestId,
    approvalNonce: preview.approvalNonce,
    actor: ACTOR,
  }), /audit_unavailable/);
  assert.equal(dispatched, false);
  assert.equal(store.map.get(record.jobId).state, 'BLOCKED');
  assert.ok(store.map.get(record.jobId).chatgptPreview.approvalConsumedAt);
});
