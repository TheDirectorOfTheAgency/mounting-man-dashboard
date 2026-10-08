import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEXT_NEXT_CUSTOMER_ETA,
  textNextCustomerEta,
  textNextCustomerEtaTool,
} from '../lib/car-tools-eta-text.mjs';
import { createMountingManZenbookerHandler } from '../pages/api/mcp/mounting-man-zenbooker.js';

const NOW = new Date('2026-10-07T15:00:00.000Z');
const SIGNING_SECRET = 'test-signing-secret';
const TWILIO_TOKEN = 'twilio-auth-token-secret';
const FULL_PHONE = '+16125550101';
const JOB_ID = '1710000000000x730395';

function enabledEnv(extra = {}) {
  return {
    MCP_SQUARE_PAYROLL_SECRET: SIGNING_SECRET,
    CAR_TEXT_ENABLED: 'true',
    TWILIO_ACCOUNT_SID: 'AC_test_sid',
    TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
    TWILIO_FROM_NUMBER: '+19526496388',
    ...extra,
  };
}

function job(overrides = {}) {
  return {
    id: JOB_ID,
    job_number: '730395',
    start_date: '2026-10-07T14:00:00.000Z',
    end_date: '2026-10-07T16:00:00.000Z',
    time_slot: { type: 'arrival_window', name: '9:00 AM - 11:00 AM' },
    status: 'scheduled',
    canceled: false,
    service_name: 'TV Mounting',
    customer: { name: 'Pat Waconia', phone: '6125550101' },
    service_address: {
      line1: '100 Main St',
      city: 'Waconia',
      state: 'MN',
      postal_code: '55387',
    },
    ...overrides,
  };
}

function otherJob() {
  return job({
    id: '1710000000000x555',
    job_number: '730400',
    start_date: '2026-10-07T16:30:00.000Z',
    end_date: '2026-10-07T18:00:00.000Z',
    time_slot: { type: 'specific_time', name: '11:30 AM' },
    customer: { name: 'Sam Lake', phone: '6125550199' },
    service_address: {
      formatted: '500 Hennepin Ave, Minneapolis, MN 55403, USA',
    },
  });
}

