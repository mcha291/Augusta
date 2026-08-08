import pg from 'pg';
const { Pool } = pg;

// Credentials come exclusively from Lambda environment variables — never
// hardcode fallbacks here: this file is committed to a repo with a remote,
// so anything written below is effectively published.
let pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 5432,
    ssl: { rejectUnauthorized: false }
});

// Test seam: lets index.test.mjs substitute a scripted pool so the handler
// can be exercised functionally without a database connection.
export function _setPoolForTests(fakePool) { pool = fakePool; }

/**
 * The schema as one entry per table, **ordered so a table only ever references
 * tables defined before it.**
 *
 * It is a list rather than one big string because a reset needs to rebuild a
 * *subset*: application data in this project is disposable while testing, but
 * `users` must survive so Cognito-backed accounts don't have to be recreated —
 * RDS profiles key on the Cognito `sub`, so losing a profile row strands a
 * working login. The ordering is what makes a partial rebuild safe.
 *
 * This replaced a single `SCHEMA_SQL` string that only `/reset-db` ever executed.
 * That arrangement let the live database drift *behind* the constant without
 * anything noticing: `alarm_labels` sat in the schema here and was missing from
 * the deployed `medication_reminders` for long enough that reminder creation had
 * never once succeeded against the Taipei database. A from-scratch definition
 * that is never executed is not a schema; it is a document.
 */
const TABLE_DEFINITIONS = [
    { name: 'genders', create: `CREATE TABLE genders (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL);` },
    { name: 'conditions', create: `CREATE TABLE conditions (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT);` },
    { name: 'users', create: `CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        cognito_id UUID UNIQUE NOT NULL,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        phone_number TEXT UNIQUE,
        role TEXT,
        full_name TEXT,
        birth_date DATE,
        gender_id INTEGER REFERENCES genders(id),
        condition_id INTEGER REFERENCES conditions(id),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        -- Meal time preferences (migration 001). These are what make a
        -- meal-relative reminder resolvable into a clock time at all.
        breakfast_time TIME NOT NULL DEFAULT '08:00',
        lunch_time     TIME NOT NULL DEFAULT '12:30',
        dinner_time    TIME NOT NULL DEFAULT '18:30',
        bedtime_time   TIME NOT NULL DEFAULT '22:00',
        -- Migration 005. Where the patient is, and what language the *server*
        -- writes to them in. Both existed as constants until the migration
        -- runner was built, because \`users\` is preserved across a reset and so
        -- is the one table that cannot pick up a column from a rebuild.
        timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
        locale   TEXT NOT NULL DEFAULT 'zh-Hant'
            CHECK (locale IN ('en', 'zh-Hant'))
    );` },
    { name: 'user_relationships', create: `CREATE TABLE user_relationships (
        id SERIAL PRIMARY KEY,
        caregiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        dependent_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        relationship_type TEXT,
        -- Migration 007 closed this vocabulary. Free text here is an
        -- access-control hazard rather than an untidy column: \`checkAccess\`
        -- tests \`status = 'active'\`, so a revocation that misspelled the new
        -- status would report success and leave the caregiver reading the
        -- records.
        status TEXT DEFAULT 'pending'
            CHECK (status IN ('pending', 'active', 'revoked')),
        verification_code TEXT,
        -- Migration 007 (2.3). The row outlives revocation deliberately: access
        -- *was* held, and who ended it and when is the only record that a
        -- caregiver could once read this patient's history. The deny branch of
        -- /relationships/respond still deletes, because a request that was never
        -- granted has no history to keep.
        revoked_at TIMESTAMPTZ,
        revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE(caregiver_id, dependent_id),
        -- Both directions. The reverse one is what forces a re-activation to
        -- clear the revocation rather than leaving a live relationship carrying
        -- a revoked_at. \`revoked_by\` is not coupled — it is legitimately NULL
        -- on a revoked row whose actor has since been deleted.
        CONSTRAINT user_relationships_revoked_at_check
            CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
    );` },
    { name: 'medication_library', create: `CREATE TABLE medication_library (id SERIAL PRIMARY KEY, name TEXT NOT NULL, default_dosage TEXT NOT NULL);` },
    { name: 'medication_reminders', create: `CREATE TABLE medication_reminders (
        id SERIAL PRIMARY KEY, 
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, 
        med_id INTEGER REFERENCES medication_library(id),
        selected_dosage TEXT, 
        at_breakfast BOOLEAN DEFAULT false, 
        breakfast_timing TEXT DEFAULT 'after',
        at_lunch BOOLEAN DEFAULT false, 
        lunch_timing TEXT DEFAULT 'after',
        at_dinner BOOLEAN DEFAULT false, 
        dinner_timing TEXT DEFAULT 'after',
        at_bedtime BOOLEAN DEFAULT false, 
        frequency_days INTEGER DEFAULT 1, 
        status TEXT DEFAULT 'active',
        reminder_sound TEXT DEFAULT 'default',
        alarms TEXT[],
        alarm_labels TEXT[],
        -- Positionally aligned with alarms (migration 001): 'manual', or
        -- meal:before / meal:after / bedtime:at for a time derived from a meal
        -- selection. Derived entries are safe to regenerate when meal times
        -- change; manual ones must never be overwritten.
        alarm_sources TEXT[],
        -- Escalation settings (migration 002 / 2.4, D-3 and D-8). The column
        -- default for escalation_enabled must stay false: true would switch
        -- escalation on for every reminder that already exists and page
        -- caregivers about historical doses. The form default is the opposite —
        -- new reminders opt in.
        escalation_enabled BOOLEAN NOT NULL DEFAULT false,
        escalation_delay_minutes INTEGER NOT NULL DEFAULT 30
            CHECK (escalation_delay_minutes BETWEEN 5 AND 240),
        escalation_order TEXT NOT NULL DEFAULT 'caregiver_first'
            CHECK (escalation_order IN ('caregiver_first', 'sms_first')),
        -- Alarm burst count (migration 002 / 2.6, D-9). iOS only; Android is
        -- rate-limited to one alarm per nine minutes while idle, so a burst
        -- there collapses to a single alert (D-10).
        alarm_repeat_count INTEGER NOT NULL DEFAULT 3
            CHECK (alarm_repeat_count BETWEEN 1 AND 6),
        -- Snooze length (migration 008). 1-120 is the clamp the dose-action
        -- route already applied to a snooze POST, and 10 was its fallback — so
        -- the column gives that a per-reminder home rather than introducing a
        -- new range, and its default reproduces the old constant exactly.
        snooze_minutes INTEGER NOT NULL DEFAULT 10
            CHECK (snooze_minutes BETWEEN 1 AND 120)
    );

    CREATE INDEX medication_reminders_escalation_enabled_idx
        ON medication_reminders (id) WHERE escalation_enabled;` },
    // 2.2 / 5.1 — expected doses, materialised ahead of time rather than written
    // on confirmation. See migrations/003 for why that distinction is the whole
    // point of the table.
    { name: 'medication_doses', create: `CREATE TABLE medication_doses (
        id SERIAL PRIMARY KEY,
        reminder_id INTEGER NOT NULL REFERENCES medication_reminders(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- The original due time, never overwritten. A snooze moves snoozed_until,
        -- not this, or the missed list rewrites history.
        scheduled_for TIMESTAMPTZ NOT NULL,
        confirmed_at TIMESTAMPTZ,
        -- Not necessarily user_id: under D-1 a caregiver may confirm.
        confirmed_by INTEGER REFERENCES users(id),
        -- D-6: a snooze re-anchors escalation rather than counting as silence.
        snoozed_until TIMESTAMPTZ,
        snooze_count INTEGER NOT NULL DEFAULT 0
            CHECK (snooze_count >= 0),
        -- D-8's two-rung ladder (2.4's deferred half). Incremented before
        -- dispatch so a retry cannot double-send.
        escalation_level INTEGER NOT NULL DEFAULT 0
            CHECK (escalation_level BETWEEN 0 AND 2),
        last_escalated_at TIMESTAMPTZ,
        UNIQUE (reminder_id, scheduled_for)
    );

    CREATE INDEX medication_doses_user_scheduled_idx
        ON medication_doses (user_id, scheduled_for DESC);

    CREATE INDEX medication_doses_pending_idx
        ON medication_doses (scheduled_for) WHERE confirmed_at IS NULL;

    CREATE INDEX medication_doses_reminder_idx
        ON medication_doses (reminder_id, scheduled_for);` },
    { name: 'appointment_statuses', create: `CREATE TABLE appointment_statuses (id SERIAL PRIMARY KEY, label TEXT UNIQUE NOT NULL, color TEXT);` },
    { name: 'appointments', create: `CREATE TABLE appointments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        appointment_date TIMESTAMP WITH TIME ZONE NOT NULL,
        doctor_name TEXT,
        title TEXT NOT NULL,
        hospital TEXT,
        department TEXT,
        room_number TEXT,
        appointment_number TEXT,
        details TEXT,
        status_id INTEGER REFERENCES appointment_statuses(id) DEFAULT 1
    );` },
    { name: 'announcements', create: `CREATE TABLE announcements (id SERIAL PRIMARY KEY, title TEXT, content TEXT, type TEXT DEFAULT 'news');` },
    { name: 'test_config', create: `CREATE TABLE test_config (field_number INTEGER PRIMARY KEY, display_name TEXT NOT NULL, units TEXT, description TEXT);` },
    { name: 'test_results', create: `CREATE TABLE test_results (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        test_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        field_1 NUMERIC, field_2 NUMERIC, field_3 NUMERIC, field_4 NUMERIC, field_5 NUMERIC,
        field_6 NUMERIC, field_7 NUMERIC, field_8 NUMERIC, field_9 NUMERIC, field_10 NUMERIC,
        field_11 NUMERIC, field_12 NUMERIC, field_13 NUMERIC, field_14 NUMERIC, field_15 NUMERIC,
        field_16 NUMERIC, field_17 NUMERIC, field_18 NUMERIC, field_19 NUMERIC, field_20 NUMERIC,
        field_21 NUMERIC, field_22 NUMERIC, field_23 NUMERIC, field_24 NUMERIC, field_25 NUMERIC,
        field_26 NUMERIC, field_27 NUMERIC, field_28 NUMERIC, field_29 NUMERIC, field_30 NUMERIC
    );` },
    // 2.5 / 5.8 (D-5) — one row per device belonging to whoever is signed in.
    // Deliberately *not* caregiver-specific: D-5 puts push on the critical path
    // for every user, because 5.9's silent schedule-change push targets patients.
    { name: 'push_tokens', create: `CREATE TABLE push_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- An Expo push token. UNIQUE because the token *is* the device address:
        -- the same string arriving for a second user means the device changed
        -- hands, and the row must move rather than duplicate. Without this the
        -- old owner keeps receiving the new owner's notifications, which for
        -- this app means a stranger's medication schedule.
        token TEXT NOT NULL UNIQUE,
        platform TEXT
            CHECK (platform IS NULL OR platform IN ('ios', 'android', 'web')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- Refreshed on every registration. 5.8's receipts poll deletes dead
        -- tokens outright, so this is not how they are reaped — it is how a
        -- token that has simply gone quiet can be told apart from a live one.
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX push_tokens_user_idx ON push_tokens (user_id);` },
    // 5.9 — silent schedule-change pushes, queued rather than sent. A
    // VPC-attached Lambda here reaches nothing outbound (no NAT, no endpoints,
    // verified), so this route cannot call Expo and cannot invoke the function
    // that can. It leaves the work in Postgres for the dispatcher to drain.
    { name: 'push_outbox', create: `CREATE TABLE push_outbox (
        id SERIAL PRIMARY KEY,
        -- Whose schedule changed. Recipients are resolved at drain time as this
        -- user's devices plus their active caregivers', whose escalation copies
        -- (4.2 item 4) go stale on the same edit.
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason TEXT NOT NULL DEFAULT 'schedule-changed',
        -- No foreign key on purpose: deleting a reminder is one of the events
        -- that enqueues a row, so this is dangling by design.
        reminder_id INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- Set when handed to Expo, or when there was nobody to send to. Both
        -- are done; a user with no device is not a failure to retry forever.
        sent_at TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX push_outbox_pending_idx ON push_outbox (created_at) WHERE sent_at IS NULL;` },
    // 5.8's receipts poll needs ticket ids to outlive the run that created
    // them: Expo returns tickets synchronously and receipts only minutes later,
    // so no single invocation can poll its own.
    { name: 'push_tickets', create: `CREATE TABLE push_tickets (
        id SERIAL PRIMARY KEY,
        ticket_id TEXT NOT NULL UNIQUE,
        -- Kept rather than referenced: the point of the receipt is to delete
        -- the push_tokens row, and a cascade would remove the ticket exactly
        -- when it is needed.
        token TEXT NOT NULL,
        -- 'dose-escalation' for 5.4 or 'schedule-changed' for 5.9. The two fail
        -- with very different consequences and the logs must separate them.
        -- NB: never write a close-paren followed by a semicolon inside these
        -- comments. The SCHEMA_SQL parity tests match a table block
        -- non-greedily up to the first one of those, so it truncates the block
        -- and reports every column below it as missing. Cost two attempts here,
        -- the second of them being this very comment.
        kind TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checked_at TIMESTAMPTZ,
        -- Free text rather than a CHECK: this mirrors a third party's
        -- vocabulary, and a constraint would turn Expo adding a status into a
        -- write failure on the one path whose job is observability.
        status TEXT,
        detail TEXT
    );

    CREATE INDEX push_tickets_unchecked_idx ON push_tickets (created_at) WHERE checked_at IS NULL;` },
];

