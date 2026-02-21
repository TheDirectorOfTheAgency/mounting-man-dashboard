// pages/api/square-revenue.js
import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
    const locationId = process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID;

    if (!token || !locationId) {
      return res.status(400).json({ error: 'Missing Square credentials', hasToken: !!token, hasLocation: !!locationId });
    }

    // Paginate through all payments
    let allPayments = [];
    let cursor = undefined;

    do {
      const params = new URLSearchParams({ location_id: locationId, limit: '100' });
      if (cursor) params.append('cursor', cursor);

      const response = await axios.get(`https://connect.squareup.com/v2/payments?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Square-Version': '2024-01-18',
        },
      });

      const payments = response.data.payments || [];
      allPayments = allPayments.concat(payments);
      cursor = response.data.cursor || null;
    } while (cursor);

    // Calculate metrics
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    let allTimeTotal = 0;
    let thisMonthTotal = 0;
    let todayTotal = 0;
    let allTimeCount = 0;
    let thisMonthCount = 0;
    let todayCount = 0;

    // Build daily revenue for last 7 days
    const dailyMap = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dailyMap[key] = 0;
    }

    allPayments.forEach((payment) => {
      if (payment.status === 'COMPLETED') {
        const amount = (payment.total_money?.amount || payment.amount_money?.amount || 0) / 100;
        const createdAt = new Date(payment.created_at);

        allTimeTotal += amount;
        allTimeCount += 1;

        if (createdAt >= thisMonthStart) {
          thisMonthTotal += amount;
          thisMonthCount += 1;
        }

        if (createdAt >= todayStart) {
          todayTotal += amount;
          todayCount += 1;
        }

        // Daily bucketing
        const dayKey = createdAt.toISOString().slice(0, 10);
        if (dailyMap.hasOwnProperty(dayKey)) {
          dailyMap[dayKey] += amount;
        }
      }
    });

    // Convert daily map to array
    const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const revenueHistory = Object.entries(dailyMap).map(([dateStr, revenue]) => {
      const d = new Date(dateStr + 'T12:00:00');
      return {
        date: days[d.getDay()],
        revenue: parseFloat(revenue.toFixed(2)),
      };
    });

    res.status(200).json({
      allTime: {
        total: parseFloat(allTimeTotal.toFixed(2)),
        count: allTimeCount,
        avgValue: allTimeCount > 0 ? parseFloat((allTimeTotal / allTimeCount).toFixed(2)) : 0,
      },
      thisMonth: {
        total: parseFloat(thisMonthTotal.toFixed(2)),
        count: thisMonthCount,
      },
      today: {
        total: parseFloat(todayTotal.toFixed(2)),
        count: todayCount,
      },
      revenueHistory,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Square API error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch Square data',
      details: error.response?.data || error.message,
    });
  }
}
