// 5.6 — tests for the notification budget. Run: npm test (node --test)
//
// The bias is toward the cases that fail *silently*: an over-count quietly
// shortens the horizon, and an under-count overruns the iOS cap where the OS
// discards whichever alarms it likes with no error and no log. Neither is
// visible without doing the sums by hand, which is what these do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    IOS_PENDING_CAP,
    PENDING_RESERVE,
    DEFAULT_HORIZON_DAYS,
    MIN_HORIZON_DAYS,
    capacityFor,
    planNotificationBudget,
} from './notification-budget.ts';

const own = (id: number, alarmCount: number, burstCount = 3, msUntilNext = 0) =>
    ({ id, alarmCount, burstCount, isCaregiverCopy: false, msUntilNext });

const dependent = (id: number, alarmCount: number, msUntilNext = 0) =>
    ({ id, alarmCount, burstCount: 1, isCaregiverCopy: true, msUntilNext });

const plan = (reminders: ReturnType<typeof own>[], platform = 'ios', horizonDays?: number) =>
    planNotificationBudget(reminders, { platform, horizonDays });

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

test('iOS capacity holds a reserve back from the 64-slot cap', () => {
    // 4.4's snooze is scheduled after the reconciliation pass has already filled
    // the queue. Budgeting to exactly 64 means a snooze either fails or evicts a
    // real alarm.
    assert.equal(capacityFor('ios'), IOS_PENDING_CAP - PENDING_RESERVE);
    assert.ok(PENDING_RESERVE > 0);
});

test('Android is not meaningfully capped, but takes the same code path', () => {
    assert.ok(capacityFor('android') > IOS_PENDING_CAP * 10);
    assert.equal(capacityFor('web'), capacityFor('android'));
});

// ---------------------------------------------------------------------------
// The ordinary case
// ---------------------------------------------------------------------------

test('a light schedule gets the full horizon and no truncation', () => {
    // One reminder, twice daily, burst 3 = 6 slots/day. 7 days = 42, inside 60.
    const p = plan([own(1, 2, 3)]);
    assert.equal(p.daysAhead, DEFAULT_HORIZON_DAYS);
    assert.equal(p.burstCap, null);
    assert.deepEqual(p.dropped, []);
    assert.deepEqual(p.truncations, []);
    assert.equal(p.projectedSlots, 42);
});

test('no reminders at all is not a truncation', () => {
    const p = plan([]);
    assert.equal(p.projectedSlots, 0);
    assert.deepEqual(p.truncations, []);
    assert.equal(p.daysAhead, DEFAULT_HORIZON_DAYS);
});

test('a reminder with no alarm times consumes nothing', () => {
    const p = plan([own(1, 0, 3)]);
    assert.equal(p.projectedSlots, 0);
    assert.deepEqual(p.dropped, []);
});

// ---------------------------------------------------------------------------
// Audibility before horizon — the priority rule
// ---------------------------------------------------------------------------

test("the plan's worked example: 3 meds x 3 daily x burst 3 fits two days, not seven", () => {
    // 27 slots/day. This is the number §8 uses to argue the cap is binding
    // rather than theoretical, so it is worth pinning exactly.
    const p = plan([own(1, 3, 3), own(2, 3, 3), own(3, 3, 3)]);
    assert.equal(p.projectedSlots / p.daysAhead, 27);
    assert.equal(p.daysAhead, 2);
    assert.equal(p.burstCap, null, 'the burst is kept; the horizon gives way first');
    assert.match(p.truncations[0], /horizon shortened to 2d/);
});

test('the horizon shortens before the burst is touched', () => {
    // 10 slots/day: 6 days fit, 7 do not. The burst must survive untouched --
    // an alarm slept through today is worse than one that stops on day seven.
    const p = plan([own(1, 2, 5)]);
    assert.equal(p.daysAhead, 6);
    assert.equal(p.burstCap, null);
    assert.ok(p.projectedSlots <= capacityFor('ios'));
});

test('the burst is only trimmed once the horizon is already at its floor', () => {
    // 40 slots/day: even one day of full burst is 40, two days is 80 > 60. So
    // the horizon cannot go below 2, and the burst has to give.
    const p = plan([own(1, 8, 5)]);
    assert.equal(p.daysAhead, MIN_HORIZON_DAYS);
    assert.ok(p.burstCap !== null && p.burstCap < 5);
    assert.ok(p.projectedSlots <= capacityFor('ios'));
    assert.match(p.truncations[0], /burst capped at \d+/);
});

test('the horizon never drops below two days', () => {
    // Below two the feature is what the app already did before 5.6.
    for (const alarms of [4, 8, 12, 30]) {
        const p = plan([own(1, alarms, 6)]);
        assert.ok(p.daysAhead >= MIN_HORIZON_DAYS, `alarms=${alarms} gave ${p.daysAhead}d`);
    }
});

test('the burst is capped no lower than a single alert', () => {
    const p = plan([own(1, 40, 6)]);
    assert.equal(p.burstCap, 1);
    assert.ok(p.daysAhead >= MIN_HORIZON_DAYS);
});

// ---------------------------------------------------------------------------
// The cap is never knowingly exceeded
// ---------------------------------------------------------------------------

test('no plan ever projects more slots than the platform allows', () => {
    // The property that matters most: overrunning is invisible, because iOS
    // drops the excess without erroring.
    const cap = capacityFor('ios');
    for (let alarms = 1; alarms <= 12; alarms += 1) {
        for (let burst = 1; burst <= 6; burst += 1) {
            const p = plan([own(1, alarms, burst)]);
            assert.ok(
                p.projectedSlots <= cap,
                `alarms=${alarms} burst=${burst} projected ${p.projectedSlots} > ${cap}`
            );
        }
    }
});

