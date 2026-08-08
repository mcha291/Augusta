-- Per-reminder snooze length.
--
-- This joins `alarm_repeat_count` (migration 002, how many alerts a dose
-- schedules) and `escalation_delay_minutes` (also 002, how long the server waits
-- before escalating). Both of those were already per-reminder and configurable;
-- the snooze length was a hardcoded constant sitting next to them, in two places
-- that could drift — `SNOOZE_MINUTES` on the client and a literal `10` in the
-- dose-action route. This closes that inconsistency.
--
-- **The default reproduces the hardcoded value exactly**, so applying this
-- migration changes nothing for the rows already in the table. That is the same
-- discipline migration 005 used for `timezone`/`locale`: move the value from a
-- place that cannot vary per reminder to one that can, and change no behaviour
-- on the way. A reminder nobody has edited since must keep snoozing the way its
-- owner already expects.

ALTER TABLE medication_reminders
    -- 1-120 mirrors the clamp the dose-action route has always applied to the
    -- `minutes` field on a snooze POST (`min(max(n, 1), 120)`), and 10 is the
    -- fallback that route already used. So this column does not introduce a
    -- range; it gives a name and a per-reminder home to one that was already
    -- being enforced in two places and configurable in neither.
    ADD COLUMN IF NOT EXISTS snooze_minutes INTEGER NOT NULL DEFAULT 10;

-- Bounds live in the database as well as at the API, not instead of it — the
-- same reasoning migration 002 gives. The API returns a usable 400; this is the
-- backstop against any other route into the table.
--
-- Guarded because ADD CONSTRAINT has no IF NOT EXISTS in Postgres, and a re-run
-- of this migration must stay harmless.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_reminders_snooze_minutes_check') THEN
        ALTER TABLE medication_reminders
            ADD CONSTRAINT medication_reminders_snooze_minutes_check
            CHECK (snooze_minutes BETWEEN 1 AND 120);
    END IF;
END $$;
