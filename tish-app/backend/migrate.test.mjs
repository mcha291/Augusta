// Tests for the migration runner's file discovery. The SQL-applying half needs
// a real Postgres and is exercised by hand; this covers the part that decides
// *what* runs and in *what order*, which is where a silent mistake would be
// most expensive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrationFiles } from './migrate.mjs';
import { APP_TIMEZONE, RESET_PRESERVED_TABLES, RESET_SQL, SCHEMA_SQL, SEED_SQL } from './index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function withDir(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tish-migrations-'));
  try {
    for (const f of files) writeFileSync(path.join(dir, f), '-- test\n');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('migrations are ordered by their numeric prefix, not lexically by chance', () => {
  withDir(['010_third.sql', '002_second.sql', '001_first.sql'], (dir) => {
    assert.deepEqual(listMigrationFiles(dir), ['001_first.sql', '002_second.sql', '010_third.sql']);
  });
});

test('zero-padding keeps order correct past ten migrations', () => {
  withDir(['001_a.sql', '009_b.sql', '010_c.sql', '011_d.sql'], (dir) => {
    assert.deepEqual(listMigrationFiles(dir), ['001_a.sql', '009_b.sql', '010_c.sql', '011_d.sql']);
  });
});

test('non-SQL files are ignored', () => {
  withDir(['001_real.sql', 'README.md', 'notes.txt'], (dir) => {
    assert.deepEqual(listMigrationFiles(dir), ['001_real.sql']);
  });
});

test('a missing migrations directory is empty, not an error', () => {
  assert.deepEqual(listMigrationFiles(path.join(tmpdir(), 'tish-does-not-exist-' + Date.now())), []);
});

test('a badly named migration is rejected rather than silently skipped', () => {
  withDir(['1_missing_padding.sql'], (dir) => {
    assert.throws(() => listMigrationFiles(dir), /Expected NNN_snake_case\.sql/);
  });
  withDir(['001-dashes-not-underscores.sql'], (dir) => {
    assert.throws(() => listMigrationFiles(dir), /Expected NNN_snake_case\.sql/);
  });
});

test('two migrations claiming the same number are rejected', () => {
  // Otherwise the apply order depends on the filesystem, and only one of the
  // two would ever be recorded as applied.
  withDir(['002_add_column.sql', '002_add_table.sql'], (dir) => {
    assert.throws(() => listMigrationFiles(dir), /Duplicate migration number 002/);
  });
});

test('the real migrations directory is well-formed', () => {
  // Guards the checked-in files against the mistakes above.
  assert.doesNotThrow(() => listMigrationFiles());
});

// ---------------------------------------------------------------------------
// SCHEMA_SQL parity. The migrations README states one hard rule: every migration
// must be mirrored into SCHEMA_SQL, because that constant is the from-scratch
// definition. When the two drift, a fresh database and a migrated one stop
// agreeing, and the difference surfaces much later — in production, as a missing
// column. Nothing enforced it until now; it was a convention in a README.
// ---------------------------------------------------------------------------

/**
 * SCHEMA_SQL is now assembled from TABLE_DEFINITIONS rather than written as one
 * literal, so this imports it instead of slicing it out of the source text. That
 * is strictly better: it checks the string the code would actually execute, not
 * the one a regex managed to find.
 */
function schemaSql() {
  return SCHEMA_SQL;
}

/** Every column name any migration adds, as `table.column` where discoverable. */
function migrationColumns() {
  const dir = path.join(HERE, 'migrations');
  const found = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    // Strip line comments first, so a column named only in prose doesn't count.
    const bare = sql.replace(/--[^\n]*/g, '');
    for (const m of bare.matchAll(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)/gi)) {
      found.push({ file, column: m[1] });
    }
  }
  return found;
}

test('every column added by a migration is mirrored into SCHEMA_SQL', () => {
  const schema = schemaSql();
  const columns = migrationColumns();

  // Sanity-check the extraction itself: a regex that silently matched nothing
  // would make this test pass forever while checking nothing at all.
  assert.ok(columns.length >= 5, `expected to find migration columns, found ${columns.length}`);

  const missing = columns.filter(({ column }) => !new RegExp(`\\b${column}\\b`).test(schema));
  assert.deepEqual(
    missing,
    [],
    `columns added by a migration but absent from SCHEMA_SQL: ${missing.map((m) => `${m.column} (${m.file})`).join(', ')}`
  );
});

test('every table created by a migration is mirrored into SCHEMA_SQL too', () => {
  // The sibling test above covers ADD COLUMN, which was the only shape any
  // migration used until 003 introduced CREATE TABLE. A whole table drifting is
  // the same failure as a column drifting and a considerably louder one: a fresh
  // database built from SCHEMA_SQL would simply not have it.
  const schema = schemaSql();
  const tables = [];

  const dir = path.join(HERE, 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    // Comments stripped first, same as the sibling: 003 discusses tables in
    // prose that it does not create.
    const bare = readFileSync(path.join(dir, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of bare.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)/gi)) {
      tables.push({ table: m[1], file });
    }
  }

  assert.ok(tables.length >= 1, `expected to find a migration-created table, found ${tables.length}`);

  const missing = tables.filter(({ table }) => !new RegExp(`CREATE TABLE ${table}\\b`).test(schema));
  assert.deepEqual(
    missing,
    [],
    `tables created by a migration but absent from SCHEMA_SQL: ${missing.map((m) => `${m.table} (${m.file})`).join(', ')}`
  );
});

