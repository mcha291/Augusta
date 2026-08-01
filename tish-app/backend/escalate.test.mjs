// 5.4 — functional tests for the escalation job. The real handlers are invoked;
// only the pool, `fetch` and the cross-Lambda invoke are substituted through the
// seams in escalate.mjs. Run: npm test
//
// These assert the things a device could not show us and a green deploy would
// hide: that the level is incremented in the same statement that selects the
// row, that a channel with no transport substitutes rather than skipping, and
// that a mismatched Expo response reaps nothing.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    dbHandler,
    dispatchHandler,
    _setPoolForTests,
    _setFetchForTests,
    _setInvokerForTests,
} from './escalate.mjs';
import { SNOOZE_ESCALATION_THRESHOLD } from './index.mjs';
import { MAX_ESCALATION_LEVEL, ESCALATION_GRACE_MINUTES } from './escalation-policy.mjs';

function makePool(routes = []) {
    const calls = [];
    return {
        calls,
        async query(text, params) {
            calls.push({ text, params });
            for (const r of routes) {
                if (r.match.test(text)) {
                    if (r.throws) throw r.throws;
                    return typeof r.result === 'function' ? r.result(text, params) : r.result;
                }
            }
            return { rows: [], rowCount: 0 };
        },
    };
}

/** One claimed dose, already enriched, with sane defaults. */
function claim(over = {}) {
    return {
        dose_id: 1,
        patient_id: 2,
        scheduled_for: '2026-07-31T00:00:00.000Z',
        escalation_level: 1,
        escalation_order: 'caregiver_first',
        patient_phone: '+886936450735',
        patient_locale: 'zh-Hant',
        caregiver_tokens: ['ExponentPushToken[aaa]'],
        ...over,
    };
}

function expoOk(count) {
    return {
        ok: true,
        status: 200,
        json: async () => ({ data: Array.from({ length: count }, (_, i) => ({ status: 'ok', id: `t${i}` })) }),
        text: async () => '',
    };
}

let pool;
beforeEach(() => {
    pool = makePool();
    _setPoolForTests(pool);
    _setFetchForTests(async () => expoOk(1));
    _setInvokerForTests(async () => ({ claims: [] }));
});

// ---------------------------------------------------------------------------
// dbHandler — the claim
// ---------------------------------------------------------------------------

test('the claim increments the level in the same statement that selects the row', async () => {
    // §8's "before dispatching, so a retry or a concurrent run can't
    // double-send". A SELECT followed by a separate UPDATE would reopen exactly
    // that window.
    pool = makePool([{ match: /UPDATE medication_doses/, result: { rows: [], rowCount: 0 } }]);
    _setPoolForTests(pool);
    await dbHandler({ op: 'claim' });

    const sql = pool.calls[0].text;
    assert.match(sql, /UPDATE medication_doses/);
    assert.match(sql, /escalation_level = escalation_level \+ 1/);
    assert.match(sql, /last_escalated_at = now\(\)/);
    assert.match(sql, /RETURNING/);
});

test('the claim locks with SKIP LOCKED so overlapping runs cannot double-claim', async () => {
    await dbHandler({ op: 'claim' });
    assert.match(pool.calls[0].text, /FOR UPDATE OF d SKIP LOCKED/);
});

test('the claim passes the ladder cap, the lateness floor, the snooze threshold and the grace period', async () => {
    await dbHandler({ op: 'claim' });
    const [maxLevel, lateness, threshold, grace] = pool.calls[0].params;
    assert.equal(maxLevel, MAX_ESCALATION_LEVEL);
    assert.equal(threshold, SNOOZE_ESCALATION_THRESHOLD);
    assert.equal(grace, ESCALATION_GRACE_MINUTES);
    assert.ok(lateness > 0);
});

test('the enrich query reads the locale from users rather than assuming one', async () => {
    // Migration 005. Before it, the server had no per-user language at all and
    // hardcoded zh-Hant.
    pool = makePool([
        { match: /UPDATE medication_doses/, result: { rows: [{ id: 1 }], rowCount: 1 } },
        { match: /caregiver_tokens/, result: { rows: [claim()], rowCount: 1 } },
    ]);
    _setPoolForTests(pool);
    await dbHandler({ op: 'claim' });
    assert.match(pool.calls[1].text, /u\.locale\s+AS patient_locale/);
});

test('the notification is rendered in the locale the row carries', async () => {
    _setInvokerForTests(async (p) => (p.op === 'claim'
        ? { claims: [claim({ patient_locale: 'en' })] }
        : { removed: 0 }));
    let body;
    _setFetchForTests(async (_url, opts) => { body = JSON.parse(opts.body); return expoOk(1); });
    await dispatchHandler();
    assert.match(body[0].body, /Someone you care for/);
});

test('an unrecognised locale degrades to the product language, not to silence', async () => {
    // A wrong-language notification is a bug nobody reports; no notification at
    // all is the failure this whole phase exists to remove. The CHECK on the
    // column means this needs someone bypassing the API, so it must not throw.
    _setInvokerForTests(async (p) => (p.op === 'claim'
        ? { claims: [claim({ patient_locale: 'kl-KL' })] }
        : { removed: 0 }));
    let body;
    _setFetchForTests(async (_url, opts) => { body = JSON.parse(opts.body); return expoOk(1); });
    const out = await dispatchHandler();
    assert.equal(out.pushed, 1);
    assert.match(body[0].body, /您照顧的對象/);
});

