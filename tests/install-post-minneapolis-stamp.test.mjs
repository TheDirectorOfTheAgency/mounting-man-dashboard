import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MINNEAPOLIS_CITY_STAMP,
  buildUnmountBody,
  buildUnmountSummary,
  cityMountingStamp,
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

test('Minneapolis GBP caption stamps the phrase once', () => {
  const caption = buildGbpCaption(seed('Minneapolis', {
    'post-summary': 'We mounted a 65 inch Samsung on drywall in Minneapolis.',
  }));
  assert.equal(caption.split(MINNEAPOLIS_CITY_STAMP).length - 1, 1);
  assert.match(caption, /65 inch Samsung/);
  assert.doesNotMatch(caption, /Samsung Frame/);
  assert.doesNotMatch(caption, /MantelMount/);
});

test('Minneapolis Frame caption keeps Frame tagging and does not invent mantel', () => {
  const caption = buildGbpCaption(seed('Minneapolis', {
    'tv-brand': 'Samsung Frame',
    'gallery-style': true,
    'post-summary': '65" Samsung Frame TV installation in Minneapolis on drywall.',
  }));
  assert.equal(caption.split(MINNEAPOLIS_CITY_STAMP).length - 1, 1);
  assert.match(caption, /Samsung Frame/);
  assert.doesNotMatch(caption, /MantelMount/);
});

test('Minneapolis MantelMount caption keeps mantel tagging and does not invent Frame', () => {
  const caption = buildGbpCaption(seed('Minneapolis', {
    mantelmount: true,
    'mount-type': 'MantelMount MM700',
    'tv-brand': 'Sony',
    'post-summary': '65" Sony TV installation in Minneapolis on drywall.',
  }));
  assert.equal(caption.split(MINNEAPOLIS_CITY_STAMP).length - 1, 1);
  assert.match(caption, /MantelMount/);
  assert.doesNotMatch(caption, /Samsung Frame/);
});

test('suburb captions use that city and never stamp Minneapolis', () => {
  for (const suburb of SUBURBS) {
    const stamp = cityMountingStamp(suburb);
    const caption = buildGbpCaption(seed(suburb, {
      'post-summary': `We mounted a 65 inch Samsung on drywall in ${suburb}.`,
    }));
    assert.match(caption, new RegExp(stamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(caption.includes(MINNEAPOLIS_CITY_STAMP), false, suburb);
    assert.equal(caption.split(stamp).length - 1, 1, suburb);
  }
});

test('metro labels do not get the Minneapolis stamp', () => {
  for (const metro of ['Minneapolis–St. Paul', 'Minneapolis-St. Paul', 'Twin Cities']) {
    const caption = buildGbpCaption(seed(metro, { 'post-summary': `Install in ${metro}.` }));
    assert.equal(caption.includes(MINNEAPOLIS_CITY_STAMP), false, metro);
    assert.match(caption, new RegExp(cityMountingStamp(metro).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
  assert.doesNotMatch(caption, /Samsung Frame/);
});

test('ensureCityStamp is idempotent', () => {
  const once = ensureCityStamp('Completed near Lake Street.', 'Minneapolis');
  const twice = ensureCityStamp(once, 'Minneapolis');
  assert.equal(once.split(MINNEAPOLIS_CITY_STAMP).length - 1, 1);
  assert.equal(twice.split(MINNEAPOLIS_CITY_STAMP).length - 1, 1);
});
