/**
 * 5.6 — laying out the alerts a reminder's horizon consists of.
 *
 * **Why this is a module and not a loop inside `notification-helper`.** The
 * arithmetic here decides which OS notification identifier each alert is written
 * under, and this codebase has now been bitten three separate times by that
 * question (§0.6): a burst member's identifier used to be the same string
 * tomorrow as today, which made the chain-forward eat the burst, made the
 * overlay's cancel delete the next occurrence, and would — the moment several
 * days are written at once — make each day silently replace the last. Scheduling
 * onto an existing identifier *replaces* it, without an error and without a log,
 * so every one of those failures is invisible until an alarm does not ring.
 *
 * `notification-helper` imports `expo-notifications` and so cannot be loaded
 * outside a native runtime. Everything below is dependency-free, which is what
 * lets `node --test` strip the types and run it — the same split as
 * `dose-queue-policy`, `escalation-policy` and `notification-budget`, and for
 * the same reason: these rules all fail silently in production.
 *
 * What is deliberately *not* here is the I/O — cancelling, resolving the
 * interruption level, and the `scheduleNotificationAsync` call itself.
 */

import { addDays, computeNextTriggerDate } from './date.ts';
import { doseKey } from './doses.ts';
import { DEFAULT_HORIZON_DAYS, plannedBurstCount, reminderHold } from './notification-budget.ts';
import { identifierFor, occurrenceKeyFor } from './notification-identifiers.ts';

/** 4.7b — spacing between consecutive alerts of one dose's burst. */
export const BURST_SPACING_MS = 30 * 1000;

export interface PlannedAlert {
    /** The OS notification identifier. Unique across the whole plan. */
    identifier: string;
    /** When this alert fires. */
    date: Date;
    /** The alarm slot it belongs to, "HH:mm" as the reminder row stores it. */
    timeStr: string;
    /** 0-based day of the horizon. */
    occurrence: number;
    /** `YYYYMMDD` of the occurrence, shared by every member of its burst. */
    occurrenceKey?: string;
    burstIndex: number;
    burstCount: number;
}

export interface AlarmPlan {
    ownerUserId?: number;
    isCaregiverCopy: boolean;
    /** How many minutes after the dose a caregiver's copy fires (D-3, 4.2 item 4). */
    escalationOffsetMinutes: number;
    frequencyDays: number;
    /** Days of look-ahead actually used, after every clamp below. */
    horizonDays: number;
    burstCount: number;
    /** Empty when this device holds nothing for the reminder. */
    alerts: PlannedAlert[];
}

export interface AlarmPlanOptions {
    viewerUserId?: number;
    platform: string;
    now?: Date;
    /** From the budget. Omitted means a single occurrence — the pre-5.6 depth. */
    daysAhead?: number;
    /** From the budget. `null`/omitted means no reduction. */
    burstCap?: number | null;
    /**
     * 4.2 item 4 — dose keys already confirmed, so a caregiver's escalation is
     * not scheduled for a dose the patient has already taken. `doses.ts` builds
     * this; passing the keys rather than the rows keeps this module free of the
     * row shape.
     */
    confirmedDoses?: ReadonlySet<string>;
}

/**
 * The horizon depth to actually use.
 *
 * **Forced to one when the reminder names no owner**, because the identifier
 * cannot then carry an occurrence segment — every occurrence would be written
 * onto the same string and each would silently replace the last, leaving one
 * alarm behind and a horizon that looks scheduled and is not. The caller says so
 * out loud; here it is only arithmetic.
 *
 * Clamped to `DEFAULT_HORIZON_DAYS` at the top end so the device cannot hold
 * alarms for days the server has not materialised doses for — 5.1 and 5.6 use
 * the same window deliberately, and 5.7's missed list disagrees with what
 * actually rang if they drift.
 */
export function horizonDaysFor(daysAhead: number | undefined, hasOwner: boolean): number {
    if (!hasOwner) return 1;
    return Math.min(Math.max(Math.trunc(Number(daysAhead)) || 1, 1), DEFAULT_HORIZON_DAYS);
}

