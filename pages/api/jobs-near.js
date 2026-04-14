// pages/api/jobs-near.js
// GET /api/jobs-near?zip=55369
// Returns count of completed jobs within 5 miles of the given zip code.
// Data is pre-computed weekly by /api/cron/jobs-snapshot and stored in Vercel KV.

const KV_KEY = 'jobs:snapshot';
const KV_UPDATED_KEY = 'jobs:snapshot:updated_at';
const RADIUS_MILES = 5;
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_UA = 'mounting-man-jobs-near/1.0 (mntvmounting@gmail.com)';

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

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180;
  const dlam = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

async function geocodeZip(zip) {
  const https = await import('https');
  const params = new URLSearchParams({ q: `${zip}, US`, format: 'json', limit: '1' });
  const url = `${NOMINATIM_URL}?${params}`;

  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': NOMINATIM_UA } };
    https.get(url, opts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const results = JSON.parse(raw);
          if (!results.length) return resolve(null);
          resolve({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { zip } = req.query;
  if (!zip || !/^\d{5}$/.test(zip.trim())) {
    return res.status(400).json({ error: 'Please provide a valid 5-digit zip code.' });
  }

  const kv = await getKV();
  if (!kv) return res.status(503).json({ error: 'Data store unavailable. Try again later.' });

  const [jobs, updatedAt] = await Promise.all([
    kv.get(KV_KEY),
    kv.get(KV_UPDATED_KEY),
  ]);

  if (!jobs || !Array.isArray(jobs)) {
    return res.status(503).json({ error: 'Job data not yet loaded. Check back shortly.' });
  }

  let coords;
  try {
    coords = await geocodeZip(zip.trim());
  } catch {
    return res.status(503).json({ error: 'Location lookup failed. Try again in a moment.' });
  }

  if (!coords) {
    return res.status(400).json({ error: `Zip code ${zip} could not be located.` });
  }

  let count = 0;
  for (const job of jobs) {
    if (haversineMiles(coords.lat, coords.lng, job.lat, job.lng) <= RADIUS_MILES) {
      count++;
    }
  }

  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  return res.status(200).json({ count, zip: zip.trim(), radius: RADIUS_MILES, dataAsOf: updatedAt || null });
}
