# Handoff — paste the block below into a new session

Everything below the line is the prompt. `PLAN.md` §0 carries the detail; this
only has to get a cold session to the right starting point without re-deriving
what session 5 already established.

---

Read PLAN.md, starting with §0 (Progress). It is the ledger and the only part
that tracks what is actually done. §0.3 says what comes next; §0.6 is the list of
places the plan turned out to be wrong, and it is worth reading before trusting
anything below §2 — session 5 added twelve entries to it.

Read the guardrails in §1 before deciding anything is too risky to try. The first
one is new and it matters more than it looks.

**There is no decision waiting for you and no deploy owed.** Unlike the last two
handoffs, this one is a clean "start the next thing". All four Lambdas are
deployed and verified, the database is migrated, and every suite is green.

## Start here — 5.6's wiring half

This is the only deliberately incomplete thing in the tree, and it is a boundary
rather than a half-edit: no file is mid-change, 200/200 backend and 122/122
client tests pass, `tsc` is clean.

`utils/notification-budget.ts` is finished and tested (22 tests). It decides how
many days of alarms fit inside iOS's 64-pending cap and what to give up when they
don't — audibility before horizon, a floor of two days, then the burst, then
dropping dependents' escalation copies furthest-dose-first, reporting every
degradation. **Nothing calls it.** Until it is wired, the app still schedules one
occurrence per alarm time and 5.6 delivers nothing to a user.

§0.3 has the five concrete steps. The one that will cost you time if you meet it
by surprise is step 3: **a burst member's identifier is currently the same string
tomorrow as it is today.** That is load-bearing for the chain-forward, and it
means scheduling several days at once makes today's and tomorrow's alerts
overwrite each other silently. Identifier reuse has already produced two
unpredicted bugs in this codebase (§0.6); this would be the third.

Then 5.9 — silent push to repair the horizon, which reuses 5.4's sender directly
and is much cheaper than its estimate now — then 5.5.

## What changed in session 5, in one paragraph

`push_tokens` reached the live database via `/reset-db` (owner's call), which
unblocked **5.4 — server-side caregiver escalation**, built together with 5.8's
send half. Then the **VPC-attached migration runner**, deferred four times, and
migration `005` giving `users` a `timezone` and a `locale`. Then 5.6's policy
half. Sessions 1–5 were committed as one checkpoint.

## State you can rely on

- **Tests: 200/200 backend, 122/122 client.** `tsc` clean, eslint 0 errors (41
  pre-existing warnings, none new), translations 325 keys.
- **All four Lambdas carry `Luv6y6Wqg97oSqkEGsxJAO7WNaBkxVSHmI9/1QCKUYg=`**,
  matching the uploaded zip. A deploy is now one build and **four**
  `update-function-code` calls — see §1 for the build recipe, which has traps.
- **All five migrations applied**, none pending, none orphaned. Check with
  `tish-migrate {"command":"status"}` rather than believing this document.
- **Committed** on `reminder-delivery-phases-1-5` (`e7c3cf1`), *not* merged to
  `main`. Nothing has been pushed. `opus 5 vs 4.8.txt` is deliberately
  uncommitted — it is an unrelated scratch file.
- Live data: 2 users (both with `timezone: Asia/Taipei`, `locale: zh-Hant`), the
  caregiver link user 1 → user 2, reminder 1 (200mg, 08:00 + 20:00, daily,
  escalation-enabled) and its 15 doses.

## ⚠ Something now runs unattended

EventBridge `tish-escalation-schedule` invokes `tish-escalate-dispatch` every 5
minutes. It is the only thing in this project that acts without a person and
sends notifications to people. Bounded — two rungs per dose, a 24-hour lateness
floor, skips anyone with no registered device — but know it exists before
touching `medication_doses`, `push_tokens` or the reminder escalation columns.

```bash
aws events disable-rule --name tish-escalation-schedule --region ap-east-2
```

## Constraints

- **Do not commit or push unless asked.** Session 5 committed because it was
  asked to.
- **Act freely against the live stack** — `ALTER TABLE`, reset, deploy, migrate,
  create and delete fixtures. Anything other than signing up new users is
  negligible until the security refactor lands. This is the third time the owner
  has had to say it; §1's first guardrail has the reasoning and the two bugs that
  hiding behind local-only verification cost.
- **A schema change no longer needs a reset.** Add a numbered `.sql`, mirror it
  into `SCHEMA_SQL` (enforced by a test), invoke `tish-migrate`.
- **`aws login` expires often** — it lapsed mid-deploy in session 5. Check
  `aws sts get-caller-identity` before AWS work; if it has gone, ask and wait.
- Backend deploys are manual, and the zip build has three traps that have each
  cost a session: resolve the staging directory to its **long** path (`SEMAPH~1`
  mangles every entry), build the archive with forward-slash entry names (there
  is no `zip` binary and `Compress-Archive` writes backslashes), and include
  `migrations/*.sql` or the runner deploys with nothing to run.
- Tests: `cd tish-app/backend && npm test` (200) and `cd tish-app && npm test`
  (122). Extend coverage rather than renumbering assertions.
- Any new user-facing string needs a key in both locale files.
- `/debug/*` is unauthenticated by deliberate choice. Do not widen it without
  asking. Note it is *not* how you reach `/reset-db` — the gateway refuses that;
  use a direct `aws lambda invoke`.

## Not verified, and why

**No real device has ever received a push from this system**, because no real
push token exists — `getExpoPushTokenAsync` cannot run on web or a simulator, so
every token used in testing was synthetic and Expo answers those with
`DeviceNotRegistered`. That exercised the reaping path properly, but the last
hop, Expo to a physical phone, is unproven.

It joins everything else waiting on **one native rebuild**, which has not been
made since the `app.json` plugin changes and is the single highest-value
verification step available: the alarm burst (4.7b), the iOS interruption level
(5.3), all three sounds (4.7a), the Android channel (4.7e), exact alarms (5.2),
4.4's snooze alarm firing, 4.7c's tray dismissal, and 5.8's token registration.
**That rebuild is the owner's to trigger, not yours.**

Also unverified: 4.2's attribution line, the delayed caregiver escalation, and
5.7's missed-dose section, which all need a signed-in session on a device. Ask
for a screenshot rather than attempting to sign in.

## Open questions

§10 has none outstanding. Both of session 5's decisions were answered by the
owner at the time — how `push_tokens` reached the database (reset), and whether
to buy a NAT gateway for 5.4 (no; two Lambdas instead). If something needs
deciding, ask rather than assuming, and add it to §10.
