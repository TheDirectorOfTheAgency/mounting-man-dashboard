// Live console threads come from /api/telemetry. This route stays so the
// dashboard poll keeps returning an empty thread list.

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  return res.status(200).json({ lines: [] });
}
