/**
 * 4.4 — the dose action that could not reach the server, kept until it can.
 *
 * **Why this exists rather than a `.catch(console.warn)`.** Under D-6 a snooze
 * is what defers caregiver escalation, so a snooze that never lands escalates to
 * the caregiver anyway. That is the correct direction to fail in — it errs
 * toward notifying — but it means the patient pressing snooze on a phone with no
 * signal quietly pages someone. A confirm is worse in the other direction: 4.2
 * item 4 cancels the caregiver's escalation alarm on the strength of a
 * confirmation, so a dropped confirm rings a caregiver about a dose that was
 * taken on time, which is exactly the desensitisation D-1 depends on not
 * happening.
 *
 * The rules live in `dose-queue-policy.ts`, which has no imports and is unit
 * tested. This file is the part that touches storage and the network.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { apiRequest } from './api';
import {
  enqueue as enqueueInto,
  isRetryableStatus,
  isSpent,
  pickDose,
} from './dose-queue-policy';
import type { QueuedDoseAction } from './dose-queue-policy';
import type { DoseRow } from './doses';

const QUEUE_KEY = 'dose-queue.v1';

async function readQueue(): Promise<QueuedDoseAction[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedDoseAction[]) : [];
  } catch {
    // A corrupt or unreadable queue must not cost the alarm path anything.
    return [];
  }
}

async function writeQueue(queue: QueuedDoseAction[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch (e) {
    console.warn('[dose-queue] could not persist the queue', e);
  }
}

export interface DoseActionRequest {
  reminderId: number;
  ownerUserId?: number;
  action: 'confirm' | 'snooze';
  minutes?: number;
  timeStr?: string | null;
  /**
   * When the button was actually pressed, device clock. Defaults to now, which
   * is right for every caller that is not replaying something.
   */
  occurredAt?: number;
  /** When the alarm overlay appeared, device clock (TELEMETRY.md §2). */
  alarmShownAt?: number | null;
}

/**
 * The two device timestamps metric 2 needs, as the server expects them.
 *
 * **Telemetry-only, and the server treats them as such**: it clamps both on
 * write and drops anything a wrong clock makes impossible. Nothing about the
 * dose action depends on them, which is why they are appended to a body rather
 * than threaded through the resolution logic — a build that omits them records
 * exactly the same dose.
 */
function timingFields(occurredAt: number, alarmShownAt?: number | null) {
  return {
    occurred_at: new Date(occurredAt).toISOString(),
    ...(Number.isFinite(Number(alarmShownAt))
      ? { alarm_shown_at: new Date(Number(alarmShownAt)).toISOString() }
      : {}),
  };
}

/**
 * Records a dose action, queueing it for the next sync if it cannot be sent now.
 *
 * **Never throws and never awaits anything the UI is waiting on.** The overlay
 * calls this as the patient presses a button on a ringing alarm; the screen has
 * to close on the press, because an alarm that appears to ignore a press is how
 * someone ends up pressing everything.
 *
 * The immediate POST deliberately sends no timestamp — the server resolves the
 * dose nearest to `now()`, and right now that is the dose that is ringing. Only
 * the *replay* names a dose explicitly; see `pickDose` for why the two differ.
 */
export async function recordDoseAction(request: DoseActionRequest): Promise<void> {
  // Supplied by the alarm overlay, which stamps it at the press. Falling back
  // to now covers every other caller and is exactly what this used to do.
  const occurredAt = Number.isFinite(Number(request.occurredAt))
    ? Number(request.occurredAt)
    : Date.now();

  try {
    const res = await apiRequest('/medication-doses', {
      method: 'POST',
      body: {
        reminder_id: Number(request.reminderId),
        action: request.action,
        ...(request.action === 'snooze' && request.minutes ? { minutes: request.minutes } : {}),
        // TELEMETRY.md §2. Note this is *not* the `scheduled_for` the comment
        // above rules out: it says when the button was pressed, not which dose
        // was meant, and the server still resolves the dose from the reminder
        // and its own clock exactly as before.
        ...timingFields(occurredAt, request.alarmShownAt),
      },
    }, request.ownerUserId);

    if (res.ok) return;

    if (!isRetryableStatus(res.status)) {
      // Terminal and, in the common case, benign: a 404 means the reminder
      // predates 5.1 or the alarm fired outside the materialised window. The
      // dose was still taken; there is nothing the patient could do about it.
      console.warn('[dose-queue] dose not recorded:', res.status, request.action);
      return;
    }
    console.warn('[dose-queue] queued after', res.status, '—', request.action);
  } catch (e) {
    console.warn('[dose-queue] queued after a network failure —', request.action, e);
  }

  await queueAction(request, occurredAt);
}

async function queueAction(request: DoseActionRequest, occurredAt: number): Promise<void> {
  const queue = await readQueue();
  await writeQueue(enqueueInto(queue, {
    reminderId: Number(request.reminderId),
    ownerUserId: request.ownerUserId,
    action: request.action,
    minutes: request.minutes,
    timeStr: request.timeStr ?? null,
    occurredAt,
    alarmShownAt: request.alarmShownAt ?? null,
    attempts: 0,
  }));
}

