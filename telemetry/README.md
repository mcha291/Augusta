# Telemetry

Everything behind [TELEMETRY.md](../TELEMETRY.md) — the product-analytics
pipeline, the nightly rollup, the Athena table and the BI host.

```
app → API Gateway (CognitoAuthorizer) → tish-telemetry-ingest → Firehose → S3 → Athena
                                                                              ↓
                              EventBridge → tish-telemetry-rollup (non-VPC)   ↓
                                                 └─ invoke → tish-telemetry-rollup-db (VPC) → Postgres
```

## Layout

| Path | What |
| --- | --- |
| `ingest/` | The API-facing Lambda. **Its package must never gain a database client** — CI fails the build if `pg` appears there. |
| `rollup/` | The nightly Athena → Postgres job. Two handlers, deployed as two Lambdas either side of the VPC boundary. |
| `athena/` | Table DDL, with the query idioms and the traps. |
| `metabase/` | The BI host: boot script and runbook. |

**This is a top-level directory rather than a folder inside `tish-app/` on
purpose.** §3's argument for a separate ingest Lambda is that the app backend is
VPC-attached and holds a `pg` pool against a `db.t4g.micro` — routing
high-frequency telemetry through it would contend with the query path that
decides whether an alarm fires, which is the exact contention that moved product
analytics out of Postgres in the first place. Keeping this code where the
backend's `package.json` cannot reach it is what stops that being undone by an
import.

**`ingest/` has no database client and must never have one.** If something in it
needs Postgres, it is a care fact and it is in the wrong pipeline — see §1's
routing rule. The deploy workflow enforces that rather than trusting it.

**`rollup/` is two Lambdas from one artifact**, differing only by handler, and
that is forced by networking: this account has no NAT gateway and no VPC
endpoints, so a VPC-attached function reaches RDS and nothing else, while a
non-VPC one reaches every AWS API and not RDS. The Athena half drives and
invokes the Postgres half. Same shape as `tish-app/backend/escalate.mjs`.

## Deploying

**Pushing to `main` deploys all three.**
`.github/workflows/deploy-telemetry.yml` watches `telemetry/**` and updates
`tish-telemetry-ingest`, `tish-telemetry-rollup` and `tish-telemetry-rollup-db`.
One-time OIDC setup is in [DEPLOY.md](../tish-app/backend/DEPLOY.md).

By hand, if needed:

```bash
cd telemetry/ingest && npm install --omit=dev && zip -r function.zip index.mjs package.json node_modules && aws lambda update-function-code --function-name tish-telemetry-ingest --zip-file fileb://function.zip --region ap-east-2
```

## Checking the ingest path

Invoke it directly with a synthetic API Gateway event — no app build needed.
`accepted` is how many events reached Firehose.

```bash
aws lambda invoke --function-name tish-telemetry-ingest --region ap-east-2 --cli-binary-format raw-in-base64-out --payload '{"httpMethod":"POST","requestContext":{"authorizer":{"claims":{"sub":"11111111-2222-3333-4444-555555555555"}}},"body":"{\"sent_at\":1,\"events\":[{\"name\":\"app.open\",\"at\":1,\"props\":{\"source\":\"cold\"}}]}"}' /tmp/out.json && cat /tmp/out.json
```

**Then wait.** Firehose buffers 5 MB or 300 seconds, whichever comes first, so
nothing appears in S3 for up to five minutes. That delay is not a fault, and it
is why §4 rules out querying Athena live on page load — the data is already
minutes stale, so "live" buys nothing.

```bash
aws s3 ls s3://tish-telemetry-180891490019/events/ --recursive --region ap-east-2
```

Delivery failures land in `errors/` in the same bucket, and the stream logs to
`/aws/kinesisfirehose/tish-telemetry`.

## Checking the rollup

```bash
aws lambda invoke --function-name tish-telemetry-rollup --region ap-east-2 --payload '{}' /tmp/rollup.json && cat /tmp/rollup.json
```

It is scheduled for 04:10 Taipei and is safe to run by hand at any time — the
write is an upsert over a trailing window, so a manual run just refreshes what
the last one wrote.

## The table

DDL lives in [`athena/events.sql`](athena/events.sql), with the query idioms and
the two traps worth knowing (partition filtering on `dt`, and timezone).
Partition projection means there is **no crawler and no `MSCK REPAIR`** — a new
hour is queryable the moment Firehose writes it.

## Things that will bite

- **Timestamps are Hive-format, not ISO-8601.** Athena's `timestamp` type reads
  `2026-08-14T22:57:13.495Z` as **NULL** — silently, with no error. See
  `hiveTimestamp()` in `ingest/index.mjs`.
- **Events carry `users.cognito_id`, not `users.id`.** The ingest Lambda cannot
  reach Postgres to resolve the numeric id, by design. Join where Postgres is.
- **`PutRecordBatch` returns HTTP 200 while failing individual records.**
  `FailedPutCount` is the only thing that says so; treating the 200 as delivery
  is the standard way to lose data through this API.
- **Firehose bills per record rounded up to 5 KB.** Events are packed
  newline-delimited up to that ceiling, worth roughly 25× on ingest cost. One
  byte over is two billing units. Note the packer counts *characters*, not
  bytes, so non-ASCII props could cross the line unnoticed.
- **The rollup's recompute window must cover the client's event age cap.** The
  device buffers for up to 30 days; anything older than the window is in Athena
  but never reaches `telemetry_daily_opens`, so the dashboard and Metabase
  disagree with no error anywhere.
