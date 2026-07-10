import assert from 'node:assert/strict';
import test from 'node:test';

import { buildUserIdentifiers } from '../lib/hash-pii.js';

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
