/**
 * 5.6 — how many days of alarms fit on this device, and what to give up when
 * they do not all fit.
 *
 * **The problem this solves.** Today the app schedules exactly one occurrence
 * per alarm time and re-arms it when it fires, so a broken chain — a device off
 * overnight, a notification that never delivered, an app killed before its
 * listener ran — stops the alarm until someone opens the app. Scheduling several
 * days ahead degrades gracefully instead: the chain can break and the next four
 * days still ring.
 *
 * **Why it needs arithmetic rather than a constant.** iOS keeps at most **64**
 * pending notifications per app and silently drops the rest — it does not error,
 * it just schedules fewer than you asked for, so the failure is invisible until
 * an alarm does not arrive. D-1 and D-9 both push against that ceiling: a
 * caregiver's device holds their own alarms *plus* an escalation for each
 * dependent's escalation-enabled reminder, and every one of the owner's own
 * alerts is multiplied by `alarm_repeat_count`. Three medications taken three
 * times daily with the default burst of 3 is 27 notifications *per day*, which
 * fits roughly two days inside 64 — not the seven the horizon wants.
 *
 * Pure and dependency-free so it can be tested at all: like `dose-queue-policy`
 * and `escalation-policy`, **every rule here fails silently in production.** A
 * budget that over-counts shortens the horizon for no reason; one that
 * under-counts overruns the cap and iOS discards whichever alarms it likes, with
 * no error and no log. Neither is visible without doing the sums by hand.
 */

/**
 * iOS's hard ceiling on pending notifications per app.
 *
 * Android has no comparable per-app limit, which is why `capacityFor` reports a
 * much larger number there rather than skipping the budget entirely — the code
 * path stays identical on both platforms, so a bug in it cannot hide on one.
 */
export const IOS_PENDING_CAP = 64;

/**
 * Reserve held back from the cap.
 *
 * 4.4's snooze alert is scheduled *on demand*, after the reconciliation pass has
 * already filled the queue, and it is the one alert a patient has explicitly
 * asked for. Budgeting to exactly 64 means a snooze at the wrong moment either
 * fails or silently evicts a real alarm. Four is one snooze per plausible
 * concurrent alarm rather than a round number.
 */
export const PENDING_RESERVE = 4;

/** The horizon 5.1's server-side materialisation uses. Aligned deliberately. */
export const DEFAULT_HORIZON_DAYS = 7;

/**
 * Never plan fewer than two days, even under pressure.
 *
 * Below this the feature has stopped being a horizon at all — one day of
 * look-ahead is what the app already did before 5.6. The plan is explicit that
 * the burst gets trimmed before the horizon goes under two days.
 */
export const MIN_HORIZON_DAYS = 2;

export interface ReminderCost {
    /** Stable id, used only so a truncation can name what it dropped. */
    id: number;
    /** How many alarm times this reminder has. */
    alarmCount: number;
    /**
     * Alerts per alarm time — D-9's burst. Always 1 for a caregiver's escalation
     * copy and always 1 on Android; the caller resolves that, not this module.
     */
    burstCount: number;
    /** A caregiver's escalation copy for a dependent, rather than the user's own. */
    isCaregiverCopy: boolean;
    /**
     * Milliseconds until this reminder's next dose, used only to order
     * dependents when some of them have to be dropped. Soonest survives.
     */
    msUntilNext?: number;
}

export interface BudgetPlan {
    /** Days of look-ahead every surviving reminder should schedule. */
    daysAhead: number;
    /**
     * Burst cap applied on top of each reminder's own `alarm_repeat_count`.
     * `null` means no reduction. Only ever set once the horizon has already been
     * squeezed to `MIN_HORIZON_DAYS`.
     */
    burstCap: number | null;
    /** Reminder ids that will not be scheduled at all. */
    dropped: number[];
    /** Human-readable reasons, for the log. Empty when everything fits. */
    truncations: string[];
    /** Slots the plan will consume, for assertions and logging. */
    projectedSlots: number;
}

/** Usable slots on this platform, after the snooze reserve. */
export function capacityFor(platform: string): number {
    // Android's limit is effectively "as many as you like"; the number is large
    // rather than Infinity so the arithmetic below stays finite and testable.
    if (platform !== 'ios') return 5000;
    return IOS_PENDING_CAP - PENDING_RESERVE;
}

/** Slots one reminder consumes per day, honouring an optional burst cap. */
function dailyCost(r: ReminderCost, burstCap: number | null): number {
    const alarms = Math.max(0, Math.floor(r.alarmCount) || 0);
    const rawBurst = Math.max(1, Math.floor(r.burstCount) || 1);
    const burst = burstCap == null ? rawBurst : Math.min(rawBurst, burstCap);
    return alarms * burst;
}

