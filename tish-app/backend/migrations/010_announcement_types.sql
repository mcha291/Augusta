-- Article types become rows staff can edit, instead of a CHECK only a migration
-- can change.
--
-- Migration 009 closed the vocabulary to ('news', 'alert', 'event') because an
-- unrecognised value reaches a patient's screen verbatim. That was the right
-- shape for a fixed list and the wrong one the moment staff needed to add a
-- category: a CHECK is changed by a migration, a deploy and an engineer, which
-- is three people too many for renaming a tag.
--
-- **The labels have to be localised, and that is what makes this a table rather
-- than a longer CHECK.** While the vocabulary was fixed the app could render it
-- through `news.type.*` locale keys, translated in the same file as everything
-- else. A type staff invent at 4pm has no locale key and never will, so the
-- translations have to live beside the row — the same per-locale column pair
-- migration 009 gave the articles themselves.

CREATE TABLE IF NOT EXISTS announcement_types (
    id SERIAL PRIMARY KEY,
    label_en TEXT NOT NULL,
    label_zh_hant TEXT,
    -- Free text rather than a CHECK. It is a tag colour: a wrong one is ugly
    -- for a day, and the point of this table is that staff do not need us.
    color TEXT,
    -- Display order in the editor and in any future filter. Not the id, because
    -- inserting a category between two others must not mean renumbering.
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `label_en` is the natural key — there is no slug column, because a slug would
-- be a second name for the same thing and a staff rename would leave the two
-- disagreeing. Unique on `lower()` rather than the raw column: "News" and "news"
-- are the same category to everyone except a plain UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS announcement_types_label_en_key
    ON announcement_types (lower(label_en));

-- The three defaults, conflict-tolerant for the same reason the genders and
-- conditions seeds are: this table is preserved across a reset, so this
-- statement runs again against rows that already exist.
INSERT INTO announcement_types (label_en, label_zh_hant, color, sort_order) VALUES
    ('System Updates', '系統更新', '#6366F1', 1),
    ('News',           '最新消息', '#22C55E', 2),
    ('Announcements',  '公告',     '#F59E0B', 3)
ON CONFLICT (lower(label_en)) DO NOTHING;

ALTER TABLE announcements
    ADD COLUMN IF NOT EXISTS type_id INTEGER REFERENCES announcement_types(id);

-- Carry the old text across, then remove the column it came from.
--
-- **009's vocabulary is mapped rather than preserved, and that is safe only
-- because it was never in production.** 009 is unapplied and `announcements`
-- has never had seed data, so in practice there is nothing here to convert; the
-- mapping exists so the statement is correct if a row does turn up. 'news' has
-- an obvious home and everything else lands in Announcements, which is the
-- general-purpose one — better than inventing a category per legacy value and
-- leaving staff to tidy up names they never chose.
--
-- Guarded on the legacy column, which is what keeps a replay harmless.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'announcements'
          AND column_name = 'type'
    ) THEN
        UPDATE announcements a
           SET type_id = t.id
          FROM announcement_types t
         WHERE a.type_id IS NULL
           AND lower(t.label_en) = CASE lower(COALESCE(a.type, 'news'))
                                        WHEN 'news' THEN 'news'
                                        ELSE 'announcements'
                                   END;

        ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_type_check;
        ALTER TABLE announcements DROP COLUMN IF EXISTS type;
    END IF;
END $$;

-- Any row still unassigned — one inserted between the two statements above, or
-- a database that never had the legacy column — gets the general-purpose type
-- rather than being left dangling.
UPDATE announcements
   SET type_id = (SELECT id FROM announcement_types WHERE lower(label_en) = 'announcements')
 WHERE type_id IS NULL;

-- NOT NULL only after the backfill, or the ALTER fails on the rows it is meant
-- to protect. RESTRICT on the reference is deliberate and the editor depends on
-- it: deleting a type that articles still use must fail loudly rather than
-- cascade articles away or quietly blank their tag.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM announcements WHERE type_id IS NULL) THEN
        RAISE EXCEPTION 'announcements.type_id backfill left rows unassigned';
    END IF;
END $$;

ALTER TABLE announcements ALTER COLUMN type_id SET NOT NULL;

ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_type_id_fkey;
ALTER TABLE announcements
    ADD CONSTRAINT announcements_type_id_fkey
    FOREIGN KEY (type_id) REFERENCES announcement_types(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS announcements_type_id_idx ON announcements (type_id);
