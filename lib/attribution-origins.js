// One place for the site origins the attribution endpoints accept (audit #4).
// Booking endpoints carry booking ids, so they accept only the production
// www origin (the apex 301s to www, so real bookings never send it). The visit beacon also accepts
// the legacy Webflow hosts and ATTRIBUTION_ALLOWED_ORIGINS extras.
export const BOOKING_ORIGINS = Object.freeze([
  'https://www.themountingman.com',
]);

export const VISIT_ORIGINS = Object.freeze([
  ...BOOKING_ORIGINS,
  'https://themountingman.com',
  'https://themountingman.webflow.io',
  'https://www.themountingmanusa.com',
  'https://themountingmanusa.com',
]);

export function visitOrigins(env = process.env) {
  const extra = String(env?.ATTRIBUTION_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...VISIT_ORIGINS, ...extra]);
}

export function bookingOrigins() {
  return new Set(BOOKING_ORIGINS);
}

// Accepts a single origin string (tests/legacy callers) or a Set.
export function originAllowed(origin, allowed) {
  if (!origin) return false;
  return typeof allowed === 'string' ? origin === allowed : Boolean(allowed?.has?.(origin));
}
