import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const privacySource = fs.readFileSync(new URL('../pages/privacy.js', import.meta.url), 'utf8');

test('privacy policy discloses advertising measurement data sharing and customer rights', () => {
  assert.match(privacySource, /hashed contact information/i);
  assert.match(privacySource, /service outcome data/i);
  assert.match(privacySource, /including Google/i);
  assert.match(privacySource, /measure whether advertising led to a booked and completed service/i);
  assert.match(privacySource, /do not sell/i);
  assert.match(privacySource, /deletion/i);
  assert.match(privacySource, /mailto:/i);
});
