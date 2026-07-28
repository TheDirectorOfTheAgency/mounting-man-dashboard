#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createOfflineConversionCoordinator } from '../lib/offline-conversion-coordinator.js';
import { createAttributionStore } from '../lib/offline-conversion-store.js';
import { uploadOfflineConversion } from '../lib/google-ads-conversions.js';
import { createUpstashKvMutationClient } from './backfill-attribution-job-maps-from-audit.mjs';

const SQUARE_BASE_URL = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = process.env.SQUARE_VERSION || '2024-01-18';
const OPAQUE_JOB_REF = /^[a-f0-9]{24}$/;
const OPAQUE_PAYMENT_REF = /^[a-f0-9]{24}$/;
const MODES = new Set(['dry-run', 'validate', 'apply']);

function loadLocalEnv() {
  for (const filename of ['.env.local', '.env']) {
    const envPath = path.join(process.cwd(), filename);
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
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

function valuesForArg(argv, name) {
  const values = [];
  const inlinePrefix = `${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith(inlinePrefix)) {
      values.push(arg.slice(inlinePrefix.length));
    } else if (arg === name && argv[index + 1]) {
      values.push(argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

export function parseReplayArgs(argv = []) {
  const validate = argv.includes('--validate');
  const apply = argv.includes('--apply');
  if (validate && apply) throw new Error('Choose only one of --validate or --apply');

  const mode = apply ? 'apply' : validate ? 'validate' : 'dry-run';
  const selected = valuesForArg(argv, '--job-ref');
  const approved = valuesForArg(argv, '--approve-job-ref');
  const paymentRefs = valuesForArg(argv, '--payment-ref');
  const expectedNetValues = valuesForArg(argv, '--expected-net-value');
  if (apply && selected.length > 0) {
    throw new Error('Apply accepts only explicit --approve-job-ref selections');
  }
  if (!apply && approved.length > 0) {
    throw new Error('--approve-job-ref may be used only with --apply');
  }

  const jobRefs = apply ? approved : selected;
  if (jobRefs.length === 0) {
    throw new Error(
      apply
        ? 'Apply requires at least one --approve-job-ref'
        : `${mode} requires at least one --job-ref`
    );
  }
  for (const jobRef of jobRefs) {
    if (!OPAQUE_JOB_REF.test(jobRef)) {
      throw new Error('Job refs must be 24-character lowercase opaque references');
    }
  }
  if (new Set(jobRefs).size !== jobRefs.length) {
    throw new Error('Each selected job ref may appear only once');
  }
  if (
    paymentRefs.length !== jobRefs.length
    || expectedNetValues.length !== jobRefs.length
  ) {
    throw new Error(
      'Each selected job requires one paired --payment-ref and --expected-net-value'
    );
  }
  for (const paymentRef of paymentRefs) {
    if (!OPAQUE_PAYMENT_REF.test(paymentRef)) {
      throw new Error('Payment refs must be 24-character lowercase opaque references');
    }
  }
  if (new Set(paymentRefs).size !== paymentRefs.length) {
    throw new Error('Each selected payment ref may appear only once');
  }
  const selections = jobRefs.map((jobRef, index) => ({
    jobRef,
    paymentRef: paymentRefs[index],
    expectedPaymentNetAmount: parseExpectedNetValue(expectedNetValues[index]),
  }));
  selections.sort((left, right) => left.jobRef.localeCompare(right.jobRef));

  return {
    mode,
    selections,
    json: argv.includes('--json'),
  };
}

function parseExpectedNetValue(value) {
  const match = String(value || '').match(/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/);
  if (!match) {
    throw new Error('Expected net values must be positive USD amounts with at most two decimals');
  }
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error('Expected net values must be positive USD amounts with at most two decimals');
  }
  return cents;
}

export function getReplayExitCode(result = {}) {
  return result.failed === 0 ? 0 : 1;
}

function customerData(customer = {}) {
  return {
    email: customer.email_address || null,
    phone: customer.phone_number || null,
    firstName: customer.given_name || null,
    lastName: customer.family_name || null,
  };
}

export async function runSelectedReplay({
  selections,
  mode = 'dry-run',
  store,
  fetchCustomer,
  uploadConversion = uploadOfflineConversion,
}) {
  if (!MODES.has(mode)) throw new Error(`Unsupported replay mode: ${mode}`);
  if (!store) throw new Error('Attribution store is required');
  if (typeof fetchCustomer !== 'function') throw new Error('Square customer fetcher is required');
  if (typeof uploadConversion !== 'function') throw new Error('Upload function is required');

  const selected = [...(selections || [])].sort((left, right) =>
    String(left?.jobRef || '').localeCompare(String(right?.jobRef || ''))
  );
  if (selected.length === 0) throw new Error('At least one selected opaque job ref is required');
  if (new Set(selected.map((selection) => selection?.jobRef)).size !== selected.length) {
    throw new Error('Each selected job ref may appear only once');
  }
  if (new Set(selected.map((selection) => selection?.paymentRef)).size !== selected.length) {
    throw new Error('Each selected payment ref may appear only once');
  }
  for (const selection of selected) {
    if (!OPAQUE_JOB_REF.test(selection?.jobRef)) {
      throw new Error('Job refs must be 24-character lowercase opaque references');
    }
    if (!OPAQUE_PAYMENT_REF.test(selection?.paymentRef)) {
      throw new Error('Payment refs must be 24-character lowercase opaque references');
    }
    if (
      !Number.isInteger(selection?.expectedPaymentNetAmount)
      || selection.expectedPaymentNetAmount <= 0
    ) {
      throw new Error('Each selected job requires a positive expected payment net amount in cents');
    }
  }

  const coordinator = createOfflineConversionCoordinator({
    store,
    uploadConversion,
    mode: mode === 'apply' ? 'continuous' : mode === 'validate' ? 'validate' : 'observe',
  });
  const results = [];

  for (const selection of selected) {
    const { jobRef, paymentRef, expectedPaymentNetAmount } = selection;
    try {
      const mapping = await store.getJobMapping(jobRef);
      if (!mapping?.squareCustomerId) {
        results.push({ jobRef, paymentRef, status: 'missing_or_mismatched_mapping' });
        continue;
      }
      const customer = customerData(await fetchCustomer(mapping.squareCustomerId));
      const assertion = { customer, paymentRef, expectedPaymentNetAmount };
      const result = mode === 'dry-run'
        ? await coordinator.inspectJob(jobRef, assertion)
        : await coordinator.resolveJob(jobRef, assertion);
      results.push({
        jobRef,
        paymentRef,
        status: result.status,
        retryable: Boolean(result.retryable),
        errorCode: result.errorCode || null,
        paidMarker: result.paidMarker || null,
        evidence: result.evidence || [],
      });
    } catch (error) {
      results.push({
        jobRef,
        paymentRef,
        status: 'operator_processing_failed',
        retryable: true,
        errorCode: error?.name === 'Error' ? 'OPERATOR_PROCESSING_FAILED' : 'UNKNOWN_FAILURE',
      });
    }
  }

  return {
    mode,
    selected: selected.length,
    ready: results.filter((result) => result.status === 'ready').length,
    validated: results.filter((result) => result.status === 'validated').length,
    uploaded: results.filter((result) => result.status === 'uploaded').length,
    failed: results.filter((result) =>
      !['ready', 'validated', 'uploaded', 'already_uploaded'].includes(result.status)
    ).length,
    results,
  };
}

async function fetchSquareCustomer(squareCustomerId, { token, fetcher = fetch } = {}) {
  const response = await fetcher(
    `${SQUARE_BASE_URL}/customers/${encodeURIComponent(squareCustomerId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Square-Version': SQUARE_VERSION,
        Accept: 'application/json',
      },
    }
  );
  const body = await response.json();
  if (!response.ok || !body?.customer) {
    throw new Error(`Square customer lookup failed with HTTP ${response.status}`);
  }
  return body.customer;
}

function createKvFromEnv() {
  const url =
    process.env.KV_REST_API_URL
    || process.env.UPSTASH_REDIS_REST_URL
    || process.env.UPSTASH_REDIS_URL;
  const token =
    process.env.KV_REST_API_TOKEN
    || process.env.UPSTASH_REDIS_REST_TOKEN
    || process.env.UPSTASH_REDIS_TOKEN;
  return createUpstashKvMutationClient({ url, token });
}

export async function main(argv = process.argv.slice(2)) {
  loadLocalEnv();
  const options = parseReplayArgs(argv);
  const kv = createKvFromEnv();
  if (!kv) throw new Error('KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_* env is required');
  const squareToken =
    process.env.SQUARE_ACCESS_TOKEN
    || process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
  if (!squareToken) throw new Error('SQUARE_ACCESS_TOKEN is required');

  const result = await runSelectedReplay({
    ...options,
    store: createAttributionStore(kv),
    fetchCustomer: (squareCustomerId) =>
      fetchSquareCustomer(squareCustomerId, { token: squareToken }),
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  console.log(`Offline conversion replay (${result.mode})`);
  console.log(`Selected: ${result.selected}`);
  console.log(`Ready: ${result.ready}`);
  console.log(`Validated: ${result.validated}`);
  console.log(`Uploaded: ${result.uploaded}`);
  console.log(`Failed/blocked: ${result.failed}`);
  for (const item of result.results) {
    console.log(`- jobRef=${item.jobRef} paymentRef=${item.paymentRef} status=${item.status}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => {
      process.exitCode = getReplayExitCode(result);
    })
    .catch((error) => {
      console.error(`replay-offline-conversions failed: ${error.message}`);
      process.exitCode = 1;
    });
}
