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
        reapCalled = true;
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
        reapCalled = true;
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
