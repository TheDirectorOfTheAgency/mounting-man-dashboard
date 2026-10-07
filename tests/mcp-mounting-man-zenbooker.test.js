import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { MCP_PUBLIC_ORIGIN, mcpWwwAuthenticateHeader } from '../lib/mcp-http.mjs';
import {
  createAuthorizeHandler,
  createProtectedResourceMetadataHandler,
  createTokenHandler,
  pkceS256Challenge,
} from '../lib/mcp-oauth.mjs';
import { chicagoDayBounds } from '../lib/square-reporting-feed.mjs';
import {
  GET_JOB,
  GET_JOBS_FOR_DAY,
  GET_ROUTE_FOR_DAY,
  GET_UPCOMING_JOBS,
  MCP_ZENBOOKER_CLIENT_ID,
  createZenbookerReadClient,
  googleMapsDirectionsUrl,
} from '../lib/zenbooker-jobs-feed.mjs';
import { createMountingManZenbookerHandler } from '../pages/api/mcp/mounting-man-zenbooker.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-10-07T15:00:00.000Z');
const SECRET = 'test-mcp-secret';

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    ended: false,
    chunks: [],
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
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
    send(value) {
      this.body = value;
      return this;
    },
    redirect(code, url) {
      this.statusCode = code;
      this.headers.location = url;
      this.ended = true;
      return this;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(value) {
      if (value !== undefined) this.body = value;
      this.ended = true;
      return this;
    },
  };
}

function request({ method = 'POST', headers = {}, body = {}, query = {} } = {}) {
  return { method, headers, body, query };
}

function authorized(overrides = {}) {
  return request({
    headers: { authorization: `Bearer ${SECRET}`, accept: 'application/json' },
    ...overrides,
  });
}

function waconiaJob(overrides = {}) {
  return {
    id: '1710000000000x730395',
    job_number: '730395',
    start_date: '2026-10-07T14:00:00.000Z',
    end_date: '2026-10-07T16:00:00.000Z',
    time_slot: { type: 'arrival_window', name: '9:00 AM - 11:00 AM' },
    status: 'scheduled',
    canceled: false,
    service_name: 'TV Mounting',
    services: [{
      service_name: 'TV Mounting',
      service_selections: [{
        name: 'TV Size',
        selected_options: [{ display_label: '65 Inches' }],
      }],
      pricing_summary: [{ description: '65 Inches', amount: 249 }],
    }],
    customer: {
      name: 'Pat Waconia',
      phone: '6125550101',
      email: 'secret@example.com',
      notes: [{ text: 'Dogs in the yard' }],
    },
    service_address: {
      line1: '100 Main St',
      city: 'Waconia',
      state: 'MN',
      postal_code: '55387',
    },
    assigned_providers: [{ name: 'Marshall Wayne', email: 'installer-secret@example.com' }],
    job_notes: [{ text: 'Gate code 1234' }],
    service_fields: [{
      field_type: 'intake',
      field_name: 'Special instructions',
      text_value: 'Use the side door',
    }],
    invoice: { total: '249.00', stripe_customer_id: 'cus_secret' },
    ...overrides,
  };
}

function minneapolisJob() {
  return waconiaJob({
    id: '1710000000000x555',
    job_number: '730400',
    start_date: '2026-10-07T22:00:00.000Z',
    end_date: '2026-10-08T00:00:00.000Z',
    time_slot: { type: 'specific_time', name: '5:00 PM' },
    customer: { name: 'Sam Lake', phone: '6125550199', email: 'other-secret@example.com' },
    service_address: {
      formatted: '500 Hennepin Ave, Minneapolis, MN 55403, USA',
    },
    job_notes: 'Call on arrival',
    service_fields: [],
    services: [{ service_name: 'MantelMount' }],
    service_name: 'MantelMount',
    invoice: { total: 325 },
  });
}

function cancelledJob() {
  return waconiaJob({
    id: '1710000000000x999',
    job_number: '730111',
    canceled: true,
    status: 'scheduled',
    customer: { name: 'Cancelled Customer', phone: '6125550000' },
  });
}