test('medication_doses carries the columns 5.4 and 5.7 query it by', () => {
  // These are not decorative: 5.4's sweep selects on confirmed_at, escalation_level
  // and COALESCE(snoozed_until, scheduled_for), and 5.7's list needs user_id and
  // scheduled_for. A rebuild that quietly lost one would break the feature months
  // after the schema changed.
  const schema = schemaSql();
  const doses = /CREATE TABLE medication_doses[\s\S]*?\);/.exec(schema);
  assert.ok(doses, 'medication_doses must exist in SCHEMA_SQL');
  for (const column of [
    'reminder_id', 'user_id', 'scheduled_for', 'confirmed_at', 'confirmed_by',
    'snoozed_until', 'snooze_count', 'escalation_level', 'last_escalated_at',
  ]) {
    assert.match(doses[0], new RegExp(`\\b${column}\\b`), `medication_doses is missing ${column}`);
  }
  // Idempotency for both materialisation and two-device confirmation (D-1).
  assert.match(doses[0], /UNIQUE \(reminder_id, scheduled_for\)/);
});

test('push_tokens carries the columns 5.4 and 5.9 need to reach a device', () => {
  const schema = schemaSql();
  const tokens = /CREATE TABLE push_tokens[\s\S]*?\);/.exec(schema);
  assert.ok(tokens, 'push_tokens must exist in SCHEMA_SQL');
  for (const column of ['user_id', 'token', 'platform', 'created_at', 'last_seen_at']) {
    assert.match(tokens[0], new RegExp(`\\b${column}\\b`), `push_tokens is missing ${column}`);
  }
});

test('THE UNIQUE IS ON THE TOKEN ALONE, not on (user_id, token)', () => {
  // The token *is* the device address. The same string arriving for a different
  // user means the device changed hands, and the row has to move rather than
  // exist twice — otherwise the previous owner keeps receiving the new owner's
  // notifications, which in this app is somebody else's medication schedule
  // arriving on their phone. `(user_id, token)` would permit exactly that, and
  // it is the more natural-looking constraint of the two.
  const tokens = /CREATE TABLE push_tokens[\s\S]*?\);/.exec(schemaSql())[0];
  assert.match(tokens, /token\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
  assert.doesNotMatch(tokens, /UNIQUE\s*\(\s*user_id\s*,\s*token\s*\)/i);
});

test('a reset rebuilds push_tokens rather than preserving it', () => {
  // Unlike `user_relationships` — preserved because re-pairing costs a
  // two-device verification exchange — a token costs nothing to recreate: the
  // device re-registers on its next launch. Preserving it would keep rows
  // pointing at devices whose user rows may have changed underneath them.
  assert.equal(RESET_PRESERVED_TABLES.includes('push_tokens'), false);
  assert.ok(droppedTables(RESET_SQL).includes('push_tokens'));
});

test('escalation_enabled defaults to false in SCHEMA_SQL, not true', () => {
  // D-3: a default of true would switch escalation on for every reminder that
  // already exists and page caregivers about historical doses the moment the
  // feature ships. The form default is the opposite, and the two are easy to
  // conflate — hence a test rather than only a comment.
  const schema = schemaSql();
  assert.match(schema, /escalation_enabled\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+false/i);
});

// ---------------------------------------------------------------------------
// Reset semantics. Application data is disposable while the project is
// internal-testing only, but accounts are not: a reset rebuilds everything
// except `users` and the two lookup tables `users` has foreign keys to.
// ---------------------------------------------------------------------------

/** Table names in the order a SQL string drops them. */
function droppedTables(sql) {
  return Array.from(sql.matchAll(/DROP TABLE IF EXISTS (\w+)/g), (m) => m[1]);
}

/** Table names in the order a SQL string creates them. */
function createdTables(sql) {
  return Array.from(sql.matchAll(/CREATE TABLE (\w+)/g), (m) => m[1]);
}

test('a reset never drops the preserved tables', () => {
  // Dropping `users` would strand every Cognito account: the login still works,
  // the profile it keys to is gone, and the tester has to re-register.
  const dropped = droppedTables(RESET_SQL);
  for (const table of RESET_PRESERVED_TABLES) {
    assert.equal(dropped.includes(table), false, `RESET_SQL must not drop ${table}`);
  }
});

test('a reset does not recreate the preserved tables either', () => {
  // CREATE TABLE users would fail against a database that still has it, taking
  // the whole reset down with it.
  const created = createdTables(RESET_SQL);
  for (const table of RESET_PRESERVED_TABLES) {
    assert.equal(created.includes(table), false, `RESET_SQL must not recreate ${table}`);
  }
});

