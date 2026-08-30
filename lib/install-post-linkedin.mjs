// LinkedIn install-post receipts.
//
// A member share of the installation article (urn:li:share / feed/update/share)
// is crawler-visible and can 500 in the mobile app. It does not appear on
// Marshall Wayne's Posts tab (linkedin.com/posts/themountingman_…-activity-…).
// Only a PUBLIC PUBLISHED IMAGE ugcPost / activity posts URL counts as posted.
// Never Reddit. Never a company page the w_member_social token cannot reach.

export const LINKEDIN_PROFILE_VANITY = 'themountingman';
export const LINKEDIN_SHARE_FAILURE = (
  'LinkedIn share URN is not a Posts-tab photo post; '
  + 'need a PUBLIC PUBLISHED IMAGE ugcPost / activity posts URL'
);
export const LINKEDIN_RECEIPT_FAILURE = (
  'LinkedIn success requires an image ugcPost id or activity posts URL'
);

const SHARE_RE = /urn:li:share:|urn%3ali%3ashare%3a|\/feed\/update\/urn:li:share:/i;
const UGC_RE = /urn:li:ugcpost:|urn%3ali%3augcpost%3a/i;
const ACTIVITY_POSTS_RE = /linkedin\.com\/posts\/themountingman_[^\s]*-activity-\d+/i;
const ACTIVITY_FEED_RE = /linkedin\.com\/feed\/update\/urn:li:activity:/i;
const ACTIVITY_URN_RE = /urn:li:activity:\d+/i;

export function isLinkedInShareReceipt(detail) {
  return SHARE_RE.test(String(detail || ''));
}

export function isLinkedInImageUgcSuccess(detail) {
  const text = String(detail || '');
  if (!text || isLinkedInShareReceipt(text)) return false;
  if (UGC_RE.test(text)) return true;
  if (ACTIVITY_POSTS_RE.test(text)) return true;
  if (ACTIVITY_FEED_RE.test(text)) return true;
  if (ACTIVITY_URN_RE.test(text)) return true;
  return false;
}

/** Dashboard / runner guard: a share-only LinkedIn response cannot be PUBLISHED. */
export function sanitizeLinkedInDestination(entry = {}) {
  const name = String(entry?.name || '').trim().toLowerCase();
  if (name !== 'linkedin') return entry;
  if (String(entry?.status || '') !== 'PUBLISHED') return entry;
  if (isLinkedInImageUgcSuccess(entry?.detail)) return entry;
  return {
    ...entry,
    status: 'RETRYABLE_FAILURE',
    detail: isLinkedInShareReceipt(entry?.detail)
      ? LINKEDIN_SHARE_FAILURE
      : LINKEDIN_RECEIPT_FAILURE,
  };
}
