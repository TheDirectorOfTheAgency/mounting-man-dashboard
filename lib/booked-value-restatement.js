// Tracking fix #3: replace the flat default value ($420) on Booked Appointment
// with the job's real ZenBooker total, without touching GTM.
//
// The thank-you tag records Booked Appointment (WEBPAGE) with
// transaction_id = booking_session and, when the URL has no `total`, the
// action's default value. Once ZenBooker sends the job with its total, we send
// a RESTATEMENT adjustment keyed by the same order id. A restatement only
// changes the value of the conversion that already exists; it never adds one.
//
// Dedupe: val:restated:<opaqueRef(session)> holds the value Google accepted,
// so the same value is never sent twice. CONVERSION_NOT_FOUND (tag never fired
// or not ingested yet) is logged and left unmarked.
// OFF by default. Google rejects restatements while the Booked Appointment
// action has "always use default value" on (CANNOT_RESTATE_CONVERSION_ACTION_
// THAT_ALWAYS_USES_DEFAULT_CONVERSION_VALUE, checked 2026-10-13 with
// validateOnly). Turn on with BOOKED_VALUE_RESTATEMENT=on only after that
// setting is changed in Google Ads.

import axios from 'axios';
import { getAccessToken, getDeveloperToken } from './google-ads-auth.js';
import { opaqueRef } from './offline-conversion-eligibility.js';
import { BOOKED_APPOINTMENT_ACTION_ID } from './deferred-booking-identity.js';

const CUSTOMER_ID = '1287907452';
const DEFAULT_API_VERSION = 'v24';
const DONE_TTL_SECONDS = 120 * 24 * 60 * 60;

function adjustmentDateTime(date = new Date()) {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')}+00:00`;
}

function codesOf(value) {
  const text = JSON.stringify(value || {});
  return [...new Set(text.match(/[A-Z][A-Z_]{5,}/g) || [])].slice(0, 6);
}

export function createRestatementUploader({
  env = process.env,
  httpClient = axios,
  getToken = getAccessToken,
  getDevToken = getDeveloperToken,
  now = () => new Date(),
} = {}) {
  return async function uploadRestatement({ orderId, value, validateOnly = false }) {
    const actionId = env.GOOGLE_ADS_BOOKED_APPOINTMENT_ACTION_ID || BOOKED_APPOINTMENT_ACTION_ID;
    const apiVersion = env.GOOGLE_ADS_API_VERSION || DEFAULT_API_VERSION;
    const body = {
      conversionAdjustments: [{
        conversionAction: `customers/${CUSTOMER_ID}/conversionActions/${actionId}`,
        adjustmentType: 'RESTATEMENT',
        orderId: String(orderId),
        adjustmentDateTime: adjustmentDateTime(now()),
        restatementValue: { adjustedValue: value, currencyCode: 'USD' },
      }],
      partialFailure: true,
      validateOnly: Boolean(validateOnly),
    };
    try {
      const response = await httpClient.post(
        `https://googleads.googleapis.com/${apiVersion}/customers/${CUSTOMER_ID}:uploadConversionAdjustments`,
        body,
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getToken()}`, 'developer-token': getDevToken() }, timeout: 10000 },
      );
      const partial = response?.data?.partialFailureError;
      if (partial) return { ok: false, codes: codesOf(partial) };
      return { ok: true, validated: Boolean(validateOnly) };
    } catch (error) {
      const status = error?.response?.status;
      return { ok: false, codes: [status ? `http_${status}` : (error?.code || 'network'), ...codesOf(error?.response?.data)] };
    }
  };
}

export async function restateBookedValue({
  kv,
  bookingSession,
  value,
  upload,
  env = process.env,
  validateOnly = false,
}) {
  if (String(env.BOOKED_VALUE_RESTATEMENT || '').toLowerCase() !== 'on') return { outcome: 'disabled' };
  if (typeof bookingSession !== 'string' || !bookingSession.trim()) return { outcome: 'no_session' };
  if (!Number.isFinite(value) || value <= 0) return { outcome: 'no_value' };
  const amount = Math.round(value * 100) / 100;
  const key = `val:restated:${opaqueRef(bookingSession)}`;
  const previous = kv ? await kv.get(key) : null;
  if (previous && Number(previous.value) === amount) return { outcome: 'already_restated' };
  const result = await upload({ orderId: bookingSession.trim(), value: amount, validateOnly });
  if (result.ok && !validateOnly && kv) {
    await kv.set(key, { value: amount, at: new Date().toISOString() }, { ex: DONE_TTL_SECONDS });
  }
  if (result.ok) return { outcome: validateOnly ? 'validated' : 'restated', value: amount };
  const notFound = (result.codes || []).some((code) => code.includes('CONVERSION_NOT_FOUND'));
  return { outcome: notFound ? 'conversion_not_found' : 'failed', codes: result.codes };
}
