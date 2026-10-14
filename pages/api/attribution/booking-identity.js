import { bookingRef, lookupBookingIdentity, originClass } from '../../../lib/booking-identity.js';
import { createAttributionStore } from '../../../lib/offline-conversion-store.js';
import { createDeferredIdentityStore } from '../../../lib/deferred-booking-identity.js';
import { bookingOrigins, originAllowed } from '../../../lib/attribution-origins.js';

// The browser stops waiting at PAGE_CONFIRM_MS (tmm-attribution-v1.js). A
// result that lands later cannot reach the tag, so it still gets deferred.
const CLIENT_USABLE_MS = 3700;

const MAX_BODY_BYTES = 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._~-]+$/;
// Post-deploy smoke tests send customer_id starting with this prefix. They get
// the normal 404 shape but never reach ZenBooker, KV, or the deferred fallback,
// and log as booking_identity_probe instead of an upstream error.
export const PROBE_ID_PREFIX = 'tmm-probe-';

export function isProbeRequest(customerId) {
  return typeof customerId === 'string' && customerId.startsWith(PROBE_ID_PREFIX);
}
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_MAX_KEYS = 5000;

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

function applyCors(res, origin, allowedOrigin) {
  res.setHeader('Vary', 'Origin');
  if (originAllowed(origin, allowedOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }
  return false;
}

function clientKey(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

// Best-effort per-instance limiter. It slows enumeration; it is not a hard cap.
export function createRateLimiter({
  windowMs = RATE_LIMIT_WINDOW_MS,
  max = RATE_LIMIT_MAX,
  now = () => Date.now(),
} = {}) {
  const hits = new Map();
  return function allow(key) {
    const current = now();
    if (hits.size > RATE_LIMIT_MAX_KEYS) {
      for (const [hitKey, times] of hits) {
        if (!times.some((time) => current - time < windowMs)) hits.delete(hitKey);
      }
    }
    const recent = (hits.get(key) || []).filter((time) => current - time < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(current);
    hits.set(key, recent);
    return true;
  };
}

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

export function createBookingIdentityHandler({
  allowedOrigin = bookingOrigins(),
  logger = defaultLogger(),
  lookup = lookupBookingIdentity,
  rateLimiter = createRateLimiter(),
  attributionStore,
  kvClient,
  deferredStore,
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers?.origin || '';
    if (!applyCors(res, origin, allowedOrigin)) {
      logger.warn('booking_identity_origin_rejected', { method: req.method, origin: originClass(origin) });
      return res.status(403).json({ found: false, errorCode: 'ORIGIN_NOT_ALLOWED' });
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      return res.status(405).json({ found: false, errorCode: 'METHOD_NOT_ALLOWED' });
    }
    if (!rateLimiter(clientKey(req))) {
      return res.status(429).json({ found: false, errorCode: 'RATE_LIMITED' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (JSON.stringify(body).length > MAX_BODY_BYTES) {
      return res.status(413).json({ found: false, errorCode: 'PAYLOAD_TOO_LARGE' });
    }
    const customerId = body.customer_id;
    const bookingSession = body.booking_session;
    if (!validIdentifier(customerId) || !validIdentifier(bookingSession)) {
      return res.status(400).json({ found: false, errorCode: 'INVALID_BOOKING_REFERENCE' });
    }

    const ref = bookingRef(customerId, bookingSession);
    if (isProbeRequest(customerId)) {
      logger.info('booking_identity_probe', { bookingRef: ref });
      return res.status(404).json({ found: false, errorCode: 'BOOKING_NOT_FOUND' });
    }
    const startedAt = Date.now();
    try {
      let store = attributionStore;
      let idStore = deferredStore;
      if (store === undefined || idStore === undefined) {
        const activeKV = kvClient === undefined ? await getDefaultKV() : kvClient;
        if (store === undefined) store = activeKV ? createAttributionStore(activeKV) : null;
        if (idStore === undefined) idStore = activeKV ? createDeferredIdentityStore(activeKV) : null;
      }
      // Resolve only through a session-to-job link; customer ID and recency are insufficient.
      const result = await lookup({ customerId, bookingSession, store });
      const durationMs = Date.now() - startedAt;
      const jobsSeen = typeof result.jobsSeen === 'number' ? result.jobsSeen : undefined;
      // Server-side fallback bookkeeping (never blocks or fails the response).
      let deferred;
      if (idStore) {
        try {
          if (result.found && durationMs <= CLIENT_USABLE_MS) {
            await idStore.markThankYouResolved(bookingSession);
          } else if (result.reason !== 'not_configured') {
            deferred = Boolean(await idStore.savePending({ customerId, bookingSession }));
          }
        } catch {
          deferred = false;
        }
      }
      if (!result.found) {
        logger.info('booking_identity_not_found', {
          deferred,
          bookingRef: ref,
          reason: result.reason,
          upstreamKind: result.upstreamKind,
          path: result.path,
          jobsSeen,
          durationMs,
        });
        return res.status(404).json({ found: false, errorCode: 'BOOKING_NOT_FOUND' });
      }
      logger.info('booking_identity_resolved', {
        bookingRef: ref,
        fields: Object.keys(result.userData),
        path: result.path,
        deferred,
        durationMs,
      });
      return res.status(200).json({ found: true, user_data: result.userData });
    } catch (error) {
      logger.error('booking_identity_lookup_failed', {
        bookingRef: ref,
        errorType: error?.name || 'Error',
      });
      return res.status(503).json({ found: false, errorCode: 'LOOKUP_FAILED' });
    }
  };
}

export default createBookingIdentityHandler();
