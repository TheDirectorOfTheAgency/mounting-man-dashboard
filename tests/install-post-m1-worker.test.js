// READY_FOR_M1 → M1 worker → canonical publisher wrapper → signed callback.
//
// The worker runs against the real claim and callback handlers in-process, so
// these tests cover the whole contract: no GitHub Actions dispatch, no machine
// GBP queue, `--art-mode never`, one Square job = one post.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { autoDispatchIfPhotoBound } from '../lib/install-post-auto-publish.mjs';
import { createConfiguredDispatcher, signRunnerRequest } from '../lib/install-post-dispatch.mjs';
import { claimNextReadyForM1 } from '../lib/install-post-m1-queue.mjs';
import { INSTALL_POST_STATES, signOperatorSession, transitionRecord } from '../lib/install-post-queue.mjs';
import { SESSION_COOKIE_NAME } from '../lib/install-post-session.mjs';
import { createInstallPostStore, M1_READY_INDEX_KEY } from '../lib/install-post-store.mjs';
import {
  CALLBACK_PATH,
  CLAIM_PATH,
  DEFAULT_WRAPPER,
  classifyPublisherOutcome,
  extractLiveUrl,
  publisherArgs,
  runOnce,
  signRequest,
  spawnPublisher,
} from '../m1/install-post-worker/install-post-worker.mjs';
import { createM1ClaimHandler, M1_CLAIM_PATH } from '../pages/api/install-post/m1/claim.js';
import { createPublishHandler } from '../pages/api/install-post/publish.js';
import { createRunnerCallbackHandler } from '../pages/api/install-post/runner/callback.js';
import { createResponse } from './webhook-test-helpers.js';

const RUNNER_SECRET = 'test-runner-secret';
const SESSION_SECRET = 'test-session-secret';
const API_BASE = 'https://dashboard.test';
const HOST = 'dashboard.test';
const NOW = 1_760_000_000_000;
const LIVE_URL = 'https://www.themountingman.com/installations/65-inch-samsung-edina';
const PHOTO = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 fake-install-photo');

const SEED = {
  city: 'Edina',
  state: 'MN',
  'tv-size': '65"',
  'tv-brand': 'Samsung',
  'wall-surface': 'Stone',
  price: '$450',
  'street-name': 'Elm Street',
  slug: '65-inch-samsung-edina',
  'seed-index': 1,
  'seed-count': 1,
};

const IMAGE = {
  sha256: createHash('sha256').update(PHOTO).digest('hex'),
  bytes: PHOTO.length,
  contentType: 'image/webp',
  assetId: 'asset-1',
  hostedUrl: 'https://cdn.example.com/65-inch-samsung.webp',
};

