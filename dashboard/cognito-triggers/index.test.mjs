// Functional tests for the Cognito Pre Sign-up trigger. Pure logic, no AWS.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler, isAllowedEmail, domainOf, rejectionMessage } from './index.mjs';

const signUpEvent = (email, triggerSource = 'PreSignUp_SignUp') => ({
  triggerSource,
  request: { userAttributes: { email } },
  response: {},
});

test('accepts an address on the company domain', async () => {
  const event = signUpEvent('nurse@ti-smarthealth.com');
  assert.equal(await handler(event), event);
});

test('rejects an address on any other domain', async () => {
  await assert.rejects(
    () => handler(signUpEvent('someone@gmail.com')),
    /limited to @ti-smarthealth\.com/
  );
});

test('rejection message tells the user what to do instead', () => {
  assert.match(rejectionMessage(), /Use your work email/);
});

// A lookalike domain must not pass. The check is on the domain after the last
// @, not a substring match, so these are the cases that would break a naive
// endsWith/includes implementation.
test('rejects lookalike and embedded domains', async () => {
  for (const email of [
    'attacker@evil-ti-smarthealth.com',
    'attacker@ti-smarthealth.com.evil.com',
    'ti-smarthealth.com@gmail.com',
    'attacker@notti-smarthealth.com',
  ]) {
    await assert.rejects(() => handler(signUpEvent(email)), /limited to/, `should reject ${email}`);
  }
});

test('an @ in the local part does not confuse the domain check', () => {
  assert.equal(domainOf('odd"@"name@ti-smarthealth.com'), 'ti-smarthealth.com');
  assert.equal(isAllowedEmail('odd"@"name@ti-smarthealth.com'), true);
});

test('domain match is case-insensitive', () => {
  assert.equal(isAllowedEmail('Nurse@TI-SmartHealth.COM'), true);
});

test('rejects missing, empty and malformed addresses', async () => {
  for (const email of ['', 'no-at-sign', '@ti-smarthealth.com', undefined]) {
    await assert.rejects(() => handler(signUpEvent(email)), /limited to/, `should reject ${email}`);
  }
});

// The owner must always be able to create a user from the console, regardless
// of domain — otherwise a mistake in ALLOWED_EMAIL_DOMAINS is unrecoverable
// without editing the trigger.
test('admin-created users bypass the domain rule', async () => {
  const event = signUpEvent('contractor@gmail.com', 'PreSignUp_AdminCreateUser');
  assert.equal(await handler(event), event);
});

test('does not auto-confirm — the user must prove they own the address', async () => {
  const event = signUpEvent('nurse@ti-smarthealth.com');
  await handler(event);
  assert.notEqual(event.response.autoConfirmUser, true);
  assert.notEqual(event.response.autoVerifyEmail, true);
});

test('extra allowed domains are honoured', () => {
  const allowed = ['ti-smarthealth.com', 'contractor.example'];
  assert.equal(isAllowedEmail('a@contractor.example', allowed), true);
  assert.equal(isAllowedEmail('a@gmail.com', allowed), false);
});
