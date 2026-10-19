import crypto from 'node:crypto';
import axios from 'axios';

import { resolveAdUserDataConsent } from './ad-user-data-consent.js';
import { uploadOfflineConversion, formatConversionDateTime } from './google-ads-conversions.js';
import { hashEmail, hashPhone } from './hash-pii.js';
import { extractClickIdentifiers } from './offline-conversion-eligibility.js';
import { centsToDollars, netCentsFromSquarePayment } from './offline-conversion-value.js';

export const DAILY_CONVERSION_ACTION_ID = '7509313857';
export const CHANGE_RECORD = 'LEDGER-2026-10-04-CONVERSION-TRACKING';
const DAY_MS = 24 * 60 * 60 * 1000;
// Daily Square read window. Upload idempotency is the KV ledger, not this window.
export const DAILY_SQUARE_LOOKBACK_DAYS = 30;
export const LOOKBACK_MS = DAILY_SQUARE_LOOKBACK_DAYS * DAY_MS;
export const SQUARE_TIMEOUT_MS = 15_000;
export const SQUARE_MAX_ATTEMPTS = 3;
export const SQUARE_RETRY_BASE_MS = 250;
export const GOOGLE_TIMEOUT_MS = 25_000;
const GOOGLE_TOKEN_SKEW_MS = 60_000;
const GOOGLE_TOKEN_DEFAULT_LIFETIME_MS = 3600 * 1000;
const MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SQUARE_VERSION = '2024-01-18';

export function resolveDailyLookbackMs(env = process.env) {
  const raw = String(env?.DAILY_OFFLINE_CONVERSION_LOOKBACK_DAYS ?? '').trim();
  if (!raw) return LOOKBACK_MS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days <= 0) return LOOKBACK_MS;
  return days * DAY_MS;
}

export function identifierTypes({ email, phone, gclid, gbraid, wbraid } = {}) {
  const types = [];
  if (hashEmail(email)) types.push('hashed_email');
  // Policy (Oct 15, 2026): phone is never an upload identifier.
  void phone;
  if (gclid) types.push('gclid');
  else if (gbraid) types.push('gbraid');
  else if (wbraid) types.push('wbraid');
  return types;
}

function paymentTime(payment) {
  return payment.updated_at || payment.completedAt || payment.created_at || null;
}

function customerEmail(customer = {}) {
  return customer.email_address || customer.email || null;
}

function customerPhone(customer = {}) {
  return customer.phone_number || customer.phone || null;
}

function customerCountry(customer = {}) {
  const country = customer.address?.country || customer.countryCode || customer.country || '';
  const normalized = String(country || '').trim();
  return normalized || null;
}

export function buildOrderGroups(payments = []) {
  const groups = new Map();
  for (const payment of payments) {
    if (String(payment.status || '').toUpperCase() !== 'COMPLETED') continue;
    const currency = payment.amount_money?.currency
      || payment.total_money?.currency
      || payment.currency
      || 'USD';
    if (String(currency).toUpperCase() !== 'USD') continue;
    const orderId = String(payment.order_id || payment.orderId || payment.id || '').trim();
    if (!orderId) continue;
    const existing = groups.get(orderId) || {
      orderId,
      customerId: payment.customer_id || payment.squareCustomerId || null,
      locationId: payment.location_id || null,
      netCents: 0,
      conversionTime: null,
      gclid: null,
      gbraid: null,
      wbraid: null,
      paymentIds: [],
    };
    existing.netCents += netCentsFromSquarePayment(payment);
    if (!existing.locationId && payment.location_id) existing.locationId = payment.location_id;
    if (!existing.customerId) {
      existing.customerId = payment.customer_id || payment.squareCustomerId || null;
    }
    const time = paymentTime(payment);
    if (time && (!existing.conversionTime || Date.parse(time) > Date.parse(existing.conversionTime))) {
      existing.conversionTime = time;
    }
    const click = extractClickIdentifiers(payment);
    if (!existing.gclid && click.gclid) existing.gclid = click.gclid;
    if (!existing.gbraid && click.gbraid) existing.gbraid = click.gbraid;
    if (!existing.wbraid && click.wbraid) existing.wbraid = click.wbraid;
    const paymentId = String(payment.id || payment.paymentId || '').trim();
    if (paymentId && !existing.paymentIds.includes(paymentId)) existing.paymentIds.push(paymentId);
    groups.set(orderId, existing);
  }
  return [...groups.values()];
}

