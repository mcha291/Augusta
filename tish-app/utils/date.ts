/**
 * Date helpers that keep local calendar dates local.
 *
 * `birth_date` is a Postgres DATE column, but the client was sending a full
 * `toISOString()`. For a UTC+8 user picking a date and signing up before 08:00
 * local, the UTC instant falls on the *previous* day, and Postgres truncates
 * to it — so the birthday was stored one day early. Format in local time and
 * send the calendar date the user actually chose.
 */
export function toLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** "HH:mm" in local time — the shape `medication_reminders.alarms` stores. */
export function toLocalTimeString(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * `days` calendar days after `date`, keeping the wall-clock time.
 *
 * 5.6 walks a reminder forward one occurrence at a time, and that arithmetic has
 * to stay on the calendar rather than on the clock. Adding `n × 86_400_000`
 * milliseconds is the obvious version and it is wrong across a daylight-saving
 * boundary: an 08:00 dose four days out would ring at 07:00 or 09:00. `setDate`
 * keeps the hour and lets the platform resolve the offset.
 *
 * **This would never show up in testing here**, which is the reason to write it
 * this way rather than after someone reports it — the app is Taipei-facing and
 * Taiwan has no DST, so the millisecond version would be correct on every device
 * the project currently has and wrong the moment one travels.
 *
 * Returns a new Date; the input is not modified.
 */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  // Same normalisation as `computeNextTriggerDate` below and for the same
  // reason: a NaN reaching `setDate` yields an Invalid Date, which becomes an
  // alarm that silently never fires.
  next.setDate(next.getDate() + (Math.trunc(Number(days)) || 0));
  return next;
}

/**
 * The next Date an alarm should fire, given a time-of-day string ("HH:mm") and
 * how many days pass between occurrences.
 *
 * Lives here rather than in `notification-helper` — which imports
 * `expo-notifications` and so cannot be loaded outside a native runtime — for the
 * same reason `notification-identifiers` does: this is the arithmetic that
 * decides *when* a medication alarm fires, and it is worth being able to exercise
 * it without a device. This module has no imports of its own, which is what lets
 * `node --test` strip the types and run it directly.
 *
 * - `fromDate` defaults to now, and represents the most recent firing (or "now"
 *   for first-time scheduling).
 * - `isFirstSchedule` controls whether *today* is allowed (when the time hasn't
 *   passed yet) or whether it must always jump forward by `frequencyDays`.
 * - `offsetMinutes` shifts the alarm after the dose time — 4.2 item 4's caregiver
 *   escalation copy. It is applied **before** the has-it-passed comparison, and
 *   that ordering is the whole point: a caregiver's device syncing at 08:05 for
 *   an 08:00 dose with a 30-minute delay should schedule today's escalation at
 *   08:30, not tomorrow's. Comparing the un-offset dose time would see 08:00 as
 *   past, roll to tomorrow, and silently drop the escalation for the dose
 *   actually in question — which is the failure this whole plan exists to remove.
 *
 * D-2 holds either way: the comparison is against the offset time, so this never
 * schedules into the past and never replays a missed dose.
 */
export function computeNextTriggerDate(
  timeStr: string,
  frequencyDays: number,
  fromDate: Date = new Date(),
  isFirstSchedule = false,
  offsetMinutes = 0
): Date {
  // `Math.max(NaN, 1)` is NaN, not 1 — so a non-numeric frequency used to flow
  // straight into `setDate` and produce an **Invalid Date**, which is then handed
  // to `scheduleNotificationAsync` as a trigger. Both current callers happen to
  // sanitise first (`parseInt(...) || 1`), so this was never reachable in
  // practice, but it is the kind of trap that only shows up as an alarm that
  // never fires. Normalise here instead, where it cannot be forgotten.
  const interval = Math.max(Math.trunc(Number(frequencyDays)) || 1, 1);

  const [hour, minute] = timeStr.split(':').map(Number);
  const next = new Date(fromDate);
  next.setHours(hour, minute, 0, 0);
  if (offsetMinutes) next.setMinutes(next.getMinutes() + offsetMinutes);

  if (isFirstSchedule) {
    // If today's slot hasn't passed yet, use today; otherwise start tomorrow.
    if (next.getTime() <= fromDate.getTime()) {
      next.setDate(next.getDate() + interval);
    }
  } else {
    // Chaining off a firing: always jump forward by the full interval.
    next.setDate(next.getDate() + interval);
  }

  return next;
}
