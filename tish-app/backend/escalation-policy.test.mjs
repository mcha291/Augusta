// 5.4 — tests for the escalation job's pure decision logic. No database, no
// network. Run: npm test
//
// The bias here is toward the rules that fail *silently*: which rung fires,
// what happens when a channel is unavailable, and the two places a positional
// array could be zipped onto the wrong thing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_ESCALATION_LEVEL,
    ESCALATION_GRACE_MINUTES,
    ESCALATION_MAX_LATENESS_HOURS,
    PUSH_CAREGIVER,
    SMS_PATIENT,
    rungFor,
    resolveDispatch,
    anchorFor,
    chunk,
    classifyPushResult,
    tokensToReap,
} from './escalation-policy.mjs';
import { SNOOZE_ESCALATION_THRESHOLD } from './index.mjs';

// ---------------------------------------------------------------------------
// The ladder (D-8)
// ---------------------------------------------------------------------------

test('caregiver_first notifies the caregiver first and texts the patient second', () => {
    assert.deepEqual(rungFor(0, 'caregiver_first'), PUSH_CAREGIVER);
    assert.deepEqual(rungFor(1, 'caregiver_first'), SMS_PATIENT);
});

test('sms_first reverses the same two rungs rather than introducing new ones', () => {
    assert.deepEqual(rungFor(0, 'sms_first'), SMS_PATIENT);
    assert.deepEqual(rungFor(1, 'sms_first'), PUSH_CAREGIVER);
});

test('the ladder stops at two rungs', () => {
    assert.equal(rungFor(MAX_ESCALATION_LEVEL, 'caregiver_first'), null);
    assert.equal(rungFor(MAX_ESCALATION_LEVEL, 'sms_first'), null);
    assert.equal(rungFor(99, 'caregiver_first'), null);
});

test('an unrecognised escalation_order escalates as caregiver_first rather than not at all', () => {
    // The column has a CHECK, so this means something bypassed the API. Refusing
    // to escalate would be the worse of the two failures.
    assert.deepEqual(rungFor(0, 'nonsense'), PUSH_CAREGIVER);
    assert.deepEqual(rungFor(0, undefined), PUSH_CAREGIVER);
    assert.deepEqual(rungFor(0, null), PUSH_CAREGIVER);
});

test('a malformed level yields no rung instead of indexing the ladder oddly', () => {
    assert.equal(rungFor(-1, 'caregiver_first'), null);
    assert.equal(rungFor(1.5, 'caregiver_first'), null);
    assert.equal(rungFor(NaN, 'caregiver_first'), null);
    assert.equal(rungFor(undefined, 'caregiver_first'), null);
});

test('push always means the caregiver and sms always means the patient', () => {
    // Channel and audience are coupled; no ordering produces sms-to-caregiver.
    for (const order of ['caregiver_first', 'sms_first']) {
        for (const level of [0, 1]) {
            const rung = rungFor(level, order);
            assert.equal(rung.channel === 'push', rung.audience === 'caregiver');
            assert.equal(rung.channel === 'sms', rung.audience === 'patient');
        }
    }
});

// ---------------------------------------------------------------------------
// Channel fallback (D-8)
// ---------------------------------------------------------------------------

test('an available channel is used unchanged', () => {
    const r = resolveDispatch(PUSH_CAREGIVER, { push: true, sms: true });
    assert.deepEqual(r.action, PUSH_CAREGIVER);
    assert.equal(r.substituted, false);
    assert.equal(r.skipped, false);
});

test('an unavailable channel substitutes the other one rather than skipping', () => {
    // The case that matters today: SNS is sandboxed, so sms_first's first rung
    // cannot send. D-8 says fall through to the caregiver, not do nothing.
    const r = resolveDispatch(SMS_PATIENT, { push: true, sms: false });
    assert.deepEqual(r.action, PUSH_CAREGIVER);
    assert.equal(r.substituted, true);
    assert.equal(r.skipped, false);
    assert.equal(r.substitutedFrom, 'sms');
});

test('a caregiver with no registered token substitutes SMS', () => {
    const r = resolveDispatch(PUSH_CAREGIVER, { push: false, sms: true });
    assert.deepEqual(r.action, SMS_PATIENT);
    assert.equal(r.substituted, true);
    assert.equal(r.substitutedFrom, 'push');
});

