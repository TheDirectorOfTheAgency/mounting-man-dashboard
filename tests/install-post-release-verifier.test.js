import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyInstallPostRelease } from '../scripts/verify-install-post-release.mjs';

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

const OPTIONS = {
  baseUrl: 'https://mounting-man-dashboard.vercel.app',
  expectedCommit: 'adc78901234567890abcdef1234567890abcdef1',
  workerSecret: 'worker-secret-for-test',
  workerId: 'm1-gbp-01',
  workerVersion: 'the188-test',
  repository: 'TheDirectorOfTheAgency/mounting-man-dashboard',
  now: Date.parse('2026-08-30T17:05:00.000Z'),
};

function fakeFetch(calls) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/api/health')) {
      return response(200, {
        status: 'ok',
        gitCommit: 'adc789012345',
        environment: 'production',
      });
    }
    if (String(url).includes('/actions/workflows/publish-install-post.yml')) {
      return response(200, { state: 'active', path: '.github/workflows/publish-install-post.yml' });
    }
    if (String(url).includes('/api/install-post/gbp') && !options.headers?.Authorization) {
      return response(401, { error: 'Unauthorized' });
    }
    if (String(url).includes('/api/install-post/gbp?heartbeat=')) {
      return response(200, {
        ok: true,
        heartbeat: {
          workerId: 'm1-gbp-01',
          version: 'the188-test',
          buildSha: OPTIONS.expectedCommit,
          seenAt: '2026-08-30T17:00:00.000Z',
        },
      });
    }
    if (String(url).endsWith('/api/install-post/gbp')) {
      return response(200, { pending: [], latest: null, count: 0 });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test('release verifier checks deployment, auth boundary, pull, workflow, and heartbeat without publishing', async () => {
  const calls = [];
  const result = await verifyInstallPostRelease({ ...OPTIONS, fetchImpl: fakeFetch(calls) });

  assert.deepEqual(result, {
    deployedCommit: 'adc789012345',
    environment: 'production',
    workflowState: 'active',
    unauthenticatedGbpStatus: 401,
    authenticatedPull: true,
    heartbeat: true,
  });
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 0);
  assert.ok(calls.every((call) => !call.url.includes(OPTIONS.workerSecret)));
  assert.ok(calls.every((call) => !String(call.options.body || '').includes(OPTIONS.workerSecret)));
  assert.ok(calls.every((call) => !String(call.options.body || '').includes('claim')));
  assert.ok(calls.every((call) => !String(call.options.body || '').includes('complete')));
});

test('release verifier rejects stale or deployment-skewed real worker heartbeats', async () => {
  for (const heartbeat of [
    {
      workerId: OPTIONS.workerId,
      version: OPTIONS.workerVersion,
      buildSha: 'deadbeef0000000000000000000000000000000000',
      seenAt: '2026-08-30T17:00:00.000Z',
    },
    {
      workerId: OPTIONS.workerId,
      version: OPTIONS.workerVersion,
      buildSha: OPTIONS.expectedCommit,
      seenAt: '2026-08-30T16:00:00.000Z',
    },
  ]) {
    await assert.rejects(
      verifyInstallPostRelease({
        ...OPTIONS,
        fetchImpl: async (url, options = {}) => {
          if (String(url).endsWith('/api/health')) {
            return response(200, {
              status: 'ok', gitCommit: OPTIONS.expectedCommit.slice(0, 12), environment: 'production',
            });
          }
          if (String(url).includes('/actions/workflows/')) {
            return response(200, { state: 'active', path: '.github/workflows/publish-install-post.yml' });
          }
          if (String(url).includes('?heartbeat=')) return response(200, { ok: true, heartbeat });
          if (!options.headers?.Authorization) return response(401, { error: 'Unauthorized' });
          return response(200, { pending: [], latest: null, count: 0 });
        },
      }),
      /heartbeat (?:build|stale)/i,
    );
  }
});

test('release verifier fails closed on deployment skew before touching GBP', async () => {
  const calls = [];
  await assert.rejects(
    verifyInstallPostRelease({
      ...OPTIONS,
      fetchImpl: async (url, options = {}) => {
        calls.push({ url: String(url), options });
        return response(200, { status: 'ok', gitCommit: 'deadbeef0000', environment: 'production' });
      },
    }),
    /deployment commit mismatch/i,
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/api/health'));
});

test('release verifier rejects missing or malformed deployed commit identity', async () => {
  await assert.rejects(
    verifyInstallPostRelease({
      ...OPTIONS,
      fetchImpl: async () => response(200, {
        status: 'ok',
        gitCommit: 'unknown',
        environment: 'production',
      }),
    }),
    /deployment commit identity/i,
  );
});

test('release verifier requires a secret but never reports its value', async () => {
  await assert.rejects(
    verifyInstallPostRelease({ ...OPTIONS, workerSecret: '', fetchImpl: fakeFetch([]) }),
    /worker secret is required/i,
  );
});
