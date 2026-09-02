// HTTP MCP for Grok custom connectors.
// Tightly scoped Google Ads WRITE: pause allowlisted keywords + add campaign PHRASE negatives.
//
// Production: https://mounting-man-dashboard.vercel.app/api/mcp/mounting-man-ads-apply
// Auth: Authorization: Bearer <MCP_SQUARE_PAYROLL_SECRET> (also accepts CRON_SECRET)
// Same operator secrets as marshallwayne-x / mounting-man-reporting. No second auth scheme.
// Sibling of mounting-man-reporting — do not flip reporting to write.

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
  ADD_CAMPAIGN_PHRASE_NEGATIVES,
  DEFAULT_CUSTOMER_ID,
  GET_CRITERION_STATUS,
  PAUSE_AD_GROUP_CRITERION,
  createMountingManAdsApplyClient,
} from '../../../lib/mounting-man-ads-apply.mjs';

const SERVER_INFO = {
  name: 'mounting-man-ads-apply',
  version: '1.0.0',
  title: 'Mounting Man Ads APPLY',
};

const TOOLS = [
  {
    name: PAUSE_AD_GROUP_CRITERION,
    description:
      'PAUSE one ad-group keyword criterion on The Mounting Man (1287907452). Requires confirm:true. Refuses campaign or ad-group pause, budgets/bids, HTSA/Agency, Frame-campaign keyword pause (negatives only), fireplace/mantel/masonry/Frame-installer KEEP keywords, brand reviews, and the locked exacts [tv mounting near me], [tv installation near me], [tv installer near me], [tv mounting service]. Returns before_status, after_status, and resource_name.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: `Google Ads customer id. Must be ${DEFAULT_CUSTOMER_ID}.`,
        },
        criterion_id: {
          type: 'string',
          description: 'Ad group criterion id to PAUSE. Not a campaign id or ad group id.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true. Mutates are refused when confirm is missing or false.',
        },
      },
      required: ['criterion_id', 'confirm'],
    },
  },
  {
    name: ADD_CAMPAIGN_PHRASE_NEGATIVES,
    description:
      'Add campaign-level PHRASE negatives on an allowlisted Mounting Man Search campaign. Requires confirm:true. Allowlisted: 20867488270 MSP General, 23038170184 MSP Samsung Frame (negatives only), 23067449455 Austin General, 23246942122 Houston General. Refuses unknown campaigns, HTSA/Agency, KEEP keywords, brand reviews, and the four locked near-me exacts. Returns before_status, after_status, and resource_names.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: `Google Ads customer id. Must be ${DEFAULT_CUSTOMER_ID}.`,
        },
        campaign_id: {
          type: 'string',
          description: 'Allowlisted campaign id only.',
        },
        phrases: {
          type: 'array',
          items: { type: 'string' },
          description: 'Phrase-match negative keyword texts. Match type is always PHRASE.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true. Mutates are refused when confirm is missing or false.',
        },
      },
      required: ['campaign_id', 'phrases', 'confirm'],
    },
  },
  {
    name: GET_CRITERION_STATUS,
    description:
      'Read-back proof for an ad-group or campaign criterion after a mutate. READ-only. Uses login-customer-id 3167428631. Returns status, resource_name, keyword, and parent campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: `Google Ads customer id. Must be ${DEFAULT_CUSTOMER_ID}.`,
        },
        criterion_id: {
          type: 'string',
          description: 'Ad group or campaign criterion id.',
        },
        resource_name: {
          type: 'string',
          description: 'Optional Google Ads resource name. Used to recover criterion_id if omitted.',
        },
      },
      required: ['criterion_id'],
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

function createDefaultAdsClient(env) {
  return createMountingManAdsApplyClient({
    env,
    httpClient: axios,
  });
}

const ADS_TOOL_NAMES = new Set([
  PAUSE_AD_GROUP_CRITERION,
  ADD_CAMPAIGN_PHRASE_NEGATIVES,
  GET_CRITERION_STATUS,
]);

const VALIDATION_CODES = new Set([
  'confirm_required',
  'unknown_campaign',
  'unknown_customer',
  'invalid_customer',
  'invalid_criterion',
  'invalid_phrases',
  'keep_keyword',
  'refuse_campaign_pause',
  'refuse_ad_group_pause',
  'refuse_htsa_agency',
  'refuse_negative_pause',
  'negatives_only_campaign',
  'forbidden_mutate',
]);

async function runTool(name, args, { adsClient }) {
  if (name === PAUSE_AD_GROUP_CRITERION) {
    return adsClient.pauseAdGroupCriterion(args);
  }
  if (name === ADD_CAMPAIGN_PHRASE_NEGATIVES) {
    return adsClient.addCampaignPhraseNegatives(args);
  }
  if (name === GET_CRITERION_STATUS) {
    return adsClient.getCriterionStatus(args);
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
        'Tightly scoped Google Ads WRITE for The Mounting Man (1287907452). Tools: pause_ad_group_criterion, add_campaign_phrase_negatives, get_criterion_status. Mutates require confirm:true. WRITE omits login-customer-id. READ uses login-customer-id 3167428631. Allowlisted campaigns only. Never pause a campaign or ad group. Never change budgets or bids. Never touch HTSA/Agency. KEEP Frame installer / fireplace / mantel / masonry keywords and the locked exacts. Mounting Man Reporting stays read-only.',
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
      if (VALIDATION_CODES.has(error.code)) {
        return jsonRpcError(id, -32602, error.message);
      }
      if (error.code === 'unknown_tool') {
        return jsonRpcError(id, -32601, error.message);
      }
      deps.logger?.error?.('mounting_man_ads_apply_tool_failed', { message: error.message });
      return jsonRpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: error.message }],
      });
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export function createMountingManAdsApplyHandler(overrides = {}) {
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
        customer_id: DEFAULT_CUSTOMER_ID,
      });
    }

    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    const adsClient = overrides.adsClient !== undefined
      ? overrides.adsClient
      : createDefaultAdsClient(env);
    const deps = { adsClient, logger };
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    if (isJsonRpcRequest(body)) {
      const message = await dispatchMcp(body, deps);
      if (message.notification) {
        return res.status(202).end();
      }
      return sendMcpMessage(req, res, 200, message);
    }

    const name = ADS_TOOL_NAMES.has(body.name) ? body.name : null;
    const args = body.name ? parseToolArguments(body) : body;
    try {
      if (!name) {
        const error = new Error('Unknown tool');
        error.code = 'unknown_tool';
        throw error;
      }
      const result = await runTool(name, args, deps);
      return sendJson(res, 200, result);
    } catch (error) {
      if (VALIDATION_CODES.has(error.code)) {
        return sendJson(res, 400, { error: error.message, code: error.code });
      }
      logger.error?.('mounting_man_ads_apply_direct_failed', { message: error.message });
      return sendJson(res, error.code === 'unknown_tool' ? 404 : 500, { error: error.message });
    }
  };
}

export default createMountingManAdsApplyHandler();