test('the claim only considers unconfirmed doses on active, escalation-enabled reminders', async () => {
    await dbHandler({ op: 'claim' });
    const sql = pool.calls[0].text;
    assert.match(sql, /r\.escalation_enabled/);
    assert.match(sql, /r\.status = 'active'/);
    assert.match(sql, /d\.confirmed_at IS NULL/);
});

test('the claim anchors on the snooze below the threshold and on scheduled_for above it', async () => {
    // D-6 and D-12 in one CASE. Getting the comparison backwards would either
    // escalate a patient who is demonstrably awake, or never escalate one who
    // snoozes forever.
    const sql = (await dbHandler({ op: 'claim' }), pool.calls[0].text);
    assert.match(sql, /CASE WHEN d\.snooze_count > \$3/);
    assert.match(sql, /THEN d\.scheduled_for/);
    assert.match(sql, /ELSE COALESCE\(d\.snoozed_until, d\.scheduled_for\)/);
});

test('a claim that finds nothing does not run the enrich query', async () => {
    await dbHandler({ op: 'claim' });
    assert.equal(pool.calls.length, 1);
});

test('a claim that finds rows enriches exactly those ids', async () => {
    pool = makePool([
        { match: /UPDATE medication_doses/, result: { rows: [{ id: 7 }, { id: 9 }], rowCount: 2 } },
        { match: /caregiver_tokens/, result: { rows: [claim({ dose_id: 7 })], rowCount: 1 } },
    ]);
    _setPoolForTests(pool);
    const out = await dbHandler({ op: 'claim' });

    assert.deepEqual(pool.calls[1].params[0], [7, 9]);
    assert.equal(out.claims.length, 1);
    assert.equal(out.claims[0].dose_id, 7);
});

// ---------------------------------------------------------------------------
// dbHandler — the reap
// ---------------------------------------------------------------------------

test('the reap deletes by token alone, not scoped to a user', async () => {
    // Correct here and only here: Expo has reported the device address dead,
    // which is a fact about the device rather than about whoever owns the row.
    pool = makePool([{ match: /DELETE FROM push_tokens/, result: { rows: [], rowCount: 2 } }]);
    _setPoolForTests(pool);
    const out = await dbHandler({ op: 'reap', tokens: ['a', 'b'] });

    assert.match(pool.calls[0].text, /DELETE FROM push_tokens WHERE token = ANY/);
    assert.doesNotMatch(pool.calls[0].text, /user_id/);
    assert.equal(out.removed, 2);
});

test('a reap with no tokens touches the database at all', async () => {
    const out = await dbHandler({ op: 'reap', tokens: [] });
    assert.equal(out.removed, 0);
    assert.equal(pool.calls.length, 0);
});

test('a reap filters non-string tokens rather than passing them to Postgres', async () => {
    pool = makePool([{ match: /DELETE FROM push_tokens/, result: { rows: [], rowCount: 1 } }]);
    _setPoolForTests(pool);
    await dbHandler({ op: 'reap', tokens: ['good', null, 42, undefined] });
    assert.deepEqual(pool.calls[0].params[0], ['good']);
});

test('an unknown op is reported rather than silently doing nothing', async () => {
    const out = await dbHandler({ op: 'destroy-everything' });
    assert.match(out.error, /unknown op/);
    assert.equal(pool.calls.length, 0);
});

// ---------------------------------------------------------------------------
// dispatchHandler — the ladder end to end
// ---------------------------------------------------------------------------

test('an empty claim sends nothing and reports a clean run', async () => {
    let fetched = 0;
    _setFetchForTests(async () => { fetched += 1; return expoOk(0); });
    const out = await dispatchHandler();
    assert.equal(out.claimed, 0);
    assert.equal(out.pushed, 0);
    assert.equal(fetched, 0);
});

test('an empty run reports the same shape as a busy one', async () => {
    // The quiet path is the one a caller reads `.errors.length` off and crashes
    // on exactly when there is nothing wrong.
    const empty = await dispatchHandler();

    _setInvokerForTests(async (p) => (p.op === 'claim' ? { claims: [claim()] } : { removed: 0 }));
    _setFetchForTests(async () => expoOk(1));
    const busy = await dispatchHandler();

    assert.deepEqual(Object.keys(empty).sort(), Object.keys(busy).sort());
    assert.ok(Array.isArray(empty.errors));
});

