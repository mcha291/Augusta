import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';

import { apiRequest } from '@/utils/api';
import { flushDoseQueue } from '@/utils/dose-queue';
import type { DoseRow } from '@/utils/doses';
import { planNotificationBudget, reminderCostFor } from '@/utils/notification-budget';
import type { BudgetPlan, ReminderCost } from '@/utils/notification-budget';
import { rememberBudgetPlan, scheduleMedicationNotifications } from '@/utils/notification-helper';
import { cacheReminders } from '@/utils/reminder-store';

/**
 * How far back the dose window reaches. A caregiver's escalation copy is only
 * ever scheduled for the *next* occurrence of each slot, so yesterday is more
 * than enough history to answer "was that one confirmed" — and keeping the
 * window small keeps the response small, since this runs on every launch.
 */
const DOSE_WINDOW_BACK_MS = 24 * 60 * 60 * 1000;
/** Forward far enough to cover the whole horizon 5.6 now schedules. */
const DOSE_WINDOW_FORWARD_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * What each owner's reminders cost this device, as of the last time they were
 * fetched (5.6).
 *
 * **The budget is device-wide and the sync is per-owner, which is the whole
 * reason this exists.** `syncOwners` from app launch does see every owner at
 * once, but `syncFor` from the medications screen sees exactly one — and on a
 * caregiver's device, budgeting a dependent's set as though it were alone on the
 * phone is how you overrun the iOS cap without noticing. Holding the last-known
 * cost of the owners *not* in this pass keeps the arithmetic honest.
 *
 * Two properties worth stating, because both look like bugs otherwise:
 *
 * - The entries for owners not in this pass are stale. They are stale in the
 *   *cost* dimension only — how many alarm times, how big a burst — which
 *   changes when a reminder is edited, not minute to minute. And the direction
 *   of error is conservative: a reminder that has since been deleted still
 *   counts, which shortens the horizon rather than overrunning the cap.
 * - Nothing clears this on sign-out, deliberately. Signing out does not cancel
 *   the alarms already on the device, so those slots really are still consumed;
 *   forgetting them would make the budget claim capacity the OS does not have.
 */
const knownCosts = new Map<number, ReminderCost[]>();

/**
 * Reconciles the device's scheduled local notifications against backend state.
 *
 * This used to live inside `loadData()` on the medications screen, which made
 * it the *only* thing in the app that repaired a broken alarm chain — so a user
 * who opened the app to Home and never navigated to Medications kept whatever
 * broken state they had. That is precisely the case the re-sync exists for:
 * a reinstall, an OS that dropped pending notifications, or a chain that
 * stopped because `rescheduleNextOccurrence` never ran.
 *
 * Now callable from app launch (`app/_layout.tsx`) as well as from the
 * medications screen.
 *
 * Deliberately **not** an alarm-delivery guarantee. Per D-2 it only ever
 * schedules forward from now — a phone that was off all day comes back with its
 * next alarm in the future and no backlog, and this must keep that property.
 */