function lateJob() {
  return waconiaJob({
    id: '1710000000000x888',
    job_number: '730777',
    start_date: '2026-10-08T04:30:00.000Z',
    time_slot: { type: 'specific_time', name: '11:30 PM' },
    customer: { name: 'Night Owl', phone: '6125550130' },
    service_address: { line1: '9 Night St', city: 'Minneapolis', state: 'MN', postal_code: '55401' },
  });
}

function nextDayJob() {
  return waconiaJob({
    id: '1710000000000x222',
    job_number: '730222',
    start_date: '2026-10-08T15:00:00.000Z',
    customer: { name: 'Next Day', phone: '6125550222' },
    service_address: { line1: '2 Tomorrow Rd', city: 'Austin', state: 'TX', postal_code: '78701' },
  });
}

function handlerWith(client, env = { MCP_SQUARE_PAYROLL_SECRET: SECRET }) {
  return createMountingManZenbookerHandler({
    env,
    client,
    now: NOW,
    logger: { error() {}, warn() {} },
  });
}

async function callTool(client, name, args = {}, env) {
  const handler = handlerWith(client, env);
  const res = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
  }), res);
  return res;
}

function assertNoSecrets(payload) {
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('secret@example.com'), false);
  assert.equal(serialized.includes('other-secret@example.com'), false);
  assert.equal(serialized.includes('installer-secret@example.com'), false);
  assert.equal(serialized.includes('cus_secret'), false);
  assert.equal(serialized.includes(SECRET), false);
}

test('read client and route source stay GET-only and off Square', () => {
  const feed = readFileSync(path.join(root, 'lib/zenbooker-jobs-feed.mjs'), 'utf8');
  const route = readFileSync(path.join(root, 'pages/api/mcp/mounting-man-zenbooker.js'), 'utf8');
  assert.equal(feed.includes("method: 'GET'"), true);
  assert.equal(/\b(POST|PUT|PATCH|DELETE)\b/.test(feed), false);
  assert.equal(/squareup|SQUARE_|squareClient/i.test(feed), false);
  assert.equal(/axios\.(post|put|patch|delete)/i.test(route), false);
  assert.equal(route.includes('ZENBOOKER_API_KEY'), false);
  assert.equal(feed.includes('ZENBOOKER_API_KEY'), true);
});

test('MCP route rejects a missing bearer and does not call ZenBooker', async () => {
  let listed = 0;
  const client = {
    async listJobs() { listed += 1; return []; },
    async getJob() { listed += 1; return null; },
  };
  const handler = handlerWith(client);
  const missing = response();
  await handler(request({
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: GET_JOBS_FOR_DAY, arguments: {} } },
  }), missing);
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.headers['www-authenticate'], mcpWwwAuthenticateHeader(
    MCP_PUBLIC_ORIGIN,
    'api/mcp/mounting-man-zenbooker',
  ));
  assert.equal(JSON.stringify(missing.body).includes(SECRET), false);
  assert.equal(listed, 0);
});

test('initialize and tools/list accept the payroll secret, cron secret, and query secret', async () => {
  const handler = handlerWith(null);
  const init = response();
  await handler(authorized({
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
  }), init);
  assert.equal(init.statusCode, 200);
  assert.equal(init.body.result.serverInfo.name, 'mounting-man-zenbooker');
  assert.match(init.body.result.instructions, /TV-mounting jobs/);
  assert.match(init.body.result.instructions, /route me to my jobs/);

  const cron = handlerWith(null, { CRON_SECRET: 'existing-cron' });
  const listed = response();
  await cron(request({
    headers: { authorization: 'Bearer existing-cron' },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  }), listed);
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [GET_JOBS_FOR_DAY, GET_UPCOMING_JOBS, GET_JOB, GET_ROUTE_FOR_DAY]);
  assert.match(listed.body.result.tools[0].description, /The Mounting Man/);
  assert.match(listed.body.result.tools[0].description, /ZenBooker/);
  assert.match(listed.body.result.tools[3].description, /route me to my jobs/);

  const query = response();
  await handler(request({
    query: { secret: SECRET },
    body: { jsonrpc: '2.0', id: 3, method: 'ping' },
  }), query);
  assert.equal(query.statusCode, 200);
  assert.deepEqual(query.body.result, {});
});