test('a level-1 caregiver_first claim pushes to every caregiver token', async () => {
    _setInvokerForTests(async (p) => (p.op === 'claim'
        ? { claims: [claim({ caregiver_tokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'] })] }
        : { removed: 0 }));
    let body;
    _setFetchForTests(async (_url, opts) => { body = JSON.parse(opts.body); return expoOk(2); });

    const out = await dispatchHandler();
    assert.equal(out.pushed, 2);
    assert.equal(body.length, 2);
    assert.deepEqual(body.map((m) => m.to), ['ExponentPushToken[a]', 'ExponentPushToken[b]']);
});

test('the push body names neither the medication nor the patient', async () => {
    // A push is readable on a locked phone; same reasoning as 4.2's lock-screen
    // note and D-8's SMS constraint.
    _setInvokerForTests(async (p) => (p.op === 'claim' ? { claims: [claim()] } : { removed: 0 }));
    let body;
    _setFetchForTests(async (_url, opts) => { body = JSON.parse(opts.body); return expoOk(1); });

    await dispatchHandler();
    const msg = body[0];
    const text = `${msg.title} ${msg.body}`;
    assert.doesNotMatch(text, /200mg|Anti-Telepathy|Robin|tester/i);
    assert.equal(msg.data.kind, 'dose-escalation');
    assert.equal(msg.data.doseId, 1);
});

test('the push uses the push API\'s kebab-case interruption level, not the client\'s camelCase', async () => {
    // Expo's push HTTP API validates against
    // 'active' | 'critical' | 'passive' | 'time-sensitive' and 400s the whole
    // request on the camelCase spelling that expo-notifications uses on the
    // device (5.3). A mocked fetch accepts either, so this literal is pinned
    // deliberately — it is the only thing stopping someone matching it back to
    // the client value. Verified against the live API, 2026-07-31.
    _setInvokerForTests(async (p) => (p.op === 'claim' ? { claims: [claim()] } : { removed: 0 }));
    let body;
    _setFetchForTests(async (_url, opts) => { body = JSON.parse(opts.body); return expoOk(1); });
    await dispatchHandler();
    assert.equal(body[0].interruptionLevel, 'time-sensitive');
    assert.notEqual(body[0].interruptionLevel, 'timeSensitive');
    assert.equal(body[0].priority, 'high');
});

test('a caregiver with no registered device is skipped, not crashed on', async () => {
    _setInvokerForTests(async (p) => (p.op === 'claim' ? { claims: [claim({ caregiver_tokens: [] })] } : { removed: 0 }));
    let fetched = 0;
    _setFetchForTests(async () => { fetched += 1; return expoOk(0); });

    const out = await dispatchHandler();
    // SMS is the only other channel and it has no transport, so there is
    // genuinely nothing to send.
    assert.equal(out.skipped, 1);
    assert.equal(out.pushed, 0);
    assert.equal(fetched, 0);
});

test('an sms_first reminder still escalates today, by substituting push (D-8)', async () => {
    // The fallback that stops a configuration setting from silently disabling
    // the safety net. SMS has no transport, so rung 1 becomes a caregiver push.
    _setInvokerForTests(async (p) => (p.op === 'claim'
        ? { claims: [claim({ escalation_order: 'sms_first', escalation_level: 1 })] }
        : { removed: 0 }));
    let body;
    _setFetchForTests(async (_url, opts) => { body = JSON.parse(opts.body); return expoOk(1); });

    const out = await dispatchHandler();
    assert.equal(out.substituted, 1);
    assert.equal(out.pushed, 1);
    assert.equal(body.length, 1);
});

test('one dependent failing does not stop the rest of the run', async () => {
    _setInvokerForTests(async (p) => (p.op === 'claim'
        ? { claims: [claim({ dose_id: 1, caregiver_tokens: [] }), claim({ dose_id: 2 })] }
        : { removed: 0 }));
    _setFetchForTests(async () => expoOk(1));

    const out = await dispatchHandler();
    assert.equal(out.claimed, 2);
    assert.equal(out.skipped, 1);
    assert.equal(out.pushed, 1);
});

test('messages are batched at Expo\'s 100-message limit', async () => {
    const tokens = Array.from({ length: 150 }, (_, i) => `ExponentPushToken[${i}]`);
    _setInvokerForTests(async (p) => (p.op === 'claim' ? { claims: [claim({ caregiver_tokens: tokens })] } : { removed: 0 }));
    const sizes = [];
    _setFetchForTests(async (_url, opts) => {
        const n = JSON.parse(opts.body).length;
        sizes.push(n);
        return expoOk(n);
    });

    const out = await dispatchHandler();
    assert.deepEqual(sizes, [100, 50]);
    assert.equal(out.pushed, 150);
});

// ---------------------------------------------------------------------------
// dispatchHandler — dead tokens and failure modes
// ---------------------------------------------------------------------------

test('a DeviceNotRegistered ticket reaps that token and only that token', async () => {
    _setInvokerForTests(async (p) => {
        if (p.op === 'claim') return { claims: [claim({ caregiver_tokens: ['good', 'dead'] })] };
        assert.deepEqual(p.tokens, ['dead']);
        return { removed: 1 };
    });
    _setFetchForTests(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ status: 'ok', id: 'x' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }] }),
        text: async () => '',
    }));

    const out = await dispatchHandler();
    assert.equal(out.reaped, 1);
    assert.equal(out.pushed, 1);
});

test('a ticket array of the wrong length reaps nothing and says so', async () => {
    // Expo answers positionally. Zipping as far as it can would delete a working
    // device's token because a different device was uninstalled.
    let reapCalled = false;
    _setInvokerForTests(async (p) => {
        if (p.op === 'claim') return { claims: [claim({ caregiver_tokens: ['a', 'b'] })] };
        // Gated on the op rather than on "anything that is not a claim", which
        // is what it said when the protocol had exactly two ops. 5.9's drain and
        // 5.8's receipts poll now run on the same pass, and a test that reads
        // either of them as a reap asserts the opposite of what it means.
        if (p.op === 'reap') reapCalled = true;
        return { removed: 0 };
    });
    _setFetchForTests(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }),
        text: async () => '',
    }));

    const out = await dispatchHandler();
    assert.equal(reapCalled, false);
    assert.equal(out.reaped, 0);
    assert.ok(out.errors.some((e) => /mismatch/.test(e)));
});