/**
 * Replays whatever is queued. Called from the notification re-sync (4.1), which
 * is the "next sync" 4.4 asks for — it runs at launch and whenever the
 * medications screen is focused.
 *
 * Serialised on a module-level promise rather than per-caller, because the
 * re-sync runs once *per owner* on a caregiver's device while the queue is
 * global. Overlapping flushes would replay the same entry twice.
 */
let inFlight: Promise<void> | null = null;

export async function flushDoseQueue(): Promise<void> {
  if (inFlight) return inFlight;
  const run = flushOnce().finally(() => { inFlight = null; });
  inFlight = run;
  return run;
}

async function flushOnce(): Promise<void> {
  const batch = await readQueue();
  if (batch.length === 0) return;

  const now = Date.now();
  const remaining: QueuedDoseAction[] = [];

  for (const entry of batch) {
    if (isSpent(entry, now)) {
      // Loud, because this is a dose action that never reached the server. For
      // a snooze the consequence is a caregiver escalated for a dose the patient
      // actually answered; for a confirm it is a dose that stays on the missed
      // list. Neither is recoverable from here, and both should be visible.
      console.warn('[dose-queue] giving up on', entry.action, 'for reminder', entry.reminderId,
        `(${entry.attempts} attempts, queued ${Math.round((now - entry.occurredAt) / 60000)}m ago)`);
      continue;
    }

    const outcome = await replay(entry);
    if (outcome === 'retry') remaining.push({ ...entry, attempts: entry.attempts + 1 });
  }

  // **Re-read before writing, or a press during the flush is silently lost.**
  // A replay is several round trips long, and the patient can answer an alarm
  // in the middle of one — the launch re-sync and a ringing alarm overlap
  // routinely. Writing `remaining` alone would clobber whatever
  // `recordDoseAction` queued after the batch was read, which is precisely the
  // entry this module exists to keep.
  const current = await readQueue();
  const inBatch = new Set(batch.map(identity));
  await writeQueue([...remaining, ...current.filter((e) => !inBatch.has(identity(e)))]);
}

/** Enough to recognise an entry across a JSON round trip; there is no id. */
function identity(entry: QueuedDoseAction): string {
  return `${entry.reminderId}|${entry.timeStr ?? ''}|${entry.action}|${entry.occurredAt}`;
}

async function replay(entry: QueuedDoseAction): Promise<'done' | 'retry'> {
  try {
    const dose = await resolveDose(entry);
    if (dose === 'unavailable') return 'retry';
    if (!dose) {
      // The window came back and this reminder had nothing in it. Either the
      // reminder was deleted (its doses cascade with it) or the dose was never
      // materialised. Retrying cannot change either, so stop.
      console.warn('[dose-queue] no dose matches the queued', entry.action, 'for reminder', entry.reminderId);
      return 'done';
    }

    const res = await apiRequest('/medication-doses', {
      method: 'POST',
      body: {
        reminder_id: Number(entry.reminderId),
        action: entry.action,
        // Passed back exactly as the server wrote it, never reformatted — the
        // lookup matches on equality.
        scheduled_for: dose.scheduled_for,
        ...(entry.action === 'snooze' && entry.minutes ? { minutes: entry.minutes } : {}),
        // TELEMETRY.md §2 — **this is the case the whole change exists for.**
        // A confirm pressed offline and replayed at the next launch lands in
        // `confirmed_at` hours late; without these two the metric would report
        // that lag as the patient's reaction time, and would report it worst
        // for exactly the patients whose connectivity is worst.
        ...timingFields(entry.occurredAt, entry.alarmShownAt),
      },
    }, entry.ownerUserId);

    if (res.ok) return 'done';
    if (!isRetryableStatus(res.status)) {
      console.warn('[dose-queue] dropping', entry.action, 'after', res.status);
      return 'done';
    }
    return 'retry';
  } catch (e) {
    console.warn('[dose-queue] replay failed', e);
    return 'retry';
  }
}

/**
 * Asks the server which doses exist around the moment the button was pressed,
 * and picks the one the patient meant.
 *
 * Distinguishes "the list says there is no such dose" from "the list could not
 * be fetched", because they need opposite answers: the first is terminal, the
 * second must be retried. Collapsing them would either drop a confirmation on a
 * flaky connection or retry a deleted reminder until the attempt cap.
 */
async function resolveDose(entry: QueuedDoseAction): Promise<DoseRow | null | 'unavailable'> {
  const halfWindow = 12 * 60 * 60 * 1000;
  const from = new Date(entry.occurredAt - halfWindow).toISOString();
  const to = new Date(entry.occurredAt + halfWindow).toISOString();

  const res = await apiRequest(
    `/medication-doses?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    {},
    entry.ownerUserId
  );
  // A 403 or a 404 on the *list* is as terminal as one on the write — the
  // caregiver link was revoked, or the person no longer exists. Only the
  // retryable statuses mean "ask again later".
  if (!res.ok) return isRetryableStatus(res.status) ? 'unavailable' : null;

  const rows = await res.json();
  if (!Array.isArray(rows)) return 'unavailable';

  return pickDose(rows, entry.reminderId, entry.occurredAt);
}
