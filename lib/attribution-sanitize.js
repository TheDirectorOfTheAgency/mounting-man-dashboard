// Server-side normalization of client-supplied attribution context. The server
// never trusts the browser: every value is fully decoded and Unicode-normalized
// before PII checks, and paths are reduced to a slug-only route template.

const MAX_DECODE_ROUNDS = 5;
const SLUG_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SEGMENTS = 6;
const MAX_SEGMENT_LENGTH = 60;
const MAX_UNBROKEN_TOKEN = 24;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Decode %XX (and + as space) repeatedly until stable, bounded; then NFKC so
// full-width / compatibility characters (＠, ０-９, ．) collapse to ASCII.
export function deepDecode(value) {
  let text = String(value ?? '');
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next = text.replace(/\+/g, ' ');
    try {
      next = decodeURIComponent(next);
    } catch {
      next = next.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    if (next === text) break;
    text = next;
  }
  return text.normalize('NFKC').toLowerCase();
}

// True if a decoded value could carry an email or phone number.
export function looksPersonal(value) {
  const text = deepDecode(value);
  if (/[@\uFE6B\uFF20]/.test(text) || /%40|\(at\)|\[at\]/.test(text)) return true;
  // Phone-like: 7+ digits even when split by spaces, dots, dashes, parens, slashes or +.
  if (/\d(?:[\s.\-()/+_]*\d){6,}/.test(text)) return true;
  // Any non-ASCII left after NFKC is not part of a site route or a class label.
  if (/[^\x20-\x7e]/.test(text)) return true;
  return false;
}

// Route template: strip query/fragment, decode, keep only slug segments.
// Anything that is not a plain slug becomes ":x"; digit-heavy segments ":n".
export function normalizeLandingPath(value) {
  if (typeof value !== 'string' || !value) return null;
  const raw = value.split(/[?#]/)[0];
  const decoded = deepDecode(raw).split(/[?#]/)[0];
  if (!decoded.startsWith('/')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.length > MAX_SEGMENTS) return null;
  const out = segments.map((segment) => {
    if (looksPersonal(segment)) return ':x';
    if (segment.length > MAX_SEGMENT_LENGTH || !SLUG_SEGMENT.test(segment)) return ':x';
    if (segment.split('-').some((part) => part.length > MAX_UNBROKEN_TOKEN)) return ':x';
    if ((segment.match(/\d/g) || []).length >= 5) return ':n';
    return segment;
  });
  // A phone split across segments (/612/555/0100/) is caught on the whole path.
  if (looksPersonal(`/${out.join('/')}`)) {
    for (let i = 0; i < out.length; i += 1) if (/\d/.test(out[i])) out[i] = ':n';
    if (looksPersonal(`/${out.join('/')}`)) return null;
  }
  const path = `/${out.join('/')}${out.length && decoded.endsWith('/') ? '/' : ''}`;
  return path.slice(0, 200);
}

// Host only, validated. Accepts a bare host or a full URL; rejects userinfo,
// IPs with ports, non-ASCII/punycode-less IDNs and anything personal-looking.
export function normalizeReferrerHost(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const decoded = deepDecode(value.trim());
  if (decoded === 'self') return 'self';
  let host = decoded;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(decoded)) {
    try {
      const url = new URL(decoded);
      if (url.username || url.password) return null;
      host = url.hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^www\./, 'www.').replace(/\.$/, '');
  if (looksPersonal(host)) return null;
  return HOST_PATTERN.test(host) ? host : null;
}

// UTM / class labels: decode + PII check first, then the existing charset clamp.
export function normalizeClass(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (looksPersonal(value)) return null;
  const cleaned = deepDecode(value).trim().replace(/[^a-z0-9_.-]/g, '').slice(0, 64);
  return cleaned || null;
}
