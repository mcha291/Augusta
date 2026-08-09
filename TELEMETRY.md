# Telemetry — design agreed, nothing built

A design session only. **No code was written and no infrastructure exists.**
Nothing in the working tree changed; the two metrics below are still entirely
unimplemented. Read this before starting, then start at §7.

The two metrics asked for:

1. **How often a user opens the app.**
2. **How long it takes a user to confirm taking a dose.**

---

## 1. The routing rule, which is the actual design

These two are not the same kind of thing, and lumping all future "things to
track" into one system is the mistake this design exists to avoid.

**Care facts** — when a dose was confirmed, how long after the alarm, whether a
caregiver pressed it. Low volume, high per-row value, needs exact joins to
`medication_reminders` and `users`, may need to be shown back to a patient or
caregiver, arguably part of the record. → **Postgres**, on the row it describes.

**Product analytics** — app opens, screen views, taps, funnels, retention. High
volume, low per-event value, exploratory, tolerant of approximation, never
displayed to a user. → **S3 via Firehose, queried with Athena.**

Metric 2 looks like analytics but is a care fact: it is already a property of a
row that exists. Metric 1 is pure product analytics.

**Every future metric gets routed by this rule**, which is the point — it means
"we want to track X too" never reopens this discussion.

---

## 2. Metric 2 — dose confirmation latency (Postgres)

### What already exists

`medication_doses` (migration `003`) materialises **one row per scheduled dose**
at schedule time, with `confirmed_at` NULL until confirmed. That is what makes
the missed list (5.7) and escalation (5.4) possible, and it means
`confirmed_at - scheduled_for` is a latency you can query **today**, with no
code at all.

### Why that number is wrong as it stands

Three timestamps matter; only two exist.

| moment | where it lives |
|---|---|
| dose was due | `medication_doses.scheduled_for` ✅ |
| alarm appeared on screen | nowhere ❌ |
| patient pressed Confirm | approximated by `confirmed_at` ⚠️ |

1. **`confirmed_at` is when the POST landed, not when the button was pressed.**
   [`dose-queue.ts`](tish-app/utils/dose-queue.ts) already captures
   `occurredAt = Date.now()` at press time and persists it with the queue entry
   — but only uses it to pick the right dose on replay, and never sends it. An
   offline confirm replayed at the next launch records a latency hours too long.
2. **"Alarm rang → pressed" and "dose due → pressed" are different questions.**
   A patient who left the phone in another room scores badly on the second and
   instantly on the first. Both are worth having; the first is unobtainable
   without the device reporting when the overlay opened.
3. **Caregiver confirms skew it.** `confirmed_by <> user_id` is different
   behaviour and must be segmented, not averaged in.

### The change

**Migration `009_dose_confirmation_timing.sql`** (next free number; `001`–`008`
are taken):

```sql
ALTER TABLE medication_doses
    ADD COLUMN IF NOT EXISTS alarm_shown_at        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS confirmed_reported_at TIMESTAMPTZ;
```

**Do not change `confirmed_at`.** It feeds escalation (5.4) and the missed list
(5.7). Making a safety-critical column come from a device clock to serve a
metric is the one thing that must not happen here. The two new columns are
telemetry-only, nullable, and read by nothing else.

Four edits:

- **[`components/alarm-overlay.tsx`](tish-app/components/alarm-overlay.tsx)** —
  a `shownAt` ref set in the existing `isVisible` effect (~line 58); pass
  `shownAt` and `Date.now()` into `recordDoseAction`.
- **[`utils/dose-queue.ts`](tish-app/utils/dose-queue.ts)** — send `occurred_at`
  and `alarm_shown_at` in the immediate POST body (~line 76) *and* the replay
  body (~line 183). `occurredAt` is already in hand in both places.
- **[`backend/index.mjs`](tish-app/backend/index.mjs)** — the POST branch of
  `/medication-doses` (~line 1684). Write the two columns, **clamped**:
  `LEAST(now(), ...)` and reject anything before `scheduled_for - 12h`, so a
  device with a wrong clock cannot poison the data.
- **Mirror both columns into `SCHEMA_SQL`** in the same file (~line 145), per
  [migrations/README.md](tish-app/backend/migrations/README.md) — a fresh
  database and a migrated one must not drift.

