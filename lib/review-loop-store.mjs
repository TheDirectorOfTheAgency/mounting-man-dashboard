// KV persistence for review-request staging after Square payments.

const REQUEST_TTL_SECONDS = 365 * 24 * 60 * 60;

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

const REQUEST_INDEX = 'review:request:index';

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
  };
}

export async function loadReviewLoopStore(env = process.env) {
  if (!env.KV_REST_API_URL || !env.KV_REST_API_TOKEN) return null;
  const { kv } = await import('@vercel/kv');
  return createReviewLoopStore(kv);
}
