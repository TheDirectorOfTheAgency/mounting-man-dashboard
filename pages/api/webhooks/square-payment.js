// pages/api/webhooks/square-payment.js
// Receives Square payment webhooks → sends review SMS via Twilio
//
// Flow:
//   1. Square POSTs payment webhook here (public Vercel URL)
//   2. Extract payment data + customer_id
//   3. Fetch customer details from Square API (phone, name)
//   4. After 24h install-post dedup, wake Kronkite with a sanitized payload
//      and stage the phone-first Upstash queue (no Discord install-thread)
//   5. If customer has phone → send review SMS via Twilio
//   6. Log SMS/errors to Discord #operations (not the Installation Posts thread)
//
// Webhook URL:
//   https://mounting-man-dashboard.vercel.app/api/webhooks/square-payment
//
// Square webhook signature validation:
//   Square signs webhooks with HMAC-SHA256. We validate if signature_key is set.
//   For initial setup, we also accept unverified webhooks and log a warning.
//
// Replaces: n8n "Square Payment → SMS Review Request" workflow (k9kdv6Do76vl6KLi)
// Why: n8n runs on M1 behind Tailscale — Square can't reach it from the internet.
//       Vercel is always public, always up, zero M1 dependency.

import axios from 'axios';
import crypto from 'crypto';
import { uploadOfflineConversion } from '../../../lib/google-ads-conversions.js';
import { createAttributionStore } from '../../../lib/offline-conversion-store.js';
import { createOfflineConversionCoordinator } from '../../../lib/offline-conversion-coordinator.js';
import { notifyQInstallPost } from '../../../lib/notify-install-post.mjs';

export { notifyQInstallPost } from '../../../lib/notify-install-post.mjs';

// ============================================================================
// CONFIG
// ============================================================================
const SQUARE_BASE    = 'https://connect.squareup.com/v2';
const SQUARE_VER     = '2024-01-18';
const SQUARE_TOKEN   = process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;

// Twilio — stored in Vercel env vars (set during deploy)
const TWILIO_SID     = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM    = process.env.TWILIO_FROM_NUMBER || '+19526496388';

// Google Review link
const REVIEW_LINK    = 'https://g.page/r/CVhbFMF9evLaEBE/review';

// Discord logging
const DISCORD_BOT_TOKEN =
  process.env.DISCORD_Q_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
const DISCORD_OPS_CHANNEL = '1472767806452924520'; // #operations — SMS/errors only

// Upstash Redis — for follow-up claim only
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Square webhook signature key (optional — set after creating subscription)
const SQUARE_WEBHOOK_SIG_KEY = (process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '').trim();

// Dedup — prevent processing the same payment twice
const DEDUP_TTL = 86400; // 24 hours

let cachedAttributionStore;

async function getDefaultAttributionStore() {
  if (cachedAttributionStore !== undefined) return cachedAttributionStore;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    cachedAttributionStore = null;
    return cachedAttributionStore;
  }
  const { kv } = await import('@vercel/kv');
  cachedAttributionStore = createAttributionStore(kv);
  return cachedAttributionStore;
}

// ============================================================================
// HELPERS
// ============================================================================

const squareHeaders = () => ({
  Authorization:    `Bearer ${SQUARE_TOKEN}`,
  'Square-Version': SQUARE_VER,
  'Content-Type':   'application/json',
});

