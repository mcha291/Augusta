/**
 * Tests for the notification identifier scheme (4.2 item 1, 4.7b's burst index).
 *
 * Run with `npm test` from `tish-app/`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { belongsToReminder, identifierFor, isSnoozeIdentifier, snoozeIdentifierFor } from './notification-identifiers.ts';

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test('an owned alarm is namespaced by owner', () => {
  assert.equal(identifierFor(12, '08:00', 7), 'med-7-12-0800');
});

test('the colon is stripped from the slot', () => {
  assert.equal(identifierFor(12, '23:05', 7), 'med-7-12-2305');
});

test('an owner of 0 is still an owner, not a missing one', () => {
  // `ownerUserId != null` rather than a truthiness check — id 0 is falsy.
  assert.equal(identifierFor(12, '08:00', 0), 'med-0-12-0800');
});

test('an unknown owner falls back to the un-namespaced form', () => {
  assert.equal(identifierFor(12, '08:00'), 'med-12-0800');
});

// ---------------------------------------------------------------------------
// 4.7b — the burst index
// ---------------------------------------------------------------------------

test('a burst member carries its index', () => {
  assert.equal(identifierFor(12, '08:00', 7, 1), 'med-7-12-0800-1');
  assert.equal(identifierFor(12, '08:00', 7, 3), 'med-7-12-0800-3');
});

test('a burst index is NEVER appended without an owner, because that shape is ambiguous', () => {
  // `med-12-0800-1` has four segments, and so does `med-{owner}-{id}-{slot}`.
  // The parser has to commit to reading position 2 as the reminder id, so an
  // un-namespaced burst identifier would be read as reminder `0800` — and
  // Number('0800') is 800. Making it unconstructible beats defending against it.
  assert.equal(identifierFor(12, '08:00', undefined, 2), 'med-12-0800');
});

test('burst members of one dose differ only in the final segment', () => {
  const members = [1, 2, 3].map((n) => identifierFor(12, '08:00', 7, n));
  assert.deepEqual(members, ['med-7-12-0800-1', 'med-7-12-0800-2', 'med-7-12-0800-3']);
  assert.equal(new Set(members).size, 3);
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test('an alarm belongs to its own reminder and owner', () => {
  assert.equal(belongsToReminder('med-7-12-0800', 12, 7), true);
});

test('every burst member matches the reminder it belongs to', () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    assert.equal(belongsToReminder(`med-7-12-0800-${n}`, 12, 7), true, `member ${n}`);
  }
});

test('a burst member does not match a different owner', () => {
  assert.equal(belongsToReminder('med-7-12-0800-2', 12, 9), false);
});

test('a burst member does not match a different reminder', () => {
  assert.equal(belongsToReminder('med-7-12-0800-2', 13, 7), false);
});

test('THE COLLISION: a slot is never mistaken for a reminder id', () => {
  // Reminder 800 must not be matched by an alarm whose slot is 08:00.
  assert.equal(belongsToReminder('med-7-12-0800-2', 800, 7), false);
  assert.equal(belongsToReminder('med-7-12-0800', 800, 7), false);
});

test('THE COLLISION, the other direction: owner 7 vs reminder 7', () => {
  // `med-7-` is a prefix of both "reminder 7, un-namespaced" and "everything
  // owned by user 7". Prefix matching would wipe a whole person's set while
  // cancelling one reminder.
  assert.equal(belongsToReminder('med-7-12-0800', 7), false, 'owner 7 is not reminder 7');
  assert.equal(belongsToReminder('med-7-0800', 7), true, 'un-namespaced reminder 7 is');
});

test('omitting the owner matches every copy of the reminder on the device', () => {
  // What `deleteReminder` relies on: the reminder is gone for everyone, so the
  // patient's own set and any caregiver copy should both go.
  assert.equal(belongsToReminder('med-7-12-0800-2', 12), true);
  assert.equal(belongsToReminder('med-9-12-0800-2', 12), true);
});

test('legacy un-namespaced alarms still match, which is what clears them', () => {
  assert.equal(belongsToReminder('med-12-0800', 12), true);
  assert.equal(belongsToReminder('med-12-0800', 12, 7), true, 'owner filter cannot apply to an alarm that has none');
});

test('anything that is not one of ours is rejected', () => {
  assert.equal(belongsToReminder('appt-7-12-0800', 12, 7), false);
  assert.equal(belongsToReminder('med', 12, 7), false);
  assert.equal(belongsToReminder('med-12', 12, 7), false);
  assert.equal(belongsToReminder('', 12, 7), false);
});

test('ids compare numerically, so string and number arguments agree', () => {
  assert.equal(belongsToReminder(identifierFor('12', '08:00', 7, 2), 12, 7), true);
});

// ---------------------------------------------------------------------------
// The slot filter — the fix for a reminder-wide cancel eating sibling slots
// ---------------------------------------------------------------------------

test('THE BUG: without a slot, one reminder\'s alarms all match each other', () => {
  // This is the behaviour that made the 08:00 alarm firing cancel the pending
  // 20:00 alert, which the chain-forward then never rewrote. Still correct for
  // callers that mean the whole reminder — asserted so the two intents stay
  // visibly distinct.
  assert.equal(belongsToReminder('med-7-12-2000-1', 12, 7), true);
});

test('a slot filter keeps a cancel inside the occurrence that fired', () => {
  assert.equal(belongsToReminder('med-7-12-0800-1', 12, 7, '08:00'), true);
  assert.equal(belongsToReminder('med-7-12-2000-1', 12, 7, '08:00'), false, 'the evening dose survives the morning one');
});

test('the slot filter reaches the un-namespaced form too', () => {
  assert.equal(belongsToReminder('med-12-0800', 12, undefined, '08:00'), true);
  assert.equal(belongsToReminder('med-12-2000', 12, undefined, '08:00'), false);
});

test('seconds on either side do not break the slot comparison', () => {
  // `identifierFor` strips only the first colon, so a time that arrived as
  // "08:00:00" builds the segment "0800:00". Both sides normalise to four chars.
  assert.equal(belongsToReminder(identifierFor(12, '08:00:00', 7, 1), 12, 7, '08:00'), true);
  assert.equal(belongsToReminder(identifierFor(12, '08:00', 7, 1), 12, 7, '08:00:00'), true);
});

test('an empty-string slot is a slot, not an absent filter', () => {
  // Guards the `timeStr != null` test against being written as a truthiness
  // check: '' would then silently widen the cancel back to the whole reminder.
  assert.equal(belongsToReminder('med-7-12-0800-1', 12, 7, ''), false);
});

// ---------------------------------------------------------------------------
// 4.4 — the snooze alarm
// ---------------------------------------------------------------------------

test('a snooze alarm sits outside the burst series', () => {
  assert.equal(snoozeIdentifierFor(12, '08:00', 7), 'med-7-12-0800-s');
  // The whole point: it must not be any burst member, at any repeat count.
  for (const n of [1, 2, 3, 4, 5, 6]) {
    assert.notEqual(snoozeIdentifierFor(12, '08:00', 7), identifierFor(12, '08:00', 7, n));
  }
});

test('a snooze alarm still belongs to its reminder, owner and slot', () => {
  const id = snoozeIdentifierFor(12, '08:00', 7);
  assert.equal(belongsToReminder(id, 12, 7), true, 'a delete clears it');
  assert.equal(belongsToReminder(id, 12, 7, '08:00'), true, 'the next occurrence firing clears it');
  assert.equal(belongsToReminder(id, 12, 7, '20:00'), false, 'a sibling slot does not');
  assert.equal(belongsToReminder(id, 13, 7), false);
  assert.equal(belongsToReminder(id, 12, 9), false);
});

test('without an owner the snooze falls back to the alarm identifier itself', () => {
  // `med-12-0800-s` would be read as reminder "0800" by the four-segment
  // branch — the same ambiguity that makes an un-namespaced burst index
  // unconstructible. Colliding with the alarm it replaces is the safe answer.
  assert.equal(snoozeIdentifierFor(12, '08:00'), 'med-12-0800');
});

test('a snooze alarm is recognisable, and nothing else is', () => {
  assert.equal(isSnoozeIdentifier(snoozeIdentifierFor(12, '08:00', 7)), true);
  assert.equal(isSnoozeIdentifier(identifierFor(12, '08:00', 7, 1)), false);
  assert.equal(isSnoozeIdentifier(identifierFor(12, '08:00', 7)), false);
  assert.equal(isSnoozeIdentifier(snoozeIdentifierFor(12, '08:00')), false, 'the un-namespaced fallback is indistinguishable, by construction');
  assert.equal(isSnoozeIdentifier('appt-7-12-0800-s'), false);
});

// ---------------------------------------------------------------------------
// Round trip — the property that actually matters at the call sites
// ---------------------------------------------------------------------------

test('everything identifierFor builds, belongsToReminder finds', () => {
  for (const owner of [undefined, 0, 7, 12]) {
    for (const burst of [undefined, 1, 3, 6]) {
      const id = identifierFor(12, '08:00', owner, burst);
      assert.equal(belongsToReminder(id, 12, owner), true, id);
      assert.equal(belongsToReminder(id, 12), true, `${id} (no owner filter)`);
      assert.equal(belongsToReminder(id, 12, owner, '08:00'), true, `${id} (slot filter)`);
    }
  }
});
