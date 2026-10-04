import crypto from 'node:crypto';
import axios from 'axios';

import { resolveAdUserDataConsent } from './ad-user-data-consent.js';
import { uploadOfflineConversion, formatConversionDateTime } from './google-ads-conversions.js';
import { hashEmail, hashPhone } from './hash-pii.js';
import { centsToDollars, netCentsFromSquarePayment } from './offline-conversion-value.js';

export const DAILY_CONVERSION_ACTION_ID = '7509313857';
export const CHANGE_RECORD = 'LEDGER-2026-10-04-CONVERSION-TRACKING';
export const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const MATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SQUARE_VERSION = '2024-01-18';

export function identifierTypes({ email, phone, gclid, gbraid } = {}) {
  const types = [];
  if (hashEmail(email)) types.push('hashed_email');
  if (hashPhone(phone)) types.push('hashed_phone');
  if (gclid) types.push('gclid');
  else if (gbraid) types.push('gbraid');
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
      netCents: 0,
      conversionTime: null,
      gclid: null,
      gbraid: null,
    };
    existing.netCents += netCentsFromSquarePayment(payment);
    if (!existing.customerId) {
      existing.customerId = payment.customer_id || payment.squareCustomerId || null;
    }
    const time = paymentTime(payment);
    if (time && (!existing.conversionTime || Date.parse(time) > Date.parse(existing.conversionTime))) {
      existing.conversionTime = time;
    }
    if (!existing.gclid && payment.gclid) existing.gclid = String(payment.gclid).trim();
    if (!existing.gbraid && payment.gbraid) existing.gbraid = String(payment.gbraid).trim();
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
  });
  if (!types.includes('hashed_email') && !types.includes('hashed_phone')) {
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
  customersById = {},
  explicitStatusByOrderId = {},
} = {}) {
  const prepared = [];
  const rejected = [];
  for (const order of buildOrderGroups(payments)) {
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

export async function uploadDailyOrders({
  orders,
  uploadConversion,
  ledger,
  validateOnly = false,
}) {
  if (typeof uploadConversion !== 'function') throw new Error('Upload function is required');
  if (!validateOnly && !ledger) throw new Error('Upload ledger is required');
  const uploaded = [];
  const errors = [];
  const skipped = [];

  for (const order of orders) {
    if (!validateOnly && await ledger.has(order.orderId)) {
      skipped.push({ orderId: order.orderId, reason: 'already_uploaded' });
      continue;
    }
    const owner = crypto.randomUUID();
    if (!validateOnly && !(await ledger.claim(order.orderId, owner))) {
      skipped.push({ orderId: order.orderId, reason: 'upload_in_progress' });
      continue;
    }
    try {
      const result = await uploadConversion({ ...order.upload, validateOnly: Boolean(validateOnly) });
      if (result?.success) {
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
        continue;
      }
      if (!validateOnly) await ledger.release(order.orderId, owner);
      errors.push({ orderId: order.orderId, error: errorText(result) });
      if (result?.httpStatus === 401 || result?.httpStatus === 403) {
        return finish(uploaded, errors, skipped, true);
      }
    } catch (error) {
      if (!validateOnly) await ledger.release(order.orderId, owner);
      errors.push({ orderId: order.orderId, error: error.message || 'upload_failed' });
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

export async function runDailyOfflineConversions({
  payments,
  customersById = {},
  store = null,
  uploadConversion,
  ledger,
  validateOnly = false,
}) {
  const groups = buildOrderGroups(payments);
  const { explicitStatusByOrderId, alreadyUploaded } = await hookAdjustments(store, groups);
  const { prepared, rejected } = prepareDailyOrders({
    payments,
    customersById,
    explicitStatusByOrderId,
  });
  const ready = prepared.filter((order) => !alreadyUploaded.has(order.orderId));
  const result = await uploadDailyOrders({
    orders: ready,
    uploadConversion,
    ledger,
    validateOnly,
  });
  const hookSkips = prepared
    .filter((order) => alreadyUploaded.has(order.orderId))
    .map((order) => ({ orderId: order.orderId, reason: 'already_uploaded' }));
  return {
    ...result,
    skipped: [...hookSkips, ...result.skipped],
    rejected,
  };
}

export function formatDiscordSummary(result) {
  const label = result.validateOnly ? 'dry-run' : 'upload';
  const lines = [
    `Offline conversions ${label}: ${result.uploadedCount} orders, $${Number(result.totalValue).toFixed(2)} USD`,
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
    const response = await httpClient.get(
      `https://connect.squareup.com/v2/payments?${params.toString()}`,
      { headers: squareHeaders(token) },
    );
    payments.push(...(response.data?.payments || []));
    cursor = response.data?.cursor || null;
  } while (cursor);
  return payments.filter((payment) => String(payment.status).toUpperCase() === 'COMPLETED');
}

export async function fetchSquareCustomers(customerIds, { token, httpClient }) {
  const customersById = {};
  for (const customerId of customerIds) {
    if (!customerId || customersById[customerId]) continue;
    const response = await httpClient.get(
      `https://connect.squareup.com/v2/customers/${customerId}`,
      { headers: squareHeaders(token) },
    );
    customersById[customerId] = response.data?.customer || {};
  }
  return customersById;
}

async function refreshGoogleAccessToken(env, httpClient) {
  const clientId = env.GOOGLE_ADS_CLIENT_ID || env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_ADS_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_ADS_REFRESH_TOKEN || env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Google OAuth credentials (GOOGLE_ADS_CLIENT_ID or GOOGLE_CLIENT_ID, plus the matching client secret and refresh token)');
  }
  const response = await httpClient.post('https://oauth2.googleapis.com/token', null, {
    params: {
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    },
  });
  return response.data.access_token;
}

export function createDailyGoogleUpload(env = process.env, httpClient = axios) {
  return (input) => uploadOfflineConversion(input, {
    conversionActionId: DAILY_CONVERSION_ACTION_ID,
    httpClient,
    getAccessToken: () => refreshGoogleAccessToken(env, httpClient),
    getDeveloperToken: () => {
      if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) {
        throw new Error('Missing GOOGLE_ADS_DEVELOPER_TOKEN');
      }
      return env.GOOGLE_ADS_DEVELOPER_TOKEN;
    },
  });
}
