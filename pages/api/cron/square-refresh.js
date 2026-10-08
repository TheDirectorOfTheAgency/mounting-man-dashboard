// pages/api/cron/square-refresh.js
// Proactively warms the Square revenue Redis cache every hour.
import axios from 'axios';
import { bucketRecentSquarePayments } from '../../../lib/square-revenue-buckets.mjs';

// Status and a short code only. Axios errors carry the request config,
// including the Square bearer token, and must not be logged or returned.
export function summarizeSquareError(error) {
  const status = Number(error?.response?.status) || null;
  const data = error?.response?.data;
  let message = 'square_request_failed';
  if (data && typeof data === 'object' && Array.isArray(data.errors) && data.errors[0]?.code) {
    message = String(data.errors[0].code);
  } else if (typeof data === 'string' && data.trim()) {
    message = 'upstream_text';
  } else if (status) {
    message = `http_${status}`;
  }
  return { status, message: message.slice(0, 80) };
}

const CACHE_KEY         = 'square:revenue:cache';
const ALLTIME_CACHE_KEY = 'square:revenue:alltime';
const CACHE_TTL_SECONDS    = 2 * 60 * 60;
const ALLTIME_TTL_SECONDS  = 14 * 24 * 60 * 60;

let _kv = null;
async function getKV() {
  if (_kv !== null) return _kv;
  try {
    const mod = await import('@vercel/kv');
    _kv = mod.kv;
    return _kv;
  } catch {
    _kv = false;
    return false;
  }
}

async function fetchPayments(token, locationId, beginTime) {
  let allPayments = [];
  let cursor = undefined;

  do {
    const params = new URLSearchParams({ location_id: locationId, limit: '100' });
    if (cursor) params.append('cursor', cursor);
    if (beginTime) params.append('begin_time', beginTime);

    const response = await axios.get(`https://connect.squareup.com/v2/payments?${params.toString()}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2024-01-18' },
    });

    allPayments = allPayments.concat(response.data.payments || []);
    cursor = response.data.cursor || null;
  } while (cursor);

  return allPayments;
}

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token      = process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
  const locationId = process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID;
  const kv         = await getKV();

  if (!token || !locationId || !kv) {
    return res.status(400).json({ error: 'Missing credentials or KV' });
  }

  try {
    const periodNow = new Date();

    // All-time: use cached or full paginate
    let allTimeTotal = 0, allTimeCount = 0;
    try {
      const cachedAllTime = await kv.get(ALLTIME_CACHE_KEY);
      if (cachedAllTime) {
        allTimeTotal = cachedAllTime.total;
        allTimeCount = cachedAllTime.count;
      }
    } catch {}

    if (!allTimeTotal) {
      const allPayments = await fetchPayments(token, locationId, null);
      allPayments.forEach((p) => {
        if (p.status === 'COMPLETED') {
          allTimeTotal += (p.total_money?.amount || p.amount_money?.amount || 0) / 100;
          allTimeCount++;
        }
      });
      await kv.set(ALLTIME_CACHE_KEY, { total: allTimeTotal, count: allTimeCount }, { ex: ALLTIME_TTL_SECONDS });
    }

    // Recent: last 90 days
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const recentPayments = await fetchPayments(token, locationId, ninetyDaysAgo.toISOString());

    const buckets = bucketRecentSquarePayments(recentPayments, periodNow, new Date());

    const result = {
      allTime:   { total: parseFloat(allTimeTotal.toFixed(2)), count: allTimeCount, avgValue: allTimeCount > 0 ? parseFloat((allTimeTotal / allTimeCount).toFixed(2)) : 0 },
      thisYear:  buckets.thisYear,
      thisMonth: buckets.thisMonth,
      today:     buckets.today,
      thisWeek:  buckets.thisWeek,
      revenueHistory: buckets.revenueHistory,
      lastUpdated: new Date().toISOString(),
    };

    await kv.set(CACHE_KEY, result, { ex: CACHE_TTL_SECONDS });
    return res.status(200).json({ ok: true, lastUpdated: result.lastUpdated });
  } catch (error) {
    const summary = summarizeSquareError(error);
    console.error('Square refresh failed', summary.status, summary.message);
    return res.status(500).json({ error: 'Failed to refresh Square cache' });
  }
}
