import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createConfiguredDispatcher,
} from '../lib/install-post-dispatch.mjs';
import {
  convertJpegToWebP,
  digestPhotoBytes,
  looksLikeJpeg,
  looksLikeWebP,
  parseMultipartForm,
} from '../lib/install-post-photo-bind.mjs';
import { INSTALL_POST_STATES } from '../lib/install-post-queue.mjs';
import { createInstallPostStore } from '../lib/install-post-store.mjs';
import { createIngestPhotoHandler } from '../pages/api/install-post/ingest-photo.js';
import { createResponse } from './webhook-test-helpers.js';

const CRON_SECRET = 'test-cron-secret';
const NOW = 1_760_000_000_000;
const HOST = 'mounting-man-dashboard.vercel.app';

const VERCEL_DEPLOY_SHA = '33aaec01aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GITHUB_MAIN_SHA = '9a407cabaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const SEED = {
  city: 'Blaine',
  'tv-size': '65"',
  'tv-brand': 'Samsung',
  'wall-surface': 'Drywall',
  price: '$350',
  'street-name': '123rd Lane Northeast',
  'seed-index': 1,
  'seed-count': 1,
};

function tinyWebP() {
  return Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    0x0e, 0x00, 0x00, 0x00, 0x30, 0x01, 0x00, 0x9d,
    0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00,
    0x34, 0x25, 0xa4, 0x00, 0x03, 0x70, 0x00, 0xfe,
    0xfb, 0x94, 0x00,
  ]);
}

function tinyJpeg() {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0xff, 0xd9,
  ]);
}

function createFakeKv() {
  const values = new Map();
  const sets = new Map();
  return {
    values,
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async del(key) { values.delete(key); return 1; },
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(member);
      return 1;
    },
    async srem(key, member) { sets.get(key)?.delete(member); return 1; },
    async smembers(key) { return [...(sets.get(key) || [])]; },
  };
}

function createFakeWebflow() {
  const puts = [];
  const signs = [];
  return {
    puts,
    signs,
    async createSignedUpload({ fileName, fileHash }) {
      signs.push({ fileName, fileHash });
      return {
        assetId: 'asset-ingest-1',
        hostedUrl: `https://cdn.example.com/${fileName}`,
        uploadUrl: 'https://s3.example.com/upload',
        uploadDetails: { key: `assets/${fileName}` },
      };
    },
    async putSignedUpload(payload) {
      puts.push(payload);
    },
  };
}

function createFakeDispatcher() {
  const dispatches = [];
  return {
    dispatches,
    async dispatch(payload) {
      dispatches.push(payload);
      return { dispatchId: payload.dispatchId };
    },
  };
}

function buildMultipart({ fields = {}, photo, boundary = '----ingestboundary' } = {}) {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  if (photo) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${photo.filename || 'photo.bin'}"\r\nContent-Type: ${photo.contentType}\r\n\r\n`,
    ));
    chunks.push(photo.bytes);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    boundary,
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function stageJob(sourceRefs = { orderId: 'ORDER-BLAINE', paymentId: 'PAY-BLAINE' }) {
  const store = createInstallPostStore(createFakeKv());
  const [record] = await store.stageJobRecords({
    seeds: [SEED],
    sourceRefs,
    source: 'square-webhook',
    stagedAt: '2026-09-02T15:00:00.000Z',
  });
  return { store, record };
}

function ingestRequest({ secret = CRON_SECRET, fields, photo, origin } = {}) {
  const multipart = buildMultipart({ fields, photo });
  const headers = {
    host: HOST,
    'content-type': multipart.contentType,
  };
  if (secret) headers['x-install-post-secret'] = secret;
  if (origin) headers.origin = origin;
  return {
    method: 'POST',
    headers,
    body: multipart.body,
    query: {},
  };
}

function handlerFor({ store, webflow, dispatcher, convertJpeg }) {
  return createIngestPhotoHandler({
    store,
    cronSecret: CRON_SECRET,
    webflow: webflow || createFakeWebflow(),
    dispatcher: dispatcher || createFakeDispatcher(),
    convertJpeg: convertJpeg || (async () => tinyWebP()),
    now: () => NOW,
  });
}

