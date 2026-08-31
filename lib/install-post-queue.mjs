// lib/install-post-queue.mjs
//
// Pure protocol for the cloud installation-post queue. No I/O, no credentials.
//
// Every value that reaches a browser, a Discord message, a workflow dispatch or
// a log line passes through here first, so the allowlists below are the single
// place that decides what counts as a safe installation fact.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { sanitizeLinkedInDestination } from './install-post-linkedin.mjs';
import { sanitizeStreetName } from './install-post-seeds.mjs';
import { INSTALL_POST_STATES, STALE_PUBLISH_MS } from './install-post-states.mjs';

export {
  INSTALL_POST_STATES,
  STALE_PUBLISH_MS,
  installPostPollDelayMs,
} from './install-post-states.mjs';

/** Seed keys the publisher needs and the operator is allowed to see. */
export const SAFE_SEED_FIELDS = Object.freeze([
  'city',
  'state',
  'job-type',
  'title',
  'slug',
  'post-summary',
  'post-body',
  'tv-size',
  'tv-brand',
  'wall-surface',
  'metro-area',
  'location-id',
  'gallery-style',
  'fireplace-type',
  'mantelmount',
  'price',
  'performed-by',
  'street-name',
  'mount-type',
  'room-type',
  'bracket-type',
  'hardware-used',
  'cable-management',
  'soundbar-mounting',
  'job-notes',
  'local-reference',
  'nearby-cities',
  'seed-index',
  'seed-count',
  'trigger-status',
  'trigger-source-code',
  'trigger-event',
]);

/** Subset of safe fields Mr. Wayne can correct from the phone card. */
export const CORRECTABLE_SEED_FIELDS = Object.freeze([
  'city',
  'state',
  'tv-size',
  'tv-brand',
  'wall-surface',
  'gallery-style',
  'fireplace-type',
  'mantelmount',
  'price',
  'performed-by',
  'street-name',
  'mount-type',
  'room-type',
  'bracket-type',
  'hardware-used',
  'cable-management',
  'soundbar-mounting',
  'local-reference',
]);

const SAFE_SEED_FIELD_SET = new Set(SAFE_SEED_FIELDS);
const CORRECTABLE_SEED_FIELD_SET = new Set(CORRECTABLE_SEED_FIELDS);
const STREET_LIKE_FIELDS = new Set(['street-name', 'local-reference']);

const RESULT_FIELDS = Object.freeze([
  'status', 'liveUrl', 'imageUrl', 'itemId', 'slug', 'publicStatus', 'message', 'destinations',
]);
const RESULT_STATUSES = new Set([
  INSTALL_POST_STATES.PUBLISHED,
  INSTALL_POST_STATES.RETRYABLE_FAILURE,
  INSTALL_POST_STATES.BLOCKED,
  INSTALL_POST_STATES.INDETERMINATE,
]);

// Distinct versions are the domain separator: each is covered by the signature,
// so a capability can never be replayed as a session, or the reverse.
const CAPABILITY_VERSION = 'v1';
const SESSION_VERSION = 's1';

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const CREDENTIAL_RE = /\b(token|secret|key|password|authorization|signature)\b(\s*[:=]\s*|\s+)["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi;

/** Strip contact details and credential-looking values out of free text. */
export function redactUnsafeText(value) {
  return String(value ?? '')
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(CREDENTIAL_RE, (_match, label) => `${label}=[redacted]`)
    .replace(EMAIL_RE, '[redacted]')
    .replace(PHONE_RE, '[redacted]');
}

function safeSeedValue(key, value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === 'string').map((entry) => redactUnsafeText(entry));
  }
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const text = STREET_LIKE_FIELDS.has(key) ? sanitizeStreetName(value) : value;
  return redactUnsafeText(text);
}

