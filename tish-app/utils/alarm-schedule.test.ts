// 5.6 — tests for the alert layout. Run: npm test (node --test)
//
// The bias is toward collisions and scope, because that is where this codebase
// has actually been hurt: §0.6 records three separate bugs caused by one
// identifier meaning two different alarms, and every one of them was silent —
// scheduling onto an existing identifier replaces it without an error, and iOS
// discards an over-budget queue without one either. So most of what follows
// counts identifiers and asserts what a cancel would and would not reach.

import assert from 'node:assert/strict';
import test from 'node:test';

import { BURST_SPACING_MS, planAlarmsForReminder, planChainForward } from './alarm-schedule.ts';
import type { AlarmPlan, PlannedAlert } from './alarm-schedule.ts';
import { doseKey } from './doses.ts';
import { capacityFor, planNotificationBudget, reminderCostFor } from './notification-budget.ts';
import { belongsToReminder } from './notification-identifiers.ts';

const at = (y: number, m: number, d: number, hh: number, mm: number) =>
  new Date(y, m - 1, d, hh, mm, 0, 0);

const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

const row = (over: Record<string, any> = {}) => ({
  id: 12,
  user_id: 7,
  status: 'active',
  alarms: ['08:00', '20:00'],
  frequency_days: 1,
  alarm_repeat_count: 3,
  reminder_sound: 'default',
  escalation_enabled: false,
  escalation_delay_minutes: 30,
  ...over,
});

/** 06:00 on 2026-07-31 — before both of the fixture's slots. */
const NOW = at(2026, 7, 31, 6, 0);

const forOwner = (reminder: any, over: Record<string, any> = {}) =>
  planAlarmsForReminder(reminder, { viewerUserId: 7, platform: 'ios', now: NOW, daysAhead: 7, ...over });

/**
 * The notification payload the I/O half writes, reconstructed from a planned
 * alert. Mirrors `writeAlerts` in `notification-helper`, which is the one thing
 * on this path that cannot be imported here.
 */
const payloadFor = (plan: AlarmPlan, alert: PlannedAlert, reminder: any) => ({
  reminderId: reminder.id,
  ownerUserId: plan.ownerUserId,
  soundKey: reminder.reminder_sound,
  frequencyDays: plan.frequencyDays,
  escalationOffsetMinutes: plan.escalationOffsetMinutes,
  timeStr: alert.timeStr,
  burstIndex: alert.burstIndex,
  burstCount: alert.burstCount,
  occurrenceKey: alert.occurrenceKey,
  horizonDays: plan.horizonDays,
});

// ---------------------------------------------------------------------------
// The horizon exists at all
// ---------------------------------------------------------------------------

test('a week of a twice-daily reminder with a burst of 3 is 42 alerts', () => {
  const plan = forOwner(row());
  assert.equal(plan.horizonDays, 7);
  assert.equal(plan.burstCount, 3);
  assert.equal(plan.alerts.length, 2 * 7 * 3);
});

test('THE PROPERTY: every identifier in a plan is distinct', () => {
  // Two alerts sharing an identifier is not a duplicate, it is a *loss* — the
  // second replaces the first and the queue silently holds one alarm where the
  // plan says two. This is the failure the occurrence segment exists to stop.
  for (const freq of [1, 2, 3, 7]) {
    for (const burst of [1, 3, 6]) {
      const plan = forOwner(row({ frequency_days: freq, alarm_repeat_count: burst }));
      const ids = new Set(plan.alerts.map((a) => a.identifier));
      assert.equal(ids.size, plan.alerts.length, `freq=${freq} burst=${burst} collided`);
    }
  }
});

test('every alert is still reachable by a reminder-wide cancel', () => {
  // Reconciling from scratch, or deleting the reminder, must find all of them.
  const plan = forOwner(row());
  for (const alert of plan.alerts) {
    assert.equal(belongsToReminder(alert.identifier, 12, 7), true, alert.identifier);
    assert.equal(belongsToReminder(alert.identifier, 12), true, alert.identifier);
  }
});

