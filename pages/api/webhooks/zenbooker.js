// Receives ZenBooker job.completed webhooks and coordinates paid-job
// attribution without trusting ZenBooker invoice estimates.

import crypto from 'node:crypto';
import { uploadOfflineConversion } from '../../../lib/google-ads-conversions.js';
import {
  evaluateJob,
  extractJobCandidate,
  opaqueRef,
} from '../../../lib/offline-conversion-eligibility.js';
import { createAttributionStore } from '../../../lib/offline-conversion-store.js';
import { createOfflineConversionCoordinator } from '../../../lib/offline-conversion-coordinator.js';

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

function eventType(req) {
  return req.headers?.event
    || req.headers?.['x-zenbooker-event']
    || req.body?.event
    || req.body?.type
    || null;
}

export function createZenbookerWebhookHandler({
  attributionStore,
  coordinator,
  kvClient,
  uploadConversion = uploadOfflineConversion,
  mode,
  disclosureVersion,
  logger = defaultLogger(),
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const expectedSecret = process.env.ZENBOOKER_WEBHOOK_SECRET;
    if (!expectedSecret) {
      logger.error('offline_conversion_configuration_error', { errorCode: 'MISSING_WEBHOOK_SECRET' });
      return res.status(500).json({ errorCode: 'WEBHOOK_NOT_CONFIGURED', retryable: true });
    }
    const suppliedSecret = req.query?.secret || req.headers?.['x-webhook-secret'];
    if (!secretsMatch(expectedSecret, suppliedSecret)) {
      logger.warn('offline_conversion_auth_failed', {});
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const receivedEvent = eventType(req);
    if (receivedEvent && receivedEvent !== 'job.completed') {
      logger.info('offline_conversion_event_skipped', { eventType: receivedEvent });
      return res.status(200).json({ skipped: true, reason: 'UNSUPPORTED_EVENT' });
    }

    const activeDisclosure = disclosureVersion ?? process.env.PRIVACY_DISCLOSURE_VERSION ?? null;
    let candidate = extractJobCandidate(req.body, { disclosureVersion: activeDisclosure });
    const jobRef = candidate.jobId ? opaqueRef(candidate.jobId).slice(0, 12) : null;
    const eligibility = evaluateJob(candidate);
    if (!eligibility.eligible) {
      logger.warn('offline_conversion_candidate_rejected', { jobRef, reason: eligibility.reason });
      return res.status(200).json({
        processed: false,
        retryable: false,
        reason: eligibility.reason,
      });
    }

    try {
      let activeStore = attributionStore;
      if (!activeStore) {
        const activeKV = kvClient === undefined ? await getDefaultKV() : kvClient;
        if (!activeKV) {
          logger.error('offline_conversion_store_unavailable', { jobRef });
          return res.status(503).json({
            processed: false,
            retryable: true,
            errorCode: 'ATTRIBUTION_STORE_UNAVAILABLE',
          });
        }
        activeStore = createAttributionStore(activeKV);
      }

      if (!candidate.acquisition?.paidEvidence && typeof activeStore.getBookingAttribution === 'function') {
        const bookingAttribution = await activeStore.getBookingAttribution({
          zenCustomerId: candidate.zenCustomerId,
          bookingSession: candidate.bookingSession,
        });
        if (bookingAttribution?.acquisition) {
          candidate = { ...candidate, acquisition: bookingAttribution.acquisition };
        }
      }
      if (!candidate.acquisition?.paidEvidence) {
        logger.info('offline_conversion_candidate_skipped', {
          jobRef,
          reason: 'NO_PAID_ACQUISITION',
        });
        return res.status(200).json({
          processed: false,
          retryable: false,
          reason: 'NO_PAID_ACQUISITION',
        });
      }

      const mapping = await activeStore.getJobMapping(candidate.jobId);
      if (!mapping?.squareCustomerId) {
        logger.info('offline_conversion_mapping_pending', { jobRef });
        return res.status(200).json({
          processed: true,
          status: 'pending_mapping',
          retryable: false,
          jobRef,
        });
      }

      const activeMode = mode ?? process.env.OFFLINE_CONVERSION_MODE ?? 'observe';
      const activeCoordinator = coordinator || createOfflineConversionCoordinator({
        store: activeStore,
        uploadConversion,
        mode: activeMode,
      });
      const result = await activeCoordinator.registerJob({
        ...candidate,
        squareCustomerId: mapping.squareCustomerId,
      });
      logger.info('offline_conversion_candidate_processed', {
        jobRef,
        mode: activeMode,
        status: result.status,
        paidEvidence: Boolean(candidate.acquisition?.paidEvidence),
      });

      const retryable = Boolean(result.retryable);
      return res.status(retryable ? 503 : 200).json({
        processed: true,
        status: result.status,
        retryable,
        jobRef,
        paidEvidence: Boolean(candidate.acquisition?.paidEvidence),
        errorCode: result.errorCode || null,
      });
    } catch (error) {
      logger.error('offline_conversion_processing_failed', {
        jobRef,
        errorType: error.name || 'Error',
      });
      return res.status(503).json({
        processed: false,
        retryable: true,
        errorCode: 'ATTRIBUTION_PROCESSING_FAILED',
      });
    }
  };
}

export default createZenbookerWebhookHandler();
