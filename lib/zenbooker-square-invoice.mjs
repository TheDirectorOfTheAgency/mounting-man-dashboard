export const CREDIT_CARD_PROCESSING_TAX = {
  uid: 'credit-card-processing-fee',
  catalog_object_id: 'UYAEERACJE7W6FVVELNNF5GL',
  name: 'Credit Card Processing Fee',
  percentage: '3.5',
};

export const SALES_TAX = {
  uid: 'sales-tax',
  catalog_object_id: 'T2SCKRERNHFSIU7S4TBXVYEE',
  name: 'Sales Tax',
  percentage: '8.03',
};

const CURRENCY = 'USD';

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function amountToCents(amount) {
  if (amount === null || amount === undefined || amount === '') return 0;

  if (typeof amount === 'object') {
    if (amount.amount !== undefined) return amountToCents(amount.amount);
    if (amount.value !== undefined) return amountToCents(amount.value);
    if (amount.total !== undefined) return amountToCents(amount.total);
    return 0;
  }

  if (typeof amount === 'number' && Number.isFinite(amount)) {
    return Number.isInteger(amount) && Math.abs(amount) > 10000
      ? amount
      : Math.round(amount * 100);
  }

  const normalized = String(amount).replace(/[$,]/g, '').trim();
  if (!normalized) return 0;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;
  return Number.isInteger(parsed) && Math.abs(parsed) > 10000
    ? parsed
    : Math.round(parsed * 100);
}

function parseQuantityDescription(description) {
  const raw = compact(description);
  const match = raw.match(/^(\d+)\s*x\s+(.+)$/i);
  if (!match) {
    return { quantity: 1, label: raw };
  }

  return {
    quantity: Math.max(1, Number(match[1]) || 1),
    label: compact(match[2]),
  };
}

function centsToMoney(amount) {
  return {
    amount: Math.round(Number(amount) || 0),
    currency: CURRENCY,
  };
}

export function classifyZenbookerInvoiceLine({ label, serviceName } = {}) {
  const text = `${label || ''} ${serviceName || ''}`.toLowerCase();

  const isHardware = (
    text.includes('bracket') ||
    /\btilt mount\b/.test(text) ||
    /\bfull motion mount\b/.test(text) ||
    /\bfixed mount\b/.test(text) ||
    /\bflush mount\b/.test(text) ||
    /\bcorner mount\b/.test(text) ||
    /\bpremium 4d tilt\b/.test(text) ||
    /\bhdmi\b/.test(text) ||
    /\bcable\b/.test(text)
  );

  return isHardware ? 'hardware' : 'service';
}

function serviceNameFromService(service, fallback) {
  return compact(
    service?.service_name ||
    service?.name ||
    service?.service?.name ||
    fallback ||
    'ZenBooker service'
  );
}

function pricingSummaryFromService(service) {
  const summary = (
    service?.pricing_summary ||
    service?.pricingSummary ||
    service?.price_summary ||
    service?.line_items ||
    []
  );
  return Array.isArray(summary) ? summary : [];
}

function makeLineItem({ label, totalCents, serviceName, index }) {
  const parsed = parseQuantityDescription(label);
  const quantity = parsed.quantity;
  const cleanLabel = parsed.label || `ZenBooker line ${index + 1}`;
  const quantityDividesEvenly = totalCents % quantity === 0;
  const squareQuantity = quantityDividesEvenly ? quantity : 1;
  const basePriceCents = quantityDividesEvenly ? totalCents / quantity : totalCents;
  const name = quantityDividesEvenly ? cleanLabel : compact(label || cleanLabel);
  const category = classifyZenbookerInvoiceLine({ label: cleanLabel, serviceName });

  return {
    uid: `line-${index + 1}`,
    name,
    quantity: String(squareQuantity),
    basePriceCents,
    totalCents,
    category,
    serviceName,
    sourceLabel: compact(label || cleanLabel),
    appliedTaxUids: category === 'hardware'
      ? [CREDIT_CARD_PROCESSING_TAX.uid, SALES_TAX.uid]
      : [CREDIT_CARD_PROCESSING_TAX.uid],
  };
}

export function buildZenbookerInvoiceModel({
  rawServices = [],
  fallbackServiceName = '',
  totalAmount = null,
} = {}) {
  const services = Array.isArray(rawServices) ? rawServices : [];
  const warnings = [];
  const lineItems = [];

  services.forEach((service) => {
    const serviceName = serviceNameFromService(service, fallbackServiceName);
    pricingSummaryFromService(service).forEach((entry) => {
      const totalCents = amountToCents(entry?.amount ?? entry?.total ?? entry?.price ?? entry?.base_price);
      if (totalCents <= 0) return;

      const label = compact(entry?.description || entry?.name || entry?.label || serviceName);
      lineItems.push(makeLineItem({
        label,
        totalCents,
        serviceName,
        index: lineItems.length,
      }));
    });
  });

  const expectedTotalCents = amountToCents(totalAmount);
  const subtotalCents = lineItems.reduce((sum, item) => sum + item.totalCents, 0);

  if (lineItems.length === 0 && expectedTotalCents > 0) {
    warnings.push('missing_pricing_summary');
    lineItems.push(makeLineItem({
      label: fallbackServiceName || 'ZenBooker service',
      totalCents: expectedTotalCents,
      serviceName: fallbackServiceName || 'ZenBooker service',
      index: 0,
    }));
  } else if (expectedTotalCents > 0 && subtotalCents !== expectedTotalCents) {
    warnings.push('pricing_summary_total_mismatch');
  }

  return {
    lineItems,
    subtotalCents: lineItems.reduce((sum, item) => sum + item.totalCents, 0),
    expectedTotalCents,
    warnings,
  };
}

