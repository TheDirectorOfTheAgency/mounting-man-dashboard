import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MINNEAPOLIS_CITY_STAMP,
  buildUnmountBody,
  buildUnmountSummary,
  ensureCityStamp,
  isExactMinneapolisCity,
  jobUsedFrame,
  jobUsedMantel,
} from '../lib/install-post-copy.mjs';
import { buildGbpCaption } from '../lib/install-post-gbp-queue.mjs';

const SUBURBS = ['Minnetonka', 'Plymouth', 'Edina', 'Woodbury', 'Richfield'];

function seed(city, overrides = {}) {
  return {
    city,
    'tv-size': '65"',
    'tv-brand': 'Samsung',
    'wall-surface': 'Drywall',
    'street-name': 'Lake Street',
    price: '$250',
    'gallery-style': false,
    mantelmount: false,
    ...overrides,
  };
}

test('exact Minneapolis city rejects metro and suburbs', () => {
  assert.equal(isExactMinneapolisCity('Minneapolis'), true);
  assert.equal(isExactMinneapolisCity('minneapolis'), true);
  assert.equal(isExactMinneapolisCity('Minneapolis–St. Paul'), false);
  assert.equal(isExactMinneapolisCity('Twin Cities'), false);
  for (const suburb of SUBURBS) {
    assert.equal(isExactMinneapolisCity(suburb), false, suburb);
  }
});

test('Minneapolis GBP caption is fence copy, not the website city stamp', () => {
  const caption = buildGbpCaption(seed('Minneapolis', {
    'post-summary': 'We mounted a 65 inch Samsung on drywall in Minneapolis.',
  }));
  assert.equal(caption.includes(MINNEAPOLIS_CITY_STAMP), false);
  assert.match(caption, /^Minneapolis TV mount 65" on drywall — Lake Street\./);
  assert.doesNotMatch(caption, /Samsung Frame/);
  assert.doesNotMatch(caption, /MantelMount/);
  assert.doesNotMatch(caption, /by The Mounting Man/);
});

test('Minneapolis Frame caption keeps Frame tagging and does not invent mantel', () => {
  const caption = buildGbpCaption(seed('Minneapolis', {
    'tv-brand': 'Samsung Frame',
    'gallery-style': true,
    'post-summary': '65" Samsung Frame TV installation in Minneapolis on drywall.',
  }));
  assert.equal(caption.includes(MINNEAPOLIS_CITY_STAMP), false);
  assert.match(caption, /^Minneapolis Samsung Frame 65" on drywall — Lake Street\./);
  assert.doesNotMatch(caption, /MantelMount/);
  assert.doesNotMatch(caption, /by The Mounting Man/);
});

test('Minneapolis MantelMount caption keeps mantel tagging and does not invent Frame', () => {
  const caption = buildGbpCaption(seed('Minneapolis', {
    mantelmount: true,
    'mount-type': 'MantelMount MM700',
    'tv-brand': 'Sony',
    'post-summary': '65" Sony TV installation in Minneapolis on drywall.',
  }));
  assert.equal(caption.includes(MINNEAPOLIS_CITY_STAMP), false);
  assert.match(caption, /^Minneapolis MantelMount 65" on drywall — Lake Street\./);
  assert.match(caption, /Centered on the mantel/);
  assert.doesNotMatch(caption, /TV mount/);
  assert.doesNotMatch(caption, /Samsung Frame/);
  assert.doesNotMatch(caption, /by The Mounting Man/);
});

test('suburb captions use that city and never stamp Minneapolis', () => {
  for (const suburb of SUBURBS) {
    const caption = buildGbpCaption(seed(suburb, {
      'post-summary': `We mounted a 65 inch Samsung on drywall in ${suburb}.`,
    }));
    assert.match(caption, new RegExp(`^${suburb} TV mount 65" on drywall — Lake Street\\.`));
    assert.equal(caption.includes(MINNEAPOLIS_CITY_STAMP), false, suburb);
    assert.doesNotMatch(caption, /by The Mounting Man/);
  }
});

test('metro labels do not get the Minneapolis stamp', () => {
  for (const metro of ['Minneapolis–St. Paul', 'Minneapolis-St. Paul', 'Twin Cities']) {
    const caption = buildGbpCaption(seed(metro, { 'post-summary': `Install in ${metro}.` }));
    assert.equal(caption.includes(MINNEAPOLIS_CITY_STAMP), false, metro);
    assert.match(caption, new RegExp(`^${metro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} TV mount`));
    assert.doesNotMatch(caption, /by The Mounting Man/);
  }
});

test('unmount copy in Minneapolis stamps once and keeps the real city on suburbs', () => {
  const minneapolis = seed('Minneapolis', { 'job-type': 'unmount' });
  const body = buildUnmountBody(minneapolis, 'Minneapolis');
  const summary = buildUnmountSummary(minneapolis, 'Minneapolis');
  assert.equal(body.split(MINNEAPOLIS_CITY_STAMP).length - 1, 1);
  assert.equal(summary.split(MINNEAPOLIS_CITY_STAMP).length - 1, 1);

  const edina = seed('Edina', { 'job-type': 'unmount' });
  const edinaBody = buildUnmountBody(edina, 'Edina');
  assert.equal(edinaBody.includes(MINNEAPOLIS_CITY_STAMP), false);
  assert.match(edinaBody, /TV mounting Edina by The Mounting Man\./);
});

test('soundbar Frame / Gallery notes do not count as a Frame job', () => {
  const notes = seed('Minneapolis', {
    'job-notes': 'Soundbar Bracket (Frame / Gallery) Yes - Premium Bracket',
  });
  assert.equal(jobUsedFrame(notes), false);
  assert.equal(jobUsedMantel(notes), false);
  const caption = buildGbpCaption({
    ...notes,
    'post-summary': 'We mounted a 65 inch Samsung on drywall in Minneapolis.',
  });
  assert.match(caption, /^Minneapolis TV mount 65" on drywall — Lake Street\./);
  assert.doesNotMatch(caption, /Samsung Frame/);
  assert.doesNotMatch(caption, /by The Mounting Man/);
});

test('ensureCityStamp is idempotent', () => {
  const once = ensureCityStamp('Completed near Lake Street.', 'Minneapolis');
  const twice = ensureCityStamp(once, 'Minneapolis');
  assert.equal(once.split(MINNEAPOLIS_CITY_STAMP).length - 1, 1);
  assert.equal(twice.split(MINNEAPOLIS_CITY_STAMP).length - 1, 1);
});
