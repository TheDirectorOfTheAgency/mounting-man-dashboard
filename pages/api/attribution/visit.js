import { createAttributionStore } from '../../../lib/offline-conversion-store.js';
import { isEmptyTouch, sanitizeTouch } from '../../../lib/source-classifier.js';
import { bridgeWindowMs } from '../../../lib/attribution-bridge.js';
import { rematchVisit } from '../../../lib/job-source.js';

const DEFAULT_ORIGINS = [
  'https://www.themountingman.com',
  'https://themountingman.com',
  'https://themountingman.webflow.io',
  'https://www.themountingmanusa.com',
  'https://themountingmanusa.com',
];
const MAX_BODY_BYTES = 4096;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._~-]+$/;

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

function allowedOrigins(env = process.env) {
  const extra = String(env?.ATTRIBUTION_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

function validIdentifier(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 200
    && IDENTIFIER_PATTERN.test(value);
}

function applyCors(res, origin, origins) {
  res.setHeader('Vary', 'Origin');
  if (origins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }
  return false;
}

export function createVisitHandler({
  attributionStore,
  kvClient,
  origins = allowedOrigins(),
  logger = console,
} = {}) {
  return async function handler(req, res) {
    const origin = req.headers?.origin || '';
    if (!applyCors(res, origin, origins)) {
      return res.status(403).json({ captured: false });
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ captured: false });

    const body = req.body || {};
    if (JSON.stringify(body).length > MAX_BODY_BYTES) {
      return res.status(413).json({ captured: false });
    }
    const bookingSession = body.booking_session || body.bookingSession;
    if (!validIdentifier(bookingSession)) return res.status(400).json({ captured: false });
    const zenCustomerId = body.customer_id || body.customerId || null;
    if (zenCustomerId && !validIdentifier(zenCustomerId)) {
      return res.status(400).json({ captured: false });
    }

    // An empty touch (e.g. thank-you with no stored state) must not overwrite.
    const firstTouch = sanitizeTouch(body.first);
    const lastTouch = sanitizeTouch(body.last || body.first);
    const first = isEmptyTouch(firstTouch) ? null : firstTouch;
    const last = isEmptyTouch(lastTouch) ? null : lastTouch;

    try {
      let store = attributionStore;
      if (!store) {
        const activeKV = kvClient === undefined ? await getDefaultKV() : kvClient;
        if (!activeKV) return res.status(503).json({ captured: false });
        store = createAttributionStore(activeKV);
      }
      const saved = await store.saveSessionTouch({
        bookingSession,
        zenCustomerId,
        first,
        last,
      });
      if (zenCustomerId) {
        try {
          await rematchVisit({
            store,
            zenCustomerId,
            capturedAt: saved?.touch?.capturedAt,
            windowMs: bridgeWindowMs(),
          });
        } catch (error) {
          logger.error?.('visit_rematch_failed', { errorType: error?.name || 'Error' });
        }
      }
      return res.status(200).json({ captured: true });
    } catch (error) {
      logger.error?.('visit_capture_failed', { errorType: error?.name || 'Error' });
      return res.status(503).json({ captured: false });
    }
  };
}

export default createVisitHandler();
