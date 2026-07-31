/**
 * 5.4 — the decisions the escalation job makes, with nothing it needs a database
 * or a network for.
 *
 * Split out for the same reason `utils/dose-queue-policy.ts` was on the client:
 * **every rule in here fails silently in production.** A ladder that picks the
 * wrong rung sends the wrong person a notification; a fallback that returns
 * "skip" instead of "substitute" turns the safety net off for exactly the
 * configuration D-8 added it for; a staleness cut-off that is too generous
 * pages a caregiver about last Tuesday. None of those throw, and none of them
 * are visible in a log that nobody is reading at 03:00. They are only assertable
 * if they live somewhere a test can reach without a VPC.
 *
 * The impure half — the claim query and the Expo call — is in `escalate.mjs`.
 */

/**
 * The ladder stops here. D-8 is explicitly two rungs: notify the caregiver, and
 * text the patient. There is no third thing to try, and a level that kept
 * climbing would re-send one of the two forever.
 *
 * Mirrored by `medication_doses.escalation_level`'s `CHECK (... BETWEEN 0 AND 2)`,
 * so a bug here is a constraint violation rather than a silent extra send.
 */
export const MAX_ESCALATION_LEVEL = 2;

/**
 * Minutes added to the configured delay before the server will act.
 *
 * §8's "Coordinating with 4.2": the device-local escalation alarm and this job
 * key off the same `escalation_delay_minutes`, so in the normal case they would
 * fire together and the caregiver would be told twice. The grace period lets the
 * device win whenever the device is working, and the server covers the case the
 * device cannot — the dependent's phone being off, which is the whole reason 5.4
 * exists.
 *
 * Deliberately small. It is a tie-breaker, not a second delay: every minute here
 * is a minute added to how long a genuinely unresponsive patient goes unnoticed.
 */
export const ESCALATION_GRACE_MINUTES = 2;

/**
 * How late a dose can be and still be worth escalating.
 *
 * **Not in the plan, and the plan is incomplete without it.** §8's query has no
 * upper bound on lateness, which is fine in steady state and wrong twice:
 *
 * - **On first deployment.** Every unconfirmed dose already in the window
 *   becomes eligible in the same run. Without a cut-off the job's first act is
 *   to escalate a backlog — the single loudest possible way to introduce a
 *   feature whose entire purpose is to be trusted when it fires.
 * - **After any outage.** Same shape, smaller: the job stops for six hours and
 *   then tells a caregiver about six hours of doses at once.
 *
 * D-2 already says missed doses are never replayed, and this is that principle
 * applied to escalation: a dose nobody acted on yesterday is the missed list's
 * job (D-4, 5.7), not an alarm's.
 *
 * 24 hours rather than something tighter because the worst-case rung-2 time is
 * `2 × 240 + 2` minutes ≈ 8 hours at the maximum configurable delay, and a
 * cut-off below that would silently disable the second rung for anyone using a
 * long delay. This leaves room above it without letting a backlog through.
 */
export const ESCALATION_MAX_LATENESS_HOURS = 24;

/** Expo rejects a push request carrying more than 100 messages. */
export const EXPO_PUSH_CHUNK_SIZE = 100;

/**
 * The two things escalation can do, as data rather than as branches.
 *
 * Channel and audience are **not independent**, which is easy to miss when
 * reading D-8's "escalation order is configurable": push always goes to the
 * caregiver and SMS always goes to the patient. `escalation_order` chooses the
 * sequence of these two fixed actions, not a free combination of channel and
 * recipient. Modelling it as a pair of constants makes the impossible
 * combinations unrepresentable.
 */
export const PUSH_CAREGIVER = Object.freeze({ channel: 'push', audience: 'caregiver' });
export const SMS_PATIENT = Object.freeze({ channel: 'sms', audience: 'patient' });

const LADDERS = Object.freeze({
    caregiver_first: Object.freeze([PUSH_CAREGIVER, SMS_PATIENT]),
    sms_first: Object.freeze([SMS_PATIENT, PUSH_CAREGIVER]),
});

/**
 * Which rung fires next for a dose at `currentLevel`.
 *
 * `currentLevel` is the value already stored — 0 for a dose that has never
 * escalated — so the rung being taken is `currentLevel + 1` and indexes the
 * ladder at `currentLevel`. Returns null past the top so the caller has one
 * obvious stop condition rather than a comparison it can get backwards.
 *
 * An unrecognised order falls back to `caregiver_first` rather than throwing:
 * the column has a CHECK constraint, so a bad value means someone bypassed the
 * API, and refusing to escalate at all is the worse of the two failures.
 */
export function rungFor(currentLevel, escalationOrder) {
    if (!Number.isInteger(currentLevel) || currentLevel < 0) return null;
    if (currentLevel >= MAX_ESCALATION_LEVEL) return null;
    const ladder = LADDERS[escalationOrder] ?? LADDERS.caregiver_first;
    return ladder[currentLevel] ?? null;
}

