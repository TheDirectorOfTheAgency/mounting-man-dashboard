import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAttributionStore } from '../lib/offline-conversion-store.js';
import { opaqueRef } from '../lib/offline-conversion-eligibility.js';
import { fetchZenBookerJobs } from './audit-offline-conversion-candidates.mjs';

const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;
const DEFAULT_SCAN_COUNT = 500;
const AUDIT_PREFIX = 'zb2sq:';

function flag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefixed = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefixed));
  if (inline) return inline.slice(prefixed.length);
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function loadLocalEnv() {
  for (const filename of ['.env.local', '.env']) {
    const envPath = path.join(process.cwd(), filename);
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  }
}

function normalizeKvValue(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function safeOpaqueRef(value) {
  try {
    return opaqueRef(value).slice(0, 12);
  } catch {
    return null;
  }
}

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function createUpstashKvMutationClient({ url, token }) {
  if (!url || !token) return null;
  const baseUrl = url.replace(/\/$/, '');
  async function command(...parts) {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(parts),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new Error(`KV parse failed: ${error.message}`);
    }
    if (!response.ok || parsed?.error) {
      throw new Error(`KV command failed: ${parsed?.error || response.status}`);
    }
    return normalizeKvValue(parsed.result);
  }
  return {
    async get(key) {
      return command('GET', key);
    },
    async set(key, value, options = {}) {
      const serializedValue = typeof value === 'string' ? value : JSON.stringify(value);
      const args = ['SET', key, serializedValue];
      if (options.nx) args.push('NX');
      if (options.ex) args.push('EX', String(options.ex));
      return command(...args);
    },
    async del(key) {
      return command('DEL', key);
    },
    async sadd(key, ...members) {
      return command('SADD', key, ...members);
    },
    async smembers(key) {
      return command('SMEMBERS', key);
    },
    async expire(key, seconds) {
      return command('EXPIRE', key, String(seconds));
    },
    async scan(cursor, { match, count = DEFAULT_SCAN_COUNT } = {}) {
      const args = ['SCAN', String(cursor)];
      if (match) args.push('MATCH', match);
      if (count) args.push('COUNT', String(count));
      return command(...args);
    },
  };
}

async function scanAuditEntries(kv, { limit = Infinity, scanCount = DEFAULT_SCAN_COUNT } = {}) {
  const entries = [];
  let cursor = '0';
  do {
    const result = await kv.scan(cursor, { match: `${AUDIT_PREFIX}*`, count: scanCount });
    cursor = String(result?.[0] || '0');
    const keys = result?.[1] || [];
    for (const key of keys) {
      const value = await kv.get(key);
      entries.push({ key, value });
      if (entries.length >= limit) return entries;
    }
  } while (cursor !== '0');
  return entries;
}

function extractAuditMapping(entry) {
  const value = normalizeKvValue(entry.value) || {};
  const jobId = value.jobId || String(entry.key || '').slice(AUDIT_PREFIX.length) || null;
  const squareCustomerId = value.squareCustomerId || null;
  return {
    jobId,
    squareCustomerId,
    squareBookingId: value.squareBookingId || null,
    refs: {
      jobRef: safeOpaqueRef(jobId),
      squareCustomerRef: safeOpaqueRef(squareCustomerId),
    },
  };
}

export async function backfillJobMapsFromAuditEntries({ entries, store, apply = false }) {
  const result = {
    mode: apply ? 'apply' : 'dry-run',
    scanned: 0,
    wouldCreate: 0,
    created: 0,
    existing: 0,
    conflicts: 0,
    skippedMissingIdentifiers: 0,
    failed: 0,
    candidates: [],
    conflictDetails: [],
  };

  for (const entry of entries || []) {
    result.scanned += 1;
    const mapping = extractAuditMapping(entry);
    if (!mapping.jobId || !mapping.squareCustomerId) {
      result.skippedMissingIdentifiers += 1;
      continue;
    }

    const existing = await store.getJobMapping(mapping.jobId);
    if (existing?.squareCustomerId) {
      if (existing.squareCustomerId === mapping.squareCustomerId) {
        result.existing += 1;
      } else {
        result.conflicts += 1;
        result.conflictDetails.push({
          jobRef: mapping.refs.jobRef,
          existingSquareCustomerRef: safeOpaqueRef(existing.squareCustomerId),
          proposedSquareCustomerRef: mapping.refs.squareCustomerRef,
        });
      }
      continue;
    }

    result.wouldCreate += 1;
    result.candidates.push({
      jobRef: mapping.refs.jobRef,
      squareCustomerRef: mapping.refs.squareCustomerRef,
    });

    if (!apply) continue;
    try {
      await store.saveJobMapping({
        jobId: mapping.jobId,
        squareCustomerId: mapping.squareCustomerId,
        squareBookingId: mapping.squareBookingId,
      });
      result.created += 1;
    } catch {
      result.failed += 1;
    }
  }

  result.candidates = result.candidates.slice(0, 20).map(jsonClone);
  result.conflictDetails = result.conflictDetails.slice(0, 20).map(jsonClone);
  return result;
}

function indexUniqueAuditMappingsByJobNumber(entries = []) {
  const index = new Map();
  for (const entry of entries) {
    const value = normalizeKvValue(entry.value) || {};
    const jobNumber = value.jobNumber ? String(value.jobNumber) : null;
    if (!jobNumber || !value.squareCustomerId) continue;
    const mapping = extractAuditMapping(entry);
    const bucket = index.get(jobNumber) || [];
    bucket.push(mapping);
    index.set(jobNumber, bucket);
  }
  return index;
}

