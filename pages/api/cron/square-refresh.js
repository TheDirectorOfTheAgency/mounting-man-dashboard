// pages/api/cron/square-refresh.js
// Proactively warms the Square revenue Redis cache every hour.
import axios from 'axios';

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

  const TIMEZONE = 'America/Chicago';
  const toLocalDateStr = (d) => d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

  const nowStr       = toLocalDateStr(new Date());
  const thisMonthStr = nowStr.slice(0, 7);
  const thisYearStr  = nowStr.slice(0, 4);

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
    allTime:   { total: parseFloat(allTimeTotal.toFixed(2)), count: allTimeCount, avgValue: allTimeCount > 0 ? parseFloat((allTimeTotal / allTimeCount).toFixed(2)) : 0 },
    thisYear:  { total: parseFloat(thisYearTotal.toFixed(2)), count: thisYearCount, avgValue: thisYearCount > 0 ? parseFloat((thisYearTotal / thisYearCount).toFixed(2)) : 0 },
    thisMonth: { total: parseFloat(thisMonthTotal.toFixed(2)), count: thisMonthCount },
    today:     { total: parseFloat(todayTotal.toFixed(2)), count: todayCount },
    revenueHistory,
    lastUpdated: new Date().toISOString(),
  };

  await kv.set(CACHE_KEY, result, { ex: CACHE_TTL_SECONDS });
  return res.status(200).json({ ok: true, lastUpdated: result.lastUpdated });
}