test('an unreachable Expo reaps nothing and records the failure', async () => {
    _setInvokerForTests(async (p) => (p.op === 'claim' ? { claims: [claim()] } : { removed: 0 }));
    _setFetchForTests(async () => { throw new Error('ETIMEDOUT'); });

    const out = await dispatchHandler();
    assert.equal(out.pushed, 0);
    assert.equal(out.reaped, 0);
    assert.ok(out.errors.some((e) => /expo-unreachable/.test(e)));
});

test('an Expo HTTP error reaps nothing and records the status', async () => {
    _setInvokerForTests(async (p) => (p.op === 'claim' ? { claims: [claim()] } : { removed: 0 }));
    _setFetchForTests(async () => ({ ok: false, status: 502, text: async () => 'bad gateway', json: async () => ({}) }));

    const out = await dispatchHandler();
    assert.equal(out.pushed, 0);
    assert.ok(out.errors.some((e) => /expo-http-502/.test(e)));
});

test('a credentials error does not empty push_tokens', async () => {
    // Every token looks dead when the project's credentials are wrong. Reaping
    // on it would force every user to reopen the app to re-register.
    let reapCalled = false;
    _setInvokerForTests(async (p) => {
        if (p.op === 'claim') return { claims: [claim({ caregiver_tokens: ['a', 'b'] })] };
        if (p.op === 'reap') reapCalled = true;
        return { removed: 2 };
    });
    _setFetchForTests(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [
            { status: 'error', details: { error: 'InvalidCredentials' } },
            { status: 'error', details: { error: 'MismatchSenderId' } },
        ] }),
        text: async () => '',
    }));

    const out = await dispatchHandler();
    assert.equal(reapCalled, false);
    assert.equal(out.reaped, 0);
});

test('a failed reap does not fail the run that already sent', async () => {
    _setInvokerForTests(async (p) => {
        if (p.op === 'claim') return { claims: [claim({ caregiver_tokens: ['dead'] })] };
        throw new Error('vpc half unreachable');
    });
    _setFetchForTests(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }),
        text: async () => '',
    }));

    const out = await dispatchHandler();
    assert.equal(out.reaped, 0);
    assert.ok(out.errors.some((e) => /reap-failed/.test(e)));
});

test('the rung is read from the level before the increment', async () => {
    // The claim returns the post-increment value, so a dose at stored level 0
    // comes back as 1 and must take rung 1 — the caregiver push. Reading it
    // as-is would skip straight to rung 2.
    _setInvokerForTests(async (p) => (p.op === 'claim'
        ? { claims: [claim({ escalation_level: 1, escalation_order: 'caregiver_first' })] }
        : { removed: 0 }));
    let body;
    _setFetchForTests(async (_url, opts) => { body = JSON.parse(opts.body); return expoOk(1); });

    const out = await dispatchHandler();
    assert.equal(out.pushed, 1);
    assert.equal(body[0].data.escalationLevel, 1);
});

test('a second-rung caregiver_first dose substitutes push because SMS has no transport', async () => {
    _setInvokerForTests(async (p) => (p.op === 'claim'
        ? { claims: [claim({ escalation_level: 2, escalation_order: 'caregiver_first' })] }
        : { removed: 0 }));
    _setFetchForTests(async () => expoOk(1));

    const out = await dispatchHandler();
    assert.equal(out.substituted, 1);
    assert.equal(out.pushed, 1);
});

// ---------------------------------------------------------------------------
// 5.9 — the outbox: dbHandler ops
// ---------------------------------------------------------------------------

/**
 * An invoker built from a partial op map, defaulting every op the dispatcher may
 * call. Without this each test has to stub five ops it does not care about, and
 * the ones it forgets surface as an unrelated `outbox-failed` in the summary.
 */
function invoker(handlers = {}) {
    const defaults = {
        claim: { claims: [] },
        'drain-outbox': { batches: [] },
        'outbox-done': { done: 0 },
        'outbox-failed': { failed: 0 },
        'record-tickets': { recorded: 0 },
        'due-receipts': { due: [], expired: 0 },
        'receipts-checked': { checked: 0 },
        reap: { removed: 0 },
    };
    return async (p) => {
        const hit = handlers[p.op];
        if (typeof hit === 'function') return hit(p);
        return hit ?? defaults[p.op] ?? {};
    };
}

test('drain-outbox groups several rows for one user into one batch', async () => {
    // The coalescing is the point: editing four reminders in a minute must be
    // one push per device, because iOS rate-limits silent pushes.
    _setPoolForTests(makePool([
        { match: /FROM push_outbox/, result: { rows: [
            { id: 1, user_id: 7 }, { id: 2, user_id: 7 }, { id: 3, user_id: 9 },
        ] } },
        { match: /owner_user_id/, result: { rows: [
            { owner_user_id: 7, tokens: ['tok-a', 'tok-b'] },
            { owner_user_id: 9, tokens: ['tok-c'] },
        ] } },
    ]));

    const out = await dbHandler({ op: 'drain-outbox' });
    assert.equal(out.batches.length, 2);
    const seven = out.batches.find((b) => b.ownerUserId === 7);
    assert.deepEqual(seven.outboxIds, [1, 2]);
    assert.deepEqual(seven.tokens, ['tok-a', 'tok-b']);
});

