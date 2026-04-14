// pages/api/webhooks/square-payment.js
// Receives Square payment webhooks → sends review SMS via Twilio
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
const DISCORD_BOT_TOKEN =
  process.env.DISCORD_Q_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
const DISCORD_OPS_CHANNEL = '1472767806452924520'; // #operations
const DISCORD_INSTALL_THREAD = '1485380804707090643'; // Installation Posts thread in Q's #general
const DISCORD_Q_USER_ID = process.env.DISCORD_Q_USER_ID || '';

// Upstash Redis — for dedup only
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const Q_QUEUE_KEY = 'agency:context:siri_queue';

// Square webhook signature key (optional — set after creating subscription)
const SQUARE_WEBHOOK_SIG_KEY = (process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '').trim();

// Dedup — prevent processing the same payment twice
const DEDUP_TTL = 86400; // 24 hours

const TEAM_MEMBER_MAP = {
  TMSiHOOr7RGdl2Ki: 'Michael',
  TMT84KWHegsrcWFB: 'Garrison',
  'TMY7unjtR-2XvVpg': 'Marshall',
  TMmOwb6WS9cTplXu: 'Crashon',
};

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

/** Push a value onto a Redis list */
async function kvRpush(key, value) {
  if (!KV_URL || !KV_TOKEN) {
    console.warn('[kv-skip] No KV_URL/KV_TOKEN configured');
    return false;
  }
  try {
    const res = await axios.post(
      `${KV_URL}/rpush/${encodeURIComponent(key)}`,
      JSON.stringify(value),
      {
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    );
    return Boolean(res.data);
  } catch (err) {
    console.error('[kv-rpush-error]', err.response?.data || err.message);
    return false;
  }
}

/** Add a member to a Redis SET (for the pending-index) */
async function kvSadd(key, member) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    await axios.post(
      `${KV_URL}/sadd/${encodeURIComponent(key)}`,
      JSON.stringify([member]),
      {
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    );
    return true;
  } catch (err) {
    console.error('[kv-sadd-error]', err.response?.data || err.message);
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

function sanitizeStreetName(line1) {
  const raw = String(line1 || '').trim();
  if (!raw) return '';
  return raw
    .replace(/^\d+[A-Za-z\-\/]*\s+/, '')
    .replace(/\b(?:apt|apartment|unit|suite|ste)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,]+$/, '');
}

function formatMoney(amountCents) {
  const amount = Number(amountCents || 0) / 100;
  return `$${amount.toFixed(2)}`;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function normalizeCity(value) {
  const city = String(value || '').trim();
  if (!city) return '';
  const lower = city.toLowerCase();
  if (lower === 'saint paul' || lower === 'st paul' || lower === 'st. paul') {
    return 'St. Paul';
  }
  return city;
}

function parseTvSize(text) {
  const value = String(text || '');
  const match = value.match(/\b(43|50|55|60|65|70|75|80|85|86|98|100)\b/);
  return match ? `${match[1]}"` : '';
}

function detectTvBrand(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return '';
  if (value.includes('samsung')) return 'Samsung';
  if (value.includes('hisense')) return 'Hisense';
  if (value.includes('tcl')) return 'TCL';
  if (value.includes('lg')) return 'LG';
  if (value.includes('sony')) return 'Sony';
  if (value.includes('vizio')) return 'Vizio';
  return '';
}

function detectGalleryStyle(text) {
  const value = String(text || '').toLowerCase();
  return value.includes('frame') || value.includes('canvas') || value.includes('nxtframe') || value.includes('g series');
}

function detectWallSurface(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return '';
  if (value.includes('drywall')) return 'Drywall';
  if (value.includes('wood slat')) return 'Wood Slats';
  if (value.includes('plaster') || value.includes('stucco')) return 'Plaster';
  if (value.includes('brick')) return 'Brick';
  if (value.includes('stone') || value.includes('faux brick')) return 'Stone';
  if (value.includes('tile') || value.includes('porcelain') || value.includes('ceramic')) return 'Tile';
  if (value.includes('concrete') || value.includes('block')) return 'Concrete';
  return '';
}

function detectBracket(text, { soldByUs = false } = {}) {
  const value = String(text || '').toLowerCase();
  if (!value || !value.includes('bracket') && !value.includes('mount')) return '';
  if (value.includes('soundbar')) return '';
  const suffix = soldByUs ? ' (Bought from us)' : '';
  if (value.includes('full motion') || value.includes('articulating')) return `Full Motion Bracket${suffix}`;
  if (value.includes('4d tilt')) return `Premium 4D Tilt Bracket${suffix}`;
  if (value.includes('premium tilt')) return `Premium Tilt Bracket${suffix}`;
  if (value.includes('tilt')) return `Tilt Bracket${suffix}`;
  if (value.includes('flush')) return `Flush Bracket${suffix}`;
  if (value.includes('fixed')) return `Fixed Bracket${suffix}`;
  if (value.includes('corner')) return `Corner Bracket${suffix}`;
  return '';
}

function detectCableManagement(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return '';
  if (value.includes('existing conduit')) return 'Existing Conduit';
  if (value.includes('soundbar cords')) return 'In-Wall Concealment With Soundbar Cords';
  if (value.includes('power bridge')) return 'Recessed Power Bridge';
  if (value.includes('new outlet')) return 'In-Wall Concealment With New Outlet';
  if (value.includes('through fireplace')) return 'In-Wall Concealment Through Fireplace';
  if (value.includes('in-wall') || value.includes('in wall')) return 'In-Wall Concealment';
  if (value.includes('exterior around fireplace')) return 'Exterior Concealment Around Fireplace';
  if (value.includes('exterior')) return 'Exterior Concealment';
  return '';
}

function detectFireplace(text) {
  const value = String(text || '').toLowerCase();
  if (!value.includes('fireplace')) return '';
  if (value.includes('brick fireplace')) return 'Brick Fireplace';
  if (value.includes('stone fireplace')) return 'Stone Fireplace';
  if (value.includes('plaster fireplace')) return 'Plaster Fireplace';
  if (value.includes('drywall fireplace')) return 'Drywall Fireplace';
  return 'Fireplace';
}

function normalizeLineItems(lineItems) {
  return (lineItems || [])
    .filter((item) => item?.name && item.name !== 'Sales Tax' && item.name !== 'CC Processing Fee')
    .map((item) => {
      const label = [item.variation_name, item.name].filter(Boolean).join(' — ');
      return {
        label,
        name: String(item.name || ''),
        variationName: String(item.variation_name || ''),
        quantity: Number(item.quantity || 1),
        note: String(item.note || ''),
      };
    });
}

function buildInstallFacts({ lineItems, payment, order, customer }) {
  const normalized = normalizeLineItems(lineItems);
  const textBlob = normalized.map((item) => `${item.variationName} ${item.name} ${item.note}`.trim()).join(' | ');
  const soldBracketByUs = normalized.some((item) => {
    const haystack = `${item.variationName} ${item.name}`.toLowerCase();
    return haystack.includes('tv mount') || haystack.includes('bracket');
  });

  const tvSize = parseTvSize(textBlob);
  const tvBrand = detectTvBrand(textBlob);
  const galleryStyle = detectGalleryStyle(textBlob);
  const wallSurface = detectWallSurface(textBlob);
  const bracketType = detectBracket(textBlob, { soldByUs: soldBracketByUs });
  const cableManagement = detectCableManagement(textBlob);
  const fireplaceType = detectFireplace(textBlob);
  const technician =
    TEAM_MEMBER_MAP[payment?.team_member_id] ||
    TEAM_MEMBER_MAP[order?.created_by_team_member_id] ||
    TEAM_MEMBER_MAP[payment?.created_by_team_member_id] ||
    '';
  const streetName = sanitizeStreetName(customer?.address?.address_line_1);

  return {
    performedBy: technician,
    tvSize,
    tvBrand,
    galleryStyle,
    wallSurface,
    fireplaceType,
    bracketType,
    cableManagement,
    streetName,
    city: normalizeCity(firstNonEmpty(customer?.address?.locality)),
    state: firstNonEmpty(customer?.address?.administrative_district_level_1),
    postalCode: firstNonEmpty(customer?.address?.postal_code),
    sourceLabels: normalized.map((item) => item.label).filter(Boolean),
  };
}

function compactSeed(seed) {
  return Object.fromEntries(
    Object.entries(seed).filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      return value !== undefined && value !== null && value !== '';
    }),
  );
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

/** Validate Square webhook signature (HMAC-SHA256) */
function verifySquareSignature(body, signatureHeader, url) {
  if (!SQUARE_WEBHOOK_SIG_KEY) return true; // Skip if not configured
  if (!signatureHeader) return false;

  const hmac = crypto.createHmac('sha256', SQUARE_WEBHOOK_SIG_KEY);
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

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();

  try {
    // ---- Parse body (raw bytes required for HMAC signature verification) ----
    const rawBody = await getRawBody(req);
    const body = JSON.parse(rawBody);

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

    // ---- Dedup check ----
    const dedupKey = isInvoiceEvent ? `square:invoice:${invoiceId}` : `square:payment:${paymentId}`;
    if (await kvExists(dedupKey)) {
      console.log(`[square-webhook] Duplicate ${isInvoiceEvent ? 'invoice' : 'payment'} event ${isInvoiceEvent ? invoiceId : paymentId} — skipping`);
      return res.status(200).json({ status: 'duplicate', paymentId, invoiceId });
    }
    await kvSet(dedupKey, { processed: new Date().toISOString() }, DEDUP_TTL);

    // ---- No customer ID? Log and bail ----
    if (!customerId) {
      console.warn(`[square-webhook] ${isInvoiceEvent ? 'Invoice' : 'Payment'} ${isInvoiceEvent ? invoiceId : paymentId} has no customer_id`);
      await logDiscord(`⚠️ **Square ${isInvoiceEvent ? 'invoice payment' : 'payment'}** $${amount} (${isInvoiceEvent ? invoiceId : paymentId}) — no customer ID attached, skipped downstream follow-up`);
      return res.status(200).json({ status: 'no_customer', paymentId, invoiceId });
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
      await logDiscord(`⚠️ **Square ${isInvoiceEvent ? 'invoice payment' : 'payment'}** $${amount} — failed to fetch customer ${customerId} (HTTP ${status})`);
      return res.status(200).json({ status: 'customer_fetch_failed', paymentId, invoiceId, customerId });
    }

    // ---- Extract customer details ----
    const firstName = customer.given_name || 'there';
    const lastName = customer.family_name || '';
    const email = customer.email_address || '';
    const phone = cleanPhone(customer.phone_number || '');
    const hasPhone = phone.length >= 12; // +1XXXXXXXXXX = 12 chars

    console.log(`[square-webhook] Customer: ${firstName} ${lastName}, phone=${phone || 'N/A'}, email=${email || 'N/A'}`);

    // ---- Notify Q in Installation Posts thread as soon as customer data is available ----
    await notifyQInstallPost({
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

    // ---- No phone? Log and bail on SMS only ----
    if (!hasPhone) {
      await logDiscord(`⚠️ **No phone number** for customer ${firstName} ${lastName} (ID: ${customerId}) — skipped review SMS. Email: ${email || 'N/A'} | Job total: $${amount}`);
      return res.status(200).json({ status: 'no_phone', paymentId, invoiceId, customerId, firstName, lastName });
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
        elapsed,
      });
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

async function notifyQInstallPost({ orderId, payment, invoice, isInvoiceEvent, eventType, firstName, lastName, customer, amount, amountCents }) {
  if (!DISCORD_BOT_TOKEN) {
    console.warn('[q-notify] No DISCORD_BOT_TOKEN — skipping Q notification');
    return;
  }

  const installDedupKey = `square:install-post:${orderId || payment?.id || invoice?.id || 'unknown'}`;
  if (await kvExists(installDedupKey)) {
    console.log(`[q-notify] Duplicate install-post notification for ${installDedupKey} — skipping`);
    return;
  }
  await kvSet(installDedupKey, { processed: new Date().toISOString() }, DEDUP_TTL);

  // ---- Fetch order line items from Square ----
  let lineItems = [];
  let order = {};
  try {
    if (!orderId) {
      throw new Error('No order_id on payment');
    }
    const orderRes = await axios.get(`${SQUARE_BASE}/orders/${orderId}`, {
      headers: squareHeaders(),
    });
    order = orderRes.data?.order || {};
    lineItems = order.line_items || [];
  } catch (err) {
    console.error('[q-notify] Failed to fetch order:', err.response?.data || err.message);
    // Continue without line items — still useful to notify Q
  }

  const facts = buildInstallFacts({ lineItems, payment, order, customer });
  const jobParts = facts.sourceLabels;
  const jobSummary = jobParts.length > 0 ? jobParts.join('\n') : '(job details unavailable)';

  // ---- Build address from customer ----
  const addr = customer.address || {};
  const addressParts = [
    addr.address_line_1,
    addr.address_line_2,
    facts.city && addr.administrative_district_level_1
      ? `${facts.city}, ${addr.administrative_district_level_1}`
      : facts.city || addr.administrative_district_level_1,
    addr.postal_code,
  ].filter(Boolean);
  const addressLine = addressParts.length > 0 ? addressParts.join(', ') : '(address not on file)';
  const streetOnly = facts.streetName ? `${facts.streetName}${facts.city ? `, ${facts.city}` : ''}` : '';
  const triggerStatus = 'Square webhook succeeded';
  const triggerSourceCode = 'square-webhook';
  const triggerEvent = isInvoiceEvent ? 'invoice.payment_made' : eventType;

  const draftSeed = compactSeed({
    city: facts.city,
    state: facts.state,
    title: '',
    slug: '',
    'post-body': '',
    'post-summary': '',
    'tv-size': facts.tvSize,
    'tv-brand': facts.tvBrand,
    'wall-surface': facts.wallSurface,
    'metro-area': '',
    'location-id': '',
    'gallery-style': facts.galleryStyle,
    'fireplace-type': facts.fireplaceType,
    price: formatMoney(amountCents),
    'performed-by': facts.performedBy,
    'street-name': facts.streetName,
    'mount-type': '',
    'room-type': '',
    'bracket-type': facts.bracketType,
    'hardware-used': '',
    'cable-management': facts.cableManagement,
    'job-notes': jobParts.join(' | '),
    'local-reference': facts.streetName || '',
    'nearby-cities': [],
    'image-path': '',
    'source-order-id': orderId,
    'source-payment-id': payment?.id || '',
    'source-invoice-id': invoice?.id || '',
    'trigger-status': triggerStatus,
    'trigger-source-code': triggerSourceCode,
    'trigger-event': triggerEvent,
  });

  const factLines = [
    facts.performedBy ? `Technician: ${facts.performedBy}` : '',
    facts.tvSize ? `TV size: ${facts.tvSize}` : '',
    facts.tvBrand ? `TV brand: ${facts.tvBrand}` : '',
    facts.galleryStyle ? `Gallery style: true` : '',
    facts.wallSurface ? `Wall surface: ${facts.wallSurface}` : '',
    facts.fireplaceType ? `Fireplace: ${facts.fireplaceType}` : '',
    facts.bracketType ? `Bracket: ${facts.bracketType}` : '',
    facts.cableManagement ? `Cable management: ${facts.cableManagement}` : '',
    streetOnly ? `Street seed: near ${streetOnly}` : '',
  ].filter(Boolean);

  // ---- Build message ----
  const fullName = [firstName, lastName].filter(s => s && s !== 'there').join(' ') || firstName;
  const qMention = DISCORD_Q_USER_ID ? `<@${DISCORD_Q_USER_ID}> ` : '';
  const qTask = [
    'Installation post seed ready.',
    `Client: ${fullName}.`,
    facts.performedBy ? `Technician: ${facts.performedBy}.` : '',
    facts.city ? `City: ${facts.city}.` : '',
    facts.streetName ? `Street seed: ${facts.streetName}.` : '',
    `Amount: $${amount}.`,
    `Square webhook: succeeded.`,
    `Trigger event: ${triggerEvent}.`,
    orderId ? `Order ID: ${orderId}.` : '',
    `Wait for the photo in Discord thread ${DISCORD_INSTALL_THREAD}, then prepare the installation post from the queued seed JSON.`,
    `Seed JSON: ${JSON.stringify(draftSeed)}`
  ].filter(Boolean).join(' ');
  const message = [
    `${qMention}📸 **New job paid — ready for installation post**`,
    `**Client**: ${fullName}`,
    `**Address**: ${addressLine}`,
    `**Job**:\n${jobParts.length > 0 ? jobParts.map(p => `  • ${p}`).join('\n') : '  • ' + jobSummary}`,
    `**Amount**: $${amount}`,
    `**Square webhook**: succeeded`,
    `**Trigger event**: ${triggerEvent}`,
    factLines.length > 0 ? `**Draft facts**:\n${factLines.map(line => `  • ${line}`).join('\n')}` : '',
    ``,
    `**Suggested seed JSON**:`,
    '```json',
    JSON.stringify(draftSeed, null, 2),
    '```',
    `Drop the job photo and I'll have the post ready to publish.`,
  ].join('\n');

  const queuePayload = {
    task: qTask,
    from: 'square-payment-webhook',
    timestamp: new Date().toISOString(),
    orderId: orderId || '',
    paymentId: payment?.id || '',
    invoiceId: invoice?.id || '',
    threadId: DISCORD_INSTALL_THREAD,
    seed: draftSeed,
  };
  const queuedForQ = await kvRpush(Q_QUEUE_KEY, JSON.stringify(queuePayload));

  // ---- Stage seed in dedicated Redis key for Q's photo handler ----
  const pendingId = orderId || payment?.id || `unknown-${Date.now()}`;
  const pendingKey = `install-post:pending:${pendingId}`;
  await kvSet(pendingKey, JSON.stringify({
    seed: draftSeed,
    orderId: orderId || '',
    paymentId: payment?.id || '',
    invoiceId: invoice?.id || '',
    customerName: fullName,
    threadId: DISCORD_INSTALL_THREAD,
    stagedAt: new Date().toISOString(),
    source: triggerSourceCode,
  }), 172800); // 48h TTL
  await kvSadd('install-post:pending-index', pendingKey);
  console.log(`[q-notify] Staged seed in Redis: ${pendingKey}`);

  // ---- Post to Installation Posts thread ----
  try {
    await axios.post(
      `https://discord.com/api/v10/channels/${DISCORD_INSTALL_THREAD}/messages`,
      {
        content: message,
        allowed_mentions: DISCORD_Q_USER_ID ? { users: [DISCORD_Q_USER_ID] } : undefined,
      },
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[q-notify] Posted to Installation Posts thread for ${fullName}`);
  } catch (err) {
    console.error('[q-notify] Discord post failed:', err.response?.data || err.message);
  }

  if (!queuedForQ) {
    console.warn(`[q-notify] Failed to queue fallback task for ${fullName}`);
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

// Disable Next.js body parser — required to read raw bytes for Square HMAC signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};