test('multipart parser extracts photo bytes and JSON identifier fields', () => {
  const webp = tinyWebP();
  const { body, contentType } = buildMultipart({
    fields: { paymentId: 'PAY-1', orderId: 'ORDER-1', jobId: 'job_abc' },
    photo: { bytes: webp, contentType: 'image/webp', filename: 'install.webp' },
  });
  const parsed = parseMultipartForm(body, contentType);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.paymentId, 'PAY-1');
  assert.equal(parsed.fields.orderId, 'ORDER-1');
  assert.equal(parsed.fields.jobId, 'job_abc');
  assert.equal(parsed.files.photo.contentType, 'image/webp');
  assert.ok(parsed.files.photo.bytes.equals(webp));
});

test('secret auth refuses missing, wrong, and query-string secrets', async () => {
  const { store, record } = await stageJob();
  const ingest = handlerFor({ store });
  const photo = { bytes: tinyWebP(), contentType: 'image/webp', filename: 'a.webp' };
  const fields = { jobId: record.jobId };

  const missing = createResponse();
  await ingest(ingestRequest({ secret: '', fields, photo }), missing);
  assert.equal(missing.statusCode, 401);

  const wrong = createResponse();
  await ingest(ingestRequest({ secret: 'nope', fields, photo }), wrong);
  assert.equal(wrong.statusCode, 401);

  const queryOnly = createResponse();
  await ingest({
    method: 'POST',
    headers: { host: HOST, 'content-type': ingestRequest({ fields, photo }).headers['content-type'] },
    query: { secret: CRON_SECRET },
    body: ingestRequest({ fields, photo }).body,
  }, queryOnly);
  assert.equal(queryOnly.statusCode, 401);
});

