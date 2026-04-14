// pages/api/shortcuts/tell-q.js
//
// Receives voice tasks from the "Hey Siri, Tell Q" Apple Shortcut.
//
// Flow: Apple Shortcut (voice) → POST /api/shortcuts/tell-q
//        → writes task to Redis list (agency:context:siri_queue)
//        → sends Telegram receipt to Marshall
//        → Q reads queue at next session start and processes tasks
//
// Auth: ?secret=TELL_Q_SECRET (set in Vercel env)
// Method: POST (also accepts GET for Shortcut simplicity)

const REDIS_URL = 'https://devoted-minnow-39394.upstash.io';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;
const QUEUE_KEY = 'agency:context:siri_queue';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // 8283042895:AAF...
const MARSHALL_CHAT_ID = '8564673592';
const EXPECTED_SECRET = (process.env.TELL_Q_SECRET || 'siri_shortcut_2026').split('\n')[0].trim();

// Post JSON to Upstash Redis REST API
async function redisRpush(key, value) {
  const url = `${REDIS_URL}/rpush/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
  });
  return res.ok;
}

// Send Telegram message from Q's bot to Marshall
async function sendTelegramReceipt(task) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN not set — skipping receipt');
    return false;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const text = `📱 *Siri task queued*\n\n"${task}"\n\n_I'll handle this at next session start._`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: MARSHALL_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('Telegram receipt failed:', body);
  }
  return res.ok;
}

export default async function handler(req, res) {
  // Allow GET and POST (Shortcuts can use either)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check
  const secret = req.query.secret || req.headers['x-shortcut-secret'];
  if (secret !== EXPECTED_SECRET) {
    console.warn('tell-q: unauthorized attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Extract task text from query param or body
  let task = req.query.task || '';
  if (!task && req.body) {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    task = req.query.task || req.body?.task || body;
  }
  task = String(task).trim();

  if (!task) {
    return res.status(400).json({ error: 'Missing task parameter' });
  }

  // Build queue entry
  const entry = JSON.stringify({
    task,
    from: 'siri',
    timestamp: new Date().toISOString(),
  });

  // Write to Redis queue
  const queued = await redisRpush(QUEUE_KEY, entry);

  // Send Telegram receipt (fire and forget — don't fail if this fails)
  sendTelegramReceipt(task).catch((err) =>
    console.error('Telegram receipt error:', err.message)
  );

  if (!queued) {
    console.error('tell-q: failed to write to Redis');
    return res.status(500).json({ error: 'Failed to queue task' });
  }

  console.log(`tell-q: queued task: "${task}"`);
  return res.status(200).json({
    ok: true,
    queued: task,
    message: `Task queued for Q: "${task}"`,
  });
}
