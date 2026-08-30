// lib/install-post-gbp-queue.mjs
//
// Queue a Google Business Profile local post for the existing M1 worker.
//
// Hermes used to write ~/.hermes/tmp/mounting-man-installation-posts/gbp-queue/pending/{slug}.json
// (caption, image_path, cta_url). After the cloud runner took over, that file
// never landed on the M1, so launchd com.themountingman.gbp-worker logged
// "No pending GBP items" while remaining healthy.
//
// Official localPosts API is SERVICE_DISABLED. GitHub Actions must not open
// the Google Business Profile UI. This module only stores a pullable item.
// The M1 worker (mntvmounting@gmail.com) is still the publisher.
// Never Reddit. Do not change GBP website or NAP.

import { decodeStoredRecord } from './install-post-store.mjs';
import { redactUnsafeText } from './install-post-queue.mjs';

export const GBP_ITEM_PREFIX = 'install-post:gbp:item:';
export const GBP_PENDING_INDEX_KEY = 'install-post:gbp:pending-index';

export const GBP_STATUSES = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  POSTED: 'posted',
});

const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIVE_URL_RE = /^https:\/\/(?:www\.)?themountingman\.com\/installations\/[a-z0-9-]+\/?$/i;
const IMAGE_URL_RE = /^https:\/\/[^\s]+$/i;

const PUBLIC_FIELDS = Object.freeze([
  'slug',
  'caption',
  'live_url',
  'cta_url',
  'image_url',
  'image_path',
  'jobId',
  'queuedAt',
  'status',
]);

export function normalizeGbpSlug(value) {
  return String(value || '').trim().toLowerCase();
}

export function gbpItemKey(slug) {
  return `${GBP_ITEM_PREFIX}${normalizeGbpSlug(slug)}`;
}

/** Caption for the M1 worker. CTA is `cta_url` — do not duplicate the URL here. */
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
  const slug = normalizeGbpSlug(raw.slug);
  if (!SLUG_RE.test(slug) || slug.length > 180) return null;

  const liveUrl = String(raw.live_url || raw.cta_url || '').trim();
  if (!LIVE_URL_RE.test(liveUrl)) return null;

  const imageUrl = String(raw.image_url || '').trim();
  if (imageUrl && !IMAGE_URL_RE.test(imageUrl)) return null;

  const status = Object.values(GBP_STATUSES).includes(raw.status)
    ? raw.status
    : GBP_STATUSES.PENDING;

  return {
    slug,
    caption: redactUnsafeText(raw.caption || '').slice(0, 1500),
    live_url: liveUrl,
    cta_url: liveUrl,
    image_url: imageUrl || '',
    image_path: null,
    jobId: String(raw.jobId || '').trim().slice(0, 80),
    queuedAt: String(raw.queuedAt || '').trim() || new Date().toISOString(),
    status,
  };
}

/** Website live + a published slug. Social receipts are not required. */
export function gbpPayloadFromRecord(record, { at } = {}) {
  const result = record?.result && typeof record.result === 'object' ? record.result : {};
  const seed = record?.seed && typeof record.seed === 'object' ? record.seed : {};
  return sanitizeGbpItem({
    slug: result.slug || seed.slug,
    caption: buildGbpCaption(seed),
    live_url: result.liveUrl,
    image_url: result.imageUrl || record?.image?.hostedUrl || '',
    jobId: record?.jobId,
    queuedAt: at,
    status: GBP_STATUSES.PENDING,
  });
}

export function shouldEnqueueGbp({ item, existing } = {}) {
  if (!item?.slug || !item.live_url) return { ok: false, reason: 'live_url_required' };
  if (existing?.slug) {
    return {
      ok: false,
      reason: existing.status === GBP_STATUSES.POSTED ? 'already_posted' : 'already_queued',
    };
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
  return {
    ...record,
    result: { ...record.result, destinations },
  };
}

export function createGbpQueue(kv, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  for (const method of ['get', 'set', 'del', 'sadd', 'srem', 'smembers']) {
    if (typeof kv?.[method] !== 'function') throw new Error(`KV adapter is missing ${method}`);
  }

  async function loadItem(slug) {
    const normalized = normalizeGbpSlug(slug);
    if (!SLUG_RE.test(normalized)) return null;
    return decodeStoredRecord(await kv.get(gbpItemKey(normalized)));
  }

  async function saveItem(item) {
    const sanitized = sanitizeGbpItem(item);
    if (!sanitized) throw new Error('invalid_gbp_item');
    await kv.set(gbpItemKey(sanitized.slug), JSON.stringify(sanitized), { ex: ttlSeconds });
    await kv.sadd(GBP_PENDING_INDEX_KEY, sanitized.slug);
    return sanitized;
  }

  async function enqueue(input) {
    const item = sanitizeGbpItem(input);
    const decision = shouldEnqueueGbp({ item, existing: item ? await loadItem(item.slug) : null });
    if (!decision.ok) {
      return {
        queued: false,
        reason: decision.reason,
        item: decision.reason === 'live_url_required' ? null : publicGbpView(await loadItem(input?.slug) || item || {}),
      };
    }
    const wrote = await kv.set(gbpItemKey(item.slug), JSON.stringify(item), { nx: true, ex: ttlSeconds });
    if (!wrote) {
      const existing = await loadItem(item.slug);
      return {
        queued: false,
        reason: existing?.status === GBP_STATUSES.POSTED ? 'already_posted' : 'already_queued',
        item: publicGbpView(existing || item),
      };
    }
    await kv.sadd(GBP_PENDING_INDEX_KEY, item.slug);
    return { queued: true, reason: 'queued', item: publicGbpView(item) };
  }

  async function listPending() {
    const members = await kv.smembers(GBP_PENDING_INDEX_KEY);
    const slugs = Array.isArray(members) ? members : [];
    const items = [];
    for (const slug of slugs) {
      const item = await loadItem(slug);
      if (!item) {
        await kv.srem(GBP_PENDING_INDEX_KEY, slug);
        continue;
      }
      if (item.status === GBP_STATUSES.POSTED) continue;
      items.push(publicGbpView(item));
    }
    items.sort((left, right) => Date.parse(left.queuedAt || 0) - Date.parse(right.queuedAt || 0));
    return items;
  }

  async function claim(slug) {
    const current = await loadItem(slug);
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.status === GBP_STATUSES.POSTED) return { ok: false, reason: 'already_posted', item: publicGbpView(current) };
    const next = await saveItem({ ...current, status: GBP_STATUSES.CLAIMED });
    return { ok: true, item: publicGbpView(next) };
  }

  async function complete(slug) {
    const current = await loadItem(slug);
    if (!current) return { ok: false, reason: 'not_found' };
    const next = await saveItem({ ...current, status: GBP_STATUSES.POSTED });
    return { ok: true, item: publicGbpView(next) };
  }

  return { enqueue, listPending, claim, complete, loadItem };
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
