import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backfillJobMapsFromAuditEntries,
  backfillJobMapsFromJobNumberMatches,
  createUpstashKvMutationClient,
  getBackfillExitCode,
} from '../scripts/backfill-attribution-job-maps-from-audit.mjs';

test('Upstash mutation client serializes non-string SET values once and reads them back', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests = [];
  const stored = new Map();
  globalThis.fetch = async (_url, options) => {
    const command = JSON.parse(options.body);
    requests.push(command);
    if (command[0] === 'SET') {
      stored.set(command[1], command[2]);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: 'OK' }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ result: stored.get(command[1]) ?? null }),
    };
  };
  const client = createUpstashKvMutationClient({
    url: 'https://example.invalid',
    token: 'test-token',
  });
  const value = { squareCustomerId: 'opaque-test-value', nested: { enabled: true } };

  await client.set('test-key', value, { ex: 90 });

  assert.deepEqual(requests[0], ['SET', 'test-key', JSON.stringify(value), 'EX', '90']);
  assert.deepEqual(await client.get('test-key'), value);
});

test('dry-run plans missing ZenBooker-to-Square audit mappings without raw identifiers', async () => {
  const saved = [];
  const existing = new Map([
    ['job-existing-sensitive', { squareCustomerId: 'square-existing-sensitive' }],
  ]);
  const result = await backfillJobMapsFromAuditEntries({
    entries: [
      {
        key: 'zb2sq:job-missing-sensitive',
        value: {
          jobId: 'job-missing-sensitive',
          squareCustomerId: 'square-customer-sensitive',
          squareInvoiceId: 'square-invoice-sensitive',
        },
      },
      {
        key: 'zb2sq:job-existing-sensitive',
        value: {
          jobId: 'job-existing-sensitive',
          squareCustomerId: 'square-existing-sensitive',
        },
      },
      {
        key: 'zb2sq:job-without-customer-sensitive',
        value: { jobId: 'job-without-customer-sensitive' },
      },
    ],
    store: {
      getJobMapping: async (jobId) => existing.get(jobId) || null,
      saveJobMapping: async (mapping) => saved.push(mapping),
    },
    apply: false,
  });

  assert.equal(result.scanned, 3);
  assert.equal(result.wouldCreate, 1);
  assert.equal(result.created, 0);
  assert.equal(result.existing, 1);
  assert.equal(result.skippedMissingIdentifiers, 1);
  assert.equal(saved.length, 0);

  const rendered = JSON.stringify(result);
  for (const forbidden of [
    'job-missing-sensitive',
    'square-customer-sensitive',
    'square-invoice-sensitive',
    'job-existing-sensitive',
  ]) {
    assert.equal(rendered.includes(forbidden), false, `leaked ${forbidden}`);
  }
});

test('apply writes only missing job mappings from existing audit evidence', async () => {
  const saved = [];
  const result = await backfillJobMapsFromAuditEntries({
    entries: [
      {
        key: 'zb2sq:job-1-sensitive',
        value: {
          jobId: 'job-1-sensitive',
          squareCustomerId: 'square-customer-1-sensitive',
        },
      },
      {
        key: 'zb2sq:job-2-sensitive',
        value: {
          jobId: 'job-2-sensitive',
          squareCustomerId: 'square-customer-2-sensitive',
        },
      },
    ],
    store: {
      getJobMapping: async (jobId) => (jobId === 'job-2-sensitive' ? { squareCustomerId: 'square-customer-2-sensitive' } : null),
      saveJobMapping: async (mapping) => saved.push(mapping),
    },
    apply: true,
  });

  assert.equal(result.wouldCreate, 1);
  assert.equal(result.created, 1);
  assert.deepEqual(saved, [
    {
      jobId: 'job-1-sensitive',
      squareCustomerId: 'square-customer-1-sensitive',
      squareBookingId: null,
    },
  ]);
});

