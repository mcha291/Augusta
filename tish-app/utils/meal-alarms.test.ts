/**
 * Tests for meal-relative alarm resolution (4.8).
 *
 * The bug 4.8 fixed was the most user-deceiving one in the plan: the form
 * collected "with breakfast, before dinner", the API stored it, the medications
 * list displayed it back, and no alarm ever fired — because the scheduler reads
 * only `alarms[]`. These cover the resolution that closed that gap, and in
 * particular the three things most likely to break it again: the day-boundary
 * wrap, manual entries winning a collision, and pre-migration rows that carry no
 * `alarm_sources` at all.
 *
 * Run with `npm test` from `tish-app/`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MEAL_TIMES,
  MANUAL_SOURCE,
  MEAL_OFFSET_MINUTES,
  buildAlarmSet,
  isDerivedSource,
  mealSource,
  minutesToTimeString,
  parseMealSource,
  parseTimeToMinutes,
  regenerateForMealTimes,
  resolveMealTime,
  timeStringToDate,
  type MealKey,
  type MealSelections,
  type MealTimes,
} from './meal-alarms.ts';

/** Stand-in for the i18n lookup the real callers pass in. */
const labelForMeal = (meal: MealKey, timing: 'before' | 'after' | 'at') => `${timing} ${meal}`;

const noMeals: MealSelections = {
  breakfast: { enabled: false, timing: 'none' },
  lunch: { enabled: false, timing: 'none' },
  dinner: { enabled: false, timing: 'none' },
  bedtime: { enabled: false, timing: 'none' },
};

const meals = (over: Partial<MealSelections>): MealSelections => ({ ...noMeals, ...over });

// ---------------------------------------------------------------------------
// Time parsing — one malformed stored value must not take a schedule down
// ---------------------------------------------------------------------------

test('parses both the form shape and the Postgres shape', () => {
  assert.equal(parseTimeToMinutes('08:00'), 480);
  assert.equal(parseTimeToMinutes('08:00:00'), 480, 'Postgres TIME renders with seconds');
  assert.equal(parseTimeToMinutes(' 23:59 '), 1439);
});

test('rejects nonsense rather than throwing', () => {
  for (const bad of ['', 'abc', '24:00', '12:60', '8', null, undefined, 480 as any]) {
    assert.equal(parseTimeToMinutes(bad as any), null, String(bad));
  }
});

// ---------------------------------------------------------------------------
// The day-boundary wrap
// ---------------------------------------------------------------------------

test('30 minutes before an early breakfast wraps to the previous evening, not a negative time', () => {
  assert.equal(minutesToTimeString(0 - MEAL_OFFSET_MINUTES), '23:30');
  assert.equal(resolveMealTime('breakfast', 'before', { ...DEFAULT_MEAL_TIMES, breakfast_time: '00:15' }), '23:45');
});

test('30 minutes after a late bedtime wraps into the small hours', () => {
  assert.equal(minutesToTimeString(1439 + MEAL_OFFSET_MINUTES), '00:29');
  assert.equal(resolveMealTime('dinner', 'after', { ...DEFAULT_MEAL_TIMES, dinner_time: '23:50' }), '00:20');
});

test('bedtime has no before/after — it resolves to the time itself', () => {
  assert.equal(resolveMealTime('bedtime', 'before', DEFAULT_MEAL_TIMES), '22:00');
  assert.equal(resolveMealTime('bedtime', 'after', DEFAULT_MEAL_TIMES), '22:00');
});

test('an unusable stored meal time resolves to null instead of a wrong alarm', () => {
  assert.equal(resolveMealTime('lunch', 'after', { ...DEFAULT_MEAL_TIMES, lunch_time: 'not a time' } as MealTimes), null);
});

// ---------------------------------------------------------------------------
// Source strings
// ---------------------------------------------------------------------------

test('a meal source round-trips, and manual is not one', () => {
  assert.equal(mealSource('dinner', 'before'), 'dinner:before');
  assert.equal(mealSource('bedtime', 'none'), 'bedtime:at', 'bedtime is a single toggle');
  assert.deepEqual(parseMealSource('dinner:before'), { meal: 'dinner', timing: 'before' });
  assert.equal(parseMealSource(MANUAL_SOURCE), null);
  assert.equal(isDerivedSource(MANUAL_SOURCE), false);
  assert.equal(isDerivedSource(undefined), false);
});

test('a source that looks structured but is not a meal is rejected', () => {
  assert.equal(parseMealSource('brunch:after'), null);
  assert.equal(parseMealSource('dinner:whenever'), null);
});

// ---------------------------------------------------------------------------
// buildAlarmSet
// ---------------------------------------------------------------------------

test('meal selections become real alarm times, sorted', () => {
  const out = buildAlarmSet({
    manualTimes: [],
    manualLabels: [],
    mealSelections: meals({
      dinner: { enabled: true, timing: 'before' },
      breakfast: { enabled: true, timing: 'after' },
    }),
    mealTimes: DEFAULT_MEAL_TIMES,
    labelForMeal,
  });
  assert.deepEqual(out.alarms, ['08:30', '18:00']);
  assert.deepEqual(out.alarm_sources, ['breakfast:after', 'dinner:before']);
  assert.deepEqual(out.alarm_labels, ['after breakfast', 'before dinner']);
});

test('an enabled meal with timing "none" contributes nothing', () => {
  const out = buildAlarmSet({
    manualTimes: [],
    manualLabels: [],
    mealSelections: meals({ lunch: { enabled: true, timing: 'none' } }),
    mealTimes: DEFAULT_MEAL_TIMES,
    labelForMeal,
  });
  assert.deepEqual(out.alarms, []);
});

