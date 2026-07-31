/**
 * 5.4 — server-side caregiver escalation, and 5.8's send half.
 *
 * This is the layer that survives the dependent's phone being off entirely,
 * which 4.2's device-local copy cannot: the device can only escalate if the
 * device is running.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS TWO HANDLERS IN ONE FILE
 * ---------------------------------------------------------------------------
 *
 * §8 describes 5.4 as "EventBridge schedule -> small Lambda", singular. That
 * cannot work in this account, and the reason is worth stating because it is
 * invisible until you try it:
 *
 * - RDS is private and `tish-rds-sg` admits 5432 from the Lambda security group
 *   only (D3/D3b), so reading `medication_doses` requires being **inside** the
 *   VPC.
 * - The VPC has no NAT gateway and no interface endpoints, and its subnets route
 *   0.0.0.0/0 to an internet gateway — which a Lambda ENI cannot use, because
 *   Lambda ENIs are never assigned public IPs. So a VPC-attached function has
 *   **no outbound internet**, and `exp.host` is on the internet.
 *
 * Verified rather than reasoned about, 2026-07-31: the same throwaway function,
 * same code, aborted at a 6s timeout while VPC-attached and returned HTTP 200
 * from `exp.host` in 2.1s with the VPC detached.
 *
 * So the work is split by what each half is *allowed to reach*:
 *
 * - `dispatchHandler` — **not** VPC-attached. The EventBridge target. Has the
 *   internet, so it talks to Expo. Cannot see the database.
 * - `dbHandler` — VPC-attached. Runs the claim and the reap. Has the database,
 *   cannot see the internet.
 *
 * The dispatcher drives, and invokes the database half through the Lambda API.
 * That direction is the one that works without buying anything: a non-VPC
 * function can call the Lambda API freely, whereas the reverse would need an
 * interface endpoint. Owner's decision, 2026-07-31, over adding a NAT gateway.
 *
 * **Neither handler is reachable through API Gateway.** They are separate
 * functions rather than routes on `index.mjs` precisely so that the root
 * `/{proxy+}` cannot reach them — adding an internal route would have recreated
 * the P0.1 class of problem that §0.7 warns about for migrations.
 *
 * Both are deployed from the same zip as `index.mjs`, so a deploy is one build
 * and three `update-function-code` calls.
 */

import pg from 'pg';
import {
    SNOOZE_ESCALATION_THRESHOLD,
    APP_TIMEZONE,
} from './index.mjs';
import {
    MAX_ESCALATION_LEVEL,
    ESCALATION_GRACE_MINUTES,
    ESCALATION_MAX_LATENESS_HOURS,
    rungFor,
    resolveDispatch,
    chunk,
    tokensToReap,
} from './escalation-policy.mjs';

const { Pool } = pg;

// Same rule as index.mjs: credentials come only from the environment. This file
// is committed to a repo with a remote.
let pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 5432,
    ssl: { rejectUnauthorized: false },
});

/**
 * Test seams, matching `index.mjs`'s `_setPoolForTests`.
 *
 * `_setFetchForTests` and `_setInvokerForTests` exist because the two things
 * this file does that cannot be exercised locally — calling Expo and invoking
 * another Lambda — are also the two things most worth asserting. Without them
 * the dispatcher is only testable by deploying it.
 */
export function _setPoolForTests(fakePool) { pool = fakePool; }

let fetchImpl = (...args) => globalThis.fetch(...args);
export function _setFetchForTests(fake) { fetchImpl = fake; }

let invokeDb = defaultInvokeDb;
export function _setInvokerForTests(fake) { invokeDb = fake ?? defaultInvokeDb; }

/**
 * How many doses one run will claim.
 *
 * A bound rather than "everything due" because the dispatcher holds the whole
 * batch in memory and Expo is called in chunks of 100. At the current scale this
 * will never bind; it exists so that a backlog produces several ordinary runs
 * instead of one run that times out and retries forever, escalating nothing.
 */
const CLAIM_LIMIT = 500;

const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * iOS urgency for a server-sent push — and **it is spelled differently here than
 * it is on the device.**
 *
 * 5.3 sets `interruptionLevel: 'timeSensitive'` through `expo-notifications` on
 * the client, and that is correct there. Expo's *push HTTP API* validates
 * against `'active' | 'critical' | 'passive' | 'time-sensitive'` — kebab-case —
 * and rejects the camelCase spelling with a 400 for the whole request. Same
 * concept, two casings, and copying the working client value across is the
 * obvious thing to do.
 *
 * Found only by sending a real request: the mocked `fetch` in the tests accepted
 * anything, so the suite was green while every live send failed. That is why
 * there is now a test pinning this exact literal — it cannot catch a future
 * change to Expo's enum, but it does stop someone "tidying" it back into
 * camelCase to match the client.
 */