export function evaluateOrder(order, customer = {}, { explicitStatus = null } = {}) {
  const consentStatus = resolveAdUserDataConsent({
    countryCode: customerCountry(customer) || 'US',
    paid: true,
    explicitStatus,
  });
  if (consentStatus === 'DENIED') return { include: false, reason: 'consent_denied' };
  if (consentStatus !== 'GRANTED') return { include: false, reason: 'not_us_paid' };
  if (!Number.isFinite(order.netCents) || order.netCents <= 0) {
    return { include: false, reason: 'non_positive_value' };
  }
  let conversionTime;
  try {
    conversionTime = formatConversionDateTime(order.conversionTime);
  } catch {
    return { include: false, reason: 'missing_conversion_time' };
  }
  const email = customerEmail(customer);
  const phone = customerPhone(customer);
  const types = identifierTypes({
    email,
    phone,
    gclid: order.gclid,
    gbraid: order.gbraid,
    wbraid: order.wbraid,
  });
  // A paid job with only a Google click ID (no email/phone on the Square
  // customer) is still matchable: Google attributes it from the click ID.
  if (!types.some((type) => ['hashed_email', 'gclid', 'gbraid', 'wbraid'].includes(type))) {
    return { include: false, reason: 'missing_identifier' };
  }
  return {
    include: true,
    upload: {
      email,
      phone,
      conversionValue: centsToDollars(order.netCents),
      conversionDateTime: order.conversionTime,
      orderId: order.orderId,
      consentStatus: 'GRANTED',
      gclid: order.gclid || null,
      gbraid: order.gclid ? null : (order.gbraid || null),
      wbraid: order.gclid || order.gbraid ? null : (order.wbraid || null),
    },
    summary: {
      orderId: order.orderId,
      value: centsToDollars(order.netCents),
      conversionTime,
      identifierTypes: types,
    },
  };
}

export function prepareDailyOrders({
  payments,
  groups = null,
  customersById = {},
  explicitStatusByOrderId = {},
} = {}) {
  const prepared = [];
  const rejected = [];
  for (const order of (groups || buildOrderGroups(payments))) {
    const customer = customersById[order.customerId] || {};
    const decision = evaluateOrder(order, customer, {
      explicitStatus: explicitStatusByOrderId[order.orderId] || null,
    });
    if (!decision.include) {
      rejected.push({ orderId: order.orderId, reason: decision.reason });
      continue;
    }
    prepared.push({
      orderId: order.orderId,
      upload: decision.upload,
      summary: decision.summary,
    });
  }
  return { prepared, rejected };
}

export function createDailyUploadLedger(kv) {
  const recordKey = (orderId) => `conv:daily-upload:${orderId}`;
  const claimKey = (orderId) => `conv:daily-claim:${orderId}`;
  return {
    async has(orderId) {
      return Boolean(await kv.get(recordKey(orderId)));
    },
    async claim(orderId, owner) {
      const result = await kv.set(claimKey(orderId), owner, { nx: true, ex: 5 * 60 });
      return result === 'OK' || result === true;
    },
    async release(orderId, owner) {
      if ((await kv.get(claimKey(orderId))) !== owner) return false;
      await kv.del(claimKey(orderId));
      return true;
    },
    async record(orderId, value) {
      await kv.set(recordKey(orderId), value);
      await kv.del(claimKey(orderId));
    },
  };
}

function isDuplicateOrder(result) {
  return JSON.stringify(result?.partialFailureError || {}).includes('ORDER_ID_ALREADY');
}

function errorText(result) {
  const err = result?.partialFailureError;
  if (!err) {
    return [
      result?.httpStatus,
      result?.googleStatus,
      result?.googleMessage,
      result?.errorCode,
    ].filter((part) => part !== undefined && part !== null && part !== '').join(' ')
      || 'upload_failed';
  }
  const details = Array.isArray(err.details) ? err.details : [];
  const messages = details.flatMap((detail) => detail.errors || []).map((error) => {
    const code = error.errorCode ? JSON.stringify(error.errorCode) : '';
    return `${code} ${error.message || ''}`.trim();
  }).filter(Boolean);
  return messages.join('; ') || err.message || result.errorCode || 'GOOGLE_PARTIAL_FAILURE';
}

