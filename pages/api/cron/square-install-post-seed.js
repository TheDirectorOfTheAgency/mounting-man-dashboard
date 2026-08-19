import axios from 'axios';

import { notifyQInstallPost } from '../../../lib/notify-install-post.mjs';

const SQUARE_BASE = 'https://connect.squareup.com/v2';
const SQUARE_VER = '2024-01-18';
const SQUARE_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN || process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID =
  process.env.SQUARE_LOCATION_ID || process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID;

const squareHeaders = () => ({
  Authorization: `Bearer ${SQUARE_TOKEN}`,
  'Square-Version': SQUARE_VER,
  'Content-Type': 'application/json',
});

async function fetchRecentCompletedPayments() {
  const begin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    location_id: SQUARE_LOCATION_ID,
    begin_time: begin,
    sort_order: 'DESC',
    limit: '10',
  });
  const response = await axios.get(`${SQUARE_BASE}/payments?${params.toString()}`, {
    headers: squareHeaders(),
  });
  return (response.data?.payments || []).filter((payment) => payment?.status === 'COMPLETED');
}

async function fetchCustomer(customerId) {
  const response = await axios.get(`${SQUARE_BASE}/customers/${customerId}`, {
    headers: squareHeaders(),
  });
  return response.data?.customer || {};
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  const vercelCronHeader = req.headers['x-vercel-cron'];
  const cronSecret = process.env.CRON_SECRET || '';
  const authorizedByBearer = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const authorizedByVercelCron = Boolean(vercelCronHeader);

  if (!authorizedByBearer && !authorizedByVercelCron) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SQUARE_TOKEN || !SQUARE_LOCATION_ID) {
    return res.status(400).json({ error: 'Missing Square credentials' });
  }

  try {
    const payments = await fetchRecentCompletedPayments();
    const results = [];

    for (const payment of payments) {
      if (!payment?.id || !payment?.customer_id) continue;
      try {
        const customer = await fetchCustomer(payment.customer_id);
        const amountCents = payment.amount_money?.amount || payment.total_money?.amount || 0;
        const result = await notifyQInstallPost({
          orderId: payment.order_id || '',
          payment,
          invoice: {},
          isInvoiceEvent: false,
          eventType: 'cron.square.completed',
          firstName: customer.given_name || 'there',
          lastName: customer.family_name || '',
          customer,
          amount: (amountCents / 100).toFixed(2),
          amountCents,
          triggerStatus: 'Square webhook failed; Vercel fallback succeeded',
          triggerSourceCode: 'vercel-cron-fallback',
        });
        results.push({
          skipped: result?.skipped || null,
          key: result?.key || '',
          paymentId: payment.id,
          orderId: payment.order_id || '',
          kronkite: result?.kronkite || null,
        });
      } catch (err) {
        results.push({
          posted: false,
          paymentId: payment.id,
          error: err.response?.data || err.message,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      scanned: payments.length,
      results,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[square-install-post-seed] Unhandled error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
