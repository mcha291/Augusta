/**
 * The decisions the dose retry queue makes (4.4), with none of the I/O.
 *
 * Split out for the same reason as `date.ts` and `notification-identifiers.ts`:
 * the module that actually retries has to import AsyncStorage and the API
 * client, which cannot be loaded outside a native runtime, and every rule below
 * fails *silently* when it is wrong. A queue that drops an entry it should have
 * kept loses a confirmation; one that keeps an entry it should have dropped
 * eventually records the **wrong dose**, which is worse than recording nothing.
 * The only import is the row shape, from a module that is itself dependency-free,
 * so `node --test` can strip the types and run this directly.
 */

// `import type`, not a value import: Node's type stripper runs these files
// without resolving types, and an interface imported as a value fails at load
// with "does not provide an export named".
import type { DoseRow } from './doses.ts';

export type DoseAction = 'confirm' | 'snooze';

export interface QueuedDoseAction {
  reminderId: number;
  /** Whose dose it is — the `user_id` the POST must be scoped to (D-1). */
  ownerUserId?: number;
  action: DoseAction;
  /** Snooze length in minutes. Ignored for a confirm. */
  minutes?: number;
  /** Which alarm slot rang, so a replay can name the dose it means. */
  timeStr?: string | null;
  /** When the patient actually pressed the button, not when we retry. */
  occurredAt: number;
  /**
   * When the alarm overlay appeared, device clock (TELEMETRY.md §2).
   *
   * Carried through the queue rather than recomputed, because a replay has no
   * way to know it: the overlay closed hours ago. Telemetry-only — nothing in
   * this module reads it, and no decision here may ever depend on it.
   */
  alarmShownAt?: number | null;
  attempts: number;
}

/** Enough for a long flight; beyond this the oldest entries are the least useful. */
export const MAX_QUEUE = 50;

/**
 * After this many failed replays an entry is dropped. Not a network-outage
 * budget — the flush only runs on a sync, so ten attempts is ten app opens.
 * It exists so a permanently unacceptable entry cannot be retried forever.
 */
export const MAX_ATTEMPTS = 10;

/**
 * How long each action stays worth replaying, and the two differ on purpose.
 *
 * A **confirm** is a historical record. Landing it three days late still
 * corrects the missed-dose list (5.7) and still tells a caregiver the dose was
 * taken, so it is worth carrying for a week.
 *
 * A **snooze** is a live instruction to defer escalation (D-6). Once the dose's
 * escalation has already run or been overtaken, replaying it sets
 * `snoozed_until` in the past and changes nothing except `snooze_count`, which
 * D-12 reads as evidence of repeated snoozing that never happened. Twelve hours
 * matches the server's own resolution window and is generous for something whose
 * whole purpose expires in minutes.
 */
export const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SNOOZE_TTL_MS = 12 * 60 * 60 * 1000;

export function ttlFor(action: DoseAction): number {
  return action === 'snooze' ? SNOOZE_TTL_MS : CONFIRM_TTL_MS;
}

/**
 * Whether an HTTP status is worth trying again.
 *
 * The 4xx answers are all *terminal and correct*, and treating them as failures
 * is how a queue turns a working system into an infinite loop: 404 means the
 * dose was never materialised (a reminder predating 5.1, or an alarm outside the
 * window — benign, and the existing overlay comment says so), 409 means the dose
 * was already confirmed, 400 means the request was malformed and will be
 * malformed again, and 403 means this caller has no access to that person.
 *
 * **401 is the exception, and it is the one that matters most.** An expired
 * token is exactly the failure a snooze pressed on a phone that has been asleep
 * for hours will hit, and the next sync carries a fresh session.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 401 || status === 408 || status === 429) return true;
  return status >= 500;
}

export function hasExpired(entry: QueuedDoseAction, now: number): boolean {
  return now - entry.occurredAt > ttlFor(entry.action);
}

export function isSpent(entry: QueuedDoseAction, now: number): boolean {
  return entry.attempts >= MAX_ATTEMPTS || hasExpired(entry, now);
}

/**
 * Adds an entry, collapsing a repeat of one already queued.
 *
 * Collapsing is on `(reminderId, timeStr, action)` — the same button on the same
 * dose. Two snoozes of one dose while offline are two real snoozes as far as
 * D-12 is concerned, but only the *latest* can be replayed truthfully: a replay
 * sets `snoozed_until` from the server's clock, so sending both would increment
 * `snooze_count` twice for one deferral that only ever happened once. The later
 * press wins, and its `occurredAt` is the one the dose lookup should use.
 *
 * A confirm always supersedes a queued snooze for the same dose. The patient
 * snoozed and then took it; replaying the snooze afterwards would push the
 * escalation clock forward for a dose that is already done.
 */
export function enqueue(queue: QueuedDoseAction[], entry: QueuedDoseAction): QueuedDoseAction[] {
  const sameDose = (e: QueuedDoseAction) =>
    e.reminderId === entry.reminderId && slotKey(e.timeStr) === slotKey(entry.timeStr);

  const kept = queue.filter((e) => {
    if (!sameDose(e)) return true;
    if (entry.action === 'confirm') return false;
    return e.action !== entry.action;
  });

  // Oldest first, so the trim below drops the least useful rather than the newest.
  return [...kept, entry].slice(-MAX_QUEUE);
}

function slotKey(timeStr?: string | null): string {
  return timeStr == null ? '' : String(timeStr).replace(/:/g, '').slice(0, 4);
}

/**
 * Which materialised dose a queued action meant.
 *
 * **This is why the queue is not just "POST it again later".** The immediate
 * POST sends no timestamp on purpose — the server resolves the dose nearest to
 * `now()`, which is exactly right when the patient is standing in front of a
 * ringing alarm. A replay is not standing in front of anything: retried at 15:00,
 * "nearest to now" on an 08:00/20:00 reminder is the **evening** dose, and the
 * queue would confirm a dose nobody has taken — suppressing the escalation that
 * exists to catch precisely that.
 *
 * So a replay names its dose explicitly, resolved against `occurredAt` from the
 * list the server itself materialised rather than recomputed on the device. The
 * `scheduled_for` string is passed straight back untouched, so the two sides
 * cannot disagree about timezones or seconds.
 *
 * Returns null when nothing is within `toleranceMs`, which is the honest answer:
 * a dose that cannot be identified must not be guessed at.
 */
export function pickDose(
  doses: DoseRow[],
  reminderId: number,
  occurredAt: number,
  toleranceMs: number = 12 * 60 * 60 * 1000
): DoseRow | null {
  let best: DoseRow | null = null;
  let bestDistance = Infinity;

  for (const dose of Array.isArray(doses) ? doses : []) {
    if (Number(dose?.reminder_id) !== Number(reminderId)) continue;
    const at = Date.parse(String(dose?.scheduled_for));
    if (!Number.isFinite(at)) continue;
    const distance = Math.abs(at - occurredAt);
    if (distance < bestDistance && distance <= toleranceMs) {
      best = dose;
      bestDistance = distance;
    }
  }

  return best;
}
