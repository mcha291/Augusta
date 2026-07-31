/**
 * Resolves what an alarm should actually say, at the moment it is shown (4.3).
 *
 * The overlay is rendered by the app, not by the OS, so unlike the notification
 * banner there *is* running code and network access at this point. Order matters:
 *
 *  1. **Cache first.** The first paint never waits on the network.
 *  2. **Then refresh, hard-bounded.** The number the patient acts on should be
 *     fetched at the moment they act on it, not merely be as fresh as the last
 *     sync — but an alarm that doesn't ring because a fetch stalled is a far
 *     worse failure than a stale dosage, so the request is aborted at
 *     `REFRESH_TIMEOUT_MS` and the cache wins.
 *  3. **Degrade, never blank.** No cache and no network means a generic
 *     medication-reminder prompt, not an empty alarm.
 */

import { useEffect, useState } from 'react';

import { apiRequest } from '@/utils/api';
import {
  cacheReminders,
  labelForTime,
  readCachedReminder,
  readOwnerName,
  type CachedReminder,
} from '@/utils/reminder-store';

/** Bounded well under the time it takes a patient to read the screen. */
export const REFRESH_TIMEOUT_MS = 2500;

export type RefreshState = 'idle' | 'pending' | 'ok' | 'failed';

export interface ResolvedReminder {
  medName: string | null;
  dosage: string | null;
  label: string | null;
  /** Display name of whoever this dose belongs to, when known (4.2). */
  ownerName: string | null;
  /** False when we genuinely don't know what this dose is. */
  resolved: boolean;
  refresh: RefreshState;
  /** When the displayed copy was taken, if it came from the cache. */
  cachedAt: number | null;
}

const UNRESOLVED: ResolvedReminder = {
  medName: null,
  dosage: null,
  label: null,
  ownerName: null,
  resolved: false,
  refresh: 'idle',
  cachedAt: null,
};

function fromCached(cached: CachedReminder, timeStr?: string | null): Omit<ResolvedReminder, 'refresh' | 'ownerName'> {
  return {
    medName: cached.medName,
    dosage: cached.dosage,
    label: labelForTime(cached, timeStr),
    resolved: true,
    cachedAt: cached.cachedAt,
  };
}

function fromReminder(reminder: any, timeStr?: string | null): Omit<ResolvedReminder, 'refresh' | 'ownerName'> {
  const alarms = Array.isArray(reminder?.alarms) ? reminder.alarms.map((a: any) => String(a)) : [];
  const alarmLabels = Array.isArray(reminder?.alarm_labels)
    ? reminder.alarm_labels.map((l: any) => (l == null ? '' : String(l)))
    : [];
  return {
    medName: reminder?.med_name ?? null,
    dosage: reminder?.selected_dosage ?? null,
    label: labelForTime({ alarms, alarmLabels }, timeStr),
    resolved: true,
    cachedAt: null,
  };
}

export function useResolvedReminder(
  isVisible: boolean,
  reminderId?: number | null,
  ownerUserId?: number | null,
  timeStr?: string | null
): ResolvedReminder {
  const [resolved, setResolved] = useState<ResolvedReminder>(UNRESOLVED);

  useEffect(() => {
    if (!isVisible || reminderId == null || !Number.isFinite(reminderId)) {
      setResolved(UNRESOLVED);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    setResolved({ ...UNRESOLVED, refresh: 'pending' });

    const run = async () => {
      // Attribution is resolved alongside the content and kept through every
      // later state change: on a caregiver's device, *whose* dose this is matters
      // even when the medication itself can't be resolved.
      const [cached, ownerName] = await Promise.all([
        readCachedReminder(Number(reminderId), ownerUserId),
        readOwnerName(ownerUserId),
      ]);
      if (cancelled) return;
      if (cached || ownerName) {
        // Keep `refresh: 'pending'` — the "couldn't refresh" notice must not
        // flicker on while the request that would clear it is still in flight.
        setResolved({
          ...(cached ? fromCached(cached, timeStr) : UNRESOLVED),
          ownerName,
          refresh: 'pending',
        });
      }

      const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
      try {
        const res = await apiRequest(
          '/medication-reminders',
          { signal: controller.signal },
          ownerUserId != null && Number.isFinite(ownerUserId) ? Number(ownerUserId) : undefined
        );
        if (!res.ok) throw new Error(`reminders unavailable: ${res.status}`);

        const list = await res.json();
        if (!Array.isArray(list)) throw new Error('unexpected reminders payload');

        // We have the whole set in hand; refresh the cache while we're here. The
        // reconciliation pass isn't the only chance to keep this current.
        cacheReminders(list, ownerUserId != null && Number.isFinite(ownerUserId) ? [Number(ownerUserId)] : []).catch(
          () => {}
        );

        if (cancelled) return;
        const fresh = list.find((r: any) => Number(r?.id) === Number(reminderId));
        if (fresh) {
          setResolved({ ...fromReminder(fresh, timeStr), ownerName, refresh: 'ok' });
        } else {
          // The refresh landed and the reminder is not there — deleted since it
          // was scheduled. Drop the cached copy rather than showing details for
          // something that no longer exists, but keep the attribution.
          setResolved({ ...UNRESOLVED, ownerName, refresh: 'ok' });
        }
      } catch (e) {
        if (cancelled) return;
        // Offline, a 5xx, or the timeout firing. Keep whatever the cache gave us
        // and say so; the notice is only rendered when there is content to
        // qualify, so a total miss falls through to the generic prompt instead.
        console.warn('[use-resolved-reminder] refresh failed, using cache:', e);
        setResolved((prev) => ({ ...prev, refresh: 'failed' }));
      } finally {
        clearTimeout(timer);
      }
    };

    run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isVisible, reminderId, ownerUserId, timeStr]);

  return resolved;
}
