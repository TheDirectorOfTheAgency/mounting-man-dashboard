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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false });
  }
  const rawBody = await readRaw(req);
  const out = await processLinearWebhook({ rawBody, headers: req.headers, kv: await getKV() });
  return res.status(out.status).json(out.body);
}
