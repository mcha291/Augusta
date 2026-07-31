/**
 * Resolving meal-relative reminders into concrete clock times.
 *
 * The bug this fixes: the form collected "with breakfast, before dinner", the
 * API stored it, and the medications list displayed it back — but
 * `scheduleMedicationNotifications` reads only `reminder.alarms`, so no alarm
 * ever fired for a meal selection. The app confirmed a setting that did not
 * exist.
 *
 * **Where resolution happens: at save time, not at read time.** Meal selections
 * are turned into entries in `alarms[]` when the reminder is saved, so the
 * device scheduler and (later) the server-side dose materialiser both read one
 * representation and neither needs meal logic. The cost is that changing a meal
 * time requires regenerating derived alarms — see `regenerateForMealTimes`.
 *
 * `alarm_sources[]` is positionally aligned with `alarms[]` and records where
 * each entry came from, which is what keeps regeneration from overwriting times
 * the user set by hand.
 */

// Extension included deliberately. Node's type stripper resolves imports the way
// the runtime does — it does not do bundler-style extension guessing — so a bare
// './date' is unresolvable under `node --test` and this module could not be
// tested at all. Metro and tsc both accept the explicit form, so it costs
// nothing. This was the single obstacle §0.8 named to giving the client tests a
// home; it is one string.
import { toLocalTimeString } from './date.ts';

export type MealKey = 'breakfast' | 'lunch' | 'dinner' | 'bedtime';
export type MealTiming = 'before' | 'after' | 'none';

/** How far before or after a meal a dose is scheduled, in minutes. */
export const MEAL_OFFSET_MINUTES = 30;

export const MANUAL_SOURCE = 'manual';

export interface MealTimes {
  breakfast_time: string;
  lunch_time: string;
  dinner_time: string;
  bedtime_time: string;
}

/** What the profile screen starts from, and what the DB columns default to. */
export const DEFAULT_MEAL_TIMES: MealTimes = {
  breakfast_time: '08:00',
  lunch_time: '12:30',
  dinner_time: '18:30',
  bedtime_time: '22:00',
};

export interface MealSelection { enabled: boolean; timing: MealTiming }
export type MealSelections = Record<MealKey, MealSelection>;

export interface ResolvedAlarms {
  alarms: string[];
  alarm_labels: string[];
  alarm_sources: string[];
}

const MEAL_KEYS: MealKey[] = ['breakfast', 'lunch', 'dinner', 'bedtime'];

export const MEAL_TIME_COLUMN: Record<MealKey, keyof MealTimes> = {
  breakfast: 'breakfast_time',
  lunch: 'lunch_time',
  dinner: 'dinner_time',
  bedtime: 'bedtime_time',
};

/**
 * Locale keys as literals, because the i18n setup types `t()` against the key
 * union — `t('mealTypes.' + meal)` doesn't compile, and that's a feature: it
 * catches a key that exists in code but in neither locale file.
 */
export const MEAL_LABEL_KEY = {
  breakfast: 'mealTypes.breakfast',
  lunch: 'mealTypes.lunch',
  dinner: 'mealTypes.dinner',
  bedtime: 'mealTypes.bedtime',
} as const;

export const TIMING_LABEL_KEY = {
  before: 'mealTypes.before',
  after: 'mealTypes.after',
} as const;

/** `true` for a source string produced by a meal selection rather than by hand. */
export function isDerivedSource(source: string | undefined): boolean {
  return !!source && source !== MANUAL_SOURCE && source.includes(':');
}

/**
 * Parse "HH:mm" or Postgres's "HH:mm:ss" into minutes since midnight.
 * Returns null rather than throwing, so one malformed stored value can't take
 * the whole schedule down.
 */
