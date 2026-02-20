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
      return res.status(400).json({ error: 'Missing Square credentials' });
    }

    // Get all payments (no date filter = all-time)
    const response = await axios.get('https://connect.squareup.com/v2/payments', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Square-Version': '2024-01-18',
      },
    });

    const payments = response.data.payments || [];
    
    // Calculate metrics
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let allTimeTotal = 0;
    let thisMonthTotal = 0;
    let todayTotal = 0;
    let allTimeCount = 0;
    let thisMonthCount = 0;

    payments.forEach((payment) => {
      if (payment.status === 'COMPLETED') {
        const amount = payment.amount_money?.amount / 100 || 0;
        const createdAt = new Date(payment.created_at);

        allTimeTotal += amount;
        allTimeCount += 1;

        if (createdAt >= thisMonthStart) {
          thisMonthTotal += amount;
          thisMonthCount += 1;
        }

        if (createdAt >= today) {
          todayTotal += amount;
        }
      }
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
      },
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Square API error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch Square data',
      details: error.message,
    });
  }
}
