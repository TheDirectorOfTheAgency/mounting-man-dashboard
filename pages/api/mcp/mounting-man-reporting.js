// HTTP MCP for Grok custom connectors.
// Live Square COMPLETED-payment feed with cashier + tips. No buyer PII.
//
// Production: https://mounting-man-dashboard.vercel.app/api/mcp/mounting-man-reporting
// Auth: Authorization: Bearer <MCP_SQUARE_PAYROLL_SECRET> (also accepts CRON_SECRET)
// Data feed only. Does not compute payroll or pay anyone.

import axios from 'axios';
import {
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
  GET_MOUNTING_MAN_SQUARE_DETAIL,
  SQUARE_LOCATION_ID,
  createSquareReportingClient,
  getMountingManSquareDetail,
} from '../../../lib/square-reporting-feed.mjs';

const SERVER_INFO = {
  name: 'mounting-man-reporting',
  version: '1.0.0',
  title: 'Mounting Man Square Reporting',
};

const TOOLS = [
  {
    name: GET_MOUNTING_MAN_SQUARE_DETAIL,
    description:
      'COMPLETED Square payments for The Mounting Man (location LVNM3Z4RVRWDK) on an America/Chicago calendar date, or one payment by id. Returns payment_id, order_id, created_at, status, team_member_id, cashier_name, amount_money, line items (name + base_price_money, including brackets/hardware), tip_money, and processing_fee when present. Never returns buyer PII. Data feed only — no payroll math.',
    inputSchema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'America/Chicago calendar date as YYYY-MM-DD. Defaults to today if payment_id is omitted.',
        },
        payment_id: {
          type: 'string',
          description: 'Square payment id. When set, returns that COMPLETED payment only.',
        },
      },
    },
  },
];

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

function createDefaultSquareClient(env) {
  const token = env.SQUARE_ACCESS_TOKEN || env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
  const locationId = env.NEXT_PUBLIC_SQUARE_LOCATION_ID || SQUARE_LOCATION_ID;
  if (!token) return null;
  return createSquareReportingClient({
    token,
    locationId,
    httpClient: axios,
  });
}

async function runSquareDetailTool(args, { squareClient, now, logger }) {
  if (!squareClient) {
    const error = new Error('Square is not configured');
    error.code = 'square_unconfigured';
    throw error;
  }
  return getMountingManSquareDetail(args, {
    client: squareClient,
    now,
    logger,
  });
}

async function handleToolsCall(params, deps) {
  const name = params?.name;
  if (name !== GET_MOUNTING_MAN_SQUARE_DETAIL) {
    const error = new Error(`Unknown tool: ${name || ''}`);
    error.code = 'unknown_tool';
    throw error;
  }
  return runSquareDetailTool(parseToolArguments(params), deps);
}

async function dispatchMcp(body, deps) {
  const { method, id, params } = body;
  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        'Read-only Square COMPLETED payment feed for The Mounting Man. Includes cashier attribution and tips. No buyer PII. Data feed only — do not compute or pay payroll from this server.',
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
      const feed = await handleToolsCall(params, deps);
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(feed, null, 2) }],
        structuredContent: feed,
      });
    } catch (error) {
      if (error.code === 'invalid_date') {
        return jsonRpcError(id, -32602, error.message);
      }
      if (error.code === 'unknown_tool') {
        return jsonRpcError(id, -32601, error.message);
      }
      deps.logger?.error?.('square_reporting_tool_failed', { message: error.message });
      return jsonRpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: 'Failed to load Square reporting feed' }],
      });
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export function createMountingManReportingHandler(overrides = {}) {
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
        'WWW-Authenticate': mcpWwwAuthenticateHeader(),
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
        location_id: SQUARE_LOCATION_ID,
      });
    }

    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    const squareClient = overrides.squareClient !== undefined
      ? overrides.squareClient
      : createDefaultSquareClient(env);
    const deps = { squareClient, now, logger };
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    if (isJsonRpcRequest(body)) {
      const message = await dispatchMcp(body, deps);
      if (message.notification) {
        return res.status(202).end();
      }
      return sendMcpMessage(req, res, 200, message);
    }

    const directArgs = body.name === GET_MOUNTING_MAN_SQUARE_DETAIL
      ? parseToolArguments(body)
      : body;
    try {
      const feed = await runSquareDetailTool(directArgs, deps);
      return sendJson(res, 200, feed);
    } catch (error) {
      if (error.code === 'invalid_date') {
        return sendJson(res, 400, { error: error.message });
      }
      logger.error?.('square_reporting_direct_failed', { message: error.message });
      return sendJson(res, 500, { error: 'Failed to load Square reporting feed' });
    }
  };
}

export default createMountingManReportingHandler();