/** Post a message to Discord #operations */
async function logDiscord(message) {
  if (!DISCORD_BOT_TOKEN) {
    console.log('[discord-skip]', message);
    return;
  }
  try {
    await axios.post(
      `https://discord.com/api/v10/channels/${DISCORD_OPS_CHANNEL}/messages`,
      { content: message },
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[discord-error]', err.response?.data || err.message);
  }
}

/** Atomically claim one customer follow-up for a Square event. */
async function kvClaimFollowUp(key, value, ttl) {
  if (!KV_URL || !KV_TOKEN) return 'unavailable';
  const encodedValue = encodeURIComponent(JSON.stringify(value));
  try {
    const res = await axios.get(
      `${KV_URL}/set/${encodeURIComponent(key)}/${encodedValue}/NX/EX/${ttl}`,
      { headers: { Authorization: `Bearer ${KV_TOKEN}` } },
    );
    return res.data?.result === 'OK' ? 'claimed' : 'duplicate';
  } catch (err) {
    console.error('[kv-claim-error]', err.response?.data || err.message);
    return 'unavailable';
  }
}

/** Clean a phone number to E.164 format (+1XXXXXXXXXX) */
function cleanPhone(raw) {
  if (!raw) return '';
  let digits = raw.replace(/[^0-9+]/g, '');
  if (digits.startsWith('+')) return digits; // Already E.164
  if (digits.startsWith('1') && digits.length === 11) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  return digits.length >= 10 ? '+' + digits : '';
}

function sumInvoiceCompletedAmount(invoice) {
  const requests = Array.isArray(invoice?.payment_requests) ? invoice.payment_requests : [];
  const total = requests.reduce((sum, request) => {
    return sum + Number(
      request?.total_completed_amount_money?.amount
      ?? request?.computed_amount_money?.amount
      ?? 0
    );
  }, 0);
  return total;
}

async function registerPaymentAttribution({
  attributionCoordinator,
  payment,
  customer,
  mode,
  webhookSignatureKeyConfigured,
  webhookSignatureVerified,
  storeLoader = getDefaultAttributionStore,
  coordinatorFactory = createOfflineConversionCoordinator,
  attributionUploader = uploadOfflineConversion,
}) {
  if (!payment?.id || !payment?.customer_id) {
    return { status: 'not_applicable' };
  }

  let coordinator = attributionCoordinator;
  if (!coordinator) {
    const store = await storeLoader();
    if (!store) return { status: 'store_unavailable' };
    coordinator = coordinatorFactory({
      store,
      uploadConversion: attributionUploader,
      mode: webhookSignatureVerified
        ? mode ?? process.env.OFFLINE_CONVERSION_MODE ?? 'observe'
        : 'observe',
    });
  }

  return coordinator.registerPayment(
    {
      paymentId: payment.id,
      squareCustomerId: payment.customer_id,
      status: payment.status || 'COMPLETED',
      currency: payment.amount_money?.currency || payment.total_money?.currency || null,
      amount: Number(payment.amount_money?.amount ?? payment.total_money?.amount ?? 0),
      refundedAmount: Number(payment.refunded_money?.amount ?? 0),
      completedAt: payment.updated_at || payment.created_at || null,
      webhookSignatureKeyConfigured: Boolean(webhookSignatureKeyConfigured),
      webhookSignatureVerified: Boolean(webhookSignatureVerified),
    },
    {
      customer: {
        email: customer.email_address || null,
        phone: cleanPhone(customer.phone_number || ''),
        firstName: customer.given_name || null,
        lastName: customer.family_name || null,
      },
    },
  );
}

/** Validate Square webhook signature (HMAC-SHA256) */
function verifySquareSignature(body, signatureHeader, url, signatureKey = SQUARE_WEBHOOK_SIG_KEY) {
  if (!signatureKey) return true; // Preserve origin/main behavior when not configured
  if (!signatureHeader) return false;

  const hmac = crypto.createHmac('sha256', signatureKey);
  hmac.update(url + body);
  const expected = hmac.digest('base64');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/** Read raw request body as a string (required for HMAC validation) */
function getRawBody(req, limit = 1048576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ============================================================================
// HANDLER
// ============================================================================

export function createSquarePaymentHandler({
  readRawBody = getRawBody,
  signatureKey = SQUARE_WEBHOOK_SIG_KEY,
  signatureVerifier = verifySquareSignature,
  httpClient = axios,
  operationsNotifier = logDiscord,
  installPostNotifier = notifyQInstallPost,
  reviewSmsSender = sendReviewSms,
  attributionCoordinator,
  attributionMode,
  attributionStoreLoader = getDefaultAttributionStore,
  attributionCoordinatorFactory = createOfflineConversionCoordinator,
  attributionUploader = uploadOfflineConversion,
  followUpClaim = kvClaimFollowUp,
  logger = console,
} = {}) {
  return async function handler(req, res) {
    // Only accept POST
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const startTime = Date.now();

    try {
      // ---- Parse body (raw bytes required for HMAC signature verification) ----
      const rawBody = await readRawBody(req);
      const body = JSON.parse(rawBody);

      console.log('[square-webhook] Webhook received');

      // ---- Signature validation ----
      const sig = req.headers['x-square-hmacsha256-signature'];
      const webhookUrl = `https://mounting-man-dashboard.vercel.app/api/webhooks/square-payment`;

      let webhookSignatureVerified = false;
      if (signatureKey) {
        if (!signatureVerifier(rawBody, sig, webhookUrl, signatureKey)) {
          console.error('[square-webhook] Signature verification FAILED');
          try {
            await operationsNotifier('🚨 **Square webhook signature verification failed** — possible spoofing attempt');
          } catch (notifyError) {
            logger.warn('square_webhook_signature_rejection_notify_failed', {
              errorType: notifyError?.name || 'Error',
            });
          }
          return res.status(401).json({ error: 'Invalid signature' });
        }
        webhookSignatureVerified = true;
      }

      if (!signatureKey && sig) {
        console.warn('[square-webhook] Signature present but no key configured — skipping validation');
      }

    // ---- Extract event type ----
    const eventType = body?.type || body?.event_type || '';
    console.log('[square-webhook] Event type:', eventType);

    // Square's current webhook model emits payment.created when a payment is
    // first recorded and payment.updated when status changes. Some POS/cash
    // flows can arrive already completed at creation time, so accept
    // payment.created as long as the payment status is COMPLETED.
    // Accept legacy payment.completed if an older subscription is still in place.
    // Invoice payments can also arrive through invoice.payment_made.
    const supportedEvent =
      eventType === 'payment.created' ||
      eventType === 'payment.updated' ||
      eventType === 'payment.completed' ||
      eventType === 'invoice.payment_made';
    if (!supportedEvent) {
      console.log(`[square-webhook] Ignoring event type: ${eventType}`);
      return res.status(200).json({ status: 'ignored', event: eventType });
    }

    // ---- Extract payment/invoice data ----
    const payment = body?.data?.object?.payment || body?.data?.object || {};
    const invoice = body?.data?.object?.invoice || body?.data?.object || {};
    const isInvoiceEvent = eventType === 'invoice.payment_made';
    const paymentId = isInvoiceEvent ? '' : (payment.id || body?.data?.id || 'unknown');
    const invoiceId = isInvoiceEvent ? (invoice.id || body?.data?.id || 'unknown') : '';
    const customerId = isInvoiceEvent
      ? (invoice?.primary_recipient?.customer_id || '')
      : (payment.customer_id || '');
    const orderId = isInvoiceEvent ? (invoice.order_id || '') : (payment.order_id || '');
    const paymentStatus = isInvoiceEvent ? 'COMPLETED' : (payment.status || '');
    const amountCents = isInvoiceEvent
      ? sumInvoiceCompletedAmount(invoice)
      : (payment.amount_money?.amount || payment.total_money?.amount || 0);
    const amount = (amountCents / 100).toFixed(2);

    if (!isInvoiceEvent && paymentStatus && paymentStatus !== 'COMPLETED') {
      console.log(`[square-webhook] Ignoring payment ${paymentId} with status ${paymentStatus}`);
      return res.status(200).json({ status: 'ignored', event: eventType, paymentStatus, paymentId });
    }

    console.log(
      `[square-webhook] ${isInvoiceEvent ? 'Invoice' : 'Payment'} ${isInvoiceEvent ? invoiceId : paymentId}: customer=${customerId}, order=${orderId || 'N/A'}, amount=$${amount}, status=${paymentStatus || 'unknown'}`
    );

    const dedupKey = isInvoiceEvent ? `square:invoice:${invoiceId}` : `square:payment:${paymentId}`;

    // ---- No customer ID? Log and bail ----
    if (!customerId) {
      console.warn(`[square-webhook] ${isInvoiceEvent ? 'Invoice' : 'Payment'} ${isInvoiceEvent ? invoiceId : paymentId} has no customer_id`);
      await operationsNotifier(`⚠️ **Square ${isInvoiceEvent ? 'invoice payment' : 'payment'}** $${amount} (${isInvoiceEvent ? invoiceId : paymentId}) — no customer ID attached, skipped downstream follow-up`);
      return res.status(200).json({ status: 'no_customer', paymentId, invoiceId });
    }

    // ---- Fetch customer from Square ----
    let customer = {};
    try {
      const custRes = await httpClient.get(`${SQUARE_BASE}/customers/${customerId}`, {
        headers: squareHeaders(),
      });
      customer = custRes.data?.customer || {};
    } catch (err) {
      const status = err.response?.status;
      console.error(`[square-webhook] Failed to fetch customer ${customerId}: ${status}`, err.response?.data || err.message);
      await operationsNotifier(`⚠️ **Square ${isInvoiceEvent ? 'invoice payment' : 'payment'}** $${amount} — failed to fetch customer ${customerId} (HTTP ${status})`);
      return res.status(200).json({ status: 'customer_fetch_failed', paymentId, invoiceId, customerId });
    }

    // ---- Extract customer details ----
    const firstName = customer.given_name || 'there';
    const lastName = customer.family_name || '';
    const email = customer.email_address || '';
    const phone = cleanPhone(customer.phone_number || '');
    const hasPhone = phone.length >= 12; // +1XXXXXXXXXX = 12 chars

    console.log(`[square-webhook] Customer loaded: phone=${hasPhone ? 'present' : 'missing'}, email=${email ? 'present' : 'missing'}`);

    let attributionStatus = isInvoiceEvent ? 'not_applicable' : 'not_attempted';
    let attributionRetryable = false;
    let attributionErrorCode = null;
    if (!isInvoiceEvent) {
      try {
        const attributionResult = await registerPaymentAttribution({
          attributionCoordinator,
          payment,
          customer,
          mode: attributionMode,
          webhookSignatureKeyConfigured: Boolean(signatureKey),
          webhookSignatureVerified,
          storeLoader: attributionStoreLoader,
          coordinatorFactory: attributionCoordinatorFactory,
          attributionUploader,
        });
        attributionStatus = attributionResult.status;
        attributionRetryable = Boolean(attributionResult.retryable);
        attributionErrorCode = attributionResult.errorCode || null;
      } catch (attributionError) {
        attributionStatus = 'failed';
        attributionRetryable = true;
        attributionErrorCode = 'ATTRIBUTION_PROCESSING_FAILED';
        console.error('[square-webhook] Attribution registration failed:', attributionError.message);
      }
    }

    let followUpClaimStatus = 'unavailable';
    try {
      followUpClaimStatus = await followUpClaim(
        dedupKey,
        { processed: new Date().toISOString() },
        DEDUP_TTL,
      );
    } catch (claimError) {
      logger.warn('square_follow_up_claim_failed', {
        errorType: claimError?.name || 'Error',
      });
    }
    if (!['claimed', 'duplicate'].includes(followUpClaimStatus)) {
      followUpClaimStatus = 'unavailable';
    }
    if (followUpClaimStatus === 'unavailable') {
      return res.status(503).json({
        status: 'follow_up_claim_unavailable',
        paymentId,
        invoiceId,
        attributionStatus,
        retryable: true,
        errorCode: attributionErrorCode || 'FOLLOW_UP_CLAIM_UNAVAILABLE',
      });
    }
    const duplicateFollowUp = followUpClaimStatus === 'duplicate';
    if (duplicateFollowUp) {
      console.log(
        `[square-webhook] Duplicate ${isInvoiceEvent ? 'invoice' : 'payment'} event `
        + `${isInvoiceEvent ? invoiceId : paymentId} — follow-up skipped`
      );
      return res.status(attributionRetryable ? 503 : 200).json({
        status: 'duplicate',
        paymentId,
        invoiceId,
        attributionStatus,
        retryable: attributionRetryable,
        errorCode: attributionErrorCode,
      });
    }

    // ---- Stage install-post desk (Kronkite wake + phone queue; no Discord) ----
    try {
      await installPostNotifier({
        orderId,
        payment,
        invoice,
        isInvoiceEvent,
        eventType,
        firstName,
        lastName,
        customer,
        amount,
        amountCents,
      });
    } catch (installPostError) {
      logger.warn('square_install_post_notify_failed', {
        errorType: installPostError?.name || 'Error',
      });
    }

    // ---- No phone? Log and bail on SMS only ----
    if (!hasPhone) {
      await operationsNotifier(`⚠️ **No phone number** for customer ${firstName} ${lastName} (ID: ${customerId}) — skipped review SMS. Email: ${email || 'N/A'} | Job total: $${amount}`);
      logger.info('square_payment_processed', {
        attributionStatus,
        reviewSmsStatus: 'skipped_no_phone',
      });
      return res.status(attributionRetryable ? 503 : 200).json({
        status: 'no_phone',
        paymentId,
        invoiceId,
        customerId,
        firstName,
        lastName,
        attributionStatus,
        retryable: attributionRetryable,
        errorCode: attributionErrorCode,
      });
    }

    if (isInvoiceEvent) {
      const elapsed = Date.now() - startTime;
      console.log(`[square-webhook] Invoice path done in ${elapsed}ms`);
      return res.status(200).json({
        status: 'invoice_processed',
        invoiceId,
        customerId,
        firstName,
        lastName,
        amount,
        attributionStatus,
        elapsed,
      });
    }

    // ---- Send review SMS directly ----
    // Natural webhook processing latency (~2-5s) provides enough delay.
    // Original n8n workflow had a 60s wait, but that was just to avoid
    // texting while the tech is still at the door. The API call chain
    // (Square webhook → Vercel → Square customer fetch → Twilio) adds
    // enough time that the customer has already left.
    const smsSent = await reviewSmsSender({ paymentId, firstName, phone, amount });

    if (smsSent) {
      await operationsNotifier(`📱 **Review SMS sent** to ${firstName} ${lastName} (${phone}) — $${amount} payment`);
    }

    logger.info('square_payment_processed', {
      attributionStatus,
      reviewSmsStatus: smsSent ? 'sent' : 'failed',
    });

    const elapsed = Date.now() - startTime;
    console.log(`[square-webhook] Done in ${elapsed}ms`);

    return res.status(attributionRetryable ? 503 : 200).json({
      status: smsSent ? 'sms_sent' : 'sms_failed',
      paymentId,
      customerId,
      firstName,
      lastName,
      phone,
      amount,
      attributionStatus,
      retryable: attributionRetryable,
      errorCode: attributionErrorCode,
      elapsed,
    });

  } catch (err) {
    console.error('[square-webhook] Unhandled error:', err);
    await operationsNotifier(`🚨 **Square webhook error**: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

export default createSquarePaymentHandler();

// ============================================================================
// SMS SENDER
// ============================================================================

async function sendReviewSms(job) {
  const { firstName, phone, amount, paymentId } = job;

  if (!TWILIO_SID || !TWILIO_TOKEN) {
    console.error('[twilio-skip] Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
    await logDiscord(`⚠️ **Twilio not configured** — couldn't send review SMS to ${firstName} (${phone})`);
    return false;
  }

  const message = `Hey ${firstName}! Marshall here from The Mounting Man. Hope you're loving the new setup! 🎬 If you have 30 seconds, a quick Google review would mean the world → ${REVIEW_LINK}`;

  try {
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');

    await axios.post(
      twilioUrl,
      new URLSearchParams({
        From: TWILIO_FROM,
        To: phone,
        Body: message,
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    console.log(`[twilio] SMS sent to ${phone} for payment ${paymentId}`);
    return true;
  } catch (err) {
    console.error('[twilio-error]', err.response?.data || err.message);
    await logDiscord(`🚨 **Twilio SMS failed** for ${firstName} (${phone}): ${err.response?.data?.message || err.message}`);
    return false;
  }
}

// Disable Next.js body parser — required to read raw bytes for Square HMAC signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};