test('drain-outbox skips rows that have already failed too often', async () => {
    // Otherwise an Expo outage builds a backlog every later run re-reads.
    const pool = makePool([{ match: /FROM push_outbox/, result: { rows: [] } }]);
    _setPoolForTests(pool);
    await dbHandler({ op: 'drain-outbox' });
    const q = pool.calls.find((c) => /FROM push_outbox/.test(c.text));
    assert.match(q.text, /attempts\s*<\s*\$2/);
    assert.ok(q.params[1] > 0, 'the attempt ceiling must be passed, not hardcoded to zero');
});

test('drain-outbox locks with SKIP LOCKED so two runs cannot double-send', async () => {
    const pool = makePool([{ match: /FROM push_outbox/, result: { rows: [] } }]);
    _setPoolForTests(pool);
    await dbHandler({ op: 'drain-outbox' });
    assert.match(pool.calls[0].text, /FOR UPDATE SKIP LOCKED/);
});

test('the recipients include the owner active caregivers, not just the owner', async () => {
    // 4.2 item 4 puts escalation copies of this reminder on a caregiver's phone,
    // and they go stale on exactly the edit that enqueued the row. §8 says "the
    // owner's devices"; that would reach half the devices holding the schedule.
    const pool = makePool([
        { match: /FROM push_outbox/, result: { rows: [{ id: 1, user_id: 7 }] } },
        { match: /owner_user_id/, result: { rows: [{ owner_user_id: 7, tokens: [] }] } },
    ]);
    _setPoolForTests(pool);
    await dbHandler({ op: 'drain-outbox' });

    const q = pool.calls.find((c) => /owner_user_id/.test(c.text));
    assert.match(q.text, /user_relationships/);
    assert.match(q.text, /caregiver_id/);
    // Revoked relationships must not receive: a former caregiver hearing about a
    // schedule change is a disclosure, not a stale cache.
    assert.match(q.text, /status = 'active'/);
});

// --- 3.2 — the access-revoked reason -----------------------------------------

test('THE REVOCATION PUSH GOES TO THAT USER OWN DEVICES, not through the caregiver fan-out', async () => {
    // The whole reason 3.2 needed a second recipient query. An `access-revoked`
    // row names the caregiver whose access just ended, and the fan-out above
    // resolves through `user_relationships ... status = 'active'` — which the
    // relationship no longer is. Run through that query it would reach everybody
    // except the one device still holding the dependent's alarms.
    const pool = makePool([
        { match: /FROM push_outbox/, result: { rows: [{ id: 1, user_id: 3, reason: 'access-revoked' }] } },
        { match: /owner_user_id/, result: { rows: [{ owner_user_id: 3, tokens: ['tok-a'] }] } },
    ]);
    _setPoolForTests(pool);

    const out = await dbHandler({ op: 'drain-outbox' });
    assert.deepEqual(out.batches[0].tokens, ['tok-a']);
    assert.equal(out.batches[0].reason, 'access-revoked');

    const q = pool.calls.find((c) => /owner_user_id/.test(c.text));
    assert.doesNotMatch(q.text, /user_relationships/, 'the revocation push must not fan out to relationships');
    assert.match(q.text, /LEFT JOIN push_tokens p ON p\.user_id = u\.id/);
});

test('two reasons for one user stay two batches rather than coalescing', async () => {
    // Coalescing is right for two edits — both mean "re-read this schedule".
    // These two mean different things: one says re-read an owner's reminders,
    // the other says re-read who you still have access to and drop the rest.
    // Merging them would silently drop whichever lost, and the loser is the
    // rarer one, which is the revocation.
    _setPoolForTests(makePool([
        { match: /FROM push_outbox/, result: { rows: [
            { id: 1, user_id: 3, reason: 'schedule-changed' },
            { id: 2, user_id: 3, reason: 'access-revoked' },
        ] } },
        { match: /owner_user_id/, result: { rows: [{ owner_user_id: 3, tokens: ['tok-a'] }] } },
    ]));

    const out = await dbHandler({ op: 'drain-outbox' });
    assert.equal(out.batches.length, 2);
    assert.deepEqual(out.batches.map((b) => b.reason).sort(), ['access-revoked', 'schedule-changed']);
});

test('an unrecognised reason is treated as schedule-changed rather than sent verbatim', async () => {
    // `reason` is a free-text column with a default, so a value nobody has
    // taught the client to handle can reach here. Falling back to the reason
    // every client already understands degrades to a redundant re-sync; passing
    // it through would produce a push the device silently ignores.
    _setPoolForTests(makePool([
        { match: /FROM push_outbox/, result: { rows: [{ id: 1, user_id: 3, reason: 'something-new' }] } },
        { match: /owner_user_id/, result: { rows: [{ owner_user_id: 3, tokens: ['tok-a'] }] } },
    ]));
    const out = await dbHandler({ op: 'drain-outbox' });
    assert.equal(out.batches[0].reason, 'schedule-changed');
});

