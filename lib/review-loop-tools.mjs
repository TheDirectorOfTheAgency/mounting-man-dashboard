import { loadReviewLoopStore } from './review-loop-store.mjs';
import {
  approveReviewRequest,
  skipReviewRequest,
  stageReviewRequestForPayment,
} from './review-request.mjs';
import {
  approveReplyDraft,
  skipReplyDraft,
  syncGoogleReplyDrafts,
} from './review-reply-drafts.mjs';

export const LIST_STAGED_REVIEW_REQUESTS = 'list_staged_review_requests';
export const APPROVE_REVIEW_REQUEST = 'approve_review_request';
export const SKIP_REVIEW_REQUEST = 'skip_review_request';
export const LIST_REVIEW_REPLY_DRAFTS = 'list_review_reply_drafts';
export const APPROVE_REVIEW_REPLY_DRAFT = 'approve_review_reply_draft';
export const SKIP_REVIEW_REPLY_DRAFT = 'skip_review_reply_draft';

function redactRequest(record) {
  if (!record) return record;
  const { email, ...rest } = record;
  return {
    ...rest,
    email_present: Boolean(email),
  };
}

export async function listStagedReviewRequests(args = {}, deps = {}) {
  const store = deps.store ?? await loadReviewLoopStore(deps.env || process.env);
  if (!store) {
    return {
      tool: LIST_STAGED_REVIEW_REQUESTS,
      connected: false,
      requests: [],
      spoken: 'Review request queue is not connected. Add Vercel KV to stage requests.',
    };
  }
  const status = args.status ? String(args.status) : 'staged';
  const requests = await store.listReviewRequests({ status });
  const list = args.include_email ? requests : requests.map(redactRequest);
  return {
    tool: LIST_STAGED_REVIEW_REQUESTS,
    connected: true,
    status_filter: status,
    count: list.length,
    requests: list,
    spoken: list.length
      ? `You have ${list.length} review request${list.length === 1 ? '' : 's'} in status ${status}.`
      : `No review requests in status ${status}.`,
  };
}

export async function approveReviewRequestTool(args = {}, deps = {}) {
  const store = deps.store ?? await loadReviewLoopStore(deps.env || process.env);
  if (!store) return { tool: APPROVE_REVIEW_REQUEST, ok: false, error: 'store_unavailable' };
  const paymentId = String(args.payment_id || args.paymentId || '').trim();
  if (!paymentId) return { tool: APPROVE_REVIEW_REQUEST, ok: false, error: 'payment_id_required' };
  const result = await approveReviewRequest(paymentId, { ...deps, store });
  return { tool: APPROVE_REVIEW_REQUEST, ...result };
}

export async function skipReviewRequestTool(args = {}, deps = {}) {
  const store = deps.store ?? await loadReviewLoopStore(deps.env || process.env);
  if (!store) return { tool: SKIP_REVIEW_REQUEST, ok: false, error: 'store_unavailable' };
  const paymentId = String(args.payment_id || args.paymentId || '').trim();
  if (!paymentId) return { tool: SKIP_REVIEW_REQUEST, ok: false, error: 'payment_id_required' };
  const result = await skipReviewRequest(paymentId, { ...deps, store });
  return { tool: SKIP_REVIEW_REQUEST, ...result };
}

export async function listReviewReplyDrafts(args = {}, deps = {}) {
  const store = deps.store ?? await loadReviewLoopStore(deps.env || process.env);
  if (!store) {
    return {
      tool: LIST_REVIEW_REPLY_DRAFTS,
      connected: false,
      drafts: [],
      spoken: 'Review reply drafts need Vercel KV.',
    };
  }
  const status = args.status ? String(args.status) : 'draft';
  const drafts = await store.listReplyDrafts({ status });
  return {
    tool: LIST_REVIEW_REPLY_DRAFTS,
    connected: true,
    status_filter: status,
    count: drafts.length,
    drafts,
    spoken: drafts.length
      ? `${drafts.length} reply draft${drafts.length === 1 ? '' : 's'} ready for ${status}. Nothing is posted automatically.`
      : `No reply drafts in status ${status}.`,
  };
}

export async function approveReviewReplyDraftTool(args = {}, deps = {}) {
  const store = deps.store ?? await loadReviewLoopStore(deps.env || process.env);
  if (!store) return { tool: APPROVE_REVIEW_REPLY_DRAFT, ok: false, error: 'store_unavailable' };
  const source = String(args.source || 'google').trim();
  const reviewId = String(args.review_id || args.reviewId || '').trim();
  if (!reviewId) return { tool: APPROVE_REVIEW_REPLY_DRAFT, ok: false, error: 'review_id_required' };
  const result = await approveReplyDraft({ source, reviewId }, { ...deps, store });
  return { tool: APPROVE_REVIEW_REPLY_DRAFT, ...result, posted: false };
}

export async function skipReviewReplyDraftTool(args = {}, deps = {}) {
  const store = deps.store ?? await loadReviewLoopStore(deps.env || process.env);
  if (!store) return { tool: SKIP_REVIEW_REPLY_DRAFT, ok: false, error: 'store_unavailable' };
  const source = String(args.source || 'google').trim();
  const reviewId = String(args.review_id || args.reviewId || '').trim();
  if (!reviewId) return { tool: SKIP_REVIEW_REPLY_DRAFT, ok: false, error: 'review_id_required' };
  const result = await skipReplyDraft({ source, reviewId }, { ...deps, store });
  return { tool: SKIP_REVIEW_REPLY_DRAFT, ...result };
}

export { stageReviewRequestForPayment, syncGoogleReplyDrafts };
