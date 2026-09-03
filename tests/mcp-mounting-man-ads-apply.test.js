import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { GET_MOUNTING_MAN_SQUARE_DETAIL } from '../lib/square-reporting-feed.mjs';
import {
  ADD_CAMPAIGN_PHRASE_NEGATIVES,
  ADS_API_VERSION,
  ADS_APPLY_TOOLS,
  DEFAULT_ADS_API_VERSION,
  DEFAULT_CUSTOMER_ID,
  GET_CRITERION_STATUS,
  PAUSE_AD_GROUP_CRITERION,
  READ_LOGIN_CUSTOMER_ID,
  createMountingManAdsApplyClient,
  formatAdGroupCriterionMatches,
  googleAdsAdGroupCriteriaMutateUrl,
  googleAdsCampaignCriteriaMutateUrl,
  googleAdsSearchUrl,
  parseAdGroupCriterionResourceName,
  resolveAdsApiVersion,
  resolveAdGroupCriterionMatch,
} from '../lib/mounting-man-ads-apply.mjs';
import { createMountingManAdsApplyHandler } from '../pages/api/mcp/mounting-man-ads-apply.js';
import { createMountingManReportingHandler } from '../pages/api/mcp/mounting-man-reporting.js';

const AUTH_ENV = {
  MCP_SQUARE_PAYROLL_SECRET: 'test-mcp-secret',
};

const ADS_TOKENS = {
  getAccessToken: async () => 'test-access-token',
  getDeveloperToken: () => 'test-developer-token',
};

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    ended: false,
    chunks: [],
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function request({ method = 'POST', headers = {}, body = {}, query = {} } = {}) {
  return { method, headers, body, query };
}

function authorized(overrides = {}) {
  return request({
    headers: { authorization: 'Bearer test-mcp-secret', accept: 'application/json' },
    ...overrides,
  });
}

function recordingHttp(handler) {
  const calls = [];
  return {
    calls,
    async request(config) {
      calls.push(config);
      return handler(config);
    },
  };
}

function handlerWithClient(adsClient, env = AUTH_ENV) {
  return createMountingManAdsApplyHandler({
    env,
    adsClient,
    logger: { error() {}, warn() {} },
  });
}

function handlerWithHttp(httpClient, env = AUTH_ENV) {
  return createMountingManAdsApplyHandler({
    env,
    adsClient: createMountingManAdsApplyClient({
      env,
      httpClient,
      ...ADS_TOKENS,
    }),
    logger: { error() {}, warn() {} },
  });
}

function searchBatch(results) {
  return { data: [{ results }] };
}

function mutateResults(resourceNames) {
  return { data: { results: resourceNames.map((resourceName) => ({ resourceName })) } };
}

function keywordRow({
  criterionId = '555000111222',
  status = 'ENABLED',
  text = 'tv mount service near me',
  matchType = 'EXACT',
  campaignId = '20867488270',
  campaignName = 'MSP - General TV Mounting',
  adGroupId = '185159817785',
  adGroupName = 'MSP | TV Mounting - Near Me',
  negative = false,
} = {}) {
  return {
    adGroupCriterion: {
      resourceName: `customers/${DEFAULT_CUSTOMER_ID}/adGroupCriteria/${adGroupId}~${criterionId}`,
      criterionId,
      status,
      negative,
      keyword: { text, matchType },
    },
    campaign: { id: campaignId, name: campaignName },
    adGroup: { id: adGroupId, name: adGroupName },
  };
}

function campaignRow({ id = '20867488270', name = 'MSP - General TV Mounting', status = 'ENABLED' } = {}) {
  return { campaign: { id, name, status } };
}

function adGroupRow({
  id = '185159817785',
  name = 'MSP | TV Mounting - Near Me',
  campaignId = '20867488270',
} = {}) {
  return {
    adGroup: { id, name, status: 'ENABLED' },
    campaign: { id: campaignId, name: 'MSP - General TV Mounting' },
  };
}

const COLLISION_CRITERION_ID = '314304139163';
const HOLD_AD_GROUP_ID = '185159817785';
const HOLD_RESOURCE_NAME = `customers/${DEFAULT_CUSTOMER_ID}/adGroupCriteria/${HOLD_AD_GROUP_ID}~${COLLISION_CRITERION_ID}`;

function collisionKeywordRows({ holdStatus = 'PAUSED' } = {}) {
  return [
    keywordRow({
      criterionId: COLLISION_CRITERION_ID,
      campaignId: '19927004057',
      campaignName: 'DM Lead Gen',
      adGroupId: '147809640156',
      adGroupName: 'DM Lead Gen',
      status: 'ENABLED',
    }),
    keywordRow({
      criterionId: COLLISION_CRITERION_ID,
      campaignId: '20825069166',
      campaignName: 'Nationwide',
      adGroupId: '161961230608',
      adGroupName: 'Nationwide',
      status: 'ENABLED',
    }),
    keywordRow({
      criterionId: COLLISION_CRITERION_ID,
      campaignId: '20867488270',
      campaignName: 'MSP - General TV Mounting',
      adGroupId: '160447947247',
      adGroupName: 'MSP General / Nationwide',
      status: 'ENABLED',
    }),
    keywordRow({
      criterionId: COLLISION_CRITERION_ID,
      campaignId: '20867488270',
      campaignName: 'MSP - General TV Mounting',
      adGroupId: HOLD_AD_GROUP_ID,
      adGroupName: 'MSP | TV Mounting - Near Me',
      status: holdStatus,
    }),
  ];
}