export function debugOrderIdFromQuery(query = {}) {
  const flag = String(query.debug_enabled || query.debugEnabled || '').toLowerCase();
  if (!['1', 'true', 'yes'].includes(flag)) return null;
  const orderId = String(query.debugOrderId || '').trim();
  return orderId || null;
}

export function debugScopeFromQuery(query = {}) {
  const debugOrderId = debugOrderIdFromQuery(query);
  const flag = String(query.onlyOrder || '').toLowerCase();
  const onlyOrderRequested = ['1', 'true', 'yes'].includes(flag);
  return {
    debugOrderId,
    onlyOrderRequested,
    onlyOrder: onlyOrderRequested && Boolean(debugOrderId),
  };
}

function paymentOrderId(payment) {
  return String(payment?.order_id || payment?.orderId || payment?.id || '').trim();
}

export function filterPaymentsToOrder(payments = [], orderId) {
  return payments.filter((payment) => paymentOrderId(payment) === orderId);
}

function googleErrorRows(result) {
  const details = Array.isArray(result?.partialFailureError?.details)
    ? result.partialFailureError.details
    : [];
  return details.flatMap((detail) => detail.errors || []).map((error) => {
    const [category, code] = Object.entries(error.errorCode || {})[0] || [];
    return {
      category: category || null,
      code: code === undefined ? null : String(code),
      message: error.message || null,
    };
  });
}

function debugRowFromResult(order, result, { validateOnly, outcome }) {
  return {
    orderId: order.orderId,
    outcome,
    validateOnly: Boolean(validateOnly),
    googleRequestId: result?.googleRequestId || null,
    googleJobId: result?.googleJobId || null,
    httpStatus: result?.httpStatus ?? null,
    googleStatus: result?.googleStatus ?? null,
    googleMessage: result?.googleMessage ?? null,
    partialFailureErrors: googleErrorRows(result),
  };
}

function clickKey(click) {
  if (click?.gclid) return `gclid:${click.gclid}`;
  if (click?.gbraid) return `gbraid:${click.gbraid}`;
  if (click?.wbraid) return `wbraid:${click.wbraid}`;
  return null;
}

function uniqueClicks(clicks) {
  const seen = new Map();
  for (const click of clicks) {
    const key = clickKey(click);
    if (key) seen.set(key, click);
  }
  return [...seen.values()];
}

function clickFromJob(job) {
  return extractClickIdentifiers({
    gclid: job?.gclid || job?.acquisition?.gclid,
    gbraid: job?.gbraid || job?.acquisition?.gbraid,
    wbraid: job?.wbraid || job?.acquisition?.wbraid,
  });
}

function inMatchWindow(paidAt, job) {
  const jobAt = Date.parse(job?.completedAt || '');
  return !Number.isNaN(paidAt)
    && !Number.isNaN(jobAt)
    && Math.abs(paidAt - jobAt) <= MATCH_WINDOW_MS;
}

function singleAgreedClick(jobs) {
  const clicks = uniqueClicks(jobs.map(clickFromJob));
  return clicks.length === 1 ? clicks[0] : null;
}

// Join keys, first match wins:
// 1. Square payment id → attrib:payment-binding → pending job jobRef.
//    Used when every bound job that has a click id agrees on one id.
// 2. Square customer id → pending jobs whose completedAt is within 7 days
//    of the payment. Used only when those jobs share one click id.
// A Square payment gclid/gbraid/wbraid, when present, is kept and not replaced.
// Precedence on the upload is gclid, then gbraid, then wbraid.
export async function attachAttributionClickIds(groups, store) {
  if (!store || typeof store.listPendingJobs !== 'function') return groups;
  for (const order of groups) {
    if (order.gclid || order.gbraid || order.wbraid || !order.customerId) continue;
    const jobs = await store.listPendingJobs(order.customerId) || [];
    const boundRefs = new Set();
    if (typeof store.getPaymentBinding === 'function') {
      for (const paymentId of order.paymentIds || []) {
        const jobRef = await store.getPaymentBinding(paymentId);
        if (jobRef) boundRefs.add(jobRef);
      }
    }
    const boundJobs = jobs.filter((job) => boundRefs.has(job.jobRef));
    const paidAt = Date.parse(order.conversionTime || '');
    const chosen = boundRefs.size > 0
      ? singleAgreedClick(boundJobs)
      : singleAgreedClick(jobs.filter((job) => inMatchWindow(paidAt, job)));
    if (!chosen) continue;
    order.gclid = chosen.gclid || null;
    order.gbraid = chosen.gclid ? null : (chosen.gbraid || null);
    order.wbraid = chosen.gclid || chosen.gbraid ? null : (chosen.wbraid || null);
  }
  return groups;
}

