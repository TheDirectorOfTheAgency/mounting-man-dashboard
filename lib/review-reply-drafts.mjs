// Daily reply drafts for new Google (and future Yelp) reviews — never auto-post.

import crypto from 'crypto';
import { getNewReviews, suggestReviewReply } from './car-tools-inbound.mjs';

export const REPLY_DRAFT_STATUSES = new Set(['draft', 'approved', 'skipped']);

function plainSpeech(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function reviewStableId(review, source = 'google') {
  const time = review?.time || review?.publishTime || '';
  const name = review?.reviewer_first_name || review?.author_name || '';
  const stars = review?.stars ?? review?.rating ?? '';
  const text = plainSpeech(review?.text || '').slice(0, 120);
  const raw = `${source}|${time}|${name}|${stars}|${text}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

export function buildReplyDraftText(review) {
  const rating = review.stars ?? review.rating;
  const text = review.text || '';
  const firstName = review.reviewer_first_name || 'there';
  const base = suggestReviewReply({ rating, text, reviewerFirstName: firstName });
  const snippet = plainSpeech(text);
  if (snippet && snippet.length > 20 && rating >= 4) {
    const detail = snippet.length > 60 ? `${snippet.slice(0, 60).trim()}…` : snippet;
    return plainSpeech(`${base} Thanks again for mentioning ${detail.replace(/\.$/, '')}.`);
  }
  if (rating != null && rating <= 2 && snippet) {
    return plainSpeech(
      `${base} I read your note about ${snippet.length > 50 ? `${snippet.slice(0, 50).trim()}…` : snippet}. I'd like to make this right offline.`,
    );
  }
  return base;
}

export async function fetchYelpReviewsStub(deps = {}) {
  // TODO: Wire Yelp Fusion read path when API credentials and business id are available.
  deps.logger?.info?.('review_reply_yelp_stub');
  return {
    connected: false,
    source: 'yelp',
    reviews: [],
    note: 'Yelp read path not implemented — add YELP_API_KEY and YELP_BUSINESS_ID when ready.',
  };
}

export async function syncGoogleReplyDrafts(deps = {}) {
  const store = deps.store;
  if (!store) return { created: 0, skipped: 0, reason: 'store_unavailable' };

  const sinceDays = Number(deps.sinceDays || 2);
  const now = deps.now || new Date();
  const since = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const feed = await getNewReviews({ since }, {
    now,
    env: deps.env || process.env,
    placesClient: deps.placesClient,
    logger: deps.logger,
  });

  let created = 0;
  let skipped = 0;
  if (!feed.connected) {
    return {
      created,
      skipped,
      degraded: true,
      google: { connected: false, spoken: feed.spoken },
    };
  }

  for (const review of feed.reviews || []) {
    const reviewId = reviewStableId(review, 'google');
    const draftText = buildReplyDraftText(review);
    const save = await store.saveReplyDraft({
      source: 'google',
      reviewId,
      status: 'draft',
      stars: review.stars,
      reviewerFirstName: review.reviewer_first_name,
      reviewText: review.text || '',
      reviewPublishedAt: review.time || null,
      replyDraft: draftText,
      createdAt: new Date().toISOString(),
    });
    if (save.duplicate) skipped += 1;
    else created += 1;
  }

  const yelp = await fetchYelpReviewsStub(deps);

  return {
    created,
    skipped,
    degraded: Boolean(feed.degraded),
    google: { connected: true, fetched: (feed.reviews || []).length },
    yelp,
  };
}

export async function approveReplyDraft({ source, reviewId }, deps = {}) {
  const store = deps.store;
  if (!store) return { ok: false, error: 'store_unavailable' };
  const record = await store.updateReplyDraft(source, reviewId, {
    status: 'approved',
    approvedAt: new Date().toISOString(),
  });
  if (!record) return { ok: false, error: 'not_found' };
  return { ok: true, record, posted: false };
}

export async function skipReplyDraft({ source, reviewId }, deps = {}) {
  const store = deps.store;
  if (!store) return { ok: false, error: 'store_unavailable' };
  const record = await store.updateReplyDraft(source, reviewId, {
    status: 'skipped',
    skippedAt: new Date().toISOString(),
  });
  if (!record) return { ok: false, error: 'not_found' };
  return { ok: true, record };
}
