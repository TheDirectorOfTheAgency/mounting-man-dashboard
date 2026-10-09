import crypto from 'node:crypto';
import axios from 'axios';
import { DEFAULT_BRIDGE_WINDOW_MS } from './attribution-bridge.js';
import { opaqueRef } from './offline-conversion-eligibility.js';

const DEFAULT_ZENBOOKER_BASE_URL = 'https://api.zenbooker.com/v1/';
export const BOOKING_WINDOW_MS = 48 * 60 * 60 * 1000;
export const LOOKUP_TIMEOUT_MS = 1200;
export const LOOKUP_RETRY_TIMEOUT_MS = 900;
const FUTURE_JOB_SLACK_MS = 5 * 60 * 1000;

const SESSION_FIELDS = ['booking_session', 'booking_session_id', 'bookingSession', 'bookingSessionId'];
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Google enhanced-conversions rules: trim, lowercase, and drop dots from the
// local part of gmail/googlemail addresses. Plus-suffixes are kept.
export function normalizeEmailForEnhancedConversions(email) {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  const parts = normalized.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1] || /\s/.test(normalized)) return null;
  const [local, domain] = parts;
  if (!domain.includes('.')) return null;
  return `${GMAIL_DOMAINS.has(domain) ? local.replace(/\./g, '') : local}@${domain}`;
}

// E.164. A leading + keeps the supplied country code; otherwise US (+1).
export function normalizePhoneForEnhancedConversions(phone) {
  if (phone === null || phone === undefined) return null;
  const raw = String(phone).trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export function hashedUserData({ email, phone } = {}) {
  const normalizedEmail = normalizeEmailForEnhancedConversions(email);
  const normalizedPhone = normalizePhoneForEnhancedConversions(phone);
  const userData = {};
  if (normalizedEmail) userData.sha256_email_address = sha256Hex(normalizedEmail);
  if (normalizedPhone) userData.sha256_phone_number = sha256Hex(normalizedPhone);
  return Object.keys(userData).length > 0 ? userData : null;
}

function sanitizeBareEmpties(text) {
  return text
    .replace(/"(?:lat|lng|latitude|longitude)"\s*:\s*,/g, (m) => m.replace(',', 'null,'))
    .replace(/"(?:lat|lng|latitude|longitude)"\s*:\s*\}/g, (m) => m.replace('}', 'null}'));
}

function parseJobsBody(data) {
  if (data && typeof data === 'object') return data;
  if (typeof data !== 'string') return null;
  try {
    let parsed = JSON.parse(data);
    if (typeof parsed === 'string') parsed = JSON.parse(sanitizeBareEmpties(parsed));
    return parsed;
  } catch {
    try {
      return JSON.parse(sanitizeBareEmpties(data));
    } catch {
      return null;
    }
  }
}