const EXPO_INTERRUPTION_LEVEL = 'time-sensitive';

/**
 * SMS is D-8's other rung and it cannot send yet.
 *
 * `sms_first` is not selectable in the UI (4.6) and SNS is still sandboxed in
 * `ap-east-2` pending Track B, so the patient's number on file has never been
 * verified through Cognito — texting a medication reminder to an unverified
 * number risks sending PHI to a stranger, which is the constraint D-8 states
 * explicitly.
 *
 * Leaving this false is what makes the channel fallback load-bearing rather than
 * theoretical: today *every* SMS rung substitutes to push. That is D-8's
 * intended behaviour for an unavailable channel, and it means a `sms_first`
 * reminder still escalates rather than silently doing nothing.
 *
 * Flip to true only when 5.5 lands and numbers are actually verified.
 */
const SMS_AVAILABLE = false;

/**
 * The notification copy, mirroring `notifications.doseEscalation*` in the two
 * locale files.
 *
 * **This duplicates strings that already exist on the client, and that is a
 * known cost rather than an oversight.** The server has no i18n layer, and more
 * to the point there is no `users.locale` column to select against — the same
 * gap as `users.timezone` (§0.6), and it wants the same fix: the migration
 * runner that has never been built. Until then the server picks the product's
 * language, which is correct for a Taiwan-facing zh-Hant app and wrong the
 * moment that stops being true.
 *
 * The wording is 4.2's, deliberately: it names neither the medication nor the
 * patient, because a push notification is readable on a locked phone. Keep them
 * in step if either locale file changes.
 */
const MESSAGES = {
    'zh-Hant': {
        title: '⚠️ 尚未確認服藥',
        body: '您照顧的對象可能錯過了一次服藥。點擊查看。',
    },
    en: {
        title: '⚠️ UNCONFIRMED DOSE',
        body: 'Someone you care for may have missed a dose. Tap to check.',
    },
};
const DEFAULT_LOCALE = 'zh-Hant';

/**
 * Claim every dose that is due for escalation, incrementing its level in the
 * same statement.
 *
 * **The increment happens before dispatch, not after, and §8 is explicit about
 * why**: a retry or a concurrent run must not be able to send the same rung
 * twice. The cost is the opposite failure — a send that fails after the claim
 * loses that rung — and it is the better of the two, because the *next* rung
 * fires a full delay later and acts as a natural retry at higher urgency. A
 * caregiver notified once late beats a caregiver notified four times.
 *
 * `FOR UPDATE ... SKIP LOCKED` is what makes two overlapping runs safe: the
 * second run sees the first run's claimed rows as locked and passes over them
 * rather than blocking or double-claiming.
 */
const CLAIM_SQL = `
    WITH due AS (
        SELECT d.id
        FROM medication_doses d
        JOIN medication_reminders r ON r.id = d.reminder_id
        WHERE r.escalation_enabled
          AND r.status = 'active'
          AND d.confirmed_at IS NULL
          AND d.escalation_level < $1
          -- The lateness floor. Without it the first run after a deploy or an
          -- outage escalates a backlog; see ESCALATION_MAX_LATENESS_HOURS.
          AND d.scheduled_for > now() - ($2 || ' hours')::interval
          AND (
                CASE WHEN d.snooze_count > $3
                     THEN d.scheduled_for
                     ELSE COALESCE(d.snoozed_until, d.scheduled_for)
                END
                + (((d.escalation_level + 1) * r.escalation_delay_minutes + $4) || ' minutes')::interval
              ) < now()
        ORDER BY d.scheduled_for
        FOR UPDATE OF d SKIP LOCKED
        LIMIT $5
    )
    UPDATE medication_doses SET
        escalation_level = escalation_level + 1,
        last_escalated_at = now()
    WHERE id IN (SELECT id FROM due)
    RETURNING id, reminder_id, user_id, scheduled_for, snoozed_until, snooze_count, escalation_level`;

/**
 * Everything the dispatcher needs about a claimed dose, in one round trip.
 *
 * The caregiver tokens are aggregated in the subquery rather than fetched per
 * dose: one dependent may have several caregivers and each caregiver several
 * devices, and doing it row-by-row would turn one run into dozens of queries
 * across the VPC boundary.
 */
const ENRICH_SQL = `
    SELECT d.id                      AS dose_id,
           d.user_id                 AS patient_id,
           d.scheduled_for,
           d.escalation_level,
           r.escalation_order,
           u.phone_number            AS patient_phone,
           -- Migration 005. Note this is the *patient's* locale, and the
           -- notification goes to their caregiver — see messagesFor.
           u.locale                  AS patient_locale,
           COALESCE(
             (SELECT array_agg(DISTINCT pt.token)
                FROM user_relationships ur
                JOIN push_tokens pt ON pt.user_id = ur.caregiver_id
               WHERE ur.dependent_id = d.user_id
                 AND ur.status = 'active'),
             ARRAY[]::text[]
           )                         AS caregiver_tokens
    FROM medication_doses d
    JOIN medication_reminders r ON r.id = d.reminder_id
    JOIN users u                ON u.id = d.user_id
    WHERE d.id = ANY($1::int[])`;