/** D-9's burst after the budget's cap. The cap only ever bites at the horizon floor. */
export function burstCountFor(
    alarmRepeatCount: unknown,
    { platform, isCaregiverCopy, hasOwner, burstCap }: {
        platform: string;
        isCaregiverCopy: boolean;
        hasOwner: boolean;
        burstCap?: number | null;
    }
): number {
    const planned = plannedBurstCount(alarmRepeatCount, { platform, isCaregiverCopy, hasOwner });
    if (burstCap == null) return planned;
    return Math.max(Math.min(planned, Math.trunc(Number(burstCap)) || 1), 1);
}

/**
 * Every alert this device should hold for one reminder.
 *
 * The occurrence key is taken from the occurrence's own trigger rather than from
 * each burst member's time: a burst beginning at 23:59:45 crosses midnight
 * partway through, and members of one occurrence must share a key or a cancel
 * scoped to that occurrence would clear only half of it.
 */
export function planAlarmsForReminder(reminder: any, options: AlarmPlanOptions): AlarmPlan {
    const { ownerUserId, isCaregiverCopy, holds } = reminderHold(reminder, options.viewerUserId);
    const now = options.now ?? new Date();

    const frequencyDays = Math.max(parseInt(reminder?.frequency_days) || 1, 1);
    // Mirrors the column default (migration 002) rather than trusting the row to
    // carry one: a reminder object assembled client-side — the form's optimistic
    // schedule, for instance — may not have the field at all, and 0 would
    // collapse the escalation back onto the dose time.
    const escalationOffsetMinutes = isCaregiverCopy
        ? Math.max(parseInt(reminder?.escalation_delay_minutes) || 30, 1)
        : 0;

    const burstCount = burstCountFor(reminder?.alarm_repeat_count, {
        platform: options.platform,
        isCaregiverCopy,
        hasOwner: ownerUserId != null,
        burstCap: options.burstCap,
    });
    const horizonDays = horizonDaysFor(options.daysAhead, ownerUserId != null);

    const base = { ownerUserId, isCaregiverCopy, escalationOffsetMinutes, frequencyDays, horizonDays, burstCount };
    if (!holds) return { ...base, alerts: [] };

    // Only a caregiver's copy can point at a dose in the *past*: it fires at dose
    // time + delay, so a device syncing at 08:10 for an 08:00 dose is scheduling
    // an 08:30 escalation for a dose that may already be confirmed. The patient's
    // own alarm is always the next occurrence, which by definition has not
    // happened yet, so there is nothing to check for it.
    const confirmed = isCaregiverCopy ? options.confirmedDoses : undefined;

    const alerts: PlannedAlert[] = [];
    for (const timeStr of reminder.alarms as string[]) {
        const firstTrigger = computeNextTriggerDate(timeStr, frequencyDays, now, true, escalationOffsetMinutes);

        for (let occurrence = 0; occurrence < horizonDays; occurrence += 1) {
            // Calendar arithmetic, not milliseconds — see `addDays`. Occurrence 0
            // is the un-shifted date so the single-day case is byte-identical to
            // what shipped before 5.6.
            const triggerDate = occurrence === 0
                ? firstTrigger
                : addDays(firstTrigger, occurrence * frequencyDays);

            if (confirmed) {
                // Keyed on the *dose* time, not the trigger: the offset was
                // applied above and the dose row knows nothing about the
                // caregiver's delay. Checked per occurrence rather than per slot,
                // because the sync's dose window reaches across the whole horizon.
                const doseTime = new Date(triggerDate.getTime() - escalationOffsetMinutes * 60 * 1000);
                if (confirmed.has(doseKey(reminder.id, doseTime))) continue;
            }

            pushBurst(alerts, {
                reminderId: reminder.id,
                ownerUserId,
                timeStr,
                triggerDate,
                occurrence,
                burstCount,
            });
        }
    }

    return { ...base, alerts };
}

