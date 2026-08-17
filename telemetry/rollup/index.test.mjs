/**
 * Tests for the nightly Athena rollup (TELEMETRY.md §4).
 *
 * Run with `npm test` from `tish-app/backend/`.
 *
 * Everything here fails silently in production. A nightly job that writes the
 * wrong day, drops late-arriving events, or truncates its result page produces
 * a chart that looks entirely plausible — and the realistic failure mode for
 * anything on a schedule is that nobody notices for a fortnight.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    _internals,
    _setAthenaForTests,
    _setInvokerForTests,
    _setPoolForTests,
    rollupDbHandler,
    rollupHandler,
} from './index.mjs';

function restore() {
    _setAthenaForTests(null);
    _setInvokerForTests(null);
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

test('days are bucketed in Taipei, not UTC', () => {
    // §4: a dashboard opened from another timezone must not shift every daily
    // count. Doing the conversion in the query that produces the row means the
    // stored `day` has exactly one meaning.
    const sql = _internals.dailyOpensSql(14);
    assert.match(sql, /AT TIME ZONE 'Asia\/Taipei'/);
});

test('THE PARTITION FILTER REACHES FURTHER BACK THAN THE DAY WINDOW', () => {
    // The two filters mean different things and the gap between them is
    // load-bearing. `dt` is when Firehose wrote the record; `occurred_at` is
    // when the event happened on the device. A phone offline for a week flushes
    // events whose `dt` is a week after their `occurred_at` — so a `dt` floor
    // equal to the day window would silently drop exactly the late arrivals the
    // upsert exists to catch.
    const sql = _internals.dailyOpensSql(14);
    const dtDays = Number(sql.match(/current_date - interval '(\d+)' day, '%Y\/%m\/%d\/00'/)[1]);
    const windowDays = Number(sql.match(/>= current_date - interval '(\d+)' day/)[1]);

    assert.equal(windowDays, 14);
    assert.ok(dtDays > windowDays, `dt floor ${dtDays} must reach further back than the ${windowDays}-day window`);
});

test('the query filters on the partition column at all', () => {
    // Without a `dt` predicate every query scans the whole bucket, which is the
    // single most expensive mistake available here and the one §3 calls the
    // most-missed step.
    assert.match(_internals.dailyOpensSql(14), /\bdt >=/);
});

test('the window is wide enough to catch a buffered phone', () => {
    assert.ok(_internals.WINDOW_DAYS >= 7, 'a one-day window would permanently undercount late arrivals');
});

// ---------------------------------------------------------------------------
// The driving half
// ---------------------------------------------------------------------------

test('rows are normalised and handed to the database half', async (t) => {
    t.after(restore);

    _setAthenaForTests(async () => ([
        { day: '2026-08-14', source: 'cold', opens: '12', users: '9' },
        { day: '2026-08-14', source: 'notification', opens: '30', users: '11' },
    ]));

    let received = null;
    _setInvokerForTests(async (payload) => { received = payload; return { written: 2 }; });

    const out = await rollupHandler();

    assert.equal(out.rows, 2);
    assert.equal(received.op, 'daily-opens');
    // Athena returns everything as strings; Postgres needs numbers.
    assert.deepEqual(received.rows[0], { day: '2026-08-14', source: 'cold', opens: 12, users: 9 });
});

test('A QUIET DAY IS NOT AN ERROR', async (t) => {
    t.after(restore);

    // A job that threw on an empty result would page somebody every night the
    // app happened to be unused, and would be switched off within a week.
    _setAthenaForTests(async () => []);
    _setInvokerForTests(async () => { throw new Error('must not be called'); });

    const out = await rollupHandler();
    assert.equal(out.rows, 0);
});

test('a row with no day is dropped rather than written', async (t) => {
    t.after(restore);

    _setAthenaForTests(async () => ([
        { day: null, source: 'cold', opens: '1', users: '1' },
        { day: '2026-08-14', source: 'cold', opens: '2', users: '2' },
    ]));
    let received = null;
    _setInvokerForTests(async (payload) => { received = payload; return { written: 1 }; });

    await rollupHandler();
    assert.equal(received.rows.length, 1);
    assert.equal(received.rows[0].day, '2026-08-14');
});

test('a missing source becomes unknown rather than null', async (t) => {
    t.after(restore);

    // `source` is NOT NULL in the table. A new client that stops sending it
    // should cost a bucket labelled `unknown`, not a failed nightly job.
    _setAthenaForTests(async () => ([{ day: '2026-08-14', source: null, opens: '1', users: '1' }]));
    let received = null;
    _setInvokerForTests(async (payload) => { received = payload; return { written: 1 }; });

    await rollupHandler();
    assert.equal(received.rows[0].source, 'unknown');
});

// ---------------------------------------------------------------------------
// The database half
// ---------------------------------------------------------------------------

test('the write is one statement with column-wise arrays', async (t) => {
    t.after(() => _setPoolForTests(null));

    let sql = '';
    let params = null;
    _setPoolForTests({
        query: async (q, p) => { sql = q; params = p; return { rowCount: 2 }; },
    });

    const out = await rollupDbHandler({
        op: 'daily-opens',
        rows: [
            { day: '2026-08-14', source: 'cold', opens: 12, users: 9 },
            { day: '2026-08-13', source: 'cold', opens: 7, users: 5 },
        ],
    });

    assert.equal(out.written, 2);
    // One round trip, not one per row: this runs against the same t4g.micro the
    // alarm path uses.
    assert.match(sql, /unnest/i);
    assert.deepEqual(params[0], ['2026-08-14', '2026-08-13']);
    assert.deepEqual(params[2], [12, 7]);
});

test('IT UPSERTS, BECAUSE LATE EVENTS CORRECT DAYS ALREADY WRITTEN', async (t) => {
    t.after(() => _setPoolForTests(null));

    // The trailing window is recomputed nightly precisely so a phone that was
    // offline for a week corrects the days its events belong to. An INSERT
    // would collide on the primary key and fail the whole batch.
    let sql = '';
    _setPoolForTests({ query: async (q) => { sql = q; return { rowCount: 1 }; } });

    await rollupDbHandler({ op: 'daily-opens', rows: [{ day: '2026-08-14', source: 'cold', opens: 1, users: 1 }] });

    assert.match(sql, /ON CONFLICT \(day, source\) DO UPDATE/);
    assert.match(sql, /refreshed_at = EXCLUDED\.refreshed_at/);
});

test('an empty batch touches the database at all', async (t) => {
    t.after(() => _setPoolForTests(null));

    let called = false;
    _setPoolForTests({ query: async () => { called = true; return { rowCount: 0 }; } });

    const out = await rollupDbHandler({ op: 'daily-opens', rows: [] });
    assert.equal(out.written, 0);
    assert.equal(called, false, 'no rows means no connection taken from the pool');
});

test('an unknown op is refused rather than guessed at', async () => {
    await assert.rejects(() => rollupDbHandler({ op: 'drop-everything' }), /unknown op/);
    await assert.rejects(() => rollupDbHandler({}), /unknown op/);
});
