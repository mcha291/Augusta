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
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

/** 5.9 — outbox rows drained per run. Same reasoning as `CLAIM_LIMIT`. */
const OUTBOX_LIMIT = 200;

/**
 * 5.9 — how many failed drains before a queued push is abandoned.
 *
 * Without a ceiling, an Expo outage builds a backlog that every subsequent run
 * re-reads forever. Abandoning is cheap here in a way it is not for an
 * escalation: the launch re-sync (4.1) is the backstop for a silent push that
 * never arrives, and §8 is explicit that this channel is an optimisation and
 * never a guarantee.
 */
const OUTBOX_MAX_ATTEMPTS = 5;

/**
 * 5.8 — how long to wait before asking Expo for a receipt, and how long to keep
 * asking.
 *
 * Expo returns tickets synchronously and receipts only some minutes later, so a
 * poll that runs immediately gets nothing and burns a request. It keeps receipts
 * for roughly 24 hours, after which a ticket will never be answered and is
 * closed out rather than polled for the rest of time.
 */
const RECEIPT_MIN_AGE_MINUTES = 5;
const RECEIPT_GIVE_UP_HOURS = 24;
const RECEIPT_LIMIT = 300;

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
 * 5.9 — the pending outbox rows, oldest first.
 *
 * `FOR UPDATE ... SKIP LOCKED` for the same reason the dose claim uses it: two
 * overlapping runs must not both send the same push. Unlike the claim this does
 * not mark anything — the row is closed out by `outbox-done` after Expo has
 * actually been called, because the alternative loses the push entirely if the
 * send then fails.
 */
const OUTBOX_SQL = `
    SELECT id, user_id
    FROM push_outbox
    WHERE sent_at IS NULL
      AND attempts < $2
    ORDER BY created_at
    LIMIT $1
    FOR UPDATE SKIP LOCKED`;

/**
 * Every device that should hear about a change to this user's schedule.
 *
 * **The owner's devices *and* their active caregivers'**, which is one step
 * wider than §8's "the owner's devices" and is deliberate. Under 4.2 item 2 a
 * caregiver's phone holds escalation copies of every escalation-enabled reminder
 * their dependent has, and those copies go stale on exactly the edit that
 * enqueued this row. Leaving them out would mean the one server-to-device
 * channel in the system reaches only half the devices holding the schedule.
 *
 * Resolved here rather than at enqueue time so a relationship created between
 * the write and the drain is still honoured — and so a revoked one is not.
 */
const OUTBOX_RECIPIENTS_SQL = `
    SELECT u.id AS owner_user_id,
           ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.token), NULL) AS tokens
    FROM UNNEST($1::int[]) AS u(id)
    LEFT JOIN push_tokens p
      ON p.user_id = u.id
      OR p.user_id IN (
           SELECT r.caregiver_id FROM user_relationships r
           WHERE r.dependent_id = u.id AND r.status = 'active'
         )
    GROUP BY u.id`;

/**
 * Ids from an untrusted payload, as integers, with everything else dropped.
 *
 * **`Number(null)` is 0 and `Number('')` is 0, and both pass
 * `Number.isInteger`** — so the obvious `.map(Number).filter(Number.isInteger)`
 * silently turns a null in the payload into a request to update row 0. Harmless
 * against a SERIAL column that starts at 1, and exactly the shape of quiet
 * coercion this plan keeps finding the hard way, so the type is checked before
 * the coercion rather than after it.
 */
function intIds(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const v of value) {
        if (typeof v !== 'number' && typeof v !== 'string') continue;
        if (String(v).trim() === '') continue;
        const n = Number(v);
        if (Number.isInteger(n)) out.push(n);
    }
    return out;
}

