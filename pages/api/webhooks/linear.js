import { processLinearWebhook } from '../../../lib/linear-handoff.js';

export const config = { api: { bodyParser: false } };

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

let cachedKV;
async function getKV() {
  if (cachedKV !== undefined) return cachedKV;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return (cachedKV = null);
  const { kv } = await import('@vercel/kv');
  return (cachedKV = kv);
}

export default async function handler(req, res) {
  // Admin-only SMTP auth check (no mail sent): GET ?verify_smtp=1 with Authorization: Bearer CRON_SECRET
  if (req.method === 'GET' && req.query?.verify_smtp === '1') {
    if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false });
    try {
      const nodemailer = (await import('nodemailer')).default;
      const e = process.env;
      await nodemailer.createTransport({ host: e.HANDOFF_SMTP_HOST || 'smtp.mail.me.com', port: Number(e.HANDOFF_SMTP_PORT || 587), requireTLS: true, auth: { user: e.HANDOFF_SMTP_USER, pass: e.HANDOFF_SMTP_PASS } }).verify();
      return res.status(200).json({ ok: true, smtp: 'auth_ok', from: e.HANDOFF_EMAIL_FROM || e.HANDOFF_SMTP_USER });
    } catch (err) {
      return res.status(502).json({ ok: false, smtp: err?.code || 'error' });
    }
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false });
  }
  const rawBody = await readRaw(req);
  const out = await processLinearWebhook({ rawBody, headers: req.headers, kv: await getKV() });
  return res.status(out.status).json(out.body);
}
