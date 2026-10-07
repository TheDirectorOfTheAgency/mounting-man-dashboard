import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { MCP_ZENBOOKER_CLIENT_ID } from '../lib/mcp-oauth.mjs';
import {
  GET_JOB,
  GET_JOBS_FOR_DAY,
  GET_ROUTE_FOR_DAY,
  GET_UPCOMING_JOBS,
  createZenbookerReadClient,
} from '../lib/zenbooker-jobs-feed.mjs';
import { createMountingManZenbookerHandler } from '../pages/api/mcp/mounting-man-zenbooker.js';

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
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end() {
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

function jobsFixture() {
  return [
    {
      id: '1690000000000x730395',
      job_number: '#730395',
      start_date: '2026-10-07T14:00:00.000Z',
      end_date: '2026-10-07T16:00:00.000Z',
      time_slot: { type: 'arrival_window', name: '9:00 AM - 11:00 AM' },
      status: 'scheduled',
      canceled: false,
      timezone: 'America/Chicago',
      service_name: 'TV Mounting',
      services: [{ service_name: 'TV Mounting' }, { name: 'MantelMount' }],
      service_address: { formatted: '123 Main St, Waconia, MN 55387' },
      customer: {
        name: 'Waconia Customer',
        phone: '555-0100',
        email: 'hidden-waconia@example.com',
        notes: [{ text: 'Gate code 1234' }],
      },
      assigned_providers: [{ name: 'Marshall Wayne', email: 'marshall@example.com', id: '111x222' }],
      job_notes: [{ text: 'Call on the way' }],
      special_instructions: 'Use the side door',
      invoice: {
        total: '450.00',
        status: 'unpaid',
        amount_due: '450.00',
        stripe_customer_id: 'cus_secret',
      },
      territory: { name: 'Minneapolis', id: 'terr-secret' },
      created_by: 'staff',
    },
    {
      id: '1690000000000x555555',
      job_number: '730400',
      start_date: '2026-10-07T22:00:00.000Z',
      end_date: '2026-10-07T23:30:00.000Z',
      time_slot: { type: 'specific_time', name: '5:00 PM' },
      status: 'scheduled',
      canceled: false,
      service_name: 'TV Mounting',
      service_address: {
        line1: '500 Hennepin Ave',
        city: 'Minneapolis',
        state: 'MN',
        postal_code: '55401',
      },
      customer: { name: 'Minneapolis Customer', phone: '555-0199', email: 'hidden-mpls@example.com' },
      assigned_providers: [{ name: 'Michael Wenzel' }],
      job_notes: 'Fifth floor',
      invoice: { total_price: 275.5 },
    },
    {
      id: '1690000000000x111',
      job_number: '730111',
      start_date: '2026-10-07T18:00:00.000Z',
      status: 'scheduled',
      canceled: true,
      service_name: 'TV Mounting',
      service_address: { formatted: '1 Cancelled St, Minneapolis, MN 55401' },
      customer: { name: 'Cancelled Customer', phone: '555-0000', email: 'hidden-cancel@example.com' },
    },
    {
      id: 'edge-prev',
      job_number: '729999',
      start_date: '2026-10-07T04:30:00.000Z',
      status: 'scheduled',
      canceled: false,
      service_name: 'TV Mounting',
      service_address: { formatted: '1 Edge St, Minneapolis, MN 55401' },
      customer: { name: 'Edge Customer', phone: '555-1111' },
    },
    {
      id: '1690000000000x222',
      job_number: '730222',
      start_date: '2026-10-08T15:00:00.000Z',
      status: 'scheduled',
      canceled: false,
      service_name: 'TV Mounting',
      service_address: { formatted: '9 Tomorrow Rd, Austin, TX 78701' },
      customer: { name: 'Tomorrow Customer', phone: '555-2222' },
    },
    {
      id: '1690000000000x333',
      job_number: '731000',
      start_date: '2026-10-28T16:00:00.000Z',
      time_slot: { name: '11:00 AM' },
      status: 'scheduled',
      canceled: false,
      service_name: 'Samsung Frame TV Mounting',
      service_address: { formatted: '50 Future Ave, Houston, TX 77002' },
      customer: { name: 'Future Customer', phone: '555-3333' },
      assigned_providers: ['1690000000000x999'],
    },
  ];
}

function mockClient(jobs = jobsFixture()) {
  const calls = [];
  return {
    calls,
    async listJobs(query) {
      calls.push({ op: 'list', query, method: 'GET' });
      return jobs;
    },
    async getJob(id) {
      calls.push({ op: 'get', id, method: 'GET' });
      return jobs.find((job) => String(job.id) === String(id)) || null;
    },
  };
}

function handlerWith(client, env = { MCP_SQUARE_PAYROLL_SECRET: SECRET }) {
  return createMountingManZenbookerHandler({
    env,
    now: NOW,
    zenbookerClient: client,
    logger: { error() {}, warn() {} },
  });
}

async function callTool(handler, name, argumentsObject, id = 1) {
  const res = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: argumentsObject },
    },
  }), res);
  return res;
}