function createFakeKv() {
  const values = new Map();
  const sets = new Map();
  return {
    values,
    sets,
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

async function readyForM1Job({ seed = SEED } = {}) {
  const kv = createFakeKv();
  const store = createInstallPostStore(kv);
  const [staged] = await store.stageJobRecords({
    seeds: [seed],
    sourceRefs: { orderId: 'ORDER-M1W', paymentId: 'PAY-M1W' },
    source: 'square-webhook',
    stagedAt: '2026-09-24T03:00:00.000Z',
  });
  const withPhoto = transitionRecord(staged, { type: 'photo', image: IMAGE }).record;
  await store.saveRecord(withPhoto);
  const handed = await autoDispatchIfPhotoBound({
    store,
    jobId: withPhoto.jobId,
    dispatcher: createConfiguredDispatcher({ env: {} }),
    now: () => NOW,
    typesafeApiKey: '',
    readyNotifier: null,
  });
  assert.equal(handed.readyForM1, true);
  return { kv, store, record: await store.loadRecord(withPhoto.jobId) };
}

function lowerHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function createDashboard(store, { pages = { [LIVE_URL]: 200 }, callbackDown = () => false } = {}) {
  const pastePacks = [];
  const handlers = {
    [CLAIM_PATH]: createM1ClaimHandler({ store, runnerSecret: RUNNER_SECRET, now: () => NOW }),
    [CALLBACK_PATH]: createRunnerCallbackHandler({
      store,
      runnerSecret: RUNNER_SECRET,
      now: () => NOW,
      gbpFenceNotify: async ({ record }) => {
        pastePacks.push(record.result.liveUrl);
        return { forwarded: true };
      },
    }),
  };
  const calls = [];
  async function fetchImpl(url, init = {}) {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.origin === API_BASE) {
      if (parsed.pathname === CALLBACK_PATH && callbackDown()) {
        return { status: 503, json: async () => ({ error: 'down' }) };
      }
      const res = createResponse();
      await handlers[parsed.pathname]({
        method: init.method,
        url: parsed.pathname,
        headers: lowerHeaders(init.headers),
        body: JSON.parse(init.body),
      }, res);
      return { status: res.statusCode, json: async () => res.body };
    }
    if (url === IMAGE.hostedUrl) {
      return { status: 200, arrayBuffer: async () => PHOTO };
    }
    if (url in pages) return { status: pages[url] };
    return { status: 404 };
  }
  return { fetchImpl, calls, pastePacks };
}

async function workerConfig() {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'm1-worker-'));
  const wrapper = path.join(stateDir, 'run_fast_install_post.sh');
  await writeFile(wrapper, '#!/bin/sh\nexit 0\n');
  await chmod(wrapper, 0o755);
  return {
    apiBase: API_BASE,
    secret: RUNNER_SECRET,
    secretFile: '',
    workerId: 'm1-test-01',
    wrapper,
    stateDir,
    publishTimeoutMs: 5_000,
  };
}

function fakePublisher({ exitCode = 0, output = `Live: ${LIVE_URL}\n`, timedOut = false } = {}) {
  const runs = [];
  return {
    runs,
    async run({ command, args, timeoutMs }) {
      const seedPath = args[args.indexOf('--seed-json') + 1];
      const imagePath = args[args.indexOf('--image') + 1];
      runs.push({
        command,
        args,
        timeoutMs,
        seed: JSON.parse(await readFile(seedPath, 'utf8')),
        image: await readFile(imagePath),
        imagePath,
      });
      return { exitCode, timedOut, spawnError: '', output };
    },
  };
}

