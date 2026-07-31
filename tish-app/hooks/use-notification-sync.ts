import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';

import { apiRequest } from '@/utils/api';
import { flushDoseQueue } from '@/utils/dose-queue';
import type { DoseRow } from '@/utils/doses';
import { scheduleMedicationNotifications } from '@/utils/notification-helper';
import { cacheReminders } from '@/utils/reminder-store';

/**
 * How far back the dose window reaches. A caregiver's escalation copy is only
 * ever scheduled for the *next* occurrence of each slot, so yesterday is more
 * than enough history to answer "was that one confirmed" — and keeping the
 * window small keeps the response small, since this runs on every launch.
 */
const DOSE_WINDOW_BACK_MS = 24 * 60 * 60 * 1000;
/** Forward far enough to cover the longest interval the next occurrence can land on. */
const DOSE_WINDOW_FORWARD_MS = 8 * 24 * 60 * 60 * 1000;

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
  const inFlight = useRef<Promise<void> | null>(null);

  /**
   * `viewerUserId` is the signed-in user, and it is what tells the scheduler
   * whether this device is holding its owner's alarms or a caregiver's copy of
   * someone else's (4.2 item 4). It is threaded through rather than read from
   * `AuthContext` here so this hook stays callable from anywhere, including the
   * medications screen, which already knows both ids.
   */
  const syncFor = useCallback(async (targetUserId?: number, viewerUserId?: number) => {
    const run = async () => {
      // 4.4 — "the next sync" the retry queue waits for. Deliberately first, and
      // deliberately not gated on the reminder fetch succeeding: a confirmation
      // that never landed is worth replaying even on a launch where the reminder
      // list is unavailable, and replaying it before the doses below are read is
      // what lets the same pass act on it (4.2 item 4).
      //
      // Globally scoped and internally serialised, so running it once per owner
      // on a caregiver's device costs one storage read rather than a double send.
      await flushDoseQueue();

      try {
        const res = await apiRequest('/medication-reminders', {}, targetUserId);
        if (!res.ok) {
          // Offline or a 5xx. Leave whatever is already scheduled alone —
          // stale alarms are better than none, and the next launch retries.
          console.warn('[notification-sync] skipped, reminders unavailable:', res.status);
          return;
        }

        const reminders = await res.json();
        if (!Array.isArray(reminders)) return;

        // 4.3 — persist the set before scheduling. The notification payload no
        // longer carries the medication name or dosage, so this cache is what an
        // alarm resolves against when it cold-starts the app. Writing it first
        // means a crash between here and the scheduling loop leaves data without
        // alarms rather than alarms without data.
        //
        // Owners come off the rows themselves (`user_id`), which is the server's
        // own answer to "whose reminder is this" and cannot drift from what gets
        // scheduled. `targetUserId` is passed as well so an owner whose list came
        // back empty still gets their map cleared — otherwise deleting a last
        // reminder would leave its details cached indefinitely.
        await cacheReminders(reminders, typeof targetUserId === 'number' ? [targetUserId] : []);

        // The web guard sits here rather than at the top of `syncFor`: there are
        // no local notifications on web, but the 4.3 cache above is app state
        // rather than a notification concern, and keeping it populated on web is
        // what makes the alarm overlay's resolve-and-degrade behaviour
        // exercisable in a web build.
        if (Platform.OS === 'web') return;

        // 4.2 item 4 — only needed when this device is holding someone else's
        // schedule, because only a caregiver's copy is scheduled *after* its
        // dose and can therefore be obsolete before it fires. Skipping the
        // request entirely on a patient's own device keeps the common launch at
        // one round trip.
        const doses = viewerUserId != null && targetUserId != null && viewerUserId !== targetUserId
          ? await fetchDoses(targetUserId)
          : [];

        // Sequential rather than Promise.all: expo-notifications serialises
        // these natively anyway, and one failure shouldn't reject the rest.
        for (const reminder of reminders) {
          try {
            await scheduleMedicationNotifications(reminder, { viewerUserId, doses });
          } catch (e) {
            console.warn('[notification-sync] could not schedule reminder', reminder?.id, e);
          }
        }
      } catch (e) {
        console.warn('[notification-sync] failed:', e);
      }
    };

    const pending = (inFlight.current ?? Promise.resolve()).then(run, run);
    inFlight.current = pending;
    await pending;
    if (inFlight.current === pending) inFlight.current = null;
  }, []);

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
   * Sequential, not `Promise.all`: `syncFor` serialises internally anyway, and
   * one person's failed fetch must not abandon the rest.
   */
  const syncOwners = useCallback(async (ownerIds: number[], viewerUserId?: number) => {
    for (const ownerId of ownerIds) {
      await syncFor(ownerId, viewerUserId);
    }
  }, [syncFor]);

  return { syncFor, syncOwners };
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
