/**
 * Migration 008's snooze length, and the normalisation that has to hold at both
 * ends of a JSON round trip through the OS notification queue.
 *
 * The interesting cases are all failure directions rather than happy paths: what
 * a missing field becomes, what a malformed one becomes, and that the fallback
 * is the same value the server falls back to.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SNOOZE_MINUTES,
  SNOOZE_MINUTES_MAX,
  SNOOZE_MINUTES_MIN,
  snoozeMinutesFor,
} from './alarm-settings.ts';

test('a configured snooze interval is carried through unchanged', () => {
  assert.equal(snoozeMinutesFor(30), 30);
  assert.equal(snoozeMinutesFor(SNOOZE_MINUTES_MIN), SNOOZE_MINUTES_MIN);
  assert.equal(snoozeMinutesFor(SNOOZE_MINUTES_MAX), SNOOZE_MINUTES_MAX);
});

test('an unusable snooze falls back to ten, not to the minimum', () => {
  // Zero is the case worth naming: a zero-minute snooze is not a snooze, it is
  // an alarm that re-rings immediately, and flooring it to 1 would be barely
  // better. Ten is what the server falls back to — the two must agree, or the
  // device re-arms at one time and `snoozed_until` records another.
  for (const value of [undefined, null, '', 'later', NaN, 0, -5]) {
    assert.equal(snoozeMinutesFor(value), DEFAULT_SNOOZE_MINUTES, `for ${String(value)}`);
  }
});

test('an alarm scheduled before migration 008 snoozes for ten minutes', () => {
  // Its payload was written into the OS queue with no `snoozeMinutes` at all,
  // and may not fire for days. It has to behave exactly as it did when it was
  // written rather than picking up a value it was never scheduled under.
  const payloadFromOlderBuild: Record<string, unknown> = { reminderId: 12, timeStr: '08:00' };
  assert.equal(snoozeMinutesFor(payloadFromOlderBuild.snoozeMinutes), DEFAULT_SNOOZE_MINUTES);
});

test('a snooze past the ceiling is clamped rather than refused', () => {
  assert.equal(snoozeMinutesFor(99999), SNOOZE_MINUTES_MAX);
});

test('a fractional snooze is truncated rather than rounded', () => {
  assert.equal(snoozeMinutesFor(10.9), 10);
  // Below one minute there is nothing to truncate to, so it lands on the default
  // rather than on a snooze that expires the moment it is set.
  assert.equal(snoozeMinutesFor(0.4), DEFAULT_SNOOZE_MINUTES);
});

test('the client clamp agrees with the range the API enforces', () => {
  // Three copies of this rule exist — a CHECK constraint, a 400, and this
  // module — and only one of them can be imported here. If the bounds ever
  // drift, the device re-arms an alarm the server would have rejected.
  assert.equal(SNOOZE_MINUTES_MIN, 1);
  assert.equal(SNOOZE_MINUTES_MAX, 120);
  assert.equal(DEFAULT_SNOOZE_MINUTES, 10);
});
