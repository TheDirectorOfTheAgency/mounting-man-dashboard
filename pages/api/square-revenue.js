// pages/api/square-revenue.js
// Uses @vercel/kv for caching (same as rest of codebase)
// All-time baseline hardcoded — cron updates it in Redis over time
// Recent data: fetches only last 90 days from Square (~3-4 API calls)
import axios from 'axios';

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
      if (cached) return res.status(200).json(cached);
    } catch {}
  }

  try {
    const token      = process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
    const locationId = process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID;

    if (!token || !locationId) {
      return res.status(400).json({ error: 'Missing Square credentials' });
    }

    const TIMEZONE = 'America/Chicago';
    const toLocalDateStr = (d) => d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

    const nowStr       = toLocalDateStr(new Date());
    const thisMonthStr = nowStr.slice(0, 7);
    const thisYearStr  = nowStr.slice(0, 4);

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

    let thisMonthTotal = 0, thisMonthCount = 0;
    let todayTotal = 0, todayCount = 0;
    let thisYearTotal = 0, thisYearCount = 0;

    const dailyMap = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dailyMap[toLocalDateStr(d)] = 0;
    }

    recentPayments.forEach((p) => {
      if (p.status === 'COMPLETED') {
        const amount  = (p.total_money?.amount || p.amount_money?.amount || 0) / 100;
        const dateStr = toLocalDateStr(new Date(p.created_at));

        if (dateStr.slice(0, 4) === thisYearStr)  { thisYearTotal  += amount; thisYearCount++;  }
        if (dateStr.slice(0, 7) === thisMonthStr)  { thisMonthTotal += amount; thisMonthCount++; }
        if (dateStr === nowStr)                    { todayTotal     += amount; todayCount++;     }
        if (dailyMap.hasOwnProperty(dateStr))      { dailyMap[dateStr] += amount; }
      }
    });

    const revenueHistory = Object.entries(dailyMap).map(([dateStr, revenue]) => {
      const d = new Date(dateStr + 'T18:00:00Z');
      const dayLabel = d.toLocaleDateString('en-US', { timeZone: TIMEZONE, weekday: 'short' }).toUpperCase().slice(0, 3);
      return { date: dayLabel, revenue: parseFloat(revenue.toFixed(2)) };
    });

    const result = {
      allTime:   { total: allTime.total, count: allTime.count, avgValue: allTime.count > 0 ? parseFloat((allTime.total / allTime.count).toFixed(2)) : 0 },
      thisYear:  { total: parseFloat(thisYearTotal.toFixed(2)), count: thisYearCount, avgValue: thisYearCount > 0 ? parseFloat((thisYearTotal / thisYearCount).toFixed(2)) : 0 },
      thisMonth: { total: parseFloat(thisMonthTotal.toFixed(2)), count: thisMonthCount },
      today:     { total: parseFloat(todayTotal.toFixed(2)), count: todayCount },
      revenueHistory,
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