function uniqueAllowlistedCollisionRows(options) {
  return collisionKeywordRows(options).filter((row) => row.adGroup.id !== '160447947247');
}

function nonAllowlistedCollisionRows() {
  return collisionKeywordRows().filter((row) => (
    row.campaign.id === '19927004057' || row.campaign.id === '20825069166'
  ));
}

function matchFromKeywordRow(row) {
  return {
    criterion_id: row.adGroupCriterion.criterionId,
    resource_name: row.adGroupCriterion.resourceName,
    status: row.adGroupCriterion.status,
    campaign_id: row.campaign.id,
    ad_group_id: row.adGroup.id,
  };
}

function campaignNegativeRow({
  criterionId = '297614770950',
  text = 'tv mount service near me',
  campaignId = '20867488270',
  status = 'ENABLED',
} = {}) {
  return {
    campaignCriterion: {
      resourceName: `customers/${DEFAULT_CUSTOMER_ID}/campaignCriteria/${campaignId}~${criterionId}`,
      criterionId,
      status,
      negative: true,
      keyword: { text, matchType: 'PHRASE' },
    },
    campaign: { id: campaignId, name: 'MSP - General TV Mounting' },
  };
}

function queryOf(config) {
  return String(config?.data?.query || '');
}

function isSearch(config) {
  return String(config?.url || '').includes('googleAds:searchStream');
}

function isMutate(config) {
  return String(config?.url || '').includes(':mutate');
}

function assertAdsApiUrl(url, version = DEFAULT_ADS_API_VERSION) {
  const value = String(url || '');
  assert.match(value, new RegExp(`/${version}/`));
  if (version !== 'v20') {
    assert.equal(value.includes('/v20/'), false, value);
  }
}

function assertAdsHttpVersions(calls, version = DEFAULT_ADS_API_VERSION) {
  const adsCalls = calls.filter((call) => String(call?.url || '').includes('googleads.googleapis.com'));
  assert.ok(adsCalls.length > 0, 'expected mocked Google Ads HTTP');
  for (const call of adsCalls) {
    assertAdsApiUrl(call.url, version);
    if (isSearch(call)) {
      assert.match(String(call.url), /googleAds:searchStream/);
    }
    if (isMutate(call)) {
      assert.match(String(call.url), /:mutate/);
    }
  }
}

test('MCP route rejects missing or wrong Bearer secrets', async () => {
  const handler = handlerWithClient(null);
  const missing = response();
  await handler(request({
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  }), missing);
  assert.equal(missing.statusCode, 401);
  assert.equal(
    missing.headers['www-authenticate'],
    'Bearer realm="mcp", resource_metadata="https://mounting-man-dashboard.vercel.app/.well-known/oauth-protected-resource", scope="mcp"',
  );

  const wrong = response();
  await handler(request({
    headers: { authorization: 'Bearer nope' },
    body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  }), wrong);
  assert.equal(wrong.statusCode, 401);
  assert.equal(String(wrong.headers['www-authenticate'] || '').includes('scope="mcp"'), true);
});

test('tools/list returns exactly the three v1 Ads APPLY tools', async () => {
  const handler = handlerWithClient(null);
  const res = response();
  await handler(authorized({
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  }), res);

  assert.equal(res.statusCode, 200);
  const names = res.body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    PAUSE_AD_GROUP_CRITERION,
    ADD_CAMPAIGN_PHRASE_NEGATIVES,
    GET_CRITERION_STATUS,
  ]);
  assert.deepEqual(names, ADS_APPLY_TOOLS);
  assert.equal(names.length, 3);
});

test('initialize and tools/list accept MCP_SQUARE_PAYROLL_SECRET and CRON_SECRET', async () => {
  const mcpHandler = handlerWithClient(null);
  const mcpRes = response();
  await mcpHandler(authorized({
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
  }), mcpRes);
  assert.equal(mcpRes.statusCode, 200);
  assert.equal(mcpRes.body.result.serverInfo.name, 'mounting-man-ads-apply');
  assert.equal(mcpRes.body.result.protocolVersion, '2025-03-26');

  const cronHandler = handlerWithClient(null, { CRON_SECRET: 'existing-cron' });
  const cronRes = response();
  await cronHandler(request({
    headers: { authorization: 'Bearer existing-cron' },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  }), cronRes);
  assert.equal(cronRes.statusCode, 200);
  assert.deepEqual(
    cronRes.body.result.tools.map((tool) => tool.name),
    ADS_APPLY_TOOLS,
  );
});

