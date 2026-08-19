// pages/api/attribution/gclid.js
//
// GCLID receiver — capture only.
//
// Public, always-on Vercel route. Accepts the Google click identifier that
// ZenBooker collected on the booking form and parks the raw value in KV
// against the booking that produced it.
//
// Deliberately inert: this route performs no Google Ads upload and no other
// module reads the keys it writes. Promoting a parked click identifier into
// the offline-conversion upload path is a separate, explicit change.
//
// Why this exists: the rest of the attribution chain
// (lib/offline-conversion-eligibility.js, /api/attribution/booking) records
// only that a gclid was *present* — `hasGclid: true`, `paidMarker: 'gclid'`.
// The value is discarded, so no click-based conversion can ever be uploaded.
// This route is the only place the raw identifier is retained.

import crypto from 'node:crypto';
import { createAttributionStore } from '../../../lib/offline-conversion-store.js';
import { opaqueRef } from '../../../lib/offline-conversion-eligibility.js';

const MAX_BODY_BYTES = 4096;
const BOOKING_REF_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;
// Google click identifiers are URL-safe tokens. Length is not contractual,
// so the bound is a sanity cap rather than a format assertion.
const CLICK_ID_PATTERN = /^[A-Za-z0-9._-]{8,512}$/;
const CLICK_TYPES = ['gclid', 'gbraid', 'wbraid'];

let cachedKV;
async function getDefaultKV() {
  if (cachedKV !== undefined) return cachedKV;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    cachedKV = null;
    return cachedKV;
  }
  const { kv } = await import('@vercel/kv');
  cachedKV = kv;
  return cachedKV;
}

function defaultLogger() {
  return {
    info(event, details) { console.log(event, details); },
    warn(event, details) { console.warn(event, details); },
    error(event, details) { console.error(event, details); },
  };
}

function secretsMatch(expected, supplied) {
  if (!expected || !supplied) return false;
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(supplied));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

// ZenBooker wraps webhook payloads in `data` (and sometimes `data.job`).
// Accept the wrapper without requiring it.
function flatten(body = {}) {
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const job = data.job && typeof data.job === 'object'
    ? data.job
    : body.job && typeof body.job === 'object' ? body.job : {};
  const tracking = {
    ...(body.tracking || {}),
    ...(data.tracking || {}),
    ...(job.tracking || {}),
  };
  return { ...body, ...data, ...job, ...tracking };
}

export function extractClickCapture(body = {}) {
  const flat = flatten(body);
  const zenCustomerId = firstPresent(
    flat.customer_id,
    flat.customerId,
    flat.customer?.id
  );
  const bookingSession = firstPresent(
    flat.booking_session,
    flat.bookingSession,
    flat.booking_session_id,
    flat.bookingSessionId
  );

  let clickType = null;
  let clickId = null;
  for (const type of CLICK_TYPES) {
    const value = firstPresent(flat[type], flat[`${type}_value`]);
    if (value !== undefined) {
      clickType = type;
      clickId = String(value).trim();
      break;
    }
  }

  return {
    zenCustomerId: zenCustomerId === undefined ? null : String(zenCustomerId).trim(),
    bookingSession: bookingSession === undefined ? null : String(bookingSession).trim(),
    clickType,
    clickId,
    clickedAt: firstPresent(flat.clicked_at, flat.clickedAt, flat.created_at, flat.createdAt) || null,
  };
}

export function createGclidReceiverHandler({
  attributionStore,
  kvClient,
  logger = defaultLogger(),
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ captured: false, errorCode: 'METHOD_NOT_ALLOWED' });
    }

    const expectedSecret = process.env.ZENBOOKER_GCLID_SECRET;
    if (!expectedSecret) {
      logger.error('gclid_receiver_configuration_error', { errorCode: 'MISSING_RECEIVER_SECRET' });
      return res.status(500).json({ captured: false, errorCode: 'RECEIVER_NOT_CONFIGURED' });
    }
    const suppliedSecret = req.query?.secret || req.headers?.['x-webhook-secret'];
    if (!secretsMatch(expectedSecret, suppliedSecret)) {
      logger.warn('gclid_receiver_auth_failed', {});
      return res.status(401).json({ captured: false, errorCode: 'UNAUTHORIZED' });
    }

    // Past auth every response is 200: ZenBooker disables a subscription after
    // four non-2xx replies, and a disabled hook loses clicks silently.
    const body = req.body || {};
    if (JSON.stringify(body).length > MAX_BODY_BYTES) {
      logger.warn('gclid_receiver_payload_rejected', { errorCode: 'PAYLOAD_TOO_LARGE' });
      return res.status(200).json({ captured: false, errorCode: 'PAYLOAD_TOO_LARGE' });
    }

    const capture = extractClickCapture(body);
    if (
      !BOOKING_REF_PATTERN.test(capture.zenCustomerId || '')
      || !BOOKING_REF_PATTERN.test(capture.bookingSession || '')
    ) {
      logger.warn('gclid_receiver_rejected', { errorCode: 'INVALID_BOOKING_REFERENCE' });
      return res.status(200).json({ captured: false, errorCode: 'INVALID_BOOKING_REFERENCE' });
    }
    if (!capture.clickType) {
      logger.info('gclid_receiver_skipped', { reason: 'NO_CLICK_IDENTIFIER' });
      return res.status(200).json({ captured: false, reason: 'NO_CLICK_IDENTIFIER' });
    }
    if (!CLICK_ID_PATTERN.test(capture.clickId || '')) {
      logger.warn('gclid_receiver_rejected', { errorCode: 'INVALID_CLICK_IDENTIFIER' });
      return res.status(200).json({ captured: false, errorCode: 'INVALID_CLICK_IDENTIFIER' });
    }

    const bookingRef = opaqueRef(`${capture.zenCustomerId}:${capture.bookingSession}`).slice(0, 12);

    try {
      let activeStore = attributionStore;
      if (!activeStore) {
        const activeKV = kvClient === undefined ? await getDefaultKV() : kvClient;
        if (!activeKV) {
          logger.error('gclid_receiver_store_unavailable', { bookingRef });
          return res.status(200).json({
            captured: false,
            retryable: true,
            errorCode: 'ATTRIBUTION_STORE_UNAVAILABLE',
          });
        }
        activeStore = createAttributionStore(activeKV);
      }

      await activeStore.saveClickIdentifier({
        zenCustomerId: capture.zenCustomerId,
        bookingSession: capture.bookingSession,
        clickType: capture.clickType,
        clickId: capture.clickId,
        clickedAt: capture.clickedAt,
      });

      // bookingRef and clickType only — the raw click id never reaches a log line.
      logger.info('gclid_receiver_captured', { bookingRef, clickType: capture.clickType });
      return res.status(200).json({
        captured: true,
        bookingRef,
        clickType: capture.clickType,
      });
    } catch (error) {
      logger.error('gclid_receiver_capture_failed', {
        bookingRef,
        errorType: error.name || 'Error',
      });
      return res.status(200).json({
        captured: false,
        retryable: true,
        errorCode: 'CLICK_CAPTURE_FAILED',
      });
    }
  };
}

export default createGclidReceiverHandler();
