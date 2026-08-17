/**
 * TELEMETRY.md §4 — the nightly aggregation that puts Athena-derived numbers
 * somewhere a dashboard can read them instantly.
 *
 * **Two handlers in one file, split across the VPC boundary, exactly as
 * `escalate.mjs` is** — and for the same unavoidable reason. This account has
 * **no NAT gateway and no VPC endpoints**, so:
 *
 * - a VPC-attached function can reach RDS and *nothing else* — no Athena, no
 *   S3, no AWS API at all, because a Lambda ENI never gets a public IP;
 * - a non-VPC function can reach every AWS API and *not* RDS, which is private.
 *
 * The rollup needs both. So the Athena half drives and invokes the database
 * half through the Lambda API, which is the direction that works: a non-VPC
 * function can call Lambda freely, whereas the reverse would need an interface
 * endpoint (~$7/month/AZ) to do what one extra invoke does for nothing.
 *
 *   EventBridge → tish-telemetry-rollup (non-VPC, Athena)
 *                     └─ invoke → tish-telemetry-rollup-db (VPC, Postgres)
 *
 * **Why nightly and not on page load**, restated because "just query Athena
 * from the portal" is the obvious shortcut and §4 rejects it on three separate
 * grounds: API Gateway REST times out at 29 seconds while Athena is
 * asynchronous and polled; every Athena query bills a 10 MB minimum, so N
 * charts × every viewer × every refresh is a real line item; and Firehose
 * buffers for five minutes, so the data is already stale and "live" buys
 * nothing. One query a night, a handful of rows, read through the API the
 * portal already has.
 */

import pg from 'pg';

const { Pool } = pg;

// Same rule as index.mjs and escalate.mjs: credentials come only from the
// environment. This file is committed to a repo with a remote.
let pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 5432,
    ssl: { rejectUnauthorized: false },
});

export function _setPoolForTests(fakePool) { pool = fakePool; }

const DATABASE = process.env.ATHENA_DATABASE || 'tish_telemetry';
const WORKGROUP = process.env.ATHENA_WORKGROUP || 'primary';

/**
 * How many days back to recompute every night.
 *
 * **Not one day, and the reason is the offline buffer.** A phone that has been
 * out of signal for a week flushes its whole buffer on the next launch, and
 * those events carry the `occurred_at` they really happened at — so last
 * Tuesday's open can arrive on Sunday. Recomputing only yesterday would leave
 * Tuesday permanently undercounted, with nothing anywhere saying so.
 *
 * Fourteen covers the client's own 30-day event age cap generously at the
 * volumes involved, and the cost of the window is a few megabytes scanned.
 */
const WINDOW_DAYS = 14;

/**
 * Athena's own polling ceiling. The scheduled Lambda gets a longer timeout than
 * this so a poll that runs long fails as a timeout here, with a message, rather
 * than as a Lambda kill with none.
 */
const MAX_POLL_MS = 120000;
const POLL_INTERVAL_MS = 1500;

/**
 * Daily app opens by source, in **Taipei days**.
 *
 * The timezone conversion happens here rather than on read, and §4 is explicit
 * about why: a dashboard opened from another timezone would otherwise silently
 * shift every daily count. Doing it once, in the query that produces the row,
 * means the stored `day` has exactly one meaning.
 *
 * `dt` is filtered as well as `occurred_at`, and both are needed. `dt` is the
 * partition — when Firehose *wrote* the record — and without a filter on it
 * every query scans the whole bucket. `occurred_at` is when the event actually
 * happened on the device. An event buffered offline for a week has a `dt` a
 * week after its `occurred_at`, so the `dt` floor is deliberately wider than
 * the day window to catch exactly those late arrivals.
 */
function dailyOpensSql(windowDays) {
    return `
        SELECT date_format(occurred_at AT TIME ZONE 'Asia/Taipei', '%Y-%m-%d') AS day,
               json_extract_scalar(props, '$.source')                          AS source,
               count(*)                                                        AS opens,
               count(DISTINCT cognito_id)                                      AS users
        FROM ${DATABASE}.events
        WHERE event = 'app.open'
          AND dt >= date_format(current_date - interval '${windowDays + 30}' day, '%Y/%m/%d/00')
          AND occurred_at AT TIME ZONE 'Asia/Taipei'
              >= current_date - interval '${windowDays}' day
        GROUP BY 1, 2
        ORDER BY 1 DESC`;
}

/**
 * The non-VPC half: run the aggregation, hand the rows to the database half.
 *
 * Triggered by EventBridge and by nothing else. Returns a summary rather than
 * throwing on an empty result — a day with no opens is a legitimate answer, and
 * a job that failed loudly on quiet days would be turned off within a week.
 */
export async function rollupHandler() {
    const rows = await athena(dailyOpensSql(WINDOW_DAYS));

    const opens = rows.map((r) => ({
        day: r.day,
        source: r.source || 'unknown',
        opens: Number(r.opens) || 0,
        users: Number(r.users) || 0,
    })).filter((r) => r.day);

    // **Logged on every run, including empty ones.** The realistic failure mode
    // for anything nightly is silence — a job that has been broken for a
    // fortnight looks exactly like a fortnight with no opens, and CloudWatch is
    // the only place the difference is visible.
    console.info('[rollup] athena returned', opens.length, 'day/source rows');

    if (opens.length === 0) return { rows: 0 };

    const { written = 0 } = await invokeDb({ op: 'daily-opens', rows: opens });
    console.info('[rollup] wrote', written, 'rows to postgres');
    return { rows: written };
}