/**
 * The VPC-attached half. Several operations, selected by `op`.
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

    // --- 5.9: the silent schedule-change push -------------------------------

    if (op === 'drain-outbox') {
        const pending = await pool.query(OUTBOX_SQL, [OUTBOX_LIMIT, OUTBOX_MAX_ATTEMPTS]);
        if (pending.rows.length === 0) return { batches: [], abandoned: 0 };

        // **Grouped by subject, so several edits are one push.** Editing four
        // reminders in a minute enqueues four rows and sends one notification
        // per device, which matters because iOS rate-limits silent pushes.
        const byUser = new Map();
        for (const row of pending.rows) {
            if (!byUser.has(row.user_id)) byUser.set(row.user_id, { ownerUserId: row.user_id, outboxIds: [] });
            byUser.get(row.user_id).outboxIds.push(row.id);
        }

        const recipients = await pool.query(OUTBOX_RECIPIENTS_SQL, [[...byUser.keys()]]);
        for (const row of recipients.rows) {
            const batch = byUser.get(row.owner_user_id);
            if (batch) batch.tokens = (row.tokens ?? []).filter(Boolean);
        }

        return { batches: [...byUser.values()].map((b) => ({ ...b, tokens: b.tokens ?? [] })) };
    }

    if (op === 'outbox-done') {
        // Marked sent whether or not anything was delivered. A user with no
        // registered device is *finished*, not failed — retrying them every
        // minute forever would be the same silent-backlog trap the attempt
        // ceiling exists to prevent.
        const ids = intIds(event.ids);
        if (ids.length === 0) return { done: 0 };
        const res = await pool.query(
            'UPDATE push_outbox SET sent_at = now(), attempts = attempts + 1 WHERE id = ANY($1::int[]) AND sent_at IS NULL',
            [ids]
        );
        return { done: res.rowCount };
    }

    if (op === 'outbox-failed') {
        // Left pending, attempt counted. `OUTBOX_SQL` stops selecting the row
        // once it has been counted `OUTBOX_MAX_ATTEMPTS` times.
        const ids = intIds(event.ids);
        if (ids.length === 0) return { failed: 0 };
        const res = await pool.query(
            'UPDATE push_outbox SET attempts = attempts + 1 WHERE id = ANY($1::int[]) AND sent_at IS NULL',
            [ids]
        );
        return { failed: res.rowCount };
    }

    // --- 5.8: tickets and receipts ------------------------------------------

    if (op === 'record-tickets') {
        const tickets = Array.isArray(event.tickets) ? event.tickets : [];
        const rows = tickets.filter((t) => t && typeof t.ticketId === 'string' && typeof t.token === 'string');
        if (rows.length === 0) return { recorded: 0 };

        // One statement rather than a loop: this runs inside a scheduled job
        // whose whole batch shares a connection, and `ON CONFLICT DO NOTHING`
        // makes a re-record idempotent rather than an error.
        const res = await pool.query(
            `INSERT INTO push_tickets (ticket_id, token, kind)
             SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])
             ON CONFLICT (ticket_id) DO NOTHING`,
            [rows.map((r) => r.ticketId), rows.map((r) => r.token), rows.map((r) => r.kind ?? 'unknown')]
        );
        return { recorded: res.rowCount };
    }

    if (op === 'due-receipts') {
        // Old enough that Expo may have an answer, young enough that it still
        // keeps one.
        const due = await pool.query(
            `SELECT ticket_id, token, kind FROM push_tickets
             WHERE checked_at IS NULL
               AND created_at <= now() - ($1 || ' minutes')::interval
               AND created_at >  now() - ($2 || ' hours')::interval
             ORDER BY created_at
             LIMIT $3`,
            [String(RECEIPT_MIN_AGE_MINUTES), String(RECEIPT_GIVE_UP_HOURS), RECEIPT_LIMIT]
        );

        // Anything past the window will never be answered. Closing it out is
        // what stops the unchecked set growing without bound, and 'expired'
        // records that the delivery outcome is unknown rather than fine.
        const expired = await pool.query(
            `UPDATE push_tickets SET checked_at = now(), status = 'expired'
             WHERE checked_at IS NULL AND created_at <= now() - ($1 || ' hours')::interval`,
            [String(RECEIPT_GIVE_UP_HOURS)]
        );

        return { due: due.rows, expired: expired.rowCount };
    }

    if (op === 'receipts-checked') {
        const results = Array.isArray(event.results) ? event.results : [];
        const rows = results.filter((r) => r && typeof r.ticketId === 'string');
        if (rows.length === 0) return { checked: 0 };
        const res = await pool.query(
            `UPDATE push_tickets t SET checked_at = now(), status = v.status, detail = v.detail
             FROM UNNEST($1::text[], $2::text[], $3::text[]) AS v(ticket_id, status, detail)
             WHERE t.ticket_id = v.ticket_id AND t.checked_at IS NULL`,
            [
                rows.map((r) => r.ticketId),
                rows.map((r) => String(r.status ?? 'unknown')),
                rows.map((r) => (r.detail == null ? null : String(r.detail).slice(0, 500))),
            ]
        );
        return { checked: res.rowCount };
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
async function sendChunk(messages, kind) {
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
        return { sent: 0, reap: [], tickets: [], error: `expo-unreachable: ${String(e)}` };
    }

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { sent: 0, reap: [], tickets: [], error: `expo-http-${res.status}: ${detail.slice(0, 200)}` };
    }

    const parsed = await res.json().catch(() => null);
    const tickets = parsed?.data;
    if (!Array.isArray(tickets)) {
        return { sent: 0, reap: [], tickets: [], error: 'expo-malformed-response' };
    }

    const { reap, misaligned } = tokensToReap(tokens, tickets);
    const ok = tickets.filter((t) => t?.status === 'ok').length;

    // 5.8 — the ok tickets carry a receipt id, which is the only handle on
    // whether the push was ever actually delivered. Paired positionally, and
    // **not paired at all on a length mismatch**, for exactly the reason
    // `tokensToReap` refuses to: a ticket filed against the wrong token would
    // later reap a working device because a different one was uninstalled.
    const recorded = misaligned
        ? []
        : tickets
            .map((t, i) => ({ ticket: t, token: tokens[i] }))
            .filter(({ ticket }) => ticket?.status === 'ok' && typeof ticket.id === 'string')
            .map(({ ticket, token }) => ({ ticketId: ticket.id, token, kind }));

    return {
        sent: ok,
        reap,
        tickets: recorded,
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

    // One shape for every run, including the empty one. An early return with
    // fewer keys is the sort of thing a caller reads `.errors.length` off and
    // crashes on exactly when there is nothing wrong.
    const summary = {
        claimed: 0,
        pushed: 0,
        substituted: 0,
        skipped: 0,
        reaped: 0,
        // 5.9
        silent: 0,
        silentBatches: 0,
        // 5.8
        tickets: 0,
        receipts: 0,
        errors: [],
        timezone: APP_TIMEZONE,
    };

    // Collected across all three steps and acted on once at the end, because
    // both features send to the same `push_tokens` rows and a token that Expo
    // has declared dead is dead for both.
    const reap = [];
    const tickets = [];

    // **Each step is isolated, and that is the point of doing it this way.** 5.4
    // is a safety mechanism and 5.9 is an optimisation; a failure in the
    // optimisation must not be able to stop the safety mechanism, and the
    // reverse would mean an unrelated escalation bug silently freezing every
    // device's schedule. The same argument as "one dependent's missing device
    // must not stop the run", one level up.
    try {
        await runEscalation(summary, reap, tickets);
    } catch (e) {
        summary.errors.push(`escalation-failed: ${String(e)}`);
    }

    try {
        await runOutbox(summary, reap, tickets);
    } catch (e) {
        summary.errors.push(`outbox-failed: ${String(e)}`);
    }

    if (tickets.length > 0) {
        try {
            const { recorded = 0 } = await invokeDb({ op: 'record-tickets', tickets });
            summary.tickets = recorded;
        } catch (e) {
            // Costs delivery observability for this batch, nothing more: the
            // pushes have already gone.
            summary.errors.push(`record-tickets-failed: ${String(e)}`);
        }
    }

    try {
        await runReceipts(summary, reap);
    } catch (e) {
        summary.errors.push(`receipts-failed: ${String(e)}`);
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

    // **Log the quiet runs too.** They are the overwhelming majority — this runs
    // on a schedule and usually has nothing to do — and they are exactly the
    // ones worth being able to see: for a safety job that is silent by design,
    // "did it run at all?" is the only question the logs can answer, and an
    // early return that skips the summary makes a dead schedule and a quiet one
    // look identical.
    //
    // **The early return that used to sit above the work is gone**, and it had
    // to: it returned as soon as there were no doses to escalate, which is most
    // runs, and 5.9's drain and 5.8's receipts poll both live below it. Leaving
    // it would have meant the silent push worked only on the runs that happened
    // to be escalating something.
    console.info('escalation run', JSON.stringify({ startedAt, ...summary }));
    return { startedAt, ...summary };
}

/** 5.4 — claim the doses that are due a rung, and send them. */
async function runEscalation(summary, reap, tickets) {
    const { claims = [] } = await invokeDb({ op: 'claim' });
    summary.claimed = claims.length;
    if (claims.length === 0) return;

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

    for (const batch of chunk(messages)) {
        const result = await sendChunk(batch, 'dose-escalation');
        summary.pushed += result.sent;
        reap.push(...result.reap);
        tickets.push(...result.tickets);
        if (result.error) summary.errors.push(result.error);
    }
}

