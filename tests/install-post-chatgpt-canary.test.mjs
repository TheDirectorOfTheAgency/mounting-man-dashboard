import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { createChatGptInstallationService } from '../lib/install-post-chatgpt-service.mjs';
import { DESTINATION_DEFINITIONS } from '../lib/install-post-chatgpt.mjs';
import { normalizeInstallationPhoto } from '../lib/install-post-chatgpt-photo.mjs';
import { canonicalRevision } from '../lib/install-post-queue.mjs';

const NOW = Date.parse('2026-08-12T18:00:00.000Z');

function record(jobId, size, room) {
  const seed = {
    'street-name': 'Susan Drive', city: 'Austin', 'tv-brand': 'Samsung', 'tv-size': size, 'room-type': room,
  };
  return {
    jobId, seed, image: null, revision: canonicalRevision({ seed, image: null }),
    state: 'AWAITING_PHOTO', approval: null, chatgptPreview: null, lease: null, result: null,
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
  };
}

function storeFor(records) {
  const map = new Map(records.map((entry) => [entry.jobId, structuredClone(entry)]));
  const leases = new Set();
  return {
    map,
    async listJobIds() { return [...map.keys()]; },
    async loadRecord(id) { return map.has(id) ? structuredClone(map.get(id)) : null; },
    async withRecordLock(id, mutator) {
      const next = await mutator(structuredClone(map.get(id)));
      if (!next) return { ok: false, reason: 'aborted' };
      map.set(id, structuredClone(next));
      return { ok: true, record: structuredClone(next) };
    },
    async claimPublishLease({ jobId, revision }) {
      const key = `${jobId}:${revision}`;
      if (leases.has(key)) return 'duplicate';
      leases.add(key);
      return 'claimed';
    },
    async releasePublishLease({ jobId, revision }) {
      leases.delete(`${jobId}:${revision}`);
      return true;
    },
  };
}

test('synthetic M1-free canary disambiguates, reverse-binds photos, previews, and refuses dispatch', async () => {
  const living = record('job_111111aaaaaa', '65-inch', 'living room');
  const bedroom = record('job_222222bbbbbb', '55-inch', 'bedroom');
  const store = storeFor([living, bedroom]);
  const imageByPath = new Map();
  imageByPath.set('/bedroom', await sharp({
    create: { width: 40, height: 30, channels: 3, background: 'green' },
  }).withMetadata({ orientation: 6 }).jpeg().toBuffer());
  imageByPath.set('/living', await sharp({
    create: { width: 30, height: 40, channels: 3, background: 'red' },
  }).withMetadata({ orientation: 3 }).jpeg().toBuffer());
  const audit = { async assertAvailable() {}, async record() {} };
  const service = createChatGptInstallationService({
    store,
    audit,
    now: () => NOW,
    nonceFactory: () => 'synthetic-approval-nonce-1234567890',
    allowedFileHosts: ['files.openai.example'],
    async lookupImpl() { return [{ address: '203.0.113.10', family: 4 }]; },
    async fetchImpl(url) {
      return new Response(imageByPath.get(new URL(url).pathname), { headers: { 'content-type': 'image/jpeg' } });
    },
    photoStore: {
      normalize: normalizeInstallationPhoto,
      async store({ normalized }) {
        return {
          sha256: normalized.sha256,
          bytes: normalized.bytes,
          contentType: normalized.contentType,
          hostedUrl: `https://cdn.example.test/${normalized.sha256}.webp`,
        };
      },
    },
    previewer: {
      async preview({ seed, noNetwork }) {
        assert.equal(noNetwork, true);
        const label = `${seed['tv-size']} ${seed['room-type']}`;
        return {
          website: { title: `Synthetic ${label}`, body: '<p>Synthetic fixture</p>' },
          destinations: Object.fromEntries(DESTINATION_DEFINITIONS
            .filter((entry) => entry.id !== 'website')
            .map((entry) => [entry.id, `${entry.label}: ${label}`])),
        };
      },
    },
  });

  assert.equal((await service.resolveInstallationReference({ reference: 'Susan Drive Samsung' })).status, 'ambiguous');

  // Receive the second job's photo first. Exact job/revision binding—not arrival
  // order—decides which installation receives each normalized digest.
  const bedroomAttached = await service.attachInstallationPhoto({
    jobId: bedroom.jobId,
    revision: bedroom.revision,
    actor: { sub: 'synthetic-owner' },
    photo: {
      download_url: 'https://files.openai.example/bedroom', file_id: 'file_bedroom', mime_type: 'image/jpeg',
    },
  });
  const livingAttached = await service.attachInstallationPhoto({
    jobId: living.jobId,
    revision: living.revision,
    actor: { sub: 'synthetic-owner' },
    photo: {
      download_url: 'https://files.openai.example/living', file_id: 'file_living', mime_type: 'image/jpeg',
    },
  });
  assert.notEqual(bedroomAttached.job.image.sha256, livingAttached.job.image.sha256);

  const preview = await service.previewInstallationPost({
    jobId: living.jobId,
    revision: livingAttached.job.revision,
    actor: { sub: 'synthetic-owner' },
  });
  assert.equal(preview.preview.binding.destinationManifest.length, 8);
  assert.doesNotMatch(JSON.stringify(store.map.get(living.jobId)), /synthetic-approval-nonce/);
  await assert.rejects(service.publishInstallationEverywhere({
    jobId: living.jobId,
    manifestId: preview.preview.manifestId,
    approvalNonce: preview.approvalNonce,
    actor: { sub: 'synthetic-owner' },
  }), /production_publish_disabled/);
});

