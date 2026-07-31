-- 5.9's outbox and 5.8's ticket store. Two tables, one migration, because both
-- exist for the same reason: **a VPC-attached Lambda in this account can reach
-- nothing outside the VPC**, so neither the API nor the database half can talk
-- to Expo, and both features need somewhere in Postgres to leave work for the
-- one function that can.
--
-- Verified rather than assumed, 2026-07-31: `describe-vpc-endpoints` and
-- `describe-nat-gateways` both return `[]` in `ap-east-2`. §0.6 recorded the
-- consequence for `exp.host`; it applies identically to the Lambda API, so
-- "the write route invokes the dispatcher" is not available either.


-- 5.9 — the silent schedule-change push, queued rather than sent.
--
-- **The queue is the feature's shape, not a workaround bolted onto it**, and it
-- is worth being clear that it costs latency: §8 says the push goes out on the
-- write, and instead it goes out on the next dispatcher run. What that buys, on
-- top of being the only option the network allows:
--
--   - **Durability.** A push that fails because Expo is unreachable is still
--     queued, and the next run retries it. A fire-and-forget invoke from the
--     write path would simply lose it, and lose it silently — which is the
--     failure mode this whole plan exists to remove.
--   - **Coalescing.** Editing four reminders in a minute is one push per user,
--     not four, because the drain groups by recipient. iOS rate-limits silent
--     pushes, so this is not merely tidy.
CREATE TABLE IF NOT EXISTS push_outbox (
    id SERIAL PRIMARY KEY,

    -- **Whose schedule changed**, not who to send to. The recipients are
    -- resolved at drain time as this user's devices *plus* their active
    -- caregivers' — a caregiver's phone holds escalation copies of this
    -- reminder (4.2 item 4) and they go stale on exactly the same edit.
    -- Recording the subject rather than the recipients is what lets a
    -- relationship created between the write and the drain still be honoured.
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    reason TEXT NOT NULL DEFAULT 'schedule-changed',

    -- **Deliberately no foreign key.** Deleting a reminder is one of the events
    -- that enqueues a row, so the reference is dangling by design and is kept
    -- for the log rather than for a join.
    reminder_id INTEGER,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Set when the push has been handed to Expo, or when there was nobody to
    -- send it to. Both are "done" — a user with no registered device is not a
    -- failure to retry forever.
    sent_at TIMESTAMPTZ,

    -- Incremented on every drain that fails to hand the row off. The drain
    -- abandons a row past a threshold so an unreachable Expo cannot build an
    -- unbounded backlog that every later run re-reads.
    attempts INTEGER NOT NULL DEFAULT 0
);

-- The drain reads only pending rows, oldest first. Partial, because the sent
-- rows are the ones that accumulate and none of them are ever selected.
CREATE INDEX IF NOT EXISTS push_outbox_pending_idx
    ON push_outbox (created_at) WHERE sent_at IS NULL;


-- 5.8's last missing piece: somewhere for Expo ticket ids to survive between
-- runs.
--
-- **Why this needs a table at all**, since it is the question the item was
-- deferred on. Expo answers a send synchronously with *tickets*, and the actual
-- delivery *receipt* is only available minutes later — so a single invocation
-- cannot poll its own. Ticket-level `DeviceNotRegistered` reaping already ships
-- and covers the common case (an uninstalled app is usually reported
-- immediately). What the receipts add is the delayed failures: a token Expo
-- accepts and only later finds undeliverable, which without this stays in
-- `push_tokens` until it happens to fail synchronously.
CREATE TABLE IF NOT EXISTS push_tickets (
    id SERIAL PRIMARY KEY,

    -- Expo's receipt id. UNIQUE so a retried record is idempotent rather than
    -- polling the same receipt twice.
    ticket_id TEXT NOT NULL UNIQUE,

    -- **Kept even though `push_tokens` has the same string**, because the point
    -- of the receipt is to delete that row. A foreign key would cascade the
    -- ticket away at exactly the moment it is needed, and scoping the reap to a
    -- token that no longer exists is a no-op rather than an error.
    token TEXT NOT NULL,

    -- 'dose-escalation' (5.4) or 'schedule-changed' (5.9). The two have very
    -- different consequences when they fail — a missed escalation is a safety
    -- matter, a missed silent push is a stale schedule the launch re-sync
    -- repairs — so the logs must be able to tell them apart.
    kind TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- NULL until a receipt has been read, or until the row is abandoned. Expo
    -- keeps receipts for about 24 hours, so a ticket older than that will never
    -- be answered and is closed out rather than polled forever.
    checked_at TIMESTAMPTZ,

    -- 'ok' | 'error' | 'expired'. Free text rather than a CHECK: this mirrors a
    -- third party's vocabulary, and a constraint here would turn Expo adding a
    -- status into a write failure on the one path whose whole job is
    -- observability.
    status TEXT,
    detail TEXT
);

CREATE INDEX IF NOT EXISTS push_tickets_unchecked_idx
    ON push_tickets (created_at) WHERE checked_at IS NULL;
