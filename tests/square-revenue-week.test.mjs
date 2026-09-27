import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bucketRecentSquarePayments,
  squareRevenueCacheIncludesThisWeek,
} from '../lib/square-revenue-buckets.mjs';

function payment({ createdAt, totalCents, amountCents, status = 'COMPLETED', refundedCents }) {
  const body = {
    status,
    created_at: createdAt,
    amount_money: { amount: amountCents ?? totalCents, currency: 'USD' },
  };
  if (totalCents != null) body.total_money = { amount: totalCents, currency: 'USD' };
  if (refundedCents != null) body.refunded_money = { amount: refundedCents, currency: 'USD' };
  return body;
}

test('Chicago week runs Sunday through Saturday, including the spring-forward week', () => {
  // Wednesday 2026-03-11 10:00 AM CDT, inside the week that springs forward
  // at 2:00 AM on Sunday 2026-03-08.
  const now = new Date('2026-03-11T15:00:00.000Z');
  const buckets = bucketRecentSquarePayments([
    payment({
      createdAt: '2026-03-08T05:30:00.000Z',
      totalCents: 10000,
    }),
    payment({
      createdAt: '2026-03-08T06:10:00.000Z',
      totalCents: 20000,
      amountCents: 15000,
    }),
    payment({
      createdAt: '2026-03-11T15:00:00.000Z',
      totalCents: 5000,
    }),
    payment({
      createdAt: '2026-03-15T04:30:00.000Z',
      totalCents: 30000,
      refundedCents: 5000,
    }),
    payment({
      createdAt: '2026-03-15T05:10:00.000Z',
      totalCents: 40000,
    }),
    payment({
      createdAt: '2026-03-11T15:00:00.000Z',
      totalCents: 99900,
      status: 'APPROVED',
    }),
  ], now);

  assert.deepEqual(buckets.thisWeek, {
    total: 550,
    count: 3,
    weekStart: '2026-03-08',
    weekEnd: '2026-03-14',
  });
  assert.deepEqual(buckets.today, { total: 50, count: 1 });
  assert.deepEqual(buckets.thisMonth, { total: 1050, count: 5 });
  assert.deepEqual(buckets.thisYear, { total: 1050, count: 5, avgValue: 210 });
  assert.deepEqual(Object.keys(buckets.thisWeek).sort(), ['count', 'total', 'weekEnd', 'weekStart']);
  assert.equal(buckets.revenueHistory.length, 7);
});

test('Saturday 11:30 PM CT stays in that week and Sunday 12:10 AM CT starts the next', () => {
  const saturdayNight = new Date('2026-03-08T05:30:00.000Z');
  const endingWeek = bucketRecentSquarePayments([
    payment({ createdAt: '2026-03-08T05:30:00.000Z', totalCents: 11100 }),
    payment({ createdAt: '2026-03-08T06:10:00.000Z', totalCents: 22200 }),
  ], saturdayNight);

  assert.deepEqual(endingWeek.thisWeek, {
    total: 111,
    count: 1,
    weekStart: '2026-03-01',
    weekEnd: '2026-03-07',
  });

  const sundayMorning = new Date('2026-03-08T06:10:00.000Z');
  const startingWeek = bucketRecentSquarePayments([
    payment({ createdAt: '2026-03-08T05:30:00.000Z', totalCents: 11100 }),
    payment({ createdAt: '2026-03-08T06:10:00.000Z', totalCents: 22200 }),
  ], sundayMorning);

  assert.deepEqual(startingWeek.thisWeek, {
    total: 222,
    count: 1,
    weekStart: '2026-03-08',
    weekEnd: '2026-03-14',
  });
  assert.deepEqual(startingWeek.today, { total: 222, count: 1 });
});

test('fall-back week still uses Chicago calendar dates, not a fixed UTC offset', () => {
  // Wednesday 2026-11-04 12:00 PM CST, after clocks fall back on Nov 1.
  const now = new Date('2026-11-04T18:00:00.000Z');
  const buckets = bucketRecentSquarePayments([
    payment({ createdAt: '2026-11-01T04:30:00.000Z', totalCents: 100 }),
    payment({ createdAt: '2026-11-01T05:10:00.000Z', totalCents: 200 }),
    payment({ createdAt: '2026-11-08T05:30:00.000Z', totalCents: 400 }),
    payment({ createdAt: '2026-11-08T06:10:00.000Z', totalCents: 800 }),
  ], now);

  assert.deepEqual(buckets.thisWeek, {
    total: 6,
    count: 2,
    weekStart: '2026-11-01',
    weekEnd: '2026-11-07',
  });
});

test('a cached Square revenue payload without thisWeek is treated as a miss', () => {
  assert.equal(squareRevenueCacheIncludesThisWeek(null), false);
  assert.equal(squareRevenueCacheIncludesThisWeek(undefined), false);
  assert.equal(squareRevenueCacheIncludesThisWeek('stale'), false);
  assert.equal(squareRevenueCacheIncludesThisWeek({
    today: { total: 1, count: 1 },
    thisMonth: { total: 2, count: 2 },
  }), false);
  assert.equal(squareRevenueCacheIncludesThisWeek({ thisWeek: null }), false);
  assert.equal(squareRevenueCacheIncludesThisWeek({
    thisWeek: { total: 0, count: 0, weekStart: '2026-03-08', weekEnd: '2026-03-14' },
  }), true);
});