function memoryKv() {
  const store = new Map();
  return {
    store,
    async set(key, value, opts = {}) {
      if (opts.nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async del(key) {
      store.delete(key);
      return 1;
    },
  };
}

function captureLogger() {
  const lines = [];
  const record = (...args) => {
    lines.push(args.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
  };
  return { lines, log: record, info: record, warn: record, error: record, debug: record };
}

function clientWith(list) {
  return {
    async listJobs() {
      return list();
    },
    async getJob() {
      throw new Error('eta text must not fetch one job');
    },
  };
}

function harness({
  jobs = [job()],
  env = enabledEnv(),
  now = new Date(NOW.getTime()),
  kv = memoryKv(),
  httpClient,
  sendSms,
  logger = captureLogger(),
} = {}) {
  const posts = [];
  const client = clientWith(() => jobs);
  const resolvedHttp = httpClient || {
    async post(url, data, config) {
      posts.push({ url, data, config });
      return { data: { sid: 'SM_test_once' } };
    },
  };
  const deps = {
    client,
    now,
    env,
    kv,
    logger,
    httpClient: resolvedHttp,
    sendSms,
  };
  return {
    posts,
    logger,
    kv,
    deps,
    now,
    call: (args) => textNextCustomerEta(args, deps),
  };
}

const PREVIEW_TEXT = "Hi Pat, this is Marshall with The Mounting Man. I'm about 12 minutes away. See you soon!";

function assertNothingSent(result, posts) {
  assert.equal(result.sent, false);
  assert.equal(posts.length, 0);
}

test('kill switch off sends nothing', async () => {
  for (const flag of [undefined, 'false', 'TRUE', '1', '']) {
    const env = enabledEnv();
    if (flag === undefined) delete env.CAR_TEXT_ENABLED;
    else env.CAR_TEXT_ENABLED = flag;
    const box = harness({ env });
    const result = await box.call({
      minutes: 12,
      confirm: true,
      preview_token: 'etap1.aaaa.bbbb',
    });
    assert.equal(result.spoken, 'Customer texting is turned off right now');
    assert.equal(result.reason, 'disabled');
    assertNothingSent(result, box.posts);
  }
});

test('step 1 sends nothing and returns a spoken preview', async () => {
  const box = harness();
  const result = await box.call({ minutes: 12, note: '  Gate is open.  ' });
  assertNothingSent(result, box.posts);
  assert.equal(result.reason, 'preview');
  assert.equal(result.first_name, 'Pat');
  assert.equal(result.job_time, '9:00 AM - 11:00 AM');
  assert.equal(result.city, 'Waconia');
  assert.equal(result.phone_last4, '0101');
  assert.equal(
    result.text,
    "Hi Pat, this is Marshall with The Mounting Man. I'm about 12 minutes away. See you soon! Gate is open.",
  );
  assert.equal(result.spoken, `${result.text} Want me to send it?`);
  assert.equal(typeof result.preview_token, 'string');
  assert.equal(result.phone_e164, undefined);
  assert.equal(JSON.stringify({ ...result, preview_token: undefined }).includes(FULL_PHONE), false);
  assert.equal(box.logger.lines.length, 0);
});

test('a valid confirm sends exactly the previewed text once', async () => {
  const box = harness();
  const preview = await box.call({ minutes: 12 });
  assert.equal(preview.text, PREVIEW_TEXT);
  assert.equal(box.posts.length, 0);

  const sent = await box.call({
    minutes: 12,
    confirm: true,
    preview_token: preview.preview_token,
  });
  assert.equal(sent.sent, true);
  assert.equal(sent.spoken, "Sent. I texted Pat that I'm about 12 minutes away.");
  assert.equal(box.posts.length, 1);
  const params = new URLSearchParams(box.posts[0].data);
  assert.equal(params.get('Body'), PREVIEW_TEXT);
  assert.equal(params.get('To'), FULL_PHONE);
  assert.equal(params.get('From'), '+19526496388');
  assert.match(box.posts[0].url, /\/Accounts\/AC_test_sid\/Messages\.json$/);
  assert.equal(sent.twilio_sid, 'SM_test_once');
  assert.match(box.logger.lines[0], /sent job=1710000000000x730395 last4=0101 minutes=12 sid=SM_test_once/);
});

function tamperText(token) {
  const [version, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.text = claims.text.replace('minutes', 'hours');
  const next = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${version}.${next}.${signature}`;
}

test('tampered text sends nothing', async () => {
  const box = harness();
  const preview = await box.call({ minutes: 12 });
  const result = await box.call({
    minutes: 12,
    confirm: true,
    preview_token: tamperText(preview.preview_token),
  });
  assert.equal(result.reason, 'bad_token');
  assert.match(result.spoken, /preview the text again/);
  assertNothingSent(result, box.posts);
});

test('wrong job sends nothing', async () => {
  const jobs = [job()];
  const box = harness({ jobs });
  const preview = await box.call({ minutes: 12 });
  jobs.splice(0, jobs.length, otherJob());
  const result = await box.call({
    minutes: 12,
    confirm: true,
    preview_token: preview.preview_token,
  });
  assert.equal(result.reason, 'mismatch');
  assert.match(result.spoken, /preview the text again/);
  assertNothingSent(result, box.posts);
});

test('expired token sends nothing', async () => {
  const box = harness();
  const preview = await box.call({ minutes: 12 });
  box.now.setTime(box.now.getTime() + (5 * 60 * 1000));
  const result = await box.call({
    minutes: 12,
    confirm: true,
    preview_token: preview.preview_token,
  });
  assert.equal(result.reason, 'expired');
  assert.match(result.spoken, /preview the text again/);
  assertNothingSent(result, box.posts);
});

test('rate limit blocks a second send', async () => {
  const box = harness();
  const preview = await box.call({ minutes: 12 });
  const args = { minutes: 12, confirm: true, preview_token: preview.preview_token };
  const first = await box.call(args);
  const second = await box.call(args);
  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'rate_limited');
  assert.match(second.spoken, /last 10 minutes/);
  assert.equal(box.posts.length, 1);
  assert.equal(new URLSearchParams(box.posts[0].data).get('Body'), PREVIEW_TEXT);
});

test('KV down sends nothing', async () => {
  const broken = {
    async set() {
      throw new Error('ECONNREFUSED kv down');
    },
  };
  const box = harness({ kv: broken });
  const preview = await box.call({ minutes: 12 });
  const result = await box.call({
    minutes: 12,
    confirm: true,
    preview_token: preview.preview_token,
  });
  assert.equal(result.reason, 'kv_unavailable');
  assert.match(result.spoken, /didn't text them/);
  assertNothingSent(result, box.posts);

  const missing = harness({ kv: null, env: enabledEnv() });
  const previewAgain = await missing.call({ minutes: 12 });
  const blocked = await missing.call({
    minutes: 12,
    confirm: true,
    preview_token: previewAgain.preview_token,
  });
  assert.equal(blocked.reason, 'kv_unavailable');
  assert.equal(missing.posts.length, 0);
});

test('no next job sends nothing', async () => {
  const box = harness({ jobs: [] });
  const result = await box.call({ minutes: 12, confirm: true, preview_token: 'nope' });
  assert.equal(result.reason, 'no_job');
  assert.match(result.spoken, /no upcoming jobs/);
  assert.equal(result.preview_token, undefined);
  assertNothingSent(result, box.posts);
});

test('a phone that cannot be normalized sends nothing', async () => {
  const box = harness({
    jobs: [job({ customer: { name: 'Pat Waconia', phone: '555' } })],
  });
  const result = await box.call({ minutes: 12 });
  assert.equal(result.reason, 'bad_phone');
  assert.match(result.spoken, /can't be texted/);
  assert.equal(result.preview_token, undefined);
  assertNothingSent(result, box.posts);
});

test('logs stay redacted when a send succeeds and when Twilio throws', async () => {
  const box = harness();
  const preview = await box.call({ minutes: 12 });
  box.deps.httpClient = {
    async post() {
      const error = new Error(`Twilio rejected ${FULL_PHONE} token ${TWILIO_TOKEN} secret ${SIGNING_SECRET}`);
      error.response = { data: { to: FULL_PHONE, auth: TWILIO_TOKEN } };
      throw error;
    },
  };
  const failed = await box.call({
    minutes: 12,
    confirm: true,
    preview_token: preview.preview_token,
  });
  assert.equal(failed.sent, false);
  assert.equal(failed.reason, 'twilio_failed');

  box.deps.httpClient = {
    async post(url, data, config) {
      box.posts.push({ url, data, config });
      return { data: { sid: 'SM_redacted_ok' } };
    },
  };
  const sent = await box.call({
    minutes: 12,
    confirm: true,
    preview_token: preview.preview_token,
  });
  assert.equal(sent.sent, true);

  const blob = box.logger.lines.join('\n');
  assert.match(blob, /last4=0101/);
  assert.match(blob, /sid=SM_redacted_ok/);
  assert.equal(blob.includes(FULL_PHONE), false);
  assert.equal(blob.includes('6125550101'), false);
  assert.equal(blob.includes(TWILIO_TOKEN), false);
  assert.equal(blob.includes(SIGNING_SECRET), false);
  assert.equal(blob.includes(preview.preview_token), false);
  assert.equal(blob.includes('Authorization'), false);
  assert.equal(blob.includes(PREVIEW_TEXT), false);
});

test('the zenbooker handler lists the tool and previews without sending', async () => {
  assert.equal(textNextCustomerEtaTool.name, TEXT_NEXT_CUSTOMER_ETA);
  assert.match(textNextCustomerEtaTool.description, /step 1 first/i);
  assert.match(textNextCustomerEtaTool.description, /aloud/);
  assert.match(textNextCustomerEtaTool.description, /Mr\. Wayne clearly says yes in this conversation/);

  const posts = [];
  const handler = createMountingManZenbookerHandler({
    env: enabledEnv(),
    now: new Date(NOW.getTime()),
    client: clientWith(() => [job()]),
    kv: memoryKv(),
    logger: captureLogger(),
    httpClient: {
      async post(url, data) {
        posts.push({ url, data });
        return { data: { sid: 'SM_should_not_send' } };
      },
    },
  });
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    },
  };
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${SIGNING_SECRET}`, accept: 'application/json' },
    body: {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: TEXT_NEXT_CUSTOMER_ETA, arguments: { minutes: 12 } },
    },
  }, res);
  assert.equal(res.statusCode, 200);
  const feed = res.body.result.structuredContent;
  assert.equal(feed.text, PREVIEW_TEXT);
  assert.equal(feed.sent, false);
  assert.match(feed.spoken, /Want me to send it\?/);
  assert.equal(res.body.result.content[0].text, feed.spoken);
  assert.equal(posts.length, 0);

  const listed = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${SIGNING_SECRET}` },
    body: { jsonrpc: '2.0', id: 8, method: 'tools/list' },
  }, listed);
  const tool = listed.body.result.tools.find((entry) => entry.name === TEXT_NEXT_CUSTOMER_ETA);
  assert.ok(tool);
  assert.match(tool.description, /Mr\. Wayne clearly says yes in this conversation/);
});