test('confirm gate refuses pause and negatives when confirm is missing or false', async () => {
  const http = recordingHttp(() => {
    throw new Error('Google Ads must not be called without confirm:true');
  });
  const handler = handlerWithHttp(http);

  for (const confirm of [undefined, false]) {
    const pause = response();
    await handler(authorized({
      body: {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: PAUSE_AD_GROUP_CRITERION,
          arguments: {
            customer_id: DEFAULT_CUSTOMER_ID,
            criterion_id: '555000111222',
            ...(confirm === undefined ? {} : { confirm }),
          },
        },
      },
    }), pause);
    assert.equal(pause.statusCode, 200);
    assert.equal(pause.body.error.code, -32602);
    assert.match(pause.body.error.message, /confirm/i);

    const negatives = response();
    await handler(authorized({
      body: {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: ADD_CAMPAIGN_PHRASE_NEGATIVES,
          arguments: {
            campaign_id: '20867488270',
            phrases: ['cheap tv mounting'],
            ...(confirm === undefined ? {} : { confirm }),
          },
        },
      },
    }), negatives);
    assert.equal(negatives.body.error.code, -32602);
    assert.match(negatives.body.error.message, /confirm/i);
  }
  assert.equal(http.calls.length, 0);
});

test('allowlist accepts MSP General and refuses an unknown campaign before mutate', async () => {
  const http = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('ad_group_criterion')) {
      return searchBatch([keywordRow()]);
    }
    if (isSearch(config) && queryOf(config).includes('campaign_criterion.keyword.text')) {
      return searchBatch([]);
    }
    if (isSearch(config) && queryOf(config).includes('FROM campaign_criterion')) {
      return searchBatch([campaignNegativeRow()]);
    }
    if (config.url === googleAdsAdGroupCriteriaMutateUrl(DEFAULT_CUSTOMER_ID)) {
      return mutateResults([keywordRow().adGroupCriterion.resourceName]);
    }
    if (config.url === googleAdsCampaignCriteriaMutateUrl(DEFAULT_CUSTOMER_ID)) {
      return mutateResults([`customers/${DEFAULT_CUSTOMER_ID}/campaignCriteria/20867488270~297614770950`]);
    }
    throw new Error(`unexpected Ads call ${config.method} ${config.url}`);
  });
  const handler = handlerWithHttp(http);

  const accepted = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: ADD_CAMPAIGN_PHRASE_NEGATIVES,
        arguments: {
          campaign_id: '20867488270',
          phrases: ['cheap tv mounting'],
          confirm: true,
        },
      },
    },
  }), accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body.result.isError, undefined);
  assert.equal(accepted.body.result.structuredContent.campaign_id, '20867488270');
  assert.equal(accepted.body.result.structuredContent.after_status[0].status, 'ENABLED');
  assert.ok(accepted.body.result.structuredContent.resource_names[0]);

  const refused = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: ADD_CAMPAIGN_PHRASE_NEGATIVES,
        arguments: {
          campaign_id: '99999999999',
          phrases: ['cheap tv mounting'],
          confirm: true,
        },
      },
    },
  }), refused);
  assert.equal(refused.body.error.code, -32602);
  assert.match(refused.body.error.message, /unknown campaign/i);

  const pauseUnknown = response();
  const pauseHttp = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('ad_group_criterion')) {
      return searchBatch([keywordRow({ campaignId: '6017386949', campaignName: 'Unlisted leftover' })]);
    }
    throw new Error('mutate must not run for unknown campaign');
  });
  const pauseHandler = handlerWithHttp(pauseHttp);
  await pauseHandler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: {
        name: PAUSE_AD_GROUP_CRITERION,
        arguments: { criterion_id: '555000111222', confirm: true },
      },
    },
  }), pauseUnknown);
  assert.equal(pauseUnknown.body.error.code, -32602);
  assert.match(pauseUnknown.body.error.message, /unknown campaign/i);
  assert.equal(pauseHttp.calls.some(isMutate), false);
  assertAdsHttpVersions(http.calls);
  assertAdsHttpVersions(pauseHttp.calls);
});

test('WRITE mutate omits login-customer-id and READ sends 3167428631', async () => {
  let pauseLookups = 0;
  const http = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('FROM ad_group_criterion')) {
      pauseLookups += 1;
      return searchBatch([keywordRow({ status: pauseLookups === 1 ? 'ENABLED' : 'PAUSED' })]);
    }
    if (config.url === googleAdsAdGroupCriteriaMutateUrl(DEFAULT_CUSTOMER_ID)) {
      return mutateResults([keywordRow().adGroupCriterion.resourceName]);
    }
    throw new Error(`unexpected Ads call ${config.method} ${config.url}`);
  });
  const handler = handlerWithHttp(http);
  const res = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: {
        name: PAUSE_AD_GROUP_CRITERION,
        arguments: {
          customer_id: DEFAULT_CUSTOMER_ID,
          criterion_id: '555000111222',
          confirm: true,
        },
      },
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.structuredContent.before_status, 'ENABLED');
  assert.equal(res.body.result.structuredContent.after_status, 'PAUSED');
  assert.equal(
    res.body.result.structuredContent.resource_name,
    keywordRow().adGroupCriterion.resourceName,
  );

  const reads = http.calls.filter(isSearch);
  const writes = http.calls.filter(isMutate);
  assert.ok(reads.length >= 2);
  assert.equal(writes.length, 1);
  assertAdsHttpVersions(http.calls);
  for (const call of reads) {
    assert.equal(call.url, googleAdsSearchUrl(DEFAULT_CUSTOMER_ID));
    assert.match(call.url, /\/v24\//);
    assert.equal(call.url.includes('/v20/'), false);
    assert.equal(call.headers['login-customer-id'], READ_LOGIN_CUSTOMER_ID);
    assert.equal(call.headers.Authorization, 'Bearer test-access-token');
    assert.equal(call.headers['developer-token'], 'test-developer-token');
  }
  assert.match(writes[0].url, /\/v24\//);
  assert.equal(writes[0].url.includes('/v20/'), false);
  assert.equal('login-customer-id' in writes[0].headers, false);
  assert.equal(writes[0].headers['login-customer-id'], undefined);
  assert.equal(writes[0].data.operations[0].update.status, 'PAUSED');
  assert.equal(writes[0].data.operations[0].updateMask, 'status');
});

