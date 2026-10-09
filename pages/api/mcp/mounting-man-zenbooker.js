// HTTP MCP for Grok custom connectors.
// Read-only ZenBooker jobs for The Mounting Man. No writes.
//
// Production: https://mounting-man-dashboard.vercel.app/api/mcp/mounting-man-zenbooker
// Auth: Authorization: Bearer <MCP_SQUARE_PAYROLL_SECRET> (also accepts CRON_SECRET)
// Same operator secrets as mounting-man-reporting / mounting-man-ads-apply.
// Grok Web Custom Connector OAuth 2.1 + PKCE issues that same Bearer via /api/mcp/auth/*.
// Enter client id mounting-man-zenbooker. Authorize accepts it; no extra env var.

import {
  MCP_PUBLIC_ORIGIN,
  acceptedOperatorSecrets,
  isAuthorizedMcpRequest,
  isJsonRpcRequest,
  jsonRpcError,
  jsonRpcResult,
  mcpWwwAuthenticateHeader,
  negotiateProtocolVersion,
  parseToolArguments,
  wantsEventStream,
} from '../../../lib/mcp-http.mjs';
import {
  GET_DAY_SUMMARY,
  GET_JOB,
  GET_JOBS_FOR_DAY,
  GET_MORNING_BRIEF,
  GET_NEXT_JOB,
  GET_ROUTE_FOR_DAY,
  GET_TOMORROW,
  GET_UPCOMING_JOBS,
  MCP_ZENBOOKER_CLIENT_ID,
  createZenbookerReadClientFromEnv,
  getDaySummary,
  getJob,
  getJobsForDay,
  getMorningBrief,
  getNextJob,
  getRouteForDay,
  getTomorrow,
  getUpcomingJobs,
} from '../../../lib/zenbooker-jobs-feed.mjs';
import {
  GET_ADS_SUMMARY,
  GET_ADS_SUMMARY_TOOL,
  getAdsSummary,
} from '../../../lib/car-tools-ads.mjs';
import {
  GET_MISSED_CALLS,
  GET_NEW_LEADS,
  GET_NEW_REVIEWS,
  createCallRailClientFromEnv,
  createGooglePlacesClientFromEnv,
  getMissedCalls,
  getNewLeads,
  getNewReviews,
} from '../../../lib/car-tools-inbound.mjs';
import {
  GET_JOB_PAYMENT_STATUS,
  GET_PAYMENTS,
  GET_SUPPLIES_FOR_DAY,
  createCarToolsSquareClient,
  getJobPaymentStatus,
  getPayments,
  getSuppliesForDay,
} from '../../../lib/car-tools-money.mjs';
import {
  TEXT_NEXT_CUSTOMER_ETA,
  textNextCustomerEta,
  textNextCustomerEtaTool,
} from '../../../lib/car-tools-eta-text.mjs';
import {
  APPROVE_REVIEW_REPLY_DRAFT,
  APPROVE_REVIEW_REQUEST,
  LIST_REVIEW_REPLY_DRAFTS,
  LIST_STAGED_REVIEW_REQUESTS,
  SKIP_REVIEW_REPLY_DRAFT,
  SKIP_REVIEW_REQUEST,
  approveReviewReplyDraftTool,
  approveReviewRequestTool,
  listReviewReplyDrafts,
  listStagedReviewRequests,
  skipReviewReplyDraftTool,
  skipReviewRequestTool,
} from '../../../lib/review-loop-tools.mjs';

const SERVER_INFO = {
  name: 'mounting-man-zenbooker',
  version: '1.1.0',
  title: 'Mounting Man ZenBooker Jobs',
};

const RESOURCE_SUFFIX = 'api/mcp/mounting-man-zenbooker';