export function conversionIdentifierCounts(orders = []) {
  let gclidCount = 0;
  let gbraidCount = 0;
  let wbraidCount = 0;
  let piiOnlyCount = 0;
  for (const order of orders) {
    const types = order.identifierTypes || [];
    if (types.includes('gclid')) gclidCount += 1;
    else if (types.includes('gbraid')) gbraidCount += 1;
    else if (types.includes('wbraid')) wbraidCount += 1;
    else piiOnlyCount += 1;
  }
  return { gclidCount, gbraidCount, wbraidCount, piiOnlyCount };
}

export async function uploadDailyOrders({
  orders,
  uploadConversion,
  ledger,
  validateOnly = false,
  debugOrderId = null,
}) {
  if (typeof uploadConversion !== 'function') throw new Error('Upload function is required');
  if (!validateOnly && !ledger) throw new Error('Upload ledger is required');
  const uploaded = [];
  const errors = [];
  const skipped = [];
  let debugRow = null;

  for (const order of orders) {
    const isDebugOrder = Boolean(debugOrderId) && debugOrderId === order.orderId;
    if (!validateOnly && await ledger.has(order.orderId)) {
      skipped.push({ orderId: order.orderId, reason: 'already_uploaded' });
      if (isDebugOrder) {
        debugRow = {
          orderId: order.orderId,
          outcome: 'skipped_already_uploaded',
          validateOnly: false,
          note: 'Order is already in the upload ledger. Nothing was sent to Google; a debug run on an uploaded order is a no-op.',
        };
      }
      continue;
    }
    const owner = crypto.randomUUID();
    if (!validateOnly && !(await ledger.claim(order.orderId, owner))) {
      skipped.push({ orderId: order.orderId, reason: 'upload_in_progress' });
      if (isDebugOrder) {
        debugRow = {
          orderId: order.orderId,
          outcome: 'skipped_upload_in_progress',
          validateOnly: false,
          note: 'Another upload holds the claim on this order. Nothing was sent to Google.',
        };
      }
      continue;
    }
    try {
      const result = await uploadConversion({
        ...order.upload,
        validateOnly: Boolean(validateOnly),
        debugEnabled: isDebugOrder,
      });
      if (result?.success) {
        if (isDebugOrder) {
          debugRow = debugRowFromResult(order, result, {
            validateOnly,
            outcome: validateOnly ? 'validated' : 'uploaded',
          });
        }
        const row = { ...order.summary, googleRequestId: result.googleRequestId || null };
        if (!validateOnly) {
          await ledger.record(order.orderId, {
            ...row,
            status: 'uploaded',
            changeRecord: CHANGE_RECORD,
            recordedAt: new Date().toISOString(),
          });
        }
        uploaded.push(row);
        continue;
      }
      if (!validateOnly && isDuplicateOrder(result)) {
        await ledger.record(order.orderId, {
          orderId: order.orderId,
          status: 'already_uploaded',
          changeRecord: CHANGE_RECORD,
          recordedAt: new Date().toISOString(),
        });
        skipped.push({ orderId: order.orderId, reason: 'already_uploaded' });
        if (isDebugOrder) {
          debugRow = {
            ...debugRowFromResult(order, result, {
              validateOnly,
              outcome: 'skipped_already_uploaded',
            }),
            note: 'Google reports this order id was already uploaded. It is now recorded in the ledger.',
          };
        }
        continue;
      }
      if (!validateOnly) await ledger.release(order.orderId, owner);
      errors.push({
        orderId: order.orderId,
        error: `Google Ads upload failed for order ${order.orderId}: ${errorText(result)}`,
      });
      if (isDebugOrder) {
        debugRow = debugRowFromResult(order, result, {
          validateOnly,
          outcome: result?.partialFailureError ? 'google_partial_failure' : 'google_request_failure',
        });
      }
      if (result?.httpStatus === 401 || result?.httpStatus === 403) {
        return finish(uploaded, errors, skipped, true);
      }
    } catch (error) {
      if (!validateOnly) await ledger.release(order.orderId, owner);
      errors.push({
        orderId: order.orderId,
        error: `Google Ads upload failed for order ${order.orderId}: ${error.message || 'upload_failed'}`,
      });
      if (isDebugOrder) {
        debugRow = {
          orderId: order.orderId,
          outcome: 'upload_exception',
          validateOnly: Boolean(validateOnly),
          error: error.message || 'upload_failed',
        };
      }
    }
  }

  return finish(uploaded, errors, skipped, false);

  function finish(uploadedRows, errorRows, skippedRows, stoppedEarly) {
    const totalCents = uploadedRows.reduce((sum, row) => sum + Math.round(Number(row.value) * 100), 0);
    return {
      validateOnly: Boolean(validateOnly),
      uploadedCount: uploadedRows.length,
      totalValue: centsToDollars(totalCents),
      currency: 'USD',
      orders: uploadedRows,
      errors: errorRows,
      skipped: skippedRows,
      stoppedEarly,
      debugRow,
      ...conversionIdentifierCounts(uploadedRows),
      conversionActionId: DAILY_CONVERSION_ACTION_ID,
      changeRecord: CHANGE_RECORD,
    };
  }
}

