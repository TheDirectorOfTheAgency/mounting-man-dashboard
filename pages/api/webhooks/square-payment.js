// Receives Square payment webhooks, records completed payment facts for
// attribution, and preserves the existing post-payment review SMS workflow.

import axios from 'axios';
import crypto from 'node:crypto';
import { uploadOfflineConversion } from '../../../lib/google-ads-conversions.js';
import { opaqueRef } from '../../../lib/offline-conversion-eligibility.js';
import { createAttributionStore } from '../../../lib/offline-conversion-store.js';
import { createOfflineConversionCoordinator } from '../../../lib/offline-conversion-coordinator.js';

const SQUARE_BASE = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2026-06-18';
const REVIEW_LINK = 'https://g.page/r/CVhbFMF9evLaEBE/review';
const WEBHOOK_URL = 'https://mounting-man-dashboard.vercel.app/api/webhooks/square-payment';
const REVIEW_DEDUP_TTL = 24 * 60 * 60;

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

function cleanPhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/[^0-9+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('1') && digits.length === 11) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return digits.length >= 10 ? `+${digits}` : '';
}

export function verifySquareSignature(rawBody, signatureHeader, url, signatureKey) {
  if (!signatureKey || !signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', signatureKey)
    .update(`${url}${rawBody}`)
    .digest('base64');
  const left = Buffer.from(expected);
  const right = Buffer.from(signatureHeader);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function squareHeaders() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN || ''}`,
    'Square-Version': SQUARE_VERSION,
    'Content-Type': 'application/json',
  };
}

async function defaultSmsSender({ firstName, phone }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER || '+19526496388';
  if (!accountSid || !authToken) return false;
  const message = `Hey ${firstName || 'there'}! Marshall here from The Mounting Man. Hope you're loving the new setup! 🎬 If you have 30 seconds, a quick Google review would mean the world → ${REVIEW_LINK}`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    new URLSearchParams({ From: from, To: phone, Body: message }).toString(),
    { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return true;
}

async function defaultOperationsNotifier(message) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return;
  await axios.post(
    'https://discord.com/api/v10/channels/1472767806452924520/messages',
    { content: message },
    { headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' } }
  );
}

function defaultReviewDedup(kv) {
  return {
    async has(paymentId) {
      return Boolean(await kv.get(`square:review-sms:${opaqueRef(paymentId)}`));
    },
    async mark(paymentId) {
      await kv.set(
        `square:review-sms:${opaqueRef(paymentId)}`,
        { sentAt: new Date().toISOString() },
        { ex: REVIEW_DEDUP_TTL }
      );
      return true;
    },
  };
}

export function createSquarePaymentHandler({
  signatureKey,
  signatureVerifier = verifySquareSignature,
  webhookUrl = WEBHOOK_URL,
  attributionStore,
  coordinator,
  kvClient,
  httpClient = axios,
  smsSender = defaultSmsSender,
  reviewDedup,
  logger = defaultLogger(),
  operationsNotifier = defaultOperationsNotifier,
  mode,
} = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const activeSignatureKey = signatureKey ?? process.env.SQUARE_WEBHOOK_SIGNATURE_KEY ?? '';
    if (!activeSignatureKey) {
      logger.error('square_webhook_configuration_error', { errorCode: 'MISSING_SIGNATURE_KEY' });
      return res.status(500).json({ errorCode: 'SQUARE_WEBHOOK_NOT_CONFIGURED', retryable: true });
    }

    const rawBody = typeof req.rawBody === 'string'
      ? req.rawBody
      : Buffer.isBuffer(req.rawBody)
        ? req.rawBody.toString('utf8')
        : typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body || {});
    const signature = req.headers?.['x-square-hmacsha256-signature'];
    if (!signatureVerifier(rawBody, signature, webhookUrl, activeSignatureKey)) {
      logger.warn('square_webhook_signature_rejected', {});
      try {
        await operationsNotifier('Square webhook signature verification failed.');
      } catch (error) {
        logger.warn('square_webhook_signature_rejection_notify_failed', {
          errorCode: error?.code || error?.name || 'NOTIFY_FAILED',
        });
      }
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    } catch {
      return res.status(400).json({ errorCode: 'INVALID_JSON', retryable: false });
    }
    const eventType = body.type || body.event_type || null;
    if (!['payment.updated', 'payment.completed'].includes(eventType)) {
      logger.info('square_payment_event_ignored', { eventType });
      return res.status(200).json({ status: 'ignored', eventType });
    }

    const payment = body?.data?.object?.payment || body?.data?.object || {};
    const status = String(payment.status || (eventType === 'payment.completed' ? 'COMPLETED' : '')).toUpperCase();
    if (status !== 'COMPLETED') {
      logger.info('square_payment_status_ignored', { eventType, status });
      return res.status(200).json({ status: 'ignored', eventType });
    }

    const paymentId = payment.id || body?.data?.id || null;
    const squareCustomerId = payment.customer_id || null;
    const paymentRef = paymentId ? opaqueRef(paymentId).slice(0, 12) : null;
    if (!paymentId || !squareCustomerId) {
      logger.warn('square_payment_missing_relationship', {
        paymentRef,
        hasPaymentId: Boolean(paymentId),
        hasCustomerId: Boolean(squareCustomerId),
      });
      return res.status(200).json({ status: 'ignored', reason: 'MISSING_PAYMENT_RELATIONSHIP' });
    }

    try {
      let activeKV = kvClient;
      if ((!coordinator && !attributionStore) || !reviewDedup) {
        activeKV = activeKV === undefined ? await getDefaultKV() : activeKV;
      }
      if (!coordinator && !attributionStore && !activeKV) {
        return res.status(503).json({ errorCode: 'ATTRIBUTION_STORE_UNAVAILABLE', retryable: true });
      }
      const activeStore = attributionStore || (activeKV ? createAttributionStore(activeKV) : null);
      const activeCoordinator = coordinator || createOfflineConversionCoordinator({
        store: activeStore,
        uploadConversion: uploadOfflineConversion,
        mode: mode ?? process.env.OFFLINE_CONVERSION_MODE ?? 'observe',
      });
      const activeReviewDedup = reviewDedup || defaultReviewDedup(activeKV);

      const customerResponse = await httpClient.get(`${SQUARE_BASE}/customers/${squareCustomerId}`, {
        headers: squareHeaders(),
      });
      const squareCustomer = customerResponse.data?.customer || {};
      const customer = {
        email: squareCustomer.email_address || null,
        phone: cleanPhone(squareCustomer.phone_number),
        firstName: squareCustomer.given_name || null,
        lastName: squareCustomer.family_name || null,
      };

      const amount = Number(payment.amount_money?.amount ?? payment.total_money?.amount ?? 0);
      const refundedAmount = Number(payment.refunded_money?.amount ?? 0);
      const currency = payment.amount_money?.currency || payment.total_money?.currency || null;
      const completedAt = payment.updated_at || payment.created_at || null;
      const attributionResult = await activeCoordinator.registerPayment(
        {
          paymentId,
          squareCustomerId,
          status,
          currency,
          amount,
          refundedAmount,
          completedAt,
        },
        { customer }
      );

      let reviewSmsStatus = 'skipped_no_phone';
      if (customer.phone) {
        if (await activeReviewDedup.has(paymentId)) {
          reviewSmsStatus = 'duplicate';
        } else {
          const sent = await smsSender({
            paymentRef,
            firstName: customer.firstName || 'there',
            phone: customer.phone,
            amount: amount / 100,
          });
          reviewSmsStatus = sent ? 'sent' : 'failed';
          if (sent) await activeReviewDedup.mark(paymentId);
        }
      }

      logger.info('square_payment_processed', {
        paymentRef,
        attributionStatus: attributionResult.status,
        reviewSmsStatus,
        hasEmail: Boolean(customer.email),
        hasPhone: Boolean(customer.phone),
      });
      if (reviewSmsStatus === 'sent') {
        await operationsNotifier('A post-payment review SMS was sent.');
      }
      const retryable = attributionResult.status === 'upload_failed' && Boolean(attributionResult.retryable);
      return res.status(retryable ? 503 : 200).json({
        status: 'processed',
        attributionStatus: attributionResult.status,
        reviewSmsStatus,
        retryable,
      });
    } catch (error) {
      logger.error('square_payment_processing_failed', {
        paymentRef,
        errorType: error.name || 'Error',
        httpStatus: error.response?.status || null,
      });
      return res.status(503).json({
        status: 'failed',
        retryable: true,
        errorCode: 'SQUARE_PAYMENT_PROCESSING_FAILED',
      });
    }
  };
}

export default createSquarePaymentHandler();
