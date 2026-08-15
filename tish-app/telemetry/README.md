# Telemetry ingest

The product-analytics half of [TELEMETRY.md](../../TELEMETRY.md) §3.

```
app → API Gateway (CognitoAuthorizer) → tish-telemetry-ingest → Firehose → S3 → Athena
```

**This is a separate directory from `../backend/` on purpose.** §3's argument
for a separate Lambda is that the backend is VPC-attached and holds a `pg` pool
against a `db.t4g.micro` — routing high-frequency telemetry through it would
contend with the query path that decides whether an alarm fires, which is the
exact contention that moved product analytics out of Postgres in the first
place. Keeping the code somewhere the backend's `package.json` cannot reach is
what stops that from being undone by an import.

**There is no database client here and there must never be one.** If something
in this Lambda needs Postgres, it is a care fact and it is in the wrong
pipeline — see §1's routing rule.

## Deploying

**Pushing to `main` deploys this** — `.github/workflows/deploy-telemetry.yml`
watches `tish-app/telemetry/**` and updates `tish-telemetry-ingest`. The OIDC
deploy role was widened to cover it; see `../backend/DEPLOY.md`.

To deploy by hand anyway:

```bash
cd tish-app/telemetry && npm install --omit=dev && zip -r function.zip index.mjs package.json node_modules && aws lambda update-function-code --function-name tish-telemetry-ingest --zip-file fileb://function.zip --region ap-east-2
```

## Checking it works

Invoke it directly with a synthetic API Gateway event — no app build needed.
`accepted` is how many events reached Firehose.

```bash
aws lambda invoke --function-name tish-telemetry-ingest --region ap-east-2 --cli-binary-format raw-in-base64-out --payload '{"httpMethod":"POST","requestContext":{"authorizer":{"claims":{"sub":"11111111-2222-3333-4444-555555555555"}}},"body":"{\"sent_at\":1,\"events\":[{\"name\":\"app.open\",\"at\":1,\"props\":{\"source\":\"cold\"}}]}"}' /tmp/out.json && cat /tmp/out.json
```

**Then wait.** Firehose buffers 5 MB or 300 seconds, whichever comes first, so
nothing appears in S3 for up to five minutes. That delay is not a fault and it
is why §4 rules out querying Athena live on page load — the data is already
minutes stale, so "live" buys nothing.

```bash
aws s3 ls s3://tish-telemetry-180891490019/events/ --recursive --region ap-east-2
```

Delivery failures land in `errors/` in the same bucket, and the stream logs to
`/aws/kinesisfirehose/tish-telemetry`.

## The table

DDL lives in [`athena/events.sql`](athena/events.sql), with the query idioms and
the two traps worth knowing (partition filtering on `dt`, and timezone).
Partition projection means there is **no crawler and no `MSCK REPAIR`** — a new
hour is queryable the moment Firehose writes it.

## Things that will bite

- **Timestamps are Hive-format, not ISO-8601.** Athena's `timestamp` type reads
  `2026-08-14T22:57:13.495Z` as **NULL** — silently, with no error. See
  `hiveTimestamp()` in `index.mjs`.
- **Events carry `users.cognito_id`, not `users.id`.** This Lambda cannot reach
  Postgres to resolve the numeric id, by design. Join where Postgres already is.
- **`PutRecordBatch` returns HTTP 200 while failing individual records.**
  `FailedPutCount` is the only thing that says so; treating the 200 as delivery
  is the standard way to lose data through this API.
- **Firehose bills per record rounded up to 5 KB.** Events are packed
  newline-delimited up to that ceiling, which is worth roughly 25× on ingest
  cost. One byte over the ceiling is two billing units.
