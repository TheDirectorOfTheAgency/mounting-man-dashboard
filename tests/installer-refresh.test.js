import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isInstallerRefreshHours,
  refreshUnassignedInstallers,
} from '../lib/installer-refresh.js';
import { createInstallerRefreshHandler } from '../pages/api/cron/installer-refresh.js';
import { resolveTechAssignment } from '../pages/api/webhooks/zenbooker-to-square.js';

function response() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function audit(overrides = {}) {
  return {
    jobId: 'job-730395',
    jobNumber: '730395',
    providerName: null,
    providerEmail: null,
    assignmentMode: 'defaulted_unassigned',
    techSquareId: 'TMY7unjtR-2XvVpg',
    resolvedProviderName: 'Marshall Donnerbauer',
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    squareCustomerId: 'square-customer-1',
    squareOrderId: 'square-order-1',
    squareInvoiceId: 'square-invoice-1',
    unassignedAlertedAt: null,
    ...overrides,
  };
}

test('chicago refresh hours cover 7 AM through 9 PM in both daylight and standard time', () => {
  assert.equal(isInstallerRefreshHours(new Date('2026-10-07T12:00:00Z')), true);
  assert.equal(isInstallerRefreshHours(new Date('2026-10-07T16:03:00Z')), true);
  assert.equal(isInstallerRefreshHours(new Date('2026-10-08T02:00:00Z')), true);
  assert.equal(isInstallerRefreshHours(new Date('2026-10-07T11:59:00Z')), false);
  assert.equal(isInstallerRefreshHours(new Date('2026-10-08T02:30:00Z')), false);
  assert.equal(isInstallerRefreshHours(new Date('2026-01-15T13:00:00Z')), true);
  assert.equal(isInstallerRefreshHours(new Date('2026-01-15T12:30:00Z')), false);
  assert.equal(isInstallerRefreshHours(new Date('2026-01-16T03:00:00Z')), true);
  assert.equal(isInstallerRefreshHours(new Date('2026-01-16T03:30:00Z')), false);
});

test('installer refresh stores Marshall Wayne and does not create Square records', async () => {
  const saved = [];
  const alerts = [];
  const squareCalls = [];
  const rows = await refreshUnassignedInstallers({
    audits: [audit()],
    loadJob: async () => ({
      id: 'job-730395',
      assigned_providers: [{ name: 'Marshall Wayne', email: 'marshall@example.com' }],
    }),
    resolveTech: resolveTechAssignment,
    alert: async (value) => { alerts.push(value); },
    now: Date.now(),
  });

  assert.equal(squareCalls.length, 0);
  assert.equal(alerts.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].updated, true);
  assert.equal(rows[0].providerName, 'Marshall Wayne');
  assert.equal(rows[0].assignmentMode, 'mapped_assigned');
  assert.equal(rows[0].audit.squareInvoiceId, 'square-invoice-1');
  assert.equal(rows[0].audit.squareOrderId, 'square-order-1');
  assert.equal(rows[0].audit.squareCustomerId, 'square-customer-1');
  saved.push(rows[0].audit);
  assert.equal(saved[0].providerName, 'Marshall Wayne');
});

test('urgent unassigned alert fires only within 2 hours and only once', async () => {
  const alerts = [];
  const soon = new Date(Date.now() + 90 * 60 * 1000).toISOString();
  const later = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
  const loadJob = async () => ({ id: 'job-1', assigned_providers: [] });

  const laterRows = await refreshUnassignedInstallers({
    audits: [audit({ jobId: 'job-later', jobNumber: '800', scheduledAt: later })],
    loadJob,
    resolveTech: resolveTechAssignment,
    alert: async (value) => { alerts.push(value); },
  });
  assert.equal(laterRows[0].updated, false);
  assert.equal(alerts.length, 0);

  const first = await refreshUnassignedInstallers({
    audits: [audit({ scheduledAt: soon })],
    loadJob,
    resolveTech: resolveTechAssignment,
    alert: async (value) => { alerts.push(value); },
  });
  assert.equal(first[0].alerted, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'unassigned_job_soon');
  assert.match(alerts[0].subject, /730395/);
  assert.match(alerts[0].subject, /2h/);

  const second = await refreshUnassignedInstallers({
    audits: [first[0].audit],
    loadJob,
    resolveTech: resolveTechAssignment,
    alert: async () => { throw new Error('second alert must not send'); },
  });
  assert.equal(second[0].alerted, false);
  assert.equal(second[0].updated, false);
});

test('scheduled cron skips outside Chicago hours and a forced run still updates', async () => {
  const stored = new Map();
  const initial = audit({
    scheduledAt: new Date(Date.parse('2026-10-07T16:00:00Z') + 60 * 60 * 1000).toISOString(),
  });
  stored.set('zb2sq:job-730395', initial);
  let fetched = 0;
  const handler = createInstallerRefreshHandler({
    env: { CRON_SECRET: 'cron-secret' },
    now: () => Date.parse('2026-10-07T11:00:00Z'),
    loadKv: async () => ({
      async get(key) { return stored.get(key) || null; },
      async set(key, value) { stored.set(key, value); },
    }),
    listJobs: async () => {
      fetched += 1;
      return [{
        id: 'job-730395',
        job_number: '730395',
        start_date: initial.scheduledAt,
        assigned_providers: [{ name: 'Marshall Wayne' }],
      }];
    },
    resolveTech: resolveTechAssignment,
    alert: async () => { throw new Error('outside window must not alert'); },
  });

  const skipped = response();
  await handler({
    method: 'GET',
    headers: { authorization: 'Bearer cron-secret' },
    query: {},
  }, skipped);
  assert.equal(skipped.statusCode, 200);
  assert.equal(skipped.body.skipped, true);
  assert.equal(fetched, 0);

  const denied = response();
  await handler({ method: 'GET', headers: {}, query: { force: '1' } }, denied);
  assert.equal(denied.statusCode, 401);

  const forced = response();
  await handler({
    method: 'GET',
    headers: { authorization: 'Bearer cron-secret' },
    query: { force: '1' },
  }, forced);
  assert.equal(forced.statusCode, 200);
  assert.equal(fetched, 1);
  assert.equal(forced.body.updated[0].jobNumber, '730395');
  assert.equal(forced.body.updated[0].providerName, 'Marshall Wayne');
  assert.equal(stored.get('zb2sq:job-730395').squareInvoiceId, 'square-invoice-1');
  assert.equal(stored.get('zb2sq:job-730395').providerName, 'Marshall Wayne');
});
