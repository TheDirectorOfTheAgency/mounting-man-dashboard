// HTTP MCP for Grok custom connectors.
// Post X recaps as @MarshallWayne from grok.com Automations.
//
// Production: https://mounting-man-dashboard.vercel.app/api/mcp/marshallwayne-x
// Auth: Authorization: Bearer <MCP_SQUARE_PAYROLL_SECRET> (also accepts CRON_SECRET)
// Same operator secrets as mounting-man-reporting. No second auth scheme.

import axios from 'axios';
import {
  acceptedOperatorSecrets,
  isAuthorizedMcpRequest,
  isJsonRpcRequest,
  jsonRpcError,
  jsonRpcResult,
  negotiateProtocolVersion,
  parseToolArguments,
  wantsEventStream,
} from '../../../lib/mcp-http.mjs';
import {
  POST_MARSHALLWAYNE_RECAP,
  VERIFY_MARSHALLWAYNE,
  createMarshallWayneXClient,
} from '../../../lib/marshallwayne-x.mjs';

const SERVER_INFO = {
  name: 'marshallwayne-x',
  version: '1.1.0',
  title: 'MarshallWayne X recap',
};

const TOOLS = [
  {
    name: VERIFY_MARSHALLWAYNE,
    description:
      'OAuth 1.0a GET https://api.twitter.com/1.1/account/verify_credentials.json using MarshallWayne user tokens. Returns screen_name and user id. Fails closed if the account is not MarshallWayne (id 1395241563509252099). Does not post.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: POST_MARSHALLWAYNE_RECAP,
    description:
      'Post the text argument VERBATIM to X as @MarshallWayne, with a 1080x1350 Mounting Man recap card attached. No rewrite, no prepend, no hashtags, no truncation. Always verify_credentials first and refuse if the account is not MarshallWayne / 1395241563509252099. Empty or whitespace-only text is refused. Returns permalink, tweet id, and media_id. Set attach_image=false to post text only.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Tweet text posted exactly as provided. Do not rewrite.',
        },
        attach_image: {
          type: 'boolean',
          description: 'Attach the generated 4:5 recap card. Default true.',
        },
      },
      required: ['text'],
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

function createDefaultXClient(env) {
  return createMarshallWayneXClient({
    env,
    httpClient: axios,
  });
}

async function runTool(name, args, { xClient }) {
  if (name === VERIFY_MARSHALLWAYNE) {
    return xClient.verifyMarshallWayne();
  }
  if (name === POST_MARSHALLWAYNE_RECAP) {
    return xClient.postMarshallWayneRecap(args?.text, args || {});
  }
  const error = new Error(`Unknown tool: ${name || ''}`);
  error.code = 'unknown_tool';
  throw error;
}

async function handleToolsCall(params, deps) {
  return runTool(params?.name, parseToolArguments(params), deps);
}

async function dispatchMcp(body, deps) {
  const { method, id, params } = body;
  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        'Post X recaps as @MarshallWayne only. verify_marshallwayne confirms the user tokens. post_marshallwayne_recap posts the text argument verbatim and attaches a 1080x1350 recap card parsed from that text — no rewrite, no prepend, no hashtags, no truncation. Set attach_image=false for text only. Refuses empty text and any account that is not MarshallWayne / 1395241563509252099.',
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
      const result = await handleToolsCall(params, deps);
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });
    } catch (error) {
      if (error.code === 'empty_text') {
        return jsonRpcError(id, -32602, error.message);
      }
      if (error.code === 'unknown_tool') {
        return jsonRpcError(id, -32601, error.message);
      }
      deps.logger?.error?.('marshallwayne_x_tool_failed', { message: error.message });
      return jsonRpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: error.message }],
      });
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export function createMarshallWayneXHandler(overrides = {}) {
  return async function handler(req, res) {
    const env = overrides.env || process.env;
    const logger = overrides.logger || console;

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

    const xClient = overrides.xClient !== undefined
      ? overrides.xClient
      : createDefaultXClient(env);
    const deps = { xClient, logger };
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    if (isJsonRpcRequest(body)) {
      const message = await dispatchMcp(body, deps);
      if (message.notification) {
        return res.status(202).end();
      }
      return sendMcpMessage(req, res, 200, message);
    }

    const name = body.name === VERIFY_MARSHALLWAYNE || body.name === POST_MARSHALLWAYNE_RECAP
      ? body.name
      : POST_MARSHALLWAYNE_RECAP;
    const args = body.name ? parseToolArguments(body) : body;
    try {
      const result = await runTool(name, args, deps);
      return sendJson(res, 200, result);
    } catch (error) {
      if (error.code === 'empty_text') {
        return sendJson(res, 400, { error: error.message });
      }
      logger.error?.('marshallwayne_x_direct_failed', { message: error.message });
      return sendJson(res, error.code === 'unknown_tool' ? 404 : 500, { error: error.message });
    }
  };
}

export default createMarshallWayneXHandler();
