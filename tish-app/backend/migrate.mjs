#!/usr/bin/env node
//
// Additive schema migrations, run by hand against RDS.
//
// Why this exists: schema lived only in `SCHEMA_SQL` as DROP TABLE + CREATE
// TABLE, which can only ever build a database from scratch. There was no way
// to add a column to a live one without destroying the data in it.
//
// Deliberately not a framework. It is a directory of numbered .sql files, a
// table recording which have been applied, and this script.
//
//   node migrate.mjs status     list applied and pending migrations
//   node migrate.mjs up         apply every pending migration, in order
//   node migrate.mjs up --dry-run   show what would run, touch nothing
//
// Connects with the same DB_* environment variables the Lambda uses:
//
//   DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=... node migrate.mjs up
//
// Rules for adding a migration:
//
//   1. Create `migrations/NNN_short_description.sql` with the next number.
//   2. Make it additive — ADD COLUMN, CREATE TABLE, CREATE INDEX. No
//      destructive rewrites; a migration that has shipped is never edited.
//   3. Mirror the same change into `SCHEMA_SQL` in index.mjs, so a
//      from-scratch build and a migrated database converge on one shape.
//      This is the step that is easy to forget and expensive to discover.
//
// Each file runs inside its own transaction together with the bookkeeping
// insert, so a failure leaves neither a half-applied migration nor a false
// record of one. Note Postgres runs DDL transactionally, which is what makes
// this safe without any extra machinery.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const CREATE_MIGRATIONS_TABLE = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        applied_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`;

/** Migration files, ordered by their numeric prefix. */
export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }

  const files = entries.filter((f) => f.endsWith('.sql'));

  for (const file of files) {
    if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(file)) {
      throw new Error(
        `Bad migration filename "${file}". Expected NNN_snake_case.sql, e.g. 001_add_meal_times.sql`
      );
    }
  }

  const seen = new Map();
  for (const file of files) {
    const version = file.slice(0, 3);
    if (seen.has(version)) {
      // Two files claiming the same number would apply in an order that
      // depends on the filesystem. Refuse rather than guess.
      throw new Error(`Duplicate migration number ${version}: "${seen.get(version)}" and "${file}"`);
    }
    seen.set(version, file);
  }

  return files.sort((a, b) => a.localeCompare(b, 'en'));
}

function makePool() {
  return new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 5432,
    ssl: { rejectUnauthorized: false },
  });
}

async function appliedVersions(client) {
  await client.query(CREATE_MIGRATIONS_TABLE);
  const res = await client.query('SELECT version FROM schema_migrations ORDER BY version ASC');
  return new Set(res.rows.map((r) => r.version));
}

export async function status(client) {
  const applied = await appliedVersions(client);
  const files = listMigrationFiles();

  if (files.length === 0) {
    console.log('No migrations found in', MIGRATIONS_DIR);
    return { pending: [] };
  }

  const pending = [];
  for (const file of files) {
    const version = file.slice(0, 3);
    const isApplied = applied.has(version);
    if (!isApplied) pending.push(file);
    console.log(`${isApplied ? '  applied' : '  PENDING'}  ${file}`);
  }

  // A version recorded in the database with no corresponding file means this
  // checkout is older than the database. Applying "pending" work on top of
  // that is how databases get into shapes nobody can reproduce.
  const fileVersions = new Set(files.map((f) => f.slice(0, 3)));
  const orphaned = [...applied].filter((v) => !fileVersions.has(v));
  if (orphaned.length > 0) {
    console.warn(
      `\n! The database records ${orphaned.length} migration(s) with no file here: ${orphaned.join(', ')}.` +
      `\n  This checkout is behind the database. Pull before migrating.`
    );
  }

  console.log(`\n${applied.size} applied, ${pending.length} pending.`);
  return { pending, orphaned };
}

export async function up(client, { dryRun = false } = {}) {
  const { pending, orphaned } = await status(client);

  if (orphaned?.length > 0 && !dryRun) {
    throw new Error('Refusing to migrate: the database is ahead of this checkout (see warning above).');
  }

  if (pending.length === 0) {
    console.log('\nNothing to do.');
    return { applied: [], pending: [], orphaned };
  }

  if (dryRun) {
    console.log(`\n--dry-run: would apply ${pending.length} migration(s), nothing was changed.`);
    return { applied: [], pending, orphaned, dryRun: true };
  }

  for (const file of pending) {
    const version = file.slice(0, 3);
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    process.stdout.write(`\nApplying ${file} ... `);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      console.log('ok');
    } catch (e) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      // Stop at the first failure. Later migrations may assume this one landed.
      throw new Error(`Migration ${file} failed and was rolled back: ${e.message}`);
    }
  }

  console.log(`\nApplied ${pending.length} migration(s).`);
  return { applied: pending, pending: [], orphaned };
}

/**
 * Lambda entry point — **the VPC-attached migration runner** that §0.7 item 1
 * described and that four sessions deferred.
 *
 * It is here rather than in a throwaway function because the reason it was
 * needed does not go away: RDS is private and `tish-rds-sg` admits 5432 from the
 * Lambda security group only (D3/D3b), so a migration can only be applied from
 * inside the VPC. A dev machine cannot reach the database at all, which is why
 * `npm run migrate` has never once been run against Taipei.
 *
 * **Deliberately not a route on the API.** §0.7 is explicit that adding one
 * would recreate the P0.1 class of problem — an unauthenticated endpoint that
 * rewrites the schema — so this is a separate function with no API Gateway
 * integration, invoked by hand with `aws lambda invoke`. It has no schedule and
 * no trigger; nothing calls it unless a person does.
 *
 *   { "command": "status" }            list applied and pending
 *   { "command": "up", "dryRun": true } show what would run, touch nothing
 *   { "command": "up" }                 apply every pending migration
 *
 * `up` is the default only for `status`; applying requires asking for it by
 * name, because an empty event should never migrate a database.
 */
export async function handler(event = {}) {
  const command = event.command ?? 'status';
  const dryRun = event.dryRun === true;

  if (!['status', 'up'].includes(command)) {
    return { ok: false, error: `Unknown command "${command}". Use: status | up` };
  }

  for (const varName of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
    if (!process.env[varName]) {
      return { ok: false, error: `Missing required environment variable ${varName}.` };
    }
  }

  const pool = makePool();
  const client = await pool.connect();
  try {
    const result = command === 'status'
      ? await status(client)
      : await up(client, { dryRun });
    return { ok: true, command, dryRun, ...result };
  } catch (e) {
    // Returned rather than thrown so `aws lambda invoke` shows the reason
    // instead of an opaque Unhandled. Each migration runs in its own
    // transaction, so a failure here has already rolled itself back.
    return { ok: false, command, error: String(e?.message ?? e) };
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const command = process.argv[2] || 'status';
  const dryRun = process.argv.includes('--dry-run');

  if (!['status', 'up'].includes(command)) {
    console.error(`Unknown command "${command}". Use: status | up [--dry-run]`);
    process.exit(2);
  }

  for (const varName of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
    if (!process.env[varName]) {
      console.error(`Missing required environment variable ${varName}.`);
      console.error('Credentials come from the environment by design — never hardcode them.');
      process.exit(2);
    }
  }

  console.log(`Database: ${process.env.DB_NAME} at ${process.env.DB_HOST}\n`);

  const pool = makePool();
  const client = await pool.connect();
  try {
    if (command === 'status') await status(client);
    else await up(client, { dryRun });
  } finally {
    client.release();
    await pool.end();
  }
}

// Only run when invoked directly, so the helpers above stay unit-testable.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\n${e.message}`);
    process.exit(1);
  });
}
