// pages/api/cron/jobs-snapshot.js
// Weekly cron: fetches all completed ZenBooker jobs with valid coordinates
// and stores a slim [{lat, lng}] array in Vercel KV for the jobs-near API.
//
// Schedule: Sunday 2 AM CT (0 8 * * 0 UTC)
// Trigger manually: POST /api/cron/jobs-snapshot (with Authorization: Bearer <CRON_SECRET>)

const DEFAULT_BASE_URL = 'https://api.zenbooker.com/v1/';
const DEFAULT_TERRITORY_ID = '1680240992681x629678957578561900';
const KV_KEY = 'jobs:snapshot';
const KV_UPDATED_KEY = 'jobs:snapshot:updated_at';
const KV_TTL = 30 * 24 * 60 * 60; // 30 days

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

function sanitizeBareEmpties(text) {
  text = text.replace(/"(?:lat|lng|latitude|longitude)"\s*:\s*,/g, (m) => m.replace(',', 'null,'));
  text = text.replace(/"(?:lat|lng|latitude|longitude)"\s*:\s*\}/g, (m) => m.replace('}', 'null}'));
  return text;
}

async function httpGet(url, apiKey) {
  const https = await import('https');
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    };
    https.get(url, opts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          let parsed = JSON.parse(raw);
          if (typeof parsed === 'string') {
            parsed = JSON.parse(sanitizeBareEmpties(parsed));
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

function extractCoords(job) {
  const addr = job.service_address || {};
  for (const [latRaw, lngRaw] of [
    [addr.lat, addr.lng],
    [addr.latitude, addr.longitude],
    [job.lat, job.lng],
  ]) {
    if (latRaw == null || lngRaw == null) continue;
    const lat = parseFloat(latRaw);
    const lng = parseFloat(lngRaw);
    if (!isNaN(lat) && !isNaN(lng) && (lat !== 0 || lng !== 0) && lat >= -90 && lat <= 90) {
      return { lat, lng };
    }
  }
  return null;
}

async function fetchAllJobs(baseUrl, apiKey, territoryId) {
  const startDate = '2019-01-01';
  const endDate = new Date().toISOString().slice(0, 10);
  let allJobs = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    const params = new URLSearchParams({ territory: territoryId, start: startDate, end: endDate });
    if (cursor) params.set('cursor', cursor);
    const url = `${baseUrl.replace(/\/$/, '')}/jobs?${params}`;
    const data = await httpGet(url, apiKey);
    const jobs = data.results || [];
    allJobs = allJobs.concat(jobs);
    console.log(`  page ${page}: ${jobs.length} jobs (total: ${allJobs.length})`);
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
    await new Promise((r) => setTimeout(r, 200));
  }

  return allJobs;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.ZENBOOKER_API_KEY;
  const baseUrl = process.env.ZENBOOKER_BASE_URL || DEFAULT_BASE_URL;
  const kv = await getKV();

  if (!apiKey) return res.status(400).json({ error: 'ZENBOOKER_API_KEY not set' });
  if (!kv) return res.status(500).json({ error: 'KV not available' });

  try {
    const allJobs = await fetchAllJobs(baseUrl, apiKey, DEFAULT_TERRITORY_ID);

    // Deduplicate by ID
    const seen = new Set();
    const unique = allJobs.filter((j) => {
      const id = j.id || JSON.stringify(j);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // Filter to completed jobs with valid coordinates
    const coords = [];
    for (const job of unique) {
      const status = (job.status || '').toLowerCase().trim();
      if (status !== 'complete') continue;
      const c = extractCoords(job);
      if (c) coords.push(c);
    }

    const updatedAt = new Date().toISOString();
    await kv.set(KV_KEY, coords, { ex: KV_TTL });
    await kv.set(KV_UPDATED_KEY, updatedAt, { ex: KV_TTL });

    console.log(`jobs-snapshot: stored ${coords.length} completed jobs with coords (of ${unique.length} unique total)`);
    return res.status(200).json({ ok: true, jobsStored: coords.length, totalJobs: unique.length, updatedAt });
  } catch (err) {
    console.error('jobs-snapshot error:', err);
    return res.status(500).json({ error: err.message });
  }
}
