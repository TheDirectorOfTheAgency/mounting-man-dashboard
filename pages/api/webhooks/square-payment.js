// pages/api/webhooks/square-payment.js
// Receives Square payment.completed webhooks → sends review SMS via Twilio
//
// Flow:
//   1. Square POSTs payment webhook here (public Vercel URL)
//   2. Extract payment data + customer_id
//   3. Fetch customer details from Square API (phone, name)
//   4. If customer has phone → send review SMS via Twilio
//   5. Log everything to Discord #operations
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
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_OPS_CHANNEL = '1472767806452924520'; // #operations
const DISCORD_INSTALL_THREAD = '1485380804707090643'; // Installation Posts thread in Q's #general

// Upstash Redis — for dedup only
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Square webhook signature key (optional — set after creating subscription)
const SQUARE_WEBHOOK_SIG_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';

// Dedup — prevent processing the same payment twice
const DEDUP_TTL = 86400; // 24 hours

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

/** Store a value in Upstash Redis with optional TTL */
async function kvSet(key, value, ttl) {
  if (!KV_URL || !KV_TOKEN) {
    console.warn('[kv-skip] No KV_URL/KV_TOKEN configured');
    return false;
  }
  const cmd = ttl ? `set/${key}/${encodeURIComponent(JSON.stringify(value))}/EX/${ttl}` : `set/${key}/${encodeURIComponent(JSON.stringify(value))}`;
  try {
    await axios.get(`${KV_URL}/${cmd}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    return true;
  } catch (err) {
    console.error('[kv-error]', err.response?.data || err.message);
    return false;
  }
}

/** Check if a key exists in Upstash Redis */
async function kvExists(key) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const res = await axios.get(`${KV_URL}/exists/${key}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    return res.data?.result === 1;
  } catch {
    return false;
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

/** Validate Square webhook signature (HMAC-SHA256) */
function verifySquareSignature(body, signatureHeader, url) {
  if (!SQUARE_WEBHOOK_SIG_KEY) return true; // Skip if not configured
  if (!signatureHeader) return false;

  const hmac = crypto.createHmac('sha256', SQUARE_WEBHOOK_SIG_KEY);
  hmac.update(url + body);
  const expected = hmac.digest('base64');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}

// ============================================================================
// HANDLER
// ============================================================================

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();

  try {
    // ---- Parse body ----
    const body = req.body;
    const rawBody = JSON.stringify(body);

    console.log('[square-webhook] Received:', rawBody.substring(0, 500));

    // ---- Signature validation ----
    const sig = req.headers['x-square-hmacsha256-signature'];
    const webhookUrl = `https://mounting-man-dashboard.vercel.app/api/webhooks/square-payment`;

    if (SQUARE_WEBHOOK_SIG_KEY && !verifySquareSignature(rawBody, sig, webhookUrl)) {
      console.error('[square-webhook] Signature verification FAILED');
      await logDiscord('🚨 **Square webhook signature verification failed** — possible spoofing attempt');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    if (!SQUARE_WEBHOOK_SIG_KEY && sig) {
      console.warn('[square-webhook] Signature present but no key configured — skipping validation');
    }

    // ---- Extract event type ----
    const eventType = body?.type || body?.event_type || '';
    console.log('[square-webhook] Event type:', eventType);

    // We only care about payment.completed events
    if (eventType !== 'payment.completed') {
      console.log(`[square-webhook] Ignoring event type: ${eventType}`);
      return res.status(200).json({ status: 'ignored', event: eventType });
    }

    // ---- Extract payment data ----
    const payment = body?.data?.object?.payment || body?.data?.object || {};
    const paymentId = payment.id || body?.data?.id || 'unknown';
    const customerId = payment.customer_id || '';
    const orderId = payment.order_id || '';
    const amountCents = payment.amount_money?.amount || payment.total_money?.amount || 0;
    const amount = (amountCents / 100).toFixed(2);

    console.log(`[square-webhook] Payment ${paymentId}: customer=${customerId}, amount=$${amount}`);

    // ---- Dedup check ----
    const dedupKey = `square:payment:${paymentId}`;
    if (await kvExists(dedupKey)) {
      console.log(`[square-webhook] Duplicate payment ${paymentId} — skipping`);
      return res.status(200).json({ status: 'duplicate', paymentId });
    }
    await kvSet(dedupKey, { processed: new Date().toISOString() }, DEDUP_TTL);

    // ---- No customer ID? Log and bail ----
    if (!customerId) {
      console.warn(`[square-webhook] Payment ${paymentId} has no customer_id`);
      await logDiscord(`⚠️ **Square payment** $${amount} (${paymentId}) — no customer ID attached, skipped review SMS`);
      return res.status(200).json({ status: 'no_customer', paymentId });
    }

    // ---- Fetch customer from Square ----
    let customer = {};
    try {
      const custRes = await axios.get(`${SQUARE_BASE}/customers/${customerId}`, {
        headers: squareHeaders(),
      });
      customer = custRes.data?.customer || {};
    } catch (err) {
      const status = err.response?.status;
      console.error(`[square-webhook] Failed to fetch customer ${customerId}: ${status}`, err.response?.data || err.message);
      await logDiscord(`⚠️ **Square payment** $${amount} — failed to fetch customer ${customerId} (HTTP ${status})`);
      return res.status(200).json({ status: 'customer_fetch_failed', paymentId, customerId });
    }

    // ---- Extract customer details ----
    const firstName = customer.given_name || 'there';
    const lastName = customer.family_name || '';
    const email = customer.email_address || '';
    const phone = cleanPhone(customer.phone_number || '');
    const hasPhone = phone.length >= 12; // +1XXXXXXXXXX = 12 chars

    console.log(`[square-webhook] Customer: ${firstName} ${lastName}, phone=${phone || 'N/A'}, email=${email || 'N/A'}`);

    // ---- No phone? Log and bail ----
    if (!hasPhone) {
      await logDiscord(`⚠️ **No phone number** for customer ${firstName} ${lastName} (ID: ${customerId}) — skipped review SMS. Email: ${email || 'N/A'} | Job total: $${amount}`);
      return res.status(200).json({ status: 'no_phone', paymentId, customerId, firstName, lastName });
    }

    // ---- Send review SMS directly ----
    // Natural webhook processing latency (~2-5s) provides enough delay.
    // Original n8n workflow had a 60s wait, but that was just to avoid
    // texting while the tech is still at the door. The API call chain
    // (Square webhook → Vercel → Square customer fetch → Twilio) adds
    // enough time that the customer has already left.
    const smsSent = await sendReviewSms({ paymentId, firstName, phone, amount });

    if (smsSent) {
      await logDiscord(`📱 **Review SMS sent** to ${firstName} ${lastName} (${phone}) — $${amount} payment`);
    }

    // ---- Notify Q in Installation Posts thread ----
    if (orderId) {
      await notifyQInstallPost({ orderId, firstName, lastName, customer, amount });
    }

    const elapsed = Date.now() - startTime;
    console.log(`[square-webhook] Done in ${elapsed}ms`);

    return res.status(200).json({
      status: smsSent ? 'sms_sent' : 'sms_failed',
      paymentId,
      customerId,
      firstName,
      lastName,
      phone,
      amount,
      elapsed,
    });

  } catch (err) {
    console.error('[square-webhook] Unhandled error:', err);
    await logDiscord(`🚨 **Square webhook error**: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================================
// SMS SENDER
// ============================================================================

// ============================================================================
// Q INSTALL POST NOTIFICATION
// ============================================================================

async function notifyQInstallPost({ orderId, firstName, lastName, customer, amount }) {
  if (!DISCORD_BOT_TOKEN) {
    console.warn('[q-notify] No DISCORD_BOT_TOKEN — skipping Q notification');
    return;
  }

  // ---- Fetch order line items from Square ----
  let lineItems = [];
  try {
    const orderRes = await axios.get(`${SQUARE_BASE}/orders/${orderId}`, {
      headers: squareHeaders(),
    });
    lineItems = orderRes.data?.order?.line_items || [];
  } catch (err) {
    console.error('[q-notify] Failed to fetch order:', err.response?.data || err.message);
    // Continue without line items — still useful to notify Q
  }

  // ---- Parse job details from line items ----
  // Square line items: name = service type, variation_name = TV size or mount type
  const jobParts = lineItems
    .filter(item => item.name && item.name !== 'Sales Tax' && item.name !== 'CC Processing Fee')
    .map(item => {
      const parts = [item.variation_name, item.name].filter(Boolean);
      return parts.join(' — ');
    });
  const jobSummary = jobParts.length > 0 ? jobParts.join('\n') : '(job details unavailable)';

  // ---- Build address from customer ----
  const addr = customer.address || {};
  const addressParts = [
    addr.address_line_1,
    addr.address_line_2,
    addr.locality && addr.administrative_district_level_1
      ? `${addr.locality}, ${addr.administrative_district_level_1}`
      : addr.locality || addr.administrative_district_level_1,
    addr.postal_code,
  ].filter(Boolean);
  const addressLine = addressParts.length > 0 ? addressParts.join(', ') : '(address not on file)';

  // ---- Build message ----
  const fullName = [firstName, lastName].filter(s => s && s !== 'there').join(' ') || firstName;
  const message = [
    `📸 **New job paid — ready for installation post**`,
    `**Client**: ${fullName}`,
    `**Address**: ${addressLine}`,
    `**Job**:\n${jobParts.length > 0 ? jobParts.map(p => `  • ${p}`).join('\n') : '  • ' + jobSummary}`,
    `**Amount**: $${amount}`,
    ``,
    `Drop the job photo and I'll have the post ready to publish.`,
  ].join('\n');

  // ---- Post to Installation Posts thread ----
  try {
    await axios.post(
      `https://discord.com/api/v10/channels/${DISCORD_INSTALL_THREAD}/messages`,
      { content: message },
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[q-notify] Posted to Installation Posts thread for ${fullName}`);
  } catch (err) {
    console.error('[q-notify] Discord post failed:', err.response?.data || err.message);
  }
}

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
