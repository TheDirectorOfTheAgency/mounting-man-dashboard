// lib/install-post-gbp-queue.mjs
//
// Durable cloud queue for the source-controlled M1 Google Business Profile
// worker. GitHub Actions never opens the GBP UI. Never Reddit. Update and
// Photos are claimed and completed independently, and all mutations are
// serialized per item.

import { randomUUID } from 'node:crypto';

import { decodeStoredRecord } from './install-post-store.mjs';
import { redactUnsafeText } from './install-post-queue.mjs';
import { ensureCityStamp } from './install-post-copy.mjs';

export const GBP_SCHEMA_VERSION = 2;
export const GBP_ITEM_PREFIX = 'install-post:gbp:item:';
export const GBP_ITEM_LOCK_PREFIX = 'install-post:gbp:lock:';
export const GBP_PENDING_INDEX_KEY = 'install-post:gbp:pending-index';
export const GBP_LEGACY_INDEX_KEY = 'install-post:gbp:legacy-index';
export const GBP_HEARTBEAT_PREFIX = 'install-post:gbp:heartbeat:';

export const GBP_STATUSES = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  POSTED: 'posted',
});

/** Every job needs a GBP Update AND an independent Photos-tab upload. */
export const GBP_REQUIRED_SURFACES = Object.freeze(['update', 'photos']);
export const GBP_SURFACE_STATUSES = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  POSTED: 'posted',
  PENDING_REVIEW: 'pending_review',
  RETRYABLE_FAILURE: 'retryable_failure',
  INDETERMINATE: 'indeterminate',
});

const UPDATE_COMPLETION_STATUSES = new Set([
  GBP_SURFACE_STATUSES.POSTED,
  GBP_SURFACE_STATUSES.PENDING_REVIEW,
  GBP_SURFACE_STATUSES.RETRYABLE_FAILURE,
  GBP_SURFACE_STATUSES.INDETERMINATE,
]);
const PHOTOS_COMPLETION_STATUSES = new Set([
  GBP_SURFACE_STATUSES.POSTED,
  GBP_SURFACE_STATUSES.RETRYABLE_FAILURE,
  GBP_SURFACE_STATUSES.INDETERMINATE,
]);
const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_TTL_MS = 10_000;
const DEFAULT_LOCK_ATTEMPTS = 200;
const DEFAULT_LOCK_RETRY_MS = 2;
const DEFAULT_HEARTBEAT_TTL_SECONDS = 7 * 24 * 60 * 60;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_WORKER_VALUE_RE = /^[A-Za-z0-9._-]+$/;
const BUILD_SHA_RE = /^[0-9a-f]{40}$/;
const LIVE_URL_RE = /^https:\/\/(?:www\.)?themountingman\.com\/installations\/[a-z0-9-]+\/?$/i;
const IMAGE_URL_RE = /^https:\/\/[^\s]+$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const REVISION_RE = /^[a-f0-9]{64}$/i;
const SAFE_PROOF_FIELDS = new Set([
  'account_verified', 'location_verified', 'surface_verified',
  'caption_exact', 'bound_image_preview_visible', 'cta_verified',
  'matching_card', 'pending_review', 'gallery_confirmed', 'image_sha256',
  'observed_at', 'worker_version', 'artifact_id', 'screenshot_sha256',
]);
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;
const ATOMIC_ENQUEUE_SCRIPT = `
if redis.call("exists", KEYS[1]) == 1 then
  redis.call("sadd", KEYS[2], ARGV[2])
  return 0
end
redis.call("set", KEYS[1], ARGV[1], "EX", ARGV[3])
redis.call("sadd", KEYS[2], ARGV[2])
return 1
`;
const FENCED_SAVE_SCRIPT = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call("set", KEYS[2], ARGV[2], "EX", ARGV[5])
if ARGV[4] == "1" then
  redis.call("sadd", KEYS[3], ARGV[3])
else
  redis.call("srem", KEYS[3], ARGV[3])