/**
 * 5.9 — drain the outbox `index.mjs` writes on every reminder change.
 *
 * **Per recipient batch rather than per outbox row**, which is what makes the
 * coalescing real: four edits in a minute produce four rows, one push per
 * device, and all four rows closed together. A batch is only marked failed if
 * Expo could not be reached at all — a `DeviceNotRegistered` is a *successful*
 * send to a device that no longer exists, and retrying it forever would be the
 * backlog the attempt ceiling exists to prevent.
 */
async function runOutbox(summary, reap, tickets) {
    const { batches = [] } = await invokeDb({ op: 'drain-outbox' });
    if (batches.length === 0) return;

    const done = [];
    const failed = [];

    for (const batch of batches) {
        const tokens = Array.isArray(batch.tokens) ? batch.tokens.filter(Boolean) : [];

        // Nobody to tell. Closed out rather than retried: a user with no
        // registered device is finished, not failed, and their next launch
        // reconciles anyway (4.1).
        if (tokens.length === 0) {
            done.push(...batch.outboxIds);
            continue;
        }

        summary.silentBatches += 1;
        let delivered = false;

        for (const messages of chunk(silentMessagesFor(batch.ownerUserId, tokens))) {
            const result = await sendChunk(messages, 'schedule-changed');
            summary.silent += result.sent;
            reap.push(...result.reap);
            tickets.push(...result.tickets);
            if (result.error) summary.errors.push(result.error);
            // Expo answered at all. A batch where every token turned out to be
            // dead still counts: there is nothing left to retry to.
            else delivered = true;
        }

        (delivered ? done : failed).push(...batch.outboxIds);
    }

    if (done.length > 0) {
        const { done: closed = 0 } = await invokeDb({ op: 'outbox-done', ids: done });
        void closed;
    }
    if (failed.length > 0) {
        await invokeDb({ op: 'outbox-failed', ids: failed });
        console.warn('silent push deferred for', failed.length, 'outbox row(s) — Expo was unreachable');
    }
}