test('get_jobs_for_day returns Chicago-day jobs sorted by start and hides cancelled jobs', async () => {
  const calls = [];
  const client = {
    async listJobs(query) {
      calls.push(query);
      return [minneapolisJob(), cancelledJob(), lateJob(), nextDayJob(), waconiaJob()];
    },
    async getJob() { throw new Error('day list must not fetch one job'); },
  };
  const res = await callTool(client, GET_JOBS_FOR_DAY, {});
  assert.equal(res.statusCode, 200);
  const feed = res.body.result.structuredContent;
  assert.equal(feed.date, '2026-10-07');
  assert.equal(feed.timezone, 'America/Chicago');
  assert.equal(feed.business, 'The Mounting Man');
  assert.equal(feed.source, 'ZenBooker');
  assert.deepEqual(feed.jobs.map((job) => job.job_number), ['730395', '730400', '730777']);
  assert.equal(feed.jobs[0].service_address, '100 Main St, Waconia, MN 55387');
  assert.equal(feed.jobs[0].customer_name, 'Pat Waconia');
  assert.equal(feed.jobs[0].customer_phone, '6125550101');
  assert.deepEqual(feed.jobs[0].installers, ['Marshall Wayne']);
  assert.deepEqual(feed.jobs[0].services, ['TV Mounting']);
  assert.match(feed.jobs[0].notes, /Gate code 1234/);
  assert.match(feed.jobs[0].notes, /Use the side door/);
  assert.match(feed.jobs[0].notes, /Dogs in the yard/);
  assert.deepEqual(feed.jobs[0].price, { amount: 249, currency: 'USD' });
  assert.equal(feed.jobs[0].time_window.label, '9:00 AM - 11:00 AM');
  assert.equal(feed.jobs[1].time_window.label, '5:00 PM');
  assert.equal(feed.jobs[1].service_address, '500 Hennepin Ave, Minneapolis, MN 55403, USA');
  assert.equal(feed.jobs[2].date, '2026-10-07');
  const bounds = chicagoDayBounds('2026-10-07');
  assert.equal(calls[0].startDateMin, bounds.beginTime);
  assert.equal(calls[0].startDateMax, bounds.endTime);
  assert.equal(calls[0].includeCancelled, false);
  assertNoSecrets(res.body);

  const withCancelled = await callTool(client, GET_JOBS_FOR_DAY, { include_cancelled: true });
  const numbers = withCancelled.body.result.structuredContent.jobs.map((job) => job.job_number);
  assert.equal(numbers.includes('730111'), true);
  assert.equal(calls.at(-1).includeCancelled, true);
});

test('get_upcoming_jobs groups by Chicago day and rejects days above 31', async () => {
  const client = {
    async listJobs() {
      return [nextDayJob(), waconiaJob(), cancelledJob(), minneapolisJob()];
    },
    async getJob() { return null; },
  };
  const res = await callTool(client, GET_UPCOMING_JOBS, { days: 2 });
  const feed = res.body.result.structuredContent;
  assert.equal(feed.start_date, '2026-10-07');
  assert.equal(feed.end_date, '2026-10-08');
  assert.equal(feed.days, 2);
  assert.deepEqual(feed.by_day.map((day) => day.date), ['2026-10-07', '2026-10-08']);
  assert.deepEqual(feed.by_day[0].jobs.map((job) => job.job_number), ['730395', '730400']);
  assert.deepEqual(feed.by_day[1].jobs.map((job) => job.job_number), ['730222']);
  assert.equal(feed.by_day[0].jobs[0].customer_phone, '6125550101');
  assertNoSecrets(res.body);

  const tooMany = await callTool(client, GET_UPCOMING_JOBS, { days: 32 });
  assert.equal(tooMany.body.error.code, -32602);
  assert.match(tooMany.body.error.message, /1 to 31/);

  const direct = response();
  await handlerWith(client)(authorized({
    body: { name: GET_UPCOMING_JOBS, days: '7' },
  }), direct);
  assert.equal(direct.statusCode, 200);
  assert.equal(direct.body.days, 7);
});

