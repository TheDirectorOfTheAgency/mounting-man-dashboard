import assert from 'node:assert/strict';
import test from 'node:test';

import { createZenbookerToSquareHandler } from '../pages/api/webhooks/zenbooker-to-square.js';
import { createResponse } from './webhook-test-helpers.js';

function payload(overrides = {}) {
  return {
    type: 'job.created',
    data: {
      id: 'job-123',
      job_number: '123456',
      start_date: '2026-07-24T15:00:00.000Z',
      customer: {
        email: 'customer@example.com',
        phone: '6125550123',
        first_name: 'Test',
        last_name: 'Customer',
      },
      assigned_providers: [{ name: 'Michael Wenzel', email: 'michael@example.com' }],
      service_name: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
      services: [
        {
          service_name: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
          pricing_summary: [
            { description: '1x 65 Inches', amount: 200, type: 'service_option' },
            { description: '1x Standard Tilt Mount', amount: 75, type: 'service_option' },
          ],
          service_selections: [
            {
              name: 'TV Size',
              selected_options: [{ display_label: '65 Inches', quantity: 1 }],
            },
          ],
        },
      ],
      invoice: { total: 275 },
      service_address: {
        line1: '100 Test Ave',
        city: 'Minneapolis',
        state: 'MN',
        postal_code: '55401',
      },
      ...overrides,
    },
  };
}

function request(body = payload(), overrides = {}) {
  return {
    method: 'POST',
    query: { secret: 'test-secret' },
    headers: {},
    body,
    ...overrides,
  };
}

function installSecret(t) {
  const previous = process.env.ZENBOOKER_WEBHOOK_SECRET;
  process.env.ZENBOOKER_WEBHOOK_SECRET = 'test-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.ZENBOOKER_WEBHOOK_SECRET;
    else process.env.ZENBOOKER_WEBHOOK_SECRET = previous;
  });
}

test('route preserves customer to order to draft SHARE_MANUALLY full-balance invoice flow', async (t) => {
  installSecret(t);
  const calls = { orders: [], invoices: [], audits: [], mappings: [] };
  const handler = createZenbookerToSquareHandler({
    findCustomer: async () => ({ id: 'square-customer-1' }),
    createCustomer: async () => assert.fail('existing customer must be reused'),
    createOrder: async (value) => {
      calls.orders.push(value);
      return { order: { id: 'square-order-1' }, error: null };
    },
    createInvoice: async (value) => {
      calls.invoices.push(value);
      return { invoice: { id: 'square-invoice-1', status: 'DRAFT' }, error: null };
    },
    readAudit: async () => null,
    writeAudit: async (...args) => { calls.audits.push(args); },
    operationsNotifier: async () => {},
    attributionStore: {},
    saveAttributionMapping: async (value) => {
      calls.mappings.push(value);
      return { saved: true };
    },
  });

  const res = createResponse();
  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.processed, true);
  assert.equal(res.body.squareCustomerId, 'square-customer-1');
  assert.equal(res.body.squareOrderId, 'square-order-1');
  assert.equal(res.body.squareInvoiceId, 'square-invoice-1');
  assert.equal(res.body.invoiceStatus, 'DRAFT');
  assert.equal(res.body.techMatched, true);
  assert.equal(res.body.techAssignmentMode, 'mapped_assigned');

  assert.equal(calls.orders.length, 1);
  assert.equal(calls.orders[0].order.line_items.length, 2);
  assert.deepEqual(calls.orders[0].order.line_items.map((line) => line.base_price_money.amount), [
    20000,
    7500,
  ]);
  assert.equal(calls.orders[0].order.line_items[0].applied_taxes.length, 1);
  assert.equal(calls.orders[0].order.line_items[1].applied_taxes.length, 2);

  assert.equal(calls.invoices.length, 1);
  assert.equal(calls.invoices[0].invoice.order_id, 'square-order-1');
  assert.equal(calls.invoices[0].invoice.delivery_method, 'SHARE_MANUALLY');
  assert.equal(calls.invoices[0].invoice.payment_requests[0].request_type, 'BALANCE');

  assert.equal(calls.audits.length, 1);
  assert.equal(calls.audits[0][0], 'job-123');
  assert.equal(calls.audits[0][1].squareOrderId, 'square-order-1');
  assert.equal(calls.audits[0][1].squareInvoiceId, 'square-invoice-1');
  assert.equal(calls.audits[0][1].mode, 'draft_invoice');

  assert.equal(calls.mappings.length, 1);
  assert.equal(calls.mappings[0].jobId, 'job-123');
  assert.equal(calls.mappings[0].squareCustomerId, 'square-customer-1');
  assert.equal(calls.mappings[0].attributionStore !== null, true);
});