async function hookAdjustments(store, groups) {
  const explicitStatusByOrderId = {};
  const alreadyUploaded = new Set();
  if (!store || typeof store.listPendingJobs !== 'function') {
    return { explicitStatusByOrderId, alreadyUploaded };
  }
  for (const order of groups) {
    if (!order.customerId) continue;
    const jobs = await store.listPendingJobs(order.customerId);
    const paidAt = Date.parse(order.conversionTime || '');
    for (const job of jobs || []) {
      const jobAt = Date.parse(job.completedAt || '');
      const inWindow = !Number.isNaN(paidAt)
        && !Number.isNaN(jobAt)
        && Math.abs(paidAt - jobAt) <= MATCH_WINDOW_MS;
      const denied = String(job.consentStatus || '').toUpperCase() === 'DENIED';
      if (denied && (inWindow || Number.isNaN(jobAt))) {
        explicitStatusByOrderId[order.orderId] = 'DENIED';
      }
      if (
        inWindow
        && job.jobRef
        && typeof store.hasSuccess === 'function'
        && await store.hasSuccess(job.jobRef)
      ) {
        alreadyUploaded.add(order.orderId);
      }
    }
  }
  return { explicitStatusByOrderId, alreadyUploaded };
}

function emptyLocationCounts() {
  return { orders: 0, eligible: 0, uploaded: 0, skipped: 0, rejected: 0, errors: 0 };
}

function countByLocation({ groups, prepared, rejected, result, hookSkips }) {
  const locationByOrder = new Map(groups.map((order) => [order.orderId, order.locationId || 'unknown']));
  const counts = {};
  const bump = (orderId, key) => {
    const locationId = locationByOrder.get(orderId) || 'unknown';
    counts[locationId] = counts[locationId] || emptyLocationCounts();
    counts[locationId][key] += 1;
  };
  for (const order of groups) bump(order.orderId, 'orders');
  for (const order of prepared) bump(order.orderId, 'eligible');
  for (const row of result.orders) bump(row.orderId, 'uploaded');
  for (const row of [...hookSkips, ...result.skipped]) bump(row.orderId, 'skipped');
  for (const row of rejected) bump(row.orderId, 'rejected');
  for (const row of result.errors) bump(row.orderId, 'errors');
  return counts;
}

