import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bookedAppointmentQuery, countRecentBookings, decideAlert, runBookedAppointmentMonitor, sumConversions, ALERT_KIND,
} from '../lib/booked-appointment-monitor.js';
import { isUrgentAlert } from '../lib/q-alert.js';

const NOW = Date.parse('2026-10-24T14:40:00Z');
const h = (n) => new Date(NOW - n * 3600000).toISOString();
const jobs = [{ id: 'a', created: h(2) }, { id: 'b', created: h(30) }, { id: 'c', created: h(60) }, { id: 'a', created: h(2) }];

test('kind is urgent', () => assert.equal(isUrgentAlert(ALERT_KIND), true));

test('query is read-only GAQL for action 6491204814 over CT dates', () => {
  const q = bookedAppointmentQuery(NOW);
  assert.equal(q.start, '2026-10-22');
  assert.equal(q.end, '2026-10-24');
  assert.match(q.query, /^SELECT /);
  assert.match(q.query, /conversionActions\/6491204814/);
});

test('counts jobs created in last 48h, deduped', () => {
  assert.equal(countRecentBookings(jobs, NOW).count, 2);
  assert.equal(countRecentBookings([{ id: 'x' }], NOW).count, null);
  assert.equal(countRecentBookings([{ id: 'y', created_at: Math.floor((NOW - 3600000) / 1000) }], NOW).count, 1);
});

test('sums conversions', () => {
  assert.equal(sumConversions([{ metrics: { allConversionsByConversionDate: 1.5 } }, { metrics: {} }]), 1.5);
  assert.equal(sumConversions([]), 0);
});

test('decision rules', () => {
  assert.equal(decideAlert({ adsConversions: 0, bookings: 2 }).alert, true);
  assert.equal(decideAlert({ adsConversions: 0, bookings: 1 }).alert, false);
  assert.equal(decideAlert({ adsConversions: 1, bookings: 9 }).alert, false);
  assert.equal(decideAlert({ adsConversions: null, bookings: 9 }).reason, 'ads_unavailable');
  assert.equal(decideAlert({ adsConversions: 0, bookings: null }).reason, 'bookings_unavailable');
});

test('alerts once when zero with bookings; dry run does not send', async () => {
  const sent = [];
  const deps = { now: NOW, queryAds: async () => [], listJobs: async () => jobs, alert: async (p) => { sent.push(p); return { delivered: true, channel: 'agentmail' }; } };
  const dry = await runBookedAppointmentMonitor({ ...deps, dryRun: true });
  assert.equal(dry.alert, true);
  assert.equal(sent.length, 0);
  const live = await runBookedAppointmentMonitor(deps);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, ALERT_KIND);
  assert.doesNotMatch(sent[0].body, /@/);
  assert.equal(live.alertResult.delivered, true);
});

test('no alert when Ads errors', async () => {
  let called = false;
  const r = await runBookedAppointmentMonitor({ now: NOW, queryAds: async () => { throw Object.assign(new Error('x'), { code: 'ads_unconfigured' }); }, listJobs: async () => jobs, alert: async () => { called = true; } });
  assert.equal(r.alert, false);
  assert.equal(r.adsError, 'ads_unconfigured');
  assert.equal(called, false);
});