const TOOLS = [
  {
    name: GET_JOBS_FOR_DAY,
    description:
      "Read-only list of The Mounting Man's TV-mounting jobs from ZenBooker for one America/Chicago calendar day. Use this when Marshall asks what jobs he has today, tonight, or on a date, including 'what jobs do I have today'. Returns every job that day sorted by start time: job id, job number, time window, status, service(s), customer name, customer phone, a single-line service address for maps, assigned installer(s), job notes and special instructions, and price when ZenBooker has one. Cancelled jobs are left out unless include_cancelled is true. Does not create, update, cancel, or reschedule anything.",
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'America/Chicago calendar date as YYYY-MM-DD. Defaults to today.',
        },
        include_cancelled: {
          type: 'boolean',
          description: 'When true, include cancelled jobs. Defaults to false.',
        },
      },
    },
  },
  {
    name: GET_UPCOMING_JOBS,
    description:
      "Read-only list of The Mounting Man's upcoming TV-mounting jobs from ZenBooker, grouped by America/Chicago day. Use this when Marshall asks what jobs are coming up this week or over the next few days. Same job fields as get_jobs_for_day. days defaults to 7, maximum 31, starting today in America/Chicago. Cancelled jobs are left out unless include_cancelled is true. Does not change any job.",
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: 'How many America/Chicago days to include, starting today. Default 7. Maximum 31.',
        },
        include_cancelled: {
          type: 'boolean',
          description: 'When true, include cancelled jobs. Defaults to false.',
        },
      },
    },
  },
  {
    name: GET_JOB,
    description:
      "Read-only full detail for one of The Mounting Man's TV-mounting jobs from ZenBooker. Use this when Marshall asks about a specific job by ZenBooker job id or job number (for example 730395). Returns the scheduling fields from the day list plus service options. Does not change the job.",
    inputSchema: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'ZenBooker job id.',
        },
        job_number: {
          type: 'string',
          description: 'ZenBooker job number, for example 730395.',
        },
      },
    },
  },
  {
    name: GET_ROUTE_FOR_DAY,
    description:
      "Read-only driving route for The Mounting Man's TV-mounting jobs from ZenBooker. Use this when Marshall asks to be routed to his jobs, for directions, or 'route me to my jobs'. Non-cancelled jobs for one America/Chicago day in start-time order, with the same job fields as get_jobs_for_day, a Google Maps multi-stop directions URL (https://www.google.com/maps/dir/...), and an Apple Maps link for the first stop. Does not book, dispatch, or modify jobs.",
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'America/Chicago calendar date as YYYY-MM-DD. Defaults to today.',
        },
      },
    },
  },
  {
    name: GET_NEXT_JOB,
    description:
      "Who's my next customer. Use this when Marshall asks who's my next customer, call my next customer, text my next customer, or where the next TV-mounting job is. Read-only ZenBooker lookup for The Mounting Man in America/Chicago. Returns the next job that is not cancelled and not complete, today first, otherwise the next day that has one. Includes the customer name, phone in E.164 plus a tel link and an sms link (phone_e164, tel_link, sms_link), the address, the time window, the services, the notes, the installer, a Google Maps directions link, and an Apple Maps link. If a job is in progress now, returns that job with in_progress true and the job after it. Does not call, text, book, or change any job.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: GET_DAY_SUMMARY,
    description:
      "What did I make today. Use this when Marshall asks what did I make today, how much is booked today, or for a summary of the day's jobs. Read-only ZenBooker booked amounts for The Mounting Man, not Square collected payments. Counts jobs, completed versus remaining, total booked revenue from ZenBooker job prices, and each job's price and status for one America/Chicago day. If ZenBooker gives no price, says so and does not guess. Does not read Square and does not change any job.",
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'America/Chicago calendar date as YYYY-MM-DD. Defaults to today.',
        },
      },
    },
  },
  {
    name: GET_MORNING_BRIEF,
    description:
      "Brief me on today. Use this when Marshall asks brief me on today, give me my morning brief, or read today's route out loud. Read-only voice brief of The Mounting Man's ZenBooker jobs for one America/Chicago day, written as plain spoken sentences with no markdown or tables. Includes how many jobs, the first start time, each job in order with the time, city, service, and notable notes, rough drive times between stops and from the first stop to the last, and the full multi-stop Google Maps route link at the end. Does not change any job.",
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'America/Chicago calendar date as YYYY-MM-DD. Defaults to today.',
        },
      },
    },
  },
  {
    name: GET_TOMORROW,
    description:
      "What's tomorrow look like. Use this when Marshall asks what's tomorrow look like, what jobs are tomorrow, or how tomorrow is shaping up. Read-only shortcut for The Mounting Man's ZenBooker jobs tomorrow in America/Chicago, with the same fields as get_jobs_for_day. Does not change any job.",
    inputSchema: {
      type: 'object',
      properties: {
        include_cancelled: {
          type: 'boolean',
          description: 'When true, include cancelled jobs. Defaults to false.',
        },
      },
    },
  },
  GET_ADS_SUMMARY_TOOL,
  {
    name: GET_MISSED_CALLS,
    description:
      "Who called me and any missed calls. Use this when Marshall asks who called me, any missed calls, or voicemails. Read-only CallRail lookup for unanswered inbound calls and voicemails since a time (since defaults to start of today in America/Chicago). Returns caller name when known, phone with tel link, time, tracking source, and voicemail transcription when CallRail provides one. Without CallRail credentials, says call tracking is not connected yet.",
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO timestamp or America/Chicago YYYY-MM-DD. Defaults to start of today.',
        },
      },
    },
  },
  {
    name: GET_NEW_LEADS,
    description:
      "Any new leads. Use this when Marshall asks any new leads or who wants service. Read-only leads since a time (since defaults to start of today in America/Chicago) from new ZenBooker online or website bookings, CallRail form submissions, and CallRail first-time callers when CallRail is configured. Says which leads have no booked job yet when that can be told. Thumbtack, Angi, and Yelp are not connected here.",
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO timestamp or America/Chicago YYYY-MM-DD. Defaults to start of today.',
        },
      },
    },
  },
  {
    name: GET_NEW_REVIEWS,
    description:
      "Any new reviews. Use this when Marshall asks any new reviews or what people said on Google. Read-only Google Places lookup for the few most recent reviews on the business (Google only returns up to five). since defaults to seven days ago in America/Chicago. Returns reviewer first name, stars, time, review text, and a suggested reply in Mr. Wayne's friendly owner voice (text only, never posted). Full Business Profile reviews need OAuth that is not set up yet. Without Google Places credentials, says reviews are not connected yet.",
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO timestamp or America/Chicago YYYY-MM-DD. Defaults to seven days ago.',
        },
      },
    },
  },
  {
    name: GET_PAYMENTS,
    description:
      "What came in today. Use this when Marshall asks what came in today, how much did I collect this week, or what Square collected yesterday. Read-only Square COMPLETED payments for The Mounting Man in America/Chicago. day may be today, yesterday, or this_week. Returns Square collected totals with tips and refunds when Square provides them, plus each payment's customer name when known, amount, and time. These are Square collected payments, not ZenBooker booked amounts from get_day_summary. Does not write to Square.",
    inputSchema: {
      type: 'object',
      properties: {
        day: {
          type: 'string',
          description: 'today, yesterday, or this_week. Defaults to today.',
        },
      },
    },
  },
  {
    name: GET_JOB_PAYMENT_STATUS,
    description:
      "Did this job pay. Use this when Marshall asks did the Johnson job pay, is job 730395 paid, or was the last job paid. Read-only ZenBooker job matched to Square collected payments using ZenBooker invoice lines and Square order metadata. Pass customer name, job id, job number, or query last for the most recent finished job. Returns paid, unpaid, partial, or unknown with amount and time when known. Lists multiple matches briefly instead of guessing. Does not write to Square or ZenBooker.",
    inputSchema: {
      type: 'object',
      properties: {
        customer_name: {
          type: 'string',
          description: 'Customer last name or full name to search.',
        },
        job_id: {
          type: 'string',
          description: 'ZenBooker job id.',
        },
        job_number: {
          type: 'string',
          description: 'ZenBooker job number, for example 730395.',
        },
        query: {
          type: 'string',
          description: 'Customer name or last to mean the most recent finished job.',
        },
      },
    },
  },
  {
    name: GET_SUPPLIES_FOR_DAY,
    description:
      "What do I need for tomorrow. Use this when Marshall asks what do I need for tomorrow, what should I bring today, or what supplies are on the schedule. Read-only supply tally from that day's non-cancelled ZenBooker jobs: TV mounts by type, HDMI cables, soundbar brackets, in-wall kits, and unmapped services listed by name without guessing. day defaults to tomorrow and may be today, tomorrow, or YYYY-MM-DD. Per job and in total. No inventory counts and no low-stock claims.",
    inputSchema: {
      type: 'object',
      properties: {
        day: {
          type: 'string',
          description: 'today, tomorrow, or YYYY-MM-DD in America/Chicago. Defaults to tomorrow.',
        },
      },
    },
  },
  textNextCustomerEtaTool,
  {
    name: LIST_STAGED_REVIEW_REQUESTS,
    description:
      'List staged review-request emails after Square payments. Read-only unless approving. Each item is a neutral Google review ask (email only, never SMS) waiting for Marshall\'s approval. Use approve_review_request or skip_review_request to act on one payment id.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: staged, approved, sent, or skipped. Defaults to staged.',
        },
        include_email: {
          type: 'boolean',
          description: 'When true, include customer email in the response. Defaults to false.',
        },
      },
    },
  },
  {
    name: APPROVE_REVIEW_REQUEST,
    description:
      'Approve one staged review-request email by Square payment id. Sends email only when REVIEW_REQUEST_SEND_ENABLED is true in Vercel; otherwise marks approved for manual send. Never sends SMS.',
    inputSchema: {
      type: 'object',
      properties: {
        payment_id: { type: 'string', description: 'Square payment id from list_staged_review_requests.' },
      },
      required: ['payment_id'],
    },
  },
  {
    name: SKIP_REVIEW_REQUEST,
    description: 'Skip a staged review-request email by Square payment id without sending.',
    inputSchema: {
      type: 'object',
      properties: {
        payment_id: { type: 'string', description: 'Square payment id.' },
      },
      required: ['payment_id'],
    },
  },
  {
    name: LIST_REVIEW_REPLY_DRAFTS,
    description:
      'List reply drafts for new Google reviews (and Yelp when connected). Read-only suggested replies — nothing is posted to Google or Yelp automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter: draft, approved, or skipped. Defaults to draft.',
        },
      },
    },
  },
  {
    name: APPROVE_REVIEW_REPLY_DRAFT,
    description:
      'Mark a review reply draft approved for Marshall to paste manually. Does not post to Google or Yelp.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Review source, usually google.' },
        review_id: { type: 'string', description: 'Stable review id from list_review_reply_drafts.' },
      },
      required: ['review_id'],
    },
  },
  {
    name: SKIP_REVIEW_REPLY_DRAFT,
    description: 'Skip a review reply draft without posting.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Review source, usually google.' },
        review_id: { type: 'string', description: 'Stable review id.' },
      },
      required: ['review_id'],
    },
  },
];

