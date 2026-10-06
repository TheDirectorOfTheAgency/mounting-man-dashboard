import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeConversionSummaryKeys,
  loadAndLogRecent,
  logConversionSummaryKeys,
  logPayloadConversionSummary,
  publicProbeResponse,
  runConversionSummaryKeyProbeOnce,
} from '../lib/conversion-summary-keys.js';
import { createConversionSummaryKeysHandler } from '../pages/api/cron/conversion-summary-keys.js';
import { createZenbookerWebhookHandler } from '../pages/api/webhooks/zenbooker.js';
import { createZenbookerToSquareHandler } from '../pages/api/webhooks/zenbooker-to-square.js';
import {
  completedPayload,
  createRequest,
  createResponse,
  installTestEnvironment,
} from './webhook-test-helpers.js';

const CLICK = 'CLICK-SECRET-zz91';
const GBRAID = 'GBRAID-SECRET-aa11';
const WBRAID = 'WBRAID-SECRET-bb22';
const LANDING = 'https://landing.example/path?gclid=CLICK-SECRET-zz91';
const EMAIL = 'secret.person@example.com';
const PHONE = '6125550199';
const SENTINELS = [CLICK, GBRAID, WBRAID, LANDING, EMAIL, PHONE, 'landing.example', 'secret.person'];

function captureLogs(t) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
  };
  t.after(() => {
    console.log = original;
  });
  return lines;
}

function summaryFixture() {
  return {
    gclid: CLICK,
    gbraid: GBRAID,
    wbraid: WBRAID,
    session_landing_page: LANDING,
    nested: { booking_session: 'SESSION-SECRET-cc33', count: 0, note: '' },
    tags: [EMAIL],
    customer: { phone: PHONE, name: 'Secret Name' },
    empty_list: [],
  };
}

function assertNoSentinels(text) {
  for (const sentinel of [...SENTINELS, 'SESSION-SECRET-cc33', 'Secret Name']) {
    assert.equal(text.includes(sentinel), false, `leaked ${sentinel}`);
  }
}

test('describeConversionSummaryKeys reports path, type, and emptiness without values', () => {
  const keys = describeConversionSummaryKeys(summaryFixture());
  const serialized = JSON.stringify(keys);
  assertNoSentinels(serialized);
  assert.deepEqual(
    keys.find((row) => row.path === 'conversion_summary.gclid'),
    { path: 'conversion_summary.gclid', type: 'string', empty: false }
  );
  assert.deepEqual(
    keys.find((row) => row.path === 'conversion_summary.nested.note'),
    { path: 'conversion_summary.nested.note', type: 'string', empty: true }
  );
  assert.deepEqual(
    keys.find((row) => row.path === 'conversion_summary.nested.count'),
    { path: 'conversion_summary.nested.count', type: 'number', empty: false }
  );
  assert.equal(keys.find((row) => row.path === 'conversion_summary.tags.0').type, 'string');
  assert.equal(keys.every((row) => Object.keys(row).sort().join() === 'empty,path,type'), true);
});

test('log line is greppable and contains no conversion values', (t) => {
  const lines = captureLogs(t);
  logConversionSummaryKeys({ jobId: 'job-shape-1', summary: summaryFixture() });
  const logged = lines.filter((line) => line.includes('ZB_CONV_SUMMARY_KEYS')).join('\n');
  assert.match(logged, /^ZB_CONV_SUMMARY_KEYS /);
  assertNoSentinels(logged);
  const parsed = JSON.parse(logged.slice('ZB_CONV_SUMMARY_KEYS '.length));
  assert.equal(parsed.jobId, 'job-shape-1');
  assert.equal(parsed.present, true);
  assert.equal(parsed.keys.some((row) => row.path === 'conversion_summary.gclid'), true);
});

test('completed webhook logs conversion_summary keys and the response has no values', async (t) => {
  const restoreEnv = installTestEnvironment();
  t.after(restoreEnv);
  const lines = captureLogs(t);
  const handler = createZenbookerWebhookHandler({
    attributionStore: {
      getJobMapping: async () => null,
      getBookingAttribution: async () => null,
    },
    disclosureVersion: '2026-07-10',
    logger: { info() {}, warn() {}, error() {} },
  });
  const res = createResponse();
  await handler(createRequest(completedPayload({
    id: 'job-shape-1',
    conversion_summary: summaryFixture(),
  })), res);

  const logged = lines.filter((line) => line.includes('ZB_CONV_SUMMARY_KEYS')).join('\n');
  assert.match(logged, /conversion_summary\.gclid/);
  assertNoSentinels(logged);
  assertNoSentinels(JSON.stringify(res.body));
  assert.equal(lines.filter((line) => line.includes('ZB_CONV_SUMMARY_KEYS')).length, 1);
});

