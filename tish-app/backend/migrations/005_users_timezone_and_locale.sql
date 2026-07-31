-- §0.6 — `users.timezone` and `users.locale`, the two columns that could only
-- ever arrive this way.
--
-- **Why these two needed the migration runner and nothing else did.** Every
-- other schema change in this project reached the live database by `/reset-db`
-- rebuilding the table from `SCHEMA_SQL` (D-11). `users` is *preserved* across a
-- reset — accounts are Cognito-backed and dropping a profile row strands a
-- working login — so it is the one table that can never pick up a column from a
-- rebuild. That is why the runner existed as a deferred to-do for four sessions
-- and why these two columns were shipped as constants in the meantime:
-- `APP_TIMEZONE` in index.mjs and `DEFAULT_LOCALE` in escalate.mjs.
--
-- Both constants were correct for a Taiwan-facing zh-Hant app on Taipei
-- infrastructure, and both were wrong the moment one patient travels or the
-- product ships elsewhere. The defaults below deliberately reproduce them
-- exactly, so applying this migration changes no behaviour on the current two
-- rows — it only moves the value from a place that cannot vary per user to one
-- that can.

ALTER TABLE users
    -- IANA name, resolved by Postgres itself: `medication_reminders.alarms`
    -- holds "HH:mm" wall-clock with no zone, and materialising a dose into
    -- `medication_doses.scheduled_for` (a timestamptz) requires knowing where
    -- the patient is.
    --
    -- Not CHECK-constrained. The valid set is `pg_timezone_names`, which is a
    -- catalog lookup and therefore not immutable, so it cannot appear in a CHECK
    -- — and an enumerated list would be wrong within a year. An invalid value
    -- fails loudly at materialisation time (`AT TIME ZONE` raises), which is the
    -- right place for it: a bad timezone is a bad dose time, and a dose silently
    -- landing an hour out is far worse than a write that refuses.
    ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',

    -- Which language the *server* writes in. The client has its own i18n and
    -- does not read this; it exists because 5.4 sends push notification copy
    -- from a Lambda, where there is no i18n layer and no request to infer a
    -- language from.
    --
    -- CHECK-constrained, unlike timezone, because the valid set is exactly the
    -- locale files in the repo and a value outside it means the server silently
    -- falls back to the default — a wrong-language notification is the kind of
    -- bug nobody reports. Adding a third language means a migration, which is
    -- the correct amount of friction for a change that also needs a locale file.
    ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'zh-Hant';

-- Guarded because ADD CONSTRAINT has no IF NOT EXISTS in Postgres, and a re-run
-- must be a no-op — migrations 001-004 were replayed against an already-current
-- database when this runner was first used.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_locale_check'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_locale_check
            CHECK (locale IN ('en', 'zh-Hant'));
    END IF;
END $$;