function assertNoSecrets(serialized) {
  assert.equal(serialized.includes('hidden-waconia@example.com'), false);
  assert.equal(serialized.includes('hidden-mpls@example.com'), false);
  assert.equal(serialized.includes('hidden-cancel@example.com'), false);
  assert.equal(serialized.includes('cus_secret'), false);
  assert.equal(serialized.includes('terr-secret'), false);
  assert.equal(serialized.includes('marshall@example.com'), false);
  assert.equal(serialized.includes(SECRET), false);
}

test('zenbooker MCP rejects missing or wrong secrets and accepts payroll or cron secrets', async () => {
  const handler = handlerWith(mockClient());
  const missing = response();
  await handler(request({ body: { jsonrpc: '2.0', id: 1, method: 'initialize' } }), missing);
  assert.equal(missing.statusCode, 401);
  assert.match(String(missing.headers['www-authenticate']), /oauth-protected-resource\/api\/mcp\/mounting-man-zenbooker/);
  assert.equal(String(missing.headers['www-authenticate']).includes(SECRET), false);

  const wrong = response();
  await handler(request({
    headers: { authorization: 'Bearer nope' },
    body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  }), wrong);
  assert.equal(wrong.statusCode, 401);

  const ok = response();
  await handler(authorized({
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
  }), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.result.serverInfo.name, 'mounting-man-zenbooker');
  assert.match(ok.body.result.instructions, /The Mounting Man/);
  assert.match(ok.body.result.instructions, /ZenBooker/);
  assert.match(ok.body.result.instructions, /TV-mounting/);

  const cron = createMountingManZenbookerHandler({
    env: { CRON_SECRET: 'existing-cron' },
    now: NOW,
    zenbookerClient: mockClient(),
    logger: { error() {} },
  });
  const listed = response();
  await cron(request({
    headers: { authorization: 'Bearer existing-cron' },
    query: { secret: 'ignored-because-bearer-wins' },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  }), listed);
  assert.equal(listed.statusCode, 200);
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [GET_JOBS_FOR_DAY, GET_UPCOMING_JOBS, GET_JOB, GET_ROUTE_FOR_DAY]);
  for (const tool of listed.body.result.tools) {
    assert.match(tool.description, /The Mounting Man/);
    assert.match(tool.description, /ZenBooker/);
    assert.match(tool.description, /TV-mounting|TV mounting|mounts/);
  }

  const querySecret = response();
  await handler(request({
    query: { secret: SECRET },
    body: { jsonrpc: '2.0', id: 3, method: 'ping' },
  }), querySecret);
  assert.equal(querySecret.statusCode, 200);
  assert.equal(MCP_ZENBOOKER_CLIENT_ID, 'mounting-man-zenbooker');
});

