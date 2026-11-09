import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ActiveAgentsPanel, LiveConsoleFeed, RecentCompletionsPanel } from '../components/home-hud-panels.js';
import {
  activeAgentsView,
  completionsForHud,
  consoleLinesForHud,
  CONSOLE_QUIET_LABEL,
  COMPLETIONS_QUIET_LABEL,
} from '../lib/home-hud.js';
import telemetryHandler, { resetTelemetryCache } from '../pages/api/telemetry.js';
import threadFeedHandler from '../pages/api/thread-feed.js';

const fixturePath = path.join(process.cwd(), 'tests/fixtures/hermes-hud-feed.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const UI_PATHS = [
  'components/Dashboard.js',
  'components/home-hud-panels.js',
  'lib/home-hud.js',
  'pages/api/telemetry.js',
  'pages/api/thread-feed.js',
];

const BANNED_UI_PATTERNS = [
  /hermes/i,
  /chatgpt/i,
  /claude/i,
  /gpt-5\.4/i,
  /sonnet-4\.6/i,
  /sonnet/i,
  /gpt-/i,
  /VIA /,
  /THE BRAIN/i,
  /Sub-Agent Pool/i,
  /CC-M4/i,
  /cc-m4/,
];

const DESK_LABELS = [
  'Q — Chief Technology Officer',
  'MoneyPenny — Chief of Staff',
  'SPECTRE — The Mastermind',
];

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

function assertNoBanned(text, where) {
  for (const pattern of BANNED_UI_PATTERNS) {
    assert.equal(pattern.test(text), false, `${where} matches ${pattern}`);
  }
}

function redisBody(value) {
  return {
    ok: true,
    json: async () => ({ result: JSON.stringify(value) }),
  };
}