test('add_campaign_phrase_negatives mutate omits login-customer-id', async () => {
  const http = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('campaign_criterion.keyword.text')) {
      return searchBatch([]);
    }
    if (isSearch(config) && queryOf(config).includes('FROM campaign_criterion')) {
      return searchBatch([campaignNegativeRow({ text: 'diy tv mount' })]);
    }
    if (config.url === googleAdsCampaignCriteriaMutateUrl(DEFAULT_CUSTOMER_ID)) {
      return mutateResults([`customers/${DEFAULT_CUSTOMER_ID}/campaignCriteria/23038170184~297614770950`]);
    }
    throw new Error(`unexpected Ads call ${config.method} ${config.url}`);
  });
  const handler = handlerWithHttp(http);
  const res = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: ADD_CAMPAIGN_PHRASE_NEGATIVES,
        arguments: {
          campaign_id: '23038170184',
          phrases: ['diy tv mount'],
          confirm: true,
        },
      },
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.structuredContent.campaign_id, '23038170184');
  assert.equal(res.body.result.structuredContent.before_status[0].status, 'ABSENT');
  assert.equal(res.body.result.structuredContent.after_status[0].status, 'ENABLED');
  const write = http.calls.find(isMutate);
  assert.ok(write);
  assertAdsHttpVersions(http.calls);
  assert.match(write.url, /\/v24\//);
  assert.equal(write.url.includes('/v20/'), false);
  assert.equal('login-customer-id' in write.headers, false);
  assert.equal(write.data.operations[0].create.negative, true);
  assert.equal(write.data.operations[0].create.keyword.matchType, 'PHRASE');
  assert.equal(http.calls.filter(isSearch).every((call) => (
    call.headers['login-customer-id'] === READ_LOGIN_CUSTOMER_ID
    && String(call.url).includes('/v24/')
    && !String(call.url).includes('/v20/')
  )), true);
});

test('get_criterion_status is read-only and sends login-customer-id 3167428631', async () => {
  const http = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('FROM ad_group_criterion')) {
      return searchBatch([keywordRow({ status: 'PAUSED' })]);
    }
    throw new Error(`unexpected Ads call ${config.method} ${config.url}`);
  });
  const handler = handlerWithHttp(http);
  const res = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: GET_CRITERION_STATUS,
        arguments: { criterion_id: '555000111222' },
      },
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.structuredContent.status, 'PAUSED');
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, googleAdsSearchUrl(DEFAULT_CUSTOMER_ID));
  assert.match(http.calls[0].url, /\/v24\//);
  assert.equal(http.calls[0].url.includes('/v20/'), false);
  assert.equal(http.calls[0].headers['login-customer-id'], READ_LOGIN_CUSTOMER_ID);
  assert.equal(http.calls.some(isMutate), false);
  assertAdsHttpVersions(http.calls);
});

test('resolveAdGroupCriterionMatch picks unique allowlisted and refuses collisions', () => {
  const unique = uniqueAllowlistedCollisionRows().map(matchFromKeywordRow);
  const picked = resolveAdGroupCriterionMatch(unique, { criterionId: COLLISION_CRITERION_ID });
  assert.equal(picked.ad_group_id, HOLD_AD_GROUP_ID);
  assert.equal(picked.campaign_id, '20867488270');

  const parsed = parseAdGroupCriterionResourceName(HOLD_RESOURCE_NAME);
  assert.equal(parsed.adGroupId, HOLD_AD_GROUP_ID);
  assert.equal(parsed.criterionId, COLLISION_CRITERION_ID);

  const all = collisionKeywordRows().map(matchFromKeywordRow);
  assert.throws(
    () => resolveAdGroupCriterionMatch(all, { criterionId: COLLISION_CRITERION_ID }),
    (error) => error.code === 'ambiguous_criterion'
      && String(error.message).includes('ad_group_id=185159817785')
      && String(error.message).includes('ad_group_id=160447947247')
      && String(error.message).includes('ad_group_id=147809640156'),
  );

  const hold = resolveAdGroupCriterionMatch(all, {
    criterionId: COLLISION_CRITERION_ID,
    adGroupId: HOLD_AD_GROUP_ID,
  });
  assert.equal(hold.resource_name, HOLD_RESOURCE_NAME);

  const byName = resolveAdGroupCriterionMatch(all, { resourceName: HOLD_RESOURCE_NAME });
  assert.equal(byName.ad_group_id, HOLD_AD_GROUP_ID);

  const offAllowlist = nonAllowlistedCollisionRows().map(matchFromKeywordRow);
  assert.throws(
    () => resolveAdGroupCriterionMatch(offAllowlist, { criterionId: COLLISION_CRITERION_ID }),
    (error) => error.code === 'unknown_campaign'
      && String(error.message).includes('not on an allowlisted campaign')
      && String(error.message).includes('campaign_id=19927004057'),
  );

  assert.match(
    formatAdGroupCriterionMatches(all),
    /campaign_id=20867488270 ad_group_id=185159817785 status=PAUSED/,
  );
});