export function useNotificationSync() {
  // Launch and a focus event can land within milliseconds of each other, and
  // scheduleMedicationNotifications cancels-then-reschedules per reminder.
  // Overlapping runs would race on that window, so serialise them.
  //
  // 5.6 moved the lock from the per-owner sync to the whole pass, which it has
  // to be: the budget is computed once from every owner's cost and then handed
  // to every reminder, so a second pass interleaving halfway through would
  // schedule part of the device against one plan and part against another.
  const inFlight = useRef<Promise<void> | null>(null);

  /**
   * 4.2 item 2 — reconcile several people's sets in one pass.
   *
   * A caregiver's device legitimately holds alarms for themselves and for every
   * active dependent (D-1), and until now nothing reconciled the dependents'
   * sets: they arrived only as a side effect of visiting that person's
   * medications screen and then stayed on the device forever. Passing each owner
   * explicitly is what lets `cacheReminders` evict a person whose list comes back
   * empty, which a caller that only ever asked about "self" could never do.
   *
   * **Three phases, and the split is 5.6's doing.** Fetch every owner's
   * reminders first, then cost the whole device and decide one budget, then
   * schedule. It cannot be one loop: the horizon depends on what *else* the
   * device is holding, so the first reminder cannot be scheduled until the last
   * one has been read.
   *
   * `viewerUserId` is the signed-in user, and it is what tells the scheduler
   * whether this device is holding its owner's alarms or a caregiver's copy of
   * someone else's (4.2 item 4). It is threaded through rather than read from
   * `AuthContext` here so this hook stays callable from anywhere, including the
   * medications screen, which already knows both ids.
   */
  const syncOwners = useCallback(async (ownerIds: (number | undefined)[], viewerUserId?: number) => {
    const run = async () => {
      // 4.4 — "the next sync" the retry queue waits for. Deliberately first, and
      // deliberately not gated on the reminder fetch succeeding: a confirmation
      // that never landed is worth replaying even on a launch where the reminder
      // list is unavailable, and replaying it before the doses below are read is
      // what lets the same pass act on it (4.2 item 4).
      //
      // Globally scoped and internally serialised, so running it once per pass
      // costs one storage read rather than a double send.
      await flushDoseQueue();

      // --- Phase 1: read ---------------------------------------------------
      const fetched: { ownerId?: number; reminders: any[] }[] = [];
      for (const ownerId of ownerIds) {
        const reminders = await fetchReminders(ownerId);
        // Offline or a 5xx. Leave whatever is already scheduled for this owner
        // alone — stale alarms are better than none, and the next launch
        // retries. Their cost stays in `knownCosts` from the last good read, so
        // the budget below still accounts for them.
        if (!reminders) continue;

        // 4.3 — persist the set before scheduling. The notification payload no
        // longer carries the medication name or dosage, so this cache is what an
        // alarm resolves against when it cold-starts the app. Writing it first
        // means a crash between here and the scheduling loop leaves data without
        // alarms rather than alarms without data.
        //
        // Owners come off the rows themselves (`user_id`), which is the server's
        // own answer to "whose reminder is this" and cannot drift from what gets
        // scheduled. The requested owner is passed as well so an owner whose list
        // came back empty still gets their map cleared — otherwise deleting a
        // last reminder would leave its details cached indefinitely.
        await cacheReminders(reminders, typeof ownerId === 'number' ? [ownerId] : []);
        fetched.push({ ownerId, reminders });
      }

      // The web guard sits here rather than at the top: there are no local
      // notifications on web, but the 4.3 cache above is app state rather than a
      // notification concern, and keeping it populated on web is what makes the
      // alarm overlay's resolve-and-degrade behaviour exercisable in a web build.
      if (Platform.OS === 'web' || fetched.length === 0) return;

      // --- Phase 2: one budget for the whole device ------------------------
      const now = new Date();
      for (const { ownerId, reminders } of fetched) {
        recordCosts(ownerId, reminders, viewerUserId, now);
      }

      const plan = planNotificationBudget(
        Array.from(knownCosts.values()).flat(),
        { platform: Platform.OS }
      );
      // Remembered so the three single-reminder callers — the form, the status
      // toggle, the profile screen's meal-time regeneration — do not silently
      // collapse a reminder's horizon back to one day. See `rememberBudgetPlan`.
      rememberBudgetPlan(plan);
      logBudget(plan);

      const dropped = new Set(plan.dropped);

      // --- Phase 3: write --------------------------------------------------
      for (const { ownerId, reminders } of fetched) {
        // 4.2 item 4 — only needed when this device is holding someone else's
        // schedule, because only a caregiver's copy is scheduled *after* its
        // dose and can therefore be obsolete before it fires. Skipping the
        // request entirely on a patient's own device keeps the common launch at
        // one round trip.
        const doses = viewerUserId != null && ownerId != null && viewerUserId !== ownerId
          ? await fetchDoses(ownerId)
          : [];

        // Sequential rather than Promise.all: expo-notifications serialises
        // these natively anyway, and one failure shouldn't reject the rest.
        for (const reminder of reminders) {
          try {
            await scheduleMedicationNotifications(reminder, {
              viewerUserId,
              doses,
              daysAhead: plan.daysAhead,
              burstCap: plan.burstCap,
              dropped: dropped.has(Number(reminder?.id)),
            });
          } catch (e) {
            console.warn('[notification-sync] could not schedule reminder', reminder?.id, e);
          }
        }
      }
    };

    const pending = (inFlight.current ?? Promise.resolve()).then(run, run);
    inFlight.current = pending;
    await pending;
    if (inFlight.current === pending) inFlight.current = null;
  }, []);

  /**
   * One owner's set. A thin wrapper so the budget is computed the same way
   * whichever entry point is used — the single-owner path is where budgeting
   * from one person's reminders alone would be wrong, so it must not have its
   * own arithmetic.
   */
  const syncFor = useCallback(
    (targetUserId?: number, viewerUserId?: number) => syncOwners([targetUserId], viewerUserId),
    [syncOwners]
  );

  return { syncFor, syncOwners };
}