// --- 5.1 policy constants ---------------------------------------------------

/**
 * How far ahead expected doses are materialised.
 *
 * Matched to 5.6's look-ahead so the device's pending alarms and the server's
 * dose rows describe the same window. Cheap to widen: the volume is roughly
 * 3,000 rows per user per year for three medications taken three times daily.
 */
export const DOSE_HORIZON_DAYS = 7;

/**
 * **D-12** — escalate regardless once a dose has been snoozed this many times.
 *
 * Owner's decision, 2026-07-31, closing §10 item 1. D-6 makes a snooze re-anchor
 * the escalation clock, which is right — the patient is demonstrably awake — but
 * it means unlimited snoozing defers escalation forever, and a patient who
 * snoozes an insulin dose four times is precisely who the caregiver escalation
 * exists for. Above this count, 5.4 ignores `snoozed_until` and anchors on
 * `scheduled_for`.
 *
 * Global rather than per-medication, unlike the delay (D-3): this is a
 * circuit-breaker on a mechanism, not a clinical judgement about a drug.
 */
export const SNOOZE_ESCALATION_THRESHOLD = 3;

/**
 * The timezone the server resolves a reminder's wall-clock alarm times in.
 *
 * `medication_reminders.alarms` holds "HH:mm" with no zone — they are wall-clock
 * times on the patient's phone — so turning one into the `timestamptz` that
 * `medication_doses.scheduled_for` needs requires knowing where the patient is.
 *
 * **This should be a `users.timezone` column and is not one, for a specific
 * reason.** `users` is preserved across `/reset-db` (D-11), so unlike every other
 * table it cannot pick up a new column from a rebuild — it needs a real
 * `ALTER TABLE` against the live database, and the VPC-attached migration runner
 * that would allow (§0.7) has never been built. A constant unblocks 5.1 today
 * without pretending the infrastructure exists. Correct for now: the app is
 * Taiwan-facing, zh-Hant, on Taipei infrastructure. Wrong the moment one patient
 * travels or the product ships elsewhere — see §0.6.
 */
export const APP_TIMEZONE = 'Asia/Taipei';

/**
 * Tables a reset must never drop.
 *
 * `users` is the obvious one: accounts are Cognito-backed and profiles key on the
 * Cognito `sub`, so dropping a profile row strands a login that still works.
 *
 * `genders` and `conditions` are the non-obvious ones, and leaving them out would
 * be a quiet bug rather than a loud one. `users` has foreign keys to both, and
 * `DROP TABLE ... CASCADE` on a referenced table **drops the referencing
 * constraint instead of refusing** — recreating the table does not bring it back.
 * A single reset would leave `users.gender_id` unconstrained, and the second reset
 * would renumber the lookup rows underneath the values still stored in `users`.
 *
 * `user_relationships` was added on 2026-07-31, after a reset wiped the caregiver
 * graph and made every D-1 feature untestable. It is preserved for a different
 * reason from the other three: not to protect a foreign key, but because the rows
 * are expensive to recreate. Pairing runs through a verification code exchanged
 * between two signed-in accounts, so restoring one is a two-device round trip
 * rather than a re-insert. It is safe to keep for the same reason `genders` is —
 * it references `users(id)`, which also survives, so no row is left dangling.
 *
 * The consequence to keep in mind: **a reset no longer produces a clean
 * relationship graph.** `/debug/link` and `/debug/unlink` exist because of that.
 */
export const RESET_PRESERVED_TABLES = ['users', 'genders', 'conditions', 'user_relationships'];

/**
 * Tables that existed once, have no definition any more, and should be removed if
 * a database still carries them. Dropped, never recreated.
 */
const RETIRED_TABLES = ['medications', 'invitations'];

/** Drops in reverse dependency order, so no CASCADE is needed to succeed. */
function dropStatementsFor(tableNames) {
    return [...RETIRED_TABLES, ...[...tableNames].reverse()]
        .map((name) => `DROP TABLE IF EXISTS ${name} CASCADE;`)
        .join('\n    ');
}

function createStatementsFor(tableNames) {
    const wanted = new Set(tableNames);
    return TABLE_DEFINITIONS.filter((t) => wanted.has(t.name)).map((t) => t.create).join('\n\n    ');
}

const ALL_TABLES = TABLE_DEFINITIONS.map((t) => t.name);

/**
 * From-scratch definition, including `users`. For a genuinely empty database.
 * **Not** what `/reset-db` runs — see RESET_SQL.
 */
export const SCHEMA_SQL = `
    ${dropStatementsFor(ALL_TABLES)}

    ${createStatementsFor(ALL_TABLES)}
`;

/**
 * What a reset actually runs: rebuild everything except the preserved tables.
 *
 * This is the shape the project wants while it is internal-testing only —
 * application data is disposable, accounts are not.
 */
export const RESET_SQL = (() => {
    const rebuild = ALL_TABLES.filter((name) => !RESET_PRESERVED_TABLES.includes(name));
    return `
    ${dropStatementsFor(rebuild)}

    ${createStatementsFor(rebuild)}
`;
})();

/**
 * Test data. Idempotent for the preserved lookup tables, because a reset leaves
 * those populated and re-seeding them would otherwise fail on their UNIQUE(name).
 * The rest are always freshly created, so they need no conflict handling.
 */
export const SEED_SQL = `
    INSERT INTO genders (name) VALUES ('Male'), ('Female'), ('Non-binary'), ('Prefer not to say') ON CONFLICT (name) DO NOTHING;
    INSERT INTO conditions (name) VALUES ('Acute Mission Stress'), ('Telepathic Overload'), ('Thorn Toxicity'), ('General Wellness') ON CONFLICT (name) DO NOTHING;
    INSERT INTO appointment_statuses (id, label, color) VALUES (1, 'New', '#6366F1'), (2, 'Cancelled', '#EF4444'), (3, 'Missed', '#F59E0B'), (4, 'Completed', '#22C55E');
    INSERT INTO medication_library (name, default_dosage) VALUES ('Anti-Telepathy Serum', '200mg, 500mg'), ('High-Grade Peanut Extract', '30mg'), ('Starlight Stamina Mints', '5mg');
    INSERT INTO test_config (field_number, display_name, units) VALUES (1, 'Starlight Level', 'g/dL'), (2, 'Reflex Factor', 'ms'), (3, 'Telepathy Wave', 'Hz');
`;

/**
 * The route path this request should be matched against.
 *
 * **This used to be rebuilt from `pathParameters.proxy`, and that only works for
 * a proxy resource mounted at the root.** For `/{proxy+}`, `proxy` is the whole
 * path and `/${proxy}` happens to reconstruct it. For any *nested* proxy
 * resource it is only the part after the mount point — so `GET /debug/users`
 * arriving through a `/debug/{proxy+}` resource has `proxy = "users"` and was
 * rebuilt as `/users`. That silently routed the request to a completely
 * different handler: `/debug/users` fell through to the auth guard and returned
 * `Cognito: login required (/users)`, and `/debug/genders` was worse — it
 * matched the *public* `/genders` route and returned a 200 full of the wrong
 * data, which looks exactly like the debug dump working.
 *
 * `event.path` is the real, stage-stripped path on a REST API proxy
 * integration, so it is now the primary source. The `proxy` reconstruction stays
 * as a fallback for an event shape that carries no path at all.
 *
 * The stage guard is belt-and-braces: REST proxy integrations do not include the
 * stage in `event.path`, but an HTTP API's `rawPath` does whenever the stage is
 * not `$default`, and this handler reads both.
 */
export function resolveRoutePath(event) {
    let path = event.path ?? event.rawPath;

    if (!path) {
        return event.pathParameters?.proxy ? `/${event.pathParameters.proxy}` : '/';
    }

    const stage = event.requestContext?.stage;
    if (stage && stage !== '$default' && path.startsWith(`/${stage}/`)) {
        path = path.slice(stage.length + 1);
    }

    return path;
}

/**
 * 5.1 — materialise expected doses for a rolling window ahead.
 *
 * Scoped by reminder (`{ reminderId }`) after a write, or by user
 * (`{ userId }`) as a top-up. Idempotent through the unique constraint, so the
 * window can be re-covered as often as anything cares to call it.
 *
 * **Done in SQL rather than in JS on purpose.** The alternative is pulling every
 * reminder out, computing occurrences in JavaScript and inserting them back, and
 * that reintroduces exactly the class of bug §0.6 already records twice — date
 * arithmetic that disagrees with itself across two implementations. Postgres
 * also has real timezone rules, including DST, which `Date` arithmetic on
 * "HH:mm" strings does not.
 *
 * Three details that are load-bearing:
 *
 * - **Only future slots.** `scheduled_for > now()` keeps D-2 intact: a reminder
 *   created at 10:00 must not materialise this morning's 08:00 as a dose that
 *   was never scheduled and therefore reads as missed.
 * - **Malformed alarm times are skipped, not fatal.** A single bad string would
 *   otherwise fail the cast and take the whole user's materialisation with it —
 *   the same reasoning as `parseTimeToMinutes` returning null on the client.
 * - **The series is anchored on today**, which is exact for `frequency_days = 1`
 *   (the default, and almost all real rows) and only approximates the device's
 *   phase for longer intervals. See §0.6; the fix is an anchor date on the
 *   reminder, which is a schema change this could not make.
 */
