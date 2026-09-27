// Shared COMPLETED-payment bucketing for /api/square-revenue and
// /api/cron/square-refresh. Period boundaries are America/Chicago calendar
// dates (DST-safe). Amounts prefer total_money (includes tips) and do not
// subtract refunds.

const TIMEZONE = 'America/Chicago';

const WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function chicagoDateString(date) {
  return date.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function chicagoWeekBounds(now) {
  const nowStr = chicagoDateString(now);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(nowStr);
  if (!match) {
    throw new Error(`Unexpected America/Chicago date: ${nowStr}`);
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const index = WEEKDAY_INDEX[weekday];
  if (index == null) {
    throw new Error(`Unexpected America/Chicago weekday label: ${weekday}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const formatUtcYmd = (utcMs) => {
    const date = new Date(utcMs);
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  return {
    weekStart: formatUtcYmd(Date.UTC(year, month - 1, day - index)),
    weekEnd: formatUtcYmd(Date.UTC(year, month - 1, day - index + 6)),
  };
}

function roundMoney(amount) {
  return parseFloat(amount.toFixed(2));
}

/**
 * @param {Array<object>} recentPayments
 * @param {Date} [now] Instant for today / thisMonth / thisYear / thisWeek.
 * @param {Date} [historyNow] Instant for the 7-day revenueHistory seed.
 *   Routes pass the post-fetch clock so that map stays aligned with the
 *   previous inline loop.
 */
export function bucketRecentSquarePayments(recentPayments, now = new Date(), historyNow = now) {
  const nowStr = chicagoDateString(now);
  const thisMonthStr = nowStr.slice(0, 7);
  const thisYearStr = nowStr.slice(0, 4);
  const { weekStart, weekEnd } = chicagoWeekBounds(now);

  let thisMonthTotal = 0;
  let thisMonthCount = 0;
  let todayTotal = 0;
  let todayCount = 0;
  let thisYearTotal = 0;
  let thisYearCount = 0;
  let thisWeekTotal = 0;
  let thisWeekCount = 0;

  const dailyMap = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(historyNow);
    d.setDate(d.getDate() - i);
    dailyMap[chicagoDateString(d)] = 0;
  }

  recentPayments.forEach((p) => {
    if (p.status === 'COMPLETED') {
      const amount = (p.total_money?.amount || p.amount_money?.amount || 0) / 100;
      const dateStr = chicagoDateString(new Date(p.created_at));

      if (dateStr.slice(0, 4) === thisYearStr) { thisYearTotal += amount; thisYearCount++; }
      if (dateStr.slice(0, 7) === thisMonthStr) { thisMonthTotal += amount; thisMonthCount++; }
      if (dateStr === nowStr) { todayTotal += amount; todayCount++; }
      if (dateStr >= weekStart && dateStr <= weekEnd) { thisWeekTotal += amount; thisWeekCount++; }
      if (dailyMap.hasOwnProperty(dateStr)) { dailyMap[dateStr] += amount; }
    }
  });

  const revenueHistory = Object.entries(dailyMap).map(([dateStr, revenue]) => {
    const d = new Date(dateStr + 'T18:00:00Z');
    const dayLabel = d.toLocaleDateString('en-US', { timeZone: TIMEZONE, weekday: 'short' }).toUpperCase().slice(0, 3);
    return { date: dayLabel, revenue: roundMoney(revenue) };
  });

  return {
    thisYear: {
      total: roundMoney(thisYearTotal),
      count: thisYearCount,
      avgValue: thisYearCount > 0 ? roundMoney(thisYearTotal / thisYearCount) : 0,
    },
    thisMonth: { total: roundMoney(thisMonthTotal), count: thisMonthCount },
    today: { total: roundMoney(todayTotal), count: todayCount },
    thisWeek: {
      total: roundMoney(thisWeekTotal),
      count: thisWeekCount,
      weekStart,
      weekEnd,
    },
    revenueHistory,
  };
}

/** Cached payloads written before thisWeek existed must recompute. */
export function squareRevenueCacheIncludesThisWeek(cached) {
  return Boolean(cached && typeof cached === 'object' && cached.thisWeek && typeof cached.thisWeek === 'object');
}