end
redis.call("del", KEYS[1])
return 1
`;

const PUBLIC_FIELDS = Object.freeze([
  'schemaVersion',
  'slug',
  'caption',
  'live_url',
  'cta_url',
  'image_url',
  'image_sha256',
  'image_path',
  'jobId',
  'revision',
  'queuedAt',
  'status',
  'legacyComplete',
  'required_surfaces',
  'surfaces',
  'skip_photos_when_update_pending',
]);

function cleanText(value, limit) {
  return String(value || '').trim().slice(0, limit);
}

function normalizeNow(value) {
  if (value === undefined || value === null || value === '') return Date.now();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function safeWorkerValue(value, limit) {
  const normalized = cleanText(value, limit);
  return normalized && SAFE_WORKER_VALUE_RE.test(normalized) ? normalized : '';
}

function emptyGbpSurface() {
  return {
    status: GBP_SURFACE_STATUSES.PENDING,
    id: '',
    proof: {},
    attempts: 0,
    lastError: null,
    lastAttemptAt: '',
    completedAt: '',
    lease: null,
  };
}

function safeProof(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const proof = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!SAFE_PROOF_FIELDS.has(key)) continue;
    if (typeof value === 'boolean') proof[key] = value;
    else if (typeof value === 'string') proof[key] = redactUnsafeText(value).slice(0, 160);
  }
  return proof;
}

function validCompletionProof({ item, surface, status, proof }) {
  const common = proof.account_verified === true
    && proof.location_verified === true
    && proof.surface_verified === true
    && proof.matching_card === true
    && proof.image_sha256 === item.image_sha256
    && SHA256_RE.test(proof.image_sha256 || '')
    && SHA256_RE.test(proof.screenshot_sha256 || '')
    && /^[a-f0-9]{8,64}$/i.test(proof.artifact_id || '')
    && safeWorkerValue(proof.worker_version, 80) === proof.worker_version
    && Number.isFinite(Date.parse(proof.observed_at || ''));
  if (!common) return false;
  if (surface === 'update') {
    return proof.caption_exact === true
      && proof.bound_image_preview_visible === true
      && proof.cta_verified === true
      && (status !== GBP_SURFACE_STATUSES.PENDING_REVIEW || proof.pending_review === true);
  }
  return proof.gallery_confirmed === true;
}

function safeError(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    return { reason_code: redactUnsafeText(raw).slice(0, 120) };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const reasonCode = safeWorkerValue(raw.reason_code || raw.code, 120);
  const retryable = typeof raw.retryable === 'boolean' ? raw.retryable : undefined;
  if (!reasonCode && retryable === undefined) return null;
  return {
    ...(reasonCode ? { reason_code: reasonCode } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  };
}

function normalizeLease(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const token = cleanText(raw.token, 200);
  const workerId = safeWorkerValue(raw.workerId, 100);
  const expiresAt = cleanText(raw.expiresAt, 40);
  if (!token || !workerId || !Number.isFinite(Date.parse(expiresAt))) return null;
  return { token, workerId, expiresAt };
}

function normalizeGbpSurface(raw) {
  if (!raw || typeof raw !== 'object') return emptyGbpSurface();
  const status = cleanText(raw.status || GBP_SURFACE_STATUSES.PENDING, 40).toLowerCase();
  if (!Object.values(GBP_SURFACE_STATUSES).includes(status)) return null;
  return {
    status,
    id: cleanText(raw.id, 200),
    proof: safeProof(raw.proof),
    attempts: Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    lastError: safeError(raw.lastError || raw.error),
    lastAttemptAt: cleanText(raw.lastAttemptAt, 40),
    completedAt: cleanText(raw.completedAt, 40),
    lease: normalizeLease(raw.lease),
    ...(raw.legacy === true ? { legacy: true } : {}),
  };
}

export function gbpUpdateLanded(surface) {
  return surface?.status === GBP_SURFACE_STATUSES.POSTED
    || surface?.status === GBP_SURFACE_STATUSES.PENDING_REVIEW;
}

export function gbpSurfacesComplete(surfaces = {}) {
  return gbpUpdateLanded(surfaces.update)
    && surfaces?.photos?.status === GBP_SURFACE_STATUSES.POSTED;
}

export function defaultGbpSurfaces(raw = {}) {
  const existing = raw.surfaces && typeof raw.surfaces === 'object' ? raw.surfaces : {};
  const update = normalizeGbpSurface(existing.update);
  const photos = normalizeGbpSurface(existing.photos);
  if (!update || !photos) return null;
  return { update, photos };
}

function aggregateGbpStatus(surfaces) {
  if (gbpSurfacesComplete(surfaces)) return GBP_STATUSES.POSTED;
  if (GBP_REQUIRED_SURFACES.some((surface) => surfaces?.[surface]?.status === GBP_SURFACE_STATUSES.CLAIMED)) {
    return GBP_STATUSES.CLAIMED;
  }
  return GBP_STATUSES.PENDING;
}

/**
 * Pure compatibility helper. Queue completion uses the token-bound mutation
 * path below; this helper only normalizes one explicit surface report.
 */
export function applyGbpSurfaceCompletion(item = {}, report = {}) {
  const surfaces = defaultGbpSurfaces(item);
  const surface = cleanText(report.surface, 20).toLowerCase();
  const status = cleanText(report.status, 40).toLowerCase();
  if (!surfaces || !GBP_REQUIRED_SURFACES.includes(surface)) return surfaces;
  const allowed = surface === 'update' ? UPDATE_COMPLETION_STATUSES : PHOTOS_COMPLETION_STATUSES;
  if (!allowed.has(status)) return surfaces;
  surfaces[surface] = {
    ...surfaces[surface],
    status,
    id: cleanText(report.id || surfaces[surface].id, 200),
    proof: safeProof(report.proof || surfaces[surface].proof),
    lastError: safeError(report.error),
    lease: null,
  };
  return surfaces;
}

export function normalizeGbpSlug(value) {
  return String(value || '').trim().toLowerCase();
}

export function gbpItemKey(slug) {
  return `${GBP_ITEM_PREFIX}${normalizeGbpSlug(slug)}`;
}

function gbpItemLockKey(slug) {
  return `${GBP_ITEM_LOCK_PREFIX}${normalizeGbpSlug(slug)}`;
}

function heartbeatKey(workerId) {
  return `${GBP_HEARTBEAT_PREFIX}${workerId}`;
}

/** Caption for the M1 worker. CTA is `cta_url` — do not duplicate the URL here. */
export function buildGbpCaption(seed = {}) {
  const city = String(seed.city || '').trim();
  const summary = ensureCityStamp(
    String(seed['post-summary'] || seed.title || '').trim(),
    city,
    seed,
  );
  const price = String(seed.price || '').trim();
  const parts = [summary];
  if (price) parts.push(`Install subtotal: ${price}.`);
  return redactUnsafeText(parts.join('\n\n')).slice(0, 1500);
}

function publicSurface(surface) {
  if (!surface || typeof surface !== 'object') return surface;
  const publicLease = surface.lease
    ? { workerId: surface.lease.workerId, expiresAt: surface.lease.expiresAt }
    : null;
  return { ...surface, lease: publicLease };
}

export function publicGbpView(item = {}) {
  const view = {};
  for (const key of PUBLIC_FIELDS) {
    if (item[key] !== undefined) view[key] = item[key];
  }
  if (view.surfaces) {
    view.surfaces = {
      update: publicSurface(view.surfaces.update),
      photos: publicSurface(view.surfaces.photos),
    };
  }
  if (view.image_path === undefined) view.image_path = null;
  return view;
}

export function sanitizeGbpItem(raw = {}) {
  const slug = normalizeGbpSlug(raw.slug);
  if (!SLUG_RE.test(slug) || slug.length > 180) return null;

  const liveUrl = String(raw.live_url || raw.cta_url || '').trim();
  if (!LIVE_URL_RE.test(liveUrl)) return null;

  const imageUrl = String(raw.image_url || '').trim();
  if (imageUrl && !IMAGE_URL_RE.test(imageUrl)) return null;
  const imageSha256 = cleanText(raw.image_sha256, 64).toLowerCase();
  if (imageSha256 && !SHA256_RE.test(imageSha256)) return null;

  if (raw.schemaVersion !== undefined && ![1, GBP_SCHEMA_VERSION].includes(raw.schemaVersion)) return null;
  const schemaVersion = raw.schemaVersion === GBP_SCHEMA_VERSION ? GBP_SCHEMA_VERSION : 1;
  const hadSurfaces = raw.surfaces && typeof raw.surfaces === 'object';
  const legacyComplete = schemaVersion < GBP_SCHEMA_VERSION
    && raw.status === GBP_STATUSES.POSTED
    && !hadSurfaces;
  const surfaces = defaultGbpSurfaces(raw);
  if (!surfaces) return null;
  const status = legacyComplete ? GBP_STATUSES.POSTED : aggregateGbpStatus(surfaces);
  const jobId = cleanText(raw.jobId, 80);
  const revision = cleanText(raw.revision, 64).toLowerCase();
  if (schemaVersion === GBP_SCHEMA_VERSION) {
    if (!imageUrl || !SHA256_RE.test(imageSha256) || !jobId || !REVISION_RE.test(revision)) return null;
  }

  return {
    schemaVersion,
    slug,
    caption: redactUnsafeText(raw.caption || '').slice(0, 1500),
    live_url: liveUrl,
    cta_url: liveUrl,
    image_url: imageUrl || '',
    image_sha256: imageSha256,
    image_path: null,
    jobId,
    revision,
    queuedAt: cleanText(raw.queuedAt, 40) || new Date().toISOString(),
    status,
    ...(legacyComplete || raw.legacyComplete === true ? { legacyComplete: true } : {}),
    required_surfaces: [...GBP_REQUIRED_SURFACES],
    surfaces,
    skip_photos_when_update_pending: false,
  };
}

/** Website live + a published slug. Social receipts are not required. */
export function gbpPayloadFromRecord(record, { at } = {}) {
  const result = record?.result && typeof record.result === 'object' ? record.result : {};
  const seed = record?.seed && typeof record.seed === 'object' ? record.seed : {};
  return sanitizeGbpItem({
    schemaVersion: GBP_SCHEMA_VERSION,
    slug: result.slug || seed.slug,
    caption: buildGbpCaption(seed),
    live_url: result.liveUrl,
    image_url: result.imageUrl || record?.image?.hostedUrl || '',
    image_sha256: record?.image?.sha256 || '',
    jobId: record?.jobId,
    revision: record?.revision,
    queuedAt: at,
    status: GBP_STATUSES.PENDING,
  });
}

export function shouldEnqueueGbp({ item, existing } = {}) {
  if (!item?.slug || !item.live_url) return { ok: false, reason: 'live_url_required' };
  if (existing?.slug) {
    const posted = existing.status === GBP_STATUSES.POSTED
      || gbpSurfacesComplete(existing.surfaces);
    return { ok: false, reason: posted ? 'already_posted' : 'already_queued' };
  }
  return { ok: true };
}

export function attachGbpQueuedDestination(record, { slug, reason } = {}) {
  if (!record?.result) return record;
  const destinations = Array.isArray(record.result.destinations)
    ? record.result.destinations.filter((entry) => String(entry?.name || '').toLowerCase() !== 'gbp')
    : [];
  destinations.push({
    name: 'gbp',
    status: 'QUEUED',
    detail: reason === 'already_queued' || reason === 'already_posted'
      ? reason
      : String(slug || ''),
  });
  return { ...record, result: { ...record.result, destinations } };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createGbpQueue(kv, {
  ttlSeconds = DEFAULT_TTL_SECONDS,
  leaseMs = DEFAULT_LEASE_MS,
  lockTtlMs = DEFAULT_LOCK_TTL_MS,
  lockAttempts = DEFAULT_LOCK_ATTEMPTS,
  lockRetryMs = DEFAULT_LOCK_RETRY_MS,
  heartbeatTtlSeconds = DEFAULT_HEARTBEAT_TTL_SECONDS,
  tokenFactory = randomUUID,
} = {}) {
  for (const method of ['get', 'set', 'del', 'eval', 'sadd', 'srem', 'smembers']) {
    if (typeof kv?.[method] !== 'function') throw new Error(`KV adapter is missing ${method}`);
  }

  async function loadItem(slug) {
    const normalized = normalizeGbpSlug(slug);
    if (!SLUG_RE.test(normalized)) return null;
    return decodeStoredRecord(await kv.get(gbpItemKey(normalized)));
  }

  async function saveItem(item, lock) {
    const sanitized = sanitizeGbpItem(item);
    if (!sanitized) throw new Error('invalid_gbp_item');
    if (!lock?.key || !lock?.token) throw new Error('item_lock_required');
    const pending = sanitized.status !== GBP_STATUSES.POSTED
      && !gbpSurfacesComplete(sanitized.surfaces);
    const committed = await kv.eval(
      FENCED_SAVE_SCRIPT,
      [lock.key, gbpItemKey(sanitized.slug), GBP_PENDING_INDEX_KEY],
      [lock.token, JSON.stringify(sanitized), sanitized.slug, pending ? '1' : '0', String(ttlSeconds)],
    );
    return committed === 1 ? sanitized : null;
  }

  async function withItemLock(slug, mutation) {
    const lockKey = gbpItemLockKey(slug);
    const lockToken = tokenFactory();
    let acquired = false;
    for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
      const result = await kv.set(lockKey, lockToken, { nx: true, px: lockTtlMs });
      if (result) {
        acquired = true;
        break;
      }
      await delay(lockRetryMs);
    }
    if (!acquired) return { ok: false, reason: 'lock_busy' };
    try {
      return await mutation({ key: lockKey, token: lockToken });
    } finally {
      await kv.eval(RELEASE_LOCK_SCRIPT, [lockKey], [lockToken]);
    }
  }

  async function enqueue(input) {
    const item = sanitizeGbpItem(input);
    const decision = shouldEnqueueGbp({ item, existing: item ? await loadItem(item.slug) : null });
    if (!decision.ok) {
      return {
        queued: false,
        reason: decision.reason,
        item: decision.reason === 'live_url_required'
          ? null
          : publicGbpView(await loadItem(input?.slug) || item || {}),
      };
    }
    const wrote = await kv.eval(
      ATOMIC_ENQUEUE_SCRIPT,
      [gbpItemKey(item.slug), GBP_PENDING_INDEX_KEY],
      [JSON.stringify(item), item.slug, String(ttlSeconds)],
    );
    if (wrote !== 1) {
      const existing = await loadItem(item.slug);
      const posted = existing?.status === GBP_STATUSES.POSTED
        || gbpSurfacesComplete(existing?.surfaces);
      return {
        queued: false,
        reason: posted ? 'already_posted' : 'already_queued',
        item: publicGbpView(existing || item),
      };
    }
    return { queued: true, reason: 'queued', item: publicGbpView(item) };
  }

  async function listPending() {
    const members = await kv.smembers(GBP_PENDING_INDEX_KEY);
    const slugs = Array.isArray(members) ? members : [];
    const items = [];
    for (const slug of slugs) {
      const item = await loadItem(slug);
      if (!item || item.status === GBP_STATUSES.POSTED || gbpSurfacesComplete(item.surfaces)) {
        await kv.srem(GBP_PENDING_INDEX_KEY, slug);
        continue;
      }
      const sanitized = sanitizeGbpItem(item);
      if (!sanitized) {
        // Unknown schemas/statuses fail closed: keep the durable row, but do not
        // hand malformed work to the browser worker.
        continue;
      }
      if (sanitized.schemaVersion !== GBP_SCHEMA_VERSION) {
        await kv.sadd(GBP_LEGACY_INDEX_KEY, sanitized.slug);
        await kv.srem(GBP_PENDING_INDEX_KEY, sanitized.slug);
        continue;
      }
      items.push(publicGbpView(sanitized));
    }
    items.sort((left, right) => Date.parse(left.queuedAt || 0) - Date.parse(right.queuedAt || 0));
    return items;
  }

  async function claim(slug, { surface, workerId, now } = {}) {
    const normalizedSurface = cleanText(surface, 20).toLowerCase();
    if (!GBP_REQUIRED_SURFACES.includes(normalizedSurface)) return { ok: false, reason: 'invalid_surface' };
    const safeWorkerId = safeWorkerValue(workerId, 100);
    if (!safeWorkerId) return { ok: false, reason: 'worker_id_required' };
    const nowMs = normalizeNow(now);
    if (!Number.isFinite(nowMs)) return { ok: false, reason: 'invalid_now' };

    return withItemLock(slug, async (lock) => {
      const current = await loadItem(slug);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.status === GBP_STATUSES.POSTED) {
        return { ok: false, reason: 'already_posted', item: publicGbpView(current) };
      }
      const surfaces = defaultGbpSurfaces(current);
      if (!surfaces) return { ok: false, reason: 'schema_mismatch' };
      const selected = surfaces[normalizedSurface];
      if (normalizedSurface === 'update' ? gbpUpdateLanded(selected) : selected.status === GBP_SURFACE_STATUSES.POSTED) {
        return { ok: false, reason: 'surface_complete' };
      }
      if (selected.lease && Date.parse(selected.lease.expiresAt) > nowMs) {
        return { ok: false, reason: 'lease_active' };
      }

      const leaseToken = tokenFactory();
      const at = new Date(nowMs).toISOString();
      surfaces[normalizedSurface] = {
        ...selected,
        status: GBP_SURFACE_STATUSES.CLAIMED,
        attempts: selected.attempts + 1,
        lastAttemptAt: at,
        lease: {
          token: leaseToken,
          workerId: safeWorkerId,
          expiresAt: new Date(nowMs + leaseMs).toISOString(),
        },
      };
      const next = await saveItem({ ...current, surfaces, status: aggregateGbpStatus(surfaces) }, lock);
      if (!next) return { ok: false, reason: 'lock_lost' };
      return { ok: true, item: publicGbpView(next), leaseToken };
    });
  }

  async function complete(slug, report = {}) {
    const nowMs = normalizeNow(report.now);
    if (!Number.isFinite(nowMs)) return { ok: false, reason: 'invalid_now' };

    return withItemLock(slug, async (lock) => {
      const current = await loadItem(slug);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.status === GBP_STATUSES.POSTED) {
        return { ok: false, reason: 'already_posted', item: publicGbpView(current) };
      }
      const surfaces = defaultGbpSurfaces(current);
      if (!surfaces) return { ok: false, reason: 'schema_mismatch' };
      const schemaVersion = current.schemaVersion === GBP_SCHEMA_VERSION ? GBP_SCHEMA_VERSION : 1;
      const normalizedSurface = cleanText(report.surface, 20).toLowerCase();

      // The only tokenless compatibility path is the historical no-surface
      // completion request, and it records Update only. Schema v2 can never use it.
      if (!normalizedSurface && schemaVersion < GBP_SCHEMA_VERSION) {
        surfaces.update = {
          ...surfaces.update,
          status: GBP_SURFACE_STATUSES.POSTED,
          id: cleanText(report.id || surfaces.update.id, 200),
          lease: null,
          completedAt: new Date(nowMs).toISOString(),
          legacy: true,
        };
        const next = await saveItem({ ...current, surfaces, status: aggregateGbpStatus(surfaces) }, lock);
        if (!next) return { ok: false, reason: 'lock_lost' };
        return { ok: true, item: publicGbpView(next) };
      }

      if (!normalizedSurface) return { ok: false, reason: 'surface_required' };
      if (!GBP_REQUIRED_SURFACES.includes(normalizedSurface)) return { ok: false, reason: 'invalid_surface' };
      const status = cleanText(report.status, 40).toLowerCase();
      const allowed = normalizedSurface === 'update' ? UPDATE_COMPLETION_STATUSES : PHOTOS_COMPLETION_STATUSES;
      if (!allowed.has(status)) return { ok: false, reason: 'invalid_status' };
      const proof = safeProof(report.proof);
      const proofRequired = status === GBP_SURFACE_STATUSES.POSTED
        || status === GBP_SURFACE_STATUSES.PENDING_REVIEW;
      if (proofRequired && Object.keys(proof).length === 0) {
        return { ok: false, reason: 'proof_required' };
      }
      if (proofRequired && !validCompletionProof({
        item: current,
        surface: normalizedSurface,
        status,
        proof,
      })) {
        return { ok: false, reason: 'invalid_proof' };
      }
      const leaseToken = cleanText(report.leaseToken, 200);
      if (!leaseToken) return { ok: false, reason: 'lease_token_required' };
      const selected = surfaces[normalizedSurface];
      if (!selected.lease || selected.lease.token !== leaseToken) {
        return { ok: false, reason: 'lease_token_mismatch' };
      }
      if (Date.parse(selected.lease.expiresAt) <= nowMs) {
        return { ok: false, reason: 'lease_expired' };
      }

      const successful = status === GBP_SURFACE_STATUSES.POSTED
        || status === GBP_SURFACE_STATUSES.PENDING_REVIEW;
      surfaces[normalizedSurface] = {
        ...selected,
        status,
        id: cleanText(report.id || selected.id, 200),
        proof: Object.keys(proof).length > 0 ? proof : selected.proof,
        lastError: successful ? null : (safeError(report.error) || selected.lastError),
        completedAt: new Date(nowMs).toISOString(),
        lease: null,
      };
      const next = await saveItem({ ...current, surfaces, status: aggregateGbpStatus(surfaces) }, lock);
      if (!next) return { ok: false, reason: 'lock_lost' };
      return { ok: true, item: publicGbpView(next) };
    });
  }

  async function heartbeat({ workerId, version, buildSha, now } = {}) {
    const safeWorkerId = safeWorkerValue(workerId, 100);
    if (!safeWorkerId) return { ok: false, reason: 'worker_id_required' };
    const safeVersion = safeWorkerValue(version, 80);
    if (!safeVersion) return { ok: false, reason: 'version_required' };
    const safeBuildSha = cleanText(buildSha, 40).toLowerCase();
    if (!BUILD_SHA_RE.test(safeBuildSha)) return { ok: false, reason: 'build_sha_required' };
    const nowMs = normalizeNow(now);
    if (!Number.isFinite(nowMs)) return { ok: false, reason: 'invalid_now' };
    const heartbeatRecord = {
      workerId: safeWorkerId,
      version: safeVersion,
      buildSha: safeBuildSha,
      seenAt: new Date(nowMs).toISOString(),
    };
    await kv.set(heartbeatKey(safeWorkerId), JSON.stringify(heartbeatRecord), { ex: heartbeatTtlSeconds });
    return { ok: true, heartbeat: heartbeatRecord };
  }

  async function getHeartbeat(workerId) {
    const safeWorkerId = safeWorkerValue(workerId, 100);
    if (!safeWorkerId) return { ok: false, reason: 'worker_id_required' };
    const parsed = decodeStoredRecord(await kv.get(heartbeatKey(safeWorkerId)));
    if (
      !parsed
      || parsed.workerId !== safeWorkerId
      || !safeWorkerValue(parsed.version, 80)
      || !BUILD_SHA_RE.test(cleanText(parsed.buildSha, 40).toLowerCase())
      || !Number.isFinite(Date.parse(parsed.seenAt))
    ) {
      return { ok: false, reason: 'heartbeat_not_found' };
    }
    return {
      ok: true,
      heartbeat: {
        workerId: safeWorkerId,
        version: parsed.version,
        buildSha: parsed.buildSha,
        seenAt: parsed.seenAt,
      },
    };
  }

  return { enqueue, listPending, claim, complete, heartbeat, getHeartbeat, loadItem };
}

export async function enqueueGbpAfterPublish({ queue, record, at } = {}) {
  if (!queue || typeof queue.enqueue !== 'function') {
    return { queued: false, reason: 'queue_unavailable', item: null };
  }
  const item = gbpPayloadFromRecord(record, { at });
  if (!item) return { queued: false, reason: 'live_url_required', item: null };
  return queue.enqueue(item);
}

let cachedQueue;

/** Lazily build the production GBP queue. Returns null when Upstash is unset. */
export async function getInstallPostGbpQueue() {
  if (cachedQueue !== undefined) return cachedQueue;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    cachedQueue = null;
    return cachedQueue;
  }
  const { kv } = await import('@vercel/kv');
  cachedQueue = createGbpQueue(kv);
  return cachedQueue;
}
