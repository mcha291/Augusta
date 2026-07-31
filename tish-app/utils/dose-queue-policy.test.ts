/**
 * Tests for the dose retry queue's rules (4.4).
 *
 * Run with `npm test` from `tish-app/`.
 *
 * Every rule here fails silently in production — a dropped entry loses a
 * confirmation without saying so, and a kept-too-long entry eventually records
 * the *wrong* dose. Neither surfaces as an error anywhere, which is why they are
 * split out of the module that does the I/O and asserted directly.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONFIRM_TTL_MS,
  MAX_ATTEMPTS,
  MAX_QUEUE,
  SNOOZE_TTL_MS,
  enqueue,
  hasExpired,
  isRetryableStatus,
  isSpent,
  pickDose,
} from './dose-queue-policy.ts';
import type { QueuedDoseAction } from './dose-queue-policy.ts';

const NOW = Date.parse('2026-07-31T12:00:00+08:00');
const HOUR = 60 * 60 * 1000;

function entry(over: Partial<QueuedDoseAction> = {}): QueuedDoseAction {
  return {
    reminderId: 12,
    ownerUserId: 1,
    action: 'confirm',
    timeStr: '08:00',
    occurredAt: NOW,
    attempts: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Which failures are worth another attempt
// ---------------------------------------------------------------------------

test('a transient failure is retried', () => {
  for (const status of [500, 502, 503, 504, 408, 429]) {
    assert.equal(isRetryableStatus(status), true, String(status));
  }
});

test('401 IS RETRYABLE, and it is the one that matters most', () => {
  // An expired token is exactly what a snooze pressed on a phone that has been
  // asleep for hours hits, and the next sync carries a fresh session. Lumping
  // it in with the other 4xx would drop precisely the entries this queue exists
  // for.
  assert.equal(isRetryableStatus(401), true);
});

test('the terminal 4xx answers are terminal, or the queue never empties', () => {
  // 404: the dose was never materialised (a reminder predating 5.1, or an alarm
  // outside the window). 409: already confirmed. 400: malformed, and it will be
  // malformed again. 403: no access to that person. Retrying any of them is an
  // infinite loop against an answer that will not change.
  for (const status of [400, 403, 404, 409, 422]) {
    assert.equal(isRetryableStatus(status), false, String(status));
  }
});

// ---------------------------------------------------------------------------
// How long an entry stays worth replaying
// ---------------------------------------------------------------------------

test('a snooze expires long before a confirm, and the difference is deliberate', () => {
  assert.ok(SNOOZE_TTL_MS < CONFIRM_TTL_MS);
});

test('a confirm is still worth landing days later', () => {
  // It corrects the missed list (5.7) and tells a caregiver the dose was taken.
  assert.equal(hasExpired(entry({ action: 'confirm' }), NOW + 3 * 24 * HOUR), false);
  assert.equal(hasExpired(entry({ action: 'confirm' }), NOW + 8 * 24 * HOUR), true);
});

test('a stale snooze is dropped rather than replayed', () => {
  // Replaying it sets `snoozed_until` in the past and changes nothing except
  // `snooze_count` — which D-12 reads as evidence of repeated snoozing that
  // never happened, and uses to decide escalation fires regardless.
  assert.equal(hasExpired(entry({ action: 'snooze' }), NOW + 6 * HOUR), false);
  assert.equal(hasExpired(entry({ action: 'snooze' }), NOW + 13 * HOUR), true);
});

test('an entry is also spent once it has been tried enough times', () => {
  assert.equal(isSpent(entry({ attempts: MAX_ATTEMPTS - 1 }), NOW), false);
  assert.equal(isSpent(entry({ attempts: MAX_ATTEMPTS }), NOW), true);
});

// ---------------------------------------------------------------------------
// Enqueueing — collapsing repeats
// ---------------------------------------------------------------------------

test('the same dose snoozed twice is queued once, as the later press', () => {
  // Two snoozes offline are two real presses, but only the latest can be
  // replayed truthfully: the server sets `snoozed_until` from its own clock, so
  // sending both would increment `snooze_count` twice for one deferral.
  const first = entry({ action: 'snooze', occurredAt: NOW });
  const second = entry({ action: 'snooze', occurredAt: NOW + 10 * 60 * 1000 });
  const queue = enqueue(enqueue([], first), second);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].occurredAt, second.occurredAt);
});

test('A CONFIRM SUPERSEDES A QUEUED SNOOZE FOR THE SAME DOSE', () => {
  // The patient snoozed and then took it. Replaying the snooze afterwards would
  // push the escalation clock forward for a dose that is already done.
  const queue = enqueue(enqueue([], entry({ action: 'snooze' })), entry({ action: 'confirm' }));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].action, 'confirm');
});

test('a snooze does not supersede a confirm for the same dose', () => {
  const queue = enqueue(enqueue([], entry({ action: 'confirm' })), entry({ action: 'snooze' }));
  assert.deepEqual(queue.map((e) => e.action), ['confirm', 'snooze']);
});

test('different slots of one reminder are different doses', () => {
  const queue = enqueue(enqueue([], entry({ timeStr: '08:00' })), entry({ timeStr: '20:00' }));
  assert.equal(queue.length, 2);
});

test('different reminders never collapse into each other', () => {
  const queue = enqueue(enqueue([], entry({ reminderId: 12 })), entry({ reminderId: 13 }));
  assert.equal(queue.length, 2);
});

test('the queue is bounded, and the trim keeps the newest', () => {
  let queue: QueuedDoseAction[] = [];
  for (let i = 0; i < MAX_QUEUE + 5; i++) {
    queue = enqueue(queue, entry({ reminderId: i, occurredAt: NOW + i }));
  }
  assert.equal(queue.length, MAX_QUEUE);
  assert.equal(queue[queue.length - 1].reminderId, MAX_QUEUE + 4);
});

// ---------------------------------------------------------------------------
// pickDose — the reason a replay is not just "POST it again"
// ---------------------------------------------------------------------------

const MORNING = { id: 1, reminder_id: 12, scheduled_for: '2026-07-31T08:00:00+08:00' };
const EVENING = { id: 2, reminder_id: 12, scheduled_for: '2026-07-31T20:00:00+08:00' };
const OTHER_REMINDER = { id: 3, reminder_id: 13, scheduled_for: '2026-07-31T08:00:00+08:00' };

test('THE WHOLE POINT: a replay resolves against when the button was pressed', () => {
  // Pressed at 08:05, retried at 15:00. "Nearest to now" would pick the evening
  // dose and confirm one nobody has taken — suppressing the escalation that
  // exists to catch exactly that. Resolving against `occurredAt` picks the
  // morning dose no matter when the replay happens.
  const pressedAt = Date.parse('2026-07-31T08:05:00+08:00');
  assert.equal(pickDose([MORNING, EVENING], 12, pressedAt)?.id, 1);
});

test('it picks the nearest dose, not the first', () => {
  const pressedAt = Date.parse('2026-07-31T20:03:00+08:00');
  assert.equal(pickDose([MORNING, EVENING], 12, pressedAt)?.id, 2);
});

test('another reminder\'s dose at the same minute is never picked', () => {
  const pressedAt = Date.parse('2026-07-31T08:05:00+08:00');
  assert.equal(pickDose([OTHER_REMINDER, MORNING], 12, pressedAt)?.id, 1);
  assert.equal(pickDose([OTHER_REMINDER], 12, pressedAt), null);
});

test('nothing within tolerance is null, not a guess', () => {
  const pressedAt = Date.parse('2026-08-05T08:05:00+08:00');
  assert.equal(pickDose([MORNING, EVENING], 12, pressedAt), null);
});

test('unparseable rows are skipped rather than sorting to the front', () => {
  const pressedAt = Date.parse('2026-07-31T08:05:00+08:00');
  const rows = [{ id: 9, reminder_id: 12, scheduled_for: 'nonsense' }, MORNING];
  assert.equal(pickDose(rows, 12, pressedAt)?.id, 1);
});

test('an empty or missing list resolves to nothing', () => {
  assert.equal(pickDose([], 12, NOW), null);
  assert.equal(pickDose(undefined as any, 12, NOW), null);
});

test('ids compare numerically, so a string reminder_id still matches', () => {
  const pressedAt = Date.parse('2026-07-31T08:05:00+08:00');
  const rows = [{ id: 1, reminder_id: '12', scheduled_for: MORNING.scheduled_for }];
  assert.equal(pickDose(rows, 12, pressedAt)?.id, 1);
});
