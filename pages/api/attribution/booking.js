import { createAttributionStore } from '../../../lib/offline-conversion-store.js';
import { opaqueRef } from '../../../lib/offline-conversion-eligibility.js';

const DEFAULT_ALLOWED_ORIGIN = 'https://www.themountingman.com';
const MAX_BODY_BYTES = 4096;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._~-]+$/;
const PAID_MARKERS = new Set(['gclid', 'gbraid', 'wbraid', 'paid_medium']);

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

function validIdentifier(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 200
    && IDENTIFIER_PATTERN.test(value);
}

function cleanClass(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 64);
  return cleaned || null;
}

export function normalizeCapturedAcquisition(value = {}) {
  const paidMarker = PAID_MARKERS.has(value.paidMarker) ? value.paidMarker : null;
  return {
    paidEvidence: Boolean(paidMarker),
    paidMarker,
    sourceClass: cleanClass(value.sourceClass),
    mediumClass: cleanClass(value.mediumClass),
    hasCampaign: Boolean(value.hasCampaign),
    hasLandingContext: Boolean(value.hasLandingContext),
    hasGclid: paidMarker === 'gclid',
    hasGbraid: paidMarker === 'gbraid',
    hasWbraid: paidMarker === 'wbraid',
  };
}

function applyCors(res, origin, allowedOrigin) {
  res.setHeader('Vary', 'Origin');
  if (origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }
  return false;
}

export function createBookingAttributionHandler({
  attributionStore,
  kvClient,
  allowedOrigin = DEFAULT_ALLOWED_ORIGIN,
  logger = defaultLogger(),
} = {}) {
  return async function handler(req, res) {
    const origin = req.headers?.origin || '';
    if (!applyCors(res, origin, allowedOrigin)) {
      logger.warn('booking_attribution_origin_rejected', {});
      return res.status(403).json({ captured: false, errorCode: 'ORIGIN_NOT_ALLOWED' });
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      return res.status(405).json({ captured: false, errorCode: 'METHOD_NOT_ALLOWED' });
    }

    const body = req.body || {};
    if (JSON.stringify(body).length > MAX_BODY_BYTES) {
      return res.status(413).json({ captured: false, errorCode: 'PAYLOAD_TOO_LARGE' });
    }
    const zenCustomerId = body.customer_id || body.customerId;
    const bookingSession = body.booking_session || body.bookingSession;
    if (!validIdentifier(zenCustomerId) || !validIdentifier(bookingSession)) {
      return res.status(400).json({ captured: false, errorCode: 'INVALID_BOOKING_REFERENCE' });
    }

    const acquisition = normalizeCapturedAcquisition(body.acquisition);
    if (!acquisition.paidEvidence) {
      return res.status(400).json({ captured: false, errorCode: 'PAID_EVIDENCE_REQUIRED' });
    }
    const bookingRef = opaqueRef(`${zenCustomerId}:${bookingSession}`).slice(0, 12);

    try {
      let activeStore = attributionStore;
      if (!activeStore) {
        const activeKV = kvClient === undefined ? await getDefaultKV() : kvClient;
        if (!activeKV) {
          return res.status(503).json({
            captured: false,
            retryable: true,
            errorCode: 'ATTRIBUTION_STORE_UNAVAILABLE',
          });
        }
        activeStore = createAttributionStore(activeKV);
      }
      await activeStore.saveBookingAttribution({
        zenCustomerId,
        bookingSession,
        acquisition,
      });
      logger.info('booking_attribution_captured', {
        bookingRef,
        paidMarker: acquisition.paidMarker,
      });
      return res.status(200).json({
        captured: true,
        bookingRef,
        paidMarker: acquisition.paidMarker,
      });
    } catch (error) {
      logger.error('booking_attribution_capture_failed', {
        bookingRef,
        errorType: error.name || 'Error',
      });
      return res.status(503).json({
        captured: false,
        retryable: true,
        errorCode: 'ATTRIBUTION_CAPTURE_FAILED',
      });
    }
  };
}

export default createBookingAttributionHandler();
