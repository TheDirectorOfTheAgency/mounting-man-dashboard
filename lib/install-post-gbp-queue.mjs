// lib/install-post-gbp-queue.mjs
//
// Queue Google Business Profile work for the existing M1 worker.
//
// Hermes wrote ~/.hermes/tmp/mounting-man-installation-posts/gbp-queue/pending/{slug}.json
// (caption, image_path, cta_url, gbp_cta_url). After the cloud runner took over,
// that file never landed on the M1, so the Photos tab went stale even while
// launchd com.themountingman.gbp-worker stayed healthy.
//
// Every live install post enqueues TWO independent items:
//   1. kind=update  — GBP Update (caption + CTA + image). upload_photo=true so
//      the worker still uploads the photo after the Update, even if Google
//      leaves the Update in pending-review.
//   2. kind=photos  — Photos-tab upload. photo_only + skip_update. This is
//      not the Update. Completing or delaying the Update must not skip it.
//
// Official localPosts API is SERVICE_DISABLED. GitHub Actions must not open
// the Google Business Profile UI. Never Reddit. Do not change GBP website or NAP.

import { decodeStoredRecord } from './install-post-store.mjs';
import { redactUnsafeText } from './install-post-queue.mjs';

export const GBP_ITEM_PREFIX = 'install-post:gbp:item:';
export const GBP_PENDING_INDEX_KEY = 'install-post:gbp:pending-index';

export const GBP_STATUSES = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  POSTED: 'posted',
});

export const GBP_KINDS = Object.freeze({
  UPDATE: 'update',
  PHOTOS: 'photos',
});

const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIVE_URL_RE = /^https:\/\/(?:www\.)?themountingman\.com\/installations\/[a-z0-9-]+\/?$/i;
const IMAGE_URL_RE = /^https:\/\/[^\s]+$/i;

const PUBLIC_FIELDS = Object.freeze([
  'id',
  'slug',
  'kind',
  'caption',
  'live_url',
  'cta_url',
  'gbp_cta_url',
  'image_url',
  'image_path',
  'upload_photo',
  'photo_only',
  'skip_update',
  'jobId',
  'queuedAt',
  'status',
]);

export function normalizeGbpSlug(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizeGbpKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return Object.values(GBP_KINDS).includes(kind) ? kind : '';
}

export function gbpQueueId(slug, kind) {
  return `${normalizeGbpSlug(slug)}:${normalizeGbpKind(kind)}`;
}

export function parseGbpQueueId(value, kind) {
  const raw = String(value || '').trim().toLowerCase();
  const explicitKind = normalizeGbpKind(kind);
  if (explicitKind && SLUG_RE.test(raw)) return { slug: raw, kind: explicitKind };
  const split = raw.lastIndexOf(':');
  if (split <= 0) return null;
  const slug = raw.slice(0, split);
  const parsedKind = normalizeGbpKind(raw.slice(split + 1));
  if (!SLUG_RE.test(slug) || !parsedKind) return null;
  return { slug, kind: parsedKind };
}

export function gbpItemKey(slug, kind) {
  const parsed = parseGbpQueueId(slug, kind);
  if (!parsed) return '';
  return `${GBP_ITEM_PREFIX}${parsed.slug}:${parsed.kind}`;
}

/** Caption for the Update. CTA lives on cta_url / gbp_cta_url. */
export function buildGbpCaption(seed = {}) {
  const summary = String(seed['post-summary'] || seed.title || '').trim()
    || `TV installation${seed.city ? ` in ${String(seed.city).trim()}` : ''} by The Mounting Man.`;
  const price = String(seed.price || '').trim();
  const parts = [summary];
  if (price) parts.push(`Install subtotal: ${price}.`);
  return redactUnsafeText(parts.join('\n\n')).slice(0, 1500);
}

