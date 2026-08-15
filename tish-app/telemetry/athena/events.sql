-- TELEMETRY.md §3 — the Athena table over what Firehose writes.
--
-- Applied to Glue database `tish_telemetry` in ap-east-2. Kept in the repo
-- because the decisions below are the ones §3 calls painful to reverse, and a
-- table that exists only in a console is a table nobody can review.
--
-- **Partition projection, not a Glue crawler.** Firehose writes
-- `events/YYYY/MM/dd/HH/`; without partitions every query scans the entire
-- bucket and the bill grows with total history rather than with the range asked
-- for. Projection is declared once here and never needs `MSCK REPAIR`, a
-- crawler, or anything running on a schedule. §3 calls it the most-missed step.
--
-- **JSON + GZIP, not Parquet.** Parquet needs the Glue table as a schema
-- reference and makes schema evolution a chore, which fights "many more things
-- to track" directly. At a few hundred MB the scan savings are cents. Convert
-- when scan cost actually shows up on a bill.
--
-- **`props` is a JSON string, parsed at query time.** A new event type then
-- needs no infrastructure change at all — no ALTER, no crawler, no redeploy.
-- This is the extensibility Postgres could not give and the reason §1 routes
-- product analytics here.

CREATE DATABASE IF NOT EXISTS tish_telemetry;

CREATE EXTERNAL TABLE IF NOT EXISTS tish_telemetry.events (
    -- Dot-namespaced event name, e.g. `app.open`.
    event         string,
    -- Device clock corrected by the batch's measured skew. **The column to
    -- query.** UTC, and Athena timestamps carry no zone — see the note below.
    occurred_at   timestamp,
    -- What the device claimed before correction, so the correction is
    -- reversible and a fleet-wide clock problem stays visible.
    device_at     timestamp,
    -- Our own clock when the batch arrived. The one value here no device can
    -- influence, and therefore the honest fallback if the others look wrong.
    received_at   timestamp,
    clock_skew_ms bigint,
    -- `users.cognito_id`, stamped by the ingest Lambda from the JWT claims so a
    -- client cannot attribute its behaviour to somebody else. Not `users.id` —
    -- that mapping lives in Postgres, which the ingest Lambda deliberately
    -- cannot reach. Join it where Postgres is (the nightly rollup, §4).
    cognito_id    string,
    -- Raw JSON. Read with json_extract_scalar(props, '$.source').
    props         string
)
PARTITIONED BY (dt string)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
WITH SERDEPROPERTIES ('ignore.malformed.json' = 'true')
LOCATION 's3://tish-telemetry-180891490019/events/'
TBLPROPERTIES (
    'projection.enabled'         = 'true',
    'projection.dt.type'         = 'date',
    'projection.dt.format'       = 'yyyy/MM/dd/HH',
    -- Opened the day the pipeline was stood up. NOW is re-evaluated per query,
    -- so this never needs maintaining.
    'projection.dt.range'        = '2026/08/01/00,NOW',
    'projection.dt.interval'     = '1',
    'projection.dt.interval.unit' = 'HOURS',
    'storage.location.template'  = 's3://tish-telemetry-180891490019/events/${dt}',
    'has_encrypted_data'         = 'false'
);

-- ---------------------------------------------------------------------------
-- How to query it
-- ---------------------------------------------------------------------------
--
-- **`dt` is the partition filter and it is a string in `yyyy/MM/dd/HH` form.**
-- Filtering on `occurred_at` alone is correct but scans everything projected;
-- always narrow `dt` as well. The two differ by design — `dt` is when Firehose
-- wrote the record, `occurred_at` is when the event happened on the device, and
-- an event buffered offline for a week lands in a `dt` a week after its
-- `occurred_at`.
--
-- **Timezone.** These timestamps are UTC and Athena's `timestamp` carries no
-- zone, so anything bucketed by day must say which day it means or a dashboard
-- opened from another timezone silently shifts every count (§4).
--
--   -- Daily opens by source, Taipei days, last 30 days.
--   SELECT date_trunc('day', occurred_at AT TIME ZONE 'Asia/Taipei') AS day,
--          json_extract_scalar(props, '$.source')                    AS source,
--          count(*)                                                  AS opens,
--          count(DISTINCT cognito_id)                                AS users
--   FROM tish_telemetry.events
--   WHERE event = 'app.open'
--     AND dt >= date_format(current_date - interval '30' day, '%Y/%m/%d/00')
--   GROUP BY 1, 2
--   ORDER BY 1 DESC;
--
-- **Segment by source or the metric measures the wrong thing** (§3 trap 2).
-- This is an alarm-driven app: a large share of opens are the OS launching it
-- from a reminder tap. Counted together with spontaneous opens, "how often do
-- they open the app" mostly measures how many medications someone is on.
--
--   -- Sessions, with the threshold decided HERE rather than on the device —
--   -- which is the whole reason the client records a raw gap (§3 trap 3).
--   -- Changing 30 minutes to 15 is an edit to this line, not a new build
--   -- waiting on people to install it.
--   SELECT count_if(gap IS NULL OR gap > 30 * 60 * 1000) AS sessions
--   FROM (SELECT try_cast(json_extract_scalar(props, '$.since_last_open_ms') AS bigint) AS gap
--         FROM tish_telemetry.events
--         WHERE event = 'app.open' AND dt >= '2026/08/01/00');
