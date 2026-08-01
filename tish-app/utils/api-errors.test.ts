// 6.2 — the code-to-key mapping. Run with the rest: `cd tish-app && npm test`.
//
// The rules here fail *silently* in production, which is why they are asserted
// rather than reasoned about: every wrong answer in this file is a user reading
// either nothing at all or a sentence in the wrong language, and neither throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  apiErrorKeys,
  apiErrorMessage,
  describeApiFailure,
  errorKeyFor,
  problemKeyFor,
  statusFallbackKey,
  NETWORK_KEY,
  UNEXPECTED_KEY,
} from './api-errors.ts';

// Renders a key as itself, so a test can assert on keys rather than on copy.
const echo = (key: string) => key;

test('a known code maps to its key', () => {
  assert.equal(errorKeyFor('ACCESS_DENIED'), 'errors.accessDenied');
  assert.equal(errorKeyFor('RELATIONSHIP_TARGET_NOT_FOUND'), 'errors.relationshipTargetNotFound');
});

test('an unknown, absent or non-string code maps to nothing', () => {
  for (const value of ['NOT_A_REAL_CODE', undefined, null, 42, {}, '']) {
    assert.equal(errorKeyFor(value), null);
  }
});

// **THE FALLBACK.** A code this build has never heard of is guaranteed on the
// next backend deploy after any client build, permanently, because the two ship
// independently. It must still produce a real sentence.
test('THE FALLBACK — an unknown code degrades to the status, never to nothing', () => {
  const keys = apiErrorKeys({ status: 409, body: { error: 'Whatever', code: 'INVENTED_LATER' } });
  assert.equal(keys.length, 1);
  assert.equal(keys[0], 'errors.conflict');
  assert.notEqual(keys[0], undefined);
  // And it is a key, not the server's English.
  assert.doesNotMatch(keys[0], /Whatever/);
});

test('THE FALLBACK — every plausible status yields exactly one usable key', () => {
  for (const status of [400, 401, 403, 404, 405, 409, 418, 422, 500, 502, 503]) {
    const keys = apiErrorKeys({ status, body: { code: 'INVENTED_LATER' } });
    assert.equal(keys.length, 1, `status ${status} produced ${keys.length} keys`);
    assert.ok(keys[0].startsWith('errors.'), `status ${status} produced ${keys[0]}`);
  }
  assert.equal(statusFallbackKey(503), 'errors.server');
  assert.equal(statusFallbackKey(500), 'errors.server');
  assert.equal(statusFallbackKey(418), UNEXPECTED_KEY);
});

test('no status at all is a network failure, not a server one', () => {
  assert.equal(statusFallbackKey(undefined), NETWORK_KEY);
  assert.equal(statusFallbackKey(NaN), NETWORK_KEY);
  assert.deepEqual(apiErrorKeys({}), [NETWORK_KEY]);
});

// **THE RECOVERY.** §0.6: /me answers 404 rather than 401 because 401 invites
// the client to sign a half-registered user out. The mapping must not undo that
// by routing an unmapped 404 to session-expired copy.
test('THE RECOVERY — no 404 can ever produce the session-expired sentence', () => {
  const sessionKey = errorKeyFor('AUTH_REQUIRED');
  assert.equal(apiErrorKeys({ status: 404, body: { code: 'PROFILE_NOT_FOUND' } })[0], 'errors.profileNotFound');
  // ...including a 404 carrying a code from some future backend.
  assert.notEqual(apiErrorKeys({ status: 404, body: { code: 'SOMETHING_NEW' } })[0], sessionKey);
  assert.equal(apiErrorKeys({ status: 404, body: {} })[0], 'errors.notFound');
  // The two 404s about people are separate sentences, because one means
  // "finish signing up" and the other means "that account does not exist".
  assert.notEqual(errorKeyFor('PROFILE_NOT_FOUND'), errorKeyFor('USER_NOT_FOUND'));
});

test('problems win over the top-level code, because they are more specific', () => {
  const keys = apiErrorKeys({
    status: 400,
    body: {
      code: 'VALIDATION_FAILED',
      problems: [
        { field: 'escalation_delay_minutes', code: 'ESCALATION_DELAY_OUT_OF_RANGE' },
        { field: 'alarm_repeat_count', code: 'ALARM_REPEAT_COUNT_OUT_OF_RANGE' },
      ],
    },
  });
  assert.deepEqual(keys, ['errors.field.escalationDelayRange', 'errors.field.alarmRepeatCountRange']);
});

