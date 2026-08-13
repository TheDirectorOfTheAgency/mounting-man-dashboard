import assert from 'node:assert/strict';
import test from 'node:test';

import { upstashSetCommand, upstashSetCommandUrl } from '../lib/upstash-set.mjs';

test('set members are encoded as Redis path arguments, not a JSON request body', async () => {
  assert.equal(
    upstashSetCommandUrl('https://example.upstash.io/', 'sadd', 'install-post:pending-index', 'install-post:pending:order/1'),
    'https://example.upstash.io/sadd/install-post%3Apending-index/install-post%3Apending%3Aorder%2F1',
  );

  const calls = [];
  const ok = await upstashSetCommand({
    httpClient: {
      get: async (...args) => {
        calls.push(args);
        return { data: { result: 1 } };
      },
    },
    baseUrl: 'https://example.upstash.io',
    token: 'test-token',
    command: 'sadd',
    key: 'install-post:pending-index',
    member: 'install-post:pending:order-1',
  });

  assert.equal(ok, true);
  assert.deepEqual(calls, [[
    'https://example.upstash.io/sadd/install-post%3Apending-index/install-post%3Apending%3Aorder-1',
    { headers: { Authorization: 'Bearer test-token' } },
  ]]);
});

test('missing Upstash configuration is a no-op', async () => {
  const ok = await upstashSetCommand({
    httpClient: { get: async () => assert.fail('request should not run') },
    baseUrl: '',
    token: '',
    command: 'srem',
    key: 'set',
    member: 'member',
  });
  assert.equal(ok, false);
});
