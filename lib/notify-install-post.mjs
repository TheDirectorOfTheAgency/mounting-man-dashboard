// Shared Square → install-post intake.
// Used by the payment webhook and the square-install-post-seed cron.
// After the 24h install-post dedup claim, stages the phone queue. If a photo is
// already bound, dispatches the cloud runner (same envelope as the phone tap).
// If the photo is missing, POSTs a sanitized wake to Woodward asking
// for the photo only — never publish_one.py / go.py, never a second desk hop.

import axios from 'axios';

import { autoDispatchStagedJobs } from './install-post-auto-publish.mjs';
import { HOLD_REASONS } from './install-post-confidence.mjs';
import { createConfiguredDispatcher } from './install-post-dispatch.mjs';
import {
  buildInstallFacts,
  buildInstallPostSeeds,
  customerWithMergedInstallAddress,
  describeInstallOrderLines,
  formatInstallPostSubtotal,
} from './install-post-seeds.mjs';
import { getInstallPostStore, stageOperatorHandoff } from './install-post-store.mjs';
import { resolveInstallPostSourceRefs } from './square-source-ids.mjs';

/** Woodward/Q must never run these. The cloud runner is the publisher. */
export const INSTALL_POST_FORBIDDEN_SCRIPTS = Object.freeze(['publish_one.py', 'go.py']);
export const INSTALL_POST_CLOUD_PUBLISHER = 'cloud-runner';
export const INSTALL_POST_DESK_ACTIONS = Object.freeze(['none', 'request_photo', 'needs_human']);

function resolveDeskAction(deskAction) {
  if (deskAction === 'none' || deskAction === 'needs_human' || deskAction === 'request_photo') {
    return deskAction;
  }
  return 'request_photo';
}

function sanitizeHoldReasons(reasons) {
  const allowed = new Set(Object.values(HOLD_REASONS));
  return (Array.isArray(reasons) ? reasons : [])
    .map((reason) => String(reason || '').trim())
    .filter((reason) => allowed.has(reason));
}

const SQUARE_BASE = 'https://connect.squareup.com/v2';
const SQUARE_VER = '2024-01-18';
const SQUARE_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN || process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;

const INSTALL_POST_ACCESS_SECRET = (process.env.INSTALL_POST_ACCESS_SECRET || '').trim();
const INSTALL_POST_BASE_URL =
  (process.env.INSTALL_POST_BASE_URL || 'https://mounting-man-dashboard.vercel.app').trim();

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const DEDUP_TTL = 86400; // 24 hours
const PENDING_TTL = 172800; // 48 hours

const TEAM_MEMBER_MAP = {
  TMSiHOOr7RGdl2Ki: 'Michael',
  TMT84KWHegsrcWFB: 'Garrison',
  'TMY7unjtR-2XvVpg': 'Marshall',
  TMmOwb6WS9cTplXu: 'Crashon',
};

// Live Woodward webhook accepts Authorization: Bearer <WOODWARD_SQUARE_WEBHOOK_KEY>.
// x-webhook-secret is still sent for older inbound examples (see zenbooker.js).
export const WOODWARD_SENDER_HEADER = 'x-webhook-secret';

// Pre-rename env names. Read only until Vercel carries WOODWARD_SQUARE_WEBHOOK_*;
// delete these two entries once the legacy vars are removed from the project.
const LEGACY_DESK_WEBHOOK_URL_ENV = 'KRONKITE_SQUARE_WEBHOOK_URL';
const LEGACY_DESK_WEBHOOK_KEY_ENV = 'KRONKITE_SQUARE_WEBHOOK_KEY';

export function woodwardWebhookUrl(env = process.env) {
  return env.WOODWARD_SQUARE_WEBHOOK_URL || env[LEGACY_DESK_WEBHOOK_URL_ENV];
}

export function woodwardWebhookKey(env = process.env) {
  return env.WOODWARD_SQUARE_WEBHOOK_KEY || env[LEGACY_DESK_WEBHOOK_KEY_ENV];
}

let loggedMissingWoodwardUrl = false;
let loggedMissingWoodwardKey = false;