test('the common all-schedule-changed drain still costs exactly one recipient query', async () => {
    const pool = makePool([
        { match: /FROM push_outbox/, result: { rows: [
            { id: 1, user_id: 7, reason: 'schedule-changed' },
            { id: 2, user_id: 9, reason: 'schedule-changed' },
        ] } },
        { match: /owner_user_id/, result: { rows: [] } },
    ]);
    _setPoolForTests(pool);
    await dbHandler({ op: 'drain-outbox' });
    assert.equal(pool.calls.filter((c) => /owner_user_id/.test(c.text)).length, 1);
});

test('an access-revoked batch sends its own kind, and the payload names the viewer', async () => {
    _setInvokerForTests(invoker({
        'drain-outbox': { batches: [{ ownerUserId: 3, reason: 'access-revoked', outboxIds: [1], tokens: ['tok'] }] },
    }));
    let body;
    _setFetchForTests(async (_url, opts) => { body = JSON.parse(opts.body); return expoOk(1); });

    await dispatchHandler();
    assert.equal(body[0].data.kind, 'access-revoked');
    // For this kind `ownerUserId` is the *viewer* whose access set changed, not
    // an owner whose reminders to re-read.
    assert.equal(body[0].data.ownerUserId, 3);
    // Still silent: a revocation must not put a notification on the caregiver's
    // lock screen announcing that somebody cut them off.
    assert.equal(body[0].title, undefined);
    assert.equal(body[0]._contentAvailable, true);
});

test('a batch with no reason still sends as schedule-changed', async () => {
    // Defensive rather than hypothetical: an outbox row enqueued by the deployed
    // build before this change carries a reason the drain read but never
    // returned, so the first run after a deploy can see batches with none.
    _setInvokerForTests(invoker({
        'drain-outbox': { batches: [{ ownerUserId: 7, outboxIds: [1], tokens: ['tok'] }] },
    }));
    let body;
    _setFetchForTests(async (_url, opts) => { body = JSON.parse(opts.body); return expoOk(1); });

    await dispatchHandler();
    assert.equal(body[0].data.kind, 'schedule-changed');
});

test('outbox-done closes rows and outbox-failed only counts the attempt', async () => {
    const pool = makePool([{ match: /UPDATE push_outbox/, result: { rowCount: 2 } }]);
    _setPoolForTests(pool);

    await dbHandler({ op: 'outbox-done', ids: [1, 2] });
    assert.match(pool.calls[0].text, /sent_at = now\(\)/);

    await dbHandler({ op: 'outbox-failed', ids: [1, 2] });
    assert.doesNotMatch(pool.calls[1].text, /sent_at = now\(\)/);
    assert.match(pool.calls[1].text, /attempts = attempts \+ 1/);
});

test('the outbox ops ignore ids that are not integers', async () => {
    // These arrive over a Lambda invoke payload, so they are untrusted input.
    const pool = makePool();
    _setPoolForTests(pool);
    assert.deepEqual(await dbHandler({ op: 'outbox-done', ids: ['x', null, undefined] }), { done: 0 });
    assert.deepEqual(await dbHandler({ op: 'outbox-done', ids: 'nope' }), { done: 0 });
    assert.equal(pool.calls.length, 0, 'nothing should reach the database');
});

// ---------------------------------------------------------------------------
// 5.9 — the outbox: the dispatcher
// ---------------------------------------------------------------------------

test('THE REGRESSION: a run with nothing to escalate still drains the outbox', async () => {
    // The old dispatcher returned as soon as `claims` was empty, which is most
    // runs. Leaving that early return would have made the silent push work only
    // on the runs that happened to be escalating something.
    let drained = false;
    _setInvokerForTests(invoker({
        claim: { claims: [] },
        'drain-outbox': () => {
            drained = true;
            return { batches: [{ ownerUserId: 7, outboxIds: [1], tokens: ['tok'] }] };
        },
    }));
    _setFetchForTests(async () => expoOk(1));

    const out = await dispatchHandler();
    assert.equal(out.claimed, 0);
    assert.equal(drained, true);
    assert.equal(out.silent, 1);
});

test('a silent push is data-only - no title, no body, content-available', async () => {
    // A title or a body would make it a notification the patient sees, which is
    // the opposite of the feature: this is meant to wake the app, not the user.
    _setInvokerForTests(invoker({
        'drain-outbox': { batches: [{ ownerUserId: 7, outboxIds: [1], tokens: ['tok'] }] },
    }));
    let body;
    _setFetchForTests(async (_url, opts) => { body = JSON.parse(opts.body); return expoOk(1); });

    await dispatchHandler();
    assert.equal(body[0].title, undefined);
    assert.equal(body[0].body, undefined);
    assert.equal(body[0]._contentAvailable, true);
    assert.equal(body[0].data.kind, 'schedule-changed');
    assert.equal(body[0].data.ownerUserId, 7);
    // Not an alert, so not time-sensitive. The alarms it rewrites are.
    assert.equal(body[0].interruptionLevel, undefined);
});