test('get_jobs_for_day returns Chicago-day jobs sorted by start and skips cancelled', async () => {
  const client = mockClient();
  const handler = handlerWith(client);
  const blocked = response();
  let listed = 0;
  const guarded = {
    async listJobs() { listed += 1; return []; },
    async getJob() { listed += 1; return null; },
  };
  await handlerWith(guarded)(request({
    body: {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: GET_JOBS_FOR_DAY, arguments: { date: '2026-10-07' } },
    },
  }), blocked);
  assert.equal(blocked.statusCode, 401);
  assert.equal(listed, 0);

  const res = await callTool(handler, GET_JOBS_FOR_DAY, { date: '2026-10-07' });
  assert.equal(res.statusCode, 200);
  const day = res.body.result.structuredContent;
  assert.equal(day.date, '2026-10-07');
  assert.equal(day.timezone, 'America/Chicago');
  assert.deepEqual(day.jobs.map((job) => job.job_number), ['730395', '730400']);
  assert.equal(day.jobs[0].time_window, '9:00 AM - 11:00 AM');
  assert.equal(day.jobs[1].time_window, '5:00 PM');
  assert.equal(day.jobs[0].service_address, '123 Main St, Waconia, MN 55387');
  assert.equal(day.jobs[1].service_address, '500 Hennepin Ave, Minneapolis, MN 55401');
  assert.deepEqual(day.jobs[0].services, ['TV Mounting', 'MantelMount']);
  assert.deepEqual(day.jobs[0].installers, ['Marshall Wayne']);
  assert.equal(day.jobs[0].customer_name, 'Waconia Customer');
  assert.equal(day.jobs[0].customer_phone, '555-0100');
  assert.match(day.jobs[0].notes, /Call on the way/);
  assert.match(day.jobs[0].notes, /Use the side door/);
  assert.match(day.jobs[0].notes, /Gate code 1234/);
  assert.equal(day.jobs[0].price, 450);
  assert.equal(day.jobs[1].price, 275.5);
  assert.equal(day.jobs[0].status, 'scheduled');
  assert.equal(client.calls.every((call) => call.method === 'GET'), true);
  assertNoSecrets(JSON.stringify(res.body));

  const withCancelled = await callTool(handler, GET_JOBS_FOR_DAY, {
    date: '2026-10-07',
    include_cancelled: true,
  }, 5);
  assert.deepEqual(
    withCancelled.body.result.structuredContent.jobs.map((job) => job.job_number),
    ['730395', '730111', '730400'],
  );

  const ahead = await callTool(handler, GET_JOBS_FOR_DAY, { date: '2026-10-28' }, 6);
  assert.equal(ahead.body.result.structuredContent.jobs[0].job_number, '731000');
  assert.deepEqual(ahead.body.result.structuredContent.jobs[0].installers, []);

  const bad = await callTool(handler, GET_JOBS_FOR_DAY, { date: '10/07/2026' }, 7);
  assert.equal(bad.body.error.code, -32602);
});

test('get_upcoming_jobs groups by day and rejects more than 31 days', async () => {
  const handler = handlerWith(mockClient());
  const week = await callTool(handler, GET_UPCOMING_JOBS, {});
  assert.equal(week.statusCode, 200);
  const body = week.body.result.structuredContent;
  assert.equal(body.days_requested, 7);
  assert.equal(body.days.length, 7);
  assert.equal(body.days[0].date, '2026-10-07');
  assert.deepEqual(body.days[0].jobs.map((job) => job.job_number), ['730395', '730400']);
  assert.equal(body.days[1].date, '2026-10-08');
  assert.equal(body.days[1].jobs[0].job_number, '730222');
  assert.equal(body.days.some((day) => day.jobs.some((job) => job.job_number === '731000')), false);
  assertNoSecrets(JSON.stringify(week.body));

  const month = await callTool(handler, GET_UPCOMING_JOBS, { days: '31' }, 2);
  assert.equal(month.body.result.structuredContent.days.length, 31);
  assert.equal(
    month.body.result.structuredContent.days.some((day) => day.date === '2026-10-28' && day.jobs[0].job_number === '731000'),
    true,
  );

  const tooMany = await callTool(handler, GET_UPCOMING_JOBS, { days: 32 }, 3);
  assert.equal(tooMany.body.error.code, -32602);
  assert.match(tooMany.body.error.message, /31/);
});

test('get_job returns one job by id or job number', async () => {
  const client = mockClient();
  const handler = handlerWith(client);
  const byNumber = await callTool(handler, GET_JOB, { job_number: '730395' });
  assert.equal(byNumber.statusCode, 200);
  const job = byNumber.body.result.structuredContent.job;
  assert.equal(byNumber.body.result.structuredContent.found, true);
  assert.equal(job.job_number, '730395');
  assert.equal(job.job_id, '1690000000000x730395');
  assert.equal(job.service_address, '123 Main St, Waconia, MN 55387');
  assert.equal(job.customer_phone, '555-0100');
  assert.equal(job.invoice.total, 450);
  assert.equal(job.invoice.status, 'unpaid');
  assert.equal(job.territory, 'Minneapolis');
  assert.equal(job.canceled, false);
  assert.equal(Object.hasOwn(job.invoice, 'stripe_customer_id'), false);
  assertNoSecrets(JSON.stringify(byNumber.body));

  const byId = await callTool(handler, GET_JOB, { job_id: '1690000000000x555555' }, 2);
  assert.equal(byId.body.result.structuredContent.job.job_number, '730400');
  assert.equal(byId.body.result.structuredContent.job.time_window, '5:00 PM');
  assert.equal(client.calls.filter((call) => call.op === 'list' && call.id).length, 0);

  const missing = await callTool(handler, GET_JOB, { job_number: '000000' }, 3);
  assert.equal(missing.body.result.structuredContent.found, false);

  const invalid = await callTool(handler, GET_JOB, {}, 4);
  assert.equal(invalid.body.error.code, -32602);
});

