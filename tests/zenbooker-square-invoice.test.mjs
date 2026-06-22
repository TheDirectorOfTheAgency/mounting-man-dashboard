import assert from 'node:assert/strict';
import test from 'node:test';
import {
  amountToCents,
  buildSquareInvoiceRequest,
  buildSquareOrderRequest,
  buildZenbookerInvoiceModel,
  CREDIT_CARD_PROCESSING_TAX,
  SALES_TAX,
} from '../lib/zenbooker-square-invoice.mjs';

const frameJobServices = [
  {
    service_name: 'Picture Frame (Gallery) Style TVs (Samsung Frame, LG G Series, Hisense Canvas, TCL NXTFRAME...)',
    pricing_summary: [
      { description: '1x 55 Inches', amount: 250, type: 'service_option' },
      { description: '1x Samsung Frame', amount: 0, type: 'service_option' },
      { description: 'Yes', amount: 0, type: 'service_option' },
      { description: '1x Brick', amount: 50, type: 'service_option' },
      { description: '1x Exterior Cord Concealing Around Fireplace', amount: 100, type: 'service_option' },
      { description: 'No', amount: 0, type: 'service_option' },
    ],
  },
];

test('builds full ZenBooker invoice subtotal from priced pricing_summary lines only', () => {
  const model = buildZenbookerInvoiceModel({
    rawServices: frameJobServices,
    totalAmount: '400.00',
  });

  assert.equal(model.subtotalCents, 40000);
  assert.deepEqual(model.warnings, []);
  assert.deepEqual(model.lineItems.map((item) => ({ name: item.name, cents: item.totalCents, category: item.category })), [
    { name: '55 Inches', cents: 25000, category: 'service' },
    { name: 'Brick', cents: 5000, category: 'service' },
    { name: 'Exterior Cord Concealing Around Fireplace', cents: 10000, category: 'service' },
  ]);
});

test('applies processing fee to all lines and sales tax only to hardware lines', () => {
  const model = buildZenbookerInvoiceModel({
    rawServices: [
      {
        service_name: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
        pricing_summary: [
          { description: '1x 65 Inches', amount: 150 },
          { description: '1x Standard Tilt Mount (For Up to 86" TVs)', amount: 75 },
        ],
      },
    ],
    totalAmount: '225.00',
  });

  assert.equal(model.subtotalCents, 22500);
  assert.equal(model.lineItems[0].category, 'service');
  assert.equal(model.lineItems[1].category, 'hardware');

  const orderRequest = buildSquareOrderRequest({
    locationId: 'LOC',
    customerId: 'CUS',
    jobId: 'job-123',
    jobNumber: '123456',
    serviceName: 'TV Mounting',
    scheduledAt: '2026-06-22T18:00:00.000Z',
    invoiceModel: model,
  });

  assert.deepEqual(orderRequest.order.taxes.map((tax) => tax.uid), [
    CREDIT_CARD_PROCESSING_TAX.uid,
    SALES_TAX.uid,
  ]);
  assert.deepEqual(orderRequest.order.taxes.map((tax) => Object.keys(tax).sort()), [
    ['catalog_object_id', 'scope', 'uid'],
    ['catalog_object_id', 'scope', 'uid'],
  ]);
  assert.deepEqual(orderRequest.order.taxes.map((tax) => tax.scope), [
    'LINE_ITEM',
    'LINE_ITEM',
  ]);
  assert.deepEqual(orderRequest.order.line_items[0].applied_taxes, [
    { tax_uid: CREDIT_CARD_PROCESSING_TAX.uid },
  ]);
  assert.deepEqual(orderRequest.order.line_items[1].applied_taxes, [
    { tax_uid: CREDIT_CARD_PROCESSING_TAX.uid },
    { tax_uid: SALES_TAX.uid },
  ]);
});

test('uses a fallback full-invoice line when ZenBooker pricing summary is missing', () => {
  const model = buildZenbookerInvoiceModel({
    rawServices: [],
    fallbackServiceName: 'Handyman Work',
    totalAmount: '150.00',
  });

  assert.equal(model.subtotalCents, 15000);
  assert.deepEqual(model.warnings, ['missing_pricing_summary']);
  assert.equal(model.lineItems[0].name, 'Handyman Work');
  assert.equal(model.lineItems[0].category, 'service');
});

test('normalizes fallback totals supplied as cents, dollars, or money-like objects', () => {
  assert.equal(amountToCents(242.88), 24288);
  assert.equal(amountToCents('242.88'), 24288);
  assert.equal(amountToCents(24288), 24288);
  assert.equal(amountToCents('24288'), 24288);
  assert.equal(amountToCents({ amount: 24288 }), 24288);
  assert.equal(amountToCents({ total: '242.88' }), 24288);

  const model = buildZenbookerInvoiceModel({
    rawServices: [],
    fallbackServiceName: 'Mount 1 Or More TVs (Normal TV Onto Any Surface)',
    totalAmount: { amount: 24288 },
  });

  assert.equal(model.subtotalCents, 24288);
  assert.equal(model.lineItems.length, 1);
  assert.equal(model.lineItems[0].totalCents, 24288);
});

test('invoice request creates a draft SHARE_MANUALLY full balance invoice', () => {
  const request = buildSquareInvoiceRequest({
    locationId: 'LOC',
    orderId: 'ORDER',
    customerId: 'CUS',
    jobId: 'job-123',
    jobNumber: '123456',
    serviceName: 'TV Mounting',
    scheduledAt: '2026-06-22T18:00:00.000Z',
    addressLine: 'Minneapolis, MN',
    sellerNote: 'No auto-send.',
    now: new Date('2026-06-22T12:00:00.000Z'),
  });

  assert.equal(request.idempotency_key, 'zb-invoice-job-123');
  assert.equal(request.invoice.order_id, 'ORDER');
  assert.equal(request.invoice.primary_recipient.customer_id, 'CUS');
  assert.equal(request.invoice.delivery_method, 'SHARE_MANUALLY');
  assert.equal(request.invoice.payment_requests[0].request_type, 'BALANCE');
  assert.equal(request.invoice.payment_requests[0].due_date, '2026-06-22');
  assert.equal(request.invoice.accepted_payment_methods.card, true);
  assert.match(request.invoice.description, /ZenBooker job #123456/);
});