test('active agents are the three Grok Bot desks in order', () => {
  const ignored = activeAgentsView(fixture);
  const view = activeAgentsView();
  assert.deepEqual(ignored, view);
  assert.deepEqual(view.agents.map((agent) => agent.id), ['q', 'moneypenny', 'spectre']);
  assert.deepEqual(view.agents.map((agent) => agent.label), DESK_LABELS);
  assert.equal(view.totalAgents, 3);
  assert.equal(view.activeCount, 3);
  for (const agent of view.agents) {
    assert.equal(Object.hasOwn(agent, 'model'), false);
    assert.equal(Object.hasOwn(agent, 'fallbacks'), false);
    assert.equal(Object.hasOwn(agent, 'task'), false);
    assert.equal(agent.status, 'active');
  }

  const html = renderToStaticMarkup(React.createElement(ActiveAgentsPanel));
  const positions = DESK_LABELS.map((label) => html.indexOf(label));
  assert.deepEqual(positions.map((index) => index >= 0), [true, true, true]);
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
  assert.equal((html.match(/data-desk="/g) || []).length, 3);
  assert.match(html, /3\/3/);
  assert.equal((html.match(/>ACTIVE</g) || []).length, 3);
  assertNoBanned(html, 'active agents markup');
  for (const agent of fixture.agents) {
    assert.equal(html.includes(agent.label), false);
    assert.equal(html.includes(agent.task), false);
  }
});

test('recent completions render a quiet panel for leftover logs', () => {
  const view = completionsForHud(fixture.contextLog);
  assert.deepEqual(view.items, []);
  assert.equal(view.okCount, 0);
  assert.equal(view.quietLabel, COMPLETIONS_QUIET_LABEL);

  const html = renderToStaticMarkup(React.createElement(RecentCompletionsPanel, {
    contextLog: fixture.contextLog,
  }));
  assert.match(html, new RegExp(COMPLETIONS_QUIET_LABEL));
  assert.match(html, /0 OK/);
  assertNoBanned(html, 'completions markup');
  for (const entry of fixture.contextLog) {
    assert.equal(html.includes(entry.action), false);
    assert.equal(html.includes(entry.agent), false);
  }
});

test('live console drops redis lines and keeps an empty thread feed quiet', () => {
  const dropped = consoleLinesForHud({
    threadLines: [],
    telemetryLines: fixture.consoleLines,
  });
  assert.deepEqual(dropped.lines, []);
  assert.equal(dropped.ignoredTelemetryLines, fixture.consoleLines.length);

  const quietHtml = renderToStaticMarkup(React.createElement(LiveConsoleFeed, {
    threadLines: [],
    telemetryLines: fixture.consoleLines,
  }));
  assert.match(quietHtml, new RegExp(CONSOLE_QUIET_LABEL.replace('...', '\\.\\.\\.')));
  assertNoBanned(quietHtml, 'quiet console markup');
  assert.equal(quietHtml.includes(fixture.consoleLines[0].msg), false);

  const threadLines = [
    { ts: '2026-11-09T18:00:00Z', label: 'Q', level: 'info', msg: 'Older desk note' },
    { ts: '2026-11-09T18:05:00Z', label: 'Q', level: 'ok', msg: 'Newer desk note' },
  ];
  const mixed = consoleLinesForHud({ threadLines, telemetryLines: fixture.consoleLines });
  assert.deepEqual(mixed.lines.map((line) => line.msg), ['Older desk note', 'Newer desk note']);
  const mixedHtml = renderToStaticMarkup(React.createElement(LiveConsoleFeed, {
    threadLines,
    telemetryLines: fixture.consoleLines,
  }));
  assert.ok(mixedHtml.indexOf('Newer desk note') < mixedHtml.indexOf('Older desk note'));
  assert.equal(mixedHtml.includes(fixture.consoleLines[0].msg), false);
  assertNoBanned(mixedHtml, 'thread console markup');
});

test('thread feed stays an empty line list', async () => {
  const getRes = response();
  await threadFeedHandler({ method: 'GET' }, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.deepEqual(getRes.body, { lines: [] });

  const postRes = response();
  await threadFeedHandler({ method: 'POST' }, postRes);
  assert.equal(postRes.statusCode, 405);
  assert.deepEqual(postRes.body, { error: 'Method not allowed' });
});

test('telemetry serves the desk roster and does not read leftover redis logs', async () => {
  const previousUrl = process.env.AGENCY_REDIS_URL;
  const previousToken = process.env.AGENCY_REDIS_TOKEN;
  const originalFetch = global.fetch;
  const calls = [];
  let priorities = {
    tasks: [
      { text: 'Order brackets', status: 'queued', model: 'gpt-5.4', lane: 'sonnet-4.6' },
      { text: 'Confirm Saturday crew', status: 'scheduled', model: 'claude-sonnet-4.6' },
    ],
  };

  process.env.AGENCY_REDIS_URL = 'https://agency-redis.test';
  process.env.AGENCY_REDIS_TOKEN = 'test-token';
  global.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href === 'https://agency-redis.test/get/agency:priorities') {
      return redisBody(priorities);
    }
    if (href.includes('agency:agents:status')) return redisBody({ agents: fixture.agents });
    if (href.includes('agency:context:active')) return redisBody({ log: fixture.contextLog });
    if (href.includes('agency:console:lines')) return redisBody(fixture.consoleLines);
    throw new Error(`unexpected redis fetch ${href}`);
  };

  try {
    resetTelemetryCache();
    const first = response();
    await telemetryHandler({ method: 'GET' }, first);
    assert.equal(first.statusCode, 200);
    assert.deepEqual(calls, ['https://agency-redis.test/get/agency:priorities']);
    assert.deepEqual(first.body.agents.agents.map((agent) => agent.label), DESK_LABELS);
    assert.equal(first.body.agents.totalAgents, 3);
    assert.deepEqual(first.body.completions, { items: [], okCount: 0 });
    assert.deepEqual(first.body.console, { lines: [] });
    assert.deepEqual(first.body.priorities, {
      queuedCount: 1,
      items: [
        { rank: 1, text: 'Order brackets', status: 'queued' },
        { rank: 2, text: 'Confirm Saturday crew', status: 'scheduled' },
      ],
    });
    assertNoBanned(JSON.stringify({
      agents: first.body.agents,
      completions: first.body.completions,
      console: first.body.console,
    }), 'telemetry desk payload');
    assert.equal(JSON.stringify(first.body.priorities).includes('gpt-5.4'), false);
    assert.equal(JSON.stringify(first.body.priorities).includes('sonnet-4.6'), false);
    assert.equal(JSON.stringify(first.body.priorities).includes('claude'), false);

    const cached = response();
    await telemetryHandler({ method: 'GET' }, cached);
    assert.equal(calls.length, 1);
    assert.deepEqual(cached.body.agents, first.body.agents);

    resetTelemetryCache();
    priorities = {
      value: JSON.stringify({
        tasks: [{ task: 'Hold the ladder', status: 'backlog' }],
      }),
    };
    const encoded = response();
    await telemetryHandler({ method: 'GET' }, encoded);
    assert.deepEqual(encoded.body.priorities.items, [
      { rank: 1, text: 'Hold the ladder', status: 'backlog' },
    ]);

    resetTelemetryCache();
    delete process.env.AGENCY_REDIS_TOKEN;
    const callsBefore = calls.length;
    const offline = response();
    await telemetryHandler({ method: 'GET' }, offline);
    assert.equal(calls.length, callsBefore);
    assert.deepEqual(offline.body.agents.agents.map((agent) => agent.id), ['q', 'moneypenny', 'spectre']);
    assert.deepEqual(offline.body.priorities, { items: [], queuedCount: 0 });
    assert.deepEqual(offline.body.completions, { items: [], okCount: 0 });
    assert.deepEqual(offline.body.console, { lines: [] });

    const denied = response();
    await telemetryHandler({ method: 'POST' }, denied);
    assert.equal(denied.statusCode, 405);
  } finally {
    resetTelemetryCache();
    global.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.AGENCY_REDIS_URL;
    else process.env.AGENCY_REDIS_URL = previousUrl;
    if (previousToken === undefined) delete process.env.AGENCY_REDIS_TOKEN;
    else process.env.AGENCY_REDIS_TOKEN = previousToken;
  }
});

test('home HUD sources do not carry leftover roster or model labels', () => {
  const dashboard = fs.readFileSync(path.join(process.cwd(), 'components/Dashboard.js'), 'utf8');
  assert.match(dashboard, /ActiveAgentsPanel/);
  assert.match(dashboard, /RecentCompletionsPanel/);
  assert.match(dashboard, /LiveConsoleFeed/);
  assert.doesNotMatch(dashboard, /agent\.model/);
  assert.doesNotMatch(dashboard, /item\.model/);
  assert.doesNotMatch(dashboard, /telemetryData\?\.agents/);
  assert.doesNotMatch(dashboard, /telemetryData\?\.completions/);
  assert.doesNotMatch(dashboard, /FALLBACKS/);

  for (const relativePath of UI_PATHS) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
    assertNoBanned(source, relativePath);
  }
});