test('get_route_for_day orders stops and builds encoded map links', async () => {
  const handler = handlerWith(mockClient());
  const res = await callTool(handler, GET_ROUTE_FOR_DAY, { date: '2026-10-07' });
  assert.equal(res.statusCode, 200);
  const route = res.body.result.structuredContent;
  assert.deepEqual(route.stops.map((job) => job.job_number), ['730395', '730400']);
  assert.equal(
    route.google_maps_url,
    'https://www.google.com/maps/dir/123%20Main%20St%2C%20Waconia%2C%20MN%2055387/500%20Hennepin%20Ave%2C%20Minneapolis%2C%20MN%2055401',
  );
  assert.equal(
    route.apple_maps_url,
    'https://maps.apple.com/?daddr=123%20Main%20St%2C%20Waconia%2C%20MN%2055387',
  );
  assert.equal(route.google_maps_url.includes('1%20Cancelled'), false);
  assert.deepEqual(route.stops_missing_address, []);
  assertNoSecrets(JSON.stringify(res.body));

  const direct = response();
  await handler(authorized({
    body: { name: GET_ROUTE_FOR_DAY, arguments: {} },
  }), direct);
  assert.equal(direct.statusCode, 200);
  assert.equal(direct.body.date, '2026-10-07');
  assert.match(direct.body.google_maps_url, /^https:\/\/www\.google\.com\/maps\/dir\//);
});

test('read client uses GET only, paginates, and does not leak the api key', async () => {
  const key = 'zb-live-key-do-not-leak';
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.includes('/jobs/missing')) {
      return { ok: false, status: 404, async text() { return key; } };
    }
    if (url.includes('cursor=')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return '{"results":[{"id":"2","job_number":"2","service_address":{"lat":,"lng":-93.1}}],"has_more":false,"next_cursor":null}';
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          results: [{ id: '1', job_number: '1' }],
          has_more: true,
          next_cursor: 100,
        });
      },
    };
  };
  const client = createZenbookerReadClient({ apiKey: key, fetchImpl });
  const jobs = await client.listJobs({
    startDateMin: '2026-10-07T05:00:00.000Z',
    startDateMax: '2026-10-08T05:00:00.000Z',
  });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].service_address.lat, null);
  assert.equal(jobs[1].service_address.lng, -93.1);
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET']);
  assert.equal(calls[1].url.includes('cursor=100'), true);
  assert.equal(calls[0].url.includes('start_date_min=2026-10-07T05'), true);
  assert.equal(calls[0].url.includes('start=2026-10-07'), true);
  assert.equal(calls[0].url.includes('end=2026-10-08'), true);
  assert.equal(calls.every((call) => call.url.includes(key) === false), true);
  assert.equal(await client.getJob('missing'), null);

  const failing = createZenbookerReadClient({
    apiKey: key,
    fetchImpl: async () => ({ ok: false, status: 500, async text() { return key; } }),
  });
  await assert.rejects(failing.listJobs({}), (error) => {
    assert.equal(String(error.message).includes(key), false);
    assert.equal(error.code, 'zenbooker_upstream');
    return true;
  });

  const handler = handlerWith(null, { ZENBOOKER_API_KEY: '', MCP_SQUARE_PAYROLL_SECRET: SECRET });
  const unconfigured = await callTool(
    createMountingManZenbookerHandler({
      env: { MCP_SQUARE_PAYROLL_SECRET: SECRET },
      now: NOW,
      zenbookerClient: null,
      logger: { error() {} },
    }),
    GET_JOBS_FOR_DAY,
    {},
  );
  assert.equal(unconfigured.body.result.isError, true);
  assert.equal(JSON.stringify(unconfigured.body).includes('ZENBOOKER_API_KEY'), false);
  assert.equal(handler === null, false);
});

test('zenbooker MCP source stays read-only and off Square', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const route = readFileSync(path.join(root, 'pages/api/mcp/mounting-man-zenbooker.js'), 'utf8');
  const feed = readFileSync(path.join(root, 'lib/zenbooker-jobs-feed.mjs'), 'utf8');
  assert.equal(route.includes('connect.squareup.com'), false);
  assert.equal(route.includes('googleads.googleapis.com'), false);
  assert.equal(feed.includes('connect.squareup.com'), false);
  assert.equal(feed.includes('googleads.googleapis.com'), false);
  assert.equal(feed.includes("method: 'POST'"), false);
  assert.equal(feed.includes('method: "POST"'), false);
  assert.match(feed, /method: 'GET'/);
  assert.match(route, /mounting-man-zenbooker/);
});