/**
 * D-8's channel fallback: a configured channel that cannot send must fall
 * through to the other one, not quietly do nothing.
 *
 * `availability` is per-dose, not global — `push` means *this dependent's
 * caregiver* has at least one registered token, `sms` means the patient's number
 * is verified and the SMS transport is actually out of the sandbox.
 *
 * **When only one channel is available, both rungs collapse onto it and the
 * patient's caregiver is notified twice.** That reads like a bug and is not one:
 * the second rung firing at all means the patient still had not responded a full
 * delay later, and D-8's intent is that both rungs fire. Sending the same thing
 * twice is a worse experience than two different channels and a much better one
 * than silence.
 */
export function resolveDispatch(rung, availability) {
    if (!rung) return { action: null, skipped: true, reason: 'ladder-exhausted' };

    const can = (action) => availability?.[action.channel] === true;
    if (can(rung)) return { action: rung, substituted: false, skipped: false };

    const other = rung === PUSH_CAREGIVER ? SMS_PATIENT : PUSH_CAREGIVER;
    if (can(other)) {
        return {
            action: other,
            substituted: true,
            skipped: false,
            substitutedFrom: rung.channel,
            reason: `${rung.channel}-unavailable`,
        };
    }

    return { action: null, skipped: true, reason: 'no-channel-available' };
}

/**
 * D-12's circuit breaker, as a predicate rather than as a SQL fragment nobody
 * can test.
 *
 * D-6 makes a snooze re-anchor the escalation clock, which is right — a patient
 * who snoozes is demonstrably awake. Unbounded, it means escalation never
 * happens for the patient who snoozes an insulin dose five times, who is
 * precisely who it exists for. Above the threshold the snooze stops counting and
 * the clock runs from the original due time.
 *
 * Note the comparison is **strictly greater than**, matching the
 * `escalates_regardless` flag 5.1 already returns on the snooze response — the
 * client and the job must agree on which snooze is the last forgiving one.
 */
export function anchorFor(dose, threshold) {
    const snoozeCount = dose?.snooze_count ?? 0;
    if (snoozeCount > threshold) return dose.scheduled_for;
    return dose?.snoozed_until ?? dose?.scheduled_for;
}

/** Split messages into Expo-sized batches. */
export function chunk(items, size = EXPO_PUSH_CHUNK_SIZE) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const n = Number.isInteger(size) && size > 0 ? size : EXPO_PUSH_CHUNK_SIZE;
    const out = [];
    for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
    return out;
}

/**
 * Expo error codes that mean the token is dead and should be deleted.
 *
 * `DeviceNotRegistered` is the ordinary one — the app was uninstalled, or the
 * token was rotated. The two credential errors are deliberately **not** here:
 * they mean *this project's* push credentials are wrong, so every token looks
 * dead, and reaping on them would empty `push_tokens` for a reason that has
 * nothing to do with the devices. That is an unrecoverable state — every user
 * would have to reopen the app to re-register — caused by a misconfiguration
 * that a redeploy fixes.
 */
const REAPABLE_ERRORS = new Set(['DeviceNotRegistered']);

const RETRYABLE_ERRORS = new Set(['MessageRateExceeded']);

/**
 * Classify one Expo ticket or receipt into what the caller should do about it.
 *
 * The two payloads have the same relevant shape — `status` plus
 * `details.error` — so one classifier serves both, which is what keeps the
 * ticket path and the (later) receipt path from drifting apart.
 *
 * Unknown errors are `fail`, not `retry`: retrying something Expo has already
 * refused is how a job turns one bad message into a rate-limit ban.
 */
export function classifyPushResult(result) {
    if (!result || result.status === 'ok') return 'ok';
    const code = result?.details?.error;
    if (REAPABLE_ERRORS.has(code)) return 'reap';
    if (RETRYABLE_ERRORS.has(code)) return 'retry';
    return 'fail';
}

/**
 * Pair Expo's positional ticket array back onto the tokens that produced it, and
 * return the tokens worth deleting.
 *
 * **Expo answers positionally and says nothing about which token a ticket
 * belongs to.** If the two arrays are ever misaligned the consequence is not a
 * crash — it is deleting a working device's token because a different device was
 * uninstalled. So a length mismatch reaps nothing at all and reports itself,
 * rather than zipping as far as it can.
 */
export function tokensToReap(tokens, results) {
    if (!Array.isArray(tokens) || !Array.isArray(results)) return { reap: [], misaligned: true };
    if (tokens.length !== results.length) return { reap: [], misaligned: true };
    const reap = [];
    for (let i = 0; i < results.length; i += 1) {
        if (classifyPushResult(results[i]) === 'reap') reap.push(tokens[i]);
    }
    return { reap, misaligned: false };
}