test('THE COLLISION: a manual alarm wins over a meal resolving to the same minute', () => {
  // Otherwise one dose becomes two notifications seconds apart.
  const out = buildAlarmSet({
    manualTimes: ['08:30'],
    manualLabels: ['Morning pill'],
    mealSelections: meals({ breakfast: { enabled: true, timing: 'after' } }),
    mealTimes: DEFAULT_MEAL_TIMES,
    labelForMeal,
  });
  assert.deepEqual(out.alarms, ['08:30']);
  assert.deepEqual(out.alarm_sources, [MANUAL_SOURCE]);
  assert.deepEqual(out.alarm_labels, ['Morning pill'], 'the label the user typed survives');
});

test('the three arrays stay positionally aligned, which everything downstream assumes', () => {
  const out = buildAlarmSet({
    manualTimes: ['21:00', '06:15'],
    manualLabels: ['Night', 'Dawn'],
    mealSelections: meals({
      lunch: { enabled: true, timing: 'before' },
      bedtime: { enabled: true, timing: 'none' },
    }),
    mealTimes: DEFAULT_MEAL_TIMES,
    labelForMeal,
  });
  assert.equal(out.alarms.length, out.alarm_labels.length);
  assert.equal(out.alarms.length, out.alarm_sources.length);
  assert.deepEqual(out.alarms, [...out.alarms].sort(), 'sorted, so the index means the same thing everywhere');
  assert.deepEqual(out.alarms, ['06:15', '12:00', '21:00', '22:00']);
});

// ---------------------------------------------------------------------------
// regenerateForMealTimes — the half that is easy to forget
// ---------------------------------------------------------------------------

test('moving a meal time moves the alarm derived from it', () => {
  const next = regenerateForMealTimes(
    {
      alarms: ['08:30'],
      alarm_labels: ['after breakfast'],
      alarm_sources: ['breakfast:after'],
      at_breakfast: true,
      breakfast_timing: 'after',
    },
    { ...DEFAULT_MEAL_TIMES, breakfast_time: '09:00' },
    labelForMeal
  );
  assert.deepEqual(next?.alarms, ['09:30']);
});

test('regeneration never overwrites a hand-set alarm', () => {
  const next = regenerateForMealTimes(
    {
      alarms: ['07:00', '08:30'],
      alarm_labels: ['Manual', 'after breakfast'],
      alarm_sources: [MANUAL_SOURCE, 'breakfast:after'],
      at_breakfast: true,
      breakfast_timing: 'after',
    },
    { ...DEFAULT_MEAL_TIMES, breakfast_time: '10:00' },
    labelForMeal
  );
  assert.deepEqual(next?.alarms, ['07:00', '10:30']);
  assert.deepEqual(next?.alarm_sources, [MANUAL_SOURCE, 'breakfast:after']);
  assert.equal(next?.alarm_labels[0], 'Manual');
});

test('nothing to change returns null, so a meal-time edit does not rewrite every reminder', () => {
  const unchanged = regenerateForMealTimes(
    {
      alarms: ['08:30'],
      alarm_labels: ['after breakfast'],
      alarm_sources: ['breakfast:after'],
      at_breakfast: true,
      breakfast_timing: 'after',
    },
    DEFAULT_MEAL_TIMES,
    labelForMeal
  );
  assert.equal(unchanged, null);
});

test('PRE-MIGRATION ROWS: no alarm_sources means everything is treated as manual', () => {
  // Rows written before migration 001 have no sources column populated.
  // Everything they hold was set by hand, so regeneration must not claim any of
  // it — otherwise a meal-time change silently rewrites times a user chose.
  const next = regenerateForMealTimes(
    {
      alarms: ['08:30'],
      alarm_labels: ['Morning'],
      alarm_sources: null,
      at_breakfast: true,
      breakfast_timing: 'after',
    },
    { ...DEFAULT_MEAL_TIMES, breakfast_time: '11:00' },
    labelForMeal
  );
  // 08:30 survives untouched as manual, and the meal adds 11:30 alongside it.
  assert.deepEqual(next?.alarms, ['08:30', '11:30']);
  assert.equal(next?.alarm_sources[0], MANUAL_SOURCE);
  assert.equal(next?.alarm_labels[0], 'Morning');
});

test('a reminder with no alarms at all does not throw', () => {
  const next = regenerateForMealTimes({}, DEFAULT_MEAL_TIMES, labelForMeal);
  assert.equal(next, null);
});

test('switching a meal off removes only its derived alarm', () => {
  const next = regenerateForMealTimes(
    {
      alarms: ['07:00', '08:30'],
      alarm_labels: ['Manual', 'after breakfast'],
      alarm_sources: [MANUAL_SOURCE, 'breakfast:after'],
      at_breakfast: false,
    },
    DEFAULT_MEAL_TIMES,
    labelForMeal
  );
  assert.deepEqual(next?.alarms, ['07:00']);
});

// ---------------------------------------------------------------------------
// Picker helpers
// ---------------------------------------------------------------------------

test('timeStringToDate seeds a picker in local time and falls back rather than throwing', () => {
  const d = timeStringToDate('18:45');
  assert.equal(d.getHours(), 18);
  assert.equal(d.getMinutes(), 45);

  const fallback = timeStringToDate('nonsense');
  assert.equal(fallback.getHours(), 8);
  assert.equal(fallback.getMinutes(), 0);
});