/**
 * The VPC-attached half. Two operations, selected by `op`.
 *
 * Invoked only by `dispatchHandler` through the Lambda API — never by API
 * Gateway, which has no route to this function.
 */
export async function dbHandler(event) {
    const op = event?.op;

    if (op === 'claim') {
        const claimed = await pool.query(CLAIM_SQL, [
            MAX_ESCALATION_LEVEL,
            ESCALATION_MAX_LATENESS_HOURS,
            SNOOZE_ESCALATION_THRESHOLD,
            ESCALATION_GRACE_MINUTES,
            CLAIM_LIMIT,
        ]);

        if (claimed.rows.length === 0) return { claims: [] };

        const ids = claimed.rows.map((r) => r.id);
        const enriched = await pool.query(ENRICH_SQL, [ids]);
        return { claims: enriched.rows };
    }

    if (op === 'reap') {
        // 5.8's dead-token half. Deleting by token alone, without scoping to a
        // user, is correct *here* and only here: Expo has told us this device
        // address is dead, which is a fact about the device rather than about
        // whoever currently owns the row. The same reasoning as 2.5's UNIQUE.
        const tokens = Array.isArray(event.tokens) ? event.tokens.filter((t) => typeof t === 'string') : [];
        if (tokens.length === 0) return { removed: 0 };
        const res = await pool.query('DELETE FROM push_tokens WHERE token = ANY($1::text[])', [tokens]);
        return { removed: res.rowCount };
    }

    return { error: `unknown op: ${String(op)}` };
}

/**
 * Invoke the VPC-attached half.
 *
 * Imported lazily so the tests never load the SDK — every test substitutes this
 * through `_setInvokerForTests`, and a top-level import would make the whole
 * suite depend on a package that is deliberately not in the deployment zip.
 *
 * **`@aws-sdk/client-lambda` is a devDependency, not a dependency, and that is
 * intentional.** The Node.js managed runtime provides the v3 SDK, so bundling it
 * would add megabytes to a 180KB zip for a module already present at execution.
 * Declaring it as a devDependency is what lets eslint resolve the specifier and
 * keeps `npm ci --omit=dev` from shipping it. The load-bearing assumption is
 * that the runtime really does provide it, which is verified against the
 * deployed function rather than trusted — see the deploy notes in §0.
 *
 * Payload marshalling uses TextEncoder/TextDecoder rather than Buffer so this
 * file has no Node-only globals in it.
 */
async function defaultInvokeDb(payload) {
    const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
    const client = new LambdaClient({});
    const res = await client.send(new InvokeCommand({
        FunctionName: process.env.ESCALATION_DB_FUNCTION,
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }));
    const raw = res.Payload ? new TextDecoder().decode(res.Payload) : '';
    if (res.FunctionError) throw new Error(`db half failed: ${raw.slice(0, 300)}`);
    return raw ? JSON.parse(raw) : {};
}

/**
 * Build the Expo messages for one claimed dose.
 *
 * The payload deliberately mirrors 4.3's slimmed local one — ids and a kind,
 * nothing resolvable — so the client's existing handling applies and nothing
 * medical rides in a push body that iOS caches on a locked screen.
 */
function messagesFor(claim, tokens) {
    // **The patient's locale, used for a message their caregiver reads**, which
    // is the wrong person's preference and is the best available answer. The
    // right one is the caregiver's own `users.locale`, but a dose has one
    // patient and possibly several caregivers with different languages, so
    // "the" locale for a batch does not exist — picking correctly means
    // grouping the tokens by caregiver and rendering per group. Worth doing when
    // a household actually spans two languages; today every row is zh-Hant, so
    // it would be machinery serving nobody. The fallback chain keeps it safe
    // either way: an unrecognised locale degrades to the product's language
    // rather than to no notification.
    const copy = MESSAGES[claim.patient_locale] ?? MESSAGES[DEFAULT_LOCALE] ?? MESSAGES.en;
    return tokens.map((token) => ({
        to: token,
        title: copy.title,
        body: copy.body,
        sound: 'default',
        priority: 'high',
        // Matches 5.3's device-side urgency so a server escalation is as
        // interruptive as the local one it stands in for — but note the casing
        // differs from the client's. See EXPO_INTERRUPTION_LEVEL.
        interruptionLevel: EXPO_INTERRUPTION_LEVEL,
        data: {
            kind: 'dose-escalation',
            doseId: claim.dose_id,
            ownerUserId: claim.patient_id,
            scheduledFor: claim.scheduled_for,
            escalationLevel: claim.escalation_level,
        },
    }));
}

