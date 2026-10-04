import assert from 'node:assert/strict';
import test from 'node:test';

import { buildUserIdentifiers, hashEmail, hashPhone } from '../lib/hash-pii.js';

test('conversion user identifiers contain only first-party hashed email and phone', () => {
  const identifiers = buildUserIdentifiers({
    email: 'Validation.Only+test@gmail.com',
    phone: '+12025550123',
    firstName: 'Unsupported',
    lastName: 'For Conversion Uploads',
  });

  assert.equal(identifiers.length, 2);
  assert.deepEqual(
    identifiers.map((value) => Object.keys(value).sort()),
    [
      ['hashedEmail', 'userIdentifierSource'],
      ['hashedPhoneNumber', 'userIdentifierSource'],
    ]
  );
  assert.equal(
    identifiers.every((value) => value.userIdentifierSource === 'FIRST_PARTY'),
    true
  );
  assert.equal(JSON.stringify(identifiers).includes('addressInfo'), false);
});

test('email hashing removes gmail dots and plus tags before SHA-256', () => {
  assert.equal(
    hashEmail('Validation.Only+test@gmail.com'),
    hashEmail('validationonly@gmail.com'),
  );
  assert.equal(hashEmail('not-an-email'), null);
});

test('phone hashing normalizes US numbers to E.164 before SHA-256', () => {
  assert.equal(hashPhone('(612) 555-0123'), hashPhone('+16125550123'));
  assert.equal(hashPhone('+1 612-555-0123'), hashPhone('6125550123'));
  assert.equal(hashPhone('555'), null);
});