export async function backfillJobMapsFromJobNumberMatches({ entries, candidates, store, apply = false }) {
  const auditsByJobNumber = indexUniqueAuditMappingsByJobNumber(entries);
  const result = {
    mode: apply ? 'apply-job-number' : 'dry-run-job-number',
    candidateScanned: 0,
    uniqueJobNumberMatches: 0,
    ambiguousJobNumberMatches: 0,
    noJobNumberMatch: 0,
    existing: 0,
    conflicts: 0,
    wouldCreate: 0,
    created: 0,
    failed: 0,
    candidates: [],
    conflictDetails: [],
  };

  for (const candidate of candidates || []) {
    result.candidateScanned += 1;
    const jobNumber = candidate.jobNumber ? String(candidate.jobNumber) : null;
    const currentJobId = candidate.rawJobId || candidate.jobId || candidate.id || null;
    if (!jobNumber || !currentJobId) {
      result.noJobNumberMatch += 1;
      continue;
    }
    const auditMatches = auditsByJobNumber.get(jobNumber) || [];
    if (auditMatches.length === 0) {
      result.noJobNumberMatch += 1;
      continue;
    }
    if (auditMatches.length > 1) {
      result.ambiguousJobNumberMatches += 1;
      continue;
    }
    result.uniqueJobNumberMatches += 1;
    const auditMapping = auditMatches[0];
    const existing = await store.getJobMapping(currentJobId);
    if (existing?.squareCustomerId) {
      if (existing.squareCustomerId === auditMapping.squareCustomerId) {
        result.existing += 1;
      } else {
        result.conflicts += 1;
        result.conflictDetails.push({
          jobRef: safeOpaqueRef(currentJobId),
          existingSquareCustomerRef: safeOpaqueRef(existing.squareCustomerId),
          proposedSquareCustomerRef: auditMapping.refs.squareCustomerRef,
        });
      }
      continue;
    }
    result.wouldCreate += 1;
    result.candidates.push({
      jobRef: safeOpaqueRef(currentJobId),
      squareCustomerRef: auditMapping.refs.squareCustomerRef,
    });
    if (!apply) continue;
    try {
      await store.saveJobMapping({
        jobId: currentJobId,
        squareCustomerId: auditMapping.squareCustomerId,
        squareBookingId: auditMapping.squareBookingId,
      });
      result.created += 1;
    } catch {
      result.failed += 1;
    }
  }

  result.candidates = result.candidates.slice(0, 20).map(jsonClone);
  result.conflictDetails = result.conflictDetails.slice(0, 20).map(jsonClone);
  return result;
}

function createKvFromEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_TOKEN;
  return createUpstashKvMutationClient({ url, token });
}

export function getBackfillExitCode(result = {}) {
  return Number(result.conflicts || 0) > 0 || Number(result.failed || 0) > 0 ? 1 : 0;
}

export async function main() {
  loadLocalEnv();
  const apply = flag('--apply');
  const jsonOutput = flag('--json');
  const joinByJobNumber = flag('--join-by-job-number');
  const days = Number(argValue('--days', '30'));
  const limitValue = argValue('--limit', null);
  const limit = limitValue ? Number(limitValue) : Infinity;
  const ttlSeconds = Number(argValue('--ttl-seconds', String(DEFAULT_TTL_SECONDS)));
  const kv = createKvFromEnv();
  if (!kv) throw new Error('KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_* env is required');
  const store = createAttributionStore(kv, { ttlSeconds });
  const entries = await scanAuditEntries(kv, { limit });
  let result;
  if (joinByJobNumber) {
    const apiKey = process.env.ZENBOOKER_API_KEY;
    if (!apiKey) throw new Error('ZENBOOKER_API_KEY is required for --join-by-job-number');
    const endTime = new Date();
    const beginTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
    const jobs = await fetchZenBookerJobs({ apiKey, beginTime, endTime });
    result = await backfillJobMapsFromJobNumberMatches({
      entries,
      candidates: jobs.map((job) => ({
        rawJobId: job.id,
        jobNumber: job.job_number,
      })),
      store,
      apply,
    });
    result.window = { begin: beginTime.toISOString(), end: endTime.toISOString(), days };
  } else {
    result = await backfillJobMapsFromAuditEntries({ entries, store, apply });
  }
  result.ttlSeconds = ttlSeconds;
  result.source = joinByJobNumber ? `${AUDIT_PREFIX}* + ZenBooker /v1/jobs job_number` : `${AUDIT_PREFIX}*`;
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  console.log(`ZenBooker→Square attribution job-map backfill (${result.mode})`);
  console.log(`Scanned audits: ${result.scanned ?? entries.length}`);
  if (joinByJobNumber) {
    console.log(`Scanned current jobs: ${result.candidateScanned}`);
    console.log(`Unique job-number matches: ${result.uniqueJobNumberMatches}`);
    console.log(`Ambiguous job-number matches: ${result.ambiguousJobNumberMatches}`);
    console.log(`No job-number match: ${result.noJobNumberMatch}`);
  }
  console.log(`Existing maps: ${result.existing}`);
  console.log(`Conflicts: ${result.conflicts}`);
  if (!joinByJobNumber) console.log(`Missing identifiers: ${result.skippedMissingIdentifiers}`);
  console.log(`Would create: ${result.wouldCreate}`);
  console.log(`Created: ${result.created}`);
  console.log(`Failed: ${result.failed}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => {
      process.exitCode = getBackfillExitCode(result);
    })
    .catch((error) => {
      console.error(`backfill-attribution-job-maps-from-audit failed: ${error.message}`);
      process.exitCode = 1;
    });
}