test('get_criterion_status and pause pick a unique allowlisted criterion_id match', async () => {
  const statusHttp = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('FROM ad_group_criterion')) {
      return searchBatch(uniqueAllowlistedCollisionRows());
    }
    throw new Error(`unexpected Ads call ${config.method} ${config.url}`);
  });
  const statusHandler = handlerWithHttp(statusHttp);
  const status = response();
  await statusHandler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 33,
      method: 'tools/call',
      params: {
        name: GET_CRITERION_STATUS,
        arguments: { criterion_id: COLLISION_CRITERION_ID },
      },
    },
  }), status);
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.result.structuredContent.ad_group_id, HOLD_AD_GROUP_ID);
  assert.equal(status.body.result.structuredContent.campaign_id, '20867488270');
  assert.equal(status.body.result.structuredContent.resource_name, HOLD_RESOURCE_NAME);
  assert.equal(statusHttp.calls.some(isMutate), false);

  let pauseLookups = 0;
  const pauseHttp = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('FROM ad_group_criterion')) {
      pauseLookups += 1;
      return searchBatch(uniqueAllowlistedCollisionRows({
        holdStatus: pauseLookups === 1 ? 'ENABLED' : 'PAUSED',
      }));
    }
    if (config.url === googleAdsAdGroupCriteriaMutateUrl(DEFAULT_CUSTOMER_ID)) {
      return mutateResults([HOLD_RESOURCE_NAME]);
    }
    throw new Error(`unexpected Ads call ${config.method} ${config.url}`);
  });
  const pauseHandler = handlerWithHttp(pauseHttp);
  const pause = response();
  await pauseHandler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: {
        name: PAUSE_AD_GROUP_CRITERION,
        arguments: { criterion_id: COLLISION_CRITERION_ID, confirm: true },
      },
    },
  }), pause);
  assert.equal(pause.statusCode, 200);
  assert.equal(pause.body.result.structuredContent.ad_group_id, HOLD_AD_GROUP_ID);
  assert.equal(pause.body.result.structuredContent.resource_name, HOLD_RESOURCE_NAME);
  assert.equal(pause.body.result.structuredContent.before_status, 'ENABLED');
  assert.equal(pause.body.result.structuredContent.after_status, 'PAUSED');
  const write = pauseHttp.calls.find(isMutate);
  assert.ok(write);
  assert.equal(write.data.operations[0].update.resourceName, HOLD_RESOURCE_NAME);
  assert.equal('login-customer-id' in write.headers, false);
  assertAdsHttpVersions(statusHttp.calls);
  assertAdsHttpVersions(pauseHttp.calls);
});

test('ambiguous multi-allowlisted criterion_id refuses without mutating', async () => {
  const http = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('FROM ad_group_criterion')) {
      return searchBatch(collisionKeywordRows());
    }
    throw new Error('mutate must not run for ambiguous criterion_id');
  });
  const handler = handlerWithHttp(http);

  const status = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 35,
      method: 'tools/call',
      params: {
        name: GET_CRITERION_STATUS,
        arguments: { criterion_id: COLLISION_CRITERION_ID },
      },
    },
  }), status);
  assert.equal(status.body.error.code, -32602);
  assert.match(status.body.error.message, /ambiguous_criterion/);
  assert.match(status.body.error.message, /ad_group_id=185159817785/);
  assert.match(status.body.error.message, /ad_group_id=160447947247/);
  assert.match(status.body.error.message, /ad_group_id=147809640156/);
  assert.match(status.body.error.message, /resource_name=customers\/1287907452\/adGroupCriteria\/185159817785~314304139163/);

  const pause = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 36,
      method: 'tools/call',
      params: {
        name: PAUSE_AD_GROUP_CRITERION,
        arguments: { criterion_id: COLLISION_CRITERION_ID, confirm: true },
      },
    },
  }), pause);
  assert.equal(pause.body.error.code, -32602);
  assert.match(pause.body.error.message, /ambiguous_criterion/);
  assert.match(pause.body.error.message, /ad_group_id or resource_name/);
  assert.equal(http.calls.some(isMutate), false);
  assertAdsHttpVersions(http.calls);
});

