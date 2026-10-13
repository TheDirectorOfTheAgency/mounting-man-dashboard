// Server-side fallback for thank-you enhanced-conversion identity.
// Sweeps bookings whose thank-you lookup could not resolve in time and, once
// the ZenBooker job is linked to that booking session, sends hashed identifiers
// as an ENHANCEMENT of the Booked Appointment conversion (order id = booking
// session). See lib/deferred-booking-identity.js and
// docs/enhanced-conversions-thank-you.md.
//
// Auth: Authorization: Bearer $CRON_SECRET. ?validateOnly=1 validates with
// Google without uploading or changing KV.

import axios from 'axios';

import {
  createDeferredIdentityStore,
  createEnhancementUploader,
  sweepDeferredIdentities,
} from '../../../lib/deferred-booking-identity.js';
import { createAttributionStore } from '../../../lib/offline-conversion-store.js';
import { fetchZenbookerJob } from '../../../lib/zenbooker-assignment.js';

function authorized(req) {
  const secret = process.env.CRON_SECRET || '';
  return Boolean(secret) && req.headers?.authorization === `Bearer ${secret}`;
}

async function defaultKV() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  const { kv } = await import('@vercel/kv');
  return kv;
}

export function createDeferredIdentityCronHandler({
  loadKV = defaultKV,
  loadJob = (jobId) => fetchZenbookerJob(jobId, { httpClient: axios }),
  upload = createEnhancementUploader(),
  logger = console,
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const flag = String(req.query?.validateOnly || '').toLowerCase();
    const validateOnly = flag === '1' || flag === 'true';
    const kv = await loadKV();
    if (!kv) return res.status(500).json({ error: 'KV not configured' });
    try {
      const summary = await sweepDeferredIdentities({
        idStore: createDeferredIdentityStore(kv),
        attributionStore: createAttributionStore(kv),
        loadJob,
        upload,
        logger,
        validateOnly,
      });
      logger.info('booking_identity_deferred_sweep', { ...summary, validateOnly });
      return res.status(200).json({ ...summary, validateOnly });
    } catch (error) {
      logger.error('booking_identity_deferred_sweep_failed', { errorType: error?.name || 'Error' });
      return res.status(500).json({ error: 'Sweep failed' });
    }
  };
}

export default createDeferredIdentityCronHandler();
