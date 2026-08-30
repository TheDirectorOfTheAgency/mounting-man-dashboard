// LinkedIn install-post receipts.
//
// The versioned Posts API documents either a raw urn:li:share or
// urn:li:ugcPost x-restli-id as a successful post-creation receipt. A feed
// permalink or arbitrary string containing one of those URNs is not the API
// receipt and remains untrusted. Legacy verified Posts-tab activity URLs are
// retained so an old successful destination survives reconciliation.
// Never Reddit. Never a company page the w_member_social token cannot reach.

export const LINKEDIN_PROFILE_VANITY = 'themountingman';
export const LINKEDIN_SHARE_FAILURE = (
  'LinkedIn share URN is not a Posts-tab photo post; '
  + 'need a PUBLIC PUBLISHED IMAGE ugcPost / activity posts URL'
);
export const LINKEDIN_RECEIPT_FAILURE = (
  'LinkedIn success requires a Posts API x-restli-id share or ugcPost URN'
);

const SHARE_RE = /urn:li:share:|urn%3ali%3ashare%3a|\/feed\/update\/urn:li:share:/i;
const POST_ID_RE = /^urn:li:(?:share|ugcPost):\d+$/i;
const ACTIVITY_POSTS_RE = /^https:\/\/www\.linkedin\.com\/posts\/themountingman_[^\s]*-activity-\d+(?:-[A-Za-z0-9_-]+)?$/i;
const ACTIVITY_FEED_RE = /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:activity:\d+\/?$/i;
const ACTIVITY_URN_RE = /^urn:li:activity:\d+$/i;

export function isLinkedInShareReceipt(detail) {
  return SHARE_RE.test(String(detail || ''));
}

export function isLinkedInPostReceipt(detail) {
  return POST_ID_RE.test(String(detail || '').trim());
}

export function isLinkedInImageUgcSuccess(detail) {
  const text = String(detail || '').trim();
  if (!text) return false;
  if (isLinkedInPostReceipt(text)) return true;
  if (ACTIVITY_POSTS_RE.test(text)) return true;
  if (ACTIVITY_FEED_RE.test(text)) return true;
  if (ACTIVITY_URN_RE.test(text)) return true;
  return false;
}

/** Dashboard guard: only a documented raw Post ID or verified legacy URL is PUBLISHED. */
export function sanitizeLinkedInDestination(entry = {}) {
  const name = String(entry?.name || '').trim().toLowerCase();
  if (name !== 'linkedin') return entry;
  if (String(entry?.status || '') !== 'PUBLISHED') return entry;
  if (isLinkedInImageUgcSuccess(entry?.detail)) return entry;
  return {
    ...entry,
    status: 'RETRYABLE_FAILURE',
    detail: LINKEDIN_RECEIPT_FAILURE,
  };
}
