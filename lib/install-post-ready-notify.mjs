// Plain "ready for M1" ping to Mr. Wayne.
//
// Fixed template, no LLM, no Woodward wake. Rides the same operator webhook as
// the GBP paste pack unless INSTALL_POST_READY_NOTIFY_URL/KEY override it.
// Body carries size/brand/city and the opaque job id only — no street, no
// customer, no Square ids.

import {
  buildGbpFenceNotifyHeaders,
  hasGbpFenceBearerAuthorization,
} from './install-post-gbp-fence-notify.mjs';
import { INSTALL_POST_STATES } from './install-post-states.mjs';

export const READY_FOR_M1_KIND = 'install_post_ready_for_m1';

let loggedMissingUrl = false;
let loggedMissingKey = false;

export function resetReadyNotifyMissingLog() {
  loggedMissingUrl = false;
  loggedMissingKey = false;
}

export function readyNotifyUrlFromEnv(env = process.env) {
  return String(env.INSTALL_POST_READY_NOTIFY_URL || env.INSTALL_POST_GBP_NOTIFY_URL || '').trim();
}

export function readyNotifyKeyFromEnv(env = process.env) {
  return String(env.INSTALL_POST_READY_NOTIFY_KEY || env.INSTALL_POST_GBP_NOTIFY_KEY || '').trim();
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

export function buildReadyForM1Ping(record = {}) {
  const seed = record.seed && typeof record.seed === 'object' ? record.seed : {};
  const tv = [text(seed['tv-size']), text(seed['tv-brand'])].filter(Boolean).join(' ');
  const jobType = text(seed['job-type']).toLowerCase() === 'unmount' ? 'TV unmounting' : 'TV installation';
  const label = [tv || jobType, text(seed.city)].filter(Boolean).join(' · ');
  return {
    kind: READY_FOR_M1_KIND,
    deskAction: 'none',
    jobId: text(record.jobId),
    revision: text(record.revision),
    body: `Install post ready for M1 publish: ${label}`,
  };
}

/** Fail open: a missed ping never changes the job's state. */
export async function sendReadyForM1Ping({
  record,
  httpClient,
  url = readyNotifyUrlFromEnv(),
  key = readyNotifyKeyFromEnv(),
  logger = console,
} = {}) {
  if (record?.state !== INSTALL_POST_STATES.READY_FOR_M1) return { skipped: 'not_ready' };

  const dest = text(url);
  if (!dest) {
    if (!loggedMissingUrl) {
      loggedMissingUrl = true;
      logger.warn?.('[install-post-ready] INSTALL_POST_READY_NOTIFY_URL / INSTALL_POST_GBP_NOTIFY_URL unset — skipping ready ping');
    }
    return { skipped: 'missing_url' };
  }

  const headers = buildGbpFenceNotifyHeaders(key);
  if (!hasGbpFenceBearerAuthorization(headers)) {
    if (!loggedMissingKey) {
      loggedMissingKey = true;
      logger.warn?.('[install-post-ready] notify key unset — refusing ready ping without Bearer auth');
    }
    return { skipped: 'missing_key' };
  }
  if (!httpClient || typeof httpClient.post !== 'function') return { skipped: 'missing_client' };

  try {
    await httpClient.post(dest, buildReadyForM1Ping(record), { headers, timeout: 8000 });
    return { forwarded: true };
  } catch (err) {
    logger.warn?.('[install-post-ready] ready ping failed open', {
      errorType: err?.name || 'Error',
      status: err?.response?.status,
    });
    return { forwarded: false, error: true };
  }
}