test('with neither channel available the dispatch is skipped and says why', () => {
    const r = resolveDispatch(PUSH_CAREGIVER, { push: false, sms: false });
    assert.equal(r.action, null);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'no-channel-available');
});

test('an exhausted ladder is skipped rather than treated as a missing channel', () => {
    const r = resolveDispatch(null, { push: true, sms: true });
    assert.equal(r.action, null);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'ladder-exhausted');
});

test('a missing availability map skips rather than assuming a channel works', () => {
    // Failing closed here is right: a truthy default would send SMS to an
    // unverified number, which is the D-8 constraint that exists to stop PHI
    // reaching a stranger.
    assert.equal(resolveDispatch(PUSH_CAREGIVER, undefined).skipped, true);
    assert.equal(resolveDispatch(PUSH_CAREGIVER, {}).skipped, true);
});

test('availability must be exactly true — a truthy value is not a working channel', () => {
    assert.equal(resolveDispatch(PUSH_CAREGIVER, { push: 'yes' }).skipped, true);
    assert.equal(resolveDispatch(PUSH_CAREGIVER, { push: 1 }).skipped, true);
});

test('when only one channel exists both rungs collapse onto it', () => {
    // Deliberate: see resolveDispatch's note. Both rungs firing is D-8's intent,
    // and a repeat beats silence.
    const only = { push: true, sms: false };
    const first = resolveDispatch(rungFor(0, 'caregiver_first'), only);
    const second = resolveDispatch(rungFor(1, 'caregiver_first'), only);
    assert.deepEqual(first.action, PUSH_CAREGIVER);
    assert.deepEqual(second.action, PUSH_CAREGIVER);
    assert.equal(second.substituted, true);
});

// ---------------------------------------------------------------------------
// The anchor (D-6 / D-12)
// ---------------------------------------------------------------------------

test('an un-snoozed dose anchors on its scheduled time', () => {
    const dose = { scheduled_for: '2026-07-31T00:00:00Z', snoozed_until: null, snooze_count: 0 };
    assert.equal(anchorFor(dose, SNOOZE_ESCALATION_THRESHOLD), '2026-07-31T00:00:00Z');
});

test('a snooze re-anchors the clock while under the threshold (D-6)', () => {
    const dose = { scheduled_for: '2026-07-31T00:00:00Z', snoozed_until: '2026-07-31T00:10:00Z', snooze_count: 1 };
    assert.equal(anchorFor(dose, SNOOZE_ESCALATION_THRESHOLD), '2026-07-31T00:10:00Z');
});

test('at exactly the threshold the snooze still counts', () => {
    // Strictly greater than, matching 5.1's escalates_regardless flag. The client
    // and the job must agree on which snooze is the last forgiving one.
    const dose = {
        scheduled_for: '2026-07-31T00:00:00Z',
        snoozed_until: '2026-07-31T00:30:00Z',
        snooze_count: SNOOZE_ESCALATION_THRESHOLD,
    };
    assert.equal(anchorFor(dose, SNOOZE_ESCALATION_THRESHOLD), '2026-07-31T00:30:00Z');
});

test('above the threshold the snooze stops deferring escalation (D-12)', () => {
    const dose = {
        scheduled_for: '2026-07-31T00:00:00Z',
        snoozed_until: '2026-07-31T02:00:00Z',
        snooze_count: SNOOZE_ESCALATION_THRESHOLD + 1,
    };
    assert.equal(anchorFor(dose, SNOOZE_ESCALATION_THRESHOLD), '2026-07-31T00:00:00Z');
});

// ---------------------------------------------------------------------------
// Constants that other things depend on
// ---------------------------------------------------------------------------

test('the lateness cut-off leaves room above the worst-case second rung', () => {
    // Max configurable delay is 240 minutes (migration 002's CHECK). Rung 2
    // lands at 2 x 240 + grace. A cut-off below that would silently disable the
    // second rung for anyone using a long delay.
    const worstCaseMinutes = MAX_ESCALATION_LEVEL * 240 + ESCALATION_GRACE_MINUTES;
    assert.ok(ESCALATION_MAX_LATENESS_HOURS * 60 > worstCaseMinutes);
});