test('occurrences step by frequency_days and keep the wall-clock time', () => {
  const plan = planAlarmsForReminder(row({ alarms: ['08:00'], alarm_repeat_count: 1, frequency_days: 3 }), {
    viewerUserId: 7, platform: 'ios', now: NOW, daysAhead: 7,
  });
  assert.deepEqual(plan.alerts.map((a) => fmt(a.date)), [
    '2026-07-31 08:00:00',
    '2026-08-03 08:00:00',
    '2026-08-06 08:00:00',
    '2026-08-09 08:00:00',
    '2026-08-12 08:00:00',
    '2026-08-15 08:00:00',
    '2026-08-18 08:00:00',
  ]);
});

test('D-2 still holds: nothing is ever planned in the past', () => {
  // A phone that was off all day comes back with its next alarm in the future
  // and no backlog. Scheduling several days ahead must not quietly reintroduce
  // one at the near end.
  const late = at(2026, 7, 31, 23, 59);
  for (const reminder of [row(), row({ escalation_enabled: true })]) {
    for (const viewer of [7, 9]) {
      const plan = planAlarmsForReminder(reminder, { viewerUserId: viewer, platform: 'ios', now: late, daysAhead: 7 });
      for (const alert of plan.alerts) {
        assert.ok(alert.date.getTime() > late.getTime(), `${alert.identifier} at ${fmt(alert.date)}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Scope: what a firing alarm's cancel reaches
// ---------------------------------------------------------------------------

test("answering today's alarm cancels today's burst and nothing else", () => {
  // The 5.6 version of the bug where the morning alarm deleted the evening one.
  // Without the occurrence filter this cancel would take the whole week.
  const plan = forOwner(row());
  const fired = plan.alerts.find((a) => a.timeStr === '08:00' && a.occurrence === 0)!;

  const cancelled = plan.alerts.filter((a) =>
    belongsToReminder(a.identifier, 12, 7, fired.timeStr, fired.occurrenceKey)
  );

  assert.equal(cancelled.length, 3, "only today's 08:00 burst");
  assert.ok(cancelled.every((a) => a.occurrence === 0 && a.timeStr === '08:00'));
  assert.equal(plan.alerts.length - cancelled.length, 39, 'the rest of the horizon survives');
});

test("the evening slot is untouched by the morning alarm, at every depth", () => {
  const plan = forOwner(row());
  const fired = plan.alerts.find((a) => a.timeStr === '08:00' && a.occurrence === 0)!;
  const evening = plan.alerts.filter((a) => a.timeStr === '20:00');

  assert.equal(evening.length, 21);
  for (const alert of evening) {
    assert.equal(belongsToReminder(alert.identifier, 12, 7, fired.timeStr, fired.occurrenceKey), false);
  }
});

test("one dependent's reminder is not reached by another owner's cancel", () => {
  const mine = forOwner(row({ id: 12, user_id: 7 }));
  const theirs = planAlarmsForReminder(row({ id: 12, user_id: 9, escalation_enabled: true }), {
    viewerUserId: 7, platform: 'ios', now: NOW, daysAhead: 7,
  });
  // Same reminder id on purpose: the owner segment is what separates them.
  for (const alert of theirs.alerts) {
    assert.equal(belongsToReminder(alert.identifier, 12, 7), false, alert.identifier);
  }
  for (const alert of mine.alerts) {
    assert.equal(belongsToReminder(alert.identifier, 12, 9), false, alert.identifier);
  }
});

// ---------------------------------------------------------------------------
// The burst inside an occurrence
// ---------------------------------------------------------------------------

test('burst members are 30s apart and share their occurrence key', () => {
  const plan = forOwner(row({ alarms: ['08:00'] }));
  const first = plan.alerts.filter((a) => a.occurrence === 0);

  assert.deepEqual(first.map((a) => a.burstIndex), [1, 2, 3]);
  assert.deepEqual(first.map((a) => a.date.getTime() - first[0].date.getTime()), [
    0, BURST_SPACING_MS, 2 * BURST_SPACING_MS,
  ]);
  assert.equal(new Set(first.map((a) => a.occurrenceKey)).size, 1);
});

test('a burst that crosses midnight still shares one occurrence key', () => {
  // 23:59:45 + 30s is tomorrow. Keying each member off its own time would split
  // the burst across two days, and an occurrence-scoped cancel would clear half.
  const plan = planAlarmsForReminder(row({ alarms: ['23:59'], alarm_repeat_count: 6 }), {
    viewerUserId: 7, platform: 'ios', now: at(2026, 7, 31, 23, 0), daysAhead: 2,
  });
  const first = plan.alerts.filter((a) => a.occurrence === 0);

  assert.equal(new Set(first.map((a) => a.occurrenceKey)).size, 1, 'one key for the whole burst');
  assert.ok(
    first.some((a) => a.date.getDate() !== first[0].date.getDate()),
    'the scenario must actually cross midnight, or it proves nothing'
  );
  for (const alert of first) {
    assert.equal(belongsToReminder(alert.identifier, 12, 7, '23:59', first[0].occurrenceKey), true);
  }
});

// ---------------------------------------------------------------------------
// The budget's levers reach the layout
// ---------------------------------------------------------------------------

test('the burst cap trims alerts per occurrence, not days', () => {
  const capped = forOwner(row(), { burstCap: 1 });
  assert.equal(capped.burstCount, 1);
  assert.equal(capped.alerts.length, 2 * 7);
});

test('the horizon is clamped to the server materialisation window and floored at one day', () => {
  // Holding alarms for days 5.1 has no dose rows for makes 5.7's missed list
  // disagree with what actually rang.
  assert.equal(forOwner(row(), { daysAhead: 99 }).horizonDays, 7);
  assert.equal(forOwner(row(), { daysAhead: 0 }).horizonDays, 1);
  assert.equal(forOwner(row(), { daysAhead: NaN }).horizonDays, 1);
  assert.equal(forOwner(row(), { daysAhead: undefined }).horizonDays, 1);
});

test('Android takes one alert per occurrence, and the full horizon', () => {
  const plan = planAlarmsForReminder(row(), { viewerUserId: 7, platform: 'android', now: NOW, daysAhead: 7 });
  assert.equal(plan.burstCount, 1);
  assert.equal(plan.alerts.length, 2 * 7);
});

// ---------------------------------------------------------------------------
// Who holds what (D-1, 4.2 item 4)
// ---------------------------------------------------------------------------

test('this device holds nothing for an inactive reminder', () => {
  assert.deepEqual(forOwner(row({ status: 'inactive' })).alerts, []);
  assert.deepEqual(forOwner(row({ alarms: [] })).alerts, []);
});

test("a caregiver holds nothing for a dependent's escalation-disabled reminder", () => {
  const plan = planAlarmsForReminder(row({ escalation_enabled: false }), {
    viewerUserId: 9, platform: 'ios', now: NOW, daysAhead: 7,
  });
  assert.deepEqual(plan.alerts, []);
});

test("a caregiver's copy is delayed, single, and covers the whole horizon", () => {
  const plan = planAlarmsForReminder(row({ escalation_enabled: true, escalation_delay_minutes: 45 }), {
    viewerUserId: 9, platform: 'ios', now: NOW, daysAhead: 7,
  });
  assert.equal(plan.isCaregiverCopy, true);
  assert.equal(plan.escalationOffsetMinutes, 45);
  assert.equal(plan.burstCount, 1);
  assert.equal(plan.alerts.length, 2 * 7);
  assert.equal(fmt(plan.alerts[0].date), '2026-07-31 08:45:00');
});

test('a confirmed dose removes exactly its own occurrence from the escalation', () => {
  // The check runs per occurrence rather than per slot, so day three being
  // confirmed early must not take day zero with it.
  const confirmed = new Set([doseKey(12, at(2026, 8, 2, 8, 0))]);
  const plan = planAlarmsForReminder(row({ escalation_enabled: true }), {
    viewerUserId: 9, platform: 'ios', now: NOW, daysAhead: 7, confirmedDoses: confirmed,
  });
  assert.equal(plan.alerts.length, 2 * 7 - 1);
  assert.ok(!plan.alerts.some((a) => a.timeStr === '08:00' && fmt(a.date).startsWith('2026-08-02')));
  assert.ok(plan.alerts.some((a) => a.timeStr === '08:00' && fmt(a.date).startsWith('2026-07-31')));
});

test("a confirmed dose does not suppress the patient's own alarm", () => {
  // Only a caregiver's copy can point at a dose in the past; the patient's own
  // alarm is always the next occurrence.
  const confirmed = new Set([doseKey(12, at(2026, 7, 31, 8, 0))]);
  const plan = forOwner(row(), { confirmedDoses: confirmed });
  assert.equal(plan.alerts.length, 2 * 7 * 3);
});

// ---------------------------------------------------------------------------
// A reminder with no owner degrades rather than colliding
// ---------------------------------------------------------------------------

test('no owner means one alert on one day, because the identifier cannot say otherwise', () => {
  // Without the owner segment there is nowhere to put a burst index or an
  // occurrence, so seven days would be written onto one identifier and six of
  // them would vanish.
  const plan = planAlarmsForReminder(row({ user_id: undefined }), {
    viewerUserId: 7, platform: 'ios', now: NOW, daysAhead: 7,
  });
  assert.equal(plan.horizonDays, 1);
  assert.equal(plan.burstCount, 1);
  assert.equal(plan.alerts.length, 2);
  assert.deepEqual(plan.alerts.map((a) => a.identifier), ['med-12-0800', 'med-12-2000']);
  assert.equal(new Set(plan.alerts.map((a) => a.identifier)).size, 2);
});

// ---------------------------------------------------------------------------
// The chain-forward, now a top-up
// ---------------------------------------------------------------------------

test('the chain-forward rewrites the same days the original plan already holds', () => {
  // Idempotence is what makes rewriting safe: the overlapping days resolve to
  // identical identifiers, so they are replaced by identical alerts rather than
  // duplicated or orphaned.
  const reminder = row({ alarms: ['08:00'] });
  const plan = forOwner(reminder);
  const fired = plan.alerts.find((a) => a.occurrence === 0 && a.burstIndex === 1)!;

  const next = planChainForward(payloadFor(plan, fired, reminder), { now: at(2026, 7, 31, 8, 0) });

  const before = new Set(plan.alerts.map((a) => a.identifier));
  const after = next.alerts.map((a) => a.identifier);

  assert.equal(next.alerts.length, 7 * 3, 'the same depth, measured from the next occurrence');
  assert.equal(after.filter((id) => before.has(id)).length, 6 * 3, 'days one to six are rewritten in place');
  assert.equal(after.filter((id) => !before.has(id)).length, 1 * 3, 'one new day at the far end');
});

test("the chain-forward never re-arms the occurrence that just fired", () => {
  const reminder = row({ alarms: ['08:00'] });
  const plan = forOwner(reminder);
  const fired = plan.alerts.find((a) => a.occurrence === 0 && a.burstIndex === 1)!;
  const firedAt = at(2026, 7, 31, 8, 0);

  const next = planChainForward(payloadFor(plan, fired, reminder), { now: firedAt });

  for (const alert of next.alerts) {
    assert.ok(alert.date.getTime() > firedAt.getTime(), `${alert.identifier} at ${fmt(alert.date)}`);
    assert.notEqual(alert.occurrenceKey, fired.occurrenceKey);
  }
});

test('the chain-forward repairs a gap rather than only appending to the far end', () => {
  // Three days of alarms fired with the app never running, so those occurrences
  // are gone. Rewriting covers the whole forward window; appending one far-end
  // day would leave the hole in the middle.
  const reminder = row({ alarms: ['08:00'] });
  const plan = forOwner(reminder);
  const fired = plan.alerts.find((a) => a.occurrence === 3 && a.burstIndex === 1)!;

  const next = planChainForward(payloadFor(plan, fired, reminder), { now: at(2026, 8, 3, 8, 0) });

  assert.equal(next.alerts.length, 7 * 3);
  const days = new Set(next.alerts.map((a) => a.occurrenceKey));
  assert.deepEqual(
    Array.from(days).sort(),
    ['20260804', '20260805', '20260806', '20260807', '20260808', '20260809', '20260810']
  );
});

test("the chain-forward keeps a caregiver's offset and stays a single alert", () => {
  const reminder = row({ alarms: ['08:00'], escalation_enabled: true, escalation_delay_minutes: 45 });
  const plan = planAlarmsForReminder(reminder, { viewerUserId: 9, platform: 'ios', now: NOW, daysAhead: 7 });
  const fired = plan.alerts[0];

  const next = planChainForward(payloadFor(plan, fired, reminder), { now: at(2026, 7, 31, 8, 45) });

  assert.equal(next.isCaregiverCopy, true);
  assert.equal(next.escalationOffsetMinutes, 45);
  assert.equal(next.burstCount, 1);
  assert.equal(fmt(next.alerts[0].date), '2026-08-01 08:45:00');
});

test('a payload from before 5.6 chains one occurrence, exactly as that build did', () => {
  const legacy = { reminderId: 12, ownerUserId: 7, timeStr: '08:00', frequencyDays: 1, soundKey: 'default' };
  const next = planChainForward(legacy, { now: at(2026, 7, 31, 8, 0) });

  assert.equal(next.horizonDays, 1);
  assert.equal(next.burstCount, 1, 'no burstCount either — that build wrote one alert');
  assert.equal(next.alerts.length, 1);
  assert.equal(fmt(next.alerts[0].date), '2026-08-01 08:00:00');
});

test('an incomplete payload chains nothing rather than guessing', () => {
  // A snooze alert deliberately carries no frequencyDays: chaining off it would
  // move the whole reminder onto snooze time.
  for (const bad of [
    {},
    { reminderId: 12, ownerUserId: 7, timeStr: '08:00', snoozed: true },
    { ownerUserId: 7, timeStr: '08:00', frequencyDays: 1 },
    { reminderId: 12, ownerUserId: 7, frequencyDays: 1 },
  ]) {
    assert.deepEqual(planChainForward(bad, { now: NOW }).alerts, [], JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// End to end: cost -> budget -> layout, against the cap that is never observed
// ---------------------------------------------------------------------------

test('THE PROPERTY: a device never lays out more alerts than the budget allowed', () => {
  // The budget's arithmetic and the layout's loops are written separately, so
  // this is the assertion that they agree. Overrunning is invisible: iOS keeps
  // what it likes and drops the rest without an error or a log.
  const devices = [
    [row({ id: 1 })],
    [row({ id: 1 }), row({ id: 2, alarms: ['07:00', '12:00', '19:00'] })],
    [
      row({ id: 1, alarms: ['06:00', '12:00', '18:00'], alarm_repeat_count: 6 }),
      row({ id: 2, alarms: ['08:00', '20:00'], alarm_repeat_count: 6 }),
      row({ id: 3, user_id: 9, escalation_enabled: true, alarms: ['09:00', '21:00'] }),
      row({ id: 4, user_id: 11, escalation_enabled: true, alarms: ['10:00'] }),
    ],
    // Extreme enough to force reminders to be dropped, not merely trimmed.
    [
      row({ id: 1, alarms: Array.from({ length: 20 }, (_, i) => `${String(i + 1).padStart(2, '0')}:00`) }),
      row({ id: 2, user_id: 9, escalation_enabled: true, alarms: Array.from({ length: 8 }, (_, i) => `${String(i + 1).padStart(2, '0')}:30`) }),
      row({ id: 3, user_id: 11, escalation_enabled: true, alarms: Array.from({ length: 8 }, (_, i) => `${String(i + 1).padStart(2, '0')}:45`) }),
    ],
  ];

  for (const reminders of devices) {
    const costs = reminders
      .map((r) => reminderCostFor(r, { viewerUserId: 7, platform: 'ios', now: NOW }))
      .filter((c): c is NonNullable<typeof c> => c != null);
    const budget = planNotificationBudget(costs, { platform: 'ios' });
    const dropped = new Set(budget.dropped);

    const identifiers = new Set<string>();
    for (const reminder of reminders) {
      if (dropped.has(Number(reminder.id))) continue;
      const plan = planAlarmsForReminder(reminder, {
        viewerUserId: 7,
        platform: 'ios',
        now: NOW,
        daysAhead: budget.daysAhead,
        burstCap: budget.burstCap,
      });
      for (const alert of plan.alerts) identifiers.add(alert.identifier);
    }

    assert.equal(identifiers.size, budget.projectedSlots, 'the layout must cost what the budget projected');
    assert.ok(identifiers.size <= capacityFor('ios'), `${identifiers.size} > ${capacityFor('ios')}`);
  }
});
