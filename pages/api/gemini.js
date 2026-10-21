// RETIRED 2026-10-21. The legacy accent-wall visualizer Gemini proxy had no rate limit or bot check.
// Replaced by the capped /api/ai-preview on tmm-nationwide (Turnstile + per-IP and daily caps).
// Intentionally makes no provider calls and reads no API key.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({ error: 'This endpoint has been retired.' });
}
