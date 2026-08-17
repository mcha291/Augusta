/**
 * TELEMETRY.md §3 — product analytics ingest.
 *
 * `app → API Gateway (existing Cognito authorizer) → THIS → Firehose → S3`
 *
 * **This is a separate Lambda from `backend/index.mjs`, and it is a separate
 * directory so that stays true.** §3's argument, restated because the obvious
 * simplification is to add a route to the backend and be done:
 *
 * - The backend Lambda is VPC-attached and holds a `pg` connection pool against
 *   a `db.t4g.micro` with 1 GB of RAM. Putting high-frequency telemetry traffic
 *   on it reintroduces exactly the contention that moving product analytics out
 *   of Postgres was meant to avoid — and it would contend with the query path
 *   that decides whether an alarm fires.
 * - Outside the VPC there is no ENI cold start.
 * - **There is no database client here and there must never be one.** If
 *   something in this file ever needs Postgres, it is a care fact and it is in
 *   the wrong pipeline; see §1's routing rule.
 *
 * Not device→Firehose directly, either: that needs a Cognito *Identity* Pool
 * this project does not have (it uses a User Pool with an API Gateway
 * authorizer), pulls the AWS SDK into the app bundle, and would let any device
 * write arbitrary records to the stream.
 */

import { FirehoseClient, PutRecordBatchCommand } from '@aws-sdk/client-firehose';

const STREAM = process.env.STREAM_NAME || 'tish-telemetry';

// Created once, outside the handler, so a warm invocation reuses the connection.
const firehose = new FirehoseClient({});

/**
 * Firehose bills each record rounded **up** to 5 KB, so a 200-byte event costs
 * the same as a 5 KB one. Newline-delimited packing is what turns that from a
 * 25× overcharge into roughly nothing, and it is the single largest cost
 * decision in this pipeline.
 *
 * 5 KB exactly (5 × 1024). One byte over is two billing units, so this is a
 * ceiling and not a target to overshoot.
 */
const MAX_RECORD_BYTES = 5 * 1024;

/** `PutRecordBatch` takes at most 500 records or 4 MB per call. */
const MAX_RECORDS_PER_CALL = 500;

/**
 * More than this in one request is not a client that has been offline, it is a
 * client that is broken or hostile. The app's own buffer caps at 500 and it
 * sends at most 100 per POST.
 */
const MAX_EVENTS = 1000;