function debugReport({ debugOrderId, onlyOrder, groups, rejected, hookSkips, debugRow }) {
  if (!debugOrderId) return null;
  const base = { orderId: debugOrderId, onlyOrder: Boolean(onlyOrder) };
  if (debugRow) return { ...base, ...debugRow };
  if (!groups.some((order) => order.orderId === debugOrderId)) {
    return {
      ...base,
      outcome: 'order_not_found',
      note: 'No COMPLETED USD payment for this order id in the lookback window. Nothing was sent to Google.',
    };
  }
  const rejection = rejected.find((row) => row.orderId === debugOrderId);
  if (rejection) {
    return {
      ...base,
      outcome: 'rejected',
      reason: rejection.reason,
      note: 'Order is not eligible for upload. Nothing was sent to Google.',
    };
  }
  if (hookSkips.some((row) => row.orderId === debugOrderId)) {
    return {
      ...base,
      outcome: 'skipped_already_uploaded',
      note: 'The Zenbooker job.completed hook already uploaded this order. Nothing was sent to Google.',
    };
  }
  return {
    ...base,
    outcome: 'not_attempted',
    note: 'Order was not attempted, usually because an earlier Google 401/403 stopped the batch.',
  };
}

export async function runDailyOfflineConversions({
  payments,
  customersById = {},
  store = null,
  uploadConversion,
  ledger,
  validateOnly = false,
  debugOrderId = null,
  onlyOrder = false,
}) {
  const scoped = onlyOrder && debugOrderId;
  const alreadyInLedger = debugOrderId && ledger ? await ledger.has(debugOrderId) : null;
  const groups = buildOrderGroups(scoped ? filterPaymentsToOrder(payments, debugOrderId) : payments);
  await attachAttributionClickIds(groups, store);
  const { explicitStatusByOrderId, alreadyUploaded } = await hookAdjustments(store, groups);
  const { prepared, rejected } = prepareDailyOrders({
    groups,
    customersById,
    explicitStatusByOrderId,
  });
  const ready = prepared.filter((order) => !alreadyUploaded.has(order.orderId));
  const result = await uploadDailyOrders({
    orders: ready,
    uploadConversion,
    ledger,
    validateOnly,
    debugOrderId,
  });
  const hookSkips = prepared
    .filter((order) => alreadyUploaded.has(order.orderId))
    .map((order) => ({ orderId: order.orderId, reason: 'already_uploaded' }));
  const { debugRow, ...publicResult } = result;
  const summary = {
    ...publicResult,
    skipped: [...hookSkips, ...result.skipped],
    rejected,
    locationCounts: countByLocation({ groups, prepared, rejected, result, hookSkips }),
  };
  const debug = debugReport({
    debugOrderId,
    onlyOrder: Boolean(scoped),
    groups,
    rejected,
    hookSkips,
    debugRow,
  });
  if (debug) {
    summary.debug = { ...debug, alreadyInLedger };
    if (alreadyInLedger && validateOnly && !debug.note) {
      summary.debug.note = 'Order is already in the upload ledger. This validate-only run did not consult the ledger and recorded nothing; a real run would skip it.';
    }
  }
  return summary;
}

export function formatOfflineConversionSummary(result) {
  const label = result.validateOnly ? 'dry-run' : 'upload';
  const lines = [
    `Offline conversions ${label}: ${result.uploadedCount} orders, $${Number(result.totalValue).toFixed(2)} USD, gclid ${result.gclidCount || 0}, gbraid ${result.gbraidCount || 0}, wbraid ${result.wbraidCount || 0}, pii-only ${result.piiOnlyCount || 0}`,
  ];
  for (const order of result.orders || []) {
    lines.push(
      `${order.orderId} $${Number(order.value).toFixed(2)} ${order.conversionTime} [${(order.identifierTypes || []).join(',')}]`,
    );
  }
  for (const error of result.errors || []) {
    lines.push(`error ${error.orderId}: ${error.error}`);
  }
  return lines.join('\n').slice(0, 1900);
}

function squareHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Square-Version': SQUARE_VERSION,
    'Content-Type': 'application/json',
  };
}

const SQUARE_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isRetryableSquareError(error) {
  const status = Number(error?.response?.status);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  if (error?.response) return false;
  const code = String(error?.code || '');
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;
  return /timeout/i.test(String(error?.message || ''));
}

export function squareRetryDelayMs(attempt, {
  baseMs = SQUARE_RETRY_BASE_MS,
  random = Math.random,
} = {}) {
  const exponential = baseMs * (2 ** (attempt - 1));
  const jitter = Math.floor(Number(random()) * exponential);
  return exponential + jitter;
}

