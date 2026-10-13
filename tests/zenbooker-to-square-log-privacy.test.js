import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';

import {
  createZenbookerToSquareHandler,
  invoiceRequestLogSummary,
  orderRequestLogSummary,
} from '../pages/api/webhooks/zenbooker-to-square.js';
import { createResponse } from './webhook-test-helpers.js';

const PII = [
  'customer@example.com', '6125550123', '5550123', 'Testfirst', 'Testlast',
  '4917 Oakland', 'Oakland Avenue', 'Minneapolis', '55417', 'Michael Wenzel',
  'michael@example.com', 'Gate code 4411',
];

function payload() {
  return {
    type: 'job.created',
    data: {
      id: 'job-priv-1',
      job_number: '822749',
      start_date: '2026-10-16T22:00:00.000Z',
      customer: {
        id: 'zb-cust-1', email: 'customer@example.com', phone: '6125550123',
        first_name: 'Testfirst', last_name: 'Testlast',
      },
      assigned_providers: [{ id: 'prov-1', name: 'Michael Wenzel', email: 'michael@example.com' }],
      service_name: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
      job_notes: ['Gate code 4411'],
      services: [{
        service_name: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
        pricing_summary: [{ description: '1x 65 Inches', amount: 200, type: 'service_option' }],
        service_selections: [{ name: 'TV Size', selected_options: [{ display_label: '65 Inches', quantity: 1 }] }],
      }],
      invoice: { total: 200 },
      service_address: { line1: '4917 Oakland Avenue', city: 'Minneapolis', state: 'MN', postal_code: '55417' },
    },
  };
}

function captureConsole(t) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' '));
    };
  }
  t.after(() => Object.assign(console, original));
  return lines;
}

test('order/invoice log summaries carry IDs and counts only', () => {
  const order = orderRequestLogSummary({
    idempotency_key: 'zb-order-job-priv-1',
    order: {
      location_id: 'LOC', customer_id: 'sq-cust',
      metadata: { zenbooker_job_id: 'job-priv-1', zenbooker_job_number: '822749' },
      line_items: [{ name: 'x', note: 'Address: 4917 Oakland Avenue', base_price_money: { amount: 40000 } }],
    },
  });
  assert.deepEqual(order.lineCents, [40000]);
  const invoice = invoiceRequestLogSummary({
    idempotency_key: 'k',
    invoice: { order_id: 'o', description: 'Address: 4917 Oakland Avenue, Minneapolis 55417', primary_recipient: { customer_id: 'c' } },
  });
  const text = JSON.stringify({ order, invoice });
  for (const value of PII) assert.ok(!text.includes(value), value);
  assert.ok(!text.includes('sq-cust'));
});

test('ZenBooker → Square webhook never writes customer or installer PII to logs', async (t) => {
  const previous = process.env.ZENBOOKER_WEBHOOK_SECRET;
  process.env.ZENBOOKER_WEBHOOK_SECRET = 'test-secret';
  const originalPost = axios.post;
  axios.post = async (url) => {
    if (url.endsWith('/orders')) return { data: { order: { id: 'square-order-1' } } };
    if (url.endsWith('/invoices')) return { data: { invoice: { id: 'square-invoice-1', status: 'DRAFT' } } };
    const error = new Error('Invalid email customer@example.com');
    error.response = { status: 400, data: { errors: [{ code: 'INVALID_EMAIL_ADDRESS', category: 'INVALID_REQUEST_ERROR', detail: 'customer@example.com 4917 Oakland Avenue' }] } };
    throw error;
  };
  t.after(() => {
    axios.post = originalPost;
    if (previous === undefined) delete process.env.ZENBOOKER_WEBHOOK_SECRET;
    else process.env.ZENBOOKER_WEBHOOK_SECRET = previous;
  });
  const lines = captureConsole(t);
  const handler = createZenbookerToSquareHandler({
    findCustomer: async () => ({ id: 'square-customer-1' }),
    readAudit: async () => null,
    writeAudit: async () => {},
    loadZenbookerJob: async () => payload().data,
    alert: async () => {},
    attributionStore: null,
    saveAttributionMapping: async () => ({ saved: true }),
  });
  const res = createResponse();
  await handler({ method: 'POST', query: { secret: 'test-secret' }, headers: {}, body: payload() }, res);
  assert.equal(res.statusCode, 200);
  const text = lines.join('\n');
  assert.ok(text.includes('Square order request'), 'order request still logged');
  assert.ok(text.includes('job-priv-1'), 'job id still logged');
  for (const value of PII) assert.ok(!text.includes(value), `log leaked ${value}`);
});