/**
 * 5.9's message: **data only, with no title and no body**, which is what makes
 * it silent rather than a notification the patient sees.
 *
 * `_contentAvailable` is Expo's spelling of APNs `content-available: 1`, the
 * flag that wakes a backgrounded iOS app rather than displaying anything. It
 * needs `UIBackgroundModes: ['remote-notification']` in the built app to have
 * any effect, which `app.json` now declares — and therefore needs the native
 * rebuild that is already owed. Without it the push still arrives while the app
 * is in the foreground, which is where the launch re-sync would have caught the
 * change a moment later anyway.
 *
 * The payload carries an id and a kind and nothing else, exactly as 4.3 and 5.4
 * do. There is no medication name here to leak, but the rule is worth keeping
 * uniform rather than argued case by case.
 */
function silentMessagesFor(ownerUserId, tokens) {
    return tokens.map((token) => ({
        to: token,
        data: { kind: 'schedule-changed', ownerUserId },
        _contentAvailable: true,
        // Deliberately *not* `EXPO_INTERRUPTION_LEVEL`: this is not an alert and
        // must never present as one. A schedule change is not time-sensitive to
        // the patient — the alarms it rewrites are.
        priority: 'high',
    }));
}

/**
 * 5.8's last piece — ask Expo what actually happened to earlier sends.
 *
 * **Receipts are the only delivery observability in this system.** A ticket says
 * Expo accepted the message; a receipt says APNs or FCM did. The gap between
 * them is where a token that looks healthy quietly stops working, and until this
 * existed the only dead tokens ever reaped were the ones Expo rejected
 * synchronously.
 *
 * Note what a receipt still does not tell you: whether the notification was
 * *displayed*. Nothing in this stack can answer that.
 */
