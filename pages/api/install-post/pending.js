// pages/api/install-post/pending.js
//
// Q calls this endpoint to retrieve pending install-post seeds and mark them complete.
//
// GET  /api/install-post/pending?secret=XXX           → latest pending seed
// GET  /api/install-post/pending?secret=XXX&all=true  → all pending seeds as array
// POST /api/install-post/pending?secret=XXX           → mark seed as complete
//   body: { orderId: "xxx", action: "complete" }
//
// Auth: ?secret=CRON_SECRET (same secret used for cron endpoints)

import axios from 'axios';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const CRON_SECRET = (process.env.CRON_SECRET || '').trim();

const PENDING_INDEX_KEY = 'install-post:pending-index';
const PENDING_TTL = 172800;  // 48 hours
const COMPLETED_TTL = 604800; // 7 days

// ============================================================================
// REDIS HELPERS
// ============================================================================

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await axios.get(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    const raw = res.data?.result;
    if (!raw) return null;
    // Value may be double-encoded (kvSet stores JSON.stringify'd value)
    try { return JSON.parse(raw); } catch { return raw; }
  } catch {
    return null;
  }
}

async function kvSet(key, value, ttl) {
  if (!KV_URL || !KV_TOKEN) return false;
  const cmd = ttl
    ? `set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}/EX/${ttl}`
    : `set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`;
  try {
    await axios.get(`${KV_URL}/${cmd}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    return true;
  } catch (err) {
    console.error('[pending-kv-set-error]', err.response?.data || err.message);
    return false;
  }
}

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    await axios.get(`${KV_URL}/del/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    return true;
  } catch (err) {
    console.error('[pending-kv-del-error]', err.response?.data || err.message);
    return false;
  }
}

async function kvSmembers(key) {
  if (!KV_URL || !KV_TOKEN) return [];
  try {
    const res = await axios.get(`${KV_URL}/smembers/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    return Array.isArray(res.data?.result) ? res.data.result : [];
  } catch {
    return [];
  }
}

async function kvSrem(key, member) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    await axios.post(
      `${KV_URL}/srem/${encodeURIComponent(key)}`,
      JSON.stringify([member]),
      { headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' } },
    );
    return true;
  } catch (err) {
    console.error('[pending-kv-srem-error]', err.response?.data || err.message);
    return false;
  }
}

// ============================================================================
// HANDLER
// ============================================================================

export default async function handler(req, res) {
  // Auth
  const secret = req.query.secret || req.headers['x-install-post-secret'];
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ---- GET: retrieve pending seeds ----
  if (req.method === 'GET') {
    const pendingKeys = await kvSmembers(PENDING_INDEX_KEY);

    if (pendingKeys.length === 0) {
      return res.status(200).json({ pending: [], latest: null });
    }

    // Fetch all seeds and filter out expired (kvGet returns null for TTL-expired keys)
    const seeds = (
      await Promise.all(
        pendingKeys.map(async (key) => {
          const data = await kvGet(key);
          if (!data) {
            // Key expired — clean up stale index entry
            await kvSrem(PENDING_INDEX_KEY, key);
            return null;
          }
          return { key, ...data };
        })
      )
    ).filter(Boolean);

    // Sort newest first
    seeds.sort((a, b) => new Date(b.stagedAt || 0) - new Date(a.stagedAt || 0));

    if (req.query.all === 'true') {
      return res.status(200).json({ pending: seeds, count: seeds.length });
    }

    return res.status(200).json({ latest: seeds[0] || null, count: seeds.length });
  }

  // ---- POST: mark seed as complete ----
  if (req.method === 'POST') {
    const { orderId, action } = req.body || {};

    if (action !== 'complete' || !orderId) {
      return res.status(400).json({ error: 'Body must include { orderId, action: "complete" }' });
    }

    const pendingKey = `install-post:pending:${orderId}`;

    // Read the existing seed before deleting
    const existing = await kvGet(pendingKey);

    if (!existing) {
      return res.status(404).json({ error: `No pending seed found for orderId: ${orderId}` });
    }

    // Move to completed namespace
    const completedKey = `install-post:completed:${orderId}`;
    const completedValue = typeof existing === 'string' ? JSON.parse(existing) : existing;
    await kvSet(completedKey, { ...completedValue, completedAt: new Date().toISOString() }, COMPLETED_TTL);

    // Remove from pending
    await kvDel(pendingKey);
    await kvSrem(PENDING_INDEX_KEY, pendingKey);

    console.log(`[install-post-pending] Marked complete: ${orderId}`);
    return res.status(200).json({ ok: true, completed: orderId, completedKey });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