test('existing invoice audit dedupes Square writes and backfills attribution mapping', async (t) => {
  installSecret(t);
  const mappings = [];
  const handler = createZenbookerToSquareHandler({
    findCustomer: async () => assert.fail('must dedupe before Square lookup'),
    createOrder: async () => assert.fail('must not create duplicate order'),
    createInvoice: async () => assert.fail('must not create duplicate invoice'),
    readAudit: async () => ({
      squareCustomerId: 'square-customer-existing',
      squareOrderId: 'square-order-existing',
      squareInvoiceId: 'square-invoice-existing',
    }),
    attributionStore: {},
    saveAttributionMapping: async (value) => { mappings.push(value); return { saved: true }; },
  });
  const res = createResponse();
  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.skipped, true);
  assert.equal(res.body.squareInvoiceId, 'square-invoice-existing');
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].squareCustomerId, 'square-customer-existing');
});

test('attribution persistence failure is non-blocking after Square invoice and audit writes', async (t) => {
  installSecret(t);
  let auditWritten = false;
  const handler = createZenbookerToSquareHandler({
    findCustomer: async () => ({ id: 'square-customer-1' }),
    createOrder: async () => ({ order: { id: 'square-order-1' }, error: null }),
    createInvoice: async () => ({ invoice: { id: 'square-invoice-1', status: 'DRAFT' }, error: null }),
    readAudit: async () => null,
    writeAudit: async () => { auditWritten = true; },
    operationsNotifier: async () => {},
    loadAttributionStore: async () => { throw new Error('KV unavailable'); },
  });
  const res = createResponse();
  await handler(request(), res);

  assert.equal(auditWritten, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.processed, true);
  assert.equal(res.body.squareInvoiceId, 'square-invoice-1');
});

test('provider mapping modes and dry-run no-write behavior remain intact', async (t) => {
  installSecret(t);
  const cases = [
    { assigned_providers: [{ name: 'Michael Wenzel' }], mode: 'mapped_assigned', matched: true },
    { assigned_providers: [], mode: 'defaulted_unassigned', matched: true },
    { assigned_providers: [{ name: 'Unknown Technician' }], mode: 'unmapped_assigned', matched: false },
  ];

  for (const providerCase of cases) {
    const handler = createZenbookerToSquareHandler({
      findCustomer: async () => ({ id: 'square-customer-1' }),
      createOrder: async () => assert.fail('dry-run must not create order'),
      createInvoice: async () => assert.fail('dry-run must not create invoice'),
      readAudit: async () => null,
      writeAudit: async () => assert.fail('dry-run must not write audit'),
      saveAttributionMapping: async () => assert.fail('dry-run must not write attribution mapping'),
    });
    const res = createResponse();
    await handler(
      request(payload({ assigned_providers: providerCase.assigned_providers }), {
        query: { secret: 'test-secret', dryRun: '1' },
      }),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.techAssignmentMode, providerCase.mode);
    assert.equal(res.body.techMatched, providerCase.matched);
    assert.equal(res.body.dryRunOrderRequest.order.line_items.length, 2);
  }
});

test('webhook authentication blocks before Square or attribution side effects', async (t) => {
  installSecret(t);
  let sideEffects = 0;
  const handler = createZenbookerToSquareHandler({
    findCustomer: async () => { sideEffects += 1; },
    saveAttributionMapping: async () => { sideEffects += 1; },
  });

  const unauthorized = createResponse();
  await handler(request(payload(), { query: { secret: 'wrong' } }), unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(sideEffects, 0);

  const wrongMethod = createResponse();
  await handler(request(payload(), { method: 'GET' }), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(sideEffects, 0);
});
