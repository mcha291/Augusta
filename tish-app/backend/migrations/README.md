# Migrations

Numbered, additive `.sql` files applied by `../migrate.mjs`. One file per
change, never edited once it has been applied anywhere.

```bash
cd tish-app/backend
DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=... node migrate.mjs status
```

```bash
cd tish-app/backend
DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=... node migrate.mjs up
```

## Adding one

1. `NNN_short_description.sql`, taking the next free number.
2. Additive only — `ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`. Prefer
   `IF NOT EXISTS` so a re-run is harmless.
3. **Mirror the change into `SCHEMA_SQL` in `../index.mjs`.** That constant is
   the from-scratch definition; if the two drift, a fresh database and a
   migrated one stop agreeing and the difference surfaces much later, in
   production, as a missing column.

## Two things to know about this project specifically

- **Deploys are manual.** Running a migration is a separate act from shipping
  Lambda code — nothing applies these automatically. See `../DEPLOY.md`.
- **The data plane is mid-migration to `ap-east-2`** (`MIGRATION.md` Track C).
  A migration applied before the RDS snapshot must be re-applied after it, and
  while both databases are live it has to be applied to both. `schema_migrations`
  is per-database, so `status` will tell you honestly which one is behind.