Cost: **zero new rows**, ~16 bytes on rows that already exist, ≈48 KB/user/year.

### Reading it

```sql
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY lag) AS median,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY lag) AS p90,
       COUNT(*)
FROM (SELECT COALESCE(confirmed_reported_at, confirmed_at) - scheduled_for AS lag
      FROM medication_doses
      WHERE confirmed_at IS NOT NULL
        AND confirmed_by = user_id          -- exclude caregiver confirms
        AND scheduled_for > now() - interval '30 days') s;
```

Reaction time is then `confirmed_reported_at - alarm_shown_at`, free.

**Latency can legitimately be negative.** The POST handler resolves to the
nearest dose within ±12h ([index.mjs:1661](tish-app/backend/index.mjs)), so
confirming at 07:00 for an 08:00 dose matches the 08:00 row. Percentiles and a
`lag >= interval '0'` filter are the honest read; do not average blindly.

---

## 3. Metric 1 — app opens (Firehose → S3 → Athena)

### Why not Postgres

Not disk. The binding argument is **contention**: RDS is `db.t4g.micro`, 20 GB,
1 GB RAM ([MIGRATION.md:282](MIGRATION.md)). A scan-heavy analytics query
competes with the query path that decides whether an alarm fires, on the same
instance `escalate.mjs` sweeps. Product analytics does not belong there.

(Sizing, for the record, since it was worked out: a trimmed events table would
be ~110 bytes/event ≈ 0.40 MB/user/year — actually *less* than
`medication_doses` at ~0.63. So size alone would have been survivable. It was
the wrong reason to reject it.)

### Why not PostHog / Amplitude / Firebase

**Decided: patient behavioural data must not leave our AWS account.** "User
4,821 took 47 minutes to confirm their evening dose" is health-adjacent and
identifiable. This rules out every SaaS option. Be clear-eyed that PostHog's
free tier would have been cheaper in dollars and *much* cheaper in hours — the
engineering time is what buys residency.

### Ingestion path

```
app → API Gateway (existing Cognito authorizer) → NEW Lambda → PutRecordBatch → Firehose → S3
```

**Not device → Firehose directly.** That needs a Cognito *Identity* Pool we do
not have (we use a User Pool with an API Gateway authorizer), pulls the AWS v3
SDK and polyfills into the bundle, and lets any device write arbitrary records
to the stream.

**A separate Lambda, outside the VPC, with no Postgres client.** This matters:
adding the route to [`backend/index.mjs`](tish-app/backend/index.mjs) would put
high-frequency telemetry traffic on a Lambda holding a connection pool against
a t4g.micro — reintroducing the exact contention we left Postgres to avoid.
Non-VPC also skips the ENI cold start. The Lambda stamps `user_id` from the JWT
claims so the client cannot spoof attribution.

Later optimisation, not first: API Gateway can integrate with Firehose directly
via a mapping template injecting `$context.authorizer.claims.sub`, no Lambda.
Fewer moving parts, more fiddly to debug.

### Athena setup — decisions that are painful to reverse

- **Partition projection, not a Glue crawler.** Firehose writes
  `.../YYYY/MM/dd/HH/`; without partitions every query scans the whole bucket.
  Projection is declared once in `TBLPROPERTIES` and never needs
  `MSCK REPAIR`. Most-missed step.
- **JSON + GZIP first, Parquet later.** Parquet needs a Glue table as schema
  reference and makes schema evolution a chore — which fights "many more things
  to track" directly. At a few hundred MB the scan savings are cents. Convert
  when scan cost shows up on a bill.
- **Keep a `props` JSON string column**, parsed with `json_extract` at query
  time. A new event type then needs *no* infrastructure change. This is the
  extensibility win Postgres could not give.
- **Batch events into one Firehose record.** Firehose bills each record rounded
  up to **5 KB**, so a 200-byte event costs the same as 5 KB. Newline-delimited
  packing cuts ingest cost ~25×.

### Client

You own the transport — no SDK. Model it on the dose queue, which solved this
same problem already: a pure, dependency-free, unit-tested policy module plus an
I/O module.