test('repeated problem codes collapse to one sentence', () => {
  const keys = apiErrorKeys({
    status: 400,
    body: {
      code: 'VALIDATION_FAILED',
      problems: [
        { field: 'breakfast_time', code: 'TIME_FORMAT_INVALID' },
        { field: 'dinner_time', code: 'TIME_FORMAT_INVALID' },
      ],
    },
  });
  assert.deepEqual(keys, ['errors.field.timeFormatInvalid']);
});

// An unrecognised problem must not strand the caller on an empty message: it
// falls back to the code, which is still specific enough to be useful.
test('problems this build cannot read fall through to the code, not to silence', () => {
  const keys = apiErrorKeys({
    status: 400,
    body: { code: 'VALIDATION_FAILED', problems: [{ field: 'x', code: 'ADDED_LATER' }] },
  });
  assert.deepEqual(keys, ['errors.validationFailed']);
});

// The server's English rides along on every failure — `error` at the top level
// and `message` on each problem — and none of it may reach a screen. Asserted
// as an exact key rather than as "does not contain the prose", because a key
// name can legitimately share a word with the sentence it replaces
// (`errors.verificationCodeMismatch` vs `Security Mismatch`).
test('THE ENGLISH IS NEVER RENDERED, from any rung of the ladder', () => {
  const cases: [Record<string, unknown>, string][] = [
    // rung 2, the code
    [{ error: 'Security Mismatch', code: 'VERIFICATION_CODE_MISMATCH' }, 'errors.verificationCodeMismatch'],
    [{ error: 'Reminder not found', code: 'REMINDER_NOT_FOUND' }, 'errors.reminderNotFound'],
    // rung 3, an unmapped code falling through to the status
    [{ error: 'Some prose from a future route', code: 'ADDED_LATER' }, 'errors.badRequest'],
    // rung 1, a problem carrying its own English
    [
      { error: 'Bad field', code: 'VALIDATION_FAILED', problems: [{ code: 'FIELD_REQUIRED', message: 'token is required.' }] },
      'errors.field.required',
    ],
  ];
  for (const [body, expected] of cases) {
    assert.equal(apiErrorMessage({ status: 400, body }, echo), expected);
  }
});

test('a body that is not an object at all still produces a sentence', () => {
  for (const body of [undefined, null, 'a gateway HTML page', 42, []]) {
    const keys = apiErrorKeys({ status: 502, body });
    assert.deepEqual(keys, ['errors.server']);
  }
});

test('apiErrorMessage joins every key it was given', () => {
  const message = apiErrorMessage({
    status: 400,
    body: {
      code: 'VALIDATION_FAILED',
      problems: [
        { code: 'ESCALATION_DELAY_OUT_OF_RANGE' },
        { code: 'ESCALATION_ORDER_INVALID' },
      ],
    },
  }, echo);
  assert.equal(message, 'errors.field.escalationDelayRange\nerrors.field.escalationOrderInvalid');
});

test('problemKeyFor rejects anything it does not know', () => {
  assert.equal(problemKeyFor('TIME_FORMAT_INVALID'), 'errors.field.timeFormatInvalid');
  assert.equal(problemKeyFor('nope'), null);
  assert.equal(problemKeyFor(undefined), null);
});

// A 502 from the gateway is HTML. Parsing must not throw a second error inside
// the error handler.
test('describeApiFailure survives a body that is not JSON', async () => {
  const failure = await describeApiFailure({
    status: 502,
    json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
  });
  assert.equal(failure.status, 502);
  assert.equal(failure.body, undefined);
  assert.deepEqual(apiErrorKeys(failure), ['errors.server']);
});

test('describeApiFailure passes a well-formed body straight through', async () => {
  const failure = await describeApiFailure({
    status: 403,
    json: () => Promise.resolve({ error: 'Access Denied', code: 'ACCESS_DENIED' }),
  });
  assert.deepEqual(apiErrorKeys(failure), ['errors.accessDenied']);
});
