import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GBP_CAPTION_MAX_CHARS,
  buildGbpFenceCaption,
} from '../lib/install-post-copy.mjs';
import { buildGbpCaption } from '../lib/install-post-gbp-queue.mjs';

const REJECT = [
  'by The Mounting Man',
  'best',
  'trusted',
  '#1',
  'coupon',
  'sale',
  '% off',
  'serving the Twin Cities',
  'call now',
  'DM us',
];

function assertFenceRules(caption) {
  assert.ok(caption.length <= GBP_CAPTION_MAX_CHARS, `caption is ${caption.length} chars`);
  assert.doesNotMatch(caption, /#\w/);
  assert.doesNotMatch(caption, /themountingman\.com/i);
  assert.doesNotMatch(caption, /https?:\/\//i);
  for (const phrase of REJECT) {
    assert.equal(caption.toLowerCase().includes(phrase.toLowerCase()), false, phrase);
  }
}

test('Frame-on-tile caption leads with the product and two seed outcomes', () => {
  const caption = buildGbpFenceCaption({
    city: 'Minnetonka',
    'tv-size': '65"',
    'tv-brand': 'Samsung Frame',
    'gallery-style': true,
    'wall-surface': 'Tile',
    'street-name': 'Plymouth Road',
    'cable-management': 'Recessed Power Bridge',
    price: '$425',
  });
  assert.equal(
    caption,
    'Minnetonka Samsung Frame 65" on tile — Plymouth Road.\nRecessed outlet. Flush to tile.\n$425.',
  );
  assertFenceRules(caption);
});

test('mantel caption leads with MantelMount and does not invent Frame', () => {
  const caption = buildGbpFenceCaption({
    city: 'Edina',
    'tv-size': '75"',
    'tv-brand': 'Sony',
    mantelmount: true,
    'mount-type': 'MantelMount MM700',
    'fireplace-type': 'Stone Fireplace',
    'wall-surface': 'Stacked Stone',
    'street-name': 'France Avenue',
    'cable-management': 'In-Wall Concealment',
    'job-notes': 'Centered on the mantel',
    price: '$650',
  });
  assert.match(caption, /^Edina MantelMount 75" on stacked stone — France Avenue\./);
  assert.match(caption, /Centered on mantel/);
  assert.match(caption, /Cord concealment/);
  assert.match(caption, /^\$650\.$/m);
  assert.doesNotMatch(caption, /Samsung Frame/);
  assert.doesNotMatch(caption, /TV mounting/);
  assertFenceRules(caption);
});

test('generic drywall caption uses TV mount, not brand throat-clearing', () => {
  const caption = buildGbpFenceCaption({
    city: 'Minneapolis',
    'tv-size': '65"',
    'tv-brand': 'Samsung',
    'wall-surface': 'Drywall',
    'street-name': 'Lake Street',
    price: '$250',
  });
  assert.equal(caption, 'Minneapolis TV mount 65" on drywall — Lake Street.\n$250.');
  assert.doesNotMatch(caption, /TV mounting/);
  assert.doesNotMatch(caption, /Samsung Frame/);
  assert.doesNotMatch(caption, /MantelMount/);
  assertFenceRules(caption);
});

test('Shakopee-style example stays under 400 chars without by The Mounting Man', () => {
  const caption = buildGbpCaption({
    city: 'Shakopee',
    'tv-size': '65"',
    'tv-brand': 'Samsung',
    'gallery-style': true,
    'wall-surface': 'Tile',
    'street-name': 'Vierling Drive',
    'local-reference': 'Vierling Drive',
    'cable-management': 'In-Wall Concealment With New Outlet',
    price: '$425',
    'post-summary': 'TV mounting Shakopee by The Mounting Man. Best trusted #1 sale.',
    title: 'TV mounting Shakopee by The Mounting Man.',
  });
  assert.match(caption, /^Shakopee Samsung Frame 65" on tile — Vierling Drive\./);
  assert.match(caption, /Recessed outlet/);
  assert.match(caption, /Flush to tile/);
  assert.match(caption, /^\$425\.$/m);
  assert.doesNotMatch(caption, /by The Mounting Man/);
  assert.doesNotMatch(caption, /TV mounting/);
  assertFenceRules(caption);
});

test('GBP caption strips house numbers, URLs, hashtags, and unknown marketing', () => {
  const caption = buildGbpFenceCaption({
    city: 'Plymouth',
    'tv-size': '55"',
    'tv-brand': 'LG',
    'wall-surface': 'Drywall',
    'street-name': '4821 Elm Street',
    price: '$180.00',
    'job-notes': 'https://www.themountingman.com/installations/plymouth-lg #tvmount call now',
  });
  assert.equal(caption, 'Plymouth TV mount 55" on drywall — Elm Street.\n$180.');
  assert.doesNotMatch(caption, /4821/);
  assertFenceRules(caption);
});

test('soundbar Frame / Gallery notes do not become a Frame caption', () => {
  const caption = buildGbpFenceCaption({
    city: 'Minneapolis',
    'tv-size': '65"',
    'tv-brand': 'Samsung',
    'wall-surface': 'Drywall',
    'street-name': 'Lake Street',
    'job-notes': 'Soundbar Bracket (Frame / Gallery) Yes - Premium Bracket',
    price: '$250',
  });
  assert.equal(caption, 'Minneapolis TV mount 65" on drywall — Lake Street.\n$250.');
  assert.doesNotMatch(caption, /Samsung Frame/);
});

test('overlong outcome lines are dropped to keep the 400-character cap', () => {
  const caption = buildGbpFenceCaption({
    city: 'Minneapolis',
    'tv-size': '65"',
    'tv-brand': 'Samsung Frame',
    'gallery-style': true,
    'wall-surface': 'Hand-painted porcelain tile with decorative inset border',
    'street-name': `${'North '.repeat(40)}Mississippi River Boulevard`,
    'cable-management': 'Recessed Power Bridge',
    price: '$425',
  });
  assert.ok(caption.length <= GBP_CAPTION_MAX_CHARS);
  assert.match(caption, /Minneapolis Samsung Frame 65"/);
  assertFenceRules(caption);
});