const TOOL_RUNNERS = {
  [GET_JOBS_FOR_DAY]: getJobsForDay,
  [GET_UPCOMING_JOBS]: getUpcomingJobs,
  [GET_JOB]: getJob,
  [GET_ROUTE_FOR_DAY]: getRouteForDay,
  [GET_NEXT_JOB]: getNextJob,
  [GET_DAY_SUMMARY]: getDaySummary,
  [GET_MORNING_BRIEF]: getMorningBrief,
  [GET_TOMORROW]: getTomorrow,
  [GET_ADS_SUMMARY]: getAdsSummary,
  [GET_MISSED_CALLS]: getMissedCalls,
  [GET_NEW_LEADS]: getNewLeads,
  [GET_NEW_REVIEWS]: getNewReviews,
  [GET_PAYMENTS]: getPayments,
  [GET_JOB_PAYMENT_STATUS]: getJobPaymentStatus,
  [GET_SUPPLIES_FOR_DAY]: getSuppliesForDay,
  [TEXT_NEXT_CUSTOMER_ETA]: textNextCustomerEta,
  [LIST_STAGED_REVIEW_REQUESTS]: listStagedReviewRequests,
  [APPROVE_REVIEW_REQUEST]: approveReviewRequestTool,
  [SKIP_REVIEW_REQUEST]: skipReviewRequestTool,
  [LIST_REVIEW_REPLY_DRAFTS]: listReviewReplyDrafts,
  [APPROVE_REVIEW_REPLY_DRAFT]: approveReviewReplyDraftTool,
  [SKIP_REVIEW_REPLY_DRAFT]: skipReviewReplyDraftTool,
};

