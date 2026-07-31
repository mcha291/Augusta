/**
 * Reading the materialised dose rows `GET /medication-doses` returns (5.1).
 *
 * Two callers with opposite needs share this: 4.2 item 4 asks "has this dose
 * already been confirmed, so the caregiver's escalation alarm should not be
 * scheduled at all", and 5.7 asks "which doses are in the past and were never
 * confirmed". Both are pure functions over the same rows, so both live here and
 * are tested — dependency-free, like `date.ts`, so `node --test` can strip the
 * types and run it directly.
 */

export interface DoseRow {
  id?: number;
  reminder_id?: number | string;
  user_id?: number | string;
  /** ISO 8601 with an offset, straight from a Postgres `timestamptz`. */
  scheduled_for?: string;
  confirmed_at?: string | null;
  confirmed_by?: number | null;
  snoozed_until?: string | null;
  snooze_count?: number;
  med_name?: string | null;
  selected_dosage?: string | null;
}

/**
 * A dose reduced to "which reminder, which minute" in the device's local time.
 *
 * Minute granularity, not millisecond: the device computes an alarm time from
 * an `HH:mm` string with the seconds zeroed, and the server materialises on the
 * minute too, so the two agree exactly at this resolution and would compare
 * unequal at any finer one.
 *
 * **Local time on both sides is what makes this work at all.** `scheduled_for`
 * is an absolute instant, so parsing it and formatting in the device's own zone
 * gives the wall-clock the patient sees. It matches only while the device agrees
 * with `APP_TIMEZONE` — see §0.6, which records that the server's zone is a
 * constant rather than a `users.timezone` column. A patient who travels gets no
 * match, which fails toward scheduling the caregiver's escalation rather than
 * suppressing it, and that is the right direction.
 */
export function doseKey(reminderId: number | string, at: Date): string {
  if (!Number.isFinite(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + `T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `${Number(reminderId)}@${stamp}`;
}

/**
 * 4.2 item 4's missing half: the doses a caregiver's device must *not* hold an
 * escalation alarm for.
 *
 * Confirmed only. A snoozed-but-unconfirmed dose stays in the set of things
 * worth escalating — D-6 says a snooze re-anchors the escalation clock rather
 * than cancelling it, and D-12 caps how many times that can happen. Honouring
 * the re-anchor on the device would mean mirroring D-12's threshold here; the
 * server-side job (5.4) is where that belongs, so the device errs toward
 * alarming, which is the correct failure direction.
 */
export function confirmedDoseKeys(rows: DoseRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.confirmed_at) continue;
    const at = new Date(String(row.scheduled_for));
    if (!Number.isFinite(at.getTime())) continue;
    keys.add(doseKey(Number(row.reminder_id), at));
  }
  return keys;
}

/**
 * 5.7 / D-4 — doses whose time has passed with no confirmation.
 *
 * Newest first, because a list read as a record is scanned from the most recent
 * backwards, and capped so a patient returning from a long absence gets a
 * readable list rather than a wall.
 *
 * **A snoozed dose is not yet missed** while its snooze is still running: the
 * patient has answered the alarm and asked for it later, and showing it as
 * missed in that window would be wrong in the one way D-4 explicitly warns
 * against — it should read as a record, not a reprimand.
 *
 * The horizon caveat from §0.6 applies and cannot be fixed here: the server
 * materialises its window anchored on today, which is exact for
 * `frequency_days = 1` and only approximate for longer intervals, so a
 * three-day reminder can show a dose on a day the device never alarmed. Trust
 * this list for daily reminders until a reminder anchor date exists.
 */
export function missedDoses(rows: DoseRow[], now: Date = new Date(), limit = 20): DoseRow[] {
  const cutoff = now.getTime();

  return (Array.isArray(rows) ? rows : [])
    .filter((row) => {
      if (!row || row.confirmed_at) return false;
      const at = Date.parse(String(row.scheduled_for));
      if (!Number.isFinite(at) || at >= cutoff) return false;
      const snoozedUntil = row.snoozed_until ? Date.parse(String(row.snoozed_until)) : NaN;
      return !(Number.isFinite(snoozedUntil) && snoozedUntil > cutoff);
    })
    .sort((a, b) => Date.parse(String(b.scheduled_for)) - Date.parse(String(a.scheduled_for)))
    .slice(0, limit);
}