test('a single unschedulable reminder is kept over-budget rather than dropped', () => {
    // One over-budget alarm set beats none: iOS keeps the first 60. Dropping the
    // last reminder standing would mean a patient with one very busy medication
    // gets no alarms at all.
    const p = plan([own(1, 100, 6)]);
    assert.deepEqual(p.dropped, []);
    assert.equal(p.burstCap, 1);
});

// ---------------------------------------------------------------------------
// Whose alarms give way first (D-1)
// ---------------------------------------------------------------------------

// Reaching this stage takes a genuinely extreme schedule, and that is the point:
// dropping only happens once single alerts over two days still overrun. At burst
// 1 the budget is just (total alarm times x 2 days), so these need more than 30
// alarm times between them.

test("a dependent's escalation copy is dropped before the patient's own alarms", () => {
    // 20 + 8 + 8 = 36 slots/day at burst 1; 72 over two days against 60.
    const p = plan([own(1, 20, 3), dependent(2, 8, 60_000), dependent(3, 8, 12 * 3600_000)]);
    assert.ok(p.dropped.length > 0, 'this schedule cannot fit without dropping something');
    assert.ok(!p.dropped.includes(1), "the patient's own reminder must survive");
    assert.ok(p.projectedSlots <= capacityFor('ios'));
});

test('among dependents, the soonest dose survives', () => {
    const soon = dependent(2, 8, 60 * 1000);
    const later = dependent(3, 8, 12 * 60 * 60 * 1000);
    const p = plan([own(1, 20, 3), soon, later]);
    assert.ok(p.dropped.length > 0, 'the scenario must actually force a drop');
    assert.ok(p.dropped.includes(3), 'the furthest-away dose is dropped first');
    assert.ok(!p.dropped.includes(2), 'the soonest dose is kept');
});

test('dropping stops as soon as the plan fits, rather than clearing the list', () => {
    // 22 + 4 + 4 + 4 = 34/day at burst 1, 68 over two days. Dropping one
    // dependent gets to 60 exactly, so the other two must survive.
    const p = plan([
        own(1, 22, 3),
        dependent(2, 4, 1000),
        dependent(3, 4, 2000),
        dependent(4, 4, 3000),
    ]);
    assert.ok(p.projectedSlots <= capacityFor('ios'));
    assert.equal(p.dropped.length, 1, 'must not drop more than the budget requires');
    assert.deepEqual(p.dropped, [4], 'the furthest-away dependent is the one to go');
});

// ---------------------------------------------------------------------------
// Truncations are always reported
// ---------------------------------------------------------------------------

test('every degradation is recorded, because a silent one is the failure mode', () => {
    const squeezed = plan([own(1, 10, 5), dependent(2, 6)]);
    assert.ok(squeezed.truncations.length > 0);
    for (const line of squeezed.truncations) assert.ok(line.length > 0);
});

test('a plan that fits reports nothing, so the log stays meaningful', () => {
    assert.deepEqual(plan([own(1, 1, 1)]).truncations, []);
});

test('a truncation names the numbers behind it, not just that one happened', () => {
    // "horizon shortened" with no figures is not actionable at 3am.
    const p = plan([own(1, 3, 3), own(2, 3, 3), own(3, 3, 3)]);
    assert.match(p.truncations[0], /\d+ slots\/day/);
    assert.match(p.truncations[0], new RegExp(String(capacityFor('ios'))));
});

// ---------------------------------------------------------------------------
// Android
// ---------------------------------------------------------------------------

test('Android gets the full horizon even where iOS would be squeezed', () => {
    // Not because the budget is skipped, but because the capacity is real. D-10
    // already forces burst 1 on Android; the caller applies that, not this.
    const heavy = [own(1, 10, 1), own(2, 10, 1), dependent(3, 6)];
    assert.equal(plan(heavy, 'android').daysAhead, DEFAULT_HORIZON_DAYS);
    assert.deepEqual(plan(heavy, 'android').truncations, []);
    assert.ok(plan(heavy, 'ios').daysAhead < DEFAULT_HORIZON_DAYS);
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

test('malformed counts degrade to something schedulable rather than NaN', () => {
    // The same shape as the Math.max(NaN, 1) trap in §0.6: a NaN reaching a
    // trigger date produces an alarm that silently never fires.
    const p = planNotificationBudget(
        [{ id: 1, alarmCount: NaN, burstCount: NaN, isCaregiverCopy: false }],
        { platform: 'ios' }
    );
    assert.ok(Number.isInteger(p.daysAhead));
    assert.ok(Number.isInteger(p.projectedSlots));
    assert.ok(p.daysAhead >= 1);
});

test('a nonsense horizon falls back to the default rather than scheduling zero days', () => {
    assert.equal(plan([own(1, 1, 1)], 'ios', NaN).daysAhead, DEFAULT_HORIZON_DAYS);
    assert.equal(plan([own(1, 1, 1)], 'ios', 0).daysAhead, DEFAULT_HORIZON_DAYS);
    assert.ok(plan([own(1, 1, 1)], 'ios', -5).daysAhead >= 1);
});

test('the horizon matches the server-side materialisation window', () => {
    // 5.1 materialises DOSE_HORIZON_DAYS = 7 ahead. If these drift, the device
    // holds alarms for doses the server has no row for, or vice versa, and 5.7's
    // missed list disagrees with what actually rang.
    assert.equal(DEFAULT_HORIZON_DAYS, 7);
});
