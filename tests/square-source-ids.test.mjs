import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractPaymentIdFromInvoice,
  extractPaymentIdFromOrder,
  resolveInstallPostSourceRefs,
} from '../lib/square-source-ids.mjs';

test('invoice payment id prefers explicit invoice fields over the invoice id', () => {
  assert.equal(extractPaymentIdFromInvoice({
    id: 'invoice-1',
    payment_ids: ['pay_from_invoice'],
  }), 'pay_from_invoice');
  assert.equal(extractPaymentIdFromInvoice({
    id: 'invoice-1',
    payment_requests: [{ payment_id: 'pay_from_request' }],
  }), 'pay_from_request');
});

test('order tenders expose Square payment id for invoice.payment_made', () => {
  assert.equal(extractPaymentIdFromOrder({
    id: 'order-1',
    tenders: [{ id: 'tender-1', type: 'CARD', payment_id: 'pay_from_tender' }],
  }), 'pay_from_tender');
  assert.equal(extractPaymentIdFromOrder({
    tenders: [{ id: 'pay_tender_id', type: 'CARD' }],
  }), 'pay_tender_id');
});

test('resolveInstallPostSourceRefs never treats the invoice id as paymentId', () => {
  const refs = resolveInstallPostSourceRefs({
    payment: { id: 'invoice-1' },
    invoice: { id: 'invoice-1', order_id: 'order-1' },
    order: { id: 'order-1', tenders: [{ payment_id: 'pay_real' }] },
  });
  assert.equal(refs.orderId, 'order-1');
  assert.equal(refs.invoiceId, 'invoice-1');
  assert.equal(refs.paymentId, 'pay_real');
});