test('job-number mode maps current ZenBooker API job IDs from unique existing Square audits', async () => {
  const saved = [];
  const result = await backfillJobMapsFromJobNumberMatches({
    entries: [
      {
        key: 'zb2sq:legacy-job-id-sensitive',
        value: {
          jobId: 'legacy-job-id-sensitive',
          jobNumber: '123456',
          squareCustomerId: 'square-customer-sensitive',
        },
      },
      {
        key: 'zb2sq:ambiguous-a-sensitive',
        value: { jobNumber: '999999', squareCustomerId: 'square-a-sensitive' },
      },
      {
        key: 'zb2sq:ambiguous-b-sensitive',
        value: { jobNumber: '999999', squareCustomerId: 'square-b-sensitive' },
      },
    ],
    candidates: [
      { jobNumber: '123456', rawJobId: 'current-api-job-id-sensitive', attributionAudit: { mappingPresent: false } },
      { jobNumber: '999999', rawJobId: 'ambiguous-current-job-sensitive', attributionAudit: { mappingPresent: false } },
    ],
    store: {
      getJobMapping: async () => null,
      saveJobMapping: async (mapping) => saved.push(mapping),
    },
    apply: true,
  });

  assert.equal(result.candidateScanned, 2);
  assert.equal(result.uniqueJobNumberMatches, 1);
  assert.equal(result.ambiguousJobNumberMatches, 1);
  assert.equal(result.created, 1);
  assert.deepEqual(saved, [
    {
      jobId: 'current-api-job-id-sensitive',
      squareCustomerId: 'square-customer-sensitive',
      squareBookingId: null,
    },
  ]);
  assert.equal(JSON.stringify(result).includes('current-api-job-id-sensitive'), false);
  assert.equal(JSON.stringify(result).includes('square-customer-sensitive'), false);
});

test('audit mode counts conflicting existing mappings using opaque references', async () => {
  const saved = [];
  const result = await backfillJobMapsFromAuditEntries({
    entries: [
      {
        key: 'zb2sq:conflicting-job-sensitive',
        value: {
          jobId: 'conflicting-job-sensitive',
          squareCustomerId: 'proposed-square-customer-sensitive',
        },
      },
    ],
    store: {
      getJobMapping: async () => ({ squareCustomerId: 'existing-square-customer-sensitive' }),
      saveJobMapping: async (mapping) => saved.push(mapping),
    },
    apply: true,
  });

  assert.equal(result.existing, 0);
  assert.equal(result.conflicts, 1);
  assert.equal(result.conflictDetails.length, 1);
  assert.equal(saved.length, 0);
  const rendered = JSON.stringify(result);
  assert.equal(rendered.includes('conflicting-job-sensitive'), false);
  assert.equal(rendered.includes('proposed-square-customer-sensitive'), false);
  assert.equal(rendered.includes('existing-square-customer-sensitive'), false);
});

test('job-number mode counts conflicting existing mappings using opaque references', async () => {
  const saved = [];
  const result = await backfillJobMapsFromJobNumberMatches({
    entries: [
      {
        key: 'zb2sq:legacy-job-sensitive',
        value: {
          jobNumber: '123456',
          squareCustomerId: 'proposed-square-customer-sensitive',
        },
      },
    ],
    candidates: [
      { jobNumber: '123456', rawJobId: 'current-job-sensitive' },
    ],
    store: {
      getJobMapping: async () => ({ squareCustomerId: 'existing-square-customer-sensitive' }),
      saveJobMapping: async (mapping) => saved.push(mapping),
    },
    apply: true,
  });

  assert.equal(result.existing, 0);
  assert.equal(result.conflicts, 1);
  assert.equal(result.conflictDetails.length, 1);
  assert.equal(saved.length, 0);
  const rendered = JSON.stringify(result);
  assert.equal(rendered.includes('current-job-sensitive'), false);
  assert.equal(rendered.includes('proposed-square-customer-sensitive'), false);
  assert.equal(rendered.includes('existing-square-customer-sensitive'), false);
});

test('CLI exits nonzero for conflicts or failed writes', () => {
  assert.equal(getBackfillExitCode({ conflicts: 0, failed: 0 }), 0);
  assert.equal(getBackfillExitCode({ conflicts: 1, failed: 0 }), 1);
  assert.equal(getBackfillExitCode({ conflicts: 0, failed: 1 }), 1);
  assert.equal(getBackfillExitCode({ conflicts: 1, failed: 1 }), 1);
});
