-- 2.2 — `medication_doses`, plus the half of 2.4 that was deferred to it.
--
-- **Why this table exists, stated precisely, because the obvious reading is
-- wrong.** It is not "a record of doses taken". Confirmations alone cannot
-- support either feature that needs this: the absence of a confirmation row is
-- indistinguishable from a dose that was never scheduled. So rows are
-- materialised **when a dose is scheduled**, with `confirmed_at` null, and
-- confirming fills that column in. That is what makes D-4's missed list and
-- 5.4's escalation query possible at all, and it is a shared prerequisite of
-- both rather than a feature of either.
--
-- 2.4 deliberately left `escalation_level` and `last_escalated_at` to this
-- migration rather than creating the table in one and altering it in another.

CREATE TABLE IF NOT EXISTS medication_doses (
    id SERIAL PRIMARY KEY,
    reminder_id INTEGER NOT NULL REFERENCES medication_reminders(id) ON DELETE CASCADE,
    -- Denormalised from the reminder so 5.7's per-user query and 5.4's job never
    -- need the join, and so a dose keeps its owner if the reminder's ownership
    -- were ever to change.
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- The *original* due time, never overwritten. A snooze moves
    -- `snoozed_until`, not this — otherwise the missed list would quietly
    -- rewrite history to say the dose was always due later than it was.
    scheduled_for TIMESTAMPTZ NOT NULL,

    confirmed_at TIMESTAMPTZ,
    -- Not necessarily `user_id`: under D-1 a caregiver may confirm a dependent's
    -- dose, and knowing which of them did it is the point of a separate column.
    confirmed_by INTEGER REFERENCES users(id),

    -- D-6: a snooze means the patient is awake and aware, so it re-anchors the
    -- escalation clock rather than being treated as silence. 5.4 anchors on
    -- COALESCE(snoozed_until, scheduled_for).
    snoozed_until TIMESTAMPTZ,
    -- The hole D-6 opens: each snooze pushes the anchor forward, so unlimited
    -- snoozing means escalation never fires — exactly the scenario the feature
    -- exists for. Resolved as D-12: escalate regardless above three.
    snooze_count INTEGER NOT NULL DEFAULT 0,

    -- 2.4's deferred half (D-8). A two-rung ladder, so the job needs to know
    -- which rungs have already fired rather than a single boolean. Incremented
    -- *before* dispatch so a retry or a concurrent run cannot double-send.
    escalation_level INTEGER NOT NULL DEFAULT 0,
    last_escalated_at TIMESTAMPTZ,

    -- Idempotency for materialisation and for confirmation alike. Under D-1 two
    -- devices may confirm the same dose, and the rolling materialisation window
    -- re-covers days it has already covered on every run; both become no-ops.
    UNIQUE (reminder_id, scheduled_for)
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_doses_snooze_count_check') THEN
        ALTER TABLE medication_doses
            ADD CONSTRAINT medication_doses_snooze_count_check
            CHECK (snooze_count >= 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_doses_escalation_level_check') THEN
        ALTER TABLE medication_doses
            ADD CONSTRAINT medication_doses_escalation_level_check
            CHECK (escalation_level BETWEEN 0 AND 2);
    END IF;
END $$;

-- 5.7's missed list: "unconfirmed doses for this user between two dates".
CREATE INDEX IF NOT EXISTS medication_doses_user_scheduled_idx
    ON medication_doses (user_id, scheduled_for DESC);

-- 5.4's escalation sweep. Partial, because the job only ever looks at doses that
-- are still unconfirmed — which is a small and self-limiting slice of the table,
-- while the table itself grows by roughly 3,000 rows per user per year.
CREATE INDEX IF NOT EXISTS medication_doses_pending_idx
    ON medication_doses (scheduled_for)
    WHERE confirmed_at IS NULL;

-- Materialisation upserts by (reminder_id, scheduled_for) and deletes future
-- unconfirmed rows for one reminder whenever its schedule changes; both hit this.
CREATE INDEX IF NOT EXISTS medication_doses_reminder_idx
    ON medication_doses (reminder_id, scheduled_for);