/**
 * The VPC-attached half. Postgres only, invoked only through the Lambda API —
 * it has no API Gateway route and must never get one.
 */
export async function rollupDbHandler(event) {
    if (event?.op !== 'daily-opens') {
        throw new Error(`unknown op: ${event?.op}`);
    }

    const rows = Array.isArray(event.rows) ? event.rows : [];
    if (rows.length === 0) return { written: 0 };

    // One statement rather than a row at a time: this runs against the same
    // t4g.micro the alarm path uses, and fourteen days of round trips for a
    // job nobody is waiting on is a poor way to spend that instance's
    // connections. `unnest` keeps it to a single parameterised call.
    const written = await pool.query(`
        INSERT INTO telemetry_daily_opens (day, source, opens, users, refreshed_at)
        SELECT day, source, opens, users, now()
        FROM unnest($1::date[], $2::text[], $3::int[], $4::int[])
             AS u(day, source, opens, users)
        ON CONFLICT (day, source) DO UPDATE
            SET opens = EXCLUDED.opens,
                users = EXCLUDED.users,
                refreshed_at = EXCLUDED.refreshed_at`,
        [
            rows.map((r) => r.day),
            rows.map((r) => r.source),
            rows.map((r) => r.opens),
            rows.map((r) => r.users),
        ]);

    return { written: written.rowCount };
}

/**
 * Submit, poll, read.
 *
 * **Athena is asynchronous and there is no synchronous mode**, which is the
 * mechanic that shapes everything around it (§4): submit a query, get an id,
 * poll until it succeeds, then page the results. Queries take seconds —
 * typically 1–10, longer cold.
 */
/**
 * Test seam, matching `_setInvokerForTests` below and for the same reason:
 * Athena and the cross-VPC invoke are the two things here that cannot be
 * exercised locally, and are therefore the two most worth asserting.
 */
let athena = runAthena;
export function _setAthenaForTests(fake) { athena = fake ?? runAthena; }

async function runAthena(sql) {
    const {
        AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand,
    } = await import('@aws-sdk/client-athena');
    const client = new AthenaClient({});

    const started = await client.send(new StartQueryExecutionCommand({
        QueryString: sql,
        WorkGroup: WORKGROUP,
    }));
    const id = started.QueryExecutionId;

    const deadline = Date.now() + MAX_POLL_MS;
    for (;;) {
        const status = await client.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
        const state = status.QueryExecution?.Status?.State;

        if (state === 'SUCCEEDED') break;
        if (state === 'FAILED' || state === 'CANCELLED') {
            throw new Error(`athena ${state}: ${status.QueryExecution?.Status?.StateChangeReason || 'no reason given'}`);
        }
        if (Date.now() > deadline) throw new Error(`athena still ${state} after ${MAX_POLL_MS}ms`);

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // Paged at 1,000 rows. Fourteen days × three sources is well inside one
    // page, but a widened window or a new source dimension would quietly
    // truncate without this — and a chart missing its oldest days looks like
    // data, not like a bug.
    const out = [];
    let token;
    let first = true;
    do {
        const page = await client.send(new GetQueryResultsCommand({
            QueryExecutionId: id,
            NextToken: token,
        }));

        const meta = page.ResultSet?.ResultSetMetadata?.ColumnInfo || [];
        const names = meta.map((c) => c.Name);
        let dataRows = page.ResultSet?.Rows || [];

        // **Athena repeats the header as the first row of the first page only.**
        // Dropping it unconditionally would eat a real row from page two.
        if (first) { dataRows = dataRows.slice(1); first = false; }

        for (const row of dataRows) {
            const values = (row.Data || []).map((d) => d.VarCharValue ?? null);
            out.push(Object.fromEntries(names.map((n, i) => [n, values[i]])));
        }

        token = page.NextToken;
    } while (token);

    return out;
}

/**
 * Same shape as `escalate.mjs`'s invoker, and a test seam for the same reason:
 * invoking another Lambda is one of the two things in this file that cannot be
 * exercised locally, so it is the one most worth being able to fake.
 */
let invokeDb = defaultInvokeDb;
export function _setInvokerForTests(fake) { invokeDb = fake ?? defaultInvokeDb; }

async function defaultInvokeDb(payload) {
    const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
    const client = new LambdaClient({});
    const res = await client.send(new InvokeCommand({
        FunctionName: process.env.ROLLUP_DB_FUNCTION,
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }));
    const raw = res.Payload ? new TextDecoder().decode(res.Payload) : '';
    if (res.FunctionError) throw new Error(`db half failed: ${raw.slice(0, 300)}`);
    return raw ? JSON.parse(raw) : {};
}

export const _internals = { dailyOpensSql, WINDOW_DAYS };