test('an owner with no registered device closes the row rather than retrying forever', async () => {
    let doneIds = null;
    let failedCalled = false;
    _setInvokerForTests(invoker({
        'drain-outbox': { batches: [{ ownerUserId: 7, outboxIds: [1, 2], tokens: [] }] },
        'outbox-done': (p) => { doneIds = p.ids; return { done: p.ids.length }; },
        'outbox-failed': () => { failedCalled = true; return { failed: 0 }; },
    }));

    const out = await dispatchHandler();
    assert.deepEqual(doneIds, [1, 2]);
    assert.equal(failedCalled, false, 'no device is finished, not failed');
    assert.equal(out.silentBatches, 0);
});

test('an unreachable Expo leaves the row pending so the next run retries it', async () => {
    let failedIds = null;
    let doneCalled = false;
    _setInvokerForTests(invoker({
        'drain-outbox': { batches: [{ ownerUserId: 7, outboxIds: [3], tokens: ['tok'] }] },
        'outbox-failed': (p) => { failedIds = p.ids; return { failed: p.ids.length }; },
        'outbox-done': () => { doneCalled = true; return { done: 0 }; },
    }));
    _setFetchForTests(async () => { throw new Error('ETIMEDOUT'); });

    const out = await dispatchHandler();
    assert.deepEqual(failedIds, [3]);
    assert.equal(doneCalled, false);
    assert.ok(out.errors.some((e) => /expo-unreachable/.test(e)));
});

test('a dead device still closes the row - there is nothing left to retry to', async () => {
    let doneIds = null;
    _setInvokerForTests(invoker({
        'drain-outbox': { batches: [{ ownerUserId: 7, outboxIds: [4], tokens: ['dead'] }] },
        'outbox-done': (p) => { doneIds = p.ids; return { done: 1 }; },
    }));
    _setFetchForTests(async () => ({
        ok: true, status: 200, text: async () => '',
        json: async () => ({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }),
    }));

    const out = await dispatchHandler();
    assert.deepEqual(doneIds, [4]);
    assert.equal(out.reaped, 0, 'the fake invoker reports no rows removed');
});

// ---------------------------------------------------------------------------
// Isolation - a safety mechanism and an optimisation sharing one run
// ---------------------------------------------------------------------------

test('a failing outbox drain cannot stop the escalation', async () => {
    // 5.4 is a safety mechanism and 5.9 is an optimisation. The optimisation
    // must never be able to take the safety mechanism down with it.
    _setInvokerForTests(invoker({
        claim: { claims: [claim()] },
        'drain-outbox': () => { throw new Error('outbox exploded'); },
    }));
    _setFetchForTests(async () => expoOk(1));

    const out = await dispatchHandler();
    assert.equal(out.pushed, 1, 'the escalation still went out');
    assert.ok(out.errors.some((e) => /outbox-failed/.test(e)));
});

test('a failing escalation cannot stop the silent pushes', async () => {
    _setInvokerForTests(invoker({
        claim: () => { throw new Error('claim exploded'); },
        'drain-outbox': { batches: [{ ownerUserId: 7, outboxIds: [1], tokens: ['tok'] }] },
    }));
    _setFetchForTests(async () => expoOk(1));

    const out = await dispatchHandler();
    assert.equal(out.silent, 1);
    assert.ok(out.errors.some((e) => /escalation-failed/.test(e)));
});

test('every run reports the same summary keys, however little it did', async () => {
    // A caller reading `.errors.length` off a shorter object crashes exactly
    // when there is nothing wrong.
    _setInvokerForTests(invoker());
    const quiet = await dispatchHandler();
    for (const key of [
        'claimed', 'pushed', 'substituted', 'skipped', 'reaped',
        'silent', 'silentBatches', 'tickets', 'receipts', 'errors', 'timezone',
    ]) {
        assert.ok(key in quiet, `a quiet run must still report ${key}`);
    }
});

// ---------------------------------------------------------------------------
// 5.8 — tickets and receipts
// ---------------------------------------------------------------------------

test('ok tickets are recorded against the token that produced them, with their kind', async () => {
    let recorded = null;
    _setInvokerForTests(invoker({
        claim: { claims: [claim({ caregiver_tokens: ['tok-a', 'tok-b'] })] },
        'record-tickets': (p) => { recorded = p.tickets; return { recorded: p.tickets.length }; },
    }));
    _setFetchForTests(async () => ({
        ok: true, status: 200, text: async () => '',
        json: async () => ({ data: [{ status: 'ok', id: 'r1' }, { status: 'ok', id: 'r2' }] }),
    }));

    await dispatchHandler();
    assert.deepEqual(recorded, [
        { ticketId: 'r1', token: 'tok-a', kind: 'dose-escalation' },
        { ticketId: 'r2', token: 'tok-b', kind: 'dose-escalation' },
    ]);
});

test('a misaligned ticket array records nothing, for the same reason it reaps nothing', async () => {
    // A ticket filed against the wrong token would later reap a *working*
    // device because a different one was uninstalled - silent, and visible only
    // as a caregiver who stops getting escalations.
    let recordCalled = false;
    _setInvokerForTests(invoker({
        claim: { claims: [claim({ caregiver_tokens: ['a', 'b'] })] },
        'record-tickets': () => { recordCalled = true; return { recorded: 0 }; },
    }));
    _setFetchForTests(async () => ({
        ok: true, status: 200, text: async () => '',
        json: async () => ({ data: [{ status: 'ok', id: 'only-one' }] }),
    }));

    await dispatchHandler();
    assert.equal(recordCalled, false);
});