const VALIDATION_CODES = new Set([
  'invalid_date',
  'invalid_days',
  'invalid_job',
  'invalid_range',
  'invalid_since',
  'invalid_day',
]);

function sendJson(res, statusCode, body, extraHeaders = {}) {
  Object.entries({
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    ...extraHeaders,
  }).forEach(([key, value]) => res.setHeader(key, value));
  return res.status(statusCode).json(body);
}

function sendMcpMessage(req, res, statusCode, body) {
  if (wantsEventStream(req)) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.status(statusCode);
    if (typeof res.write === 'function') {
      res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    }
    return res.end();
  }
  return sendJson(res, statusCode, body);
}

function toolArguments(params) {
  const parsed = parseToolArguments(params);
  if (parsed && Object.keys(parsed).length) return parsed;
  if (!params || typeof params !== 'object') return {};
  const rest = { ...params };
  delete rest.name;
  delete rest.jsonrpc;
  delete rest.id;
  delete rest.method;
  delete rest.params;
  delete rest.arguments;
  delete rest.args;
  return rest;
}

async function runTool(name, args, deps) {
  const runner = TOOL_RUNNERS[name];
  if (!runner) {
    throw Object.assign(new Error(`Unknown tool: ${name || ''}`), { code: 'unknown_tool' });
  }
  return runner(args, deps);
}

