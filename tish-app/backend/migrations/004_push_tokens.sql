-- 2.5 — `push_tokens` (D-5, groundwork for 5.8).
--
-- **One row per device belonging to whoever is signed in, with no caregiver
-- special-casing**, and that is the point rather than a simplification. The
-- obvious reading of "push tokens" in this plan is "somewhere to send caregiver
-- escalations", which would make this part of 5.4. D-5 puts push on the critical
-- path for *every* user: 5.9's silent schedule-change push targets patients, and
-- it is the only server-to-device channel in the system at all. So the record is
-- simply an address for a device, and both features read the same table.
--
-- A user may have several devices and all of them are sent to. That is a
-- deliberate consequence of D-1's redundancy argument, not an accident of the
-- schema.

CREATE TABLE IF NOT EXISTS push_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- **UNIQUE on the token alone, not on (user_id, token).** The token *is* the
    -- device address, so the same string arriving for a different user means the
    -- device changed hands — a reinstall under another account, or a shared
    -- family tablet. The row must move to the new owner rather than existing
    -- twice, because the alternative is the previous owner continuing to receive
    -- the new owner's notifications. In this app that is somebody else's
    -- medication schedule arriving on your phone, so it is a disclosure rather
    -- than a duplicate-row annoyance.
    token TEXT NOT NULL UNIQUE,

    -- Nullable: `Platform.OS` is always known on a real device, but a token that
    -- registers without one is still a usable address, and rejecting it would
    -- trade a working push channel for a tidy column.
    platform TEXT
        CHECK (platform IS NULL OR platform IN ('ios', 'android', 'web')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Refreshed every time the device registers, which is every launch.
    --
    -- **This is not how dead tokens are reaped.** Expo reports
    -- `DeviceNotRegistered` for a token that has died, and 5.8 deletes those on
    -- receipt — that is the mechanism, and it has to be, because a token can go
    -- dead the moment an app is uninstalled while `last_seen_at` says it was
    -- healthy an hour ago. What this column is for is telling a quiet device
    -- apart from a live one when deciding whether a user has any reachable
    -- device at all.
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every read is "all devices for this user", for both 5.4 and 5.9.
CREATE INDEX IF NOT EXISTS push_tokens_user_idx ON push_tokens (user_id);
