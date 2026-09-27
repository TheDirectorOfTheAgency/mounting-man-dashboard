// pages/api/square-revenue.js
// Uses @vercel/kv for caching (same as rest of codebase)
// All-time baseline hardcoded — cron updates it in Redis over time
// Recent data: fetches only last 90 days from Square (~3-4 API calls)
import axios from 'axios';
import {
  bucketRecentSquarePayments,
  squareRevenueCacheIncludesThisWeek,
} from '../../lib/square-revenue-buckets.mjs';

const CACHE_KEY         = 'square:revenue:cache';
const ALLTIME_CACHE_KEY = 'square:revenue:alltime';
const CACHE_TTL_SECONDS = 2 * 60 * 60; // 2 hours
const ALLTIME_BASELINE  = { total: 1678219, count: 4374 };

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

async function fetchRecentPayments(token, locationId) {
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  let allPayments = [];
  let cursor = undefined;

  do {
    const params = new URLSearchParams({
      location_id: locationId,
      limit: '100',
      begin_time: ninetyDaysAgo.toISOString(),
    });
    if (cursor) params.append('cursor', cursor);

    const response = await axios.get(`https://connect.squareup.com/v2/payments?${params.toString()}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Square-Version': '2024-01-18' },
    });

    allPayments = allPayments.concat(response.data.payments || []);
    cursor = response.data.cursor || null;
  } while (cursor);

  return allPayments;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const kv = await getKV();

  // Serve from cache if available
  if (kv) {
    try {
      const cached = await kv.get(CACHE_KEY);
      if (squareRevenueCacheIncludesThisWeek(cached)) return res.status(200).json(cached);
    } catch {}
  }

  try {
    const token      = process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
    const locationId = process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID;

    if (!token || !locationId) {
      return res.status(400).json({ error: 'Missing Square credentials' });
    }

    const periodNow = new Date();

    // All-time: Redis if cron stored it, otherwise hardcoded baseline
    let allTime = ALLTIME_BASELINE;
    if (kv) {
      try {
        const cachedAllTime = await kv.get(ALLTIME_CACHE_KEY);
        if (cachedAllTime) allTime = cachedAllTime;
      } catch {}
    }

    // Recent: last 90 days only — fast
    const recentPayments = await fetchRecentPayments(token, locationId);

    const buckets = bucketRecentSquarePayments(recentPayments, periodNow, new Date());

    const result = {
      allTime:   { total: allTime.total, count: allTime.count, avgValue: allTime.count > 0 ? parseFloat((allTime.total / allTime.count).toFixed(2)) : 0 },
      thisYear:  buckets.thisYear,
      thisMonth: buckets.thisMonth,
      today:     buckets.today,
      thisWeek:  buckets.thisWeek,
      revenueHistory: buckets.revenueHistory,
      lastUpdated: new Date().toISOString(),
    };

    // Cache with @vercel/kv
    if (kv) {
      try { await kv.set(CACHE_KEY, result, { ex: CACHE_TTL_SECONDS }); } catch {}
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error('Square API error:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Failed to fetch Square data', details: error.response?.data || error.message });
  }
}
