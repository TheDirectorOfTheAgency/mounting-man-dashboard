// HTTP MCP for Grok custom connectors.
// Read-only ZenBooker schedule for The Mounting Man TV-mounting jobs.
//
// Production: https://mounting-man-dashboard.vercel.app/api/mcp/mounting-man-zenbooker
// OAuth client_id: mounting-man-zenbooker
// Authorize: https://mounting-man-dashboard.vercel.app/api/mcp/auth/authorize
// Token: https://mounting-man-dashboard.vercel.app/api/mcp/auth/token
// Auth: Authorization: Bearer <MCP_SQUARE_PAYROLL_SECRET> (also accepts CRON_SECRET)
// Same operator secrets as mounting-man-reporting / mounting-man-ads-apply.
// GET ZenBooker only. Does not create, update, cancel, or invoice jobs.

import {
  MCP_PUBLIC_ORIGIN,
  MCP_ZENBOOKER_RESOURCE_PATH,
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
  createZenbookerReadClient,
  runZenbookerTool,
} from '../../../lib/zenbooker-jobs-feed.mjs';

const SERVER_INFO = {
  name: 'mounting-man-zenbooker',
  version: '1.0.0',
  title: 'Mounting Man ZenBooker Jobs',
};

const JOB_FIELDS = 'job id, job number, time window, status, service(s), customer name, customer phone, full service address as one maps line, assigned installer(s), job notes and special instructions, and price when ZenBooker has one';

const TOOLS = [
  {
    name: GET_JOBS_FOR_DAY,
    description:
      `The Mounting Man's TV-mounting jobs from ZenBooker for one America/Chicago day. Use when Mr. Wayne asks what jobs he has today, tomorrow, or on a date — including jobs booked weeks ahead. Returns every job scheduled that day, sorted by start time, with ${JOB_FIELDS}. Cancelled jobs are left out unless include_cancelled is true. Read-only.`,
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'America/Chicago calendar date as YYYY-MM-DD. Defaults to today.',
        },
        include_cancelled: {
          type: 'boolean',
          description: 'When true, include cancelled ZenBooker jobs. Defaults to false.',
        },
      },
    },
  },
  {
    name: GET_UPCOMING_JOBS,
    description:
      `The Mounting Man's upcoming TV-mounting jobs from ZenBooker, grouped by America/Chicago day. Use for "what jobs do I have this week" or the next few weeks, including jobs booked ahead. Same fields as get_jobs_for_day: ${JOB_FIELDS}. days defaults to 7 and cannot exceed 31. Read-only.`,
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: 'Number of America/Chicago days starting today. Default 7. Maximum 31.',
        },
        include_cancelled: {
          type: 'boolean',
          description: 'When true, include cancelled ZenBooker jobs. Defaults to false.',
        },
      },
    },
  },
  {
    name: GET_JOB,
    description:
      "Full detail for one of The Mounting Man's ZenBooker TV-mounting jobs. Pass a ZenBooker job id or a job number such as 730395. Use when Mr. Wayne asks about a specific mount. Read-only.",
    inputSchema: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'ZenBooker job id. A numeric job number is also accepted here.',
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
      "Driving route for The Mounting Man's non-cancelled ZenBooker TV-mounting jobs on one America/Chicago day, in start-time order. Use when Mr. Wayne says route me to my jobs or asks for directions to today's mounts. Returns each stop plus a Google Maps multi-stop directions URL and an Apple Maps link for the first stop. Read-only.",
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

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

const VALIDATION_CODES = new Set([
  'invalid_date',
  'invalid_days',
  'invalid_job',
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

function createDefaultZenbookerClient(env) {
  const apiKey = String(env?.ZENBOOKER_API_KEY || '').trim();
  if (!apiKey) return null;
  return createZenbookerReadClient({
    apiKey,
    baseUrl: env.ZENBOOKER_BASE_URL,
  });
}

async function dispatchMcp(body, deps) {
  const { method, id, params } = body;
  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "Read-only ZenBooker schedule for The Mounting Man's TV-mounting jobs. Use these tools when Mr. Wayne asks what jobs he has today, on a future day, or to route him to each job. Dates are America/Chicago. Never create, update, cancel, or reschedule a job.",
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
      const result = await runZenbookerTool(params?.name, parseToolArguments(params), deps);
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
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
        'WWW-Authenticate': mcpWwwAuthenticateHeader(MCP_PUBLIC_ORIGIN, MCP_ZENBOOKER_RESOURCE_PATH),
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
      });
    }

    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    const zenbookerClient = overrides.zenbookerClient !== undefined
      ? overrides.zenbookerClient
      : createDefaultZenbookerClient(env);
    const deps = { client: zenbookerClient, now, logger };
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    if (isJsonRpcRequest(body)) {
      const message = await dispatchMcp(body, deps);
      if (message.notification) {
        return res.status(202).end();
      }
      return sendMcpMessage(req, res, 200, message);
    }

    const name = TOOL_NAMES.has(body.name) ? body.name : null;
    try {
      if (!name) {
        const error = new Error('Unknown tool');
        error.code = 'unknown_tool';
        throw error;
      }
      const result = await runZenbookerTool(name, parseToolArguments(body), deps);
      return sendJson(res, 200, result);
    } catch (error) {
      if (VALIDATION_CODES.has(error.code)) {
        return sendJson(res, 400, { error: error.message, code: error.code });
      }
      logger.error?.('zenbooker_jobs_direct_failed', { message: error.message });
      return sendJson(res, error.code === 'unknown_tool' ? 404 : 500, {
        error: error.code === 'unknown_tool' ? error.message : 'Failed to load ZenBooker jobs',
      });
    }
  };
}

export default createMountingManZenbookerHandler();
