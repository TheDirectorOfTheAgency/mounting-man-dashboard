// Auto-deliver a GBP paste pack to Mr. Wayne after a verified install page.
//
// Two fence-only bodies: caption (no URL, no hashtags) and the live Book URL.
// Never posts to Google Business Profile. Never Reddit. Does not wait on
// Woodward — this is a dedicated operator webhook, Kronkite-header shaped.

import { buildGbpFenceCaption, GBP_CAPTION_MAX_CHARS } from './install-post-copy.mjs';
import { INSTALL_POST_STATES } from './install-post-states.mjs';

const SENDER_HEADER = 'x-webhook-secret';

function headerValue(headers, name) {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/** Same Bearer + x-webhook-secret shape as the Kronkite wake. */
export function buildGbpFenceNotifyHeaders(key) {
  const senderKey = String(key || '').trim();
  if (!senderKey) return null;
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${senderKey}`,
    [SENDER_HEADER]: senderKey,
  };
}

export function hasGbpFenceBearerAuthorization(headers) {
  const auth = headerValue(headers, 'authorization');
  return typeof auth === 'string' && /^Bearer \S/.test(auth);
}

export const GBP_FENCE_CAPTION_KIND = 'gbp_caption';
export const GBP_FENCE_BOOK_URL_KIND = 'gbp_book_url';

const LIVE_INSTALL_URL_RE = /^https:\/\/(?:www\.)?themountingman\.com\/installations\/[a-z0-9-]+\/?$/i;

let loggedMissingUrl = false;
let loggedMissingKey = false;

export function resetGbpFenceNotifyMissingLog() {
  loggedMissingUrl = false;
  loggedMissingKey = false;
}

export function isLiveInstallPageUrl(url) {
  return LIVE_INSTALL_URL_RE.test(String(url || '').trim());
}

export function publishedInstallPageIsLive(record = {}) {
  const result = record.result && typeof record.result === 'object' ? record.result : {};
  if (record.state !== INSTALL_POST_STATES.PUBLISHED) return false;
  if (Number(result.publicStatus) !== 200) return false;
  return isLiveInstallPageUrl(result.liveUrl);
}

/** Caption + Book URL. Caption never includes the URL. */
export function buildGbpFenceNotifyBodies({ seed = {}, liveUrl = '' } = {}) {
  const caption = String(buildGbpFenceCaption(seed || {}) || '').trim();
  const bookUrl = String(liveUrl || '').trim();
  return [
    {
      kind: GBP_FENCE_CAPTION_KIND,
      deskAction: 'paste_gbp_caption',
      body: caption.slice(0, GBP_CAPTION_MAX_CHARS),
    },
    {
      kind: GBP_FENCE_BOOK_URL_KIND,
      deskAction: 'paste_gbp_book_url',
      body: bookUrl,
    },
  ];
}

export async function forwardGbpFenceNotify({
  payloads = [],
  httpClient,
  url = process.env.INSTALL_POST_GBP_NOTIFY_URL,
  key = process.env.INSTALL_POST_GBP_NOTIFY_KEY,
  logger = console,
} = {}) {
  const dest = String(url || '').trim();
  if (!dest) {
    if (!loggedMissingUrl) {
      loggedMissingUrl = true;
      logger.warn('[install-post-gbp-fence] INSTALL_POST_GBP_NOTIFY_URL unset — skipping owner fence');
    }
    return { skipped: 'missing_url' };
  }

  const headers = buildGbpFenceNotifyHeaders(key);
  if (!hasGbpFenceBearerAuthorization(headers)) {
    if (!loggedMissingKey) {
      loggedMissingKey = true;
      logger.warn('[install-post-gbp-fence] INSTALL_POST_GBP_NOTIFY_KEY unset — refusing fence without Bearer auth');
    }
    return { skipped: 'missing_key' };
  }

  if (!httpClient || typeof httpClient.post !== 'function') {
    return { skipped: 'missing_client' };
  }

  const sent = [];
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    try {
      await httpClient.post(dest, payload, { headers, timeout: 8000 });
      sent.push(payload.kind);
    } catch (err) {
      logger.warn?.('[install-post-gbp-fence] owner notify failed open', {
        errorType: err?.name || 'Error',
        status: err?.response?.status,
        kind: payload?.kind,
      });
      return { forwarded: false, error: true, sent };
    }
  }
  return { forwarded: true, sent };
}

/**
 * Post-publish success hook. Fail open — a notify miss must not fail the
 * runner callback or the live page.
 */
export async function deliverGbpFenceToOwner({
  record,
  httpClient,
  url = process.env.INSTALL_POST_GBP_NOTIFY_URL,
  key = process.env.INSTALL_POST_GBP_NOTIFY_KEY,
  logger = console,
} = {}) {
  if (!publishedInstallPageIsLive(record)) {
    return { skipped: 'page_not_live' };
  }
  const liveUrl = String(record.result.liveUrl || '').trim();
  const payloads = buildGbpFenceNotifyBodies({
    seed: record.seed || {},
    liveUrl,
  });
  const caption = payloads[0]?.body || '';
  if (!caption || /https?:\/\//i.test(caption) || /#\w/.test(caption)) {
    logger.warn?.('[install-post-gbp-fence] caption failed fence rules — skipping');
    return { skipped: 'caption_fence' };
  }
  if (!isLiveInstallPageUrl(payloads[1]?.body)) {
    return { skipped: 'book_url_invalid' };
  }
  return forwardGbpFenceNotify({ payloads, httpClient, url, key, logger });
}