test('ad_group_id and resource_name disambiguate a colliding criterion_id', async () => {
  let lookups = 0;
  const http = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('FROM ad_group_criterion')) {
      lookups += 1;
      return searchBatch(collisionKeywordRows({
        holdStatus: lookups === 1 || lookups === 2 ? 'ENABLED' : 'PAUSED',
      }));
    }
    if (config.url === googleAdsAdGroupCriteriaMutateUrl(DEFAULT_CUSTOMER_ID)) {
      return mutateResults([HOLD_RESOURCE_NAME]);
    }
    throw new Error(`unexpected Ads call ${config.method} ${config.url}`);
  });
  const handler = handlerWithHttp(http);

  const byAdGroup = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 37,
      method: 'tools/call',
      params: {
        name: GET_CRITERION_STATUS,
        arguments: {
          criterion_id: COLLISION_CRITERION_ID,
          ad_group_id: HOLD_AD_GROUP_ID,
        },
      },
    },
  }), byAdGroup);
  assert.equal(byAdGroup.statusCode, 200);
  assert.equal(byAdGroup.body.result.structuredContent.ad_group_id, HOLD_AD_GROUP_ID);
  assert.equal(byAdGroup.body.result.structuredContent.status, 'ENABLED');
  assert.match(queryOf(http.calls[0]), /ad_group\.id = 185159817785/);

  const byResource = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 38,
      method: 'tools/call',
      params: {
        name: PAUSE_AD_GROUP_CRITERION,
        arguments: {
          criterion_id: COLLISION_CRITERION_ID,
          resource_name: HOLD_RESOURCE_NAME,
          confirm: true,
        },
      },
    },
  }), byResource);
  assert.equal(byResource.statusCode, 200);
  assert.equal(byResource.body.result.structuredContent.ad_group_id, HOLD_AD_GROUP_ID);
  assert.equal(byResource.body.result.structuredContent.before_status, 'ENABLED');
  assert.equal(byResource.body.result.structuredContent.after_status, 'PAUSED');
  assert.equal(byResource.body.result.structuredContent.resource_name, HOLD_RESOURCE_NAME);
  const write = http.calls.find(isMutate);
  assert.ok(write);
  assert.equal(write.data.operations[0].update.resourceName, HOLD_RESOURCE_NAME);
  assert.equal('login-customer-id' in write.headers, false);
  assert.match(queryOf(http.calls.find((call) => (
    isSearch(call) && String(call.data?.query || '').includes("ad_group_criterion.resource_name = '")
  ))), /adGroupCriteria\/185159817785~314304139163/);
  assertAdsHttpVersions(http.calls);
});

test('non-allowlisted-only criterion_id collisions refuse unknown_campaign', async () => {
  const http = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('FROM ad_group_criterion')) {
      return searchBatch(nonAllowlistedCollisionRows());
    }
    throw new Error('mutate must not run for non-allowlisted criterion collisions');
  });
  const handler = handlerWithHttp(http);

  const status = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 39,
      method: 'tools/call',
      params: {
        name: GET_CRITERION_STATUS,
        arguments: { criterion_id: COLLISION_CRITERION_ID },
      },
    },
  }), status);
  assert.equal(status.body.error.code, -32602);
  assert.match(status.body.error.message, /unknown campaign/i);
  assert.match(status.body.error.message, /not on an allowlisted campaign/);
  assert.match(status.body.error.message, /campaign_id=19927004057/);
  assert.match(status.body.error.message, /campaign_id=20825069166/);
  assert.equal(String(status.body.error.message).includes('campaign_id=20867488270'), false);

  const pause = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: {
        name: PAUSE_AD_GROUP_CRITERION,
        arguments: { criterion_id: COLLISION_CRITERION_ID, confirm: true },
      },
    },
  }), pause);
  assert.equal(pause.body.error.code, -32602);
  assert.match(pause.body.error.message, /unknown campaign/i);
  assert.equal(http.calls.some(isMutate), false);
  assert.equal(pause.body.result?.structuredContent, undefined);
  assertAdsHttpVersions(http.calls);
});

test('refuses campaign pause and ad-group pause without mutating', async () => {
  const http = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('FROM ad_group_criterion')) {
      return searchBatch([]);
    }
    if (isSearch(config) && queryOf(config).includes('FROM campaign')) {
      return searchBatch([campaignRow()]);
    }
    if (isSearch(config) && queryOf(config).includes('FROM ad_group')) {
      return searchBatch([adGroupRow()]);
    }
    throw new Error('mutate must not run for campaign/ad-group pause');
  });
  const handler = handlerWithHttp(http);

  const campaignArgs = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: {
        name: PAUSE_AD_GROUP_CRITERION,
        arguments: { campaign_id: '20867488270', confirm: true },
      },
    },
  }), campaignArgs);
  assert.equal(campaignArgs.body.error.code, -32602);
  assert.match(campaignArgs.body.error.message, /campaign pause/i);

  const campaignAsCriterion = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: {
        name: PAUSE_AD_GROUP_CRITERION,
        arguments: { criterion_id: '20867488270', confirm: true },
      },
    },
  }), campaignAsCriterion);
  assert.equal(campaignAsCriterion.body.error.code, -32602);
  assert.match(campaignAsCriterion.body.error.message, /campaign pause/i);

  const adGroupArgs = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: {
        name: PAUSE_AD_GROUP_CRITERION,
        arguments: { ad_group_id: '185159817785', confirm: true },
      },
    },
  }), adGroupArgs);
  assert.equal(adGroupArgs.body.error.code, -32602);
  assert.match(adGroupArgs.body.error.message, /ad group pause/i);

  const adGroupLookup = response();
  const lookupHttp = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('FROM ad_group_criterion')) {
      return searchBatch([]);
    }
    if (isSearch(config) && queryOf(config).includes('FROM campaign WHERE')) {
      return searchBatch([]);
    }
    if (isSearch(config) && queryOf(config).includes('FROM ad_group')) {
      return searchBatch([adGroupRow({ id: '185832605716', name: 'Large TVs' })]);
    }
    throw new Error('mutate must not run for ad group lookup pause');
  });
  const lookupHandler = handlerWithHttp(lookupHttp);
  await lookupHandler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 43,
      method: 'tools/call',
      params: {
        name: PAUSE_AD_GROUP_CRITERION,
        arguments: { criterion_id: '185832605716', confirm: true },
      },
    },
  }), adGroupLookup);
  assert.equal(adGroupLookup.body.error.code, -32602);
  assert.match(adGroupLookup.body.error.message, /ad group pause/i);
  assert.equal(http.calls.some(isMutate), false);
  assert.equal(lookupHttp.calls.some(isMutate), false);
  assertAdsHttpVersions(lookupHttp.calls);
});

