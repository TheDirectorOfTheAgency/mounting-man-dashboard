import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractPaymentIdFromInvoice,
  extractPaymentIdFromOrder,
  resolveInstallPostSourceRefs,
} from '../lib/square-source-ids.mjs';

test('invoice payment id is read from payment_requests, never from the invoice id', () => {
  assert.equal(extractPaymentIdFromInvoice({
    id: 'invoice-1',
    payment_requests: [{ payment_id: 'pay_from_request' }],
  }), 'pay_from_request');
  assert.equal(extractPaymentIdFromInvoice({ id: 'invoice-1' }), '');
});

test('order tenders supply a payment id when the invoice omitted it', () => {
  assert.equal(extractPaymentIdFromOrder({
    tenders: [{ id: 'tender-1', payment_id: 'pay_from_tender' }],
  }), 'pay_from_tender');
});

test('resolveInstallPostSourceRefs keeps invoice id distinct from payment id', () => {
  const refs = resolveInstallPostSourceRefs({
    invoice: { id: 'invoice-bloomington', order_id: 'order-invoice' },
    order: { id: 'order-invoice', tenders: [{ payment_id: 'pay_from_tender' }] },
    payment: { id: 'invoice-bloomington' },
  });
  assert.equal(refs.orderId, 'order-invoice');
  assert.equal(refs.invoiceId, 'invoice-bloomington');
  assert.equal(refs.paymentId, 'pay_from_tender');
});