- **`utils/telemetry-policy.ts`** — buffer cap, flap collapsing, clock-skew
  clamp, batching rules. No imports, so `npm run test`
  (`node --test "utils/*.test.ts"`) runs it directly. Follows
  [`dose-queue-policy.ts`](tish-app/utils/dose-queue-policy.ts).
- **`utils/telemetry.ts`** — AsyncStorage buffer + batched POST. Never throws,
  never awaited by UI.
- **[`app/_layout.tsx`](tish-app/app/_layout.tsx)** — the `AppState` listener.
  There is currently **no `AppState` usage anywhere in the app**; this is new.
- **Flush** alongside `flushDoseQueue()` in
  [`use-notification-sync.ts:110`](tish-app/hooks/use-notification-sync.ts),
  which already runs at launch and on medications-screen focus.

### Three traps in the open-detection itself

1. **iOS transitions.** Home button is `active → inactive → background`;
   returning is `background → inactive → active`. Gating on "previous state was
   background" *fails*, because the listener sees `inactive` immediately before
   `active`. Track a `wasBackgrounded` flag instead, and drop flaps under ~60s
   (app switcher, Control Centre).
2. **Tag the source or the metric measures the wrong thing.** This is an
   alarm-driven app; a large share of opens are the OS launching it from a
   notification tap. Counted together with spontaneous opens, "how often do they
   open the app" mostly measures how many reminders they have. Use
   `source: 'cold' | 'foreground' | 'notification'`.
   [`_layout.tsx:140`](tish-app/app/_layout.tsx) already has the response
   listener; `Notifications.getLastNotificationResponseAsync()` covers
   cold-start-from-notification.
3. **Don't bake the session threshold into the client.** Record every foreground
   with the gap since the last one and decide what counts as a "session" in
   Athena. Otherwise changing 30 minutes to 15 means shipping a build.

Known and accepted: an open **before sign-in** has no token, buffers, and gets
attributed to whoever authenticates first — wrong person on a shared device.
Not worth solving.

---

## 4. The UI

### Already in the dashboard