/** Reduce any seed-shaped object to allowlisted, redacted installation facts. */
export function safeSeed(seed = {}) {
  const result = {};
  for (const key of SAFE_SEED_FIELDS) {
    const raw = seed?.[key];
    if (raw === undefined || raw === null) continue;
    const value = safeSeedValue(key, raw);
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Recognizable card labels
// ---------------------------------------------------------------------------

/** One-line label an operator can match to the TV standing in front of him. */
export function cardLabel(record = {}) {
  const seed = safeSeed(record.seed || {});
  const tv = [seed['tv-size'], seed['tv-brand']].filter(Boolean).join(' ');
  const surface = [seed['wall-surface'], seed['fireplace-type']].filter(Boolean).join(' / ');
  const place = [seed['street-name'], seed.city].filter(Boolean).join(', ');
  const count = Number(seed['seed-count'] || 0);
  const index = Number(seed['seed-index'] || 0);

  const jobType = String(seed['job-type'] || '').toLowerCase();
  const fallback = jobType === 'unmount' ? 'TV unmounting' : 'TV installation';
  return [
    tv || fallback,
    seed['mount-type'] || seed['bracket-type'] || '',
    surface,
    place,
    seed.price || '',
    count > 1 && index > 0 ? `TV ${index} of ${count}` : '',
  ].filter(Boolean).join(' · ');
}

/** Exactly what the phone card is allowed to render. */
export function publicJobView(record = {}) {
  const image = record.image
    ? {
      sha256: record.image.sha256,
      bytes: record.image.bytes,
      contentType: record.image.contentType,
      previewUrl: record.image.hostedUrl || '',
      uploadedAt: record.image.uploadedAt || '',
    }
    : null;

  return {
    jobId: record.jobId,
    state: record.state,
    label: cardLabel(record),
    seed: safeSeed(record.seed || {}),
    revision: record.revision,
    image,
    result: record.result || null,
    approvedAt: record.approval?.approvedAt || null,
    correctableFields: [...CORRECTABLE_SEED_FIELDS],
    updatedAt: record.updatedAt || record.createdAt || null,
  };
}

const REASON_STATUS = Object.freeze({
  not_found: 404,
  unavailable: 503,
  locked: 409,
  stale_revision: 409,
  duplicate_publish: 409,
  already_published: 409,
  publish_in_flight: 409,
  reconcile_required: 409,
  not_reconcilable: 409,
  not_stale: 409,
  dispatch_mismatch: 409,
  upload_not_found: 409,
  digest_mismatch: 409,
  photo_required: 400,
  field_not_correctable: 400,
  empty_patch: 400,
  invalid_image: 400,
  unsupported_event: 400,
});

/** Map a transition/store refusal to the HTTP status an API route returns. */
export function statusForReason(reason) {
  return REASON_STATUS[reason] || 400;
}

// ---------------------------------------------------------------------------
// Deterministic revision hashing
// ---------------------------------------------------------------------------

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalImage(image) {
  if (!image || typeof image !== 'object') return null;
  const sha256 = String(image.sha256 || '').trim().toLowerCase();
  if (!sha256) return null;
  return {
    sha256,
    bytes: Number(image.bytes || 0),
    contentType: String(image.contentType || '').trim().toLowerCase(),
  };
}

/**
 * Hash of exactly what would be published: the safe seed plus the bound photo.
 * Any change to either produces a different revision, which invalidates any
 * approval that referenced the old one.
 */
export function canonicalRevision({ seed, image } = {}) {
  const payload = canonicalize({ seed: safeSeed(seed || {}), image: canonicalImage(image) });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ---------------------------------------------------------------------------
// Signed job capability and operator session tokens
// ---------------------------------------------------------------------------

function sign(secret, data) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function mintToken({ version, claims, secret }) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${version}.${payload}.${sign(secret, `${version}.${payload}`)}`;
}

/** Open a signed token of one exact version. Fails closed on every surprise. */
function openToken(token, { version, secret, now }) {
  if (!secret) return { ok: false, reason: 'unconfigured' };
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== version || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed' };
  }
  const [, payload, signature] = parts;
  if (!safeEqual(signature, sign(secret, `${version}.${payload}`))) {
    return { ok: false, reason: 'bad_signature' };
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!claims?.jobId) return { ok: false, reason: 'malformed' };
  if (!Number.isFinite(claims.exp) || Math.floor(now) >= claims.exp) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, jobId: String(claims.jobId), expiresAt: claims.exp };
}

/**
 * Mint a job-scoped capability. Carries no customer data.
 *
 * It travels in the URL *fragment* of the operator link, so it never reaches a
 * server, proxy, or access log. The browser trades it once for a session.
 */
export function signJobCapability({ jobId, secret, issuedAt = Date.now(), ttlSeconds = 172800 } = {}) {
  if (!secret) throw new Error('install-post capability secret is not configured');
  if (!jobId) throw new Error('jobId is required');
  // `iat`/`exp` are epoch milliseconds, matching the `now` the verifier is given.
  const issued = Math.floor(issuedAt);
  return mintToken({
    version: CAPABILITY_VERSION,
    secret,
    claims: { jobId: String(jobId), iat: issued, exp: issued + Math.floor(ttlSeconds) * 1000 },
  });
}

/** Verify a capability token. */
export function verifyJobCapability(token, { secret, now = Date.now() } = {}) {
  return openToken(token, { version: CAPABILITY_VERSION, secret, now });
}

/**
 * Mint the cookie-borne operator session a capability is exchanged for.
 *
 * It expires at exactly the capability's own `exp`, so moving the credential
 * out of the URL cannot quietly extend the 48 hour window.
 */
export function signOperatorSession({ jobId, secret, expiresAt } = {}) {
  if (!secret) throw new Error('install-post session secret is not configured');
  if (!jobId) throw new Error('jobId is required');
  if (!Number.isFinite(expiresAt)) throw new Error('expiresAt is required');
  return mintToken({
    version: SESSION_VERSION,
    secret,
    claims: { jobId: String(jobId), exp: Math.floor(expiresAt) },
  });
}

/** Verify an operator session token. */
export function verifyOperatorSession(token, { secret, now = Date.now() } = {}) {
  return openToken(token, { version: SESSION_VERSION, secret, now });
}

/**
 * One `Add photo & publish` link per staged TV.
 *
 * The link is the whole operator handoff: a recognizable label plus a bootstrap
 * URL whose *fragment* carries the job-scoped capability. Fragments are never
 * sent to a server, so no request line, referrer, or access log can record it.
 * Returns [] when the queue is not configured, so the existing notification
 * degrades instead of breaking.
 */
export function buildOperatorLinks({
  records = [],
  secret,
  baseUrl,
  issuedAt = Date.now(),
  ttlSeconds = 172800,
} = {}) {
  const root = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!secret || !root) return [];
  return records.map((record) => ({
    jobId: record.jobId,
    label: cardLabel(record),
    url: `${root}/install-posts/open#${signJobCapability({
      jobId: record.jobId,
      secret,
      issuedAt,
      ttlSeconds,
    })}`,
  }));
}

/** The Discord operator block. Safe labels and links only — never raw JSON. */
export function formatOperatorLinkBlock(links = []) {
  if (!links.length) return '';
  return [
    `**📱 Add photo & publish**${links.length > 1 ? ` — ${links.length} TVs, one link each` : ''}`,
    ...links.map((link) => `  • ${link.label} → ${link.url}`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Result sanitization
// ---------------------------------------------------------------------------

function sanitizeDestinations(destinations) {
  if (!Array.isArray(destinations)) return undefined;
  return destinations.slice(0, 12).map((entry) => sanitizeLinkedInDestination({
    name: redactUnsafeText(entry?.name || '').slice(0, 60),
    status: redactUnsafeText(entry?.status || '').slice(0, 40),
    detail: redactUnsafeText(entry?.detail || '').slice(0, 300),
  }));
}

/**
 * Published destination receipts that must survive reconcile.
 *
 * `result` is cleared when a retry starts so the card does not show the old
 * outcome, but Instagram/Facebook/LinkedIn/X that already posted for this
 * slug must not be posted again.
 */
export function collectPostedDestinations(...sources) {
  const byName = new Map();
  for (const source of sources) {
    const list = sanitizeDestinations(source);
    if (!list) continue;
    for (const entry of list) {
      const published = entry.status === INSTALL_POST_STATES.PUBLISHED;
      const linkedinBarrier = entry.name === 'linkedin'
        && entry.status === INSTALL_POST_STATES.INDETERMINATE;
      if (!entry.name || (!published && !linkedinBarrier)) continue;
      byName.set(entry.name, entry);
    }
  }
  return [...byName.values()];
}

/**
 * Reduce a runner result to reportable fields.
 *
 * Publisher acknowledgement is not success: PUBLISHED is only preserved when a
 * public URL was read back with HTTP 200. Anything else degrades to
 * INDETERMINATE so it gets reconciled rather than silently trusted.
 */
export function sanitizePublishResult(result) {
  const source = result && typeof result === 'object' ? result : {};
  const declared = String(source.status || '').toUpperCase();
  let status = RESULT_STATUSES.has(declared) ? declared : INSTALL_POST_STATES.BLOCKED;

  const liveUrl = String(source.liveUrl || '').trim();
  const publicStatus = Number(source.publicStatus || 0);
  if (status === INSTALL_POST_STATES.PUBLISHED && !(liveUrl && publicStatus === 200)) {
    status = INSTALL_POST_STATES.INDETERMINATE;
  }

  const values = {
    status,
    liveUrl: liveUrl || undefined,
    imageUrl: String(source.imageUrl || '').trim() || undefined,
    itemId: String(source.itemId || '').trim() || undefined,
    slug: String(source.slug || '').trim() || undefined,
    publicStatus: Number.isFinite(publicStatus) && publicStatus > 0 ? publicStatus : undefined,
    message: source.message === undefined || source.message === null
      ? undefined
      : redactUnsafeText(source.message).slice(0, 600),
    destinations: sanitizeDestinations(source.destinations),
  };

  const sanitized = {};
  for (const key of RESULT_FIELDS) {
    if (values[key] !== undefined) sanitized[key] = values[key];
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Workflow transitions
// ---------------------------------------------------------------------------

function restingState(image) {
  return image ? INSTALL_POST_STATES.READY : INSTALL_POST_STATES.AWAITING_PHOTO;
}

function normalizeRecord(record = {}) {
  const seed = safeSeed(record.seed || {});
  const image = canonicalImage(record.image)
    ? { ...record.image, ...canonicalImage(record.image) }
    : null;
  return {
    ...record,
    seed,
    image,
    revision: canonicalRevision({ seed, image }),
    approval: record.approval || null,
    lease: record.lease || null,
    result: record.result || null,
    postedDestinations: collectPostedDestinations(record.postedDestinations),
    state: record.state || restingState(image),
  };
}

function reject(record, reason) {
  return { ok: false, reason, record };
}

const IN_FLIGHT_STATES = new Set([INSTALL_POST_STATES.PUBLISHING, INSTALL_POST_STATES.VERIFYING]);

/**
 * Apply one workflow event. Pure: returns the next record instead of mutating.
 *
 * Guarantees relied on by the API routes:
 *  - a published job is terminal,
 *  - any seed or photo change clears approval and produces a new revision,
 *  - one publish lease exists per revision, so a duplicate tap cannot dispatch,
 *  - an indeterminate outcome blocks a blind retry and freezes the approved
 *    binding until it has been reconciled at that same revision.
 */
export function transitionRecord(record, event = {}) {
  const current = normalizeRecord(record);
  const at = event.at || new Date().toISOString();

  if (event.type === 'import') {
    const seed = current.seed;
    const image = current.image;
    return {
      ok: true,
      record: {
        ...current,
        state: restingState(image),
        approval: null,
        lease: null,
        result: null,
        postedDestinations: [],
        revision: canonicalRevision({ seed, image }),
      },
    };
  }

  if (current.state === INSTALL_POST_STATES.PUBLISHED) {
    return reject(current, 'already_published');
  }

  switch (event.type) {
    case 'correct': {
      if (IN_FLIGHT_STATES.has(current.state)) return reject(current, 'publish_in_flight');
      // Editing an unresolved job would move the revision away from the post
      // that may already be live, so reconciliation has to happen first.
      if (current.state === INSTALL_POST_STATES.INDETERMINATE) {
        return reject(current, 'reconcile_required');
      }
      const patch = event.patch && typeof event.patch === 'object' ? event.patch : {};
      const keys = Object.keys(patch);
      if (!keys.length) return reject(current, 'empty_patch');
      if (keys.some((key) => !CORRECTABLE_SEED_FIELD_SET.has(key))) {
        return reject(current, 'field_not_correctable');
      }
      const seed = safeSeed({ ...current.seed, ...patch });
      return {
        ok: true,
        record: {
          ...current,
          seed,
          revision: canonicalRevision({ seed, image: current.image }),
          approval: null,
          lease: null,
          result: null,
          postedDestinations: [],
          state: restingState(current.image),
          updatedAt: at,
        },
      };
    }

    case 'photo': {
      if (IN_FLIGHT_STATES.has(current.state)) return reject(current, 'publish_in_flight');
      if (current.state === INSTALL_POST_STATES.INDETERMINATE) {
        return reject(current, 'reconcile_required');
      }
      const image = canonicalImage(event.image);
      if (!image) return reject(current, 'invalid_image');
      const bound = { ...event.image, ...image, uploadedAt: event.image?.uploadedAt || at };
      return {
        ok: true,
        record: {
          ...current,
          image: bound,
          revision: canonicalRevision({ seed: current.seed, image: bound }),
          approval: null,
          lease: null,
          result: null,
          postedDestinations: [],
          state: INSTALL_POST_STATES.READY,
          updatedAt: at,
        },
      };
    }

    case 'approve': {
      if (current.state === INSTALL_POST_STATES.INDETERMINATE) {
        return reject(current, 'reconcile_required');
      }
      if (!current.image) return reject(current, 'photo_required');
      if (event.revision !== current.revision) return reject(current, 'stale_revision');
      if (current.lease && current.lease.revision === current.revision) {
        return reject(current, 'duplicate_publish');
      }
      return {
        ok: true,
        record: {
          ...current,
          approval: {
            revision: current.revision,
            imageSha256: current.image.sha256,
            approvedAt: at,
          },
          lease: {
            revision: current.revision,
            dispatchId: String(event.dispatchId || ''),
            claimedAt: at,
          },
          result: null,
          state: INSTALL_POST_STATES.PUBLISHING,
          updatedAt: at,
        },
      };
    }

    case 'progress': {
      if (!IN_FLIGHT_STATES.has(current.state)) return reject(current, 'not_publishing');
      if (event.state !== INSTALL_POST_STATES.VERIFYING) return reject(current, 'unsupported_progress');
      return { ok: true, record: { ...current, state: INSTALL_POST_STATES.VERIFYING, updatedAt: at } };
    }

    case 'result': {
      const sanitized = sanitizePublishResult(event.result);
      // An unresolved run keeps both halves of its binding: the approval so a
      // reconcile stays pinned to the exact seed+photo that may already be
      // live, and the lease so nothing else can dispatch that revision.
      const unresolved = sanitized.status === INSTALL_POST_STATES.INDETERMINATE;
      return {
        ok: true,
        record: {
          ...current,
          state: sanitized.status,
          result: sanitized,
          postedDestinations: collectPostedDestinations(
            current.postedDestinations,
            sanitized.destinations,
          ),
          approval: unresolved ? current.approval : null,
          lease: unresolved ? current.lease : null,
          updatedAt: at,
        },
      };
    }

    case 'reconcile': {
      if (current.state !== INSTALL_POST_STATES.INDETERMINATE) {
        return reject(current, 'not_reconcilable');
      }
      // Reconciliation re-runs the *same* approval; it never re-approves. The
      // runner reuses an existing post for this photo instead of duplicating.
      if (!current.approval || current.approval.revision !== current.revision) {
        return reject(current, 'stale_revision');
      }
      if (event.revision !== current.revision) return reject(current, 'stale_revision');
      if (!current.image) return reject(current, 'photo_required');
      return {
        ok: true,
        record: {
          ...current,
          lease: {
            revision: current.revision,
            dispatchId: String(event.dispatchId || ''),
            claimedAt: at,
          },
          postedDestinations: collectPostedDestinations(
            current.postedDestinations,
            current.result?.destinations,
          ),
          result: null,
          state: INSTALL_POST_STATES.PUBLISHING,
          updatedAt: at,
        },
      };
    }

    case 'timeout': {
      if (!IN_FLIGHT_STATES.has(current.state)) return reject(current, 'not_stale');
      const startedAt = Date.parse(current.updatedAt || current.createdAt || '');
      const staleAfter = Number.isFinite(event.staleAfterMs) ? event.staleAfterMs : STALE_PUBLISH_MS;
      if (!Number.isFinite(startedAt) || Date.parse(at) - startedAt < staleAfter) {
        return reject(current, 'not_stale');
      }
      // The run is gone but its post may exist, so this is genuinely unknown
      // rather than a failure — it lands where reconciliation can pick it up.
      return {
        ok: true,
        record: {
          ...current,
          state: INSTALL_POST_STATES.INDETERMINATE,
          result: sanitizePublishResult({
            status: INSTALL_POST_STATES.INDETERMINATE,
            message: 'The cloud run reported nothing before its publish window closed',
          }),
          updatedAt: at,
        },
      };
    }

    default:
      return reject(current, 'unsupported_event');
  }
}
