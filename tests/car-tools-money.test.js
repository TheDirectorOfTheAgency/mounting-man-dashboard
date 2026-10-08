import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GET_JOB_PAYMENT_STATUS,
  GET_PAYMENTS,
  GET_SUPPLIES_FOR_DAY,
  SQUARE_COLLECTED_LABEL,
  getJobPaymentStatus,
  getPayments,
  getSuppliesForDay,
} from '../lib/car-tools-money.mjs';
import { createMountingManZenbookerHandler } from '../pages/api/mcp/mounting-man-zenbooker.js';

const NOW = new Date('2026-10-07T15:00:00.000Z');
const SECRET = 'test-mcp-secret';

function waconiaJob(overrides = {}) {
  return {
    id: '1710000000000x730395',
    job_number: '730395',
    start_date: '2026-10-07T14:00:00.000Z',
    end_date: '2026-10-07T16:00:00.000Z',
    completed_at: '2026-10-07T16:30:00.000Z',
    status: 'complete',
    canceled: false,
    service_name: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
    services: [{
      service_name: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
      service_selections: [{
        name: 'TV Size',
        selected_options: [{ display_label: '65 Inches' }],
      }, {
        name: 'TV Mounting Bracket',
        selected_options: [{ display_label: 'Standard Tilt Mount (For Up to 86" TVs)' }],
      }],
      pricing_summary: [
        { description: '1x 65 Inches', amount: 200 },
        { description: '1x Standard Tilt Mount', amount: 75 },
      ],
    }],
    customer: { name: 'Pat Waconia', phone: '6125550101', email: 'pat@example.com' },
    service_address: { line1: '100 Main St', city: 'Waconia', state: 'MN', postal_code: '55387' },
    invoice: { total: '275.00', amount_paid: '0.00' },
    ...overrides,
  };
}

function johnsonJob(overrides = {}) {
  return waconiaJob({
    id: '1710000000000x700001',
    job_number: '700001',
    customer: { name: 'Alex Johnson', phone: '6125550111', email: 'alex@example.com' },
    ...overrides,
  });
}

function secondJohnsonJob() {
  return waconiaJob({
    id: '1710000000000x700002',
    job_number: '700002',
    customer: { name: 'Jamie Johnson', phone: '6125550112', email: 'jamie@example.com' },
  });
}

function customInstallJob() {
  return waconiaJob({
    id: '1710000000000x900001',
    job_number: '900001',
    service_name: 'Custom LED Wall Design Package',
    services: [{
      service_name: 'Custom LED Wall Design Package',
      pricing_summary: [{ description: 'Design consult', amount: 500 }],
    }],
    customer: { name: 'LED Client', phone: '6125550999' },
  });
}

function squareClient(overrides = {}) {
  return {
    locationId: 'LVNM3Z4RVRWDK',
    async listPayments() { return []; },
    async batchOrders() { return {}; },
    async batchCustomers() { return {}; },
    ...overrides,
  };
}

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
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
    end() {
      return this;
    },
  };
}

test('get_payments returns an empty day with spoken Square collected wording', async () => {
  const feed = await getPayments({ day: 'today' }, {
    now: NOW,
    squareClient: squareClient(),
    logger: { error() {} },
  });
  assert.equal(feed.tool, GET_PAYMENTS);
  assert.equal(feed.payment_count, 0);
  assert.deepEqual(feed.total_collected, { amount: 0, currency: 'USD' });
  assert.match(feed.spoken, /no completed payments/i);
  assert.match(feed.spoken, /Square collected payments/i);
  assert.equal(feed.revenue_basis, SQUARE_COLLECTED_LABEL);
});

test('get_payments degrades on Square error without leaking tokens', async () => {
  const token = 'super-secret-square-token-value';
  const feed = await getPayments({ day: 'today' }, {
    now: NOW,
    squareClient: {
      locationId: 'LVNM3Z4RVRWDK',
      async listPayments() {
        throw new Error(`Square failed with token ${token}`);
      },
    },
    logger: { error() {} },
  });
  assert.equal(feed.error, 'square_unavailable');
  assert.match(feed.spoken, /could not be loaded/i);
  assert.match(feed.spoken, /Square collected payments/i);
  const serialized = JSON.stringify(feed);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('super-secret'), false);
});

test('get_job_payment_status lists ambiguous customer-name matches instead of guessing', async () => {
  const client = {
    async listJobs() {
      return [johnsonJob(), secondJohnsonJob()];
    },
    async getJob() { return null; },
  };
  const feed = await getJobPaymentStatus({ customer_name: 'Johnson' }, {
    client,
    squareClient: squareClient(),
    now: NOW,
    logger: { error() {} },
  });
  assert.equal(feed.found, false);
  assert.equal(feed.ambiguous_matches.length, 2);
  assert.match(feed.spoken, /More than one job matched/i);
  assert.match(feed.spoken, /job number/i);
});

test('get_supplies_for_day tallies mapped supplies and lists unmapped services', async () => {
  const client = {
    async listJobs() {
      return [waconiaJob(), customInstallJob()];
    },
    async getJob() { return null; },
  };
  const feed = await getSuppliesForDay({ day: '2026-10-07' }, {
    client,
    now: NOW,
    logger: { error() {} },
  });
  assert.equal(feed.tool, GET_SUPPLIES_FOR_DAY);
  assert.equal(feed.job_count, 2);
  assert.equal(feed.totals.tilt_mount, 1);
  assert.equal(feed.unmapped_services.includes('Custom LED Wall Design Package'), true);
  assert.match(feed.spoken, /tilt TV mount/i);
  assert.match(feed.spoken, /Unmapped service/i);
  assert.match(feed.spoken, /Custom LED Wall Design Package/);
});

test('get_supplies_for_day defaults to tomorrow on an empty day', async () => {
  const client = {
    async listJobs() { return []; },
    async getJob() { return null; },
  };
  const feed = await getSuppliesForDay({}, {
    client,
    now: NOW,
    logger: { error() {} },
  });
  assert.equal(feed.date, '2026-10-08');
  assert.equal(feed.job_count, 0);
  assert.match(feed.spoken, /nothing to bring/i);
});

test('MCP handler exposes car money tools and returns spoken text for get_payments', async () => {
  const handler = createMountingManZenbookerHandler({
    env: { MCP_SQUARE_PAYROLL_SECRET: SECRET },
    client: { async listJobs() { return []; }, async getJob() { return null; } },
    squareClient: squareClient(),
    now: NOW,
    logger: { error() {} },
  });
  const listed = response();
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  }, listed);
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.equal(names.includes(GET_PAYMENTS), true);
  assert.equal(names.includes(GET_JOB_PAYMENT_STATUS), true);
  assert.equal(names.includes(GET_SUPPLIES_FOR_DAY), true);

  const called = response();
  await handler({
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, accept: 'application/json' },
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: GET_PAYMENTS, arguments: { day: 'today' } },
    },
  }, called);
  assert.equal(called.body.result.content[0].text, called.body.result.structuredContent.spoken);
  assert.match(called.body.result.structuredContent.spoken, /Square collected payments/i);
});
