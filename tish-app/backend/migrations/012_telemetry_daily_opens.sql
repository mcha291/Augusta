-- TELEMETRY.md §4 — where the nightly Athena rollup lands.
--
-- **This table is a cache, not a record.** Every row in it is derivable from
-- S3 by re-running the rollup, nothing writes to it except the rollup job, and
-- losing the whole thing costs one night. That is what makes it safe to put
-- Athena-derived data on the same `db.t4g.micro` the alarm path uses: §3 kept
-- *events* off this instance because a scan over millions of rows contends with
-- the query that decides whether an alarm fires — this is a handful of rows per
-- day, written once nightly and read by an indexed point lookup.
--
-- **Why it exists at all**, from §4: the browser can never talk to Athena
-- directly, and proxying live is wrong on three counts — API Gateway REST has a
-- 29-second integration timeout while Athena is asynchronous and polled, every
-- Athena query bills a 10 MB minimum so N charts × every viewer × every refresh
-- is a real line item, and the data is already minutes stale from Firehose
-- buffering so "live" buys nothing. Aggregating nightly into a few rows the
-- portal reads through the API it already has costs one query per night total.
--
-- **Days are Taipei days**, resolved in the Athena query that produces them
-- (`occurred_at AT TIME ZONE 'Asia/Taipei'`), so this column is a plain DATE
-- with no zone to re-interpret. A dashboard opened from another timezone must
-- not shift every daily count, which is exactly what storing an instant here
-- and truncating on read would do.

CREATE TABLE IF NOT EXISTS telemetry_daily_opens (
    -- Taipei calendar day.
    day    DATE NOT NULL,
    -- 'cold' | 'foreground' | 'notification'. Kept as a text column rather than
    -- an enum or a lookup: §3's whole argument for the S3 pipeline is that a
    -- new event dimension must not need a schema change, and a rollup that
    -- rejected an unknown source would reintroduce that on the way back in.
    source TEXT NOT NULL,

    opens  INTEGER NOT NULL,
    -- Distinct `cognito_id`s, counted in Athena. Not summable across rows —
    -- somebody who opened from both a notification and cold appears in two.
    users  INTEGER NOT NULL,

    -- When the rollup last wrote this row. A stale dashboard is indistinguishable
    -- from a quiet week otherwise, and the job failing silently for a fortnight
    -- is the realistic failure mode for anything on a nightly schedule.
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The rollup re-computes a trailing window every night and upserts, so
    -- events that arrive late — a phone that was offline for a week — correct
    -- the days they belong to rather than landing on the day they were
    -- received. This is what makes that an upsert instead of an append.
    PRIMARY KEY (day, source)
);

-- The only read pattern: a date range, newest first.
CREATE INDEX IF NOT EXISTS telemetry_daily_opens_day_idx
    ON telemetry_daily_opens (day DESC);
