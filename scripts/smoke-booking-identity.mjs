#!/usr/bin/env node
// Post-deploy smoke test for /api/attribution/booking-identity.
// Uses the synthetic tmm-probe- ID, so it never calls ZenBooker and logs as
// booking_identity_probe. Usage: node scripts/smoke-booking-identity.mjs [baseUrl]
const base = (process.argv[2] || 'https://mounting-man-dashboard.vercel.app').replace(/\/$/, '');
const url = `${base}/api/attribution/booking-identity`;
const origin = 'https://www.themountingman.com';
const stamp = Date.now().toString(36);
const checks = [];

async function check(name, init, expected) {
  const response = await fetch(url, init);
  const ok = response.status === expected;
  checks.push({ name, status: response.status, expected, ok });
}

await check('preflight', { method: 'OPTIONS', headers: { Origin: origin } }, 204);
await check('foreign origin rejected', {
  method: 'POST',
  headers: { Origin: 'https://probe.invalid', 'Content-Type': 'application/json' },
  body: JSON.stringify({ customer_id: `tmm-probe-${stamp}`, booking_session: `tmm-probe-${stamp}` }),
}, 403);
await check('probe lookup returns 404 without upstream call', {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ customer_id: `tmm-probe-${stamp}`, booking_session: `tmm-probe-${stamp}` }),
}, 404);

console.table(checks);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