/** One owner's reminders, or `null` if they could not be read. */
async function fetchReminders(ownerUserId?: number): Promise<any[] | null> {
  try {
    const res = await apiRequest('/medication-reminders', {}, ownerUserId);
    if (!res.ok) {
      console.warn('[notification-sync] skipped, reminders unavailable:', res.status);
      return null;
    }
    const reminders = await res.json();
    return Array.isArray(reminders) ? reminders : null;
  } catch (e) {
    console.warn('[notification-sync] failed:', e);
    return null;
  }
}

/**
 * Replaces this owner's entry in the device-wide cost map.
 *
 * Keyed on the requested owner where there is one, and otherwise on the rows'
 * own `user_id` — which is how the "self" call from the medications screen,
 * where the target is left undefined, still files its costs under a real id
 * rather than accumulating a second unattributed entry.
 */
function recordCosts(
  ownerId: number | undefined,
  reminders: any[],
  viewerUserId: number | undefined,
  now: Date
) {
  const key = typeof ownerId === 'number' && Number.isFinite(ownerId)
    ? ownerId
    : Number(reminders[0]?.user_id);
  if (!Number.isFinite(key)) return;

  const costs: ReminderCost[] = [];
  for (const reminder of reminders) {
    const cost = reminderCostFor(reminder, { viewerUserId, platform: Platform.OS, now });
    if (cost) costs.push(cost);
  }
  knownCosts.set(key, costs);
}

/**
 * **Logged on every pass, not only when something is given up.** 5.6 exists to
 * remove an invisible degradation, and the same argument that made 5.4's
 * dispatcher log its empty runs applies here: a horizon that quietly shortened
 * looks exactly like one that never needed to, and "what did the device decide?"
 * is the only question these logs can answer after the fact.
 */
function logBudget(plan: BudgetPlan) {
  console.info(
    '[notification-sync] budget:',
    `${plan.daysAhead}d horizon,`,
    `${plan.projectedSlots} slots,`,
    plan.burstCap != null ? `burst capped at ${plan.burstCap}` : 'full burst'
  );
  for (const line of plan.truncations) {
    console.warn('[notification-sync] budget truncation:', line);
  }
}

/**
 * The owner's materialised doses around now (5.1), for 4.2 item 4's
 * confirmed-dose check.
 *
 * Returns `[]` on any failure, which schedules every escalation rather than
 * none. That is the safe direction and it is worth being explicit about: an
 * empty list means "we could not tell", and a caregiver alarmed about a dose
 * that was actually taken is an annoyance, while one *not* alarmed about a dose
 * that was missed is the failure this whole plan exists to remove.
 */
async function fetchDoses(ownerUserId: number): Promise<DoseRow[]> {
  const now = Date.now();
  const from = new Date(now - DOSE_WINDOW_BACK_MS).toISOString();
  const to = new Date(now + DOSE_WINDOW_FORWARD_MS).toISOString();

  try {
    const res = await apiRequest(
      `/medication-doses?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {},
      ownerUserId
    );
    if (!res.ok) {
      console.warn('[notification-sync] doses unavailable:', res.status);
      return [];
    }
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.warn('[notification-sync] could not read doses', e);
    return [];
  }
}