test('secret path does not require a phone origin or session cookie', async () => {
  const { store, record } = await stageJob();
  const dispatcher = createFakeDispatcher();
  const ingest = handlerFor({ store, dispatcher });
  const res = createResponse();
  await ingest(ingestRequest({
    fields: { jobId: record.jobId },
    photo: { bytes: tinyWebP(), contentType: 'image/webp', filename: 'a.webp' },
    origin: 'https://evil.example.com',
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.job.state, INSTALL_POST_STATES.PUBLISHING);
  assert.equal(dispatcher.dispatches.length, 1);
});

test('secret photo POST binds a staged AWAITING_PHOTO job by paymentId', async () => {
  const { store, record } = await stageJob();
  assert.equal(record.state, INSTALL_POST_STATES.AWAITING_PHOTO);
  const dispatcher = createFakeDispatcher();
  const webflow = createFakeWebflow();
  const ingest = handlerFor({ store, dispatcher, webflow });
  const webp = tinyWebP();
  const digest = digestPhotoBytes(webp);

  const res = createResponse();
  await ingest(ingestRequest({
    fields: { paymentId: 'PAY-BLAINE' },
    photo: { bytes: webp, contentType: 'image/webp', filename: 'blaine.webp' },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.job.jobId, record.jobId);
  assert.equal(res.body.job.state, INSTALL_POST_STATES.PUBLISHING);
  assert.equal(res.body.job.image.sha256, digest.sha256);
  assert.equal(res.body.job.image.contentType, 'image/webp');
  assert.equal(webflow.puts.length, 1);
  assert.equal(webflow.signs[0].fileName.endsWith('.webp'), true);
  assert.equal(dispatcher.dispatches.length, 1);
  assert.equal(dispatcher.dispatches[0].jobId, record.jobId);
  const serialized = JSON.stringify({ body: res.body, dispatch: dispatcher.dispatches });
  for (const forbidden of ['PAY-BLAINE', 'ORDER-BLAINE', 'publish_one.py']) {
    assert.ok(!serialized.includes(forbidden), `leaked ${forbidden}`);
  }
});

test('JPEG desk bytes are converted to WebP before the Webflow bind', async () => {
  const { store, record } = await stageJob();
  const webp = tinyWebP();
  let converted = 0;
  const webflow = createFakeWebflow();
  const ingest = handlerFor({
    store,
    webflow,
    convertJpeg: async (bytes) => {
      converted += 1;
      assert.ok(looksLikeJpeg(bytes));
      return webp;
    },
  });

  const res = createResponse();
  await ingest(ingestRequest({
    fields: { orderId: 'ORDER-BLAINE' },
    photo: { bytes: tinyJpeg(), contentType: 'image/jpeg', filename: 'blaine.jpg' },
  }), res);

  assert.equal(converted, 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.job.image.contentType, 'image/webp');
  assert.equal(res.body.job.image.sha256, digestPhotoBytes(webp).sha256);
  assert.ok(webflow.signs[0].fileName.endsWith('.webp'));
  assert.equal(webflow.puts[0].fileName.endsWith('.webp'), true);
  assert.ok(looksLikeWebP(webflow.puts[0].bytes));
  assert.equal((await store.loadRecord(record.jobId)).image.contentType, 'image/webp');
});

test('injectable JPEG converter returns WebP bytes', async () => {
  const webp = tinyWebP();
  const out = await convertJpegToWebP(tinyJpeg(), { convert: async () => webp });
  assert.ok(looksLikeWebP(out));
  assert.ok(out.equals(webp));
});

test('returns 404 when no staged job matches paymentId or jobId', async () => {
  const store = createInstallPostStore(createFakeKv());
  const ingest = handlerFor({ store });
  const res = createResponse();
  await ingest(ingestRequest({
    fields: { paymentId: 'PAY-MISSING' },
    photo: { bytes: tinyWebP(), contentType: 'image/webp', filename: 'a.webp' },
  }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'not_found');
});

test('returns 409 when the staged job is already publishing or published', async () => {
  const { store, record } = await stageJob();
  await store.saveRecord({ ...record, state: INSTALL_POST_STATES.PUBLISHED });
  const ingest = handlerFor({ store });
  const published = createResponse();
  await ingest(ingestRequest({
    fields: { jobId: record.jobId },
    photo: { bytes: tinyWebP(), contentType: 'image/webp', filename: 'a.webp' },
  }), published);
  assert.equal(published.statusCode, 409);
  assert.equal(published.body.error, 'already_published');

  const { store: store2, record: record2 } = await stageJob({ orderId: 'O2', paymentId: 'P2' });
  await store2.saveRecord({ ...record2, state: INSTALL_POST_STATES.PUBLISHING });
  const ingest2 = handlerFor({ store: store2 });
  const flying = createResponse();
  await ingest2(ingestRequest({
    fields: { jobId: record2.jobId },
    photo: { bytes: tinyWebP(), contentType: 'image/webp', filename: 'a.webp' },
  }), flying);
  assert.equal(flying.statusCode, 409);
  assert.equal(flying.body.error, 'publish_in_flight');
});

test('ingest auto-publish pins source_commit to GitHub main, never a Vercel SHA', async () => {
  const { store, record } = await stageJob();
  const posts = [];
  const gets = [];
  const httpClient = {
    async get(url) {
      gets.push(url);
      return { data: { object: { sha: GITHUB_MAIN_SHA, type: 'commit' } } };
    },
    async post(url, payload) {
      posts.push({ url, payload });
      return { status: 204 };
    },
  };

  const keys = [
    'VERCEL_GIT_COMMIT_SHA',
    'INSTALL_POST_DISPATCH_TOKEN',
    'INSTALL_POST_DISPATCH_OWNER',
    'INSTALL_POST_DISPATCH_REPO',
    'INSTALL_POST_DISPATCH_WORKFLOW',
    'INSTALL_POST_DISPATCH_REF',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    VERCEL_GIT_COMMIT_SHA: VERCEL_DEPLOY_SHA,
    INSTALL_POST_DISPATCH_TOKEN: 'ghp_test',
    INSTALL_POST_DISPATCH_OWNER: 'TheDirectorOfTheAgency',
    INSTALL_POST_DISPATCH_REPO: 'mounting-man-dashboard',
  });

  try {
    const ingest = createIngestPhotoHandler({
      store,
      cronSecret: CRON_SECRET,
      webflow: createFakeWebflow(),
      dispatcher: createConfiguredDispatcher({ httpClient }),
      convertJpeg: async () => tinyWebP(),
      now: () => NOW,
    });
    const res = createResponse();
    await ingest(ingestRequest({
      fields: { jobId: record.jobId },
      photo: { bytes: tinyWebP(), contentType: 'image/webp', filename: 'a.webp' },
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(posts.length, 1);
    assert.match(posts[0].url, /workflows\/publish-install-post\.yml\/dispatches$/);
    assert.equal(posts[0].payload.ref, 'main');
    assert.equal(posts[0].payload.inputs.source_commit, GITHUB_MAIN_SHA);
    assert.notEqual(posts[0].payload.inputs.source_commit, VERCEL_DEPLOY_SHA);
    assert.ok(!JSON.stringify(posts[0].payload).includes(VERCEL_DEPLOY_SHA));
    assert.match(gets[0], /\/git\/ref\/heads\/main$/);
    assert.equal((await store.loadRecord(record.jobId)).state, INSTALL_POST_STATES.PUBLISHING);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
