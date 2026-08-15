#!/bin/bash
#
# TELEMETRY.md §4 — the Metabase host's first boot.
#
# Kept in the repo because it is the whole definition of this instance: there is
# no config management here, and an EC2 box whose setup exists only in a console
# field is one nobody can rebuild.
#
# **Metabase's application database is a Postgres container on this box**, not
# RDS and not H2, and each half of that is a deliberate choice:
#
# - **Not H2.** It is Metabase's default and is not supported for production. It
#   is a single file that corrupts if the JVM is killed mid-write, and it holds
#   every dashboard, question, account and permission in the install.
# - **Not the app's RDS instance (`season1`).** §4 says not to, and the reason
#   is sharper than contention: `/reset-db` drops and recreates tables from
#   `TABLE_DEFINITIONS`, so Metabase's ~40 tables living there would be
#   destroyed by a reset or would have to be special-cased in it. Metabase also
#   runs substantial lock-taking schema migrations on every version upgrade,
#   and the database that decides whether an alarm fires is not the place for a
#   third-party tool's DDL.
# - **Not a dedicated RDS instance either**, which is what this replaced — that
#   was ~$14/month for state that is entirely rebuildable and is backed up here
#   by EBS snapshots instead.
#
# The trade-off being accepted: lose this instance without a snapshot and the
# dashboards go with it. That is why the snapshot schedule is not optional.
set -euxo pipefail

REGION=ap-east-2
PASSWORD_PARAM=/tish/metabase/db-password
# **Mounted at `/var/lib/postgresql`, not `/var/lib/postgresql/data`.** From 18
# onward the official image stores data in a major-version subdirectory
# (`/var/lib/postgresql/18/docker`) so that `pg_upgrade --link` works without
# crossing a mount boundary. Mounting the old path makes the container refuse
# to start, with the data sitting in what it calls an "unused mount/volume".
PGDATA_DIR=/var/lib/metabase-pg

dnf update -y
dnf install -y docker
systemctl enable --now docker

APPDB_PASSWORD="$(aws ssm get-parameter --name "$PASSWORD_PARAM" --with-decryption --region "$REGION" --query 'Parameter.Value' --output text)"

# A user-defined network so the two containers resolve each other by name.
# Metabase then reaches Postgres as `metabase-db` with nothing published to the
# host — the database is not listening on any interface the outside world can
# reach, which is the one security property RDS was providing for free.
docker network create metabase-net || true

mkdir -p "$PGDATA_DIR"

docker run -d \
  --name metabase-db \
  --restart unless-stopped \
  --network metabase-net \
  -e POSTGRES_DB=metabase \
  -e POSTGRES_USER=metabase \
  -e POSTGRES_PASSWORD="$APPDB_PASSWORD" \
  -v "$PGDATA_DIR":/var/lib/postgresql \
  postgres:18-alpine

# Metabase fails its own startup if the database is not accepting connections
# yet, and `--restart unless-stopped` would then loop it. Waiting here costs a
# few seconds on first boot and removes that race.
for i in $(seq 1 60); do
  if docker exec metabase-db pg_isready -U metabase -d metabase; then break; fi
  sleep 2
done

docker run -d \
  --name metabase \
  --restart unless-stopped \
  --network metabase-net \
  -p 3000:3000 \
  -e MB_DB_TYPE=postgres \
  -e MB_DB_DBNAME=metabase \
  -e MB_DB_PORT=5432 \
  -e MB_DB_USER=metabase \
  -e MB_DB_PASS="$APPDB_PASSWORD" \
  -e MB_DB_HOST=metabase-db \
  -e JAVA_TOOL_OPTIONS="-Xmx2g" \
  metabase/metabase:latest

unset APPDB_PASSWORD