`recharts@3.8`, [`src/components/ui/chart.tsx`](dashboard/src/components/ui/chart.tsx)
(shadcn's themed Recharts wrapper), `@tanstack/react-table@8.21`,
`@tanstack/react-query@5.101`, and shadcn `table`/`select`/`dialog`/`card`/
`badge`/`skeleton`. There is also a `MOCK` flag in
[`lib/config.ts`](dashboard/src/lib/config.ts) and
[`lib/mock.ts`](dashboard/src/lib/mock.ts), so these screens can be built before
the endpoints exist.

### Actually missing — a short list

1. **Date range picker** — the only real gap. `npx shadcn@latest add calendar popover`,
   which pulls `react-day-picker` and `date-fns`.
2. **CSV export** — hand-roll ~25 lines, no library. **Prepend a `﻿` BOM**
   or Excel on Windows mangles every zh-Hant medication name.
3. **`@tanstack/react-virtual`** — only once a table renders >1,000 rows. Not yet.

Do not add: a second charting library, a CSV library, a query builder.

### Stand up Metabase first, and build nothing until it falls short

Point **Metabase** at both sources — it has an official Amazon Athena driver
alongside Postgres, so one tool covers care data and product analytics. This got
*firmer* when we chose Athena, since Athena ships no front end at all.
QuickSight is the AWS-native alternative (native Athena integration, clunkier).

**It covers more than a first pass suggests**: bar/line/area/combo/scatter/pie/
funnel/row/waterfall charts, number and trend tiles, pivot and plain tables with
sorting and conditional formatting, CSV/XLSX/JSON export on every card,
dashboard filter widgets wired across multiple cards at once (including the date
range picker), drill-through to underlying rows, a notebook builder for
non-SQL users, a native SQL editor with parameters, and scheduled email/Slack
subscriptions.

Where it stops, and therefore what is still worth building by hand:

1. **It is a separate app, not a surface in the product.** Static embedding is a
   read-only iframe with limited styling; interactive embedding with SSO is paid.
2. **It shows data, it does not act.** Anything needing "select these patients →
   do something" belongs in the dashboard.
3. **Bespoke domain visuals.** A dose timeline showing confirmed/missed/snoozed
   against scheduled times per reminder is not a standard chart type.
4. **Anyone who is not an internal admin.** Row-level security for a clinician or
   caregiver view needs Metabase sandboxing — Pro pricing, ~$500/mo. Cheap in our
   own dashboard, expensive in theirs.

At current scale Metabase can query the primary; when it can't, a read replica
of a t4g.micro is ~$15/month.

### How the data actually reaches a screen

**Athena is a query service, not a database and not a UI.** There is nothing for
staff to log into. Three access paths: the AWS console query editor (IAM login,
a SQL editor, engineers only), the `StartQueryExecution` API, and JDBC/ODBC for
BI tools.

The mechanic that shapes everything: **it is asynchronous.** Submit a query, get
a `QueryExecutionId`, poll until `SUCCEEDED`, then fetch results paginated
(1,000 rows/page) or read the CSV Athena wrote to the results bucket. Queries
take seconds — typically 1–10, longer cold.

The browser can never talk to Athena directly (no AWS credentials in a browser,
same objection as device→Firehose), so any dashboard view is proxied:

```
dashboard → admin Lambda → Athena Start/GetQueryResults → JSON → Recharts
```

**But do not query Athena live on page load.** Three reasons: API Gateway REST
has a 29-second integration timeout and polling holds it open; every query is
billed with a 10 MB minimum, so N charts × every viewer × every refresh is a
real line item; and the data is already minutes stale from Firehose buffering,
so "live" buys nothing.

**Instead — and this is new infrastructure the rest of this doc does not
mention — an EventBridge-scheduled Lambda runs the aggregations nightly and
writes the small result sets into Postgres**, a handful of rows per chart. The
portal then reads them instantly through the API it already has and renders with
Recharts: full shadcn styling, no iframe, no latency, no per-view cost. **There
is currently no EventBridge scheduling wired up for anything**, so this is a new
piece to stand up.

If genuine ad-hoc Athena querying from the portal is ever wanted, the pattern is
two calls — POST starts the query and returns the id, GET polls it — and turn on
Athena query result reuse, which serves identical repeat queries from cache for
free.

### Self-hosting Metabase — what it actually involves

- A Java app (Docker `metabase/metabase`) **plus its own application database**
  for questions, dashboards, users and permissions. H2 is the default and is not
  for production; use Postgres. The JVM wants 2 GB+, so `t4g.small` is marginal
  and `t4g.medium` comfortable — roughly $15–25/month.
- **Do not put its app DB on the existing t4g.micro.** That is the contention
  problem again.
- Connect to Athena with an **instance role**, not access keys — Athena + Glue
  read + the S3 results bucket.
- **Logins are the part that bites.** Metabase has its own accounts. Google
  OAuth and LDAP are free in OSS; **SAML and JWT SSO are paid Pro/Enterprise**,
  so Cognito SSO is a paid feature. Manually managed accounts are fine for a
  small internal team.
- **Embedding into the portal is free.** Static embedding is in OSS: the server
  signs a JWT with the embedding secret and produces an iframe URL for one
  question or dashboard, optionally locked to parameter values, and **the viewer
  needs no Metabase account**. Limits: iframe, Metabase's own theming only
  (`#theme=night`, `bordered`, `titled`), read-only, no drill-through.
  Interactive embedding with drill-through and row-level sandboxing is paid.
  Public links are unauthenticated — never for this data.

**Who uses what:**

| audience | surface |
|---|---|
| engineers exploring | Metabase UI directly, over both stores |
| staff needing recurring answers | Metabase dashboards, own login |
| charts that must live in the portal | Recharts over the nightly rollup, or a signed Metabase embed |

### Do build — one view, maybe two

1. ~~Cohort overview~~ — **cut.** Metabase does stat tiles and a trend line
   completely, with filters, in minutes. Building it in shadcn is rebuilding
   Metabase badly.
2. **Per-patient drill-down** — the one that earns its keep. Doses over a range:
   confirmed, missed, snoozed, latency distribution. Domain-specific timeline,
   the join to `medication_reminders` is the whole point, and it is the view most
   likely to grow actions attached to it.
3. **Filterable dose table with export** — react-table + date range + CSV. Build
   **only** if it must sit inside the admin workflow beside translations and
   announcements. If it is just "look and export", Metabase wins.

**Sequencing:** stand up Metabase, build nothing, and find out which questions
actually get asked repeatedly. Those are the ones worth hard-coding into a
purpose-built view. Building views before knowing the questions is how you get
dashboards nobody opens.

### The decision that makes or breaks all three

**Aggregate in Postgres, not the browser.** A histogram over 50,000 doses should
cross the wire as 24 buckets:

```sql
SELECT width_bucket(
         EXTRACT(epoch FROM COALESCE(confirmed_reported_at, confirmed_at) - scheduled_for) / 60,
         0, 120, 24) AS bucket,
       COUNT(*)::int AS n
FROM medication_doses
WHERE confirmed_at IS NOT NULL AND scheduled_for BETWEEN $1 AND $2
GROUP BY 1 ORDER BY 1;
```

The existing `GET /medication-doses` has `LIMIT 500`
([index.mjs:1631](tish-app/backend/index.mjs)) and **cannot back a chart**. New
aggregate actions go in [`dashboard/server/index.mjs`](dashboard/server/index.mjs),
following its named-action router (`case 'doseLatencyHistogram'` alongside
`listTables`, `getTable`).

Export is the exception and wants the opposite shape: stream CSV from the
server, or you're capped by browser memory and whatever `LIMIT` is set.

**Timezone:** bucket by Taipei days *in SQL* —
`date_trunc('day', occurred_at AT TIME ZONE 'Asia/Taipei')` — or a dashboard
opened from another timezone silently shifts every daily count. For display,
`Intl.DateTimeFormat` with `timeZone` needs no dependency.

---

## 5. Cost

Firehose $0.029/GB, S3 $0.023/GB-mo, Athena $5/TB scanned. At 1,000 users × 10
events/day, **batched into 5 KB records**: under $1/month all in. The cost of
this decision is engineering time, not AWS spend.

---

## 6. Open question — one, and it only decides the region

**Does "must not leave our infrastructure" mean *our AWS account*, or
*physically inside Taiwan*?**

- *Our account* → if Firehose/Athena aren't in `ap-east-2` (new region, thin on
  services — **verify before building**), put the bucket and pipeline in
  `ap-northeast-1`. Telemetry is the one workload where cross-region is fine.