export function publicGbpView(item = {}) {
  const view = {};
  for (const key of PUBLIC_FIELDS) {
    if (item[key] !== undefined) view[key] = item[key];
  }
  if (view.image_path === undefined) view.image_path = null;
  return view;
}

export function sanitizeGbpItem(raw = {}) {
  const parsed = parseGbpQueueId(raw.slug, raw.kind) || parseGbpQueueId(raw.id);
  if (!parsed) return null;
  const { slug, kind } = parsed;
  if (!SLUG_RE.test(slug) || slug.length > 180) return null;

  const liveUrl = String(raw.live_url || raw.cta_url || raw.gbp_cta_url || '').trim();
  if (!LIVE_URL_RE.test(liveUrl)) return null;

  const imageUrl = String(raw.image_url || '').trim();
  if (imageUrl && !IMAGE_URL_RE.test(imageUrl)) return null;
  if (kind === GBP_KINDS.PHOTOS && !imageUrl) return null;

  const status = Object.values(GBP_STATUSES).includes(raw.status)
    ? raw.status
    : GBP_STATUSES.PENDING;

  const item = {
    id: gbpQueueId(slug, kind),
    slug,
    kind,
    caption: redactUnsafeText(raw.caption || '').slice(0, 1500),
    live_url: liveUrl,
    cta_url: liveUrl,
    gbp_cta_url: liveUrl,
    image_url: imageUrl || '',
    image_path: null,
    jobId: String(raw.jobId || '').trim().slice(0, 80),
    queuedAt: String(raw.queuedAt || '').trim() || new Date().toISOString(),
    status,
  };

  if (kind === GBP_KINDS.UPDATE) {
    // Always upload the photo after the Update, including when Google
    // leaves that Update waiting for review. Photos is a separate row.
    item.upload_photo = true;
  }
  if (kind === GBP_KINDS.PHOTOS) {
    item.photo_only = true;
    item.skip_update = true;
  }

  return item;
}

export function gbpPayloadFromRecord(record, { kind, at } = {}) {
  const result = record?.result && typeof record.result === 'object' ? record.result : {};
  const seed = record?.seed && typeof record.seed === 'object' ? record.seed : {};
  return sanitizeGbpItem({
    slug: result.slug || seed.slug,
    kind,
    caption: buildGbpCaption(seed),
    live_url: result.liveUrl,
    image_url: result.imageUrl || record?.image?.hostedUrl || '',
    jobId: record?.jobId,
    queuedAt: at,
    status: GBP_STATUSES.PENDING,
  });
}

export function shouldEnqueueGbp({ item, existing } = {}) {
  if (!item?.slug || !item.kind || !item.live_url) return { ok: false, reason: 'live_url_required' };
  if (existing?.slug && existing.kind === item.kind) {
    return {
      ok: false,
      reason: existing.status === GBP_STATUSES.POSTED ? 'already_posted' : 'already_queued',
    };
  }
  return { ok: true };
}

export function attachGbpQueuedDestinations(record, { update, photos } = {}) {
  if (!record?.result) return record;
  const destinations = Array.isArray(record.result.destinations)
    ? record.result.destinations.filter((entry) => {
      const name = String(entry?.name || '').toLowerCase();
      return name !== 'gbp' && name !== 'gbp-photos';
    })
    : [];

  function push(name, outcome) {
    if (!outcome?.item && outcome?.reason !== 'already_queued' && outcome?.reason !== 'already_posted') return;
    destinations.push({
      name,
      status: 'QUEUED',
      detail: outcome.queued ? (outcome.item?.slug || '') : String(outcome.reason || ''),
    });
  }

  push('gbp', update);
  push('gbp-photos', photos);
  return { ...record, result: { ...record.result, destinations } };
}