export function resetWoodwardMissingUrlLog() {
  loggedMissingWoodwardUrl = false;
  loggedMissingWoodwardKey = false;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

export function hasWoodwardBearerAuthorization(headers) {
  const auth = headerValue(headers, 'authorization');
  return typeof auth === 'string' && /^Bearer \S/.test(auth);
}

/** Live Woodward desk requires Authorization: Bearer. x-webhook-secret is compatibility-only. */
export function buildWoodwardWakeHeaders(key) {
  const senderKey = String(key || '').trim();
  if (!senderKey) return null;
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${senderKey}`,
    [WOODWARD_SENDER_HEADER]: senderKey,
  };
}

function squareHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    'Square-Version': SQUARE_VER,
    'Content-Type': 'application/json',
  };
}

async function kvSet(key, value, ttl) {
  if (!KV_URL || !KV_TOKEN) {
    console.warn('[kv-skip] No KV_URL/KV_TOKEN configured');
    return false;
  }
  const cmd = ttl
    ? `set/${key}/${encodeURIComponent(JSON.stringify(value))}/EX/${ttl}`
    : `set/${key}/${encodeURIComponent(JSON.stringify(value))}`;
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

/** CARD vs everything else Square records as cash/check/external. */
export function classifyPaymentSource(payment) {
  const sourceType = String(payment?.source_type || '').toUpperCase();
  if (sourceType === 'CARD' || sourceType === 'CARD_PRESENT') return 'CARD';
  return 'EXTERNAL/CHECK';
}

export function installDedupKey({ orderId, payment, invoice } = {}) {
  return `square:install-post:${orderId || payment?.id || invoice?.id || 'unknown'}`;
}

function tvNoteFromSeed(seed) {
  const notes = String(seed?.['job-notes'] || '')
    .split(' | ')
    .map((part) => part.trim())
    .filter(Boolean);
  return notes.find((note) => /tv installation|tv mounting|tv unmount|mantelmount/i.test(note)) || '';
}

function tvLinesFromSeeds(seeds = []) {
  return (Array.isArray(seeds) ? seeds : [])
    .map((seed) => {
      const size = seed['tv-size'] || '';
      const name = tvNoteFromSeed(seed) || (size ? `${size} TV Installation` : '');
      if (!name && !size) return null;
      return { name, size };
    })
    .filter(Boolean);
}

function serviceLinesFromSeeds(seeds = []) {
  const names = [];
  for (const seed of Array.isArray(seeds) ? seeds : []) {
    const notes = String(seed?.['job-notes'] || '')
      .split(' | ')
      .map((part) => part.trim())
      .filter(Boolean);
    for (const note of notes) {
      if (/tv installation|tv mounting|tv unmount|mantelmount/i.test(note)) continue;
      if (!names.includes(note)) names.push(note);
    }
  }
  return names.map((name) => ({ name }));
}

/**
 * Sanitized Woodward wake body. No customer name, full address, house number,
 * phone, email, or tokens.
 * tvSize stays a first-match fallback. Multi-TV jobs must use tvLines / tvSizes.
 */
export function buildWoodwardSquarePayload({
  facts = {},
  seeds = [],
  lineItems = [],
  payment = {},
  orderId = '',
  paymentId = '',
  eventType = '',
  installSubtotal = '',
  photoPresent = false,
  deskAction = 'request_photo',
  holdReasons = [],
} = {}) {
  const fromOrder = describeInstallOrderLines(lineItems);
  const usedOrderLines = fromOrder.tvLines.length > 0 || fromOrder.serviceLines.length > 0;
  const tvLines = fromOrder.tvLines.length ? fromOrder.tvLines : tvLinesFromSeeds(seeds);
  const serviceLines = usedOrderLines ? fromOrder.serviceLines : serviceLinesFromSeeds(seeds);
  const tvSizes = tvLines.map((line) => line.size).filter(Boolean);
  const reasons = sanitizeHoldReasons(holdReasons);

  return {
    city: facts.city || '',
    streetName: facts.streetName || '',
    tvSize: facts.tvSize || tvSizes[0] || '',
    tvBrand: facts.tvBrand || '',
    wallSurface: facts.wallSurface || '',
    mount: facts.bracketType || '',
    installationSubtotal: installSubtotal || '',
    paymentId: paymentId || payment?.id || '',
    orderId: orderId || payment?.order_id || '',
    paymentSource: classifyPaymentSource(payment),
    eventType: eventType || '',
    tvCount: tvLines.length,
    tvSizes,
    tvLines,
    serviceLines,
    // Desk contract: photo missing → request_photo. Confidence HOLD → needs_human.
    // Never run local Python.
    publisher: INSTALL_POST_CLOUD_PUBLISHER,
    photoPresent: Boolean(photoPresent),
    deskAction: resolveDeskAction(deskAction),
    holdReasons: reasons,
    doNotRun: [...INSTALL_POST_FORBIDDEN_SCRIPTS],
  };
}

/** Wake Woodward with reason codes only. No customer name, phone, or full address. */
export async function forwardConfidenceHoldWake({
  record,
  reasons = [],
  httpClient = axios,
  url = woodwardWebhookUrl(),
  key = woodwardWebhookKey(),
  logger = console,
} = {}) {
  const seed = record?.seed && typeof record.seed === 'object' ? record.seed : {};
  const payload = buildWoodwardSquarePayload({
    facts: {
      city: seed.city || '',
      streetName: seed['street-name'] || '',
      tvSize: seed['tv-size'] || '',
      tvBrand: seed['tv-brand'] || '',
      wallSurface: seed['wall-surface'] || '',
      bracketType: seed['bracket-type'] || '',
    },
    seeds: [seed],
    photoPresent: Boolean(record?.image),
    deskAction: 'needs_human',
    holdReasons: reasons,
  });
  return forwardWoodwardSquareWake({ payload, httpClient, url, key, logger });
}

export async function forwardWoodwardSquareWake({
  payload,
  httpClient = axios,
  url = woodwardWebhookUrl(),
  key = woodwardWebhookKey(),
  logger = console,
} = {}) {
  const dest = String(url || '').trim();
  if (!dest) {
    if (!loggedMissingWoodwardUrl) {
      loggedMissingWoodwardUrl = true;
      logger.warn('[woodward] WOODWARD_SQUARE_WEBHOOK_URL unset — skipping install-post wake');
    }
    return { skipped: 'missing_url' };
  }

  const headers = buildWoodwardWakeHeaders(key);
  if (!hasWoodwardBearerAuthorization(headers)) {
    if (!loggedMissingWoodwardKey) {
      loggedMissingWoodwardKey = true;
      logger.warn('[woodward] WOODWARD_SQUARE_WEBHOOK_KEY unset — refusing wake without Bearer auth');
    }
    return { skipped: 'missing_key' };
  }

  try {
    await httpClient.post(dest, payload, { headers, timeout: 8000 });
    logger.info('[woodward] forwarded sanitized install-post wake');
    return { forwarded: true };
  } catch (err) {
    logger.error('[woodward] wake failed:', err.response?.data || err.message);
    return { forwarded: false, error: true };
  }
}

export async function notifyQInstallPost(
  {
    orderId,
    payment,
    invoice,
    paymentId: paymentIdHint = '',
    invoiceId: invoiceIdHint = '',
    isInvoiceEvent,
    eventType,
    firstName,
    lastName,
    customer,
    amount,
    amountCents,
    triggerStatus,
    triggerSourceCode,
  },
  {
    httpClient = axios,
    exists = kvExists,
    set = kvSet,
    rpush,
    sadd = kvSadd,
    installPostStore,
    capabilitySecret = INSTALL_POST_ACCESS_SECRET,
    queueBaseUrl = INSTALL_POST_BASE_URL,
    woodwardUrl = woodwardWebhookUrl(),
    woodwardKey = woodwardWebhookKey(),
    dispatcher,
    logger = console,
    typesafeHttpClient,
    typesafeApiKey = process.env.TYPESAFE_API_KEY,
  } = {},
) {
  // Unused by this path: kept so older callers that still pass Discord deps
  // or the Siri queue writer do not throw. Install-post seeds must not wake
  // Discord or Opus.
  void rpush;
  void amount;
  void amountCents;

  const dedupKey = installDedupKey({ orderId, payment, invoice });
  if (await exists(dedupKey)) {
    logger.info(`[q-notify] Duplicate install-post notification for ${dedupKey} — skipping`);
    return { skipped: 'duplicate', key: dedupKey };
  }
  await set(dedupKey, { processed: new Date().toISOString() }, DEDUP_TTL);

  let lineItems = [];
  let order = {};
  try {
    if (!orderId) {
      throw new Error('No order_id on payment');
    }
    const orderRes = await httpClient.get(`${SQUARE_BASE}/orders/${orderId}`, {
      headers: squareHeaders(),
    });
    order = orderRes.data?.order || {};
    lineItems = order.line_items || [];
  } catch (err) {
    logger.error('[q-notify] Failed to fetch order:', err.response?.data || err.message);
  }

  const seedCustomer = customerWithMergedInstallAddress(
    customer,
    invoice?.primary_recipient?.address,
  );
  const facts = buildInstallFacts({
    lineItems,
    payment,
    order,
    customer: seedCustomer,
    teamMemberMap: TEAM_MEMBER_MAP,
  });
  const resolvedTriggerStatus = triggerStatus
    || (isInvoiceEvent || eventType ? 'Square webhook succeeded' : 'Square webhook succeeded');
  const resolvedTriggerSource = triggerSourceCode || 'square-webhook';
  const triggerEvent = isInvoiceEvent ? 'invoice.payment_made' : eventType;
  const sourceRefs = resolveInstallPostSourceRefs({
    orderId,
    paymentId: paymentIdHint,
    invoiceId: invoiceIdHint || invoice?.id || '',
    payment,
    invoice,
    order,
  });

  const draftSeeds = buildInstallPostSeeds({
    lineItems,
    payment,
    order,
    customer: seedCustomer,
    orderId: sourceRefs.orderId,
    paymentId: sourceRefs.paymentId,
    invoiceId: sourceRefs.invoiceId,
    triggerStatus: resolvedTriggerStatus,
    triggerSourceCode: resolvedTriggerSource,
    triggerEvent,
    teamMemberMap: TEAM_MEMBER_MAP,
  });
  const draftSeed = draftSeeds[0] || {};
  const installSubtotal = formatInstallPostSubtotal({ seeds: draftSeeds, order });

  const resolvedStore = installPostStore !== undefined ? installPostStore : await getInstallPostStore();
  const operatorLinks = await stageOperatorHandoff({
    store: resolvedStore,
    seeds: draftSeeds,
    sourceRefs,
    source: resolvedTriggerSource,
    secret: capabilitySecret,
    baseUrl: queueBaseUrl,
  });

  const fullName = [firstName, lastName].filter((s) => s && s !== 'there').join(' ') || firstName;
  const pendingId = sourceRefs.orderId || sourceRefs.paymentId || `unknown-${Date.now()}`;
  const pendingKey = `install-post:pending:${pendingId}`;
  await set(pendingKey, JSON.stringify({
    seed: draftSeed,
    orderId: sourceRefs.orderId,
    paymentId: sourceRefs.paymentId,
    invoiceId: sourceRefs.invoiceId,
    customerName: fullName,
    stagedAt: new Date().toISOString(),
    source: resolvedTriggerSource,
    seeds: draftSeeds,
    seedCount: draftSeeds.length,
  }), PENDING_TTL);
  if (sadd) {
    await sadd('install-post:pending-index', pendingKey);
  }
  logger.info(`[q-notify] Staged seed in Redis: ${pendingKey}`);

  const recordsForJobs = [];
  if (resolvedStore && operatorLinks.length) {
    for (const link of operatorLinks) {
      const record = await resolvedStore.loadRecord(link.jobId);
      if (record) recordsForJobs.push(record);
    }
  }

  const photoBound = recordsForJobs.filter((record) => record.image);
  const photoMissing = recordsForJobs.length
    ? recordsForJobs.some((record) => !record.image)
    : true;
  const photoPresent = recordsForJobs.length > 0 && photoBound.length === recordsForJobs.length;

  const resolvedDispatcher = dispatcher !== undefined
    ? dispatcher
    : (photoBound.length ? createConfiguredDispatcher() : null);
  const dispatchResults = await autoDispatchStagedJobs({
    records: photoBound,
    store: resolvedStore,
    dispatcher: resolvedDispatcher,
    logger,
    typesafeHttpClient,
    typesafeApiKey,
  });

  const holdReasons = [];
  for (const entry of dispatchResults) {
    if (entry?.reason !== 'needs_human') continue;
    for (const reason of Array.isArray(entry.holdReasons) ? entry.holdReasons : []) {
      if (!holdReasons.includes(reason)) holdReasons.push(reason);
    }
  }
  const confidenceHold = holdReasons.length > 0;
  const deskAction = photoMissing
    ? 'request_photo'
    : (confidenceHold ? 'needs_human' : 'none');

  const woodwardPayload = buildWoodwardSquarePayload({
    facts,
    seeds: draftSeeds,
    lineItems,
    payment,
    orderId: sourceRefs.orderId,
    paymentId: sourceRefs.paymentId,
    eventType: triggerEvent,
    installSubtotal,
    photoPresent,
    deskAction,
    holdReasons,
  });

  // Photo present + PASS → cloud runner. Photo missing → request the photo.
  // Confidence HOLD → wake Woodward with reason codes only (no second publisher).
  let woodward = { skipped: 'photo_present_cloud_publisher' };
  if (photoMissing || confidenceHold) {
    woodward = await forwardWoodwardSquareWake({
      payload: woodwardPayload,
      httpClient,
      url: woodwardUrl,
      key: woodwardKey,
      logger,
    });
  }

  return {
    skipped: null,
    key: dedupKey,
    pendingKey,
    operatorLinks,
    seeds: draftSeeds,
    woodward,
    woodwardPayload,
    cloudDispatch: dispatchResults,
  };
}