export const handler = async (event) => {
    const method = event?.httpMethod || event?.requestContext?.http?.method;

    if (method === 'OPTIONS') return respond(204, null);
    if (method !== 'POST') return respond(405, { message: 'Only POST is supported.' });

    // **The identity comes from the authorizer, never from the body.** This is
    // the whole reason a Lambda sits here rather than API Gateway integrating
    // with Firehose directly: a client that could name its own `cognito_id`
    // could attribute its behaviour to anyone.
    const claims = event?.requestContext?.authorizer?.claims;
    const cognitoId = claims?.sub;
    if (!cognitoId) {
        // The app treats 401 as retryable and keeps the batch, which is what
        // makes a pre-sign-in open survive until someone authenticates (§3,
        // "known and accepted").
        return respond(401, { message: 'No identity on the request.' });
    }

    let payload;
    try {
        payload = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch {
        return respond(400, { message: 'Body is not JSON.' });
    }

    const events = Array.isArray(payload?.events) ? payload.events : null;
    if (!events) return respond(400, { message: 'events must be an array.' });
    if (events.length === 0) return respond(200, { accepted: 0 });
    if (events.length > MAX_EVENTS) return respond(400, { message: 'Too many events in one batch.' });

    const receivedAt = Date.now();

    /**
     * How wrong the device's clock is, measured against ours.
     *
     * `sent_at` is the device's clock at the moment it flushed, so
     * `receivedAt - sent_at` is skew plus network latency — and latency is
     * milliseconds while the skew this exists to catch is minutes to years.
     * Applying one offset to the whole batch is what makes the correction
     * sound: every event in it was stamped by the same clock, so the *gaps
     * between them* are already right and only the anchor is wrong.
     *
     * The raw device value is kept alongside. A correction that cannot be
     * undone is a lossy edit to data that has not been analysed yet.
     */
    const sentAt = Number(payload?.sent_at);
    const skewMs = Number.isFinite(sentAt) ? receivedAt - sentAt : 0;

    const lines = [];
    for (const item of events) {
        const line = toLine(item, cognitoId, receivedAt, skewMs);
        if (line) lines.push(line);
    }
    if (lines.length === 0) return respond(200, { accepted: 0 });

    try {
        await deliver(pack(lines));
    } catch (e) {
        // 5xx, so the app keeps the batch and the next sync retries it.
        console.error('[telemetry] could not deliver to Firehose', e);
        return respond(502, { message: 'Could not accept the batch.' });
    }

    return respond(200, { accepted: lines.length });
};

/**
 * One event as the line that lands in S3, or null if it is not usable.
 *
 * **`props` is stringified rather than nested**, per §3. A JSON string column
 * parsed with `json_extract` at query time means a new event type needs no
 * table change, no Glue update and no migration — which is the extensibility
 * Postgres could not offer and the reason this pipeline exists at all.
 */
function toLine(item, cognitoId, receivedAt, skewMs) {
    if (!item || typeof item.name !== 'string') return null;

    const deviceAt = Number(item.at);
    if (!Number.isFinite(deviceAt)) return null;

    let props = '{}';
    try {
        props = JSON.stringify(item.props ?? {});
    } catch {
        // Unserialisable props cost the props, not the event. Knowing an open
        // happened is most of the value; knowing which source it had is the
        // rest, and half of something beats none of it.
        props = '{}';
    }

    return JSON.stringify({
        event: item.name,
        // Skew-corrected, and the column every query should use.
        occurred_at: hiveTimestamp(deviceAt + skewMs),
        // What the device actually claimed, kept so the correction is reversible.
        device_at: hiveTimestamp(deviceAt),
        received_at: hiveTimestamp(receivedAt),
        clock_skew_ms: skewMs,
        // `users.cognito_id`. Not `users.id` — that mapping lives in Postgres
        // and this Lambda deliberately cannot reach it. Anything needing the
        // join does it where Postgres is, which is the nightly rollup (§4).
        cognito_id: cognitoId,
        props,
    });
}

/**
 * `YYYY-MM-DD HH:mm:ss.SSS`, UTC — what Athena's `timestamp` type actually
 * parses.
 *
 * **Not `toISOString()`, and this is a trap worth naming.** ISO 8601 with its
 * `T` separator and `Z` suffix is the obvious thing to write and Athena reads
 * it as **NULL** against a `timestamp` column — no error, no warning, just a
 * column of nulls discovered whenever someone first runs a query. Declaring the
 * columns `string` and calling `from_iso8601_timestamp()` everywhere is the
 * other way out, and it is worse: §4 points Metabase at this, and Metabase
 * gives a real timestamp column date pickers and time-series grouping that a
 * string does not get.
 *
 * The values are UTC and Athena timestamps carry no zone, so anything bucketing
 * by day must say so — `occurred_at AT TIME ZONE 'Asia/Taipei'` — or a dashboard
 * opened from another timezone silently shifts every daily count (§4).
 */
function hiveTimestamp(ms) {
    return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

/** Newline-delimited lines packed into records at most 5 KB each. */
function pack(lines) {
    const records = [];
    let current = '';

    for (const line of lines) {
        // +1 for the newline this line will carry.
        if (current && current.length + line.length + 1 > MAX_RECORD_BYTES) {
            records.push(current);
            current = '';
        }
        current += line + '\n';
    }
    if (current) records.push(current);

    return records;
}

/**
 * Sends every record, retrying whatever Firehose individually rejects.
 *
 * `PutRecordBatch` succeeds at the HTTP level while failing individual records
 * — `FailedPutCount` is the only thing that says so. Treating a 200 as delivery
 * is the standard way to lose data through this API silently.
 */
async function deliver(records) {
    for (let i = 0; i < records.length; i += MAX_RECORDS_PER_CALL) {
        let chunk = records.slice(i, i + MAX_RECORDS_PER_CALL);

        // One retry. Firehose's per-record failures are throughput throttles,
        // which clear in milliseconds; anything still failing after a second
        // attempt is not transient and the client's own buffer is the better
        // place for it to wait.
        for (let attempt = 0; attempt < 2 && chunk.length > 0; attempt++) {
            const res = await firehose.send(new PutRecordBatchCommand({
                DeliveryStreamName: STREAM,
                Records: chunk.map((data) => ({ Data: Buffer.from(data, 'utf8') })),
            }));

            if (!res.FailedPutCount) return;

            const responses = res.RequestResponses || [];
            chunk = chunk.filter((_, index) => responses[index]?.ErrorCode);
            console.warn('[telemetry] Firehose rejected', chunk.length, 'records; retrying');
        }

        if (chunk.length > 0) throw new Error(`Firehose rejected ${chunk.length} records`);
    }
}

function respond(statusCode, body) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
            'Access-Control-Allow-Methods': 'POST,OPTIONS',
        },
        body: body == null ? '' : JSON.stringify(body),
    };
}