test('get_job returns one job by id or job number and omits customer email', async () => {
  const calls = { listed: 0, got: 0 };
  const client = {
    async listJobs() {
      calls.listed += 1;
      return [minneapolisJob(), waconiaJob({ job_number: '#730395' })];
    },
    async getJob(id) {
      calls.got += 1;
      assert.equal(id, '1710000000000x730395');
      return waconiaJob();
    },
  };
  const byId = await callTool(client, GET_JOB, { job_id: '1710000000000x730395' });
  const idFeed = byId.body.result.structuredContent;
  assert.equal(idFeed.found, true);
  assert.equal(idFeed.job.job_number, '730395');
  assert.equal(idFeed.job.service_details[0].name, 'TV Mounting');
  assert.equal(idFeed.job.service_details[0].options.includes('65 Inches'), true);
  assert.equal(calls.got, 1);
  assert.equal(calls.listed, 0);
  assertNoSecrets(byId.body);

  const byNumber = await callTool(client, GET_JOB, { job_number: '730395' });
  assert.equal(byNumber.body.result.structuredContent.found, true);
  assert.equal(byNumber.body.result.structuredContent.job.job_id, '1710000000000x730395');
  assert.equal(calls.listed, 1);

  const missingClient = {
    async listJobs() { return []; },
    async getJob() { return null; },
  };
  const missing = await callTool(missingClient, GET_JOB, { job_number: '000' });
  assert.equal(missing.body.result.structuredContent.found, false);
  assert.equal(missing.body.result.structuredContent.job, null);

  const invalid = await callTool(client, GET_JOB, {});
  assert.equal(invalid.body.error.code, -32602);
});

test('get_route_for_day builds encoded Google and Apple map links in start order', async () => {
  const client = {
    async listJobs(query) {
      assert.equal(query.includeCancelled, false);
      return [minneapolisJob(), cancelledJob(), nextDayJob(), lateJob(), waconiaJob()];
    },
    async getJob() { throw new Error('route must not fetch one job'); },
  };
  const res = await callTool(client, GET_ROUTE_FOR_DAY, { date: '2026-10-07' });
  const feed = res.body.result.structuredContent;
  assert.deepEqual(feed.jobs.map((job) => job.job_number), ['730395', '730400', '730777']);
  const addresses = feed.jobs.map((job) => job.service_address);
  assert.equal(feed.google_maps_url, googleMapsDirectionsUrl(addresses));
  assert.match(feed.google_maps_url, /^https:\/\/www\.google\.com\/maps\/dir\//);
  assert.equal(feed.google_maps_url.includes(' '), false);
  assert.equal(feed.google_maps_url.includes(encodeURIComponent(addresses[0])), true);
  assert.equal(feed.google_maps_url.includes(encodeURIComponent(addresses[1])), true);
  assert.equal(
    feed.apple_maps_url,
    `https://maps.apple.com/?daddr=${encodeURIComponent(addresses[0])}&dirflg=d`,
  );
  assert.equal(feed.jobs.some((job) => job.job_number === '730111'), false);
  assertNoSecrets(res.body);

  const empty = await callTool({
    async listJobs() { return []; },
    async getJob() { return null; },
  }, GET_ROUTE_FOR_DAY, { date: '2026-10-07' });
  assert.equal(empty.body.result.structuredContent.google_maps_url, null);
  assert.equal(empty.body.result.structuredContent.apple_maps_url, null);

  const badDate = await callTool(client, GET_ROUTE_FOR_DAY, { date: 'October 7' });
  assert.equal(badDate.body.error.code, -32602);
});

test('unconfigured ZenBooker is an error result and unknown tools are rejected', async () => {
  const handler = handlerWith(null);
  const failed = response();
  await handler(authorized({
    body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: GET_JOBS_FOR_DAY, arguments: {} } },
  }), failed);
  assert.equal(failed.body.result.isError, true);
  assert.equal(failed.body.result.content[0].text, 'Failed to load ZenBooker jobs');

  const unknown = response();
  await handler(authorized({
    body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'cancel_job', arguments: {} } },
  }), unknown);
  assert.equal(unknown.body.error.code, -32601);
});

