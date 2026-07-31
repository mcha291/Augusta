-- 2.7 — Meal time preferences, and 4.8 — derived-alarm provenance.
--
-- Meal-relative reminders ("with breakfast", "before dinner") were collected by
-- the form, stored, and displayed back to the patient, but never scheduled:
-- the scheduler reads only `alarms`. They were never built because "before
-- dinner" is not computable without knowing when this person eats, and the app
-- never asked.
--
-- These four columns are what make a meal selection resolvable into a clock
-- time. Treated as an estimate the user can adjust, not a fact.
--
-- Defaults are deliberate rather than NULL: an existing user who has never
-- opened the new profile screen still gets meal reminders that fire at sensible
-- times, instead of silently getting none — which is the exact failure this
-- change exists to remove.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS breakfast_time TIME NOT NULL DEFAULT '08:00',
    ADD COLUMN IF NOT EXISTS lunch_time     TIME NOT NULL DEFAULT '12:30',
    ADD COLUMN IF NOT EXISTS dinner_time    TIME NOT NULL DEFAULT '18:30',
    ADD COLUMN IF NOT EXISTS bedtime_time   TIME NOT NULL DEFAULT '22:00';

-- Provenance for each entry in `alarms`, positionally aligned with it.
--
--   'manual'            the user set this time by hand
--   'breakfast:before'  derived from a meal selection, and therefore safe to
--   'breakfast:after'   regenerate when the user changes their meal times
--   'lunch:before' | 'lunch:after'
--   'dinner:before' | 'dinner:after'
--   'bedtime:at'
--
-- Without this, re-resolving after a meal-time change would overwrite times the
-- user typed in by hand.
ALTER TABLE medication_reminders
    ADD COLUMN IF NOT EXISTS alarm_sources TEXT[];

-- Existing rows predate meal resolution, so every alarm they hold was set by
-- hand. Say so explicitly rather than leaving NULL to be guessed at later.
UPDATE medication_reminders
   SET alarm_sources = ARRAY(SELECT 'manual' FROM generate_series(1, COALESCE(array_length(alarms, 1), 0)))
 WHERE alarm_sources IS NULL;
