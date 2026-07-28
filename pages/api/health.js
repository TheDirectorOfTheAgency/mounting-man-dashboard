export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  return res.status(200).json({
    status: 'ok',
    gitCommit: (process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').slice(0, 12),
    environment: process.env.VERCEL_ENV || 'local',
    offlineConversionMode: process.env.OFFLINE_CONVERSION_MODE || 'observe',
  });
}