function upstreamFailureDetail(error) {
  const status = Number(error?.response?.status);
  if (Number.isInteger(status) && status > 0) return String(status);
  const code = String(error?.code || '');
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(String(error?.message || ''))) {
    return 'timeout';
  }
  if (code) return code;
  return error?.message || 'request_failed';
}

function toSquareStepError(error, prefix) {
  const message = String(error?.message || '');
  if (message.startsWith(prefix)) return error;
  const wrapped = new Error(`${prefix}: ${upstreamFailureDetail(error)}`);
  wrapped.cause = error;
  if (error?.response) wrapped.response = error.response;
  if (error?.code) wrapped.code = error.code;
  return wrapped;
}

function squareRetryConfig(options = {}) {
  const config = {};
  if (options.maxAttempts != null) config.attempts = options.maxAttempts;
  if (options.sleep) config.sleep = options.sleep;
  if (options.random) config.random = options.random;
  if (options.retryBaseMs != null) config.baseMs = options.retryBaseMs;
  return config;
}

export async function withSquareRetry(request, {
  attempts = SQUARE_MAX_ATTEMPTS,
  sleep = SQUARE_SLEEP,
  random = Math.random,
  baseMs = SQUARE_RETRY_BASE_MS,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableSquareError(error)) throw error;
      await sleep(squareRetryDelayMs(attempt, { baseMs, random }));
    }
  }
  throw lastError;
}

async function squareGet(httpClient, url, options = {}) {
  const { token, timeoutMs = SQUARE_TIMEOUT_MS, ...retry } = options;
  return withSquareRetry(
    () => httpClient.get(url, {
      headers: squareHeaders(token),
      timeout: timeoutMs,
    }),
    squareRetryConfig(retry),
  );
}

export function squareCredentials(env = process.env) {
  return {
    token: env.SQUARE_ACCESS_TOKEN || env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN || '',
    locationId: env.SQUARE_LOCATION_ID || env.NEXT_PUBLIC_SQUARE_LOCATION_ID || '',
  };
}

export async function fetchCompletedSquarePayments({
  token,
  locationId,
  beginTime,
  httpClient,
  ...retry
}) {
  const payments = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({
      location_id: locationId,
      limit: '100',
      begin_time: beginTime,
    });
    if (cursor) params.set('cursor', cursor);
    const response = await squareGet(
      httpClient,
      `https://connect.squareup.com/v2/payments?${params.toString()}`,
      { token, ...retry },
    );
    payments.push(...(response.data?.payments || []));
    cursor = response.data?.cursor || null;
  } while (cursor);
  return payments.filter((payment) => String(payment.status).toUpperCase() === 'COMPLETED');
}

export async function fetchActiveSquareLocations({ token, httpClient, ...retry }) {
  let response;
  try {
    response = await squareGet(
      httpClient,
      'https://connect.squareup.com/v2/locations',
      { token, ...retry },
    );
  } catch (error) {
    throw toSquareStepError(error, 'Square locations fetch failed');
  }
  return (response.data?.locations || [])
    .filter((location) => String(location.status || '').toUpperCase() === 'ACTIVE' && location.id)
    .map((location) => ({ id: location.id, name: location.name || null }));
}

// Falls back to the configured location when the list call fails or has no ACTIVE entry.
export async function resolveSquareLocations({ token, fallbackLocationId, httpClient, ...retry }) {
  try {
    const locations = await fetchActiveSquareLocations({ token, httpClient, ...retry });
    if (locations.length > 0) return { locations, source: 'list_locations' };
  } catch (error) {
    console.error('daily_offline_conversion_list_locations_failed', { message: error.message });
  }
  return {
    locations: fallbackLocationId ? [{ id: fallbackLocationId, name: null }] : [],
    source: 'fallback_square_location_id',
  };
}

