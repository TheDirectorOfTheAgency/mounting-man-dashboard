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
  GET_JOB,
  GET_JOBS_FOR_DAY,
  GET_ROUTE_FOR_DAY,
  GET_UPCOMING_JOBS,
  MCP_ZENBOOKER_CLIENT_ID,
  createZenbookerReadClientFromEnv,
  getJob,
  getJobsForDay,
  getRouteForDay,
  getUpcomingJobs,
} from '../../../lib/zenbooker-jobs-feed.mjs';

const SERVER_INFO = {
  name: 'mounting-man-zenbooker',
  version: '1.0.0',
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
];

const TOOL_RUNNERS = {
  [GET_JOBS_FOR_DAY]: getJobsForDay,
  [GET_UPCOMING_JOBS]: getUpcomingJobs,
  [GET_JOB]: getJob,
  [GET_ROUTE_FOR_DAY]: getRouteForDay,
};

const VALIDATION_CODES = new Set(['invalid_date', 'invalid_days', 'invalid_job']);

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
        "Read-only ZenBooker feed of The Mounting Man's TV-mounting jobs in America/Chicago. Use get_jobs_for_day for 'what jobs do I have today', get_upcoming_jobs for the coming days, get_job for one job id or job number, and get_route_for_day for 'route me to my jobs' (Google Maps multi-stop URL plus Apple Maps for the first stop). Never create, update, cancel, or reschedule a job.",
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
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(feed, null, 2) }],
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
    const deps = { client, now, logger };
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