async function materialiseDoses({ reminderId, userId }) {
    const scope = reminderId != null ? 'r.id = $1' : 'r.user_id = $1';
    // Migration 005 — the zone comes from the patient's own row now, not from a
    // module constant. `COALESCE` to APP_TIMEZONE anyway: the column is NOT NULL
    // so this cannot fire today, and it means a future nullable column, or a
    // reminder whose owner row has somehow gone missing, degrades to the old
    // behaviour rather than materialising every dose at UTC midnight.
    const q = `
        INSERT INTO medication_doses (reminder_id, user_id, scheduled_for)
        SELECT r.id, r.user_id, slot.at
        FROM medication_reminders r
        JOIN users u ON u.id = r.user_id
        CROSS JOIN LATERAL (SELECT COALESCE(u.timezone, $2) AS tz) AS z
        CROSS JOIN LATERAL unnest(r.alarms) AS a(alarm)
        CROSS JOIN LATERAL generate_series(0, $3::int, GREATEST(COALESCE(r.frequency_days, 1), 1)) AS off(n)
        CROSS JOIN LATERAL (
            SELECT (((now() AT TIME ZONE z.tz)::date + off.n) + a.alarm::time) AT TIME ZONE z.tz AS at
        ) AS slot
        WHERE ${scope}
          AND r.status = 'active'
          AND a.alarm ~ '^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$'
          AND slot.at > now()
        ON CONFLICT (reminder_id, scheduled_for) DO NOTHING`;

    const res = await pool.query(q, [reminderId ?? userId, APP_TIMEZONE, DOSE_HORIZON_DAYS]);
    return res.rowCount;
}

/**
 * Drop a reminder's *future, unconfirmed* doses.
 *
 * Every qualifier matters. Future, because a schedule change cannot un-happen
 * yesterday. Unconfirmed, because a confirmed dose is a record of something the
 * patient actually did and editing the reminder does not undo it — D-4's missed
 * list is only honest if the history under it is.
 *
 * Called before re-materialising on edit, and on its own when a reminder is
 * deactivated. A *deleted* reminder is handled by the FK cascade instead, which
 * does take its confirmed history with it — acceptable while D-11 holds, and
 * noted in §0.6 as the thing to revisit when it stops.
 */
/**
 * Materialise without letting a failure fail the user's write.
 *
 * The judgement here is worth stating, because both obvious options are wrong.
 * Letting it throw would return a 500 *after* the reminder row was already
 * inserted — the client reports "save failed" about a save that succeeded, which
 * is a worse lie than the one it was trying to avoid. Swallowing it silently is
 * the failure class this whole plan exists to remove: the missed list and the
 * escalation sweep would both be blind to that reminder, with nothing anywhere
 * saying so.
 *
 * So: the write stands, and the failure is loud in two places a person actually
 * looks — CloudWatch, and `/debug/medication_doses` being emptier than it should
 * be. The realistic cause is a deploy that landed before migration 003 (or a
 * `/reset-db`) created the table, which is the ordering trap §0.6 already records
 * once.
 */
async function safeMaterialiseDoses(scope) {
    try {
        return await materialiseDoses(scope);
    } catch (e) {
        console.error('dose materialisation failed for', JSON.stringify(scope), '— the reminder was saved but has no doses:', e);
        return null;
    }
}

/**
 * 5.9 — queue a silent schedule-change push for a reminder's owner.
 *
 * **Queued rather than sent, and that is forced by the network rather than
 * chosen.** §8 describes the write itself sending a data-only push. It cannot:
 * this Lambda is VPC-attached because RDS is private, and a VPC-attached
 * function in this account has no NAT and no interface endpoints, so it can
 * reach neither `exp.host` nor the Lambda API to ask the non-VPC dispatcher to
 * do it. Verified 2026-07-31 — both `describe-vpc-endpoints` and
 * `describe-nat-gateways` return empty. §0.6 recorded this for 5.4 and predicted
 * it would constrain 5.9; it does.
 *
 * What it costs is latency: the push goes out on the next dispatcher run rather
 * than on the write. What it buys is that a failed send is *retried* instead of
 * lost, and that several edits in quick succession coalesce into one push —
 * which matters because iOS rate-limits silent pushes.
 *
 * **Failure is swallowed on purpose, and unlike `safeMaterialiseDoses` this one
 * really is safe to swallow.** A missed silent push costs a device that finds
 * out about the change at its next launch instead of within the minute — which
 * is exactly the behaviour that shipped before 5.9, and which 4.1's launch
 * re-sync remains the backstop for. §8 is explicit that this is an optimisation
 * and never a guarantee, so failing the user's save over it would be trading a
 * real write for a best-effort one.
 */
async function enqueueSchedulePush({ userId, reminderId, reason = 'schedule-changed' }) {
    if (!Number.isInteger(Number(userId))) return null;
    try {
        const res = await pool.query(
            `INSERT INTO push_outbox (user_id, reason, reminder_id) VALUES ($1, $2, $3) RETURNING id`,
            [userId, reason, Number.isInteger(Number(reminderId)) ? Number(reminderId) : null]
        );
        return res.rows[0]?.id ?? null;
    } catch (e) {
        console.error('could not queue a schedule-change push for user', userId, 'reminder', reminderId, e);
        return null;
    }
}

async function clearFutureDoses(reminderId) {
    const res = await pool.query(
        `DELETE FROM medication_doses
         WHERE reminder_id = $1 AND confirmed_at IS NULL AND scheduled_for > now()`,
        [reminderId]
    );
    return res.rowCount;
}

// --- 6.1 the error contract -------------------------------------------------

/**
 * Every failure this API can report, as a stable code paired with the status it
 * is always sent with.
 *
 * **What this replaces.** The entire taxonomy used to be one line at the bottom
 * of the handler — `err.message === "Access Denied" ? 403 : 500` — so a route
 * that meant "you gave me the wrong verification code" returned a 500 carrying
 * the English string `Security Mismatch`. The app ships en and zh-Hant, and a
 * message with no code attached to it cannot be translated: there is nothing to
 * key a lookup off. That is what 6.2 consumes.
 *
 * **The status lives here rather than at the call site, and that is the point.**
 * Three of these codes are 404s where a 403 would read more naturally, and each
 * is a deliberate decision that a later mechanical "fix" would undo:
 *
 * - `RELATIONSHIP_NOT_FOUND` / `RELATIONSHIP_REQUEST_NOT_FOUND` — ids are
 *   sequential SERIALs, so answering 403 on someone else's row confirms that
 *   the row exists. §3.1 chose 404 for that reason and 3.2 followed it.
 * - `REMINDER_NOT_FOUND` — same reasoning, from 1.14.
 * - `PROFILE_NOT_FOUND` — a Cognito user with no RDS row is **authenticated**;
 *   the profile simply is not built yet. 401 would invite the client to sign
 *   them out, which is the opposite of the intended recovery. It is a separate
 *   code from `USER_NOT_FOUND` for exactly this reason: that one means *the
 *   person you asked about* does not exist, and the two want different copy and
 *   different client behaviour.
 *
 * Pairing each code with its status in one table is what stops a future edit
 * emitting `RELATIONSHIP_NOT_FOUND` with a 403 and quietly reversing the
 * decision. The `message` is the developer-facing default and is **not** what a
 * user reads — 6.2 renders `code` through the locale files.
 */
export const ERRORS = Object.freeze({
    // 400 — the caller sent something this API cannot act on. Field-level
    // detail rides in `problems`, never in prose the client would have to parse.
    VALIDATION_FAILED: { status: 400, message: 'Some fields need attention.' },
    DEBUG_TABLE_NOT_ALLOWED: { status: 400, message: 'That table is restricted or does not exist.' },

    // 401 — no verified Cognito subject on the request at all.
    AUTH_REQUIRED: { status: 401, message: 'Sign-in required.' },

    // 403 — authenticated, and still not allowed.
    ACCESS_DENIED: { status: 403, message: 'Access Denied' },
    // 403 rather than 404, and it does not contradict the rule above: the row
    // was already found *and* scoped to this caller as the dependent, so the
    // existence of their own pending request is not news to them. The only
    // thing being refused is a wrong code.
    VERIFICATION_CODE_MISMATCH: { status: 403, message: 'That verification code does not match.' },

    // 404
    PROFILE_NOT_FOUND: { status: 404, message: 'User not found' },
    USER_NOT_FOUND: { status: 404, message: 'User not found' },
    REMINDER_NOT_FOUND: { status: 404, message: 'Reminder not found' },
    APPOINTMENT_NOT_FOUND: { status: 404, message: 'Appointment not found' },
    TEST_RESULT_NOT_FOUND: { status: 404, message: 'Test result not found' },
    DOSE_NOT_FOUND: { status: 404, message: 'No matching dose to record.' },
    RELATIONSHIP_NOT_FOUND: { status: 404, message: 'Relationship not found' },
    RELATIONSHIP_REQUEST_NOT_FOUND: { status: 404, message: 'Relationship request not found' },
    RELATIONSHIP_TARGET_NOT_FOUND: { status: 404, message: 'No account matches that email or username.' },
    ROUTE_NOT_FOUND: { status: 404, message: 'Not found' },

    // 405
    METHOD_NOT_ALLOWED: { status: 405, message: 'That method is not supported on this route.' },

    // 409 — the request was well-formed and the world disagrees with it.
    RELATIONSHIP_ALREADY_ACTIVE: { status: 409, message: 'Access to this account has already been granted.' },
    DOSE_ALREADY_CONFIRMED: { status: 409, message: 'That dose has already been confirmed.' },

    // 500
    INTERNAL_ERROR: { status: 500, message: 'Internal error' },
});

/**
 * Codes for a single bad field, carried in `problems[].code`.
 *
 * Separate from `ERRORS` because they are not statuses — every one of them
 * arrives inside a `VALIDATION_FAILED` 400. Each is specific enough that the
 * translated sentence can state the bounds, which is why there is one per rule
 * rather than a generic `OUT_OF_RANGE` plus interpolated numbers: keeping the
 * limits in the locale string means the wire format carries no parameters the
 * two sides have to agree about.
 */
export const PROBLEM_CODES = Object.freeze({
    FIELD_REQUIRED: 'FIELD_REQUIRED',
    EMAIL_OR_PHONE_REQUIRED: 'EMAIL_OR_PHONE_REQUIRED',
    ESCALATION_DELAY_OUT_OF_RANGE: 'ESCALATION_DELAY_OUT_OF_RANGE',
    ALARM_REPEAT_COUNT_OUT_OF_RANGE: 'ALARM_REPEAT_COUNT_OUT_OF_RANGE',
    SNOOZE_MINUTES_OUT_OF_RANGE: 'SNOOZE_MINUTES_OUT_OF_RANGE',
    ESCALATION_ORDER_INVALID: 'ESCALATION_ORDER_INVALID',
    TIME_FORMAT_INVALID: 'TIME_FORMAT_INVALID',
});

/**
 * A failure raised from somewhere that cannot assign to the handler's locals —
 * `checkAccess`, or a lookup nested inside a branch.
 *
 * The alternative was to keep throwing bare `Error`s and to keep recognising
 * them by their message at the bottom, which is the thing 6.1 exists to remove:
 * `"Access Denied"` as a *string* is a taxonomy that any typo silently widens
 * to a 500.
 */