export function parseTimeToMinutes(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes since midnight back to "HH:mm", wrapping within the day. */
export function minutesToTimeString(minutes: number): string {
  // A dose 30 minutes before an 00:15 breakfast belongs at 23:45, not at a
  // negative time — and 30 after a 23:50 bedtime belongs at 00:20.
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const mins = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/** The `alarm_sources` value for a meal selection. */
export function mealSource(meal: MealKey, timing: MealTiming): string {
  // Bedtime has no before/after in the UI — it's a single "at bedtime" toggle.
  return meal === 'bedtime' ? 'bedtime:at' : `${meal}:${timing}`;
}

/** Split a source string back into its parts, or null if it isn't a meal source. */
export function parseMealSource(source: string): { meal: MealKey; timing: 'before' | 'after' | 'at' } | null {
  if (!isDerivedSource(source)) return null;
  const [meal, timing] = source.split(':');
  if (!MEAL_KEYS.includes(meal as MealKey)) return null;
  if (!['before', 'after', 'at'].includes(timing)) return null;
  return { meal: meal as MealKey, timing: timing as 'before' | 'after' | 'at' };
}

/**
 * The clock time a single meal selection resolves to, or null if the meal time
 * on file is unusable.
 */
export function resolveMealTime(
  meal: MealKey,
  timing: MealTiming,
  mealTimes: MealTimes,
): string | null {
  const base = parseTimeToMinutes(mealTimes[MEAL_TIME_COLUMN[meal]]);
  if (base === null) return null;

  if (meal === 'bedtime') return minutesToTimeString(base);
  if (timing === 'before') return minutesToTimeString(base - MEAL_OFFSET_MINUTES);
  if (timing === 'after') return minutesToTimeString(base + MEAL_OFFSET_MINUTES);
  return minutesToTimeString(base);
}

/**
 * Combine hand-set alarms with the ones derived from meal selections into the
 * single sorted representation the scheduler reads.
 *
 * Manual entries win a tie: if a user has typed 08:30 and "after breakfast"
 * also resolves to 08:30, that is one dose, not two notifications thirty
 * seconds apart.
 */
export function buildAlarmSet({
  manualTimes,
  manualLabels,
  mealSelections,
  mealTimes,
  labelForMeal,
}: {
  manualTimes: string[];
  manualLabels: string[];
  mealSelections: MealSelections;
  mealTimes: MealTimes;
  /** Localised display label, e.g. ("dinner", "before") -> "Before dinner". */
  labelForMeal: (meal: MealKey, timing: 'before' | 'after' | 'at') => string;
}): ResolvedAlarms {
  const byTime = new Map<string, { label: string; source: string }>();

  manualTimes.forEach((time, i) => {
    const normalised = minutesToTimeString(parseTimeToMinutes(time) ?? 0);
    byTime.set(normalised, { label: manualLabels[i] ?? normalised, source: MANUAL_SOURCE });
  });

  for (const meal of MEAL_KEYS) {
    const selection = mealSelections[meal];
    if (!selection?.enabled) continue;
    if (meal !== 'bedtime' && selection.timing === 'none') continue;

    const time = resolveMealTime(meal, selection.timing, mealTimes);
    if (!time) continue;

    // Don't clobber a manual entry that already occupies this slot.
    if (byTime.get(time)?.source === MANUAL_SOURCE) continue;

    const timing = meal === 'bedtime' ? 'at' : (selection.timing as 'before' | 'after');
    byTime.set(time, { label: labelForMeal(meal, timing), source: mealSource(meal, selection.timing) });
  }

  const sorted = [...byTime.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en'));

  return {
    alarms: sorted.map(([time]) => time),
    alarm_labels: sorted.map(([, v]) => v.label),
    alarm_sources: sorted.map(([, v]) => v.source),
  };
}

/**
 * Recompute a saved reminder's derived alarms against new meal times, leaving
 * every hand-set alarm exactly where it is.
 *
 * Returns null when nothing would change, so the caller can skip the write —
 * a meal-time change shouldn't rewrite every reminder a user owns.
 */
export function regenerateForMealTimes(
  reminder: {
    alarms?: string[] | null;
    alarm_labels?: string[] | null;
    alarm_sources?: string[] | null;
    at_breakfast?: boolean; breakfast_timing?: MealTiming;
    at_lunch?: boolean; lunch_timing?: MealTiming;
    at_dinner?: boolean; dinner_timing?: MealTiming;
    at_bedtime?: boolean;
  },
  mealTimes: MealTimes,
  labelForMeal: (meal: MealKey, timing: 'before' | 'after' | 'at') => string,
): ResolvedAlarms | null {
  const alarms = reminder.alarms ?? [];
  const labels = reminder.alarm_labels ?? [];
  // Rows written before migration 001 have no sources. Everything they hold
  // was set by hand, so treat it that way rather than regenerating over it.
  const sources = reminder.alarm_sources ?? alarms.map(() => MANUAL_SOURCE);

  const manualTimes: string[] = [];
  const manualLabels: string[] = [];
  alarms.forEach((time, i) => {
    if (!isDerivedSource(sources[i])) {
      manualTimes.push(time);
      manualLabels.push(labels[i] ?? time);
    }
  });

  const next = buildAlarmSet({
    manualTimes,
    manualLabels,
    mealSelections: {
      breakfast: { enabled: !!reminder.at_breakfast, timing: reminder.breakfast_timing ?? 'none' },
      lunch: { enabled: !!reminder.at_lunch, timing: reminder.lunch_timing ?? 'none' },
      dinner: { enabled: !!reminder.at_dinner, timing: reminder.dinner_timing ?? 'none' },
      bedtime: { enabled: !!reminder.at_bedtime, timing: 'none' },
    },
    mealTimes,
    labelForMeal,
  });

  const unchanged =
    next.alarms.length === alarms.length &&
    next.alarms.every((t, i) => t === alarms[i]) &&
    next.alarm_sources.every((s, i) => s === sources[i]);

  return unchanged ? null : next;
}

/** A Date (from a time picker) as the "HH:mm" the API stores. */
export function dateToTimeString(date: Date): string {
  return toLocalTimeString(date);
}

/** "HH:mm[:ss]" to a Date today, for seeding a time picker. */
export function timeStringToDate(value: string | null | undefined, fallback = '08:00'): Date {
  const minutes = parseTimeToMinutes(value) ?? parseTimeToMinutes(fallback) ?? 0;
  const date = new Date();
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date;
}