/**
 * POST one chunk to Expo and pair the tickets back onto the tokens that
 * produced them.
 *
 * Expo answers positionally, so `tokensToReap` refuses to reap at all on a
 * length mismatch rather than deleting a working device's token because a
 * different device was uninstalled.
 */
async function sendChunk(messages) {
    const tokens = messages.map((m) => m.to);
    let res;
    try {
        res = await fetchImpl(EXPO_SEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(messages),
        });
    } catch (e) {
        // Network failure. The rung is already claimed and is not retried here —
        // the next rung is the retry. Reap nothing: an unreachable Expo says
        // nothing about whether these devices exist.
        return { sent: 0, reap: [], error: `expo-unreachable: ${String(e)}` };
    }

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { sent: 0, reap: [], error: `expo-http-${res.status}: ${detail.slice(0, 200)}` };
    }

    const parsed = await res.json().catch(() => null);
    const tickets = parsed?.data;
    if (!Array.isArray(tickets)) {
        return { sent: 0, reap: [], error: 'expo-malformed-response' };
    }

    const { reap, misaligned } = tokensToReap(tokens, tickets);
    const ok = tickets.filter((t) => t?.status === 'ok').length;
    return {
        sent: ok,
        reap,
        error: misaligned ? 'expo-ticket-count-mismatch' : null,
    };
}

/**
 * The EventBridge target. Not VPC-attached, so this is the half with internet.
 *
 * Returns a summary rather than throwing on a partial failure: one dependent's
 * caregiver having no registered device must not stop the run that escalates
 * everybody else's.
 */
export async function dispatchHandler() {
    const startedAt = new Date().toISOString();
    const { claims = [] } = await invokeDb({ op: 'claim' });

    // One shape for every run, including the empty one. An early return with
    // fewer keys is the sort of thing a caller reads `.errors.length` off and
    // crashes on exactly when there is nothing wrong.
    const summary = {
        claimed: claims.length,
        pushed: 0,
        substituted: 0,
        skipped: 0,
        reaped: 0,
        errors: [],
        timezone: APP_TIMEZONE,
    };

    // **Log the quiet runs too.** They are the overwhelming majority — this runs
    // every five minutes and usually has nothing to do — and they are exactly
    // the ones worth being able to see: for a safety job that is silent by
    // design, "did it run at all?" is the only question the logs can answer, and
    // an early return that skips the summary makes a dead schedule and a quiet
    // one look identical.
    if (claims.length === 0) {
        console.info('escalation run', JSON.stringify({ startedAt, ...summary }));
        return { startedAt, ...summary };
    }

    const messages = [];

    for (const claim of claims) {
        const tokens = Array.isArray(claim.caregiver_tokens) ? claim.caregiver_tokens.filter(Boolean) : [];
        const availability = {
            push: tokens.length > 0,
            sms: SMS_AVAILABLE && Boolean(claim.patient_phone),
        };

        // `escalation_level` in the claim is the value *after* the increment, so
        // the rung that was just claimed is the one at level - 1.
        const rung = rungFor(claim.escalation_level - 1, claim.escalation_order);
        const decision = resolveDispatch(rung, availability);

        if (decision.skipped) {
            summary.skipped += 1;
            console.warn('escalation skipped for dose', claim.dose_id, decision.reason);
            continue;
        }
        if (decision.substituted) {
            summary.substituted += 1;
            // D-8 requires the substitution to be logged, not just performed.
            console.info(
                'escalation substituted channel for dose', claim.dose_id,
                'from', decision.substitutedFrom, 'to', decision.action.channel,
                '-', decision.reason
            );
        }

        if (decision.action.channel === 'push') {
            messages.push(...messagesFor(claim, tokens));
        } else {
            // Unreachable while SMS_AVAILABLE is false — resolveDispatch would
            // have substituted. Here so 5.5 has one obvious place to land.
            summary.skipped += 1;
            console.warn('sms rung reached but no transport is wired for dose', claim.dose_id);
        }
    }

    const reap = [];
    for (const batch of chunk(messages)) {
        const result = await sendChunk(batch);
        summary.pushed += result.sent;
        reap.push(...result.reap);
        if (result.error) summary.errors.push(result.error);
    }

    if (reap.length > 0) {
        try {
            const { removed = 0 } = await invokeDb({ op: 'reap', tokens: [...new Set(reap)] });
            summary.reaped = removed;
        } catch (e) {
            // A failed reap costs a wasted send next run, nothing more.
            summary.errors.push(`reap-failed: ${String(e)}`);
        }
    }

    console.info('escalation run', JSON.stringify({ startedAt, ...summary }));
    return { startedAt, ...summary };
}