- *Inside Taiwan* → hard constraint on region, and if the services aren't in
  `ap-east-2` the whole pipeline needs rethinking.

Nothing else in the design depends on the answer. The client half (§7 step 1) is
identical either way and is not blocked on it.

---

## 7. Suggested order

1. **`utils/telemetry-policy.ts` + tests.** Pure, testable under `node --test`,
   no AWS, not blocked on the open question above. Then `utils/telemetry.ts` and
   the `AppState` listener, buffering locally.
2. **Migration 009 + the four dose-timing edits.** Independent of all Athena
   work, and it starts collecting the more valuable metric immediately. Deploys
   are manual — see [backend/DEPLOY.md](tish-app/backend/DEPLOY.md); the
   migration is a separate act from shipping Lambda code, and
   `MIGRATION.md` Track C means it may need applying to both databases.
3. **Answer §6**, then stand up the bucket, Firehose stream, telemetry Lambda,
   and the Athena table with partition projection.
4. **Point the client's flush at the new endpoint.**
5. **Metabase** against Postgres first — it answers metric 2 with no dashboard
   code at all. Self-hosting details in §4; budget a `t4g.medium` and its own
   application database, and add the Athena connection once step 3 exists.
6. **The nightly EventBridge aggregation job**, only once there is a portal view
   that needs Athena data. New infrastructure — nothing is scheduled today.
7. **The per-patient drill-down**, and only whatever else Metabase turns out not
   to cover — see §4, which cuts the cohort overview entirely.

## Constraints that still apply

- **Do not commit or push unless asked.**
- No new user-facing strings are involved, so no locale keys and no
  `npm run validate-translations` concern.
- `aws login` and `gh auth login` both expire — check, then ask and wait.