export class ApiError extends Error {
    constructor(code, detail = {}) {
        super(ERRORS[code]?.message ?? code);
        this.name = 'ApiError';
        this.code = code;
        this.detail = detail;
    }
}

/**
 * The response body for a failure: `{ error, code, problems? }`.
 *
 * Mirrors `dashboard/server/index.mjs`, which §1 names as the reference for
 * this — with one addition and one narrowing, both deliberate. The addition is
 * `code`, which the reference does not have at all (it returns `{ error }` and,
 * on one route, `{ error, problems }`); a shape with no code cannot be
 * translated, so converging on it exactly would have shipped 6.1 without the
 * thing 6.2 needs. The narrowing is that `problems` entries are objects rather
 * than the reference's English sentences, for the same reason.
 */
export function errorBody(code, { message, problems } = {}) {
    const spec = ERRORS[code] ?? ERRORS.INTERNAL_ERROR;
    const out = { error: message ?? spec.message, code };
    if (Array.isArray(problems) && problems.length > 0) out.problems = problems;
    return out;
}

export const handler = async (event) => {


    console.log("event.path: " + event.path);
    console.log("event.rawPath: " + event.rawPath);

    const path = resolveRoutePath(event);

    const method = event.requestContext?.http?.method || event.httpMethod;
    const payload = event.body ? JSON.parse(event.body) : null;
    const queryParams = event.queryStringParameters || {};

    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'OPTIONS, POST, GET, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    console.log("method+path: " + method + " " + path)

    if (method === 'OPTIONS') return { statusCode: 204, headers };

    let body;
    // Numeric, matching the admin Lambda. REST API Gateway tolerated the
    // string form, but nothing else in the stack does.
    let statusCode = 200;

    /**
     * Answer with a typed failure. One line per site, and the status comes from
     * `ERRORS` rather than from the call site so a code cannot drift away from
     * the status it was reasoned about with — see the 404-not-403 notes there.
     */
    const fail = (code, detail) => {
        statusCode = (ERRORS[code] ?? ERRORS.INTERNAL_ERROR).status;
        body = errorBody(code, detail);
    };

    try {
        // --- 1. AUTH EXTRACTION ---
        const claims = event.requestContext?.authorizer?.claims || event.requestContext?.authorizer?.jwt?.claims;
        const cognitoSub = claims?.sub;

        // Helper: Get internal ID
        const getUserId = async (sub) => {
            const res = await pool.query('SELECT id FROM users WHERE cognito_id = $1', [sub]);
            return res.rows[0]?.id;
        };

        // Helper: Permission Check
        const checkAccess = async (requesterId, targetUserId) => {
            if (requesterId === targetUserId) return true;
            const res = await pool.query('SELECT 1 FROM user_relationships WHERE caregiver_id = $1 AND dependent_id = $2 AND status = $3', [requesterId, targetUserId, 'active']);
            return res.rows.length > 0;
        };

        /** `checkAccess` or stop. Every scoped route opened with this pair. */
        const requireAccess = async (requesterId, targetUserId) => {
            if (!(await checkAccess(requesterId, targetUserId))) throw new ApiError('ACCESS_DENIED');
        };

        // --- 2. THE ROUTE CHAIN ---
        if (path === "/reset-db") {
            // RESET_SQL, not SCHEMA_SQL: this rebuilds every table *except*
            // `users`, `genders` and `conditions`, so accounts survive a reset.
            // The old behaviour dropped `users` too, which meant every tester had
            // to re-register against a Cognito account that still existed.
            //
            // Still unauthenticated, and that is still P0.1's problem rather than
            // fixed here — any registered user can call this. Acceptable only
            // because the environment is internal-testing-only; it must not
            // outlive that.
            await pool.query(RESET_SQL);
            body = { message: "Reset complete.", preserved: RESET_PRESERVED_TABLES };
        }
        else if (path === "/seed-data") {
            await pool.query(SEED_SQL);
            body = { message: "Seeded." };
        }

        // Caregiver links, for testing. Ahead of the table dump below because
        // `/debug/link` would otherwise be read as a table name and rejected.
        //
        // **Why this route has to exist at all.** `user_relationships` is now a
        // preserved table (D-11), so `/reset-db` no longer clears it — which is
        // the point, since re-pairing costs a verification-code round trip
        // between two accounts. But that also means a reset can no longer
        // *create* a clean state, so an unlink is as necessary as a link. Both
        // are here for that reason; shipping only the link would have replaced a
        // "relationships keep vanishing" problem with a "relationships can never
        // be cleared" one.
        //
        // Deliberately skips the verification-code exchange that
        // `/relationships/request` + `/relationships/respond` implement — that
        // flow needs two signed-in devices, which is exactly what makes testing
        // the caregiver features expensive. This is a test fixture, not a second
        // way to pair, and it carries the same P0.1 caveat as everything else
        // under `/debug/`.
        else if (path === "/debug/link" || path === "/debug/unlink") {
            const asId = (value) => {
                const n = Number(value);
                return Number.isInteger(n) && n > 0 ? n : null;
            };
            const caregiverId = asId(queryParams.caregiver ?? payload?.caregiver_id);
            const dependentId = asId(queryParams.dependent ?? payload?.dependent_id);

            if (path === "/debug/unlink" && (queryParams.all === '1' || payload?.all === true)) {
                const removed = await pool.query('DELETE FROM user_relationships RETURNING id');
                body = { message: `Removed ${removed.rowCount} relationship(s).` };
            }
            else if (!caregiverId || !dependentId) {
                // A developer-facing route, so the message stays specific
                // rather than being reduced to a code the client would translate
                // — nothing in the app ever calls this.
                fail('VALIDATION_FAILED', {
                    message: "Pass ?caregiver=<userId>&dependent=<userId>. Both must be positive integers. /debug/unlink also accepts ?all=1. User ids come from /debug/users — they are the RDS `id`, not the Cognito sub.",
                    problems: [
                        { field: 'caregiver', code: PROBLEM_CODES.FIELD_REQUIRED },
                        { field: 'dependent', code: PROBLEM_CODES.FIELD_REQUIRED },
                    ],
                });
            }
            else if (caregiverId === dependentId) {
                // checkAccess already returns true when requester === target, so
                // a self-link changes nothing and would only sit in the table
                // looking like a real relationship.
                fail('VALIDATION_FAILED', {
                    message: "A user cannot be their own caregiver.",
                    problems: [{ field: 'dependent', code: PROBLEM_CODES.FIELD_REQUIRED }],
                });
            }
            else if (path === "/debug/unlink") {
                const removed = await pool.query(
                    'DELETE FROM user_relationships WHERE caregiver_id = $1 AND dependent_id = $2 RETURNING id',
                    [caregiverId, dependentId]
                );
                if (removed.rowCount === 0) {
                    fail('RELATIONSHIP_NOT_FOUND', { message: "No such relationship." });
                } else {
                    body = { message: "Unlinked.", caregiver_id: caregiverId, dependent_id: dependentId };
                }
            }
            else {
                // Both ids are checked against `users` first. The FK would catch
                // a bad one anyway, but as a 500 carrying a Postgres constraint
                // message — and this route exists to make testing easier, so it
                // should say which id was wrong.
                const found = await pool.query('SELECT id FROM users WHERE id = ANY($1::int[])', [[caregiverId, dependentId]]);
                const ids = found.rows.map((r) => r.id);
                const missing = [caregiverId, dependentId].filter((id) => !ids.includes(id));

                if (missing.length > 0) {
                    fail('USER_NOT_FOUND', { message: `No user with id ${missing.join(' or ')}.` });
                } else {
                    // Idempotent, and it re-activates rather than failing: a
                    // pending row left over from a real pairing attempt is the
                    // most likely thing already sitting on this pair.
                    const linked = await pool.query(`
                        INSERT INTO user_relationships (caregiver_id, dependent_id, relationship_type, status, verification_code)
                        VALUES ($1, $2, $3, 'active', NULL)
                        ON CONFLICT (caregiver_id, dependent_id)
                        DO UPDATE SET status = 'active',
                                      relationship_type = EXCLUDED.relationship_type,
                                      verification_code = NULL,
                                      -- Cleared because the pair is live again.
                                      -- Migration 007's CHECK rejects a live row
                                      -- carrying a revocation, so re-linking a
                                      -- revoked pair would otherwise fail here —
                                      -- which is precisely what that constraint
                                      -- is for: it turns "forgot to clear it"
                                      -- into a loud error instead of an access
                                      -- history that contradicts itself.
                                      revoked_at = NULL,
                                      revoked_by = NULL
                        RETURNING *`,
                        [caregiverId, dependentId, queryParams.type || payload?.relationship_type || 'family']
                    );
                    body = { message: "Linked.", relationship: linked.rows[0] };
                }
            }
        }

        else if (path.startsWith("/debug/")) {
            // 2. Extract table name from path (e.g., "/debug/users" -> "users")
            const tableName = path.split("/")[2];

            // 3. Whitelist: Only allow these specific tables to be queried
            const allowedTables = [
                'users',
                'appointments',
                'medication_reminders',
                // 5.1 — materialisation failing is deliberately non-fatal to the
                // reminder write, so this is one of the two places it is visible
                // at all (the other is CloudWatch). Without it the "loud
                // failure" this table is supposed to provide is only half loud.
                'medication_doses',
                'medication_library',
                'test_results',
                'test_config',
                'user_relationships',
                'genders',
                'conditions',
                'appointment_statuses',
                // 5.8 / 5.9 — the push tables. Added session 7 on the owner's
                // instruction, after a session declined to add them and was told
                // that was overthinking. Same reasoning as `medication_doses`
                // above: both `enqueueSchedulePush` and the receipts poll fail
                // *non-fatally* by design, so without a way to look at these
                // tables the "loud failure" they are supposed to provide is only
                // half loud — CloudWatch and nothing else.
                //
                // These do expose Expo push tokens, which need no credential to
                // send to. That is a real consideration and it belongs to the
                // security refactor along with the rest of `/debug/*`, which is
                // unauthenticated in its entirety; it is not a reason to keep
                // one table out of a list while the other twelve are in.
                'push_tokens',
                'push_outbox',
                'push_tickets',
                // The migration ledger. `tish-migrate {"command":"status"}`
                // answers the same question and is authoritative, but this is
                // one HTTP call rather than a Lambda invoke.
                'schema_migrations'
            ];

            if (!allowedTables.includes(tableName)) {
                fail('DEBUG_TABLE_NOT_ALLOWED', { message: `Table '${tableName}' is restricted or does not exist.` });
            } else {
                // 4. Execution: Since the table name is verified against the whitelist, 
                // it is now safe to use string interpolation.
                const res = await pool.query(`SELECT * FROM ${tableName} LIMIT 100`);
                body = {
                    table: tableName,
                    count: res.rowCount,
                    rows: res.rows
                };
            }
        }

        else if (path === "/genders") { body = (await pool.query('SELECT * FROM genders ORDER BY id ASC')).rows; }
        else if (path === "/conditions") { body = (await pool.query('SELECT * FROM conditions ORDER BY id ASC')).rows; }
        else if (path === "/appointment-statuses") { body = (await pool.query('SELECT * FROM appointment_statuses ORDER BY id ASC')).rows; }
        else if (path === "/medication-library") {
            // Matched on path alone before, so a POST fell into the GET branch
            // and returned the unchanged list with 200 — the add-medicine
            // dialog reported success and saved nothing.
            if (method === 'GET') {
                body = (await pool.query('SELECT * FROM medication_library ORDER BY name ASC')).rows;
            } else if (method === 'POST') {
                const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
                const dosage = typeof payload?.default_dosage === 'string' ? payload.default_dosage.trim() : '';
                if (!name || !dosage) {
                    fail('VALIDATION_FAILED', {
                        message: "name and default_dosage are required.",
                        problems: [
                            ...(name ? [] : [{ field: 'name', code: PROBLEM_CODES.FIELD_REQUIRED }]),
                            ...(dosage ? [] : [{ field: 'default_dosage', code: PROBLEM_CODES.FIELD_REQUIRED }]),
                        ],
                    });
                } else {
                    const q = `INSERT INTO medication_library (name, default_dosage) VALUES ($1, $2) RETURNING *`;
                    statusCode = 201;
                    body = (await pool.query(q, [name, dosage])).rows[0];
                }
            } else {
                fail('METHOD_NOT_ALLOWED', { message: `Method ${method} not allowed on ${path}.` });
            }
        }
        else if (path === "/test-config") { body = (await pool.query('SELECT * FROM test_config ORDER BY field_number ASC')).rows; }

        else if (path === "/check-availability" && method === "GET") {
            const email = queryParams.email ? queryParams.email.toLowerCase().trim() : null;
            const phone = queryParams.phone_number ? queryParams.phone_number.trim() : null;
        
            if (!email && !phone) {
                fail('VALIDATION_FAILED', {
                    message: "Email or phone number must be provided.",
                    problems: [{ field: 'email', code: PROBLEM_CODES.EMAIL_OR_PHONE_REQUIRED }],
                });
            } else {
                // Query to check if either field is already taken
                const res = await pool.query(
                    'SELECT email, phone_number FROM users WHERE email = $1 OR phone_number = $2 LIMIT 1',
                    [email, phone]
                );
        
                if (res.rows.length > 0) {
                    const match = res.rows[0];
                    let field = "account details";
                    
                    // Determine specifically which field caused the conflict
                    if (match.email === email) {
                        field = "email address";
                    } else if (match.phone_number === phone) {
                        field = "phone number";
                    }
        
                    body = { exists: true, field: field };
                } else {
                    body = { exists: false };
                }
            }
        }
        
        else if (path === "/register-profile") {
            // This route sits above the auth guard because it runs during
            // signup, so it has to do its own check. Reading the claims
            // unguarded turned a tokenless call into a TypeError and a 500,
            // when the honest answer is 401.
            if (!cognitoSub) {
                fail('AUTH_REQUIRED', { message: `Cognito: login required (${path})` });
            } else {
                const { username, full_name, birth_date, gender_id, condition_id, phone_number, role } = payload ?? {};

                // Retrying a partial signup is the documented recovery path for
                // a Cognito account with no RDS row, so the upsert has to
                // actually refresh what the user corrected. Updating only
                // full_name silently kept the stale gender/condition/birth
                // date/phone and made the retry look like it had worked.
                const q = `
                INSERT INTO users (cognito_id, username, email, phone_number, role, full_name, birth_date, gender_id, condition_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (cognito_id) DO UPDATE SET
                    username = EXCLUDED.username,
                    email = EXCLUDED.email,
                    phone_number = EXCLUDED.phone_number,
                    role = EXCLUDED.role,
                    full_name = EXCLUDED.full_name,
                    birth_date = EXCLUDED.birth_date,
                    gender_id = EXCLUDED.gender_id,
                    condition_id = EXCLUDED.condition_id
                RETURNING *`;

                // Use the email directly from the verified token for extra security
                const email = claims?.email;

                body = (await pool.query(q, [
                    cognitoSub, username, email, phone_number, role, full_name, birth_date, gender_id, condition_id
                ])).rows[0];
            }
        }

        // --- PROTECTED DATA ---
        else if (!cognitoSub) {
            fail('AUTH_REQUIRED', { message: `Cognito: login required (${path})` });
        }

        else if (path === "/my-id") {
            // Returned a bare scalar, and `undefined` on a miss — which
            // serialises to an empty body with a 200, the same failure shape
            // as /me below.
            const id = await getUserId(cognitoSub);
            if (id === undefined) fail('PROFILE_NOT_FOUND');
            else body = { id };
        }

        else if (path === "/me") {
            const q = `SELECT u.*, g.name as gender_name, c.name as condition_name FROM users u
                       LEFT JOIN genders g ON u.gender_id = g.id LEFT JOIN conditions c ON u.condition_id = c.id WHERE u.cognito_id = $1`;
            const res = await pool.query(q, [cognitoSub]);
            // Two faults sat on these lines. `res.rows.count` is always
            // undefined (arrays have .length), so the not-found branch never
            // ran; and the missing braces made `statusCode = 200`
            // unconditional. A Cognito user with no RDS row got 200 with an
            // empty body, the client's res.json() threw, and AuthContext's
            // incomplete-profile recovery never fired because it tests
            // `!res.ok` — and the response *was* ok. Presented as an infinite
            // bounce to /login.
            //
            // 404 rather than 401: the caller is authenticated, the profile
            // just doesn't exist yet. 401 would invite a client to sign them
            // out, which is the opposite of the recovery we want.
            if (res.rows.length === 0) {
                fail('PROFILE_NOT_FOUND');
            } else {
                body = res.rows[0];
            }
        }
        else if (path === "/my-dependents") {
            const userId = await getUserId(cognitoSub);
            const q = `
                SELECT u.id, u.username, u.full_name, r.relationship_type 
                FROM user_relationships r
                JOIN users u ON r.dependent_id = u.id
                WHERE r.caregiver_id = $1 AND r.status = 'active'`;
            body = (await pool.query(q, [userId])).rows;
        }
        else if (path === "/relationships/request") {
            const userId = await getUserId(cognitoSub);
            const target = await pool.query('SELECT id FROM users WHERE email = $1 OR username = $1', [payload.dependent_email]);
            // Was a bare throw, so it left here as a **500** carrying the
            // string "Agent not found" — an internal codename for a condition
            // the user causes by mistyping an email. 404 is the honest status
            // and the code is what lets the client say so in either language.
            if (target.rows.length === 0) throw new ApiError('RELATIONSHIP_TARGET_NOT_FOUND');
            const code = "TISH-" + Math.floor(100 + Math.random() * 899);

            // **An upsert since 3.2, and that is a consequence of revocation
            // rather than a tidy-up.** The row now *survives* being revoked
            // (2.3), and `UNIQUE(caregiver_id, dependent_id)` means a bare
            // INSERT for a pair that has ever been linked fails on the duplicate
            // key — so without this, revoking access once would permanently bar
            // that caregiver from ever asking again. Revocation has to be
            // reversible by the dependent's own consent; a one-way door is a
            // different feature and not the one 3.2 describes.
            //
            // `revoked_at`/`revoked_by` are cleared here because the row is live
            // again, and the CHECK added by migration 007 enforces exactly that
            // — a live relationship carrying a `revoked_at` is rejected by the
            // database rather than sitting in the access history as a lie.
            //
            // **The DO UPDATE is guarded on the existing row not being active**,
            // so re-requesting access you already hold cannot silently downgrade
            // a live relationship back to pending and demand a fresh code from
            // the dependent. `rowCount` is then how that case is recognised.
            const requested = await pool.query(`
                INSERT INTO user_relationships (caregiver_id, dependent_id, relationship_type, status, verification_code)
                VALUES ($1, $2, $3, 'pending', $4)
                ON CONFLICT (caregiver_id, dependent_id) DO UPDATE
                    SET status = 'pending',
                        relationship_type = EXCLUDED.relationship_type,
                        verification_code = EXCLUDED.verification_code,
                        revoked_at = NULL,
                        revoked_by = NULL
                    WHERE user_relationships.status <> 'active'
                RETURNING id`,
                [userId, target.rows[0].id, payload.relationship_type, code]
            );

            if (requested.rowCount === 0) {
                // The conflict target matched and the guard refused it: this pair
                // is already active. Reported rather than swallowed, because
                // returning a handshake code the dependent will never be asked
                // for is the silent-failure shape Phase 1 exists to remove.
                fail('RELATIONSHIP_ALREADY_ACTIVE');
            } else {
                body = { handshakeCode: code };
            }
        }

        /**
         * 3.2 — who currently has access, in both directions.
         *
         * Both directions from one route because **either participant may
         * revoke**, and the two sides of that are asked by different screens:
         * the profile screen's "who can see my records" is the dependent's view,
         * and a caregiver stepping back from someone they no longer care for is
         * the same row seen from the other end. A second route would have
         * duplicated the join to say the same thing.
         *
         * `role` is the *other* party's relationship to the caller, so a client
         * never has to compare ids to work out which name it is showing.
         *
         * Pending rows are included. A caregiver whose request has not been
         * answered can withdraw it here, which is the gap §3.1 deliberately left
         * open when it made both branches of `/relationships/respond`
         * dependent-only.
         */
        else if (path === "/relationships/granted") {
            const userId = await getUserId(cognitoSub);
            const q = `
                SELECT r.id,
                       r.status,
                       r.relationship_type,
                       CASE WHEN r.caregiver_id = $1 THEN 'dependent' ELSE 'caregiver' END AS role,
                       other.id       AS other_user_id,
                       other.username AS other_username,
                       other.full_name AS other_full_name
                FROM user_relationships r
                JOIN users other
                  ON other.id = CASE WHEN r.caregiver_id = $1 THEN r.dependent_id ELSE r.caregiver_id END
                WHERE (r.caregiver_id = $1 OR r.dependent_id = $1)
                  AND r.status IN ('pending', 'active')
                ORDER BY r.id`;
            body = (await pool.query(q, [userId])).rows;
        }

        /**
         * 3.2 — withdraw access.
         *
         * **Either participant, which is wider than `/relationships/respond`'s
         * dependent-only rule and deliberately so.** Consent is the dependent's
         * to withdraw, and a caregiver who no longer wants the responsibility —
         * or who never should have asked — must be able to step back without
         * needing the other person to act.
         *
         * Ownership is in the WHERE clause rather than a SELECT-then-UPDATE, the
         * same shape 3.1 established: there is no window between checking and
         * writing, so two revokes racing cannot both pass the check.
         *
         * **Enforcement follows for free.** `checkAccess` already filters on
         * `status = 'active'`, so nothing downstream needs to learn about
         * revocation — every scoped route starts denying the moment this commits.
         * The same is true of 5.9's recipient query, which is why a revoked
         * caregiver stops receiving silent schedule pushes without any change
         * there.
         *
         * Not-yours is a 404 rather than a 403, for 3.1's reason: `id` is a
         * sequential SERIAL and a 403 would confirm that a given relationship
         * exists.
         */
        else if (path === "/relationships/revoke") {
            const userId = await getUserId(cognitoSub);
            const relationshipId = Number(payload?.relationship_id);

            if (!Number.isInteger(relationshipId)) {
                fail('VALIDATION_FAILED', {
                    message: "relationship_id is required.",
                    problems: [{ field: 'relationship_id', code: PROBLEM_CODES.FIELD_REQUIRED }],
                });
            } else {
                const revoked = await pool.query(`
                    UPDATE user_relationships
                       SET status = 'revoked', revoked_at = now(), revoked_by = $2
                     WHERE id = $1
                       AND (caregiver_id = $2 OR dependent_id = $2)
                       AND status <> 'revoked'
                    RETURNING caregiver_id, dependent_id`,
                    [relationshipId, userId]
                );

                if (revoked.rowCount === 0) {
                    // **Already-revoked is a 200, not a 404, and that distinction
                    // is worth the extra round trip.** Two devices, or one
                    // impatient double-tap, must not turn a completed revocation
                    // into an error the user reads as "it did not work" — the
                    // same non-idempotency that made 5.1's second confirm a 404
                    // (§0.6). The SELECT is scoped to the caller for the same
                    // reason the UPDATE is: it must not confirm the existence of
                    // a relationship the caller is not part of.
                    const existing = await pool.query(
                        `SELECT 1 FROM user_relationships
                          WHERE id = $1 AND (caregiver_id = $2 OR dependent_id = $2) AND status = 'revoked'`,
                        [relationshipId, userId]
                    );
                    if (existing.rowCount > 0) {
                        body = { message: "Access already revoked." };
                    } else {
                        fail('RELATIONSHIP_NOT_FOUND');
                    }
                } else {
                    const { caregiver_id: caregiverId } = revoked.rows[0];

                    // **The caregiver's phone is still holding this dependent's
                    // alarms, and nothing else in the system will take them
                    // away.** Under 4.2 item 2 a caregiver's device carries an
                    // escalation copy of every escalation-enabled reminder their
                    // dependent has, and since 5.6 it carries up to a week of
                    // them. They resolve their medication name and dosage from
                    // the device's own cache (4.3), so left alone they go on
                    // announcing a revoked patient's prescription on a phone
                    // that no longer has any right to it — for as long as the
                    // horizon reaches.
                    //
                    // The obvious enqueue does not work: the drain resolves
                    // recipients through `user_relationships ... status =
                    // 'active'`, so a row filed under the *dependent* correctly
                    // reaches everyone except the one device that needs it. So
                    // the row is filed under the **caregiver**, with its own
                    // reason, and the drain sends `access-revoked` to that
                    // user's own devices only.
                    //
                    // The push is the prompt half, never the reliable one — §8
                    // is explicit that this channel is an optimisation. The
                    // durable half is device-side: the launch reconcile now
                    // drops alarms belonging to anyone who is no longer a
                    // dependent, so an ignored or undelivered push costs
                    // latency rather than correctness.
                    await enqueueSchedulePush({ userId: caregiverId, reason: 'access-revoked' });
                    body = { message: "Access revoked." };
                }
            }
        }

        else if (path === "/relationships/pending") {
            const userId = await getUserId(cognitoSub);
            body = (await pool.query('SELECT r.id, u.full_name, u.username FROM user_relationships r JOIN users u ON r.caregiver_id = u.id WHERE r.dependent_id = $1 AND r.status = $2', [userId, 'pending'])).rows;
        }

        // 3.1 — the responder must *be* the dependent, on both branches.
        //
        // Two separate holes before this. The approve branch verified the
        // handshake code but never checked who was answering — and the caregiver
        // is shown that code when they request access (`managed-users.tsx`
        // displays it), while `id` is a sequential SERIAL, so a caregiver could
        // approve their own request. The deny branch was a bare DELETE by id with
        // no ownership check at all, so any authenticated user could delete any
        // relationship by guessing an id.
        //
        // Ownership goes into the WHERE clause rather than a separate SELECT-then-
        // act, so there is no window between checking and writing.
        //
        // Not-yours is reported as 404 rather than 403 deliberately: `id` is
        // guessable, and 403 would confirm that a given relationship exists.
        // Consistent with the PUT 404s from 1.14.
        //
        // Dependent-only on both branches, per the plan. A caregiver withdrawing
        // their own request is a real gap, but it belongs to 3.2's revocation
        // route rather than being smuggled into the deny branch here.
        else if (path === "/relationships/respond") {
            const { request_id, action, provided_code } = payload;
            const userId = await getUserId(cognitoSub);

            // **Both branches are scoped to `status = 'pending'` since 3.2, and
            // that is a second access-control fix rather than tidiness.** Before
            // revocation existed, a row was only ever pending or active and
            // approving an active one was merely redundant. Now a revoked row
            // survives in the table, and without this filter the *old handshake
            // code still works on it* — so a relationship the dependent had
            // deliberately ended could be brought back by replaying a code from
            // before it ended. Re-granting access has to go through
            // `/relationships/request` again, which mints a fresh code.
            //
            // The deny branch is scoped for a different reason: it DELETEs, and
            // a revoked row is the access history 2.3 exists to keep. Declining
            // a request that was never granted destroys nothing; deleting a
            // revoked one destroys the record that access was ever held.
            if (action === 'active') {
                const check = await pool.query("SELECT verification_code FROM user_relationships WHERE id = $1 AND dependent_id = $2 AND status = 'pending'", [request_id, userId]);
                if (check.rows.length === 0) { fail('RELATIONSHIP_REQUEST_NOT_FOUND'); }
                // Was a 500 carrying "Security Mismatch". 403 rather than the
                // 404 above, and the two sit one line apart on purpose: by this
                // point the row has been found *and* scoped to this caller as
                // the dependent, so admitting it exists tells them nothing they
                // did not already know. The 404 above is the disclosure-shaped
                // case; this one is not.
                else if (check.rows[0].verification_code !== provided_code) throw new ApiError('VERIFICATION_CODE_MISMATCH');
                else {
                    await pool.query("UPDATE user_relationships SET status = $1 WHERE id = $2 AND dependent_id = $3 AND status = 'pending'", ['active', request_id, userId]);
                    body = { message: "Granted" };
                }
            } else {
                const denied = await pool.query("DELETE FROM user_relationships WHERE id = $1 AND dependent_id = $2 AND status = 'pending' RETURNING id", [request_id, userId]);
                if (denied.rows.length === 0) { fail('RELATIONSHIP_REQUEST_NOT_FOUND'); }
                else body = { message: "Denied" };
            }
        }

        // Meal time preferences (2.7). These are what make "before dinner"
        // resolvable into a clock time, so meal-relative reminders can be
        // scheduled at all. Scoped like every other route, so a caregiver can
        // set them for a dependent.
        else if (path === "/meal-times") {
            const userId = await getUserId(cognitoSub);
            const targetId = queryParams.user_id ? parseInt(queryParams.user_id) : userId;
            await requireAccess(userId, targetId);

            const MEAL_COLUMNS = ['breakfast_time', 'lunch_time', 'dinner_time', 'bedtime_time'];
            const SELECT_MEALS = `SELECT ${MEAL_COLUMNS.join(', ')} FROM users WHERE id = $1`;

            if (method === 'GET') {
                const res = await pool.query(SELECT_MEALS, [targetId]);
                if (res.rows.length === 0) { fail('USER_NOT_FOUND'); }
                else body = res.rows[0];
            } else if (method === 'PUT') {
                // Validate here rather than letting Postgres reject it: an
                // invalid TIME literal would surface as a 500 with raw driver
                // prose, which the app cannot translate or act on.
                const isValidTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v);
                const invalid = MEAL_COLUMNS.filter((c) => payload?.[c] !== undefined && payload[c] !== null && !isValidTime(payload[c]));

                if (invalid.length > 0) {
                    // One problem per bad column rather than one sentence
                    // listing them, so the form can mark the fields it owns.
                    fail('VALIDATION_FAILED', {
                        message: `Invalid time value for: ${invalid.join(', ')}. Expected HH:mm.`,
                        problems: invalid.map((field) => ({ field, code: PROBLEM_CODES.TIME_FORMAT_INVALID })),
                    });
                } else {
                    const q = `UPDATE users SET
                        breakfast_time = COALESCE($1, breakfast_time),
                        lunch_time     = COALESCE($2, lunch_time),
                        dinner_time    = COALESCE($3, dinner_time),
                        bedtime_time   = COALESCE($4, bedtime_time)
                        WHERE id = $5
                        RETURNING ${MEAL_COLUMNS.join(', ')}`;
                    const updated = (await pool.query(q, [
                        payload?.breakfast_time ?? null,
                        payload?.lunch_time ?? null,
                        payload?.dinner_time ?? null,
                        payload?.bedtime_time ?? null,
                        targetId,
                    ])).rows[0];
                    if (!updated) { fail('USER_NOT_FOUND'); }
                    else body = updated;
                }
            } else {
                fail('METHOD_NOT_ALLOWED', { message: `Method ${method} not allowed on ${path}.` });
            }
        }

        else if (path === "/appointments") {
            const userId = await getUserId(cognitoSub);
            const targetId = queryParams.user_id ? parseInt(queryParams.user_id) : userId;

            console.log("appointments: userId: " + userId + "/ TargetID: " + targetId);

            await requireAccess(userId, targetId);

            if (method === 'GET') {
                body = (await pool.query('SELECT a.*, s.label as status_label, s.color as status_color FROM appointments a JOIN appointment_statuses s ON a.status_id = s.id WHERE a.user_id = $1 ORDER BY a.appointment_date ASC', [targetId])).rows;
            } else if (method === 'POST') {
                const q = `INSERT INTO appointments (user_id, appointment_date, doctor_name, title, hospital, department, room_number, appointment_number, details, status_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`;
                body = (await pool.query(q, [targetId, payload.appointment_date, payload.doctor_name, payload.title, payload.hospital, payload.department, payload.room_number, payload.appointment_number, payload.details, payload.status_id])).rows[0];
            } else if (method === 'PUT') {
                const q = `UPDATE appointments SET status_id=COALESCE($1,status_id), doctor_name=COALESCE($2,doctor_name), appointment_date=COALESCE($3,appointment_date), title=COALESCE($4,title), hospital=COALESCE($5,hospital), department=COALESCE($6,department), room_number=COALESCE($7,room_number), appointment_number=COALESCE($8,appointment_number), details=COALESCE($9,details) WHERE id=$10 AND user_id=$11 RETURNING *`;
                const updated = (await pool.query(q, [payload.status_id, payload.doctor_name, payload.appointment_date, payload.title, payload.hospital, payload.department, payload.room_number, payload.appointment_number, payload.details, payload.id, targetId])).rows[0];
                if (!updated) { fail('APPOINTMENT_NOT_FOUND'); }
                else body = updated;
            }
        }

        else if (path === "/medication-reminders") {
            const userId = await getUserId(cognitoSub);
            const targetId = queryParams.user_id ? parseInt(queryParams.user_id) : userId;
            console.log("medication-reminders: userId: " + userId + "/ TargetID: " + targetId);
            await requireAccess(userId, targetId);

            if (method === 'GET') {
                body = (await pool.query('SELECT r.*, l.name as med_name FROM medication_reminders r JOIN medication_library l ON r.med_id = l.id WHERE r.user_id = $1 ORDER BY r.status ASC', [targetId])).rows;

                // 5.1 — top up the rolling window (D-2 safe: only future slots).
                //
                // A write side effect on a GET is not lovely, and it is here for
                // a reason: the horizon has to move forward with time, and the
                // only thing in this system that runs on a schedule today is
                // nothing at all. This route is called at app launch (4.1) and
                // on the medications screen, so the window is refreshed whenever
                // anyone actually looks — which is a weaker guarantee than a
                // cron but is *some* guarantee rather than none.
                //
                // **5.4 brings an EventBridge schedule; move this there and take
                // it off the read path.** Failing here is deliberately swallowed:
                // a materialisation problem must not stop a patient seeing their
                // medication list.
                await safeMaterialiseDoses({ userId: targetId });
            } else if (method === 'POST' || method === 'PUT') {
                // 4.6 / 2.4 / 2.6 — validate the escalation and burst settings
                // here, not only in the form. Migration 002 puts CHECK
                // constraints on all three, so an out-of-range value would
                // otherwise reach Postgres and come back as a constraint
                // violation — which the error contract turns into a 500 carrying
                // internal English prose (see Phase 6). A 400 naming the field is
                // the difference between a fixable error and a mystery.
                // 6.1 — each problem is now `{ field, code, message }` rather
                // than a sentence. The field is what a form marks, the code is
                // what 6.2 translates, and the message is the English default
                // for anything reading the response directly (a probe, a log,
                // the dashboard). The *rules* are untouched: these are 4.6's
                // bounds, live and verified since session 2.
                const escalationProblems = [];
                if (payload?.escalation_delay_minutes !== undefined && payload.escalation_delay_minutes !== null) {
                    const delay = Number(payload.escalation_delay_minutes);
                    if (!Number.isInteger(delay) || delay < 5 || delay > 240) {
                        escalationProblems.push({
                            field: 'escalation_delay_minutes',
                            code: PROBLEM_CODES.ESCALATION_DELAY_OUT_OF_RANGE,
                            message: "escalation_delay_minutes must be a whole number of minutes between 5 and 240.",
                        });
                    }
                }
                if (payload?.alarm_repeat_count !== undefined && payload.alarm_repeat_count !== null) {
                    const count = Number(payload.alarm_repeat_count);
                    if (!Number.isInteger(count) || count < 1 || count > 6) {
                        escalationProblems.push({
                            field: 'alarm_repeat_count',
                            code: PROBLEM_CODES.ALARM_REPEAT_COUNT_OUT_OF_RANGE,
                            message: "alarm_repeat_count must be a whole number between 1 and 6.",
                        });
                    }
                }
                // Migration 008. Same shape as the two above: the column has a
                // CHECK, so without this guard an out-of-range value reaches
                // Postgres and returns a 500 carrying internal prose.
                if (payload?.snooze_minutes !== undefined && payload.snooze_minutes !== null) {
                    const snooze = Number(payload.snooze_minutes);
                    if (!Number.isInteger(snooze) || snooze < 1 || snooze > 120) {
                        escalationProblems.push({
                            field: 'snooze_minutes',
                            code: PROBLEM_CODES.SNOOZE_MINUTES_OUT_OF_RANGE,
                            message: "snooze_minutes must be a whole number of minutes between 1 and 120.",
                        });
                    }
                }
                if (payload?.escalation_order !== undefined && payload.escalation_order !== null) {
                    // Both values are accepted even though 'sms_first' is not yet
                    // selectable in the UI (D-8 gates it on Track B). Rejecting it
                    // here would be a second, redundant gate, and 5.4's channel
                    // fallback already handles a configured channel that cannot
                    // send — falling through to the caregiver rather than
                    // silently doing nothing.
                    if (!['caregiver_first', 'sms_first'].includes(payload.escalation_order)) {
                        escalationProblems.push({
                            field: 'escalation_order',
                            code: PROBLEM_CODES.ESCALATION_ORDER_INVALID,
                            message: "escalation_order must be 'caregiver_first' or 'sms_first'.",
                        });
                    }
                }

                if (escalationProblems.length > 0) {
                    // 4.6's named-field 400s, which were already live and
                    // verified (§0.4) — they become the `problems` array rather
                    // than being rewritten. What changes is that they stop being
                    // joined into one English sentence the client cannot
                    // translate: each entry keeps its field and gains a code.
                    fail('VALIDATION_FAILED', {
                        message: escalationProblems.map((p) => p.message).join(' '),
                        problems: escalationProblems,
                    });
                } else if (method === 'PUT') {
                    const q = `UPDATE medication_reminders SET
                        status = COALESCE($1, status),
                        selected_dosage = COALESCE($2, selected_dosage),
                        at_breakfast = COALESCE($3, at_breakfast),
                        breakfast_timing = COALESCE($4, breakfast_timing),
                        at_lunch = COALESCE($5, at_lunch),
                        lunch_timing = COALESCE($6, lunch_timing),
                        at_dinner = COALESCE($7, at_dinner),
                        dinner_timing = COALESCE($8, dinner_timing),
                        at_bedtime = COALESCE($9, at_bedtime),
                        frequency_days = COALESCE($10, frequency_days),
                        alarms = COALESCE($11, alarms),
                        alarm_labels = COALESCE($12, alarm_labels),
                        reminder_sound = COALESCE($13, reminder_sound),
                        alarm_sources = COALESCE($14, alarm_sources),
                        escalation_enabled = COALESCE($15, escalation_enabled),
                        escalation_delay_minutes = COALESCE($16, escalation_delay_minutes),
                        escalation_order = COALESCE($17, escalation_order),
                        alarm_repeat_count = COALESCE($18, alarm_repeat_count),
                        snooze_minutes = COALESCE($19, snooze_minutes)
                        WHERE id = $20 AND user_id = $21 RETURNING *`;
                    // An id that matches nothing used to return an empty body
                    // with 200. The form's res.json() then threw, the throw was
                    // swallowed, and the app went on to schedule notifications
                    // from local state for a reminder the server never updated.
                    const updated = (await pool.query(q, [payload.status, payload.selected_dosage, payload.at_breakfast, payload.breakfast_timing, payload.at_lunch, payload.lunch_timing, payload.at_dinner, payload.dinner_timing, payload.at_bedtime, payload.frequency_days, payload.alarms, payload.alarm_labels, payload.reminder_sound, payload.alarm_sources, payload.escalation_enabled, payload.escalation_delay_minutes, payload.escalation_order, payload.alarm_repeat_count, payload.snooze_minutes, payload.id, targetId])).rows[0];
                    if (!updated) { fail('REMINDER_NOT_FOUND'); }
                    else {
                        // 5.1 — the schedule may have moved, so future
                        // unconfirmed doses are rebuilt from scratch rather than
                        // reconciled. Deactivating lands here too: the clear
                        // runs, and materialisation is a no-op because it only
                        // selects active reminders.
                        try {
                            await clearFutureDoses(updated.id);
                        } catch (e) {
                            console.error('could not clear future doses for reminder', updated.id, e);
                        }
                        await safeMaterialiseDoses({ reminderId: updated.id });
                        // 5.9 — an edit *and* a status toggle both land here, and
                        // both change what the device should be holding. The
                        // toggle is the one worth naming: deactivating a reminder
                        // leaves alarms scheduled on every device until something
                        // reconciles, and before this the only thing that did was
                        // the next app launch.
                        await enqueueSchedulePush({ userId: targetId, reminderId: updated.id });
                        body = updated;
                    }
                } else {
                    // The COALESCE wrappers on $16-$20 are load-bearing, not
                    // decoration. Migrations 002 and 008 make these columns NOT
                    // NULL DEFAULT ..., and a column *default* only applies when
                    // the column is omitted from the statement — sending an
                    // explicit NULL into a NOT NULL column is an error, not a
                    // fallback. Since this statement always lists all 20 columns,
                    // an omitted field arrives as NULL and has to be defaulted
                    // here.
                    //
                    // The values deliberately mirror the migrations' defaults:
                    // escalation off, 30 minutes, caregiver_first, 3 alerts,
                    // 10-minute snooze. Off is D-3's column default so shipping
                    // the feature doesn't retroactively enable it for existing
                    // rows; the *form* opts new reminders in, which is the
                    // opposite and is meant to be.
                    const q = `INSERT INTO medication_reminders (user_id, med_id, selected_dosage, at_breakfast, breakfast_timing, at_lunch, lunch_timing, at_dinner, dinner_timing, at_bedtime, frequency_days, alarms, alarm_labels, reminder_sound, alarm_sources, escalation_enabled, escalation_delay_minutes, escalation_order, alarm_repeat_count, snooze_minutes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,COALESCE($16,false),COALESCE($17,30),COALESCE($18,'caregiver_first'),COALESCE($19,3),COALESCE($20,10)) RETURNING *`;
                    body = (await pool.query(q, [targetId, payload.med_id, payload.selected_dosage, payload.at_breakfast, payload.breakfast_timing, payload.at_lunch, payload.lunch_timing, payload.at_dinner, payload.dinner_timing, payload.at_bedtime, payload.frequency_days, payload.alarms, payload.alarm_labels, payload.reminder_sound, payload.alarm_sources, payload.escalation_enabled, payload.escalation_delay_minutes, payload.escalation_order, payload.alarm_repeat_count, payload.snooze_minutes])).rows[0];

                    // 5.1 — a brand-new reminder has no doses yet, and the
                    // escalation job and the missed list are both blind to a
                    // dose that was never materialised.
                    if (body?.id) await safeMaterialiseDoses({ reminderId: body.id });
                    if (body?.id) await enqueueSchedulePush({ userId: targetId, reminderId: body.id });
                }
            } else if (method === 'DELETE') {
                const removed = await pool.query('DELETE FROM medication_reminders WHERE id = $1 AND user_id = $2', [payload.id, targetId]);
                // 5.9 — **only when a row actually went**, unlike the two paths
                // above. A DELETE that matched nothing is not a schedule change,
                // and this route answers 200 either way (it does not 404 on a
                // miss the way PUT does), so `rowCount` is the only thing that
                // separates them. Enqueuing regardless would wake every device
                // the owner has for a request that changed nothing.
                if (removed.rowCount > 0) {
                    await enqueueSchedulePush({ userId: targetId, reminderId: payload.id, reason: 'reminder-deleted' });
                }
                body = { message: "Deleted" };
            }
        }

        // 5.1 (confirmation) and the server half of 5.7 (the missed list).
        else if (path === "/medication-doses") {
            const userId = await getUserId(cognitoSub);
            const targetId = queryParams.user_id ? parseInt(queryParams.user_id) : userId;
            await requireAccess(userId, targetId);

            if (method === 'GET') {
                // Bounded by an explicit window rather than returning everything:
                // this table grows by roughly 3,000 rows per user per year.
                const from = queryParams.from || null;
                const to = queryParams.to || null;
                body = (await pool.query(`
                    SELECT d.*, l.name AS med_name, r.selected_dosage
                    FROM medication_doses d
                    JOIN medication_reminders r ON r.id = d.reminder_id
                    JOIN medication_library l ON l.id = r.med_id
                    WHERE d.user_id = $1
                      AND ($2::timestamptz IS NULL OR d.scheduled_for >= $2::timestamptz)
                      AND ($3::timestamptz IS NULL OR d.scheduled_for <= $3::timestamptz)
                    ORDER BY d.scheduled_for DESC
                    LIMIT 500`, [targetId, from, to])).rows;
            }
            else if (method === 'POST') {
                const action = payload?.action === 'snooze' ? 'snooze' : 'confirm';
                const reminderId = parseInt(payload?.reminder_id);

                if (!Number.isInteger(reminderId)) {
                    fail('VALIDATION_FAILED', {
                        message: "reminder_id is required.",
                        problems: [{ field: 'reminder_id', code: PROBLEM_CODES.FIELD_REQUIRED }],
                    });
                } else {
                    // **The client does not send a timestamp, and should not.**
                    // The overlay knows which reminder rang and roughly when;
                    // making it compute the exact `scheduled_for` would mean
                    // reproducing the server's timezone resolution on the device
                    // and getting a 404 whenever the two disagreed by a second.
                    // Resolving server-side to the nearest unconfirmed dose is
                    // both more robust and the behaviour a user expects from
                    // pressing the button on a ringing alarm.
                    //
                    // `scheduled_for` is still accepted, for a caller that knows
                    // exactly which dose it means — 5.7's list, eventually.
                    const explicit = payload?.scheduled_for || null;
                    const found = await pool.query(`
                        SELECT d.*, r.snooze_minutes FROM medication_doses d
                        JOIN medication_reminders r ON r.id = d.reminder_id
                        WHERE d.reminder_id = $1
                          AND r.user_id = $2
                          AND ($3::timestamptz IS NULL OR d.scheduled_for = $3::timestamptz)
                          AND ($3::timestamptz IS NOT NULL OR abs(extract(epoch FROM (d.scheduled_for - now()))) < 43200)
                        -- Unconfirmed first, then nearest. Both halves matter, and
                        -- filtering confirmed rows out instead — which is what
                        -- this did until live testing caught it — is wrong in a
                        -- way unit tests could not see: the second confirm of a
                        -- dose found nothing and returned 404, so the COALESCE
                        -- idempotency below was unreachable and a caregiver
                        -- confirming after the patient (D-1, the case it exists
                        -- for) got an error for a normal action. Ordering rather
                        -- than filtering keeps an unconfirmed dose winning
                        -- whenever there is one, and returns the already-confirmed
                        -- dose only when there is nothing else in the window.
                        ORDER BY (d.confirmed_at IS NOT NULL) ASC,
                                 abs(extract(epoch FROM (d.scheduled_for - now()))) ASC
                        LIMIT 1`, [reminderId, targetId, explicit]);

                    const dose = found.rows[0];
                    if (!dose) {
                        // Not an error the user can act on, and not a silent
                        // success either. A dose can legitimately be absent: the
                        // reminder was created before 5.1, or the alarm fired
                        // outside the materialised window.
                        fail('DOSE_NOT_FOUND');
                    } else if (action === 'confirm') {
                        // Idempotent by design, not by accident: under D-1 the
                        // patient and their caregiver may both confirm the same
                        // dose, and the second press must not overwrite who
                        // actually recorded it first.
                        const saved = await pool.query(`
                            UPDATE medication_doses
                            SET confirmed_at = COALESCE(confirmed_at, now()),
                                confirmed_by = COALESCE(confirmed_by, $2)
                            WHERE id = $1 RETURNING *`, [dose.id, userId]);
                        body = saved.rows[0];
                    } else {
                        // D-6 — a snooze re-anchors escalation rather than
                        // counting as silence, and D-12 caps how long that can
                        // go on. `snooze_count` is what 5.4 reads to decide.
                        //
                        // **The reminder's own `snooze_minutes` is the fallback,
                        // not 10** (migration 008).
                        //
                        // An explicit `minutes` still wins, and must: the device
                        // has already re-armed its local alarm on that value, and
                        // `snoozed_until` has to point at the moment the patient
                        // will actually be alerted again or 5.4 escalates against
                        // a clock the phone disagrees with. 4.4's offline queue
                        // persists the value with the action, so a replay carries
                        // it too.
                        //
                        // What the fallback is for is every caller that has no
                        // value to send — a direct API consumer, the dashboard,
                        // 5.7's missed list when it lands — plus any build from
                        // before the overlay knew about the column. A hardcoded 10
                        // served those by contradicting whatever the reminder was
                        // actually configured for. The literal 10 survives only for
                        // a database that has not run migration 008 yet.
                        const configured = parseInt(dose.snooze_minutes) || 10;
                        const minutes = Math.min(Math.max(parseInt(payload?.minutes) || configured, 1), 120);
                        const saved = await pool.query(`
                            UPDATE medication_doses
                            SET snoozed_until = now() + ($2 || ' minutes')::interval,
                                snooze_count = snooze_count + 1
                            WHERE id = $1 AND confirmed_at IS NULL RETURNING *`, [dose.id, minutes]);
                        if (!saved.rows[0]) {
                            fail('DOSE_ALREADY_CONFIRMED');
                        } else {
                            body = {
                                ...saved.rows[0],
                                // Surfaced so the client need not know the policy
                                // constant, and so the threshold being hit is
                                // visible in a response rather than only in 5.4.
                                escalates_regardless: saved.rows[0].snooze_count > SNOOZE_ESCALATION_THRESHOLD,
                            };
                        }
                    }
                }
            }
            else {
                fail('METHOD_NOT_ALLOWED', { message: `${method} not supported on /medication-doses.` });
            }
        }

        // 5.8 — where a device says "this is how to reach me" (D-5).
        //
        // **Scoped to the caller, with no `user_id` parameter and no
        // `checkAccess`, unlike every route above.** That is the one deliberate
        // asymmetry here and it is worth stating: a push token is a property of
        // the device in your hand, not of the person whose data you are looking
        // at. A caregiver viewing a dependent's medications is still registering
        // their *own* phone, so honouring `user_id` would file the caregiver's
        // device under the dependent and send the dependent's escalations to the
        // person they were meant to escalate *to*.
        else if (path === "/push-tokens") {
            const userId = await getUserId(cognitoSub);
            // Same shape §0.6 argues for on `/me`: authenticated but with no
            // profile row is a 404, not a 401. It also stops a NULL owner being
            // inserted — `checkAccess` would compare undefined to undefined and
            // pass, which is the hole the `medication_reminders.user_id` finding
            // describes.
            if (!userId) {
                fail('PROFILE_NOT_FOUND');
            }
            else if (method === 'POST') {
                const token = typeof payload?.token === 'string' ? payload.token.trim() : '';
                const platform = ['ios', 'android', 'web'].includes(payload?.platform) ? payload.platform : null;

                if (!token) {
                    fail('VALIDATION_FAILED', {
                        message: "token is required.",
                        problems: [{ field: 'token', code: PROBLEM_CODES.FIELD_REQUIRED }],
                    });
                } else {
                    // **Upsert on the token, and move it if the owner differs.**
                    // Called on every launch, so the common case is a row that
                    // already exists and only needs `last_seen_at` bumped. The
                    // `user_id` in the SET is what handles a device changing
                    // hands — a reinstall under another account, or a shared
                    // family tablet — and without it the previous owner would go
                    // on receiving the new owner's notifications.
                    const saved = await pool.query(`
                        INSERT INTO push_tokens (user_id, token, platform)
                        VALUES ($1, $2, $3)
                        ON CONFLICT (token) DO UPDATE
                            SET user_id = EXCLUDED.user_id,
                                platform = COALESCE(EXCLUDED.platform, push_tokens.platform),
                                last_seen_at = now()
                        RETURNING *`, [userId, token, platform]);
                    body = saved.rows[0];
                }
            }
            else if (method === 'DELETE') {
                // Sign-out, and eventually 5.8's receipts poll reaping a token
                // Expo has reported as `DeviceNotRegistered`.
                //
                // Scoped by `user_id` as well as by token so one account cannot
                // unregister another's device by guessing a token. Deleting
                // something already gone is a 200, not a 404: the caller wanted
                // it absent and it is absent.
                const token = typeof payload?.token === 'string' ? payload.token.trim() : '';
                if (!token) {
                    fail('VALIDATION_FAILED', {
                        message: "token is required.",
                        problems: [{ field: 'token', code: PROBLEM_CODES.FIELD_REQUIRED }],
                    });
                } else {
                    const removed = await pool.query(
                        'DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [token, userId]);
                    body = { message: "Deleted", removed: removed.rowCount };
                }
            }
            else {
                fail('METHOD_NOT_ALLOWED', { message: `${method} not supported on /push-tokens.` });
            }
        }

        else if (path === "/test-results") {
            const userId = await getUserId(cognitoSub);
            const targetId = queryParams.user_id ? parseInt(queryParams.user_id) : userId;
            await requireAccess(userId, targetId);

            if (method === 'GET') {
                body = (await pool.query('SELECT * FROM test_results WHERE user_id = $1 ORDER BY test_date DESC', [targetId])).rows;
            } else if (method === 'POST' || method === 'PUT') {
                const isPut = method === 'PUT';
                const cols = []; const vals = isPut ? [payload.id] : []; 
                const addCol = (n, v) => { cols.push(isPut ? `${n} = $${vals.length + 1}` : n); vals.push(v); };
                if (!isPut) addCol('user_id', targetId);
                if (payload.test_date) addCol('test_date', payload.test_date);
                for (let i = 1; i <= 30; i++) { if (payload[`field_${i}`] !== undefined) addCol(`field_${i}`, payload[`field_${i}`] === "" ? null : payload[`field_${i}`]); }
                const query = isPut ? `UPDATE test_results SET ${cols.join(', ')} WHERE id = $1 AND user_id = ${targetId} RETURNING *` : `INSERT INTO test_results (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`;
                const saved = (await pool.query(query, vals)).rows[0];
                if (isPut && !saved) { fail('TEST_RESULT_NOT_FOUND'); }
                else body = saved;
            } else if (method === 'DELETE') {
                await pool.query('DELETE FROM test_results WHERE id = $1 AND user_id = $2', [payload.id, targetId]);
                body = { message: "Deleted" };
            }
        }
        else if (path === "/announcements") body = (await pool.query('SELECT * FROM announcements ORDER BY id DESC')).rows;
        else if (path === "/admin/stats") {
            // node-postgres hands back bigint as a string, so these were
            // shipping as {"totalUsers":"42"} and `totalUsers + 1` was "421".
            // ::int is what dashboard/server/index.mjs already does.
            const u = await pool.query('SELECT COUNT(*)::int AS count FROM users');
            const a = await pool.query('SELECT COUNT(*)::int AS count FROM appointments');
            body = { totalUsers: u.rows[0].count, totalMissions: a.rows[0].count };
        }
        // `path` is now the real request path rather than a reconstruction, so
        // there is no second value left to disagree with it. The old message
        // reported both because they could differ — which is exactly the bug
        // `resolveRoutePath` fixes.
        else { fail('ROUTE_NOT_FOUND', { message: `Not found: ${path}` }); }

    } catch (err) {
        // **The whole taxonomy used to be the line below this one**, and an
        // `err.message` string was both the status and the user-facing text.
        // Anything that was not the literal "Access Denied" became a 500
        // carrying whatever prose had been thrown — including, on a bad write,
        // a raw Postgres constraint message.
        if (err instanceof ApiError) {
            // Expected, and logged at a lower level than a fault: these are
            // routine answers, but a 403 nobody can explain is worth being able
            // to find in CloudWatch. The code is the searchable part.
            console.warn('api error', err.code, method, path);
            fail(err.code, err.detail);
        } else {
            // Unexpected. The detail stays in CloudWatch and does not go into
            // the response, which is what `dashboard/server/index.mjs` already
            // does — a driver message is not something a client can act on, and
            // in this codebase it is the one path that reaches a user with text
            // nobody wrote.
            console.error(err);
            fail('INTERNAL_ERROR');
        }
    }

    return { statusCode, body: JSON.stringify(body), headers };
};