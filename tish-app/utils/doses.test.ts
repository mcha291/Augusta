/**
 * Tests for reading materialised dose rows (4.2 item 4's confirmed check, 5.7's
 * missed list).
 *
 * Run with `npm test` from `tish-app/`.
 *
 * **Nothing here asserts a literal wall-clock against a literal offset**, on
 * purpose. `doseKey` formats in the device's own zone, so a test comparing
 * `'…+08:00'` to `'…T08:00'` would pass in Taipei and fail everywhere else —
 * it would be testing the machine, not the code. The format is pinned with
 * dates built from local components, and the server-row-to-device-Date
 * agreement is pinned as a round trip, which holds in any zone.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmedDoseKeys, doseKey, missedDoses } from './doses.ts';

const HOUR = 60 * 60 * 1000;

function dose(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    reminder_id: 12,
    scheduled_for: '2026-07-31T08:00:00+08:00',
    confirmed_at: null,
    snoozed_until: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// doseKey — the join between a server row and a device-computed alarm time
// ---------------------------------------------------------------------------

test('a dose key is reminder plus local wall-clock to the minute', () => {
  // Local components, so the assertion is about the format rather than the
  // machine's zone. Single digits must pad or a 9am dose and a 9pm one collide.
  assert.equal(doseKey(12, new Date(2026, 6, 31, 8, 0, 0)), '12@2026-07-31T08:00');
  assert.equal(doseKey(12, new Date(2026, 0, 5, 9, 5, 0)), '12@2026-01-05T09:05');
});

test('seconds are dropped, because neither side has any', () => {
  assert.equal(
    doseKey(12, new Date(2026, 6, 31, 8, 0, 47)),
    doseKey(12, new Date(2026, 6, 31, 8, 0, 0))
  );
});

test('the same instant on two reminders is two different doses', () => {
  const at = new Date('2026-07-31T08:00:00+08:00');
  assert.notEqual(doseKey(12, at), doseKey(13, at));
});

test('the offset a row is written with does not change its key', () => {
  // `scheduled_for` is an absolute instant; Postgres may hand it back in UTC or
  // with an offset. Both describe the same moment and must reduce to one key,
  // or a caregiver's escalation would be cancelled on some responses and not
  // others depending on how the row happened to serialise.
  assert.equal(
    doseKey(12, new Date('2026-07-31T08:00:00+08:00')),
    doseKey(12, new Date('2026-07-31T00:00:00Z'))
  );
});

test('an unparseable date yields no key rather than a key that matches nothing', () => {
  assert.equal(doseKey(12, new Date('not a date')), '');
});

// ---------------------------------------------------------------------------
// confirmedDoseKeys — 4.2 item 4's remaining third
// ---------------------------------------------------------------------------

test('only confirmed doses are in the set', () => {
  const morning = '2026-07-31T08:00:00+08:00';
  const evening = '2026-07-31T20:00:00+08:00';
  const keys = confirmedDoseKeys([
    dose({ id: 1, scheduled_for: morning, confirmed_at: '2026-07-31T08:02:00+08:00' }),
    dose({ id: 2, scheduled_for: evening }),
  ]);
  assert.equal(keys.has(doseKey(12, new Date(morning))), true);
  assert.equal(keys.has(doseKey(12, new Date(evening))), false, 'the evening dose is still worth escalating');
});

test('A SNOOZED DOSE IS NOT A CONFIRMED ONE', () => {
  // D-6 says a snooze re-anchors the escalation clock rather than cancelling
  // it, and D-12 caps how many times that can happen. Treating a snooze as a
  // confirmation here would remove the caregiver's alarm for a dose nobody has
  // taken — the exact failure 4.2 item 4 exists to catch.
  const keys = confirmedDoseKeys([dose({ snoozed_until: '2026-07-31T08:10:00+08:00' })]);
  assert.equal(keys.size, 0);
});

test('rows with no usable timestamp are skipped, not guessed at', () => {
  const keys = confirmedDoseKeys([
    dose({ scheduled_for: 'nonsense', confirmed_at: '2026-07-31T08:02:00+08:00' }),
    dose({ scheduled_for: undefined, confirmed_at: '2026-07-31T08:02:00+08:00' }),
  ]);
  assert.equal(keys.size, 0);
});

test('nothing at all is an empty set, not a throw', () => {
  assert.equal(confirmedDoseKeys([]).size, 0);
  assert.equal(confirmedDoseKeys(undefined as any).size, 0);
});

test('the set answers the question the scheduler actually asks', () => {
  // The scheduler holds a Date it computed from "HH:mm" and asks whether that
  // dose is done. This round trip is the whole contract between the two.
  const scheduledFor = '2026-07-31T08:00:00+08:00';
  const keys = confirmedDoseKeys([dose({ scheduled_for: scheduledFor, confirmed_at: scheduledFor })]);
  assert.equal(keys.has(doseKey(12, new Date(scheduledFor))), true);
});

// ---------------------------------------------------------------------------
// missedDoses — 5.7 / D-4
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-31T12:00:00+08:00');

test('a past unconfirmed dose is missed', () => {
  const rows = [dose({ scheduled_for: '2026-07-31T08:00:00+08:00' })];
  assert.equal(missedDoses(rows, NOW).length, 1);
});

test('a past confirmed dose is not', () => {
  const rows = [dose({ confirmed_at: '2026-07-31T08:05:00+08:00' })];
  assert.equal(missedDoses(rows, NOW).length, 0);
});

test('a future dose is not missed — D-2 means it has not happened yet', () => {
  const rows = [dose({ scheduled_for: '2026-07-31T20:00:00+08:00' })];
  assert.equal(missedDoses(rows, NOW).length, 0);
});

test('A DOSE STILL INSIDE ITS SNOOZE IS NOT MISSED', () => {
  // The patient answered the alarm and asked for it later. Listing it as missed
  // while the snooze is still running is the reprimand D-4 explicitly asks this
  // list not to be.
  const rows = [dose({
    scheduled_for: new Date(NOW.getTime() - HOUR).toISOString(),
    snoozed_until: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
  })];
  assert.equal(missedDoses(rows, NOW).length, 0);
});

test('...but it is once the snooze has run out', () => {
  const rows = [dose({
    scheduled_for: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
    snoozed_until: new Date(NOW.getTime() - HOUR).toISOString(),
  })];
  assert.equal(missedDoses(rows, NOW).length, 1);
});

test('newest first, because a record is read backwards from now', () => {
  const rows = [
    dose({ id: 1, scheduled_for: '2026-07-29T08:00:00+08:00' }),
    dose({ id: 2, scheduled_for: '2026-07-31T08:00:00+08:00' }),
    dose({ id: 3, scheduled_for: '2026-07-30T08:00:00+08:00' }),
  ];
  assert.deepEqual(missedDoses(rows, NOW).map((d) => d.id), [2, 3, 1]);
});

test('the list is capped, so a long absence is readable rather than a wall', () => {
  const rows = Array.from({ length: 40 }, (_, i) =>
    dose({ id: i, scheduled_for: new Date(NOW.getTime() - (i + 1) * HOUR).toISOString() }));
  const shown = missedDoses(rows, NOW);
  assert.equal(shown.length, 20);
  assert.equal(shown[0].id, 0, 'the cap keeps the most recent, not the oldest');
});

test('malformed rows are dropped rather than rendered blank', () => {
  const rows = [dose({ scheduled_for: 'nonsense' }), dose({ scheduled_for: undefined }), null as any];
  assert.equal(missedDoses(rows, NOW).length, 0);
});

test('a dose exactly at now is not yet missed', () => {
  const rows = [dose({ scheduled_for: NOW.toISOString() })];
  assert.equal(missedDoses(rows, NOW).length, 0);
});