test('square webhook logs conversion_summary keys before any customer lookup', async (t) => {
  const previous = process.env.ZENBOOKER_WEBHOOK_SECRET;
  process.env.ZENBOOKER_WEBHOOK_SECRET = 'test-webhook-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.ZENBOOKER_WEBHOOK_SECRET;
    else process.env.ZENBOOKER_WEBHOOK_SECRET = previous;
  });
  const lines = captureLogs(t);
  const handler = createZenbookerToSquareHandler({
    findCustomer: async () => {
      throw new Error('customer lookup must not run');
    },
  });
  const res = createResponse();
  await handler(createRequest({
    type: 'job.created',
    data: {
      id: 'job-shape-2',
      conversion_summary: summaryFixture(),
    },
  }), res);

  const logged = lines.filter((line) => line.includes('ZB_CONV_SUMMARY_KEYS')).join('\n');
  assert.match(logged, /conversion_summary\.wbraid/);
  assertNoSentinels(logged);
  assertNoSentinels(JSON.stringify(res.body));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.skipped, true);
});

test('one-shot recent-jobs response and logs omit values', async (t) => {
  const lines = captureLogs(t);
  const handler = createConversionSummaryKeysHandler({
    probe: () => loadAndLogRecent({
      apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            results: [
              {
                id: 'job-recent-1',
                customer: { email: EMAIL, phone: PHONE },
                conversion_summary: summaryFixture(),
              },
              {
                id: 'job-recent-2',
                customer: { email: EMAIL },
              },
            ],
          });
        },
      }),
    }),
  });
  const res = createResponse();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer cron-secret' },
    query: {},
  }, res);

  assert.equal(res.statusCode, 401);
  process.env.CRON_SECRET = 'cron-secret';
  t.after(() => {
    delete process.env.CRON_SECRET;
  });
  const allowed = createResponse();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer cron-secret' },
    query: {},
  }, allowed);

  const logged = lines.filter((line) => line.includes('ZB_CONV_SUMMARY_KEYS')).join('\n');
  assert.match(logged, /conversion_summary\.gclid/);
  assert.match(logged, /"present":false/);
  assertNoSentinels(logged);
  assertNoSentinels(JSON.stringify(allowed.body));
  assert.equal(allowed.body.jobCount, 2);
  assert.equal(allowed.body.probes[0].keys.some((row) => row.value !== undefined), false);
  assert.equal(Object.hasOwnProperty.call(allowed.body, 'jobId'), false);
});

test('public probe response drops anything except path, type, and emptiness', () => {
  const body = publicProbeResponse([{
    present: true,
    jobId: 'job-secret',
    keys: [{ path: 'conversion_summary.gclid', type: 'string', empty: false, value: CLICK }],
  }]);
  assertNoSentinels(JSON.stringify(body));
  assert.deepEqual(body.probes[0].keys[0], {
    path: 'conversion_summary.gclid',
    type: 'string',
    empty: false,
  });
});

test('run-once marker fetches once and does not retry after success', async (t) => {
  captureLogs(t);
  const saved = new Map();
  const kv = {
    async get(key) { return saved.get(key) || null; },
    async set(key, value) { saved.set(key, value); },
  };
  let calls = 0;
  const probe = async () => {
    calls += 1;
    return logPayloadConversionSummary({
      data: { id: 'job-once', conversion_summary: { gclid: CLICK } },
    });
  };
  const first = await runConversionSummaryKeyProbeOnce({ kv, probe });
  const second = await runConversionSummaryKeyProbeOnce({ kv, probe });
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already_ran');
  assert.equal(calls, 1);
  assertNoSentinels(JSON.stringify([...saved.values()]));
});

test('payload without conversion_summary does not emit the keys line', (t) => {
  const lines = captureLogs(t);
  assert.equal(logPayloadConversionSummary({ data: { id: 'job-plain', status: 'complete' } }), null);
  assert.equal(lines.some((line) => line.includes('ZB_CONV_SUMMARY_KEYS')), false);
});