async function dispatchMcp(body, deps) {
  const { method, id, params } = body;
  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "Read-only ZenBooker feed of The Mounting Man's TV-mounting jobs in America/Chicago. Use get_jobs_for_day for 'what jobs do I have today', get_upcoming_jobs for the coming days, get_job for one job id or job number, and get_route_for_day for 'route me to my jobs' (Google Maps multi-stop URL plus Apple Maps for the first stop). Use get_next_job for 'who's my next customer' or 'call my next customer', get_day_summary for 'what did I make today' (ZenBooker booked amounts, not Square collected payments), get_morning_brief for 'brief me on today', and get_tomorrow for 'what's tomorrow look like'. Use get_ads_summary for 'how are the ads doing' or 'what did I spend on ads today'. Use get_missed_calls for missed calls and voicemails, get_new_leads for new leads, and get_new_reviews for Google reviews. Use get_payments for Square collected money, get_job_payment_status for whether a job paid, and get_supplies_for_day for what to bring. Never create, update, cancel, or reschedule a job.",
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') {
    return { notification: true };
  }
  if (method === 'ping') {
    return jsonRpcResult(id, {});
  }
  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: TOOLS });
  }
  if (method === 'resources/list') {
    return jsonRpcResult(id, { resources: [] });
  }
  if (method === 'prompts/list') {
    return jsonRpcResult(id, { prompts: [] });
  }
  if (method === 'tools/call') {
    try {
      const feed = await runTool(params?.name, toolArguments(params), deps);
      const text = typeof feed?.spoken === 'string'
        ? feed.spoken
        : feed?.tool === GET_MORNING_BRIEF && typeof feed.brief === 'string'
          ? feed.brief
          : JSON.stringify(feed, null, 2);
      return jsonRpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: feed,
      });
    } catch (error) {
      if (VALIDATION_CODES.has(error.code)) {
        return jsonRpcError(id, -32602, error.message);
      }
      if (error.code === 'unknown_tool') {
        return jsonRpcError(id, -32601, error.message);
      }
      deps.logger?.error?.('zenbooker_jobs_tool_failed', { message: error.message });
      return jsonRpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: 'Failed to load ZenBooker jobs' }],
      });
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export function createMountingManZenbookerHandler(overrides = {}) {
  return async function handler(req, res) {
    const env = overrides.env || process.env;
    const logger = overrides.logger || console;
    const now = overrides.now || new Date();

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, x-mcp-secret',
      );
      return res.status(204).end();
    }

    if (!isAuthorizedMcpRequest(req, env)) {
      const configured = acceptedOperatorSecrets(env).length > 0;
      return sendJson(res, 401, {
        error: 'Unauthorized',
        hint: configured ? undefined : 'MCP_SQUARE_PAYROLL_SECRET is not set',
      }, {
        'WWW-Authenticate': mcpWwwAuthenticateHeader(MCP_PUBLIC_ORIGIN, RESOURCE_SUFFIX),
      });
    }

    if (req.method === 'DELETE') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      return sendJson(res, 200, {
        protocol: 'mcp',
        server: SERVER_INFO,
        tools: TOOLS,
        oauth_client_id: MCP_ZENBOOKER_CLIENT_ID,
        timezone: 'America/Chicago',
      });
    }

    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    const client = overrides.client !== undefined
      ? overrides.client
      : createZenbookerReadClientFromEnv(env);
    const deps = {
      client,
      squareClient: overrides.squareClient !== undefined
        ? overrides.squareClient
        : createCarToolsSquareClient(env),
      now,
      logger,
      env,
      geocode: overrides.geocode,
      fetchImpl: overrides.fetchImpl,
      queryGoogleAds: overrides.queryGoogleAds,
      callRailClient: overrides.callRailClient !== undefined
        ? overrides.callRailClient
        : createCallRailClientFromEnv(env, { fetchImpl: overrides.fetchImpl }),
      placesClient: overrides.placesClient !== undefined
        ? overrides.placesClient
        : createGooglePlacesClientFromEnv(env, { fetchImpl: overrides.fetchImpl }),
      kv: overrides.kv,
      sendSms: overrides.sendSms,
      httpClient: overrides.httpClient,
    };
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    if (isJsonRpcRequest(body)) {
      const message = await dispatchMcp(body, deps);
      if (message.notification) {
        return res.status(202).end();
      }
      return sendMcpMessage(req, res, 200, message);
    }

    const name = TOOL_RUNNERS[body.name] ? body.name : null;
    try {
      if (!name) {
        throw Object.assign(new Error('Unknown tool'), { code: 'unknown_tool' });
      }
      const feed = await runTool(name, toolArguments(body), deps);
      return sendJson(res, 200, feed);
    } catch (error) {
      if (VALIDATION_CODES.has(error.code)) {
        return sendJson(res, 400, { error: error.message, code: error.code });
      }
      if (error.code === 'unknown_tool') {
        return sendJson(res, 404, { error: error.message });
      }
      logger.error?.('zenbooker_jobs_direct_failed', { message: error.message });
      const status = error.code === 'zenbooker_unconfigured' ? 503 : 502;
      return sendJson(res, status, { error: 'Failed to load ZenBooker jobs' });
    }
  };
}

export default createMountingManZenbookerHandler();