test('refuses KEEP keywords and the four locked exacts without mutating', async () => {
  const keepTexts = [
    'tv mounting near me',
    'tv installation near me',
    'tv installer near me',
    'tv mounting service',
    'Frame TV installer near me',
    'tv over fireplace mount',
    'mantelmount installation',
    'masonry tv mounting',
    'the mounting man reviews',
  ];

  for (const text of keepTexts) {
    const http = recordingHttp((config) => {
      if (isSearch(config) && queryOf(config).includes('FROM ad_group_criterion')) {
        return searchBatch([keywordRow({ text })]);
      }
      throw new Error(`mutate must not run for KEEP keyword ${text}`);
    });
    const handler = handlerWithHttp(http);
    const res = response();
    await handler(authorized({
      body: {
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: {
          name: PAUSE_AD_GROUP_CRITERION,
          arguments: { criterion_id: '555000111222', confirm: true },
        },
      },
    }), res);
    assert.equal(res.body.error.code, -32602, text);
    assert.match(res.body.error.message, /KEEP keyword/i, text);
    assert.equal(http.calls.some(isMutate), false, text);
    assertAdsHttpVersions(http.calls);
  }

  const negativesHttp = recordingHttp(() => {
    throw new Error('Google Ads must not be called for KEEP phrase negatives');
  });
  const negativesHandler = handlerWithHttp(negativesHttp);
  for (const phrase of [
    '[tv mounting near me]',
    'tv installation near me',
    'tv installer near me',
    'tv mounting service',
    'the mounting man reviews',
    'fireplace tv mounting',
  ]) {
    const res = response();
    await negativesHandler(authorized({
      body: {
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: {
          name: ADD_CAMPAIGN_PHRASE_NEGATIVES,
          arguments: {
            campaign_id: '20867488270',
            phrases: [phrase],
            confirm: true,
          },
        },
      },
    }), res);
    assert.equal(res.body.error.code, -32602, phrase);
    assert.match(res.body.error.message, /KEEP keyword/i, phrase);
  }
  assert.equal(negativesHttp.calls.length, 0);
});

test('Frame campaign refuses keyword pause and still accepts phrase negatives', async () => {
  const pauseHttp = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('FROM ad_group_criterion')) {
      return searchBatch([keywordRow({
        text: 'samsung frame installation',
        campaignId: '23038170184',
        campaignName: 'MSP- Samsung Frame',
      })]);
    }
    throw new Error('mutate must not pause Frame keywords');
  });
  const pauseHandler = handlerWithHttp(pauseHttp);
  const pause = response();
  await pauseHandler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 60,
      method: 'tools/call',
      params: {
        name: PAUSE_AD_GROUP_CRITERION,
        arguments: { criterion_id: '555000111222', confirm: true },
      },
    },
  }), pause);
  assert.equal(pause.body.error.code, -32602);
  assert.match(pause.body.error.message, /negatives only/i);
  assert.equal(pauseHttp.calls.some(isMutate), false);
  assertAdsHttpVersions(pauseHttp.calls);
});

test('budgets and bids are refused without hitting Google Ads', async () => {
  const http = recordingHttp(() => {
    throw new Error('Google Ads must not be called for budget/bid mutates');
  });
  const handler = handlerWithHttp(http);
  const res = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 70,
      method: 'tools/call',
      params: {
        name: PAUSE_AD_GROUP_CRITERION,
        arguments: {
          criterion_id: '555000111222',
          confirm: true,
          budget: 750,
        },
      },
    },
  }), res);
  assert.equal(res.body.error.code, -32602);
  assert.match(res.body.error.message, /budget/i);
  assert.equal(http.calls.length, 0);
});

