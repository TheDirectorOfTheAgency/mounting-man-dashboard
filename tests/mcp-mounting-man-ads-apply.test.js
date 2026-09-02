import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { GET_MOUNTING_MAN_SQUARE_DETAIL } from '../lib/square-reporting-feed.mjs';
import {
  ADD_CAMPAIGN_PHRASE_NEGATIVES,
  ADS_APPLY_TOOLS,
  DEFAULT_CUSTOMER_ID,
  GET_CRITERION_STATUS,
  PAUSE_AD_GROUP_CRITERION,
  READ_LOGIN_CUSTOMER_ID,
  createMountingManAdsApplyClient,
  googleAdsAdGroupCriteriaMutateUrl,
  googleAdsCampaignCriteriaMutateUrl,
  googleAdsSearchUrl,
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

test('MCP route rejects missing or wrong Bearer secrets', async () => {
  const handler = handlerWithClient(null);
  const missing = response();
  await handler(request({
    method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  }), missing);
  assert.equal(missing.statusCode, 401);

  const wrong = response();
  await handler(request({
    headers: { authorization: 'Bearer nope' },
    body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  }), wrong);
  assert.equal(wrong.statusCode, 401);
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
  for (const call of reads) {
    assert.equal(call.url, googleAdsSearchUrl(DEFAULT_CUSTOMER_ID));
    assert.equal(call.headers['login-customer-id'], READ_LOGIN_CUSTOMER_ID);
    assert.equal(call.headers.Authorization, 'Bearer test-access-token');
    assert.equal(call.headers['developer-token'], 'test-developer-token');
  }
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
  assert.equal('login-customer-id' in write.headers, false);
  assert.equal(write.data.operations[0].create.negative, true);
  assert.equal(write.data.operations[0].create.keyword.matchType, 'PHRASE');
  assert.equal(http.calls.filter(isSearch).every((call) => (
    call.headers['login-customer-id'] === READ_LOGIN_CUSTOMER_ID
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
  assert.equal(http.calls[0].headers['login-customer-id'], READ_LOGIN_CUSTOMER_ID);
  assert.equal(http.calls.some(isMutate), false);
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
