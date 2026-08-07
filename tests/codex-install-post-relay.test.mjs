import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquireLock,
  assertOpenAIProvider,
  buildCodexSeedPrompt,
  buildMinimalCodexEnvironment,
  normalizeRelayState,
  receiptKey,
  relayPendingSeeds,
  sanitizeSeed,
} from '../scripts/codex-install-post-relay.mjs';

test('sanitizeSeed keeps installation facts while removing customer and source identifiers', () => {
  const sanitized = sanitizeSeed({
    city: 'Minneapolis',
    state: 'MN',
    'street-name': '123 Main Street',
    'tv-size': '65"',
    'wall-surface': 'Drywall',
    'job-notes': 'Call customer@example.com or 612-555-1212 before arrival',
    customerName: 'Private Customer',
    address: '123 Main Street, Minneapolis, MN 55401',
    'source-order-id': 'order-secret',
    'source-payment-id': 'payment-secret',
    'image-path': '/tmp/Private Customer-123 Main Street.jpg',
    'nearby-cities': ['Edina', { customerName: 'Private Customer', email: 'customer@example.com' }],
  });

  assert.deepEqual(sanitized, {
    city: 'Minneapolis',
    state: 'MN',
    'street-name': 'Main Street',
    'tv-size': '65"',
    'wall-surface': 'Drywall',
    'nearby-cities': ['Edina'],
  });
});

test('normalizeRelayState migrates legacy source-bearing receipt keys to opaque hashes', () => {
  const normalized = normalizeRelayState({
    threadId: 'thread-1',
    relayed: { 'install-post:pending:order-secret': '2026-08-01T00:00:00.000Z' },
  });
  assert.equal(normalized.changed, true);
  assert.equal(normalized.state.relayed[receiptKey('install-post:pending:order-secret')], '2026-08-01T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(normalized.state), /order-secret/);
});

test('buildCodexSeedPrompt stages the seed and explicitly forbids publishing', () => {
  const prompt = buildCodexSeedPrompt({
    key: 'install-post:pending:order-1',
    customerName: 'Private Customer',
    seed: { city: 'Eagan', 'tv-size': '75"', 'wall-surface': 'Brick', 'job-notes': 'Private Customer setup' },
  });

  assert.match(prompt, /Installation post seed staged/);
  assert.match(prompt, /Do not publish/);
  assert.match(prompt, /wait for Mr\. Wayne to attach the matching installation photo/i);
  assert.match(prompt, /"city": "Eagan"/);
  assert.doesNotMatch(prompt, /Private Customer/);
  assert.doesNotMatch(prompt, /order-1/);
});

test('relayPendingSeeds skips receipts and records only successful Codex staging turns', async () => {
  const state = { threadId: 'thread-1', relayed: { [receiptKey('install-post:pending:old')]: '2026-08-01T00:00:00.000Z' } };
  const calls = [];
  let saved = null;

  const result = await relayPendingSeeds({
    pending: [
      { key: 'install-post:pending:old', seed: { city: 'Edina' } },
      { key: 'install-post:pending:new', seed: { city: 'Eagan' } },
    ],
    state,
    stageSeed: async ({ threadId, prompt }) => {
      calls.push({ threadId, prompt });
      return { threadId: 'thread-1', turnId: 'turn-1' };
    },
    saveState: async (value) => { saved = structuredClone(value); },
    now: () => '2026-08-06T12:00:00.000Z',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadId, 'thread-1');
  assert.match(calls[0].prompt, /Eagan/);
  assert.equal(saved.relayed[receiptKey('install-post:pending:new')], '2026-08-06T12:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(saved), /install-post:pending:new/);
  assert.equal(result.relayed, 1);
  assert.equal(result.skipped, 1);
});

test('relayPendingSeeds does not persist a receipt when Codex staging fails', async () => {
  let saves = 0;
  await assert.rejects(
    relayPendingSeeds({
      pending: [{ key: 'install-post:pending:new', seed: { city: 'Eagan' } }],
      state: { threadId: null, relayed: {} },
      stageSeed: async () => { throw new Error('turn failed'); },
      saveState: async () => { saves += 1; },
    }),
    /turn failed/,
  );
  assert.equal(saves, 0);
});

test('buildMinimalCodexEnvironment excludes API keys, provider overrides, and business credentials', () => {
  const env = buildMinimalCodexEnvironment({
    HOME: '/Users/test',
    PATH: '/usr/bin:/bin',
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
    OPENAI_API_KEY: 'metered',
    OPENAI_BASE_URL: 'https://alternate.invalid',
    SQUARE_ACCESS_TOKEN: 'private',
  });

  assert.deepEqual(env, {
    HOME: '/Users/test',
    PATH: '/usr/bin:/bin',
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
  });
});

test('assertOpenAIProvider fails closed for custom model providers', () => {
  assert.doesNotThrow(() => assertOpenAIProvider({ modelProvider: 'openai' }));
  assert.throws(() => assertOpenAIProvider({ modelProvider: 'custom-proxy' }), /requires modelProvider=openai/);
  assert.throws(() => assertOpenAIProvider({}), /requires modelProvider=openai/);
});

test('acquireLock replaces a stale dead-process lock and cleans up on release', async () => {
  const dir = path.join(tmpdir(), `codex-relay-lock-${process.pid}-${Date.now()}`);
  const lockPath = path.join(dir, 'relay.lock');
  await mkdir(dir, { recursive: true });
  await writeFile(lockPath, '99999999');
  const release = await acquireLock(lockPath);
  assert.equal(typeof release, 'function');
  await release();
  await rm(dir, { recursive: true, force: true });
});