export async function fetchCompletedSquarePaymentsForLocations({
  token,
  locations,
  beginTime,
  httpClient,
  ...retry
}) {
  const payments = [];
  const seenPaymentIds = new Set();
  const perLocation = [];
  const failures = [];
  for (const location of locations) {
    try {
      const locationPayments = await fetchCompletedSquarePayments({
        token,
        locationId: location.id,
        beginTime,
        httpClient,
        ...retry,
      });
      let added = 0;
      for (const payment of locationPayments) {
        if (payment.id && seenPaymentIds.has(payment.id)) continue;
        if (payment.id) seenPaymentIds.add(payment.id);
        payments.push(payment.location_id ? payment : { ...payment, location_id: location.id });
        added += 1;
      }
      perLocation.push({ locationId: location.id, name: location.name, paymentCount: added });
    } catch (error) {
      const wrapped = toSquareStepError(
        error,
        `Square payments fetch failed for location ${location.id}`,
      );
      failures.push({ locationId: location.id, error: wrapped.message });
    }
  }
  return { payments, perLocation, failures };
}

export async function fetchSquareCustomers(customerIds, { token, httpClient, ...retry }) {
  const customersById = {};
  for (const customerId of customerIds) {
    if (!customerId || customersById[customerId]) continue;
    try {
      const response = await squareGet(
        httpClient,
        `https://connect.squareup.com/v2/customers/${customerId}`,
        { token, ...retry },
      );
      customersById[customerId] = response.data?.customer || {};
    } catch (error) {
      throw toSquareStepError(error, `Square customer fetch failed for ${customerId}`);
    }
  }
  return customersById;
}

async function refreshGoogleAccessToken(env, httpClient, { timeoutMs = GOOGLE_TIMEOUT_MS } = {}) {
  const clientId = env.GOOGLE_ADS_CLIENT_ID || env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_ADS_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_ADS_REFRESH_TOKEN || env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Google OAuth credentials (GOOGLE_ADS_CLIENT_ID or GOOGLE_CLIENT_ID, plus the matching client secret and refresh token)');
  }
  try {
    const response = await httpClient.post('https://oauth2.googleapis.com/token', null, {
      timeout: timeoutMs,
      params: {
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      },
    });
    if (!response.data?.access_token) {
      throw new Error('Google OAuth token fetch failed: missing access_token');
    }
    return response.data;
  } catch (error) {
    if (String(error?.message || '').startsWith('Google OAuth token fetch failed')) throw error;
    throw new Error(`Google OAuth token fetch failed: ${upstreamFailureDetail(error)}`);
  }
}

function googleTokenLifetimeMs(expiresIn) {
  const seconds = Number(expiresIn);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return GOOGLE_TOKEN_DEFAULT_LIFETIME_MS;
}

export function createCachedGoogleAccessToken(env, httpClient, {
  now = () => Date.now(),
  timeoutMs = GOOGLE_TIMEOUT_MS,
} = {}) {
  const state = { token: null, expiresAt: 0, error: null, pending: null };
  return function getAccessToken() {
    if (state.token && now() < state.expiresAt - GOOGLE_TOKEN_SKEW_MS) return Promise.resolve(state.token);
    if (state.error && !state.token) return Promise.reject(state.error);
    if (!state.pending) {
      state.error = null;
      state.pending = refreshGoogleAccessToken(env, httpClient, { timeoutMs })
        .then((data) => {
          state.token = data.access_token;
          state.expiresAt = now() + googleTokenLifetimeMs(data.expires_in);
          state.error = null;
          return state.token;
        })
        .catch((error) => {
          state.token = null;
          state.expiresAt = 0;
          state.error = error;
          throw error;
        })
        .finally(() => {
          state.pending = null;
        });
    }
    return state.pending;
  };
}

function withRequestTimeout(httpClient, timeoutMs) {
  return {
    post(url, data, config = {}) {
      return httpClient.post(url, data, {
        ...config,
        timeout: config.timeout ?? timeoutMs,
      });
    },
  };
}

export function createDailyGoogleUpload(env = process.env, httpClient = axios, options = {}) {
  const getAccessToken = createCachedGoogleAccessToken(env, httpClient, options);
  return (input) => uploadOfflineConversion(input, {
    conversionActionId: DAILY_CONVERSION_ACTION_ID,
    httpClient: withRequestTimeout(httpClient, options.timeoutMs ?? GOOGLE_TIMEOUT_MS),
    getAccessToken,
    getDeveloperToken: () => {
      if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) {
        throw new Error('Missing GOOGLE_ADS_DEVELOPER_TOKEN');
      }
      return env.GOOGLE_ADS_DEVELOPER_TOKEN;
    },
  });
}