test('a silent push records its tickets under its own kind', async () => {
    // The two kinds fail with very different consequences - a missed escalation
    // is a safety matter, a missed silent push is a stale schedule - so the logs
    // have to separate them.
    let recorded = null;
    _setInvokerForTests(invoker({
        'drain-outbox': { batches: [{ ownerUserId: 7, outboxIds: [1], tokens: ['tok'] }] },
        'record-tickets': (p) => { recorded = p.tickets; return { recorded: 1 }; },
    }));
    _setFetchForTests(async () => expoOk(1));

    await dispatchHandler();
    assert.equal(recorded[0].kind, 'schedule-changed');
});

test('due-receipts asks only for tickets old enough to have one and young enough to keep one', async () => {
    const pool = makePool([{ match: /FROM push_tickets/, result: { rows: [] } }]);
    _setPoolForTests(pool);
    await dbHandler({ op: 'due-receipts' });

    const select = pool.calls.find((c) => /SELECT ticket_id/.test(c.text));
    assert.match(select.text, /checked_at IS NULL/);
    assert.match(select.text, /minutes/);
    assert.match(select.text, /hours/);
    // And anything past the window is closed out rather than polled forever.
    const expire = pool.calls.find((c) => /UPDATE push_tickets/.test(c.text));
    assert.match(expire.text, /'expired'/);
});

test('a receipt reporting DeviceNotRegistered reaps the token', async () => {
    // The delayed failure this whole poll exists for: Expo accepted the send and
    // only the receipt reveals the device is gone.
    let reaped = null;
    _setInvokerForTests(invoker({
        'due-receipts': { due: [{ ticket_id: 'r1', token: 'ghost', kind: 'dose-escalation' }], expired: 0 },
        reap: (p) => { reaped = p.tokens; return { removed: p.tokens.length }; },
    }));
    _setFetchForTests(async () => ({
        ok: true, status: 200, text: async () => '',
        json: async () => ({ data: { r1: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } } }),
    }));

    const out = await dispatchHandler();
    assert.deepEqual(reaped, ['ghost']);
    assert.equal(out.reaped, 1);
});

test('a receipt that is fine reaps nothing but is still marked checked', async () => {
    let reapCalled = false;
    let checked = null;
    _setInvokerForTests(invoker({
        'due-receipts': { due: [{ ticket_id: 'r1', token: 'alive', kind: 'schedule-changed' }], expired: 0 },
        reap: () => { reapCalled = true; return { removed: 0 }; },
        'receipts-checked': (p) => { checked = p.results; return { checked: p.results.length }; },
    }));
    _setFetchForTests(async () => ({
        ok: true, status: 200, text: async () => '',
        json: async () => ({ data: { r1: { status: 'ok' } } }),
    }));

    const out = await dispatchHandler();
    assert.equal(reapCalled, false);
    assert.deepEqual(checked, [{ ticketId: 'r1', status: 'ok', detail: null }]);
    assert.equal(out.receipts, 1);
});

test('a receipt Expo has no answer for yet is left unchecked for the next run', async () => {
    // Receipts appear minutes after the send. An id missing from the response is
    // "not yet", not "fine" - marking it checked would lose the outcome.
    let checked = null;
    _setInvokerForTests(invoker({
        'due-receipts': { due: [
            { ticket_id: 'r1', token: 'a', kind: 'schedule-changed' },
            { ticket_id: 'r2', token: 'b', kind: 'schedule-changed' },
        ], expired: 0 },
        'receipts-checked': (p) => { checked = p.results; return { checked: p.results.length }; },
    }));
    _setFetchForTests(async () => ({
        ok: true, status: 200, text: async () => '',
        json: async () => ({ data: { r1: { status: 'ok' } } }),
    }));

    await dispatchHandler();
    assert.equal(checked.length, 1);
    assert.equal(checked[0].ticketId, 'r1');
});

test('an unreachable receipts endpoint leaves every ticket unchecked', async () => {
    let checkCalled = false;
    _setInvokerForTests(invoker({
        'due-receipts': { due: [{ ticket_id: 'r1', token: 'a', kind: 'schedule-changed' }], expired: 0 },
        'receipts-checked': () => { checkCalled = true; return { checked: 0 }; },
    }));
    _setFetchForTests(async () => { throw new Error('ETIMEDOUT'); });

    const out = await dispatchHandler();
    assert.equal(checkCalled, false);
    assert.ok(out.errors.some((e) => /receipts-unreachable/.test(e)));
});

test('a credentials error in a receipt does not empty push_tokens either', async () => {
    // Same reasoning as the ticket-level guard: these make every device look
    // dead at once, and acting on them forces every user to reopen the app.
    let reapCalled = false;
    _setInvokerForTests(invoker({
        'due-receipts': { due: [{ ticket_id: 'r1', token: 'a', kind: 'schedule-changed' }], expired: 0 },
        reap: () => { reapCalled = true; return { removed: 1 }; },
    }));
    _setFetchForTests(async () => ({
        ok: true, status: 200, text: async () => '',
        json: async () => ({ data: { r1: { status: 'error', details: { error: 'InvalidCredentials' } } } }),
    }));

    await dispatchHandler();
    assert.equal(reapCalled, false);
});
