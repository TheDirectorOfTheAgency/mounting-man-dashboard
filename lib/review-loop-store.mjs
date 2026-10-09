// KV persistence for review-request staging and review-reply drafts.

const REQUEST_TTL_SECONDS = 365 * 24 * 60 * 60;
const DRAFT_TTL_SECONDS = 365 * 24 * 60 * 60;

function requireKv(kv) {
  for (const method of ['set', 'get', 'sadd', 'smembers', 'expire']) {
    if (typeof kv?.[method] !== 'function') {
      throw new Error(`KV adapter is missing ${method}`);
    }
  }
}

function paymentKey(paymentId) {
  return `review:request:${String(paymentId).trim()}`;
}

function draftKey(source, reviewId) {
  const src = String(source || 'google').trim().toLowerCase();
  const id = String(reviewId || '').trim();
  return `review:reply-draft:${src}:${id}`;
}

const REQUEST_INDEX = 'review:request:index';
const DRAFT_INDEX = 'review:reply-drafts:index';

export function createReviewLoopStore(kv) {
  requireKv(kv);

  return {
    async getReviewRequest(paymentId) {
      return kv.get(paymentKey(paymentId));
    },

    async saveReviewRequest(record) {
      const paymentId = String(record?.paymentId || '').trim();
      if (!paymentId) throw new Error('paymentId is required');
      const key = paymentKey(paymentId);
      const existing = await kv.get(key);
      if (existing?.paymentId) {
        return { saved: false, duplicate: true, record: existing };
      }
      const value = {
        ...record,
        paymentId,
        updatedAt: new Date().toISOString(),
      };
      await kv.set(key, value, { ex: REQUEST_TTL_SECONDS });
      await kv.sadd(REQUEST_INDEX, paymentId);
      await kv.expire(REQUEST_INDEX, REQUEST_TTL_SECONDS);
      return { saved: true, duplicate: false, record: value };
    },

    async updateReviewRequest(paymentId, patch) {
      const key = paymentKey(paymentId);
      const existing = await kv.get(key);
      if (!existing) return null;
      const value = {
        ...existing,
        ...patch,
        paymentId: existing.paymentId,
        updatedAt: new Date().toISOString(),
      };
      await kv.set(key, value, { ex: REQUEST_TTL_SECONDS });
      return value;
    },

    async listReviewRequests({ status } = {}) {
      const ids = await kv.smembers(REQUEST_INDEX);
      const records = [];
      for (const paymentId of ids) {
        const record = await kv.get(paymentKey(paymentId));
        if (!record) continue;
        if (status && record.status !== status) continue;
        records.push(record);
      }
      records.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
      return records;
    },

    async getReplyDraft(source, reviewId) {
      return kv.get(draftKey(source, reviewId));
    },

    async saveReplyDraft(record) {
      const source = String(record?.source || 'google').trim().toLowerCase();
      const reviewId = String(record?.reviewId || '').trim();
      if (!reviewId) throw new Error('reviewId is required');
      const key = draftKey(source, reviewId);
      const existing = await kv.get(key);
      if (existing?.reviewId) {
        return { saved: false, duplicate: true, record: existing };
      }
      const member = `${source}:${reviewId}`;
      const value = {
        ...record,
        source,
        reviewId,
        updatedAt: new Date().toISOString(),
      };
      await kv.set(key, value, { ex: DRAFT_TTL_SECONDS });
      await kv.sadd(DRAFT_INDEX, member);
      await kv.expire(DRAFT_INDEX, DRAFT_TTL_SECONDS);
      return { saved: true, duplicate: false, record: value };
    },

    async updateReplyDraft(source, reviewId, patch) {
      const key = draftKey(source, reviewId);
      const existing = await kv.get(key);
      if (!existing) return null;
      const value = {
        ...existing,
        ...patch,
        source: existing.source,
        reviewId: existing.reviewId,
        updatedAt: new Date().toISOString(),
      };
      await kv.set(key, value, { ex: DRAFT_TTL_SECONDS });
      return value;
    },

    async listReplyDrafts({ status } = {}) {
      const members = await kv.smembers(DRAFT_INDEX);
      const records = [];
      for (const member of members) {
        const [source, ...rest] = String(member).split(':');
        const reviewId = rest.join(':');
        const record = await kv.get(draftKey(source, reviewId));
        if (!record) continue;
        if (status && record.status !== status) continue;
        records.push(record);
      }
      records.sort((a, b) => Date.parse(b.reviewPublishedAt || b.createdAt || 0)
        - Date.parse(a.reviewPublishedAt || a.createdAt || 0));
      return records;
    },
  };
}

export async function loadReviewLoopStore(env = process.env) {
  if (!env.KV_REST_API_URL || !env.KV_REST_API_TOKEN) return null;
  const { kv } = await import('@vercel/kv');
  return createReviewLoopStore(kv);
}
