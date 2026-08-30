import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LINKEDIN_RECEIPT_FAILURE,
  isLinkedInImageUgcSuccess,
  isLinkedInPostReceipt,
  isLinkedInShareReceipt,
  sanitizeLinkedInDestination,
} from '../lib/install-post-linkedin.mjs';
import { sanitizePublishResult, collectPostedDestinations } from '../lib/install-post-queue.mjs';

const SHARE_ID = 'urn:li:share:7499851525402308608';
const SHARE_PERMALINK = 'https://www.linkedin.com/feed/update/urn:li:share:7499924411085611008';
const UGC_ID = 'urn:li:ugcPost:7499800000000000000';
const ACTIVITY_POSTS = (
  'https://www.linkedin.com/posts/themountingman_'
  + 'tvmounting-brooklynpark-activity-7499800000000000000-AbCd'
);

test('a raw share URN is a documented Posts API receipt but a share permalink is not', () => {
  assert.equal(isLinkedInShareReceipt(SHARE_ID), true);
  assert.equal(isLinkedInShareReceipt(SHARE_PERMALINK), true);
  assert.equal(isLinkedInPostReceipt(SHARE_ID), true);
  assert.equal(isLinkedInImageUgcSuccess(SHARE_ID), true);
  assert.equal(isLinkedInPostReceipt(SHARE_PERMALINK), false);
  assert.equal(isLinkedInImageUgcSuccess(SHARE_PERMALINK), false);
  assert.equal(isLinkedInPostReceipt(`posted ${SHARE_ID}`), false);
});

test('a ugcPost id or legacy Posts-tab activity URL is success', () => {
  assert.equal(isLinkedInPostReceipt(UGC_ID), true);
  assert.equal(isLinkedInImageUgcSuccess(UGC_ID), true);
  assert.equal(isLinkedInImageUgcSuccess(ACTIVITY_POSTS), true);
  assert.equal(
    isLinkedInImageUgcSuccess('https://www.linkedin.com/feed/update/urn:li:activity:7499800000000000000'),
    true,
  );
  assert.equal(isLinkedInShareReceipt(UGC_ID), false);
});

test('sanitizeLinkedInDestination preserves documented raw post IDs and rejects malformed receipts', () => {
  const share = sanitizeLinkedInDestination({
    name: 'linkedin',
    status: 'PUBLISHED',
    detail: SHARE_ID,
  });
  assert.equal(share.status, 'PUBLISHED');
  assert.equal(share.detail, SHARE_ID);

  const empty = sanitizeLinkedInDestination({
    name: 'linkedin',
    status: 'PUBLISHED',
    detail: 'urn:li:digitalmediaAsset:asset-1',
  });
  assert.equal(empty.status, 'RETRYABLE_FAILURE');
  assert.equal(empty.detail, LINKEDIN_RECEIPT_FAILURE);

  const ok = sanitizeLinkedInDestination({
    name: 'linkedin',
    status: 'PUBLISHED',
    detail: UGC_ID,
  });
  assert.equal(ok.status, 'PUBLISHED');
  assert.equal(ok.detail, UGC_ID);
});

test('sanitizePublishResult retains a documented LinkedIn share Post ID', () => {
  const sanitized = sanitizePublishResult({
    status: 'PUBLISHED',
    liveUrl: 'https://www.themountingman.com/installations/fireplace-tv-mounting-maple-grove-75-inch-tilting-mount-jewel-way',
    publicStatus: 200,
    destinations: [
      { name: 'website', status: 'PUBLISHED', detail: 'https://www.themountingman.com/installations/x' },
      { name: 'linkedin', status: 'PUBLISHED', detail: SHARE_ID },
    ],
  });
  const linkedin = sanitized.destinations.find((entry) => entry.name === 'linkedin');
  assert.equal(linkedin.status, 'PUBLISHED');
  assert.equal(isLinkedInPostReceipt(linkedin.detail), true);
  assert.equal(
    collectPostedDestinations(sanitized.destinations).some((entry) => entry.name === 'linkedin'),
    true,
  );
});

test('a real image ugcPost still survives reconcile as already posted', () => {
  const destinations = [
    { name: 'linkedin', status: 'PUBLISHED', detail: UGC_ID },
  ];
  const posted = collectPostedDestinations(destinations);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].detail, UGC_ID);
});
