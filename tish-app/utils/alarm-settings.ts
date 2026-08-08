/**
 * The snooze length migration 008 added, normalised in one place.
 *
 * **Why a module rather than a clamp at each use site.** The value travels a
 * long way from the row that holds it: server → reminder row → notification
 * payload → OS queue → (days later) the fired alert → the overlay → back to the
 * server on the snooze POST. The payload hop is the dangerous one — it is JSON
 * written into the OS queue at schedule time, so an alarm scheduled by an older
 * build carries no `snoozeMinutes` at all and reads as `undefined` on arrival. A
 * clamp written separately at each end is how the two ends come to disagree, and
 * this codebase has already been bitten three times by exactly that shape (§0.6).
 *
 * Dependency-free for the same reason `notification-budget`, `dose-queue-policy`
 * and `escalation-policy` are: **this rule fails silently in production.** A
 * snooze that normalises wrong re-arms the alarm at a time the server's
 * escalation clock does not agree with, so a caregiver is paged about a dose the
 * patient is about to be reminded of. It does not throw, it does not log, and it
 * is not visible without doing the sums by hand — so it lives somewhere
 * `node --test` can reach without a native runtime.
 *
 * The bounds mirror migration 008's CHECK constraint and the API's validation.
 * Three copies of a rule is two too many, but the other two are a database
 * constraint and a 400 response, and neither can be imported here.
 */

/** Migration 008's column default, and the constant it replaced. */
export const DEFAULT_SNOOZE_MINUTES = 10;

/** Migration 008: `CHECK (snooze_minutes BETWEEN 1 AND 120)`. */
export const SNOOZE_MINUTES_MIN = 1;
export const SNOOZE_MINUTES_MAX = 120;

/**
 * How long a snooze defers the alarm, in minutes.
 *
 * Anything unusable — missing, malformed, zero, negative — becomes the default
 * rather than being passed through or floored to the minimum. Zero is the case
 * worth naming: a zero-minute snooze is not a snooze, it is an alarm that
 * re-rings immediately, and 1 would be barely better. Ten is what the server
 * also falls back to, and the two must agree or the device re-arms at one time
 * while `snoozed_until` records another.
 */
export function snoozeMinutesFor(value: unknown): number {
    const minutes = Math.trunc(Number(value));
    if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_SNOOZE_MINUTES;
    return Math.min(Math.max(minutes, SNOOZE_MINUTES_MIN), SNOOZE_MINUTES_MAX);
}
