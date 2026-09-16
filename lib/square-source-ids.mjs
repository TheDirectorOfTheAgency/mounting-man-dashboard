// Resolve Square order / payment / invoice ids for install-post records.
// Invoice webhooks often omit payment.id; Square keeps it on the order tenders.

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function collectIds(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap(collectIds);
  if (typeof value === 'object') {
    return collectIds(value.id || value.payment_id || value.paymentId);
  }
  return [String(value).trim()].filter(Boolean);
}

export function extractPaymentIdFromInvoice(invoice) {
  if (!invoice || typeof invoice !== 'object') return '';
  const fromRequests = (Array.isArray(invoice.payment_requests) ? invoice.payment_requests : [])
    .flatMap((request) => [
      ...collectIds(request?.payment_id),
      ...collectIds(request?.payment_ids),
      ...collectIds(request?.payments),
    ]);
  return firstNonEmpty(
    invoice.payment_id,
    invoice.paymentId,
    ...(Array.isArray(invoice.payment_ids) ? invoice.payment_ids : []),
    ...fromRequests,
  );
}

export function extractPaymentIdFromOrder(order) {
  const tenders = Array.isArray(order?.tenders) ? order.tenders : [];
  for (const tender of tenders) {
    const id = firstNonEmpty(tender?.payment_id, tender?.paymentId, tender?.id);
    if (id) return id;
  }
  return '';
}

function paymentIdIfDistinct(payment, invoiceId) {
  const id = firstNonEmpty(payment?.id);
  if (!id || (invoiceId && id === invoiceId)) return '';
  return id;
}

/**
 * Top-level source refs for a job / pending record.
 * Never treats an invoice id as a payment id.
 */
export function resolveInstallPostSourceRefs({
  orderId = '',
  paymentId = '',
  invoiceId = '',
  payment,
  invoice,
  order,
} = {}) {
  const resolvedInvoiceId = firstNonEmpty(invoiceId, invoice?.id);
  const resolvedOrderId = firstNonEmpty(
    orderId,
    payment?.order_id,
    invoice?.order_id,
    order?.id,
  );
  const resolvedPaymentId = firstNonEmpty(
    paymentId,
    paymentIdIfDistinct(payment, resolvedInvoiceId),
    extractPaymentIdFromInvoice(invoice),
    extractPaymentIdFromOrder(order),
  );
  return {
    orderId: resolvedOrderId,
    paymentId: resolvedPaymentId,
    invoiceId: resolvedInvoiceId,
  };
}