function orderTaxesForLineItems(lineItems) {
  const usesProcessingFee = lineItems.some((item) => item.appliedTaxUids.includes(CREDIT_CARD_PROCESSING_TAX.uid));
  const usesSalesTax = lineItems.some((item) => item.appliedTaxUids.includes(SALES_TAX.uid));
  const taxes = [];

  if (usesProcessingFee) {
    taxes.push({
      uid: CREDIT_CARD_PROCESSING_TAX.uid,
      catalog_object_id: CREDIT_CARD_PROCESSING_TAX.catalog_object_id,
      name: CREDIT_CARD_PROCESSING_TAX.name,
      type: 'ADDITIVE',
      scope: 'LINE_ITEM',
    });
  }

  if (usesSalesTax) {
    taxes.push({
      uid: SALES_TAX.uid,
      catalog_object_id: SALES_TAX.catalog_object_id,
      name: SALES_TAX.name,
      type: 'ADDITIVE',
      scope: 'LINE_ITEM',
    });
  }

  return taxes;
}

function toOrderLineItem(item) {
  return {
    uid: item.uid,
    name: item.name,
    quantity: item.quantity,
    base_price_money: centsToMoney(item.basePriceCents),
    note: item.serviceName || undefined,
    applied_taxes: item.appliedTaxUids.map((taxUid) => ({ tax_uid: taxUid })),
  };
}

function truncateMetadata(value) {
  const text = compact(value);
  return text ? text.slice(0, 255) : undefined;
}

export function buildSquareOrderRequest({
  locationId,
  customerId,
  jobId,
  jobNumber,
  serviceName,
  scheduledAt,
  invoiceModel,
} = {}) {
  const lineItems = invoiceModel?.lineItems || [];
  const order = {
    location_id: locationId,
    customer_id: customerId,
    source: { name: 'ZenBooker' },
    reference_id: truncateMetadata(jobNumber ? `ZenBooker ${jobNumber}` : `ZenBooker ${jobId}`),
    line_items: lineItems.map(toOrderLineItem),
    taxes: orderTaxesForLineItems(lineItems),
    metadata: {
      source: 'zenbooker',
      zenbooker_job_id: truncateMetadata(jobId),
      zenbooker_job_number: truncateMetadata(jobNumber),
      service_date: truncateMetadata(scheduledAt),
      service_name: truncateMetadata(serviceName),
    },
  };

  Object.keys(order.metadata).forEach((key) => {
    if (!order.metadata[key]) delete order.metadata[key];
  });

  return {
    idempotency_key: `zb-order-${jobId}`.slice(0, 192),
    order,
  };
}

function dateOnly(value, fallback = new Date()) {
  const date = value ? new Date(value) : fallback;
  if (Number.isNaN(date.getTime())) return fallback.toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

export function buildSquareInvoiceRequest({
  locationId,
  orderId,
  customerId,
  jobId,
  jobNumber,
  serviceName,
  scheduledAt,
  addressLine,
  sellerNote,
  now = new Date(),
} = {}) {
  const serviceDate = dateOnly(scheduledAt, now);
  const description = [
    jobNumber ? `ZenBooker job #${jobNumber}` : null,
    jobId ? `ZenBooker job ID: ${jobId}` : null,
    serviceName ? `Service: ${serviceName}` : null,
    scheduledAt ? `Appointment: ${scheduledAt}` : null,
    addressLine ? `Address: ${addressLine}` : null,
    sellerNote ? `Notes: ${sellerNote}` : null,
  ].filter(Boolean).join('\n');

  return {
    idempotency_key: `zb-invoice-${jobId}`.slice(0, 128),
    invoice: {
      location_id: locationId,
      order_id: orderId,
      primary_recipient: {
        customer_id: customerId,
      },
      payment_requests: [
        {
          request_type: 'BALANCE',
          due_date: serviceDate,
        },
      ],
      delivery_method: 'SHARE_MANUALLY',
      accepted_payment_methods: {
        card: true,
        square_gift_card: false,
        bank_account: false,
        buy_now_pay_later: false,
        cash_app_pay: false,
      },
      title: 'The Mounting Man Installation',
      description: description || undefined,
      sale_or_service_date: serviceDate,
    },
  };
}
