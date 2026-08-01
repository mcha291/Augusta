-- 2.3 — the revocation columns 3.2's route writes.
--
-- **`user_relationships` is one of D-11's four preserved tables, so this
-- migration is the only way these columns can ever arrive.** A reset rebuilds
-- every table from `SCHEMA_SQL` except `users`, `genders`, `conditions` and this
-- one — preserved because re-pairing costs a verification-code exchange between
-- two signed-in devices, which is the single most expensive fixture in the
-- project to recreate. That is exactly the situation `users.timezone` was in
-- (§0.6), where two sessions shipped a constant rather than a column because
-- nobody noticed the table could not pick one up from a rebuild.
--
-- **Why the row survives revocation instead of being deleted.** The deny branch
-- of `/relationships/respond` deletes, and that is right for a request that was
-- never granted — nothing happened, so there is nothing to remember. Revocation
-- is the opposite: access *was* held, and for how long and who ended it is the
-- only record that a caregiver could once read this patient's medication
-- history. Deleting the row destroys that, and `checkAccess` already filters on
-- `status = 'active'`, so keeping it costs nothing in enforcement.

ALTER TABLE user_relationships
    -- When access ended. NULL for every row that still stands.
    ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,

    -- Which of the two participants ended it. Either may revoke (3.2), so this
    -- is not derivable from the row — a dependent withdrawing consent and a
    -- caregiver stepping back are the same status and very different events.
    --
    -- ON DELETE SET NULL rather than CASCADE. In practice it never fires: this
    -- is always one of `caregiver_id` or `dependent_id`, and both of those
    -- cascade the whole row away first. It is declared for what it means rather
    -- than for what it does — losing the actor must never be a reason to lose
    -- the record of the act.
    ADD COLUMN IF NOT EXISTS revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL;


-- The status vocabulary, closed at last.
--
-- **This is the constraint that makes a revocation typo loud.** `status` has
-- been free text since the table was created, and the failure mode of a bare
-- TEXT column here is specific and bad: an UPDATE writing 'revoke' or 'REVOKED'
-- reports success, the client shows access withdrawn, and `checkAccess` — which
-- tests `status = 'active'` — goes on returning true. Consent would appear to
-- have been withdrawn while the caregiver kept reading the records. That is the
-- silent-failure shape Phase 1 spent eighteen items removing, in the one place
-- in this schema where it is an access-control failure rather than a lost alarm.
--
-- Safe to add against live data: the deployed table holds one row and its status
-- is 'active' (checked via /debug/user_relationships before writing this).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_relationships_status_check'
    ) THEN
        ALTER TABLE user_relationships
            ADD CONSTRAINT user_relationships_status_check
            CHECK (status IN ('pending', 'active', 'revoked'));
    END IF;
END $$;


-- `revoked_at` and `status` must agree, in both directions.
--
-- **The reverse direction is the one that earns this**, and it is not
-- decorative. A revoked row that is later re-activated — `/relationships/request`
-- re-requesting the same pair, or `/debug/link` re-linking it — must *clear* the
-- revocation, not leave it behind. Without this constraint the obvious
-- implementation of both (set status, say nothing about the other columns)
-- leaves a live relationship carrying a `revoked_at`, and the access history
-- this migration exists to keep would then read as "revoked" for a pair that
-- currently has access. Both write paths were changed to clear the columns; this
-- is what stops the third one from forgetting.
--
-- `revoked_by` is deliberately *not* coupled. It is legitimately NULL on a
-- revoked row whose actor has since been deleted (see the FK above).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_relationships_revoked_at_check'
    ) THEN
        ALTER TABLE user_relationships
            ADD CONSTRAINT user_relationships_revoked_at_check
            CHECK ((status = 'revoked') = (revoked_at IS NOT NULL));
    END IF;
END $$;
