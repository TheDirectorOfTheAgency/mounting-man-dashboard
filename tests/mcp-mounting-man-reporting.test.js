import assert from 'node:assert/strict';
import test from 'node:test';

import { createMountingManReportingHandler } from '../pages/api/mcp/mounting-man-reporting.js';
import { GET_MOUNTING_MAN_SQUARE_DETAIL } from '../lib/square-reporting-feed.mjs';

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

function handlerWithClient(client, env = {
  MCP_SQUARE_PAYROLL_SECRET: 'test-mcp-secret',
}) {
  return createMountingManReportingHandler({
    env,
    squareClient: client,
    logger: { error() {}, warn() {} },
  });
}

test('MCP route rejects missing or wrong Bearer secrets', async () => {
  const handler = handlerWithClient(null);
  const missing = response();
  await handler(request({ method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'initialize' } }), missing);
  assert.equal(missing.statusCode, 401);

  const wrong = response();
  await handler(request({
    headers: { authorization: 'Bearer nope' },
    body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  }), wrong);
  assert.equal(wrong.statusCode, 401);
});

test('MCP route accepts MCP_SQUARE_PAYROLL_SECRET and existing CRON_SECRET', async () => {
  const mcpHandler = handlerWithClient(null);
  const mcpRes = response();
  await mcpHandler(authorized({
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
  }), mcpRes);
  assert.equal(mcpRes.statusCode, 200);
  assert.equal(mcpRes.body.result.serverInfo.name, 'mounting-man-reporting');
  assert.equal(mcpRes.body.result.protocolVersion, '2025-03-26');

  const cronHandler = handlerWithClient(null, { CRON_SECRET: 'existing-cron' });
  const cronRes = response();
  await cronHandler(request({
    headers: { authorization: 'Bearer existing-cron' },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  }), cronRes);
  assert.equal(cronRes.statusCode, 200);
  assert.equal(
    cronRes.body.result.tools.some((tool) => tool.name === GET_MOUNTING_MAN_SQUARE_DETAIL),
    true,
  );
});

test('tools/call returns sanitized Square detail and never hits Square without auth', async () => {
  let listed = 0;
  const client = {
    locationId: 'LVNM3Z4RVRWDK',
    async listPayments() {
      listed += 1;
      return [{
        id: 'pay_1',
        order_id: 'ord_1',
        created_at: '2026-08-22T16:00:00.000Z',
        status: 'COMPLETED',
        location_id: 'LVNM3Z4RVRWDK',
        team_member_id: 'TMSiHOOr7RGdl2Ki',
        customer_id: 'cust_secret',
        buyer_email_address: 'buyer@example.com',
        receipt_url: 'https://squareup.com/receipt/nope',
        amount_money: { amount: 20000, currency: 'USD' },
        tip_money: { amount: 500, currency: 'USD' },
        billing_address: { address_line_1: '99 Hidden Rd' },
      }];
    },
    async batchOrders() {
      return {
        ord_1: {
          id: 'ord_1',
          customer_id: 'cust_secret',
          line_items: [
            { name: 'TV Mount / Bracket', quantity: '1', base_price_money: { amount: 7500, currency: 'USD' } },
            { name: '65 Inch TV Mounting', quantity: '1', base_price_money: { amount: 20000, currency: 'USD' } },
          ],
        },
      };
    },
    async getTeamMember() {
      throw new Error('known cashier should not require a live lookup');
    },
  };

  const handler = handlerWithClient(client);
  const blocked = response();
  await handler(request({
    body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: GET_MOUNTING_MAN_SQUARE_DETAIL, arguments: { date: '2026-08-22' } } },
  }), blocked);
  assert.equal(blocked.statusCode, 401);
  assert.equal(listed, 0);

  const ok = response();
  await handler(authorized({
    body: {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: GET_MOUNTING_MAN_SQUARE_DETAIL, arguments: { date: '2026-08-22' } },
    },
  }), ok);

  assert.equal(ok.statusCode, 200);
  const feed = ok.body.result.structuredContent;
  assert.equal(feed.payments[0].cashier_name, 'Michael Wenzel');
  assert.equal(feed.payments[0].tip_money.amount, 500);
  assert.equal(feed.payments[0].team_member_id, 'TMSiHOOr7RGdl2Ki');
  assert.equal(feed.payments[0].line_items.some((item) => item.name === 'TV Mount / Bracket'), true);
  const serialized = JSON.stringify(ok.body);
  assert.equal(serialized.includes('buyer@example.com'), false);
  assert.equal(serialized.includes('cust_secret'), false);
  assert.equal(serialized.includes('99 Hidden'), false);
  assert.equal(serialized.includes('squareup.com/receipt'), false);
  assert.equal(serialized.includes('25%'), false);
});

test('direct POST date lookup is MCP-compatible and payment_id uses getPayment', async () => {
  const client = {
    locationId: 'LVNM3Z4RVRWDK',
    async getPayment(id) {
      assert.equal(id, 'pay_lookup');
      return {
        id: 'pay_lookup',
        order_id: 'ord_lookup',
        created_at: '2026-08-22T20:00:00.000Z',
        status: 'COMPLETED',
        location_id: 'LVNM3Z4RVRWDK',
        team_member_id: 'TMSiHOOr7RGdl2Ki',
        amount_money: { amount: 10000, currency: 'USD' },
        tip_money: { amount: 0, currency: 'USD' },
      };
    },
    async batchOrders() {
      return { ord_lookup: { id: 'ord_lookup', line_items: [] } };
    },
    async getTeamMember() { return null; },
  };
  const handler = handlerWithClient(client);
  const res = response();
  await handler(authorized({ body: { payment_id: 'pay_lookup' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.payments[0].payment_id, 'pay_lookup');
  assert.equal(res.body.payments[0].cashier_name, 'Michael Wenzel');
});