test('synthetic publisher suppresses replay and retries transient failures only', async () => {
  const candidate = record('job_333333cccccc', '65-inch', 'living room');
  candidate.image = {
    sha256: 'a'.repeat(64),
    bytes: 100,
    contentType: 'image/webp',
    hostedUrl: 'https://synthetic.invalid/photo.webp',
  };
  candidate.revision = canonicalRevision({ seed: candidate.seed, image: candidate.image });
  candidate.state = 'READY';
  const store = storeFor([candidate]);
  const dispatches = [];
  const audit = { async assertAvailable() {}, async record() {} };
  const service = createChatGptInstallationService({
    store,
    audit,
    publishEnabled: true,
    now: () => NOW,
    nonceFactory: () => 'synthetic-approval-nonce-1234567890',
    previewer: {
      async preview() {
        return {
          website: { title: 'Synthetic only', body: '<p>No external write.</p>' },
          destinations: Object.fromEntries(DESTINATION_DEFINITIONS
            .filter((entry) => entry.id !== 'website')
            .map((entry) => [entry.id, `Synthetic ${entry.label}`])),
        };
      },
    },
    publisher: {
      async dispatch(payload) { dispatches.push({ type: 'publish', ...payload }); },
      async retry(payload) { dispatches.push({ type: 'retry', ...payload }); },
    },
  });
  const preview = await service.previewInstallationPost({
    jobId: candidate.jobId,
    revision: candidate.revision,
    actor: { sub: 'synthetic-owner' },
  });
  const first = await service.publishInstallationEverywhere({
    jobId: candidate.jobId,
    manifestId: preview.preview.manifestId,
    approvalNonce: preview.approvalNonce,
    actor: { sub: 'synthetic-owner' },
  });
  const duplicate = await service.publishInstallationEverywhere({
    jobId: candidate.jobId,
    manifestId: preview.preview.manifestId,
    approvalNonce: preview.approvalNonce,
    actor: { sub: 'synthetic-owner' },
  });
  assert.equal(first.status, 'DISPATCHED');
  assert.equal(duplicate.status, 'ALREADY_DISPATCHED');
  assert.equal(dispatches.filter((entry) => entry.type === 'publish').length, 1);
  assert.deepEqual(Object.keys(dispatches[0]).sort(), [
    'dispatchId', 'jobId', 'manifestId', 'revision', 'type',
  ].sort());

  const current = store.map.get(candidate.jobId);
  current.result = {
    destinations: DESTINATION_DEFINITIONS.map((entry) => ({
      id: entry.id,
      required: entry.id !== 'reddit_samsung_frame_mounting',
      status: entry.id === 'website' ? 'VERIFIED'
        : entry.id === 'linkedin' ? 'TRANSIENT_FAILURE'
          : entry.id === 'x' ? 'INDETERMINATE'
            : entry.id === 'reddit_samsung_frame_mounting' ? 'SKIPPED' : 'POSTED',
    })),
  };
  store.map.set(candidate.jobId, current);
  const retryChallenge = await service.retryFailedDestinations({
    jobId: candidate.jobId,
    manifestId: preview.preview.manifestId,
    destinationIds: ['linkedin'],
    actor: { sub: 'synthetic-owner' },
  });
  assert.equal(retryChallenge.status, 'REAPPROVAL_REQUIRED');
  const retry = await service.retryFailedDestinations({
    jobId: candidate.jobId,
    manifestId: preview.preview.manifestId,
    approvalNonce: retryChallenge.approvalNonce,
    destinationIds: retryChallenge.destinationIds,
    actor: { sub: 'synthetic-owner' },
  });
  const retryReplay = await service.retryFailedDestinations({
    jobId: candidate.jobId,
    manifestId: preview.preview.manifestId,
    approvalNonce: retryChallenge.approvalNonce,
    destinationIds: retryChallenge.destinationIds,
    actor: { sub: 'synthetic-owner' },
  });
  assert.deepEqual(retry.destinationIds, ['linkedin']);
  assert.equal(retryReplay.status, 'ALREADY_DISPATCHED');
  assert.equal(dispatches.filter((entry) => entry.type === 'retry').length, 1);
});