test('ZenBooker read client only GETs, paginates, and tolerates bare coordinates', async () => {
  const calls = [];
  const page = {
    results: [{
      id: '1710000000000x1',
      job_number: '1',
      start_date: '2026-10-07T14:00:00.000Z',
      customer: { name: 'A', phone: '1' },
    }],
    has_more: true,
    next_cursor: 100,
  };
  const raw = JSON.stringify(page).replace('"lat":', '"lat":');
  const broken = `{"results":[{"id":"2","job_number":"2","lat":,"lng":}],"has_more":false,"next_cursor":null}`;
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, hasBody: Object.prototype.hasOwnProperty.call(options, 'body') });
    assert.equal(options.headers.Authorization, 'Bearer zb-key');
    if (String(url).includes('/jobs/missing')) {
      return { ok: false, status: 404, async text() { return ''; } };
    }
    const body = calls.length === 1 ? raw : broken;
    return { ok: true, status: 200, async text() { return body; } };
  };
  const client = createZenbookerReadClient({
    apiKey: 'zb-key',
    baseUrl: 'https://api.zenbooker.com/v1/',
    fetchImpl,
  });
  const jobs = await client.listJobs({
    startDateMin: '2026-10-07T05:00:00.000Z',
    startDateMax: '2026-10-08T05:00:00.000Z',
    includeCancelled: false,
  });
  assert.equal(jobs.length, 2);
  assert.equal(calls.every((call) => call.method === 'GET' && call.hasBody === false), true);
  const first = new URL(calls[0].url);
  assert.equal(first.pathname, '/v1/jobs');
  assert.equal(first.searchParams.get('canceled'), 'false');
  assert.equal(first.searchParams.get('sort_by'), 'start_time');
  assert.equal(first.searchParams.get('start_date_min'), '2026-10-07T05:00:00.000Z');
  assert.equal(calls[1].url.includes('cursor=100'), true);
  assert.equal(await client.getJob('missing'), null);
  assert.equal(calls.at(-1).method, 'GET');
});

test('protected resource metadata and OAuth accept client id mounting-man-zenbooker', async () => {
  const metadata = createProtectedResourceMetadataHandler();
  const listed = response();
  await metadata(request({
    method: 'GET',
    query: { path: ['api', 'mcp', 'mounting-man-zenbooker'] },
  }), listed);
  assert.equal(
    listed.body.resource,
    'https://mounting-man-dashboard.vercel.app/api/mcp/mounting-man-zenbooker',
  );
  assert.deepEqual(listed.body.authorization_servers, [MCP_PUBLIC_ORIGIN]);

  const env = { MCP_SQUARE_PAYROLL_SECRET: SECRET };
  const verifier = 'zenbooker-pkce-verifier-value-32b';
  const authorize = createAuthorizeHandler({ env });
  const redirected = response();
  await authorize(request({
    method: 'GET',
    query: {
      response_type: 'code',
      client_id: MCP_ZENBOOKER_CLIENT_ID,
      redirect_uri: 'https://grok.com/auth/callback',
      code_challenge: pkceS256Challenge(verifier),
      code_challenge_method: 'S256',
      state: 'zb-state',
      scope: 'mcp',
    },
  }), redirected);
  assert.equal(redirected.statusCode, 302);
  const location = new URL(redirected.headers.location);
  assert.equal(location.searchParams.get('state'), 'zb-state');
  assert.equal(redirected.headers.location.includes(SECRET), false);

  const token = createTokenHandler({ env });
  const issued = response();
  await token(request({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: {
      grant_type: 'authorization_code',
      code: location.searchParams.get('code'),
      redirect_uri: 'https://grok.com/auth/callback',
      client_id: MCP_ZENBOOKER_CLIENT_ID,
      code_verifier: verifier,
    },
  }), issued);
  assert.equal(issued.statusCode, 200);
  assert.equal(issued.body.token_type, 'Bearer');
  assert.equal(issued.body.access_token, SECRET);
  assert.equal(JSON.stringify({ ...issued.body, access_token: '[redacted]' }).includes(SECRET), false);
});
