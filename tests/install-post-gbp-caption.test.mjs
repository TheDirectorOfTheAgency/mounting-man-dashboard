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
    price: '$650',
  });
  assert.equal(
    caption,
    'Edina MantelMount 75" on stacked stone — France Avenue.\nCentered on the mantel. No cords on the stone.\n$650.',
  );
  assert.doesNotMatch(caption, /Samsung Frame/);
  assert.doesNotMatch(caption, /TV mount/);
  assertFenceRules(caption);
});

test('Heather Lane MantelMount uses stacked stone, not TV mount on drywall', () => {
  const caption = buildGbpFenceCaption({
    city: 'Edina',
    'tv-size': '65"',
    'tv-brand': 'Sony',
    mantelmount: true,
    'fireplace-type': 'Stone Fireplace',
    'wall-surface': 'Stacked Stone',
    'street-name': 'Heather Lane',
    'cable-management': 'In-Wall Concealment',
  });
  assert.equal(
    caption,
    'Edina MantelMount 65" on stacked stone — Heather Lane.\nCentered on the mantel. No cords on the stone.',
  );
  assert.doesNotMatch(caption, /TV mount/);
  assert.doesNotMatch(caption, /on drywall/);
  assertFenceRules(caption);
});

test('fireplace seed never falls through to commodity TV mount on drywall', () => {
  const caption = buildGbpFenceCaption({
    city: 'Edina',
    'tv-size': '65"',
    'tv-brand': 'Sony',
    mantelmount: true,
    'fireplace-type': 'Stone Fireplace',
    'wall-surface': 'Drywall',
    'street-name': 'Heather Lane',
    'cable-management': 'In-Wall Concealment',
    price: '$650',
  });
  assert.equal(
    caption,
    'Edina MantelMount 65" on stone — Heather Lane.\nCentered on the mantel. No cords on the stone.\n$650.',
  );
  assert.doesNotMatch(caption, /TV mount/);
  assert.doesNotMatch(caption, /on drywall/);
  assertFenceRules(caption);
});

test('specialty jobs always lead with the product name, never TV mount', () => {
  const examples = [
    {
      name: 'Samsung Frame',
      seed: {
        city: 'Minnetonka',
        'tv-size': '65"',
        'tv-brand': 'Samsung Frame',
        'gallery-style': true,
        'wall-surface': 'Tile',
        'street-name': 'Plymouth Road',
      },
      lead: 'Minnetonka Samsung Frame 65" on tile — Plymouth Road.',
    },
    {
      name: 'Hisense Canvas',
      seed: {
        city: 'Plymouth',
        'tv-size': '75"',
        'tv-brand': 'Hisense Canvas',
        'gallery-style': true,
        'wall-surface': 'Drywall',
        'street-name': 'Vicksburg Lane',
      },
      lead: 'Plymouth Hisense Canvas 75" on drywall — Vicksburg Lane.',
    },
    {
      name: 'LG G-Series',
      seed: {
        city: 'Bloomington',
        'tv-size': '65"',
        'tv-brand': 'LG G-Series',
        'gallery-style': true,
        'wall-surface': 'Drywall',
        'street-name': 'Normandale Boulevard',
      },
      lead: 'Bloomington LG G-Series 65" on drywall — Normandale Boulevard.',
    },
    {
      name: 'MantelMount',
      seed: {
        city: 'Edina',
        'tv-size': '65"',
        mantelmount: true,
        'fireplace-type': 'Stone Fireplace',
        'wall-surface': 'Stacked Stone',
        'street-name': 'Heather Lane',
      },
      lead: 'Edina MantelMount 65" on stacked stone — Heather Lane.',
    },
    {
      name: 'tile fireplace',
      seed: {
        city: 'Eden Prairie',
        'tv-size': '75"',
        'tv-brand': 'Sony',
        mantelmount: false,
        'fireplace-type': 'Tile Fireplace',
        'wall-surface': 'Tile',
        'street-name': 'Prairie Center Drive',
      },
      lead: 'Eden Prairie 75" on tile fireplace — Prairie Center Drive.',
    },
    {
      name: 'Frame on tile fireplace',
      seed: {
        city: 'Eden Prairie',
        'tv-size': '75"',
        'tv-brand': 'Samsung Frame',
        'gallery-style': true,
        mantelmount: false,
        'fireplace-type': 'Tile Fireplace',
        'wall-surface': 'Tile',
        'street-name': 'Prairie Center Drive',
      },
      lead: 'Eden Prairie Samsung Frame 75" on tile fireplace — Prairie Center Drive.',
    },
  ];

  for (const example of examples) {
    const caption = buildGbpFenceCaption(example.seed);
    assert.equal(caption.split('\n')[0], example.lead, example.name);
    assert.doesNotMatch(caption, /TV mount/, example.name);
    assertFenceRules(caption);
  }
});

test('tile fireplace recovered from a drywall default puts fireplace in the surface', () => {
  const caption = buildGbpFenceCaption({
    city: 'Eden Prairie',
    'tv-size': '65"',
    'tv-brand': 'Samsung',
    mantelmount: false,
    'fireplace-type': 'Tile Fireplace',
    'wall-surface': 'Drywall',
    'street-name': 'Prairie Center Drive',
    'cable-management': 'In-Wall Concealment',
  });
  assert.equal(
    caption,
    'Eden Prairie 65" on tile fireplace — Prairie Center Drive.\nCentered on the mantel. No cords on the tile.',
  );
  assert.doesNotMatch(caption, /tile fireplace \d/);
  assert.doesNotMatch(caption, /TV mount/);
  assert.doesNotMatch(caption, /on drywall/);
  assertFenceRules(caption);
});

test('fireplace-only seed puts fireplace in the surface, not the product', () => {
  const caption = buildGbpFenceCaption({
    city: 'Edina',
    'tv-size': '65"',
    'tv-brand': 'Samsung',
    mantelmount: false,
    'fireplace-type': 'Stacked Stone Fireplace',
    'wall-surface': 'Drywall',
    'street-name': 'Heather Lane',
    'cable-management': 'Cord Concealment',
  });
  assert.equal(
    caption,
    'Edina 65" on stacked stone fireplace — Heather Lane.\nCentered on the mantel. No cords on the stone.',
  );
  assert.doesNotMatch(caption, /fireplace mount/);
  assert.doesNotMatch(caption, /TV mount/);
  assert.doesNotMatch(caption, /on drywall/);
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
