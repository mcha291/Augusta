-- 2.4 — Escalation settings (D-3, D-8), and 2.6 — alarm burst count (D-9).
--
-- Both are per-medication settings on `medication_reminders`, both are read by
-- the same form (4.6 builds the escalation controls and 4.7's burst control on
-- one screen), so they land together.
--
-- Scope note: 2.4 also calls for `escalation_level` and `last_escalated_at` on
-- `medication_doses`. That table does not exist yet (2.2), and creating a table
-- in one migration only to add columns to it in another is worse than creating it
-- complete. Those two columns belong with 2.2 / 5.1 in a later migration.

-- D-3: a per-medication toggle and delay, not a global constant. A morning
-- vitamin and an insulin dose do not warrant the same urgency.
--
-- **The column default must be false.** A default of true would retroactively
-- switch escalation on for every reminder that already exists, and start paging
-- caregivers about historical doses the moment the feature ships. The *form*
-- default is the opposite — new reminders opt in (4.6) — because a safety net
-- nobody enables isn't one. Two different defaults, deliberately.
ALTER TABLE medication_reminders
    ADD COLUMN IF NOT EXISTS escalation_enabled       BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS escalation_delay_minutes INTEGER NOT NULL DEFAULT 30,
    -- D-8: which rung fires first. 'sms_first' must not be selectable in the UI
    -- until Track B lands and phone numbers are actually verified — texting
    -- medication reminders to an unverified number risks sending PHI to a
    -- stranger. Stored as data from day one so the ladder is configurable
    -- without a schema change, even though only one rung is reachable today.
    ADD COLUMN IF NOT EXISTS escalation_order         TEXT    NOT NULL DEFAULT 'caregiver_first',
    -- D-9 / 2.6: how many consecutive alerts one dose schedules. iOS only —
    -- Android is capped at one alarm per nine minutes per app while idle, so a
    -- burst there degrades to a single alert (D-10). Default 3, bounded 1-6.
    ADD COLUMN IF NOT EXISTS alarm_repeat_count       INTEGER NOT NULL DEFAULT 3;

-- Bounds live in the database as well as at the API, not instead of it. The API
-- is what returns a usable 400 (4.6); these are the backstop that keeps a bad
-- value from being persisted by any other route into the table.
--
-- Guarded because ADD CONSTRAINT has no IF NOT EXISTS in Postgres, and a re-run
-- of this migration must stay harmless.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_reminders_escalation_order_check') THEN
        ALTER TABLE medication_reminders
            ADD CONSTRAINT medication_reminders_escalation_order_check
            CHECK (escalation_order IN ('caregiver_first', 'sms_first'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_reminders_escalation_delay_check') THEN
        ALTER TABLE medication_reminders
            ADD CONSTRAINT medication_reminders_escalation_delay_check
            CHECK (escalation_delay_minutes BETWEEN 5 AND 240);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_reminders_alarm_repeat_check') THEN
        ALTER TABLE medication_reminders
            ADD CONSTRAINT medication_reminders_alarm_repeat_check
            CHECK (alarm_repeat_count BETWEEN 1 AND 6);
    END IF;
END $$;

-- Partial index for 5.4's escalation job: it only ever scans reminders with
-- escalation switched on, which is expected to be a small minority of rows.
CREATE INDEX IF NOT EXISTS medication_reminders_escalation_enabled_idx
    ON medication_reminders (id)
    WHERE escalation_enabled;