const noSleep = async () => {};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('READY_FOR_M1 is picked up by the M1 worker and settles PUBLISHED with no Actions dispatch', async () => {
  assert.equal(createConfiguredDispatcher({ env: {} }), null);
  const { kv, store, record } = await readyForM1Job();
  const config = await workerConfig();
  const dashboard = createDashboard(store);
  const publisher = fakePublisher();

  const summary = await runOnce({
    config, fetchImpl: dashboard.fetchImpl, runPublisher: publisher.run, sleep: noSleep, now: () => NOW,
  });

  assert.equal(summary.status, 'reported');
  assert.equal(summary.state, INSTALL_POST_STATES.PUBLISHED);
  assert.equal(summary.delivered, true);

  assert.equal(publisher.runs.length, 1);
  const [run] = publisher.runs;
  assert.equal(run.command, config.wrapper);
  assert.deepEqual(run.args.filter((_, index) => index % 2 === 0), ['--seed-json', '--image', '--art-mode']);
  assert.equal(run.args.at(-1), 'never');
  assert.deepEqual(run.seed, record.seed);
  assert.ok(run.image.equals(PHOTO));
  assert.equal(path.extname(run.imagePath), '.webp');
  const leaked = JSON.stringify(run.seed);
  for (const forbidden of ['ORDER-M1W', 'PAY-M1W', '4821']) {
    assert.equal(leaked.includes(forbidden), false, `seed leaked ${forbidden}`);
  }

  const saved = await store.loadRecord(record.jobId);
  assert.equal(saved.state, INSTALL_POST_STATES.PUBLISHED);
  assert.equal(saved.result.liveUrl, LIVE_URL);
  assert.equal(saved.result.publicStatus, 200);
  assert.equal(saved.result.slug, '65-inch-samsung-edina');
  assert.deepEqual(dashboard.pastePacks, [LIVE_URL]);

  assert.equal([...kv.values.keys()].some((key) => key.startsWith('install-post:gbp:')), false, 'no GBP queue write');
  assert.equal(dashboard.calls.some((url) => /api\.github\.com/.test(url)), false, 'no Actions dispatch');
  assert.equal((await kv.smembers(M1_READY_INDEX_KEY)).length, 0);
  assert.deepEqual(await readdir(path.join(config.stateDir, 'jobs')), [], 'work dir cleaned up');

  const again = await runOnce({
    config, fetchImpl: dashboard.fetchImpl, runPublisher: publisher.run, sleep: noSleep, now: () => NOW,
  });
  assert.equal(again.status, 'idle');
  assert.equal(publisher.runs.length, 1, 'one Square job = one post');
  await rm(config.stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Claim API
// ---------------------------------------------------------------------------

function signedClaim(body, secret = RUNNER_SECRET) {
  const timestamp = Math.floor(NOW / 1000);
  return {
    method: 'POST',
    url: M1_CLAIM_PATH,
    headers: {
      'x-install-post-signature': signRunnerRequest({ secret, method: 'POST', path: M1_CLAIM_PATH, body, timestamp }),
      'x-install-post-timestamp': String(timestamp),
    },
    body,
  };
}

test('claim moves READY_FOR_M1 to PUBLISHING under one lease and returns an art-mode-never envelope', async () => {
  const { store, record } = await readyForM1Job();
  const claim = createM1ClaimHandler({
    store, runnerSecret: RUNNER_SECRET, now: () => NOW, dispatchIdFactory: () => 'dispatch-m1-1',
  });
  const res = createResponse();
  await claim(signedClaim({ workerId: 'm1-a' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.job.jobId, record.jobId);
  assert.equal(res.body.job.revision, record.revision);
  assert.equal(res.body.job.dispatchId, 'dispatch-m1-1');
  assert.equal(res.body.job.artMode, 'never');
  assert.equal(res.body.job.image.hostedUrl, IMAGE.hostedUrl);
  assert.equal(JSON.stringify(res.body).includes('PAY-M1W'), false);

  const saved = await store.loadRecord(record.jobId);
  assert.equal(saved.state, INSTALL_POST_STATES.PUBLISHING);
  assert.equal(saved.lease.dispatchId, 'dispatch-m1-1');
  assert.equal(saved.lease.workerId, 'm1-a');
  assert.equal(saved.approval.revision, record.revision);

  const second = createResponse();
  await claim(signedClaim({ workerId: 'm1-b' }), second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.job, null, 'a claimed job cannot be claimed twice');
});

test('claim refuses an unsigned or wrongly signed request and a missing worker id', async () => {
  const { store } = await readyForM1Job();
  const claim = createM1ClaimHandler({ store, runnerSecret: RUNNER_SECRET, now: () => NOW });

  const unsigned = createResponse();
  await claim({ method: 'POST', headers: {}, body: { workerId: 'm1-a' } }, unsigned);
  assert.equal(unsigned.statusCode, 401);

  const wrong = createResponse();
  await claim(signedClaim({ workerId: 'm1-a' }, 'other-secret'), wrong);
  assert.equal(wrong.statusCode, 401);

  const noWorker = createResponse();
  await claim(signedClaim({ workerId: 'bad id!' }), noWorker);
  assert.equal(noWorker.statusCode, 400);
});

test('claim only picks READY_FOR_M1: a HOLD stays READY and is never handed to M1', async () => {
  const { store, record } = await readyForM1Job();
  const held = transitionRecord(record, { type: 'correct', patch: { city: 'Twin Cities' } }).record;
  await store.saveRecord(held);
  assert.equal(held.state, INSTALL_POST_STATES.READY);

  const outcome = await claimNextReadyForM1({ store, workerId: 'm1-a', now: () => NOW });
  assert.deepEqual(outcome, { ok: true, job: null });
  assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.READY);
});

test('rescan finds a READY_FOR_M1 job parked before the ready index existed', async () => {
  const { kv, store, record } = await readyForM1Job();
  kv.sets.get(M1_READY_INDEX_KEY).clear();

  assert.equal((await claimNextReadyForM1({ store, workerId: 'm1-a', now: () => NOW })).job, null);
  const rescanned = await claimNextReadyForM1({ store, workerId: 'm1-a', now: () => NOW, rescan: true });
  assert.equal(rescanned.job.jobId, record.jobId);
});

// ---------------------------------------------------------------------------
// Failure paths never strand a job
// ---------------------------------------------------------------------------

test('a publisher failure with no live page is RETRYABLE_FAILURE and a new Publish tap re-queues for M1', async () => {
  const { store, record } = await readyForM1Job();
  const config = await workerConfig();
  const dashboard = createDashboard(store);
  const publisher = fakePublisher({ exitCode: 2, output: 'Webflow 503\n' });

  const summary = await runOnce({
    config, fetchImpl: dashboard.fetchImpl, runPublisher: publisher.run, sleep: noSleep, now: () => NOW,
  });
  assert.equal(summary.state, INSTALL_POST_STATES.RETRYABLE_FAILURE);
  const failed = await store.loadRecord(record.jobId);
  assert.equal(failed.state, INSTALL_POST_STATES.RETRYABLE_FAILURE);
  assert.equal(failed.lease, null);
  assert.deepEqual(dashboard.pastePacks, []);

  const publish = createPublishHandler({
    store, sessionSecret: SESSION_SECRET, dispatcher: null, now: () => NOW, readyNotifier: null,
  });
  const session = signOperatorSession({ jobId: record.jobId, secret: SESSION_SECRET, expiresAt: NOW + 3600_000 });
  const res = createResponse();
  await publish({
    method: 'POST',
    headers: { host: HOST, origin: `https://${HOST}`, cookie: `${SESSION_COOKIE_NAME}=${session}` },
    query: {},
    body: { revision: record.revision },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.job.state, INSTALL_POST_STATES.READY_FOR_M1);
  assert.equal((await claimNextReadyForM1({ store, workerId: 'm1-a', now: () => NOW })).job.jobId, record.jobId);
  await rm(config.stateDir, { recursive: true, force: true });
});

test('a photo that does not match the approved digest is BLOCKED and the publisher never runs', async () => {
  const { store, record } = await readyForM1Job();
  const config = await workerConfig();
  const dashboard = createDashboard(store);
  const tampered = async (url, init) => (url === IMAGE.hostedUrl
    ? { status: 200, arrayBuffer: async () => Buffer.from('different bytes') }
    : dashboard.fetchImpl(url, init));
  const publisher = fakePublisher();

  const summary = await runOnce({
    config, fetchImpl: tampered, runPublisher: publisher.run, sleep: noSleep, now: () => NOW,
  });
  assert.equal(summary.state, INSTALL_POST_STATES.BLOCKED);
  assert.equal(publisher.runs.length, 0);
  assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.BLOCKED);
  await rm(config.stateDir, { recursive: true, force: true });
});

test('a misconfigured worker never claims, so the job stays READY_FOR_M1', async () => {
  const { store, record } = await readyForM1Job();
  const config = { ...(await workerConfig()), wrapper: '/nonexistent/run_fast_install_post.sh' };
  const dashboard = createDashboard(store);

  const summary = await runOnce({ config, fetchImpl: dashboard.fetchImpl, sleep: noSleep, now: () => NOW });
  assert.deepEqual(summary, { status: 'misconfigured', reason: 'publisher_wrapper_not_executable' });
  assert.equal(dashboard.calls.length, 0);
  assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.READY_FOR_M1);

  const noSecret = await runOnce({
    config: { ...config, secret: '', secretFile: '/nonexistent/secret' },
    fetchImpl: dashboard.fetchImpl,
    now: () => NOW,
  });
  assert.equal(noSecret.reason, 'runner_secret_missing');
  await rm(config.stateDir, { recursive: true, force: true });
});

test('an undelivered PUBLISHED callback is parked and delivered on the next pass', async () => {
  const { store, record } = await readyForM1Job();
  const config = await workerConfig();
  let down = true;
  const dashboard = createDashboard(store, { callbackDown: () => down });
  const publisher = fakePublisher();

  const first = await runOnce({
    config, fetchImpl: dashboard.fetchImpl, runPublisher: publisher.run, sleep: noSleep, now: () => NOW,
  });
  assert.equal(first.delivered, false);
  assert.equal(first.parked, true);
  assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.PUBLISHING);

  down = false;
  const second = await runOnce({
    config, fetchImpl: dashboard.fetchImpl, runPublisher: publisher.run, sleep: noSleep, now: () => NOW,
  });
  assert.equal(second.flushed, 1);
  assert.equal(second.status, 'idle');
  assert.equal(publisher.runs.length, 1, 'the parked result is resent, not republished');
  assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.PUBLISHED);
  await rm(config.stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

test('publisher outcomes never turn a possibly-live page into a blind retry', () => {
  const cases = [
    [{ exitCode: 0, liveUrl: LIVE_URL, publicStatus: 200 }, 'PUBLISHED'],
    [{ exitCode: 1, liveUrl: LIVE_URL, publicStatus: 200 }, 'PUBLISHED'],
    [{ timedOut: true, liveUrl: LIVE_URL, publicStatus: 200 }, 'PUBLISHED'],
    [{ exitCode: 0, liveUrl: LIVE_URL, publicStatus: 404 }, 'INDETERMINATE'],
    [{ exitCode: 1, liveUrl: LIVE_URL, publicStatus: 0 }, 'INDETERMINATE'],
    [{ timedOut: true }, 'INDETERMINATE'],
    [{ exitCode: 0 }, 'INDETERMINATE'],
    [{ exitCode: 1 }, 'RETRYABLE_FAILURE'],
    [{ spawnError: 'ENOENT' }, 'RETRYABLE_FAILURE'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(classifyPublisherOutcome(input).status, expected, JSON.stringify(input));
  }
  const published = classifyPublisherOutcome({ exitCode: 0, liveUrl: LIVE_URL, publicStatus: 200 });
  assert.equal(published.slug, '65-inch-samsung-edina');
  assert.deepEqual(published.destinations, [{ name: 'website', status: 'PUBLISHED', detail: LIVE_URL }]);
});

test('extractLiveUrl prefers the last publisher JSON live_url, then regex fallback', () => {
  const pretty = JSON.stringify({
    live_url: LIVE_URL,
    slug: '65-inch-samsung-edina',
    image_url: 'https://cdn.webflow.com/abc.webp',
  }, null, 2);
  assert.equal(extractLiveUrl(pretty), LIVE_URL);

  const compact = JSON.stringify({ live_url: LIVE_URL, slug: '65-inch-samsung-edina' });
  assert.equal(extractLiveUrl(compact), LIVE_URL);

  const noisyStdout = [
    'uploading hero image...',
    'posting to instagram...',
    JSON.stringify({ live_url: 'https://www.themountingman.com/installations/older-post' }),
    'finalizing webflow item...',
    pretty,
  ].join('\n');
  assert.equal(extractLiveUrl(noisyStdout), LIVE_URL);

  const proseFallback = [
    'checking https://www.themountingman.com/installations/older-post',
    'Verified live: https://www.themountingman.com/installations/65-inch-samsung-edina (200)',
  ].join('\n');
  assert.equal(extractLiveUrl(proseFallback), LIVE_URL);

  assert.equal(extractLiveUrl('https://www.themountingman.com/tv-mounting/edina'), '');
  assert.equal(extractLiveUrl(JSON.stringify({
    live_url: 'https://www.themountingman.com/tv-mounting/edina',
  })), '');
  assert.equal(extractLiveUrl('publisher finished with no URL\n'), '');
  assert.equal(classifyPublisherOutcome({ exitCode: 0 }).status, 'INDETERMINATE');
});

test('spawnPublisher runs a real wrapper, captures its URL, and kills it on timeout', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'm1-spawn-'));
  const ok = path.join(dir, 'ok.sh');
  await writeFile(ok, `#!/bin/sh\n[ "$5" = "--art-mode" ] && [ "$6" = "never" ] || exit 9\necho "Verified ${LIVE_URL}" >&2\n`);
  await chmod(ok, 0o755);
  const finished = await spawnPublisher({
    command: ok, args: publisherArgs({ seedPath: '/s.json', imagePath: '/p.webp' }), timeoutMs: 5_000, env: {},
  });
  assert.equal(finished.exitCode, 0);
  assert.equal(finished.timedOut, false);
  assert.equal(extractLiveUrl(finished.output), LIVE_URL);

  const hang = path.join(dir, 'hang.sh');
  await writeFile(hang, '#!/bin/sh\nexec sleep 30\n');
  await chmod(hang, 0o755);
  const killed = await spawnPublisher({ command: hang, args: [], timeoutMs: 200, env: {} });
  assert.equal(killed.timedOut, true);
  assert.equal(classifyPublisherOutcome(killed).status, 'INDETERMINATE');

  const missing = await spawnPublisher({ command: path.join(dir, 'nope.sh'), args: [], timeoutMs: 1_000, env: {} });
  assert.equal(missing.spawnError, 'ENOENT');
  await rm(dir, { recursive: true, force: true });
});

test('the worker signs exactly like the dashboard verifier', () => {
  const body = { workerId: 'm1-a', rescan: true };
  const args = { secret: RUNNER_SECRET, method: 'POST', path: CLAIM_PATH, body, timestamp: 1_760_000_000 };
  assert.equal(signRequest(args), signRunnerRequest(args));
});

test('the worker wraps the canonical publisher with --art-mode never and nothing else', async () => {
  assert.match(DEFAULT_WRAPPER, /\/jewel-way-run\/bin\/run_fast_install_post\.sh$/);
  assert.deepEqual(publisherArgs({ seedPath: '/s.json', imagePath: '/p.webp' }), [
    '--seed-json', '/s.json', '--image', '/p.webp', '--art-mode', 'never',
  ]);

  const source = await readFile(new URL('../m1/install-post-worker/install-post-worker.mjs', import.meta.url), 'utf8');
  for (const forbidden of [/api\.github\.com/, /workflows\/.*dispatches/, /reddit\.com/i, /business\.google\.com/i, /\/api\/install-post\/gbp/]) {
    assert.doesNotMatch(source, forbidden);
  }
  assert.doesNotMatch(source, /from '\.\.\//, 'worker must stay self-contained for the installer copy');

  const callback = await readFile(new URL('../pages/api/install-post/runner/callback.js', import.meta.url), 'utf8');
  assert.doesNotMatch(callback, /install-post-gbp-queue/, 'PUBLISHED must not depend on the machine GBP queue');

  const plist = await readFile(new URL('../m1/install-post-worker/com.themountingman.install-post-worker.plist', import.meta.url), 'utf8');
  assert.match(plist, /<string>com\.themountingman\.install-post-worker<\/string>/);
  assert.match(plist, /INSTALL_POST_RUNNER_SECRET_FILE/);
  assert.doesNotMatch(plist, /<key>INSTALL_POST_RUNNER_SECRET<\/key>/, 'secret value must never live in the plist');
});