function jobSession(job) {
  for (const field of SESSION_FIELDS) {
    const value = job?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function jobCreatedAt(job) {
  const value = job?.created || job?.created_at || job?.createdAt;
  const time = Date.parse(value || '');
  return Number.isNaN(time) ? null : time;
}

export function bookingRef(customerId, bookingSession) {
  return crypto
    .createHash('sha256')
    .update(`${customerId}:${bookingSession}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Looks up one just-made booking by Zenbooker customer id and exact booking
 * session, and returns only SHA-256 hashes. Plain email/phone never leave this
 * function. Returns { found: false, reason } or { found: true, userData, path }.
 */
function customerMatches(job, customerId) {
  const jobCustomerId = job?.customer?.id || job?.customer_id;
  return Boolean(jobCustomerId) && jobCustomerId === customerId;
}

function withPath(result, path) {
  if (!result?.found) return result;
  return { ...result, path };
}

function hashesFor(job) {
  const userData = hashedUserData({
    email: job.customer?.email || job.customer_email,
    phone: job.customer?.phone || job.customer?.phone_number || job.customer_phone,
  });
  return userData ? { found: true, userData } : { found: false, reason: 'no_identifiers' };
}

function isRetryableUpstreamError(error) {
  const code = error?.code;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ERR_NETWORK') return true;
  const status = error?.response?.status;
  if (typeof status === 'number' && (status >= 500 || status === 429)) return true;
  return false;
}

function upstreamKindFromError(error) {
  const code = error?.code;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'timeout';
  const status = error?.response?.status;
  if (typeof status === 'number') return `http_${status}`;
  if (code === 'ERR_NETWORK' || !error?.response) return 'network';
  return 'network';
}

async function fetchZenbookerJobs({
  baseUrl,
  customerId,
  now,
  apiKey,
  httpClient,
  timeoutMs,
}) {
  const params = new URLSearchParams({
    customer: customerId,
    created_after: new Date(now - BOOKING_WINDOW_MS).toISOString(),
    limit: '100',
  });
  const url = `${baseUrl}/jobs?${params.toString()}`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0',
  };
  const requestConfig = {
    headers,
    transformResponse: [(data) => data],
  };

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptTimeout = attempt === 0 ? timeoutMs : LOOKUP_RETRY_TIMEOUT_MS;
    try {
      const response = await httpClient.get(url, { ...requestConfig, timeout: attemptTimeout });
      return { response, attempts: attempt + 1, lastAttemptTimeout: attemptTimeout };
    } catch (error) {
      lastError = error;
      if (attempt === 0 && isRetryableUpstreamError(error)) continue;
      return {
        error: lastError,
        upstreamKind: upstreamKindFromError(lastError),
        attempts: attempt + 1,
        lastAttemptTimeout: attemptTimeout,
      };
    }
  }
  return {
    error: lastError,
    upstreamKind: upstreamKindFromError(lastError),
    attempts: 2,
    lastAttemptTimeout: LOOKUP_RETRY_TIMEOUT_MS,
  };
}

async function bridgeByStoredJob(store, jobs, customerId, bookingSession) {
  if (typeof store?.getJobIdForSession !== 'function') return null;
  const mappedId = await store.getJobIdForSession(bookingSession);
  if (!mappedId) return null;
  const mapped = jobs.find((job) => String(job?.id) === String(mappedId) && customerMatches(job, customerId));
  return mapped ? withPath(hashesFor(mapped), 'stored') : { found: false, reason: 'not_found' };
}

async function bridgeByUniqueWindow(store, jobs, customerId, bookingSession, windowMs) {
  if (typeof store?.listCaptures !== 'function') return null;
  let wanted = null;
  try {
    wanted = opaqueRef(bookingSession);
  } catch {
    return null;
  }
  const captures = await store.listCaptures(customerId);
  const mine = captures.filter((capture) => capture?.sessionRef === wanted);
  if (mine.length !== 1 || mine[0].customerId !== customerId || !mine[0].capturedAt) return null;
  const anchor = Date.parse(mine[0].capturedAt);
  if (Number.isNaN(anchor)) return null;
  const near = (value) => {
    const time = Date.parse(value || '');
    return !Number.isNaN(time) && Math.abs(time - anchor) <= windowMs;
  };
  const windowJobs = jobs.filter((job) => customerMatches(job, customerId) && near(job?.created || job?.created_at));
  const windowCaptures = captures.filter((capture) => near(capture.capturedAt));
  if (windowJobs.length !== 1 || windowCaptures.length !== 1) return null;
  if (typeof store.saveJobBridge === 'function') {
    await store.saveJobBridge({
      jobId: windowJobs[0].id,
      sessionRef: wanted,
      source: 'window',
      acquisition: mine[0].acquisition,
      gclid: mine[0].gclid,
      gbraid: mine[0].gbraid,
      wbraid: mine[0].wbraid,
    });
  }
  return withPath(hashesFor(windowJobs[0]), 'window');
}

export async function lookupBookingIdentity({
  customerId,
  bookingSession,
  env = process.env,
  httpClient = axios,
  now = Date.now(),
  timeoutMs = LOOKUP_TIMEOUT_MS,
  store = null,
  windowMs = DEFAULT_BRIDGE_WINDOW_MS,
}) {
  const apiKey = env.ZENBOOKER_API_KEY;
  if (!apiKey) return { found: false, reason: 'not_configured' };

  const baseUrl = (env.ZENBOOKER_BASE_URL || DEFAULT_ZENBOOKER_BASE_URL).replace(/\/$/, '');
  const fetched = await fetchZenbookerJobs({
    baseUrl,
    customerId,
    now,
    apiKey,
    httpClient,
    timeoutMs,
  });
  if (fetched.error) {
    return {
      found: false,
      reason: 'upstream_error',
      upstreamKind: fetched.upstreamKind,
      jobsSeen: 0,
    };
  }

  const body = parseJobsBody(fetched.response?.data);
  const jobs = Array.isArray(body?.results) ? body.results : null;
  if (!jobs) {
    return { found: false, reason: 'upstream_error', upstreamKind: 'parse', jobsSeen: 0 };
  }

  const jobsSeen = jobs.length;

  const match = jobs.find((job) => {
    if (jobSession(job) !== bookingSession) return false;
    if (!customerMatches(job, customerId)) return false;
    const created = jobCreatedAt(job);
    return created !== null && now - created <= BOOKING_WINDOW_MS && created <= now + FUTURE_JOB_SLACK_MS;
  });
  if (match) return { ...withPath(hashesFor(match), 'exact_session'), jobsSeen };

  const stored = await bridgeByStoredJob(store, jobs, customerId, bookingSession);
  if (stored) return { ...stored, jobsSeen };

  const windowMatch = await bridgeByUniqueWindow(store, jobs, customerId, bookingSession, windowMs);
  if (windowMatch) return { ...windowMatch, jobsSeen };

  return { found: false, reason: 'not_found', jobsSeen };
}