test('a reset rebuilds every table it drops', () => {
  const dropped = droppedTables(RESET_SQL).filter((t) => createdTables(SCHEMA_SQL).includes(t));
  const created = createdTables(RESET_SQL);
  assert.deepEqual([...dropped].sort(), [...created].sort());
});

test('drops run in reverse creation order, so foreign keys resolve', () => {
  // CASCADE would paper over a wrong order, but only by silently dropping the
  // constraints of tables it was not asked to touch — which is exactly how
  // `users` would quietly lose its gender_id/condition_id foreign keys.
  const created = createdTables(RESET_SQL);
  const dropped = droppedTables(RESET_SQL).filter((t) => created.includes(t));
  assert.deepEqual(dropped, [...created].reverse());
});

test('SCHEMA_SQL still covers every table, including the preserved ones', () => {
  const created = createdTables(SCHEMA_SQL);
  for (const table of [...RESET_PRESERVED_TABLES, 'medication_reminders', 'appointments', 'test_results']) {
    assert.ok(created.includes(table), `SCHEMA_SQL should define ${table}`);
  }
});

test('the seed is idempotent for the preserved lookup tables', () => {
  // A reset leaves genders and conditions populated, so re-seeding them without
  // a conflict clause would fail on their UNIQUE(name) and abort the seed.
  for (const line of SEED_SQL.split('\n')) {
    const match = line.match(/INSERT INTO (\w+)/);
    if (!match) continue;
    if (RESET_PRESERVED_TABLES.includes(match[1])) {
      assert.match(line, /ON CONFLICT/, `seed for preserved table ${match[1]} must tolerate existing rows`);
    }
  }
});

test('medication_reminders is rebuilt with the columns the API writes', () => {
  // The drift that started this: `alarm_labels` was in the schema constant and
  // missing from the live table, so every reminder insert and update failed.
  for (const column of ['alarms', 'alarm_labels', 'alarm_sources', 'escalation_enabled', 'alarm_repeat_count']) {
    assert.match(RESET_SQL, new RegExp(`\\b${column}\\b`), `RESET_SQL should create ${column}`);
  }
});

test('SCHEMA_SQL keeps the bounds that migration 002 constrains', () => {
  const schema = schemaSql();
  assert.match(schema, /alarm_repeat_count\s+INTEGER[\s\S]{0,80}BETWEEN\s+1\s+AND\s+6/i);
  assert.match(schema, /escalation_delay_minutes\s+INTEGER[\s\S]{0,80}BETWEEN\s+5\s+AND\s+240/i);
  assert.match(schema, /escalation_order[\s\S]{0,120}'caregiver_first',\s*'sms_first'/i);
});

// ---------------------------------------------------------------------------
// Migration 005 — users.timezone / users.locale
// ---------------------------------------------------------------------------

test('users carries the timezone and locale columns the server resolves against', () => {
  const schema = schemaSql();
  assert.match(schema, /timezone\s+TEXT\s+NOT NULL\s+DEFAULT\s+'Asia\/Taipei'/i);
  assert.match(schema, /locale\s+TEXT\s+NOT NULL\s+DEFAULT\s+'zh-Hant'/i);
});

test("migration 005's defaults reproduce the constants they replace exactly", () => {
  // The whole point of applying 005 is that it changes *nothing* about how the
  // existing two rows behave — it moves a value from a place that cannot vary
  // per user to one that can. A default that disagreed with the constant would
  // silently reschedule every materialised dose the first time a reminder was
  // edited.
  const sql = readFileSync(path.join(HERE, 'migrations', '005_users_timezone_and_locale.sql'), 'utf8');
  assert.match(sql, new RegExp(`timezone TEXT NOT NULL DEFAULT '${APP_TIMEZONE}'`));
  assert.match(sql, /locale TEXT NOT NULL DEFAULT 'zh-Hant'/);
});

test('the locale column is constrained to the locale files that actually exist', () => {
  // Unlike timezone, whose valid set is a catalog lookup and cannot be a CHECK.
  // A locale outside this set makes the server fall back silently, which is the
  // kind of bug nobody reports.
  const schema = schemaSql();
  assert.match(schema, /locale[\s\S]{0,120}CHECK\s*\(\s*locale IN \('en', 'zh-Hant'\)\s*\)/i);
});

test('005 is replay-safe, because 001-004 were replayed against a current database', () => {
  // The runner was first used on a database the reset had already brought up to
  // date, so every migration ran as a no-op except this one. ADD CONSTRAINT has
  // no IF NOT EXISTS in Postgres, hence the DO block.
  const sql = readFileSync(path.join(HERE, 'migrations', '005_users_timezone_and_locale.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS timezone/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS locale/);
  assert.match(sql, /SELECT 1 FROM pg_constraint WHERE conname = 'users_locale_check'/);
});

test('users is preserved across a reset, which is why these two needed a migration', () => {
  // The load-bearing fact behind this whole migration existing. Every other
  // schema change reached the live database by /reset-db rebuilding the table
  // from SCHEMA_SQL; `users` is never rebuilt, so it can only be altered.
  assert.ok(RESET_PRESERVED_TABLES.includes('users'));
  assert.doesNotMatch(RESET_SQL, /DROP TABLE[^;]*\busers\b/i);
});