test('ads-apply URL builders default to v24 and honor GOOGLE_ADS_API_VERSION', () => {
  assert.equal(DEFAULT_ADS_API_VERSION, 'v24');
  assert.equal(ADS_API_VERSION, 'v24');
  assert.equal(resolveAdsApiVersion({}), 'v24');
  assert.equal(resolveAdsApiVersion({ GOOGLE_ADS_API_VERSION: '' }), 'v24');
  assert.equal(resolveAdsApiVersion({ GOOGLE_ADS_API_VERSION: 'v21' }), 'v21');

  const searchUrl = googleAdsSearchUrl(DEFAULT_CUSTOMER_ID);
  const pauseUrl = googleAdsAdGroupCriteriaMutateUrl(DEFAULT_CUSTOMER_ID);
  const negativesUrl = googleAdsCampaignCriteriaMutateUrl(DEFAULT_CUSTOMER_ID);
  assertAdsApiUrl(searchUrl, 'v24');
  assertAdsApiUrl(pauseUrl, 'v24');
  assertAdsApiUrl(negativesUrl, 'v24');
  assert.match(searchUrl, /\/v24\/customers\/1287907452\/googleAds:searchStream$/);
  assert.match(pauseUrl, /\/v24\/customers\/1287907452\/adGroupCriteria:mutate$/);
  assert.match(negativesUrl, /\/v24\/customers\/1287907452\/campaignCriteria:mutate$/);

  const overrideSearch = googleAdsSearchUrl(DEFAULT_CUSTOMER_ID, 'v21');
  assertAdsApiUrl(overrideSearch, 'v21');
  assert.equal(overrideSearch.includes('/v24/'), false);
});

test('mocked search and mutate HTTP uses /v24/ by default and the env override when set', async () => {
  let pauseLookups = 0;
  const defaultHttp = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('FROM ad_group_criterion')) {
      pauseLookups += 1;
      return searchBatch([keywordRow({ status: pauseLookups === 1 ? 'ENABLED' : 'PAUSED' })]);
    }
    if (isMutate(config)) {
      return mutateResults([keywordRow().adGroupCriterion.resourceName]);
    }
    throw new Error(`unexpected Ads call ${config.method} ${config.url}`);
  });
  const defaultHandler = handlerWithHttp(defaultHttp);
  const paused = response();
  await defaultHandler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 90,
      method: 'tools/call',
      params: {
        name: PAUSE_AD_GROUP_CRITERION,
        arguments: { criterion_id: '555000111222', confirm: true },
      },
    },
  }), paused);
  assert.equal(paused.statusCode, 200);
  assert.equal(paused.body.result.structuredContent.after_status, 'PAUSED');
  assertAdsHttpVersions(defaultHttp.calls, 'v24');
  assert.ok(defaultHttp.calls.some(isSearch));
  assert.ok(defaultHttp.calls.some(isMutate));

  const overrideEnv = { ...AUTH_ENV, GOOGLE_ADS_API_VERSION: 'v21' };
  const overrideHttp = recordingHttp((config) => {
    if (isSearch(config) && queryOf(config).includes('FROM ad_group_criterion')) {
      return searchBatch([keywordRow({ status: 'PAUSED' })]);
    }
    throw new Error(`unexpected Ads call ${config.method} ${config.url}`);
  });
  const overrideHandler = handlerWithHttp(overrideHttp, overrideEnv);
  const status = response();
  await overrideHandler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 91,
      method: 'tools/call',
      params: {
        name: GET_CRITERION_STATUS,
        arguments: { criterion_id: '555000111222' },
      },
    },
  }), status);
  assert.equal(status.statusCode, 200);
  assertAdsHttpVersions(overrideHttp.calls, 'v21');
  assert.equal(overrideHttp.calls[0].url.includes('/v24/'), false);
  assert.equal(overrideHttp.calls[0].url.includes('/v20/'), false);
});

test('reporting MCP files stay a read-only sibling and do not gain Ads write tools', async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const reporting = readFileSync(path.join(root, 'pages/api/mcp/mounting-man-reporting.js'), 'utf8');
  const reportingTest = readFileSync(path.join(root, 'tests/mcp-mounting-man-reporting.test.js'), 'utf8');
  const reportingFeed = readFileSync(path.join(root, 'lib/square-reporting-feed.mjs'), 'utf8');

  assert.match(reporting, /createMountingManReportingHandler/);
  assert.match(reporting, /Read-only Square/);
  assert.equal(reporting.includes(PAUSE_AD_GROUP_CRITERION), false);
  assert.equal(reporting.includes(ADD_CAMPAIGN_PHRASE_NEGATIVES), false);
  assert.equal(reporting.includes('adGroupCriteria:mutate'), false);
  assert.equal(reporting.includes('googleads.googleapis.com'), false);
  assert.equal(reportingTest.includes(PAUSE_AD_GROUP_CRITERION), false);
  assert.equal(reportingFeed.includes('googleAds'), false);

  const handler = createMountingManReportingHandler({
    env: AUTH_ENV,
    squareClient: null,
    logger: { error() {}, warn() {} },
  });
  const res = response();
  await handler(authorized({
    body: { jsonrpc: '2.0', id: 80, method: 'tools/list' },
  }), res);
  assert.deepEqual(
    res.body.result.tools.map((tool) => tool.name),
    [GET_MOUNTING_MAN_SQUARE_DETAIL],
  );
});
