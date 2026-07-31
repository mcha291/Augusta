/**
 * Tests for `computeNextTriggerDate` — 4.2 item 4's offset in particular, where
 * the ordering of "add the delay" against "has it passed" is the whole
 * correctness argument.
 *
 * Run with `npm test` from `tish-app/`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { computeNextTriggerDate } from './date.ts';

/** Local-time constructor, so these read as wall-clock like the scheduler does. */
function at(y: number, m: number, d: number, hh: number, mm: number) {
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// ---------------------------------------------------------------------------
// The patient's own alarms — unchanged behaviour, guarded against regression.
// ---------------------------------------------------------------------------

test("first schedule uses today when the slot hasn't passed", () => {
  const now = at(2026, 7, 31, 6, 0);
  assert.equal(fmt(computeNextTriggerDate('08:00', 1, now, true)), '2026-07-31 08:00');
});

test('first schedule rolls forward when the slot has passed', () => {
  const now = at(2026, 7, 31, 9, 0);
  assert.equal(fmt(computeNextTriggerDate('08:00', 1, now, true)), '2026-08-01 08:00');
});

test('a slot exactly now counts as passed, so an alarm is never scheduled at zero notice', () => {
  const now = at(2026, 7, 31, 8, 0);
  assert.equal(fmt(computeNextTriggerDate('08:00', 1, now, true)), '2026-08-01 08:00');
});

test('chaining off a firing always advances by the full interval', () => {
  const now = at(2026, 7, 31, 8, 0);
  assert.equal(fmt(computeNextTriggerDate('08:00', 3, now, false)), '2026-08-03 08:00');
});

test('a zero or nonsense frequency is treated as daily, not as "never"', () => {
  const now = at(2026, 7, 31, 9, 0);
  assert.equal(fmt(computeNextTriggerDate('08:00', 0, now, true)), '2026-08-01 08:00');
  assert.equal(fmt(computeNextTriggerDate('08:00', NaN as any, now, true)), '2026-08-01 08:00');
});

// ---------------------------------------------------------------------------
// 4.2 item 4 — the caregiver's escalation copy.
// ---------------------------------------------------------------------------

test('the offset delays the caregiver copy past the dose time', () => {
  const now = at(2026, 7, 31, 6, 0);
  assert.equal(fmt(computeNextTriggerDate('08:00', 1, now, true, 30)), '2026-07-31 08:30');
});

test('THE CASE THIS ORDERING EXISTS FOR: syncing after the dose but before the escalation keeps today', () => {
  // Caregiver opens the app at 08:05 for an 08:00 dose with a 30-minute delay.
  // Comparing the un-offset dose time would see 08:00 as past and roll to
  // tomorrow, silently dropping the escalation for the dose actually in doubt.
  const now = at(2026, 7, 31, 8, 5);
  assert.equal(fmt(computeNextTriggerDate('08:00', 1, now, true, 30)), '2026-07-31 08:30');
});

test('once the escalation time itself has passed, it rolls forward — D-2, no replay', () => {
  const now = at(2026, 7, 31, 8, 45);
  assert.equal(fmt(computeNextTriggerDate('08:00', 1, now, true, 30)), '2026-08-01 08:30');
});

test('an offset that crosses midnight lands on the next day', () => {
  const now = at(2026, 7, 31, 20, 0);
  assert.equal(fmt(computeNextTriggerDate('23:50', 1, now, true, 30)), '2026-08-01 00:20');
});

test('a midnight-crossing offset adds one day, not two', () => {
  // The slot is anchored to `fromDate`'s own day, so 23:50 + 30m is always the
  // following morning and is never in the past — no interval roll should be
  // added on top of the crossing.
  const now = at(2026, 8, 1, 1, 0);
  assert.equal(fmt(computeNextTriggerDate('23:50', 1, now, true, 30)), '2026-08-02 00:20');
});

test('chaining forward keeps the offset, so occurrence two is not back at dose time', () => {
  const now = at(2026, 7, 31, 8, 30);
  assert.equal(fmt(computeNextTriggerDate('08:00', 1, now, false, 30)), '2026-08-01 08:30');
});

test('chaining forward keeps the offset across a multi-day frequency', () => {
  const now = at(2026, 7, 31, 8, 30);
  assert.equal(fmt(computeNextTriggerDate('08:00', 3, now, false, 30)), '2026-08-03 08:30');
});

test('a long delay is not capped and simply lands later', () => {
  const now = at(2026, 7, 31, 6, 0);
  assert.equal(fmt(computeNextTriggerDate('08:00', 1, now, true, 240)), '2026-07-31 12:00');
});

test('offset 0 is byte-identical to omitting it — the patient path cannot be disturbed', () => {
  for (const [time, freq, hh, mm] of [['08:00', 1, 6, 0], ['08:00', 1, 9, 0], ['23:50', 2, 23, 55]] as const) {
    const now = at(2026, 7, 31, hh, mm);
    assert.equal(
      computeNextTriggerDate(time, freq, now, true, 0).getTime(),
      computeNextTriggerDate(time, freq, now, true).getTime()
    );
  }
});

test('an escalation is never scheduled in the past, whatever the delay', () => {
  const now = at(2026, 7, 31, 8, 5);
  for (const delay of [10, 15, 30, 60, 120, 240]) {
    const next = computeNextTriggerDate('08:00', 1, now, true, delay);
    assert.ok(next.getTime() > now.getTime(), `delay ${delay} scheduled at or before now: ${fmt(next)}`);
  }
});
