import { loadReviewLoopStore } from './review-loop-store.mjs';
import {
  approveReviewRequest,
  skipReviewRequest,
  stageReviewRequestForPayment,
} from './review-request.mjs';

export const LIST_STAGED_REVIEW_REQUESTS = 'list_staged_review_requests';
export const APPROVE_REVIEW_REQUEST = 'approve_review_request';
export const SKIP_REVIEW_REQUEST = 'skip_review_request';

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

export { stageReviewRequestForPayment };
