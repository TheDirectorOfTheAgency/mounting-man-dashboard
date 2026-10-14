// Constant-time secret comparison (Gemini code audit #8).
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value) => createHash('sha256').update(String(value ?? ''), 'utf8').digest();

// True only when both values are non-empty and equal. Hashing first gives
// equal-length buffers, so length differences do not leak through timing.
export function safeEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

// `Authorization: Bearer <CRON_SECRET>`; false when the secret is not configured.
export function hasBearer(req, secret = process.env.CRON_SECRET) {
  if (!secret) return false;
  const header = req?.headers?.authorization;
  return safeEqual(typeof header === 'string' ? header : '', `Bearer ${secret}`);
}