test('the grace period is small enough to be a tie-breaker, not a second delay', () => {
    // Every minute here is a minute a genuinely unresponsive patient goes
    // unnoticed. It only has to outlast the device's own alarm.
    assert.ok(ESCALATION_GRACE_MINUTES > 0);
    assert.ok(ESCALATION_GRACE_MINUTES <= 5);
});

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

test('chunk splits at Expo\'s 100-message limit', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const out = chunk(items);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((c) => c.length), [100, 100, 50]);
    assert.deepEqual(out.flat(), items);
});

test('chunk handles an exact multiple without a trailing empty batch', () => {
    assert.equal(chunk(Array.from({ length: 200 }, (_, i) => i)).length, 2);
});

test('chunk of nothing is no batches, not one empty batch', () => {
    // A single empty batch would POST an empty message array to Expo.
    assert.deepEqual(chunk([]), []);
    assert.deepEqual(chunk(null), []);
    assert.deepEqual(chunk(undefined), []);
});

// ---------------------------------------------------------------------------
// Ticket / receipt classification
// ---------------------------------------------------------------------------

test('an ok ticket is ok', () => {
    assert.equal(classifyPushResult({ status: 'ok', id: 'abc' }), 'ok');
});

test('DeviceNotRegistered reaps the token', () => {
    assert.equal(
        classifyPushResult({ status: 'error', details: { error: 'DeviceNotRegistered' } }),
        'reap'
    );
});

test('MessageRateExceeded is retryable and does not reap', () => {
    assert.equal(
        classifyPushResult({ status: 'error', details: { error: 'MessageRateExceeded' } }),
        'retry'
    );
});

test('a credentials error never reaps, however many tokens it hits', () => {
    // These mean *this project's* push credentials are wrong, so every token
    // looks dead. Reaping on them would empty push_tokens for a reason that has
    // nothing to do with the devices, and every user would have to reopen the
    // app to recover.
    for (const error of ['InvalidCredentials', 'MismatchSenderId']) {
        assert.equal(classifyPushResult({ status: 'error', details: { error } }), 'fail');
    }
});

test('an unknown error fails rather than retrying forever', () => {
    assert.equal(classifyPushResult({ status: 'error', details: { error: 'WhoKnows' } }), 'fail');
    assert.equal(classifyPushResult({ status: 'error' }), 'fail');
});

test('a missing result is treated as ok rather than crashing the run', () => {
    assert.equal(classifyPushResult(undefined), 'ok');
    assert.equal(classifyPushResult(null), 'ok');
});

// ---------------------------------------------------------------------------
// Positional pairing — the one that deletes the wrong device's token
// ---------------------------------------------------------------------------

test('tokensToReap picks out only the dead tokens, by position', () => {
    const tokens = ['tok-a', 'tok-b', 'tok-c'];
    const results = [
        { status: 'ok', id: '1' },
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'ok', id: '3' },
    ];
    const { reap, misaligned } = tokensToReap(tokens, results);
    assert.equal(misaligned, false);
    assert.deepEqual(reap, ['tok-b']);
});

test('a length mismatch reaps nothing at all and reports itself', () => {
    // Expo answers positionally and never names the token. Zipping as far as it
    // can would delete a working device's token because a different device was
    // uninstalled — so the safe failure is to reap none of them.
    const { reap, misaligned } = tokensToReap(
        ['tok-a', 'tok-b'],
        [{ status: 'error', details: { error: 'DeviceNotRegistered' } }]
    );
    assert.equal(misaligned, true);
    assert.deepEqual(reap, []);
});

test('non-array input is misaligned rather than throwing', () => {
    assert.equal(tokensToReap(null, []).misaligned, true);
    assert.equal(tokensToReap([], null).misaligned, true);
});

test('all-ok tickets reap nothing', () => {
    const { reap, misaligned } = tokensToReap(
        ['a', 'b'],
        [{ status: 'ok' }, { status: 'ok' }]
    );
    assert.equal(misaligned, false);
    assert.deepEqual(reap, []);
});
