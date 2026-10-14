import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCampaignRows, reportWindow } from '../lib/campaign-jobs-report.js';

test('rows join spend with booked and paid conversions per campaign', () => {
  const action = (id) => `customers/1287907452/conversionActions/${id}`;
  const { rows, totals } = buildCampaignRows({
    spendRows: [
      { campaign: { id: '1', name: 'MSP General' }, metrics: { costMicros: '150000000', clicks: '30' } },
      { campaign: { id: '2', name: 'Idle' }, metrics: { costMicros: '0', clicks: '0' } },
    ],
    conversionRows: [
      { campaign: { id: '1', name: 'MSP General' }, segments: { conversionAction: action('6491204814') }, metrics: { allConversions: 3, allConversionsValue: 1260 } },
      { campaign: { id: '1', name: 'MSP General' }, segments: { conversionAction: action('7509313857') }, metrics: { allConversions: 2, allConversionsValue: 600.5 } },
    ],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { spend: rows[0].spend, booked: rows[0].bookedJobs, paid: rows[0].paidJobs, rev: rows[0].paidRevenue, cpp: rows[0].costPerPaidJob, roas: rows[0].paidRoas },
    { spend: 150, booked: 3, paid: 2, rev: 600.5, cpp: 75, roas: 4 },
  );
  assert.deepEqual(totals, { spend: 150, bookedJobs: 3, paidJobs: 2, paidRevenue: 600.5 });
});

test('window defaults to the reliable-tracking start and rejects bad dates', () => {
  const w = reportWindow({ from: "x' OR 1=1", to: '2026-10-13' });
  assert.deepEqual(w, { from: '2026-10-10', to: '2026-10-13' });
});
