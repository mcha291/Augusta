-- Announcements become localised, publishable news articles.
--
-- The table shipped as `(id, title, content, type DEFAULT 'news')`: no
-- timestamps, no publish state, and one pair of text columns for an app that
-- has been bilingual since it had users. Three consequences, all of which the
-- dashboard's publishing UI would otherwise inherit:
--
--  - **Ordering was by `id`**, which is insertion order and not publication
--    order. Fine while rows only ever arrive newest-last, wrong the moment an
--    article is edited, re-published, or backdated.
--  - **Every row was live the instant it existed.** There was no way to prepare
--    an article, and no way to take one down without deleting it.
--  - **A zh-Hant reader could be shown English.** `users.locale` exists
--    (migration 005) but the client never syncs it, so the server cannot resolve
--    a language on the reader's behalf either.
--
-- **Per-locale columns rather than a `locale` column with one row per language.**
-- One article stays one row, so the editor shows both languages side by side and
-- an author can see at a glance that the Chinese half is missing. Two rows keyed
-- by a shared group id make the half-translated case invisible and the
-- publish-both case a two-step operation that can stop halfway.
--
-- **`published_at` is the entire publish state**, nullable, NULL meaning draft.
-- A boolean *and* a timestamp would be two columns that can disagree — exactly
-- what migration 007's revocation CHECK exists to prevent. One nullable
-- timestamp cannot disagree with itself.

ALTER TABLE announcements
    ADD COLUMN IF NOT EXISTS title_en        TEXT,
    ADD COLUMN IF NOT EXISTS title_zh_hant   TEXT,
    ADD COLUMN IF NOT EXISTS content_en      TEXT,
    ADD COLUMN IF NOT EXISTS content_zh_hant TEXT,
    ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS published_at    TIMESTAMPTZ;

-- Carry any existing rows across, then remove the columns they came from.
--
-- **Guarded on the legacy column still existing, and that guard is what makes
-- the whole migration replay-safe** — a second run finds nothing to copy and
-- nothing to drop, so it is a no-op rather than a wipe. Every other statement
-- here is already idempotent; this is the one that would not be on its own.
--
-- The text lands in `*_en` rather than `*_zh_hant` because the rows that exist
-- are written in English. A zh-Hant reader reaches it through the read path's
-- fallback, which is honest about what it is, instead of English being stored
-- under a column claiming it is Chinese.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'announcements'
          AND column_name = 'title'
    ) THEN
        UPDATE announcements
           SET title_en   = COALESCE(title_en, title),
               content_en = COALESCE(content_en, content);

        ALTER TABLE announcements DROP COLUMN IF EXISTS title;
        ALTER TABLE announcements DROP COLUMN IF EXISTS content;
    END IF;
END $$;

-- `type` drives a tag rendered straight onto the card (`item.type.toUpperCase()`
-- on the home screen), so an unrecognised value reaches a patient's screen
-- as-is. Normalise the rows first and constrain second — the order migration 007
-- used on `user_relationships.status`, and for the same reason: a closed
-- vocabulary is only closed if what is already in the table is inside it.
UPDATE announcements SET type = 'news'
 WHERE type IS NULL OR type NOT IN ('news', 'alert', 'event');

ALTER TABLE announcements ALTER COLUMN type SET DEFAULT 'news';
ALTER TABLE announcements ALTER COLUMN type SET NOT NULL;

-- Guarded because ADD CONSTRAINT has no IF NOT EXISTS in Postgres, and a re-run
-- must stay harmless. Same shape as migration 008's bounds check.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'announcements_type_check') THEN
        ALTER TABLE announcements
            ADD CONSTRAINT announcements_type_check
            CHECK (type IN ('news', 'alert', 'event'));
    END IF;
END $$;

-- The patient-facing read is always "published, newest first"; the editor's is
-- "everything, newest first". A partial index serves the first without carrying
-- drafts, the same shape as `medication_doses_pending_idx`.
CREATE INDEX IF NOT EXISTS announcements_published_idx
    ON announcements (published_at DESC)
    WHERE published_at IS NOT NULL;