export function createGbpQueue(kv, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  for (const method of ['get', 'set', 'del', 'sadd', 'srem', 'smembers']) {
    if (typeof kv?.[method] !== 'function') throw new Error(`KV adapter is missing ${method}`);
  }

  async function loadItem(slug, kind) {
    const key = gbpItemKey(slug, kind);
    if (!key) return null;
    return decodeStoredRecord(await kv.get(key));
  }

  async function saveItem(item) {
    const sanitized = sanitizeGbpItem(item);
    if (!sanitized) throw new Error('invalid_gbp_item');
    await kv.set(gbpItemKey(sanitized.slug, sanitized.kind), JSON.stringify(sanitized), { ex: ttlSeconds });
    await kv.sadd(GBP_PENDING_INDEX_KEY, sanitized.id);
    return sanitized;
  }

  async function enqueue(input) {
    const item = sanitizeGbpItem(input);
    const existing = item ? await loadItem(item.slug, item.kind) : null;
    const decision = shouldEnqueueGbp({ item, existing });
    if (!decision.ok) {
      return {
        queued: false,
        reason: decision.reason,
        item: decision.reason === 'live_url_required' ? null : publicGbpView(existing || item || {}),
      };
    }
    const wrote = await kv.set(gbpItemKey(item.slug, item.kind), JSON.stringify(item), { nx: true, ex: ttlSeconds });
    if (!wrote) {
      const raced = await loadItem(item.slug, item.kind);
      return {
        queued: false,
        reason: raced?.status === GBP_STATUSES.POSTED ? 'already_posted' : 'already_queued',
        item: publicGbpView(raced || item),
      };
    }
    await kv.sadd(GBP_PENDING_INDEX_KEY, item.id);
    return { queued: true, reason: 'queued', item: publicGbpView(item) };
  }

  async function listPending() {
    const members = await kv.smembers(GBP_PENDING_INDEX_KEY);
    const ids = Array.isArray(members) ? members : [];
    const items = [];
    for (const id of ids) {
      const parsed = parseGbpQueueId(id);
      const item = parsed ? await loadItem(parsed.slug, parsed.kind) : null;
      if (!item) {
        await kv.srem(GBP_PENDING_INDEX_KEY, id);
        continue;
      }
      if (item.status === GBP_STATUSES.POSTED) continue;
      items.push(publicGbpView(item));
    }
    // Update first, then Photos. Those are independent queue rows: claiming
    // or completing Update must not hide Photos.
    items.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === GBP_KINDS.UPDATE ? -1 : 1;
      return Date.parse(left.queuedAt || 0) - Date.parse(right.queuedAt || 0);
    });
    return items;
  }

  async function claim(slug, kind) {
    const current = await loadItem(slug, kind);
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.status === GBP_STATUSES.POSTED) return { ok: false, reason: 'already_posted', item: publicGbpView(current) };
    const next = await saveItem({ ...current, status: GBP_STATUSES.CLAIMED });
    return { ok: true, item: publicGbpView(next) };
  }

  async function complete(slug, kind) {
    const current = await loadItem(slug, kind);
    if (!current) return { ok: false, reason: 'not_found' };
    const next = await saveItem({ ...current, status: GBP_STATUSES.POSTED });
    return { ok: true, item: publicGbpView(next) };
  }

  return { enqueue, listPending, claim, complete, loadItem };
}

export async function enqueueGbpAfterPublish({ queue, record, at } = {}) {
  if (!queue || typeof queue.enqueue !== 'function') {
    return {
      update: { queued: false, reason: 'queue_unavailable', item: null },
      photos: { queued: false, reason: 'queue_unavailable', item: null },
    };
  }
  const updateItem = gbpPayloadFromRecord(record, { kind: GBP_KINDS.UPDATE, at });
  const photosItem = gbpPayloadFromRecord(record, { kind: GBP_KINDS.PHOTOS, at });
  const update = updateItem
    ? await queue.enqueue(updateItem)
    : { queued: false, reason: 'live_url_required', item: null };
  const photos = photosItem
    ? await queue.enqueue(photosItem)
    : { queued: false, reason: 'live_url_required', item: null };
  return { update, photos };
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