async function runReceipts(summary, reap) {
    const { due = [], expired = 0 } = await invokeDb({ op: 'due-receipts' });
    if (expired > 0) {
        console.warn('gave up on', expired, 'push receipt(s) older than', RECEIPT_GIVE_UP_HOURS, 'hours');
    }
    if (due.length === 0) return;

    const byTicket = new Map(due.map((row) => [row.ticket_id, row]));
    const results = [];

    for (const batch of chunk(due.map((row) => row.ticket_id))) {
        let res;
        try {
            res = await fetchImpl(EXPO_RECEIPTS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ ids: batch }),
            });
        } catch (e) {
            // Leave them unchecked; the next run asks again, and the give-up
            // window closes them if Expo stays unreachable.
            summary.errors.push(`receipts-unreachable: ${String(e)}`);
            continue;
        }

        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            summary.errors.push(`receipts-http-${res.status}: ${detail.slice(0, 200)}`);
            continue;
        }

        const parsed = await res.json().catch(() => null);
        const data = parsed?.data;
        if (!data || typeof data !== 'object') {
            summary.errors.push('receipts-malformed-response');
            continue;
        }

        // **Keyed by ticket id, not positional** — unlike the send response,
        // which is an array. So the misalignment hazard §0.6 records for
        // `tokensToReap` does not apply here: Expo names the ticket, and a
        // ticket names exactly one token in our own table.
        for (const [ticketId, receipt] of Object.entries(data)) {
            const row = byTicket.get(ticketId);
            if (!row) continue;

            const status = receipt?.status === 'ok' ? 'ok' : 'error';
            const reason = receipt?.details?.error ?? null;
            results.push({ ticketId, status, detail: reason ?? receipt?.message ?? null });

            if (reason === 'DeviceNotRegistered') {
                // The delayed case this whole poll exists for: Expo accepted the
                // send and only the receipt reveals the device is gone.
                reap.push(row.token);
                console.info('receipt reports a dead device for a', row.kind, 'push — reaping the token');
            } else if (status === 'error') {
                console.warn('push receipt error for a', row.kind, 'push:', reason ?? receipt?.message);
            }
        }
    }

    if (results.length > 0) {
        const { checked = 0 } = await invokeDb({ op: 'receipts-checked', results });
        summary.receipts = checked;
    }
}
