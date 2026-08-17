# Metabase

TELEMETRY.md §4 — one BI tool over both stores: Postgres for care facts, Athena
for product analytics.

**Standing up Metabase before building dashboard views is deliberate.** §4's
sequencing argument: find out which questions actually get asked repeatedly, and
only hard-code those into a purpose-built screen. It already covers far more
than a first pass suggests — bar/line/area/combo/scatter/pie/funnel/row/waterfall
charts, number and trend tiles, pivot tables with conditional formatting,
CSV/XLSX/JSON export on every card, dashboard filters wired across cards
(including a date range picker), drill-through to underlying rows, a notebook
builder for non-SQL users, a SQL editor with parameters, and scheduled
email/Slack subscriptions. The cohort overview §4 originally listed was **cut**
for exactly this reason.

## What exists

| Thing | Value |
| --- | --- |
| Instance | `i-091db41c5b16cf5e5`, `t4g.medium`, `ap-east-2`, 30 GB encrypted gp3 |
| Address | Elastic IP `43.213.218.198` (`eipalloc-0451650c399708dbf`), A record in zone `Z0492003C3ORSSH0BIWC` |
| TLS | Caddy + Let's Encrypt, auto-renewing. Port 80 world-open for the ACME challenge only; **443 restricted to one IP** |
| URL | **https://bi.ti-smarthealth.com** |
| App database | Postgres 18 container **on this instance**, data at `/var/lib/metabase-pg` |
| Security group | `sg-0fe31be0cccb4f341` — 443 to one IP, 80 world-open for ACME only, 3000 closed |
| Instance role | `tish-metabase-role` — Athena + Glue read, S3 results, SSM |
| Snapshots | DLM `policy-018c8d8a84a2d0768` — nightly 03:00 Taipei, 7 kept |
| Boot script | [`user-data.sh`](user-data.sh) |
| Version | **pinned** to `metabase/metabase:v0.63.13`; `postgres` and `athena` drivers both present |

Roughly **$32/month** running: ~$25 instance, ~$3.60 Elastic IP, ~$2.50 EBS, ~$1 snapshots.
TLS and DNS add nothing — the certificate is free and the hosted zone already existed.

**Stopped it costs ~$7/month** (EBS, snapshots, and the Elastic IP, which is
charged while detached from a running instance). Dashboards, accounts, data
sources and query history all survive on the EBS volume, and the address no
longer changes, so restarting is just a start — nothing to reconfigure. The
telemetry pipeline keeps collecting the whole time; Metabase is purely a
consumer.

Setup is complete and both data sources are connected: `TISH App` (postgres,
against `season1`) and `TISH Analytics` (athena). If either ever needs
rebuilding, the Athena one takes **no access keys** — the instance role carries
the permissions and the driver falls back to it, which is what §4 asks for.
Region `ap-east-2`, workgroup `primary`, staging directory
`s3://tish-telemetry-180891490019/athena-results/`.

`TISH App` is the connection that answers **metric 2 with no dashboard code at
all** — `medication_doses` holds `scheduled_for`, `confirmed_at`,
`confirmed_reported_at` and `alarm_shown_at`, so confirmation latency is a
question you can ask in the notebook builder.

## The application database

**A Postgres 18 container on this instance**, not RDS and not H2. It started on
a dedicated `db.t4g.micro` and was migrated off on 2026-08-15 to save ~$14/month
for state that is entirely rebuildable.

Each half of that choice matters:

- **Not H2**, Metabase's default. A single file that corrupts if the JVM is
  killed mid-write, holding every dashboard, question, account and permission.
- **Not `season1`**, the app's own RDS instance. §4 says not to, and the reason
  is sharper than contention: `/reset-db` drops and recreates tables from
  `TABLE_DEFINITIONS`, so Metabase's 177 tables living there would be destroyed
  by a reset or would have to be special-cased in it. Metabase also runs
  substantial lock-taking schema migrations on every version upgrade, and the
  database that decides whether an alarm fires is not the place for a
  third-party tool's DDL.

**The trade-off being accepted is that this instance is now stateful.** Lose it
without a snapshot and the dashboards go with it — which is why the DLM policy
above is not optional. The container publishes no port to the host, so the
database is not listening on any interface the outside world can reach.

The password lives in SSM at `/tish/metabase/db-password` (SecureString) and is
read at boot by the instance role. It is never placed in EC2 user data, which
any process on the box can read from the metadata service.

```bash
aws ssm start-session --target i-091db41c5b16cf5e5 --region ap-east-2 --document-name AWS-StartInteractiveCommand --parameters command="docker exec -it metabase-db psql -U metabase -d metabase"
```

## Things that will bite

- **Port 443 is open to exactly one IP** (`115.186.235.35/32`, the address this
  was set up from). From anywhere else the page will simply hang. To add one:

  ```bash
  aws ec2 authorize-security-group-ingress --group-id sg-0fe31be0cccb4f341 --protocol tcp --port 443 --cidr YOUR.IP.HERE/32 --region ap-east-2
  ```

- **Port 80 is open to the world and must stay that way.** Let's Encrypt's
  HTTP-01 challenge comes from unpublished addresses, so it cannot be
  allowlisted. Caddy serves nothing there but the challenge and a 308 to HTTPS —
  but closing it will break renewal ~60 days later, silently, and the failure
  will look like an expired certificate rather than a firewall change.
- **Certificates renew automatically and the state that makes that work is a
  volume.** `/var/lib/caddy-data` holds the certificate and the ACME account
  key; wiping it re-issues from scratch and walks toward Let's Encrypt's rate
  limits.
- **No SSH key and no port 22.** Use Session Manager:

  ```bash
  aws ssm start-session --target i-091db41c5b16cf5e5 --region ap-east-2
  ```

- **SAML and JWT SSO are paid.** Cognito SSO is therefore a paid feature; Google
  OAuth and LDAP are free in OSS. Manually managed accounts are fine for a small
  internal team.
- **Static embedding is free and interactive embedding is not.** A signed iframe
  for one question or dashboard needs no Metabase account for the viewer, but is
  read-only, Metabase-themed, and has no drill-through. Row-level sandboxing for
  a clinician or caregiver view is Pro, ~$500/month — which is why §4 puts
  anything non-admin in our own dashboard instead.
- **Never use public links.** They are unauthenticated, and this is
  health-adjacent identifiable data.

## Rebuilding it

A fresh, empty install is `user-data.sh` plus the role and security group above,
and nothing else.

**Restoring the existing one is a volume restore, not a re-run.** The
dashboards, questions, accounts and permissions are all in the container's data
directory, so recovery means launching from the most recent DLM snapshot rather
than booting a new instance and re-running the script — which would come up
correct and empty.

There is also `tish-metabase-appdb-pre-migration`, an RDS snapshot taken
immediately before the move off RDS. It predates everything done since and is
worth keeping only until the DLM schedule has a few days of history behind it.