/**
 * The horizon to rewrite when an alarm fires — 4.7b's chain-forward, which 5.6
 * turns into a top-up.
 *
 * **Rewrites the whole forward horizon rather than appending one day**, and that
 * is the choice §0.3 asked to be made deliberately. Appending is cheaper and
 * wrong in the case that matters: if the app has not run for several days, the
 * occurrences that fired meanwhile are gone and appending a single far-end day
 * leaves the gap in the middle. Because identifiers are date-keyed, rewriting is
 * idempotent — an occurrence already scheduled is replaced by an identical alert
 * — so it repairs the gap instead of widening it.
 *
 * Starts at the *next* occurrence (`isFirstSchedule: false`), so it can never
 * re-arm the one that just fired. D-2 holds.
 *
 * A payload from before 5.6 carries no `horizonDays` and reads as 1 — exactly
 * the single next occurrence that build chained forward. One from before 4.7b
 * carries no `burstCount` and reads as 1, which is the single alert it wrote.
 */
export function planChainForward(data: any, { now = new Date() }: { now?: Date } = {}): AlarmPlan {
    // No platform argument, deliberately: the burst and the horizon both come off
    // the payload, which was written by a scheduler that had already applied
    // D-10's Android rule and the budget's cap. Re-deriving them here would let
    // the two disagree about an alarm that is already on the device.
    const ownerUserId = Number.isFinite(Number(data?.ownerUserId)) ? Number(data.ownerUserId) : undefined;
    // A payload carrying an offset is a caregiver's escalation copy (4.2 item 4),
    // and the next occurrence has to keep both the offset and the wording.
    const escalationOffsetMinutes = Math.max(parseInt(data?.escalationOffsetMinutes) || 0, 0);
    const isCaregiverCopy = escalationOffsetMinutes > 0;
    const frequencyDays = Math.max(parseInt(data?.frequencyDays) || 1, 1);

    // Same clamps as the scheduler, applied to the payload rather than the row.
    const burstCount = ownerUserId != null
        ? Math.min(Math.max(parseInt(data?.burstCount) || 1, 1), 6)
        : 1;
    const horizonDays = horizonDaysFor(parseInt(data?.horizonDays) || 1, ownerUserId != null);

    const base = { ownerUserId, isCaregiverCopy, escalationOffsetMinutes, frequencyDays, horizonDays, burstCount };
    if (!data?.reminderId || !data?.timeStr || !data?.frequencyDays) return { ...base, alerts: [] };

    const firstTrigger = computeNextTriggerDate(data.timeStr, frequencyDays, now, false, escalationOffsetMinutes);

    const alerts: PlannedAlert[] = [];
    for (let occurrence = 0; occurrence < horizonDays; occurrence += 1) {
        pushBurst(alerts, {
            reminderId: data.reminderId,
            ownerUserId,
            timeStr: data.timeStr,
            triggerDate: occurrence === 0 ? firstTrigger : addDays(firstTrigger, occurrence * frequencyDays),
            occurrence,
            burstCount,
        });
    }

    return { ...base, alerts };
}

function pushBurst(
    into: PlannedAlert[],
    { reminderId, ownerUserId, timeStr, triggerDate, occurrence, burstCount }: {
        reminderId: number | string;
        ownerUserId?: number;
        timeStr: string;
        triggerDate: Date;
        occurrence: number;
        burstCount: number;
    }
) {
    const occurrenceKey = ownerUserId != null ? occurrenceKeyFor(triggerDate) : undefined;

    for (let burstIndex = 1; burstIndex <= burstCount; burstIndex += 1) {
        into.push({
            identifier: identifierFor(
                reminderId,
                timeStr,
                ownerUserId,
                ownerUserId != null ? burstIndex : undefined,
                occurrenceKey
            ),
            date: new Date(triggerDate.getTime() + (burstIndex - 1) * BURST_SPACING_MS),
            timeStr,
            occurrence,
            occurrenceKey,
            burstIndex,
            burstCount,
        });
    }
}