const sumDaily = (rs: ReminderCost[], burstCap: number | null) =>
    rs.reduce((total, r) => total + dailyCost(r, burstCap), 0);

/**
 * Decide the horizon, and what to sacrifice if the full one does not fit.
 *
 * **The priority order is the plan's, and the reasoning behind it is worth
 * keeping in view: audibility before horizon.** An alarm the patient sleeps
 * through *today* is a worse failure than one that stops working on day five,
 * because the launch re-sync (4.1) and the silent push (5.9) both exist to
 * repair a short horizon and **nothing repairs an alarm that was not heard.**
 * So:
 *
 *   1. Shorten the horizon, keeping the full burst, down to `MIN_HORIZON_DAYS`.
 *   2. Only then trim the burst, down to a single alert.
 *   3. Only then drop reminders — dependents' escalation copies first, by
 *      furthest-away dose, since the patient's own alarms are the ones that
 *      actually deliver the medication.
 *
 * Every step past the first is recorded in `truncations`. A silently shortened
 * horizon is exactly the invisible degradation this phase exists to remove.
 */
export function planNotificationBudget(
    reminders: ReminderCost[],
    { platform, horizonDays = DEFAULT_HORIZON_DAYS }: { platform: string; horizonDays?: number }
): BudgetPlan {
    const capacity = capacityFor(platform);
    const truncations: string[] = [];
    const requested = Math.max(1, Math.floor(horizonDays) || DEFAULT_HORIZON_DAYS);

    const active = reminders.filter((r) => dailyCost(r, null) > 0);
    if (active.length === 0) {
        return { daysAhead: requested, burstCap: null, dropped: [], truncations, projectedSlots: 0 };
    }

    // 1. Horizon first, full burst kept.
    const perDay = sumDaily(active, null);
    let daysAhead = Math.min(requested, Math.floor(capacity / perDay));

    if (daysAhead >= MIN_HORIZON_DAYS) {
        if (daysAhead < requested) {
            truncations.push(
                `horizon shortened to ${daysAhead}d (from ${requested}d): ${perDay} slots/day against ${capacity}`
            );
        }
        return { daysAhead, burstCap: null, dropped: [], truncations, projectedSlots: perDay * daysAhead };
    }

    // 2. Horizon is pinned at the floor; start trimming the burst instead.
    daysAhead = MIN_HORIZON_DAYS;
    const maxBurst = Math.max(...active.map((r) => Math.max(1, Math.floor(r.burstCount) || 1)));

    for (let cap = maxBurst - 1; cap >= 1; cap -= 1) {
        const cost = sumDaily(active, cap) * daysAhead;
        if (cost <= capacity) {
            truncations.push(
                `burst capped at ${cap} to hold a ${daysAhead}d horizon: ` +
                `${sumDaily(active, cap)} slots/day against ${capacity}`
            );
            return { daysAhead, burstCap: cap, dropped: [], truncations, projectedSlots: cost };
        }
    }

    // 3. Single alerts, two days, and it still does not fit. Start dropping —
    //    dependents' escalation copies first, furthest-away dose first, because
    //    the patient's own alarms are the ones delivering the medication.
    const burstCap = 1;
    truncations.push(`burst capped at 1: even single alerts overrun ${capacity} slots`);

    const order = [...active].sort((a, b) => {
        if (a.isCaregiverCopy !== b.isCaregiverCopy) return a.isCaregiverCopy ? -1 : 1;
        return (b.msUntilNext ?? 0) - (a.msUntilNext ?? 0);
    });

    const dropped: number[] = [];
    let kept = [...active];
    for (const victim of order) {
        if (sumDaily(kept, burstCap) * daysAhead <= capacity) break;
        // Never drop the last reminder standing: one over-budget alarm set is
        // still better than none, and iOS will keep the first 60 of them.
        if (kept.length <= 1) break;
        kept = kept.filter((r) => r.id !== victim.id);
        dropped.push(victim.id);
    }

    if (dropped.length > 0) {
        truncations.push(
            `dropped ${dropped.length} reminder(s) [${dropped.join(', ')}] to fit ${capacity} slots` +
            ` — caregiver escalation copies first, furthest dose first`
        );
    }

    return {
        daysAhead,
        burstCap,
        dropped,
        truncations,
        projectedSlots: sumDaily(kept, burstCap) * daysAhead,
    };
}
