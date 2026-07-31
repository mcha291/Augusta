# Tish — Remediation & Reminder Delivery Plan

**This document is written to be picked up cold by a session with no prior
context.** Everything needed to start should be here. Companion to
`MIGRATION.md`, which covers the Taipei/SMS/email infrastructure migration;
this document covers application defects, the consent model, and the reminder
delivery layer.

Drafted 2026-07-26. Implementation started 2026-07-30.

> **Start at §0.** It is the progress ledger and the only part of this document
> that tracks what is actually done. Sections §3–§9 describe the *original*
> defects and are deliberately left as first written — they are context, not
> status. Acting on one without checking §0 first means redoing finished work.

---

## 0. Progress ledger

**This section is the single source of truth for what is done.** The item
descriptions in §3–§9 were written before any work started and are *not* updated
as work lands — they describe the original defect, which stays useful as
context. Always check the ledger here before acting on anything below.

### 0.1 — Keeping this current

A session can be cut off mid-item, so treat this as a running log rather than an
end-of-session summary:

1. **Before starting an item**, set its ledger row to `WIP` and fill in §0.3.
2. **When it lands**, set the row to `done`, note the files, and clear §0.3.
3. **If the plan turns out to be wrong about something**, add it to §0.6 rather
   than silently working around it — three entries there were stale plan text
   that cost real time to re-derive.
4. **Append to §0.5** at the end of a session, or when interrupted.

Status vocabulary: `done` · `WIP` · `blocked` · `—` (not started) ·
`deferred` (deliberately out of scope, with a reason).

### 0.2 — Status ledger

Last updated **2026-07-31**, session 5.

| Item | Status | Where it landed |
|---|---|---|
| P0.1 — destructive routes above auth guard | `deferred` | Moved to the separate security plan by the owner. Do not action from this document. |
| P0.2 — iOS Critical Alerts entitlement | `deferred`, **blocks nothing** | Owner's call, 2026-07-31: do not block on Apple. 5.3 shipped the strongest level available without an entitlement request. If the entitlement is ever granted, the client change is one flag — `CRITICAL_ALERTS_ENTITLED` in `constants/config.ts` — plus the entitlement in `app.json` and a build. File it opportunistically or not at all. |
| P0.3 — Android exact-alarms spike | `done` | Decision written into §3 P0.3 (findings + decision) and §2 **D-10**. Unblocks 4.7b, 4.7c, 5.2; declines 4.7d; adds 4.7e. |
| 1.1 – 1.18 — all Phase 1 silent failures | `done` | `backend/index.mjs`, `index.test.mjs`, and 8 client screens. Tests 15 → 51. |
| Web date picker (from `MIGRATION.md` D6) | `done` | `components/platform-date-picker.tsx` — web branch, native `<input type="date\|time">`. |
| 2.1 — migration mechanism | `done`, **and finally usable against Taipei** | `backend/migrate.mjs`, `backend/migrations/`, `migrate.test.mjs`. **Session 5 added the VPC-attached runner** §0.7 item 1 described and four sessions deferred: `migrate.handler` deployed as `tish-migrate`. Not a route on the API — a separate function with no API Gateway integration, invoked by hand, no schedule. `status` / `up --dry-run` / `up`. |
| 2.8 — `users.timezone` + `users.locale` | `done` | Session 5, migration `005`, mirrored into `SCHEMA_SQL`. **The two columns that could only ever arrive by migration**, because `users` is preserved across a reset and so never picks up a column from a rebuild. Defaults reproduce the constants they replaced exactly (`Asia/Taipei`, `zh-Hant`), so applying it changed no behaviour. Both live rows carry them. Server now reads them: materialisation resolves alarms in `u.timezone`, 5.4 renders copy in `u.locale`. 10 tests. |
| 2.2 — `medication_doses` | `done` | Migration `003`, mirrored into `SCHEMA_SQL`, including 2.4's deferred `escalation_level` / `last_escalated_at`. Three indexes (5.4's partial pending index, 5.7's per-user, materialisation's per-reminder). Live — created by the reset, since the table is not preserved. |
| 2.3 — relationship revocation columns | `—` | Blocks 3.2. |
| 2.4 — escalation settings | `done` | **Row corrected in session 6: it said `WIP` and both halves had in fact landed**, so the ledger overstated what was left. `medication_reminders` half — migration `002`, mirrored into `SCHEMA_SQL`, with CHECK constraints and a partial index for 5.4. `medication_doses` half (`escalation_level`, `last_escalated_at`) — migration `003`, deferred into 2.2 so the table is created complete rather than in two migrations, and 2.2's own row has said so since session 3. Verified by grep against `migrations/002` and `003`. 4.6 is unblocked. |
| 2.5 — `push_tokens` | `done`, **live** | Session 4. Migration `004`, mirrored into `SCHEMA_SQL`, indexed on `user_id`. **UNIQUE on `token` alone, not `(user_id, token)`** — see §0.6; the natural-looking constraint is the wrong one. Not in D-11's preserved set: a token costs nothing to recreate. 3 tests. **Reached the live database in session 5** via `/reset-db` + `/seed-data` (owner's decision, §0.7 item 2 — now resolved). |
| 2.6 — alarm burst setting | `done` | `alarm_repeat_count`, migration `002` alongside 2.4 — same table, same form. CHECK 1–6. 4.7b's form control is unblocked. |
| 2.7 — meal time preferences | `done` | Migration `001`, mirrored into `SCHEMA_SQL`. Done as part of 4.8. |
| 3.1 — enforce responder identity | `done` | Owner's call, 2026-07-30: action it here as functional correctness. `backend/index.mjs` `/relationships/respond`, both branches scoped by `dependent_id`; 6 tests. Tests 51 → 57. |
| 3.2 — revocation | `—` | Needs 2.3. |
| 3.3 — revalidate persisted scope | `—` | |
| 3.4 — relationship type | `—` | |
| 3.5 — password reset flow | `done` | `app/forgot-password.tsx`, `login.tsx`, `_layout.tsx`, both locale files. |
| 3.6 — unhandled sign-in next-steps | `done` | `login.tsx` `handleNextStep`, covers all 13 Amplify steps. |
| 4.1 — re-sync at app launch | `done` | `hooks/use-notification-sync.ts`, called from `_layout.tsx`; `medications.tsx` reuses it. |
| 4.2 — multi-user alarm sets | `done` | Items 1, 3, 5 in session 2. Items 2 and 4 in session 3: `_layout.tsx` reconciles self + every active dependent; `scheduleMedicationNotifications` takes a `viewerUserId` and turns a non-owner's copy into a delayed, escalation-gated alarm. `computeNextTriggerDate` moved to `utils/date.ts` and gained an offset; 15 tests. **Item 4's carried gap closed in session 4**: `utils/doses.ts` `confirmedDoseKeys`, a `doses` field on `ScheduleOptions`, and a per-owner `GET /medication-doses` in `use-notification-sync.ts` — the caregiver's escalation copy is now skipped for a dose already confirmed. A snoozed dose deliberately stays escalatable (D-6/D-12); see §0.6. |
| 4.3 — slim the notification payload | `done` | `utils/reminder-store.ts` (new), `hooks/use-resolved-reminder.ts` (new), `notification-helper.tsx`, `alarm-overlay.tsx`, `_layout.tsx`, `use-notification-sync.ts`, both locale files. Payload is now `{reminderId, ownerUserId, timeStr, frequencyDays, soundKey}`. |
| 4.4 — make snooze snooze | `done` | Session 4, client-only as forecast. `utils/dose-queue.ts` + `utils/dose-queue-policy.ts` (new, 22 tests), `scheduleSnoozeAlert` and `snoozeIdentifierFor`, `alarm-overlay.tsx`, `use-notification-sync.ts` flushes the queue, `alarmOverlay.snooze` now interpolates its length (the label said 5m). **A replay names its dose explicitly** rather than re-POSTing blind — see §0.6, this is the part the item's "~2h" did not account for. Also fixed two live cancel-scope bugs found in the same code path (§0.6). |
| 4.5 — remove dead code | `done` | `startVibration` deleted from `alarm-overlay.tsx`. |
| 4.6 — escalation settings end to end | `done` | API: `/medication-reminders` POST + PUT carry all four columns, with 400-level validation ahead of migration 002's CHECKs. Form: burst count, escalation toggle, delay presets + custom, order control with `sms_first` disabled. 7 new tests (60 → 67) and 14 locale keys. **Form controls not visually verified** — the screen needs a session. |
| 4.7a — notification sound file | `done` | `assets/sounds/alarm_*.wav`, `app.json` plugin, `constants/sounds.ts`, `notification-helper.tsx`. **Unverified on device.** |
| 4.7b — schedule the burst | `done` | `notification-helper.tsx` `burstCountFor` + `scheduleOneAlert`; identifiers gain a burst index (`notification-identifiers.ts`). iOS only, and a caregiver's escalation copy is always one alert — see the note under 4.7. |
| 4.7c — cancel remainder on response | `done` | `cancelAlarmBurst` — both queues, scheduled *and* presented. Triggered from `_layout.tsx`'s listeners and from the overlay's confirm and snooze. **Ordering constraint against the chain-forward** — see §0.6. |
| 4.7d — Android full-screen intent | `deferred` | **Declined** by the P0.3 spike — not reachable without a bespoke native module or a single-maintainer notifee fork. See D-10 and P0.3 decision 3 for when to revisit. |
| 4.7e — Android channel audibility | `done` | `notification-helper.tsx` `setupNotificationChannels` — `usage: ALARM` + `enforceAudibility`, `lockscreenVisibility: PRIVATE`. Landed while the current channel ids were still unshipped, so no new ids were needed. **Unverified on device.** |
| 4.8 — meal-relative reminders | `done` | `utils/meal-alarms.ts`, migration `001`, `medication-reminder-form.tsx`, `profile.tsx`, `/meal-times` route. |
| 5.2 — Android exact alarms | `done` | `plugins/with-exact-alarms.js` (new) + `app.json`. Both permissions verified present in the introspected manifest, with `maxSdkVersion="32"` on the legacy one. Needs the native rebuild to take effect; needs a Play declaration before Android ships (§0.7). |
| 5.3 — iOS alert urgency | `done` for what is reachable | `interruptionLevel: 'timeSensitive'` on every alert, the self-service `time-sensitive` entitlement in `app.json` (confirmed in `expo config --type introspect`), and an explicit iOS authorization request. Breaks through Focus modes and the notification summary. **Ring-silent and Do Not Disturb still need Critical Alerts**, which is P0.2 and no longer blocks. |
| 5.1 — dose records | `done` | **Materialisation**: `materialiseDoses` in SQL, rolling 8-day window (today + `DOSE_HORIZON_DAYS`), on create, on edit (clear-then-rebuild), and as a top-up on `GET /medication-reminders`. **Confirmation**: `POST /medication-doses` (`confirm` \| `snooze`), wired to the overlay's confirm button. Verified against the live database. Unblocks 4.4, 5.4, 5.7. |
| 5.7 — missed dose list | `done` | Server half in session 3 (`GET /medication-doses?from=&to=`, scoped through `checkAccess`, bounded at 500). **Client half in session 4**: `utils/doses.ts` `missedDoses` (13 tests), a section on `medications.tsx` above the reminder list, 3 locale keys in both files. Shown only when non-empty; a dose still inside its snooze is not yet missed. The §0.6 phase caveat still applies — trustworthy for daily reminders only. |
| 5.8 — push token infrastructure | `done`, **complete including receipts** | **Session 7 added the receipts poll**, the last missing piece: migration `006`'s `push_tickets`, `record-tickets` / `due-receipts` / `receipts-checked` ops on the db half, and a `runReceipts` step on the dispatcher that reaps `DeviceNotRegistered` from a *delayed* failure rather than only a synchronous one. Gives up after 24h because Expo keeps receipts about that long. **Not exercised against a real receipt** — that needs an `ok` ticket, which needs a real device (§0.4). History: session 4 built registration: 2.5's table, `POST`/`DELETE /push-tokens` (upsert on token, owner reassignment, 12 tests), `utils/push-token.ts`, registration on sign-in from `_layout.tsx`, unregistration on sign-out from `AuthContext`. **Session 5 built the send half inside 5.4**, as §0.3 directed: the Expo call, chunking at 100, ticket classification and `DeviceNotRegistered` reaping all live in `escalate.mjs` as 5.4's dispatch step. The receipts poll was the one piece left, and session 7 closed it. |
| 5.4 — server-side caregiver escalation | `done` | Session 5. `escalation-policy.mjs` (pure, 33 tests) + `escalate.mjs` (two handlers, 28 tests). **Two Lambdas, not one** — `tish-escalate-dispatch` (no VPC, has internet, EventBridge target) drives `tish-escalate-db` (VPC-attached, has RDS); §8's single-Lambda shape is impossible in this VPC and §0.6 records why. EventBridge `tish-escalation-schedule`, **`rate(1 minute)` since session 7** — it was 5, and 5.9's drain rides on the same schedule. Claim increments `escalation_level` in the same statement it selects, under `FOR UPDATE ... SKIP LOCKED`. Adds a **lateness floor** the plan does not have (§0.6). |
| 5.6 — schedule N occurrences ahead | `done` | Policy half session 5 (`utils/notification-budget.ts`, 22 tests): audibility before horizon, floor of 2 days, then burst, then drop dependents' copies furthest-dose-first, every degradation reported. **Wiring session 6.** `utils/alarm-schedule.ts` (new, 25 tests) lays the horizon out; `notification-budget.ts` gained the cost model both halves read (`reminderHold`, `plannedBurstCount`, `reminderCostFor`, 16 tests) so the budget cannot cost a set the scheduler would not write. `notification-identifiers.ts` gained an **occurrence segment** — the trap §0.3 named, see §0.6. `use-notification-sync.ts` is now fetch-all → one budget → schedule-all. `rescheduleNextOccurrence` became a horizon top-up. Client tests 122 → 183. |
| 5.9 — silent push on schedule change | `done` | Session 7. **Not sent on the write, and that is forced rather than chosen**: `index.mjs` is VPC-attached and this account has no NAT and no interface endpoints, so it can reach neither Expo nor the Lambda API. Verified 2026-07-31 — `describe-vpc-endpoints` and `describe-nat-gateways` are both empty. So a reminder write enqueues into `push_outbox` (migration `006`) and the non-VPC dispatcher drains it. **EventBridge tightened to `rate(1 minute)`** so the queue costs ≤1 min rather than ≤5. Recipients are the owner's devices *and* their active caregivers' — one step wider than §8, see §0.6. Client handler in `_layout.tsx`; `UIBackgroundModes` added to `app.json`, so background delivery on iOS needs the owed native rebuild. 23 tests. |
| 5.5 — SMS escalation | `—`, **externally blocked** | **The last item in Phase 5.** Gated on Track B: SNS is still sandboxed in `ap-east-2` (B0 filed, B1 spend limit still $1, zero numbers registered). Until it lands every SMS rung substitutes to push, which is D-8's intended fallback but means the ladder is effectively one rung twice. |
| 6.1, 6.2 — error contract | `—` | Lowest urgency. |

### 0.3 — In progress right now

**Nothing is half-edited, there is no decision outstanding and no deploy owed.**
All four Lambdas are deployed and verified on
`duN/2QDdFDiNw9yjKKEXUhIhPBzJGKwjdhfczNbYAgA=`, all six migrations are applied,
and every suite is green.

**Phase 5 is finished except 5.5, which is blocked on AWS rather than on us.**
That is the headline: the delivery layer now has a device-side horizon (5.6), a
server-side escalation ladder (5.4), a server-to-device channel (5.9) and
delivery observability (5.8's receipts). The only thing missing is a second
*channel*, and SNS is still sandboxed.

**Sessions 6 and 7 are uncommitted**, in the working tree on `main`. Sessions 1–5
are committed — see §0.4, and note the branch name the session-5 handoff gave was
wrong (§0.6).

**Landed in session 7, 2026-07-31: 5.9 and 5.8's receipts poll**, migration `006`,
a deploy of all four Lambdas, and the EventBridge rate change below. Backend tests
200 → 227.

**Landed in session 6, 2026-07-31: 5.6's wiring half.** The horizon is real: a
device now holds up to seven days of alarms instead of one. Client tests 122 → 183.

> **⚠ Something in this project runs on its own, and it now runs every minute.**
> EventBridge `tish-escalation-schedule` invokes `tish-escalate-dispatch` at
> **`rate(1 minute)`** — session 7 tightened it from 5, because 5.9's silent-push
> drain rides on the same schedule and a five-minute queue undercuts the whole
> point of the feature. It is the only thing here that acts without a person
> triggering it *and* sends notifications to people.
>
> Still bounded: two rungs per dose, a 24-hour lateness floor, and it skips
> anyone with no registered device. **The rate change does not make escalation
> more aggressive** — the claim is gated on `scheduled_for + delay + grace`, so
> running more often only fires it closer to the intended moment. Know it is
> there before changing `medication_doses`, `push_tokens`, `push_outbox`,
> `push_tickets` or the reminder escalation columns. Kill switch:
> `aws events disable-rule --name tish-escalation-schedule --region ap-east-2`.

**The next item is 3.2's group — the Phase 3 consent batch.** See the session 8
directive at the end of this section; it is the last coherent block of feature
work that is not blocked on something external.

**What 5.6 did not and could not verify.** Every rule in it is unit-tested and
the mutation check in §0.5 confirms the tests are not vacuous, but **no alarm
written under the new identifier scheme has ever been handed to an OS.** The
whole horizon lives or dies on `scheduleNotificationAsync` accepting a
six-segment identifier and on iOS keeping what the budget projected, and neither
can be seen on web or in a simulator. It joins the native-rebuild list below, and
like the push it will be obvious the moment one exists: schedule a reminder,
background the app for two days without opening it, and the alarm either rings on
day two or it does not.

**What 5.9 did not and could not verify**, beyond the whole-server path which
*is* exercised live (§0.4). **No real device has ever received a silent push**,
for the same reason no real device has received any push: there is no real Expo
token, because `getExpoPushTokenAsync` cannot run on web or a simulator. And
because a synthetic token never produces an `ok` ticket, **the receipts poll has
never had a receipt to read** — its "nothing due" path is exercised on every run
and its "here is a receipt" path is only unit-tested.

**5.5 is worth more than its number suggests, for a reason session 5 made
concrete.** D-8's ladder is two rungs, and one of them cannot send: SMS has no
transport, so *every* SMS rung currently substitutes to a caregiver push. The
fallback is working exactly as D-8 specifies, but the practical effect is that
the ladder is one rung delivered twice. It gets a genuine second channel only
when 5.5 lands, and that is gated on Track B.

Smaller things that are cheap and worth doing when something else touches their
file:

> **A schema change is no longer a reason to defer anything.** Every item in this
> plan that was shaped around "we cannot alter a live table" — the timezone
> constant, the missing locale, `push_tickets`, and the `medication_reminders.user_id`
> NOT NULL fix in §0.6 — was working around a gap that closed in session 5. The
> anchor-date column that would fix the non-daily materialisation phase (§0.6) is
> the other obvious candidate. Add a numbered `.sql`, mirror it into `SCHEMA_SQL`,
> invoke `tish-migrate`.
- **The escalation copy on the device still does not follow a snooze.** Now that
  5.4 exists it is the authority, and the disagreement §0.6 describes is live:
  expect one duplicate escalation inside a snooze window. 5.4 honours D-6's
  re-anchor; the device does not.
- **`missedDoses` is capped at 20 with no "show more"** (`utils/doses.ts`).
  Carried from session 4. Fine for a week's window; revisit if it ever widens.

---

## ▶ DIRECTIVE FOR SESSION 8 — the Phase 3 consent batch

**Do these four, in this order, because 3.2 needs 2.3's columns and everything
else is independent.** They are one coherent block: one migration, one deploy,
one screen, one relationships area. Estimated ~6h in total, which is the one
thing here that may not fit — if it does not, **drop 3.4 first**; it is the least
load-bearing and the only one that is cosmetic rather than correctness.

1. **2.3 — revocation columns** *(~30m)*. `revoked_at`, `revoked_by` on
   `user_relationships`. Migration `007`, mirrored into `SCHEMA_SQL`, then
   `tish-migrate {"command":"up"}`. Keep the row rather than deleting it, so
   access history survives revocation. **Note `user_relationships` is one of the
   four preserved tables (D-11)** — a reset will not rebuild it, so the migration
   is the only way these columns can arrive. That is the same situation
   `users.timezone` was in, and §0.6 records what it cost to not notice.
2. **3.2 — revocation** *(~4h)*. `POST /relationships/revoke`, either participant
   may revoke, sets `status = 'revoked'` plus 2.3's columns. Enforcement then
   follows for free: `checkAccess` already filters on `status = 'active'`.
   Client half is a "who can see my records" list with a revoke action on
   `profile.tsx`, next to the existing pending-requests section. Locale keys in
   **both** files. Tests: a revoked relationship denies access on every scoped
   route.

   **Two things 5.9 just made true that §6's text predates.** Revocation now has
   a second consequence: a former caregiver's device is still holding escalation
   copies of that dependent's reminders (4.2 item 4), and nothing cancels them.
   Consider enqueuing a `push_outbox` row for the dependent on revoke — the drain
   resolves recipients through `user_relationships ... status = 'active'`, so the
   revoked caregiver correctly will *not* receive it, which means their stale
   alarms need a different answer. Worth deciding deliberately and recording;
   do not let it silently ship as "the alarms just stay there".
3. **3.3 — revalidate persisted scope** *(~30m)*. `activeDependent` is restored
   from AsyncStorage in `AuthContext` without checking the relationship still
   exists, so after a revocation a caregiver sits in a stale scope until some
   request 403s. Cross-check against `/my-dependents` inside `checkUser()` and
   clear if absent.
4. **3.4 — relationship type** *(~1h)*. `relationship_type` is hardcoded
   `'Family'` in `managed-users.tsx:38`. Offer a selection at request time. This
   does **not** change access scope — the model stays all-or-nothing, which is a
   known limitation rather than a defect.

**Before you start:** `aws sts get-caller-identity`, and ask Robin to re-login if
it has lapsed rather than working around it. **Before you believe anything in
this document about the database:** `tish-migrate {"command":"status"}`.

**End session 8 by writing the session 9 directive**, in this same place and this
same shape, replacing this block. Session 9 is **Phase 6 — the error contract**:
6.1 typed errors mirroring `dashboard/server/index.mjs`'s `{ error, code,
problems? }` shape (~3h), then 6.2 mapping those codes to i18n keys client-side
with keys in both locale files (~2h). Do them together — 6.2 is meaningless
without 6.1's codes — and give that session nothing else, because 6.1 touches
every route. Fold in the three carried fixes listed above if there is room.
**And instruct session 9 to end by writing the session 10 directive**, which is
**device verification**: it cannot start until Robin triggers a native rebuild,
and it is the session that finally exercises the ten things now waiting on one —
the three sounds, the burst, the Android channel, exact alarms, the iOS
interruption level, snooze firing, tray dismissal, token registration, 5.4's and
5.9's last hop to a real phone, and 5.6's entire horizon. Budget it as *at least*
one session: every time this project has verified something live rather than
stopping at green tests, it has found a bug the suite could not see.

---

*(A duplicate of the two bullets above, plus a paragraph arguing 5.6's urgency,
stood here until session 6 removed them. The urgency argument was answered by
5.6 landing, and the duplicated bullets had drifted — one of them still said the
snooze disagreement would last "until 5.4 lands", which it did in session 5.)*

> When picking up an item, replace this with: the item id, which files have been
> touched, what is half-done, and what the next concrete step is. A session that
> dies mid-edit is the case this exists for.

**Session 2 — 2026-07-30.** P0.3 (spike → written decision, D-10, plus new
sub-item 4.7e and 4.7d declined), 4.3 in full including the AsyncStorage
persistence layer it depends on, and 4.2 items 1, 3 and 5. Verified 4.3's four
resolution paths — cache hit, live refresh, stalled-fetch timeout, and
nothing-to-resolve — in a running web build rather than by reasoning. Left 4.2
items 2 and 4 blocked on 2.4 rather than shipping half a feature. Then 3.1, after
the owner ruled it belongs in this plan. The owner then deployed the backend by
hand, which surfaced the migration-ordering finding in §0.6 and made 001 urgent.
Then the native-build batch — 4.7e and 5.2 together, because both only take effect
in a rebuild and 4.7e's window closes once one is made — and finally 2.4's
`medication_reminders` half plus 2.6 as migration `002`, with a test that enforces
the `SCHEMA_SQL` mirroring rule the README only asserted in prose. Then 4.6 end to
end — API validation, form controls, 14 locale keys — after a second manual
backend deploy by the owner. Did not commit or migrate.

Two things this session could not verify, both for the same reason — they only
render for a signed-in user and creating that session means entering the owner's
password: **4.2's attribution line** and **4.6's form controls**. Everything
server-side behind them is covered by tests.

**Session 3 — 2026-07-31.** Cleared the deploy-and-reset block that session 2
died on: rebuilt and deployed the backend zip, ran `/reset-db` + `/seed-data`
against the live Taipei database under D-11, and probed the result — reminder
create and edit now work there for the first time, and `users` came through
intact. Then 4.2 items 2 and 4 together, which is what 2.4 and 4.6 had been
holding. Moved `computeNextTriggerDate` into `utils/date.ts` to make the new
offset arithmetic testable, and the tests immediately found a latent `Math.max`
NaN trap (§0.6).

Then, on the owner's instruction not to block on Apple, **5.3** at the level that
needs no entitlement request, and **4.7b + 4.7c** — which completes Phase 4 apart
from 4.4 (gated on 5.1) and the declined 4.7d. Writing 4.7c surfaced the ordering
bug in §0.6 that 4.7b had just created and that nothing in the plan predicted:
burst identifiers repeat across occurrences, so the chain-forward reschedule
silently ate the rest of today's burst unless the cancel ran first.

Then a tooling batch, prompted by the reset having wiped the caregiver graph:
`user_relationships` joined D-11's preserved set, `/debug/link` and
`/debug/unlink` were added (the unlink is not optional once the reset stops
clearing the table), and the nested-proxy routing bug in §0.6 was fixed — the
owner's API Gateway configuration had been correct all along, and `/debug/genders`
returning a plausible 200 from the *wrong* route is what made it look otherwise.
Deployed, verified against the live stack, and user 2 linked as a dependent of
user 1.

Then the client test runner §0.8 had been deferring since session 1: `npm test`
in `tish-app`, 52 tests moved into the repo, a `client-utils` CI job, and the
one-line import fix that was the only thing blocking it. Verified the app still
bundles afterwards rather than assuming — Metro had to accept the explicit `.ts`
extension too.

Finally **2.2 + 5.1**, with D-12 settled at three. Migration `003`, materialisation
written in SQL rather than JS so the date arithmetic exists once, and the
confirm/snooze route. Exercised against the live database rather than stopping at
green tests, which is the only reason the non-idempotent lookup in §0.6 was found
— it was unreachable code that every unit test was happy with. Two limits are
recorded rather than papered over: the timezone constant, and the materialisation
window's phase for non-daily reminders.

Corrected six stale things in this document along the way: the §1 guardrail that
forbade the reset D-11 requires, the 67-test count, §0.7 item 1 (resolved rather
than outstanding), §0.4's claim that the deployed code was behind the tree,
P0.2's premise that Critical Alerts was iOS's only urgency lever, and 4.7b's
assumption that 30-second spacing yields continuous audio. Did not commit.

**Session 4 — 2026-07-31.** The three items session 3 named: **4.4**, then **4.2
item 4's carried gap**, then **5.7's client half**. No backend change, so no
deploy and no AWS work at all — everything these needed was already live.

4.4 was forecast at "~2h, client-only" and the estimate held for two of its three
parts. The third — "retry the POST on the next sync" — turned out to hide a
correctness problem the plan never states: **the immediate POST deliberately
sends no timestamp, so a replay resolves against the wrong moment.** The server
picks the dose nearest `now()`, which is exactly right for a ringing alarm and
exactly wrong hours later, when "nearest to now" on an 08:00/20:00 reminder is
the evening dose. A queue built the obvious way would eventually confirm a dose
nobody had taken and suppress the escalation that exists to catch it. Resolved
without a server change: a replay reads `GET /medication-doses` around the moment
the button was pressed and posts the exact `scheduled_for` the server itself
wrote. Recorded in §0.6.

Writing 4.4 also surfaced **two live cancel-scope bugs in the code it had to
modify**, both from 4.7c and neither predicted anywhere. One deleted the sibling
slot's pending alarm every time a reminder with two alarm times fired; the other
deleted the *next occurrence* every time the patient pressed a button on the
overlay. Both are in §0.6 with the reasoning. They are the reason this session
touched `notification-identifiers.ts` and `_layout.tsx` at all.

Kept the pure logic in dependency-free modules so it could be tested rather than
reasoned about — `dose-queue-policy.ts` and `doses.ts`, following `date.ts` and
`notification-identifiers.ts`. That is what caught the `import type` requirement
under Node's type stripper (§0.6) and is what makes the retry rules assertable at
all: every one of them fails *silently* in production.

Verified beyond green tests: the app still bundles (1867 modules, no resolution
error), the overlay renders `Snooze (10m)` where it used to say `5m` while doing
nothing, and pressing snooze on the web build classified its 401 as retryable and
persisted a well-formed queue entry.

Then **2.5 and 5.8's registration half**, which is where the session stopped.
Split 5.8 rather than attempting it whole: registering a device is
self-contained and testable, while *sending* — Expo's push call, tickets, the
receipts poll, dead-token reaping — has no caller until 5.4 exists and should be
built as 5.4's dispatch step. The registration route is the first in this
codebase that deliberately ignores `?user_id`, for a reason worth reading in
§0.6 before "fixing" it. Left one decision rather than guessing: how
`push_tokens` reaches the live database (§0.7 item 2), with a recommendation.
Did not commit and did not deploy.

### 0.4 — State of the tree

- **Sessions 1–5 are committed on `main`, as *two* commits, and nothing has been
  pushed.** `e7c3cf1` (phases 1–5, the migration mechanism, server escalation)
  and `a1454c8` (5.6's policy half plus the session-5 handoff). `main` is 4 ahead
  of `origin/main`. **The session-5 handoff named a branch
  `reminder-delivery-phases-1-5` that does not exist** — see §0.6; verify with
  `git log --oneline -3` rather than believing a handoff. **Session 6's work
  (5.6's wiring) and session 7's (5.9, 5.8's receipts) are uncommitted**, in the
  working tree.
- **⚠ There is now a scheduled job running unattended.** EventBridge rule
  `tish-escalation-schedule`, `rate(5 minutes)`, ENABLED, targeting
  `tish-escalate-dispatch`. This is the first thing in the project that acts
  without anyone triggering it, and it is the thing that sends notifications to
  people. Disable with
  `aws events disable-rule --name tish-escalation-schedule --region ap-east-2`;
  that stops all escalation and nothing else.
- **There are now four Lambdas, all deployed from one zip.** `operation-strix`
  (`index.handler`, VPC), `tish-escalate-db` (`escalate.dbHandler`, VPC),
  `tish-escalate-dispatch` (`escalate.dispatchHandler`, **no VPC**) and
  `tish-migrate` (`migrate.handler`, VPC, no trigger of any kind). A backend
  deploy is one build and four `update-function-code` calls; leaving one behind
  means the escalation halves disagree about the protocol between them.
  **The zip must include `migrations/*.sql`** — `migrate.mjs` reads them from
  disk at runtime, so a zip built from the older file list deploys a runner with
  no migrations to run and reports "nothing to do" rather than failing.
- **`@aws-sdk/client-lambda` is a `devDependency` on purpose.** The dispatcher
  imports it to call the database half, but the Node.js managed runtime already
  provides the v3 SDK, so bundling it would add megabytes to a 195KB zip.
  Declaring it as a dev dependency is what lets eslint resolve the specifier
  while `npm ci --omit=dev` keeps it out of the artifact. **The assumption that
  the runtime provides it is verified**, not trusted — the dispatcher ran
  successfully against the live stack, which is the only thing that could prove
  it. If a future runtime drops the bundled SDK, the symptom is a module-not-found
  at cold start and the fix is one line in `package.json`.
- **The backend is deployed and current** as of 2026-07-31 (session 3, to
  `operation-strix` in `ap-east-2`). Everything server-side in sessions 1 and 2 —
  including 3.1, 2.4/2.6's schema and 4.6's validation — is live, verified by
  `CodeSha256` matching the local zip. **This stopped being true late in session
  4**: 2.5's table and `/push-tokens` are in the tree and not deployed. Every
  route that was live still is, and none of them changed — the gap is additive.
  §0.7 item 2 has the deploy.
- **The live database was rebuilt** by `/reset-db` + `/seed-data` under D-11.
  `users` survived (2 rows, both accounts intact, meal-time columns present);
  every other table was dropped and recreated from `SCHEMA_SQL`, which carries
  `alarm_labels`, `alarm_sources` and all four of 002's columns. The schema drift
  in §0.6 is resolved — by rebuilding, not by migrating.
- **Migrations `001` and `002` are still unapplied *as migrations***, and no
  longer need to be: the reset created every table already containing their
  columns, and `schema_migrations` is untouched. Both are `ADD COLUMN IF NOT
  EXISTS`, so a later replay is a no-op. A future non-idempotent migration makes
  this a trap — see D-11's last bullet.
- **No native build** has been made since the `app.json` plugin change, so 4.7a
  is not in any installed app.

Live probes, 2026-07-31, against the deployed Lambda:

| Probe | Result |
|---|---|
| `PUT /medication-reminders`, nonexistent id | **404 "Reminder not found"** — every column in the UPDATE resolves, `alarm_labels` included |
| `PUT` with `alarm_repeat_count: 99` | **400**, named field — 4.6's validation is live |
| `PUT` with `escalation_delay_minutes: 3` | **400**, named field |
| `PUT` with `escalation_order: "nope"` | **400**, named field |
| `POST /medication-reminders` | **200**, row returned with `escalation_enabled: false`, `escalation_delay_minutes: 30`, `escalation_order: caregiver_first`, `alarm_repeat_count: 3` — the defaults the INSERT's `COALESCE`s claim |
| `/debug/users` | 2 rows, preserved across the reset |
| `/debug/medication_reminders` | 0 rows |

The `POST` probe left a row behind, so the reset and seed were re-run afterwards;
the table is empty. See the `user_id` finding in §0.6, which that probe exposed.

**Session 5 probes, 2026-07-31**, all by direct `aws lambda invoke` rather than
through the gateway (§0.6):

| Probe | Result |
|---|---|
| `/reset-db` | **200**, `preserved: [users, genders, conditions, user_relationships]` |
| counts after reset + seed | `users` 2, `genders` 4, `conditions` 4, `user_relationships` 1, `medication_reminders` 0 — every preserved table intact, including the caregiver link |
| `POST /push-tokens` as user 1, with `?user_id=99` | **200**, row written with `user_id: 1` — the deliberate asymmetry holds live |
| same token re-POSTed as user 2 | **200**, **same row id**, `user_id` moved to 2, `created_at` unchanged, `last_seen_at` bumped — the row *moves* rather than duplicating, which is what the UNIQUE-on-token-alone constraint is for |
| `DELETE /push-tokens` as the previous owner | **200**, `removed: 0` — one account cannot unregister another's device |
| `DELETE /push-tokens` as the current owner | **200**, `removed: 1` |
| `POST /medication-reminders` (fixture) | **200**, reminder 1 recreated with `escalation_enabled: true` |
| `/debug/medication_doses` | **15** doses, in two buckets: `00:00Z` ×7 and `12:00Z` ×8 — i.e. 08:00 and 20:00 Taipei, so the timezone resolution is right |
| `tish-escalate-db` `{op:"claim"}` | **200**, `{"claims":[]}` — the claim SQL parses and resolves against the live schema; empty is correct, every dose was still in the future |
| `tish-escalate-dispatch` `{}` | **200**, clean summary — proves the cross-VPC invoke works *and* that the runtime provides `@aws-sdk/client-lambda` |

**Session 7 probes, 2026-07-31**, all by direct `aws lambda invoke`:

| Probe | Result |
|---|---|
| `tish-migrate {"command":"status"}` before | `pending: [006_push_outbox_and_tickets.sql]` |
| `{"command":"up","dryRun":true}` then `{"command":"up"}` | **applied**; a second `status` reports none pending, none orphaned — **six applied** |
| `CodeSha256` on all four Lambdas | all `duN/2QDdFDiNw9yjKKEXUhIhPBzJGKwjdhfczNbYAgA=`, matching the uploaded zip |
| dispatcher, baseline | **200**, summary carries the five new keys, `errors: []` — the new tables resolve |
| `POST /push-tokens` (synthetic, user 1) → `POST /medication-reminders` | **200** each; the write enqueues an outbox row |
| dispatcher, run 1 | `silentBatches: 1, silent: 0, reaped: 1, errors: []` — **the whole 5.9 chain**: the write queued, the drain resolved user 1's device, Expo answered `DeviceNotRegistered` for the synthetic token, and the VPC half deleted it |
| dispatcher, run 2 | all zero — the row was **closed, not retried**, so `outbox-done` works |
| `DELETE /medication-reminders` → dispatcher | `silentBatches: 0` — the delete enqueued, the drain found no device (the token had just been reaped) and closed the row rather than retrying forever |
| **no-op `DELETE`, with a token re-registered** | `silentBatches: 0` — **the `rowCount > 0` guard genuinely works.** Run separately and deliberately: with no token present it is indistinguishable from a row that was enqueued and closed |
| unattended, 8 consecutive minutes of CloudWatch | **8 runs, one per minute, `errors: []`** — the rate change took effect and the schedule is firing |

The probe reminder and the synthetic token were both removed afterwards.
`/debug/medication_reminders` is back to one row: session 3's fixture, reminder 1,
200mg at 08:00 and 20:00, escalation enabled. **Leave it.**

**`/debug/*` was widened after all**, in the same session. It was initially left
alone — the guardrail at the time said not to widen it without asking, and
`push_tickets` holds push tokens that Expo's unauthenticated API would let anyone
send to — and the owner's answer was that this is overthinking security that
belongs to the refactor as a whole. `push_tokens`, `push_outbox`, `push_tickets`
and `schema_migrations` are now in `allowedTables`, and §1's guardrail is
reversed. The probe table above was gathered before that, from the dispatcher's
own summary, which is why it reads the way it does.

**And the widened dump immediately paid for itself, which is the argument for the
owner's call.** `/debug/push_outbox` shows the whole of 5.9's behaviour directly,
where the table above could only infer it:

| id | reason | reminder | created | sent | attempts |
|---|---|---|---|---|---|
| 1 | `schedule-changed` | 4 | 13:29:23 | **13:29:32** | 1 |
| 2 | `reminder-deleted` | 4 | 13:29:54 | **13:29:56** | 1 |

Three things are visible here that the summary could only imply: the create and
the delete each enqueued exactly one row; both were **closed within seconds** of
the next drain, including row 2, which had no device to send to; and **there is
no third row** — the no-op `DELETE` issued at 13:30 enqueued nothing, so the
`rowCount > 0` guard is confirmed by observation rather than by a
carefully-constructed probe. `push_tickets` is empty, which is correct: a
synthetic token never yields an `ok` ticket. `push_tokens` is empty, confirming
the cleanup. `schema_migrations` reports six.

**5.4 was then exercised end to end against a dose built to come due during the
session** — a reminder for user 2 (the dependent) timed three minutes ahead with
the 5-minute minimum delay, and a synthetic push token registered to user 1 (the
caregiver). Both rungs fired at exactly the computed times:

| Rung | Time | Result |
|---|---|---|
| 1 (`push` → caregiver) | 05:35, = dose + 5 delay + 2 grace | `claimed: 1, pushed: 0` — **the Expo casing bug**; the claim was correct and the send 400'd. Level still advanced 0 → 1, which is the increment-before-dispatch semantics §8 asks for, behaving correctly under a failure |
| 2 (`sms` → substituted to `push`) | 05:39, = dose + 2×5 + 2 | `claimed: 1, substituted: 1, reaped: 1, errors: []` |
| 3rd claim | 05:40 | `{"claims":[]}` — dose sits at `escalation_level: 2` and will never escalate again |

**The second run is the one worth reading.** `substituted: 1` is D-8's channel
fallback firing for real: `caregiver_first`'s second rung is SMS, SMS has no
transport, and rather than doing nothing the job sent a caregiver push instead.
`reaped: 1` is 5.8's dead-token half completing the loop — Expo reported
`DeviceNotRegistered`, the dispatcher classified it, and the VPC-attached half
deleted the row. `errors: []` with `pushed: 0` is the correct outcome for a
synthetic token: the send succeeded, the *device* does not exist.

The fixture was deleted afterwards, and its 8 doses cascaded with it — left in
place it would have escalated to the caregiver at 13:27 every day. `users`,
`user_relationships`, reminder 1 and its 15 doses are untouched.

**The schedule itself was then confirmed firing unattended**, which is a separate
claim from "the handler works" and needed its own check. At 06:01:29 UTC, with
nobody invoking anything, CloudWatch recorded
`escalation run {"claimed":0,...,"errors":[]}` in
`/aws/lambda/tish-escalate-dispatch`. That single line proves the whole chain:
EventBridge fired, the non-VPC dispatcher woke, it reached across into the
VPC-attached half, the query ran, and the result came back clean.

**A design consequence found while verifying, not a bug.** A dose whose patient
has no caregiver and no SMS still consumes both rungs: the job claims it,
finds no available channel, logs `no-channel-available` and increments anyway.
So if a caregiver is added later, that dose's escalation is already spent. The
alternative — not incrementing — is worse, because the dose would then be
re-claimed on every run forever. Bounded and deliberate; worth knowing before
reading a skipped escalation as a failure.

**15 doses, not session 3's 16, and that is correct rather than a regression.**
The fixture was recreated at 13:24 Taipei, so that day's 08:00 slot was already
past and materialisation refused to create a dose in the past. Session 3 ran
before 08:00 and got both slots. Worth knowing before reading the count as a
bug.

Verification as of end of session 2: **67/67 backend tests pass** (51 → 67: six
from 3.1, three from migration 002's `SCHEMA_SQL` parity, seven from 4.6; no
existing assertion renumbered — the two that would have needed it now read
parameters by column name), `npx tsc --noEmit` clean, `npx eslint .`
0 errors (41 warnings, all pre-existing), `npm run validate-translations` passes
at **320 keys**. Plus **11/11** identifier tests, run with `node --test` against
`utils/notification-identifiers.ts` — these live in the scratchpad, not the repo;
see §0.6.

**Re-verified at the start of session 3: 75/75 backend tests pass.** The 67 above
was stale — D-11's reset work added eight (`RESET_SQL` preserving and rebuilding
the right tables, drop ordering, `SCHEMA_SQL` coverage, seed idempotency,
`medication_reminders` rebuilt with the columns the API writes, and 002's bounds
surviving into `SCHEMA_SQL`) and the ledger was never updated with the new count.

**End of session 3**: **115/115 backend tests** (75 → 115: six for
`resolveRoutePath` and the two nested-proxy symptoms, nine for `/debug/link` and
`/debug/unlink`, twenty-two for 2.2 and 5.1, two for the `SCHEMA_SQL` mirroring
of a migration-created *table* rather than only columns; two extended in place
because the behaviour they described genuinely changed — no assertion
renumbered), **52/52 client tests**, `npx tsc --noEmit` clean, `npx eslint .` 0 errors
/ 41 warnings — the same 41, none new — and `npm run validate-translations` at
**322 keys** (320 + the two escalation strings).

**End of session 4**: **129/129 backend tests** (115 → 129: three for 2.5's
schema and twelve for `/push-tokens`), **100/100 client tests** (52 → 100),
`npx tsc --noEmit` clean, `npx eslint .` 0 errors / 41 warnings — the same 41,
none new — and `npm run validate-translations` at **325 keys** (322 + 5.7's
three, with `alarmOverlay.snooze` changed in place rather than added). The app
bundles: 1866 modules, no resolution error, login screen renders with an empty
error console.

**End of session 5**: **200/200 backend tests** (129 → 200: 33 for
`escalation-policy.mjs`, 31 for `escalate.mjs`, 6 for migration 005 and 2 for
the timezone wiring; no existing assertion renumbered or weakened),
**122/122 client tests** (100 → 122: 22 for 5.6's `utils/notification-budget.ts`) — session 5 touched
no client code — `npx tsc --noEmit` clean, `npx eslint .` 0 errors / 41 warnings
(the same 41; two real errors were introduced and fixed, see below), and
`npm run validate-translations` at **325 keys**, unchanged: 5.4 deliberately
reuses 4.2's existing `notifications.doseEscalation*` rather than adding copy.

The two eslint errors are worth recording because both were genuine rather than
lint noise: an unresolvable `@aws-sdk/client-lambda` (fixed by declaring it —
see the devDependency note above) and `Buffer` as an undefined global (fixed by
using `TextEncoder`/`TextDecoder`, which is also the more portable marshalling).
Neither would have failed a test; both would have failed at runtime or in CI.

**The deployed stack is level with the tree.** All four Lambdas carry
`Luv6y6Wqg97oSqkEGsxJAO7WNaBkxVSHmI9/1QCKUYg=`, matching the zip uploaded at the
end of session 5. Per §0.6 that hash is only meaningful against *that* upload —
rebuilding from unchanged source produces a different one, so do not diff a
fresh build against it.

`tish-migrate` `{"command":"status"}` reports **five applied, none pending, none
orphaned** — the first time `schema_migrations` and the database have agreed.

**End of session 7**: **227/227 backend tests** (200 → 227: 5 for migration 006's
schema and the two new tables' shape, 22 for the outbox drain, the receipts poll
and the step isolation; two existing tests were *tightened* rather than
weakened — they gated on "any op that is not a claim", which meant the new ops
read as a reap, so they now name the op they mean), **183/183 client** — session
7 touched one client file and added no pure logic — `npx tsc --noEmit` clean,
`npx eslint .` 0 errors / 41 warnings (the same 41), and
`npm run validate-translations` at **325 keys**, unchanged: 5.9's push carries no
user-facing copy by design, because it is silent.

`app.json` gained `UIBackgroundModes: ['remote-notification']`, confirmed present
through `npx expo config --type introspect` alongside the `audio` mode that was
already there. **It has no effect until the native rebuild.**

**End of session 6**: **183/183 client tests** (122 → 183, all from 5.6's
wiring: 5 for `addDays`, 17 for the identifier occurrence segment, 16 for
`notification-budget`'s new cost model, and 25 for the new
`utils/alarm-schedule.ts`; no existing assertion renumbered or weakened),
**200/200 backend** — session 6 touched no backend code and made no AWS call —
`npx tsc --noEmit` clean, `npx eslint .` 0 errors / 41 warnings (the same 41,
none new), and `npm run validate-translations` at **325 keys**, unchanged: 5.6
adds no user-facing string. The app bundles and the login screen renders with an
empty error console.

**The new tests were mutation-checked rather than trusted**, because session 5
had found three of its own budget tests passing vacuously. Deleting the
occurrence segment from `identifierFor` — the single change that reintroduces the
bug 5.6's wiring exists to avoid — fails **8** tests across three files,
including both of the ones named `THE PROPERTY`. See §0.5.

**Client tests now live in the repo and run in CI** — `cd tish-app && npm test`,
**100/100**. This closed the "tests with no home" problem that had cost sessions
1 and 2 their suites; see §0.8 for what it covers and, more importantly, what it
does not.

- **20** for `utils/date.ts` — 15 for `computeNextTriggerDate` (offset ordering,
  the midnight crossing, the chain-forward, and the guarantee that no offset ever
  schedules into the past) and **5 in session 6** for `addDays`, including that a
  malformed step cannot produce an Invalid Date.
- **48** for `utils/notification-identifiers.ts` — session 2's 11, session 3's
  seven for the burst index, session 4's 13 for the slot filter and the snooze
  marker (both directions of the id/slot collision, the sibling-slot case that
  was a live bug, seconds surviving the comparison, an empty-string slot not
  silently widening the match, a build-then-match round trip), and **17 in
  session 6** for the occurrence segment: that it is local rather than UTC, that
  a burst index can never be read as one at any repeat count, that an identifier
  carrying none still matches any occurrence filter, and the collision the whole
  segment exists to prevent.
- **38** for `utils/notification-budget.ts` — session 5's 22 for the capacity
  arithmetic, and **16 in session 6** for the cost model the scheduler and the
  budget now share.
- **25** for `utils/alarm-schedule.ts` (session 6) — the layout of the horizon:
  that every identifier in a plan is distinct, that answering one alarm cancels
  exactly its own burst and leaves the rest of the week, that a burst crossing
  midnight keeps one occurrence key, that the chain-forward repairs a gap rather
  than only appending, and the end-to-end property that a device never lays out
  more alerts than the budget projected.
- **19** for `utils/meal-alarms.ts` — the day-boundary wrap, manual-wins-collision,
  positional alignment of the three arrays, and pre-migration rows carrying no
  `alarm_sources`.
- **22** for `utils/dose-queue-policy.ts` (session 4) — which statuses are worth
  retrying (401 yes, the other 4xx no), the two TTLs, the collapse rules
  including confirm-supersedes-snooze, and `pickDose` resolving against when the
  button was pressed rather than when the replay happens.
- **13** for `utils/doses.ts` (session 4) — the dose key's format and its
  independence from how a row serialises, a snoozed dose counting as neither
  confirmed nor yet missed, and the ordering and cap on the missed list. None of
  these assert a wall-clock against a fixed offset; a test that did would be
  testing the machine's timezone rather than the code.

`app.json` verified through `npx expo config --type introspect`: the Time
Sensitive entitlement is present, and 5.2's `USE_EXACT_ALARM` /
`SCHEDULE_EXACT_ALARM` (with `maxSdkVersion="32"`) are still intact alongside it.

**4.6's form controls are confirmed rendering**, from an owner screenshot on
2026-07-31: the burst control shows 1–6 with 3 selected — matching migration
002's CHECK and the column default — and the escalation section renders with its
caregiver-first order control. The delay presets sit below the fold and are still
unseen.

The deployed routes were then exercised for real against the live stack:
`/debug/users` returns its 15 columns instead of 401ing, `/debug/genders` returns
the *dump* rather than the public route's bare array, `/debug/link` created and
returned an active relationship, `/debug/unlink` 404s on a pair that is not
linked, and `/genders` still returns its own shape — i.e. the routing fix did not
shadow the public routes it was previously colliding with.

**The caregiver path is now testable**: user 1 is an active caregiver for user 2
on the live database, created while verifying `/debug/link`. Reverse it with
`/debug/unlink?caregiver=1&dependent=2` then `/debug/link?caregiver=2&dependent=1`.

5.1 was then exercised end to end against the live database, which is where its
one real bug turned up (§0.6). Reminder 1 for user 1 (200mg, 08:00 and 20:00,
daily) materialised **16 doses = 8 days × 2 slots**, all in the future, all
unconfirmed, at exactly 08:00 and 20:00 Taipei wall-clock — so the timezone
resolution is right. A second `GET /medication-reminders` left the count at 16,
confirming the top-up is idempotent. One dose was confirmed; confirming again
returns the *original* `confirmed_at` and `confirmed_by` rather than a second
write, and snoozing that dose returns 409. **That reminder and its doses are
still on the live database and are useful fixtures — leave them.**

Still not verified in a running app: 4.2's attribution line and the delayed
escalation alarm — those need a signed-in session on a device, not just the
relationship. Also unverified on a device: the burst, the interruption level, and
every sound. All native-only, so no web build could have exercised them.

**Session 7 adds two more.** 5.9's silent push has never reached a device — and
on iOS it cannot until the rebuild, because `UIBackgroundModes` only takes effect
in a built app; without it the push arrives while the app is foregrounded, which
is the case the launch re-sync would have covered anyway. And **5.8's receipts
poll has never read a receipt**: a receipt only exists for an `ok` ticket, a
synthetic token never produces one, so the path that reaps a delayed
`DeviceNotRegistered` is unit-tested only. Its "nothing due" path runs every
minute and is clean.

**Session 6 adds one to that list, and it is the largest single thing on it.**
No alarm written under 5.6's six-segment identifier has ever been handed to an
OS. The reconciliation pass returns before scheduling on web, by design, so a web
build cannot reach the code at all — every assertion about the horizon is a unit
test over pure functions. What a device would settle: that
`scheduleNotificationAsync` accepts the longer identifier, that iOS really does
keep 60 pending alerts rather than fewer, and that a burst member's cancel finds
the day it fired and not the week.

**What session 5 could not verify about 5.4, and it is one specific thing.** The
whole server path is exercised — claim, ladder, substitution, Expo call, ticket
handling, reaping — but **no real device has ever received one of these pushes,
because no real push token exists.** `getExpoPushTokenAsync` cannot run on web or
a simulator, so every token used in testing was well-formed and synthetic, and
Expo answers those with `DeviceNotRegistered`. That is genuinely useful — it is
what exercised the reaping path end to end — but it means the last hop, Expo to
a physical phone, is unproven. It joins the list of things waiting on the native
rebuild, and unlike the others it will be obvious the moment one exists: register
a device, let a dose go unconfirmed, and the phone either buzzes or it does not.

4.3 was exercised in a running web build via the `triggerAlarm` console helper:
cache hit resolves name, dosage and the right one of several time-slot labels;
a live refresh overwrites the cache and evicts deleted rows; a stalled fetch is
aborted at 2.5s with the cached copy standing and the "could not refresh" notice
shown; and an unknown or server-side-deleted reminder degrades to the generic
prompt rather than rendering blank. **Not** verified: 4.2's attribution line,
which only renders for a signed-in user whose id differs from the alarm's owner —
that needs a real session.

Re-run all four after any interruption before trusting the ledger above:

```bash
cd tish-app/backend && npm test
```

```bash
cd tish-app && npx tsc --noEmit && npx eslint . && npm run validate-translations
```

### 0.5 — Session log

**Session 1 — 2026-07-30.** Worked the owner's explicit order: 3.5+3.6, 4.7a,
Phase 1 (all 18, not the 12 in the original table — 1.13–1.18 were added by the
second review pass), 2.1, 4.8, then 4.1+4.5 from §11. Corrected `MIGRATION.md`
D6, three of whose four entries were stale. Ended at a clean boundary with the
Phase 4 foundation in place. Did not commit, deploy, or migrate.

**Session 5 — 2026-07-31.** Cleared §0.7 item 2, then built **5.4** with 5.8's
send half inside it.

The decision first, because everything else waited on it: the owner chose
`/reset-db` + `/seed-data` over building the migration runner. **The ordering
turned out to be forced rather than a matter of taste** — the reset executes
`SCHEMA_SQL` *from the deployed code*, so the Lambda carrying `push_tokens` had
to be deployed before the reset could create the table. Deploy, reset, seed,
then recreate the fixture. Two things about the reset are worth carrying
forward: the gateway refuses `/reset-db` outright (§0.6), so it runs by direct
`aws lambda invoke`; and the recreated reminder was deliberately made
`escalation_enabled: true`, because the row it replaced had it false and 5.4
could not have been exercised against it.

Then 5.4, which cost most of the session and did not go the way §8 describes.
**The single Lambda §8 specifies cannot exist in this account**: the job needs
RDS, which is VPC-only, and Expo, which is on the internet, and a VPC-attached
Lambda here has neither NAT nor endpoints. The subnets route to an internet
gateway, which reads as egress and is not — Lambda ENIs get no public IP.
Proved it with a throwaway function rather than trusting the route table, which
is the only reason the diagnosis was quick: same code, 6s abort attached, HTTP
200 in 2.1s detached. The owner chose two Lambdas over a NAT gateway, so the
dispatcher runs outside the VPC and drives a VPC-attached database half through
the Lambda API — the direction that costs nothing.

Kept the decisions in a dependency-free module for the same reason sessions 3
and 4 did, and it earned its keep immediately: **every rule in
`escalation-policy.mjs` fails silently.** A ladder that picks the wrong rung
notifies the wrong person; a fallback that skips instead of substituting turns
off the safety net for exactly the configuration D-8 added it for. Two of them
would have shipped wrong without a test — the rung index is read from the
*post-increment* level, and Expo's positional ticket array will happily pair a
dead ticket onto a working token if the lengths differ.

Also found two things §8 gets wrong and one it omits: its query selects
`escalated_at`, a column 2.2 never shipped; and it has **no upper bound on
lateness**, which would have made the feature's first act an escalation of every
unconfirmed dose in the window. All three are in §0.6.

Deployed all three Lambdas from one zip, wired EventBridge at `rate(5 minutes)`,
and exercised the job against the live database rather than stopping at green
tests — which is what confirmed the claim SQL resolves against the real schema
and that the runtime really does provide the AWS SDK the dispatcher assumes.

**And then the live run found the bug the whole suite had missed.** A fixture
dose was built to come due during the session — a reminder for user 2 timed
three minutes ahead, with the 5-minute minimum delay — and the first real
dispatch reported `claimed: 1, pushed: 0`. The claim, the ladder and every
database interaction were correct; Expo rejected the batch with a 400 because
**`interruptionLevel` is kebab-case in the push API and camelCase on the
device**, and 5.3's known-good client value had been copied across. 190 green
tests could not see it, because they mock `fetch`. Fixed, pinned with a test,
and written up in §0.6 along with the misleading shape of Expo's error.

That fixture is worth keeping as a technique rather than as data: **a dose timed
to come due inside the session is the only way to exercise this job**, and it
costs one `POST /medication-reminders` plus a wait of `delay + 2` minutes.

**Then, on the owner's instruction, the migration runner** — build it, set the
existing users' timezone and locale to defaults, and carry on. It had been
deferred four times, always correctly, because a reset was always cheaper. What
changed is that 5.4 had just built two VPC-attached Lambdas from the same zip an
hour earlier, so the role, the subnet ids, the zip pipeline and the invoke
pattern were all already in hand: §0.7's half-day estimate came in well under an
hour. `tish-migrate`, migration `005`, `status` → `up --dry-run` → `up`.

Running `status` for the first time immediately contradicted §0.4: **001 and 002
were already recorded as applied**, because `schema_migrations` is not in
`ALL_TABLES` and so survives every reset by omission. Harmless so far and a trap
waiting for the first non-idempotent migration. All five are now recorded and
the database and its history agree for the first time.

Wired both columns through rather than leaving them decorative — materialisation
resolves against `COALESCE(u.timezone, $2)` and 5.4 renders copy in
`u.locale` — and verified live: a reminder at 09:15 Taipei materialised doses at
01:15 UTC, which is the whole point of the column existing. The `aws login`
session expired between applying the migration and deploying that wiring, which
is worth noting only because the gap was *invisible*: the constants and the
column values were identical, so nothing misbehaved in between.

Finally **5.6's policy half** and the session's first commits — 66 files,
deliberately excluding the unrelated `opus 5 vs 4.8.txt` scratch file in the
working tree. Stopped before 5.6's wiring rather than starting a multi-hour
change with no room to finish it; §0.3 had the five concrete steps, including the
identifier collision that would otherwise be discovered the hard way for the
third time.

*(Corrected in session 6: this paragraph said "one checkpoint on
`reminder-delivery-phases-1-5`". There were **two** commits, `e7c3cf1` and
`a1454c8`, and they are on `main` — no such branch exists. See §0.6.)*

Worth recording about the budget module itself: **the first failing test was the
test, not the code.** The scenario written to prove "dependents get dropped
first" never reached the dropping stage, because trimming the burst absorbed the
pressure first — which is the priority order the plan specifies. Reaching the
drop path at all takes more than thirty alarm times between reminders. Two other
tests in the same block were passing *vacuously* for the same reason and now
assert that a drop actually happened.

Then wiring EventBridge turned up two more, and they are a matched pair: the
execution role could only write logs for `operation-strix`, so both new
functions ran **completely blind** while returning correct results — and once
that was fixed, the logs revealed that the dispatcher skipped its own summary
line on empty runs, which is every run that has nothing to do. A scheduled
safety mechanism that is silent by design and unobservable by accident is not
one anybody should trust. Both in §0.6. **The first bug hid the second**, which
is the argument for going and reading the logs rather than assuming a green
return value means the thing is observable.

**Session 6 — 2026-07-31.** One item: **5.6's wiring**, the only thing session 5
left deliberately incomplete. No backend change, no AWS call, no deploy — like
session 4, everything this needed was already in the tree.

§0.3's five steps held, and step 3 was the one that cost the time it was
predicted to. The plan asked for an occurrence *index*; what shipped is an
occurrence **date** (`YYYYMMDD`), and the reason is worth carrying: an index is
relative to when the schedule was written, so `-o0` means today in one pass and
tomorrow in the next — the same identifier meaning two different alarms, which is
precisely the fact §0.6 already records two bugs against. A date is stable, which
makes both writers idempotent and let step 4 be answered without hedging.

That answer is the other thing worth reading. §0.3 asked whether
`rescheduleNextOccurrence` becomes a no-op or a top-up; it is a top-up, and it
rewrites the **whole** forward horizon rather than appending one day at the far
end. Appending is cheaper and wrong in the case that matters — an app that has
not run for three days has lost those occurrences, and appending leaves the hole
in the middle. Date-keyed identifiers make the rewrite idempotent, so it repairs
the gap instead. There is a test for exactly that.

Two structural problems the plan did not name, both in §0.6. The budget is
device-wide while `syncFor` is called for **one** owner from the medications
screen, so budgeting from that owner's reminders alone would overrun the cap on a
caregiver's phone — hence a device-wide cost map. And three callers outside the
reconciliation pass schedule a single reminder in response to a user action;
falling back to one occurrence in those would have collapsed a reminder's horizon
every time someone toggled it — hence the remembered plan.

Split the layout into `utils/alarm-schedule.ts` partway through rather than
leaving it inside `notification-helper`, for the reason sessions 3, 4 and 5 each
made the same call: the identifier arithmetic is the part that fails silently,
`notification-helper` imports `expo-notifications` and cannot be loaded outside a
native runtime, and "I reasoned about it" is not good enough for a rule that has
already produced three unpredicted bugs. `notification-helper` is now the I/O
half and nothing else.

**Session 7 — 2026-07-31.** **5.9** and **5.8's receipts poll**, together, because
both needed the same migration and the same deploy. Phase 5 is now finished apart
from 5.5, which is blocked on AWS.

The architecture was decided by the network rather than by preference, and it is
the thing worth carrying. §8 says the reminder write sends the push. It cannot:
`index.mjs` is VPC-attached because RDS is private, and **a VPC-attached function
here can reach neither `exp.host` nor the Lambda API** — so it can neither send
nor ask the non-VPC dispatcher to. §0.6 predicted this would constrain 5.9 and it
did. Verified rather than assumed this time, in one command:
`describe-vpc-endpoints` and `describe-nat-gateways` both return `[]`.

So the write enqueues into `push_outbox` and the dispatcher drains it. That costs
latency and buys two things the direct send would not have had: a failed send is
**retried** rather than lost, and several edits in a minute **coalesce** into one
push per device, which matters because iOS rate-limits silent pushes. The latency
was then bought back by tightening EventBridge from `rate(5 minutes)` to
`rate(1 minute)` — safe because the escalation claim is gated on
`scheduled_for + delay + grace`, so a more frequent run fires it *closer* to the
intended moment rather than more aggressively.

**The restructure this forced is the part a future session should not undo.** The
dispatcher used to return as soon as there were no doses to escalate — which is
most runs — and 5.9's drain and 5.8's poll both live after that point. Leaving
the early return would have made the silent push work only on the runs that
happened to be escalating something. It is now three isolated steps, each in its
own try/catch, so that an optimisation cannot take a safety mechanism down with
it. There is a test named for the regression.

Two bugs found by the tests rather than by reading, both the same shape as things
§0.6 already records. **`Number(null)` is 0 and passes `Number.isInteger`**, so
the obvious id sanitiser turned a null in an untrusted payload into a request to
update row 0. And the `SCHEMA_SQL` parity test matches a table block non-greedily
up to the first close-paren-semicolon, so a `);` **inside a SQL comment** silently
truncates the block and reports every column below it as missing — which cost two
attempts, the second being the comment written to warn about the first.

Exercised against the live stack rather than stopping at green tests, which is
where the two probes that actually prove something came from: a reminder write
that produced `silentBatches: 1, reaped: 1`, and a second run that produced all
zeros because the row had been *closed* rather than retried. The no-op-delete
guard needed its own probe with a token deliberately re-registered — without one,
"enqueued nothing" and "enqueued and closed with no device" are the same summary.

Initially did **not** widen `/debug/*` to inspect the new tables, though it was
the obvious way, because §1 forbade widening it without asking. **The owner
overruled that at the end of the session**: `/debug/*` is unauthenticated in its
entirety and belongs to the security refactor as a unit, so holding individual
tables out of the whitelist is overthinking. `push_tokens`, `push_outbox`,
`push_tickets` and `schema_migrations` were added and §1's guardrail reversed —
it now says to widen freely. Worth recording as a pattern rather than an
incident: this is the **fourth** time a session has been told it was being too
cautious with something the owner had already priced, which is why §1's first
guardrail exists.

**The tests were then mutation-checked rather than trusted**, because session 5
found three of its own budget tests passing vacuously and the same trap was live
here — every new test passed on the first run, which is exactly what a vacuous
suite looks like. Deleting the occurrence segment from `identifierFor` fails 8
tests across three files, including both `THE PROPERTY` assertions. Separately
confirmed that the end-to-end test's extreme fixture genuinely reaches the
*drop* path (`dropped: [2]`) rather than being absorbed by the burst trim, which
is the specific way session 5's tests had been vacuous.

Also corrected two stale things in this document: §0.3 carried a duplicated pair
of bullets, one of which still said the snooze disagreement would last "until 5.4
lands" — it landed in session 5 — and §0.4 said "nothing is committed" while §0.3
three sections above said the opposite. The commit facts in the session-5 handoff
were wrong in two ways; see §0.6.

### 0.6 — Findings that amend the plan

- **4.7a: `alarm.wav` was referenced three times, not twice** — also
  `notification-helper.tsx:117` in `rescheduleNextOccurrence`.
- **4.7a: iOS will not play MP3 as a notification sound.** It accepts PCM in
  `.wav`/`.aiff`/`.caf` only and silently substitutes the default chime.
  Registering the existing `.mp3` files would have fixed Android alone. Hence
  `assets/sounds/alarm_*.wav`, mono 44.1kHz — and the `alarm_` prefix, because
  `res/raw/default.wav` generates `R.raw.default` and fails the Android build on
  a reserved word.
- **4.7a: the `medication-alarms` channel was never actually used.** `channelId`
  belongs on the *trigger*, and no `scheduleNotificationAsync` call set it — so
  Android notifications were landing on the default channel at default
  importance, quieter than the plan assumed. Android also takes sound from the
  channel rather than the notification, so a per-reminder sound needs one channel
  per sound; both are now wired, with new channel ids because a channel's sound
  is fixed at creation and cannot be changed by an update.
- **The translation coverage hole is smaller than §4 says.** `t()` is typed
  against the generated key union, so a key missing from *both* locale files is
  already a `tsc` error. The residual gap is a key in `en.json` but not
  `zh-Hant.json` when the workflow doesn't run. **Not** fixed: widening
  `translations.yml`'s trigger also changes what gets EAS-published, which is a
  deploy decision. See the amended `MIGRATION.md` D6.
- **Two more `MIGRATION.md` D6 entries were stale**, alongside the
  `frequencyEvery_one` one already noted: there is no `react/no-children-prop`
  code in the repo. D6 has been corrected in place.
- **P0.3: `app.json` does have an `expo-notifications` plugin block** — session 1
  added one for 4.7a. P0.3's text said it had none.
- **P0.3: the nine-minute Doze cap invalidates D-9's burst on Android.**
  `setAndAllowWhileIdle` / `setExactAndAllowWhileIdle` cannot fire more than once
  per nine minutes per app while idle, and they are the only APIs
  `expo-notifications` uses. The burst is iOS-only; see D-10. This was not
  anticipated anywhere in the plan and it also puts a nine-minute floor under
  5.6's handling of two reminders scheduled close together.
- **P0.3: notifee was archived in April 2026.** The plan implicitly assumed
  full-screen intent was a config-plugin-shaped problem. It is now either bespoke
  native code or a four-month-old single-maintainer fork. 4.7d is declined rather
  than blocked.
- **P0.3: getting exact alarms needs no plugin at all, only a permission.**
  `expo-notifications` already branches on `canScheduleExactAlarms()`. 5.2 shrinks
  to ~45m. The only reason a config plugin is involved is that `app.json` cannot
  express `android:maxSdkVersion` on a permission.
- **The parameter counts 4.6 warned about were already stale.** The plan (and
  §0.3) said `inserted.length === 14` / `updated.length === 15`; session 1's
  `alarm_sources` had already moved them to 15 and 16. Rather than renumber a
  third time, the two tests now read parameters **by column name**, parsed out of
  the SQL — `insertedByColumn` / `updatedByColumn` in `index.test.mjs`. The
  arity assertions stay, and the UPDATE's id/user_id scoping is asserted
  relative to the SET count rather than at fixed positions. Adding a column to
  either statement no longer touches any index.
- **4.6's proposed 5-minute custom delay floor is unsafe on Android, for a reason
  that has nothing to do with the UI.** 4.6 says to bound the custom escalation
  delay at 5–240 minutes. But 4.2 item 4 schedules the caregiver's copy locally at
  dose time + delay, and Android throttles the app to **one alarm per nine
  minutes** while idle (P0.3 finding 6). A 5-minute delay puts the escalation
  alarm inside that window, so on a caregiver's own device it can be silently
  deferred. Migration `002` keeps the permissive 5–240 CHECK — the database should
  not be stricter than the plan without a decision — but **4.6's UI should offer
  15 as its lowest preset and bound the custom value at 10 or more.** Flagged
  rather than decided.
- **Nothing enforced the migration ↔ `SCHEMA_SQL` mirroring rule** that
  `migrations/README.md` calls the one hard rule; it was a convention in prose.
  `migrate.test.mjs` now extracts every `ADD COLUMN IF NOT EXISTS` from every
  migration and asserts each appears in `SCHEMA_SQL`, with a guard against the
  extraction silently matching nothing. Verified to fail when any one column is
  removed.
- **⚠ `SCHEMA_SQL` has columns that no migration ever applied, so the live
  database is behind the code even with every migration applied.** Probed against
  the deployed Lambda on 2026-07-30: `UPDATE medication_reminders` fails with
  `column "alarm_labels" does not exist`. `alarm_labels` is **not in migration 001
  or 002** — it exists only in `SCHEMA_SQL`, added directly before the migration
  mechanism (2.1) existed. Postgres reports the first unresolved column, so
  `alarm_sources` and 002's four columns are *masked* and their state is unknown.

  Consequences:
  - **`POST` and `PUT /medication-reminders` are broken on the live stack and
    running 001 and 002 will not fix them.** `medication_reminders` holds **0
    rows**, which is consistent with reminder creation never having succeeded
    against the Taipei database.
  - This is a **second, worse drift class** than the ordering finding below. The
    parity test added in session 2 checks migration → `SCHEMA_SQL`; it cannot
    catch `SCHEMA_SQL` → database, because nothing in the repo knows what the
    database actually has.
  - `SCHEMA_SQL` is only ever executed by `/reset-db`, which P0.1 deletes and
    which must never run against a live database — so it has never been a real
    convergence mechanism, only a from-scratch definition that quietly drifted.

  **Resolved by decision, 2026-07-30:** the owner ruled that application data is
  disposable while the project is internal-testing only, so the fix is to rebuild
  the tables rather than to reconcile them. See the reset mechanism below and
  §2 D-11.
- **Migrations must be applied *before* the code that reads their columns is
  deployed, and nothing in this plan said so.** Both §0.7 items were listed as a
  flat to-do list with no ordering, and deploying first cost a live regression on
  three routes — two of them pre-existing write paths, not new features. **This
  applies again to 2.4:** migration `002` must land in the database before 4.6's
  API changes are deployed, or `POST`/`PUT /medication-reminders` breaks the same
  way a second time.
- **4.2's item 2 cannot ship before 2.4**, which the suggested order in §11 did
  not reflect — it lists 4.2 as a single item after 4.1 and 4.3, but item 4 reads
  columns that 2.4 adds. Corrected in the note under 4.2.
- **The client *can* be unit-tested today, for dependency-free modules.** §0.8
  blamed the missing runner on `meal-alarms.ts` importing `./date` without an
  extension. That is the only obstacle: `node --test` on Node 24 strips types
  and runs a `.ts` file with no imports directly, which is how the 11 identifier
  tests run. Adding the extension to that one import would likely bring
  `meal-alarms.ts` in too.
- **⚠ 5.1's dose lookup excluded confirmed doses, which made confirmation
  non-idempotent — and no unit test could have caught it.** Found by exercising
  the deployed route against the real database. The "which dose does this alarm
  mean" query filtered `confirmed_at IS NULL`, so a *second* confirm found
  nothing and returned 404 — meaning the `COALESCE(confirmed_at, now())`
  idempotency written directly below it was unreachable code. Under D-1 the
  second confirm is the caregiver's, i.e. exactly the case `confirmed_by` exists
  to record, so the caregiver's app would have shown an error for a completely
  normal action.

  Fixed by **ordering rather than filtering**: `ORDER BY (confirmed_at IS NOT
  NULL) ASC, <distance> ASC`. An unconfirmed dose still wins whenever one is in
  the window; an already-confirmed one is returned only when there is nothing
  else, which is precisely the double-press case. Snooze is unaffected — its
  `UPDATE` still carries `confirmed_at IS NULL` and correctly 409s.

  The general lesson, since this is the second time in this session: the unit
  tests assert the *shape* of the SQL, which is genuinely useful and cannot
  notice that a `WHERE` clause makes a later branch unreachable. Routes that
  resolve a row by proximity or by state need one live round trip before being
  believed.
- **Zip hashes are not stable across rebuilds, so they cannot answer "is the
  deployed code current?"** `CodeSha256` matching the zip you just uploaded is a
  valid check that *that upload* landed — it is used three times in this session
  for exactly that. But rebuilding from unchanged source produces a different
  hash, because the zip records each entry's mtime and staging copies the files
  fresh. Comparing a fresh build against the deployed hash therefore reports a
  false difference. Redeploy rather than trying to diff.
- **⚠ The Lambda rebuilt its route from `pathParameters.proxy`, which only works
  for a proxy resource mounted at the root — and the failure was disguised.**
  Found 2026-07-31 while enabling `/debug/` through API Gateway. For `/{proxy+}`,
  `proxy` is the whole path and `/${proxy}` reconstructs it exactly, so this was
  invisible for a year. For a *nested* resource like `/debug/{proxy+}`, `proxy`
  is only the part after the mount point: `GET /debug/users` became `/users`.

  Two different symptoms, and the second is why it was hard to place:

  - `/debug/users`, `/debug/medication_reminders`, `/debug/user_relationships`
    fell through to the auth guard and returned **401 `Cognito: login required
    (/users)`** — note the path in the message is the rewritten one, which is the
    tell.
  - `/debug/genders` returned **200 with plausible data**, because `/genders` is
    a real public route. It looked like the debug dump working. Any diagnosis
    that started from "genders works, so the gateway is fine" was starting from a
    false premise.

  Fixed by `resolveRoutePath`: prefer the request's real path (`event.path`, or
  `rawPath`), keep the `proxy` reconstruction only as a fallback for an event
  carrying no path, and strip a stage prefix if one appears. Six tests, including
  both symptoms above. **The API Gateway side was configured correctly all
  along** — `/debug` and `/debug/{proxy+}` with `GET` at `NONE`, integrated to
  the same Lambda, and deployed.
- **⚠ 4.7c must run *before* the chain-forward reschedule, and this section did
  not anticipate it.** A burst member's identifier is stable across occurrences —
  the same reminder, slot and index tomorrow produce the same string — and
  scheduling onto an existing identifier *replaces* it. So `rescheduleNextOccurrence`
  writing tomorrow's burst silently drags today's un-fired alerts forward with it,
  cancelling the burst by accident and leaving `cancelAlarmBurst` nothing to find.
  Reversed, it is correct: cancel today's remainder, then write the next
  occurrence into an empty queue. `_layout.tsx` sequences the two and the ordering
  is load-bearing rather than stylistic.

  Worth seeing clearly: **before 4.7b this bug was invisible**, because a single
  alert had already fired by the time it rescheduled itself. The burst is what
  made identifier reuse across occurrences matter.
- **P0.2's premise was too coarse: iOS has two urgency levels, and only the
  higher one needs Apple.** The plan treated Critical Alerts as the only lever and
  therefore treated 5.3 as fully blocked. `interruptionLevel: 'timeSensitive'`
  breaks through Focus modes and the notification summary, and its entitlement is
  self-service — no request, no lead time. That covers the bedtime-dose case for
  anyone using Sleep Focus, which was most of P0.2's stated value. Only ring-silent
  and Do Not Disturb proper actually require the entitlement. **Roughly 80% of what
  P0.2 was blocking was available the whole time.**
- **The burst's 30-second spacing does not produce continuous audio, and D-9
  assumed it would.** D-9 reasoned from "a sound of up to 30 seconds… spaced so
  the audio runs continuously", but the three bundled sounds run **9–12 seconds**
  (`constants/sounds.ts`), so a 3-alert burst at 30s spacing is three pulses
  across 60 seconds with ~20s of silence between them. Implemented at 30s as 4.7b
  specifies rather than quietly retuned, and it is arguably the better wake
  pattern — intermittent alerts across a longer window beat 30 seconds of
  continuous tone. But it is not what the decision described, and the lever if a
  device test says otherwise is **lengthening the sound files toward 30s**, not
  shortening the spacing: shorter spacing shrinks the window the burst covers.
- **⚠ `schema_migrations` survives a reset, so the migration history is not what
  §0.4 said it was.** §0.4 recorded that 001 and 002 were "still unapplied *as
  migrations*" and that `schema_migrations` was untouched. Running `status` for
  the first time, in session 5, showed **001 and 002 already recorded as
  applied** and only 003–005 pending. The cause: `RESET_SQL` drops the tables in
  `ALL_TABLES`, and `schema_migrations` is not one of them — so it is preserved
  by omission rather than by the deliberate `RESET_PRESERVED_TABLES` list, and
  its contents outlive every reset.

  Harmless here, and it would not have stayed harmless: the assumption that the
  table was empty is what would have made a future non-idempotent migration
  either silently skipped or wrongly replayed. **Now resolved as a question
  rather than an assumption** — all five migrations are recorded, so
  `schema_migrations` and the database agree for the first time.

  The corollary worth carrying: **check `status` before believing any claim in
  this document about what is applied.** It is one Lambda invoke now.
- **⚠ `scheduled_for` needs a timezone, and there is nowhere correct to put one.**
  `medication_reminders.alarms` holds "HH:mm" wall-clock with no zone, and
  `medication_doses.scheduled_for` is a `timestamptz`, so materialisation has to
  know where the patient is. The right answer is a `users.timezone` column
  populated by the client. **It cannot be added**: `users` is preserved across
  `/reset-db` (D-11), so unlike every other table it cannot pick up a column from
  a rebuild — it needs a real `ALTER TABLE` against the live database, and the
  VPC-attached migration runner that would allow (§0.7 item 1) has never been
  built. That item was marked resolved because the *reset* superseded it; this is
  the first thing to prove it only superseded it for rebuildable tables.

  Shipped as `APP_TIMEZONE = 'Asia/Taipei'`, which is correct today — the app is
  Taiwan-facing, zh-Hant, on Taipei infrastructure — and wrong the moment one
  patient travels or the product ships elsewhere. **Whoever builds the migration
  runner should treat `users.timezone` as its first customer.**

  **✅ RESOLVED, session 5, and it was indeed the first customer.** The runner
  was built (`tish-migrate`) and migration `005` added `users.timezone` and
  `users.locale` together, both defaulting to exactly the constants they
  replaced so nothing changed for the existing rows. `materialiseDoses` now
  joins `users` and resolves against `COALESCE(u.timezone, $2)` — the fallback
  to `APP_TIMEZONE` is kept deliberately, because a NULL zone would otherwise
  materialise every dose at UTC midnight, an eight-hour error that no test and
  no glance at the data would catch. `APP_TIMEZONE` therefore stays as a
  fallback rather than being deleted.

  The estimate was wrong in the useful direction: §0.7 called the runner half a
  day, and it took well under an hour **because 5.4 had already built two
  VPC-attached Lambdas from the same zip that same session** — the role, the
  subnet and security-group ids, the staging and zip pipeline and the invoke
  pattern were all already established. The deferral was reasonable each time it
  was made; it stopped being reasonable the moment the surrounding work made it
  cheap.
- **The materialised window is anchored on today, which is exact only for
  `frequency_days = 1`.** The device anchors its chain on when the reminder was
  created or last edited and walks forward; the server walks forward from today.
  For daily reminders — the form default and almost every real row — the two
  agree exactly. For a 3-day interval they can be out of phase, so the server may
  materialise a dose on a day the device does not alarm, and 5.7 would show it as
  missed. Not fixable without storing an anchor date on the reminder, which is a
  schema change 5.1 could not make. **Worth doing with the next migration**;
  until then, treat the missed list as trustworthy for daily reminders only.
- **⚠ The reset wiped `user_relationships`, so caregiver features cannot be
  tested until a pairing is re-created.** D-11 preserves `users`, `genders` and
  `conditions`; the caregiver graph is not in that set and was rebuilt empty.
  Accounts survived, so this is re-pairing rather than re-registering — but it
  needs the dependent to accept a verification code, so it is not a one-sided
  fix, and it is why 4.2's caregiver path could not be exercised in session 3.

  **Resolved by the owner, 2026-07-31: `user_relationships` is now preserved.**
  D-11's set is four tables. It is preserved for a different reason from the
  other three — not to protect a foreign key, but because the rows cost a
  two-device verification-code exchange to recreate. Safe for the same reason
  `genders` is: it references `users(id)`, which also survives.

  **The consequence, which is the part worth carrying forward: a reset no longer
  produces a clean relationship graph.** `/debug/link` and `/debug/unlink` exist
  because of that, and shipping only the link would have swapped "relationships
  keep vanishing" for "relationships can never be cleared".
- **⚠ 4.2 item 4 shipped without its cancel-on-confirm half, and the reason is
  structural rather than an omission.** The item is "schedule at dose time +
  delay, only for escalation-enabled reminders, **and cancel it on the next sync
  if the dose has been confirmed**." The first two thirds are done. The last third
  has nothing to read: a confirmation is not recorded anywhere — not on the
  server (`medication_doses` is 2.2, not started) and not even locally, since
  4.4 has not landed and the overlay's confirm button still only dismisses. So a
  caregiver is escalated at dose time + delay for **every** occurrence of an
  escalation-enabled reminder, including ones the dependent confirmed on time.

  Shipped anyway, deliberately, because it is strictly better than the state it
  replaces on every axis that matters: before this, a caregiver who had once
  visited a dependent's medications screen kept **every** one of that dependent's
  alarms, firing at **dose time**, forever, with nothing ever reconciling them.
  Now they hold only the escalation-enabled subset, delayed. The desensitisation
  the plan warns about is reduced by this change, not introduced by it.

  It is still a real gap and it closes with 2.2 + 5.1, which is why §0.3 now names
  those as next. The seam is ready: `scheduleMedicationNotifications` already
  decides per reminder whether to schedule the caregiver's copy at all, so the
  confirmation check goes in that same branch.
- **⚠ `Math.max(NaN, 1)` is `NaN`, and it was one caller away from an alarm that
  silently never fires.** Found by the new `computeNextTriggerDate` tests, not by
  reading. `Math.max(frequencyDays, 1)` was the guard against a zero or missing
  frequency, but `Math.max` propagates NaN rather than clamping it, so a
  non-numeric frequency flowed into `setDate` and produced an **Invalid Date** —
  which is then handed to `scheduleNotificationAsync` as a trigger. Not reachable
  from either current caller (both do `parseInt(...) || 1` first), so this was a
  latent trap rather than a live defect, but it is precisely the silent-failure
  shape Phase 1 spent 18 items removing. Normalised inside the function, where a
  future caller cannot forget it.
- **Moving `computeNextTriggerDate` into `utils/date.ts` made it testable, and
  the finding above is the argument for the move.** It sat in
  `notification-helper.tsx`, which imports `expo-notifications` and so cannot be
  loaded outside a native runtime; `date.ts` has no imports at all, which is what
  lets `node --test` strip its types and run it. Same reasoning that split
  `notification-identifiers.ts` out in session 2. **A Windows caveat for whoever
  writes the next one:** a bare `D:/...` import specifier fails with
  `ERR_UNSUPPORTED_ESM_URL_SCHEME` — Node reads `d:` as a URL scheme. Use
  `file:///D:/...`.
- **⚠ `medication_reminders.user_id` is nullable, and a NULL-owner row is both
  invisible and undeletable.** Found by accident in session 3: a `POST` probe
  authenticated as a Cognito `sub` with no `users` row inserted successfully with
  `user_id: null` and returned 200. Two things make this worse than an untidy row.
  `getUserId` returns `undefined` for an unknown sub, and `checkAccess` then
  compares `undefined === undefined` and returns **true** — so the access check
  passes for a caller who is authenticated but has no profile. And every read and
  the delete are scoped `WHERE user_id = $n`, which never matches NULL, so the row
  cannot be seen by any `GET` or removed by the `DELETE` route. Only a reset
  clears it. The fix is `NOT NULL` on the column plus an explicit
  `if (!userId) → 404` before `checkAccess` (the same shape §0.6 already argues
  for on `/me`). Not actioned — it is a schema change plus a route guard, and
  `checkAccess`'s `undefined === undefined` hole reaches every route that calls
  it, so it wants doing deliberately rather than as a footnote to a deploy.
- **The §1 guardrail "do not run `/reset-db` or `/seed-data` against any deployed
  database" is superseded by D-11** and was contradicted by the owner's explicit
  instruction in session 3. Corrected in place; the guardrail now points at D-11
  rather than forbidding the thing D-11 requires. This was a genuine stall risk —
  a cold session following §1 literally would refuse the one action that fixes the
  live database.
- **`users.cognito_id` is a `uuid` column, so probe events need a well-formed
  UUID.** A synthetic `sub` of `"probe-no-such-user"` fails inside `getUserId`
  with `invalid input syntax for type uuid` and returns 500 — which looks exactly
  like the schema failure being probed for. Use
  `00000000-0000-0000-0000-000000000000`: it parses, matches no row, and reaches
  the statement under test.
- **`/me` returns 404, not 401,** when a Cognito user has no RDS row. The caller
  is authenticated; the profile just doesn't exist yet. 401 would invite a client
  to sign them out, which is the opposite of the intended recovery. Same for
  `/my-id` (1.9).
- **⚠ 4.7c's cancel was reminder-wide, so the morning alarm deleted the evening
  one — every day, on every twice-daily reminder.** Found in session 4 while
  reading the code 4.4 had to modify. `cancelAlarmBurst(reminderId, owner)`
  matched **every** pending alert on the reminder, but `rescheduleNextOccurrence`
  afterwards rewrote only the slot that fired. So an 08:00/20:00 reminder lost its
  20:00 alert at 08:00 and did not get it back until the next launch re-sync
  (4.1) — and a patient who does not open the app between breakfast and dinner
  simply misses the evening alarm.

  §0.6's earlier finding got the *ordering* right (cancel, then chain forward) and
  said nothing about scope, which is why this survived it. Fixed by giving
  `belongsToReminder` an optional `timeStr` and threading `data.timeStr` from
  `_layout.tsx`. Callers that genuinely mean the whole reminder — deleting it, or
  reconciling it from scratch — still omit it.

  **Neither unit tests nor a device would have caught this quickly.** The tests
  asserted `belongsToReminder` did exactly what it was written to do, and on a
  device the symptom is one missing alarm a day with the app repairing itself
  the moment you open it to investigate.
- **⚠ And the overlay's copy of that cancel deleted *tomorrow's* alarm, for the
  opposite reason.** Same session, same read. The overlay called
  `cancelAlarmBurst` on confirm and on snooze — but by then `_layout.tsx` has
  already cancelled today's remainder *and chained forward*, and because a burst
  member's identifier is the same string tomorrow as today, the identifiers the
  overlay cancelled were the next occurrence. Pressing **confirm** on a dose
  therefore deleted the reminder's next alarm.

  The same fact makes the overlay's scheduled-queue cancel pointless as well as
  harmful: the alerts it was written to stop were *replaced* by the chain-forward,
  not left pending. What is genuinely still there is the tray. So the overlay now
  calls `dismissPresentedAlarms`, which is the half that does something.

  Worth stating as a rule, since this is the second time identifier reuse has
  produced a bug nobody predicted: **any cancel that runs after the chain-forward
  is operating on the next occurrence, not this one.**
- **⚠ A queued dose action cannot simply be re-POSTed, and the plan's "retry on
  next sync" reads as though it can.** The immediate POST sends no timestamp
  deliberately — the server resolves the dose nearest to `now()`, which is right
  when the patient is standing in front of a ringing alarm. A replay is not: at
  15:00, "nearest to now" on an 08:00/20:00 reminder is the **evening** dose, so
  a naive retry confirms a dose nobody has taken and suppresses the escalation
  that exists to catch exactly that. Two hours of delay is enough to do it.

  Fixed without a server change or a device-side timezone computation: the entry
  records when the button was pressed, and the replay reads
  `GET /medication-doses` around that moment and posts back the exact
  `scheduled_for` string the server itself wrote. The route already accepted an
  explicit `scheduled_for` — 5.1 added it "for a caller that knows exactly which
  dose it means", and this is that caller, sooner than expected.

  Two further rules that follow and are easy to get wrong, both in
  `dose-queue-policy.ts`: **401 must be retryable** (it is the single most likely
  failure for a snooze pressed on a phone that has been asleep, and the next sync
  carries a fresh session) while 400/403/404/409 must not be (each is a correct,
  final answer, and retrying one is an infinite loop); and **a snooze expires far
  sooner than a confirm** — a confirm landing three days late still corrects the
  missed list, while a stale snooze only increments `snooze_count`, which D-12
  reads as evidence of repeated snoozing that never happened.
- **A snooze alarm needs an identifier outside the burst series, and reusing a
  burst index would have deleted tomorrow's alarm.** Same identifier-reuse fact
  as above: `med-7-12-0800-1` is tomorrow's first alert by the time snooze is
  pressed. Hence `snoozeIdentifierFor` and its non-numeric `-s` segment, which
  cannot collide at any `alarm_repeat_count`. It still parses as this reminder,
  owner and slot, so a delete or the next occurrence firing clears an unanswered
  snooze — but the **reconciliation pass had to be taught to leave it alone**
  (`preserveSnoozed`), because that pass rewrites the schedule from the server's
  reminder row and the row says nothing about a snooze. Without it, a patient who
  snoozed and then opened the app within ten minutes silently lost the alarm they
  had just asked for.
- **4.2 item 4's confirmed-dose check treats a snoozed dose as still escalatable,
  and that is deliberate.** D-6 says a snooze re-anchors the escalation clock
  rather than cancelling it, and D-12 caps how often. Honouring the re-anchor on
  the device would mean mirroring D-12's threshold there; 5.4 is where that
  belongs. So the device may alarm a caregiver during a dependent's snooze
  window. It errs toward notifying, which is the correct direction, but **5.4 and
  the device will disagree on snoozed doses until 5.4 lands** — worth knowing
  before reading a duplicate escalation as a bug.

  **Decided in session 5, when 5.4 landed: the disagreement stays.** 5.4 honours
  D-6's re-anchor and D-12's circuit breaker properly, in SQL, where both are
  testable — so the *server* is now correct and is the authority. Mirroring
  D-12's threshold onto the device would mean shipping the same constant twice
  and keeping two implementations of the same rule in step across a native
  rebuild cycle, to remove a duplicate notification that only occurs inside a
  snooze window and only when the caregiver's device is also awake. The cost is
  higher than the defect. **Revisit if a real caregiver reports the duplicate**,
  which is the signal that it happens often enough to matter; until then the
  device erring toward notifying is the right direction to fail in.
- **Node's type stripper needs `import type`, and a plain named import of an
  interface fails at load.** `import { DoseRow } from './doses.ts'` throws
  `SyntaxError: The requested module does not provide an export named 'DoseRow'`
  under `node --test`, because stripping types is not type-*aware* — it cannot
  know the name is erasable. The error names the export, which reads like a
  missing file rather than a syntax rule. Only bites the dependency-free modules
  §0.8 covers; Metro and tsc are both fine with either form. Whoever adds the
  next testable module: write `import type` for anything that is only a type.
- **⚠ `push_tokens` must be UNIQUE on `token` alone, and `(user_id, token)` — the
  more natural-looking constraint — is a disclosure bug.** 2.5's text says
  "unique on token" and it is worth knowing *why*, because the composite key is
  what a reviewer would reach for. **The token is the device address, not a fact
  about a user.** The same string arriving under a different account means the
  device changed hands — a reinstall, or a shared family tablet — and the row has
  to *move*. Under `(user_id, token)` it would duplicate instead, and the
  previous owner would go on receiving the new owner's notifications: in this app
  a dependent's unconfirmed-dose alerts arriving on a stranger's phone. Hence
  `ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id`, and a test
  asserting the composite form is *absent* rather than only that the single form
  is present.
- **`/push-tokens` deliberately ignores `?user_id` and calls no `checkAccess`,
  and it is the only route that does.** Every other route treats `user_id` as
  "whose data am I looking at". A push token is not data you look at — it is the
  device in your hand. A caregiver viewing a dependent's medications is still
  registering their *own* phone, so honouring the parameter would file the
  caregiver's device under the dependent and send the dependent's escalations to
  the person they were meant to escalate **to**. The asymmetry is load-bearing;
  a future pass making the routes uniform would silently invert D-1's escalation
  path. Tested by passing `?user_id=99` and asserting the caller's id is what
  gets written.
- **The registration is not queued for retry, unlike a dose action, and the
  distinction is worth keeping.** 4.4's queue exists because a dose action is a
  one-off event that is simply lost if it never lands. A token registration
  re-runs on the next sign-in and every launch after it, so the retry already
  exists and is free. Adding a queue would be machinery earning nothing.
- **`getPermissionsAsync()`'s result does not typecheck against `.status` in this
  SDK.** `NotificationPermissionsStatus extends PermissionResponse`, but tsc does
  not see the inherited fields — `Property 'status' does not exist`. `_layout.tsx`
  already casts on the request side for the same reason; `push-token.ts` now does
  too and checks `granted`, `status` and the bare string, because the runtime
  shape has varied across versions.
- **The retry queue re-reads storage before writing, and the reason is a real
  race rather than defensiveness.** A replay is several round trips long and the
  patient can answer an alarm in the middle of one — the launch re-sync and a
  ringing alarm overlap routinely. Writing back only the unprocessed batch would
  clobber whatever was queued during the flush, which is precisely the entry the
  queue exists to keep.
- **⚠ A VPC-attached Lambda in this account has no outbound internet, so 5.4
  cannot be the single Lambda §8 describes.** The two things the escalation job
  must reach are mutually exclusive as the VPC stands: RDS is private and
  `tish-rds-sg` admits 5432 from the Lambda security group only (D3/D3b), so
  reading `medication_doses` requires being inside the VPC — and `exp.host` is on
  the internet, which a VPC-attached function cannot reach. The subnets *look*
  like they have egress: they route `0.0.0.0/0` to an internet gateway. They do
  not, because **Lambda ENIs are never assigned public IPs**, and an IGW route
  without a public IP is a black hole. There is no NAT gateway and there are no
  interface endpoints.

  **Verified rather than reasoned about**, which matters because the routing
  table is genuinely misleading: one throwaway function, same code both times,
  aborted at a 6s timeout while VPC-attached and returned HTTP 200 from
  `exp.host` in 2.1s with the VPC detached.

  Resolved by the owner, 2026-07-31, choosing two Lambdas over a NAT gateway
  (~US$35–45/month): `tish-escalate-dispatch` is not VPC-attached and is the
  EventBridge target, and it drives the VPC-attached `tish-escalate-db` through
  the Lambda API. **That direction is the one that costs nothing** — a non-VPC
  function can call the Lambda API freely, whereas VPC → Lambda API would need an
  interface endpoint. Both are separate functions rather than routes on
  `index.mjs` so that the root `/{proxy+}` cannot reach them.

  **This constrains everything server-side that has to call out**, not just 5.4.
  5.9's silent push and 5.5's SNS call inherit it.
- **§8's escalation query selects on `escalated_at IS NULL`, and there is no such
  column.** 2.2 shipped `escalation_level` and `last_escalated_at` instead, which
  is strictly better — a two-rung ladder needs to know *which* rung, not merely
  whether it has fired — but the query as written in §8 does not run. The real
  stop condition is `escalation_level < 2`. Anyone implementing from §8 will hit
  this in the first five minutes.
- **⚠ §8's query has no upper bound on lateness, and without one the job's first
  act is to escalate a backlog.** Every unconfirmed dose already in the window
  becomes eligible on the same run, so deploying the feature is the loudest
  possible way to introduce it — and the same shape recurs after any outage.
  D-2 already says missed doses are never replayed; a dose nobody acted on
  yesterday is the missed list's job (D-4, 5.7), not an alarm's. Shipped as
  `ESCALATION_MAX_LATENESS_HOURS = 24`, chosen to sit above the worst-case
  rung-2 time of `2 × 240 + 2` minutes ≈ 8 hours so that a long configured delay
  does not silently lose its second rung.
- **`/reset-db` and `/seed-data` are not reachable through API Gateway** — they
  return the gateway's own `{"message":"Unauthorized"}` before the Lambda is
  entered. They are unauthenticated *in the Lambda* (P0.1), which is what the
  plan records, and that is a different thing from being exposed. Session 3 ran
  them without noting how. Use a direct `aws lambda invoke` with
  `{"path":"/reset-db","httpMethod":"GET"}`; `resolveRoutePath` reads `event.path`
  and the route sits above the auth guard, so no claims are needed. The same
  technique is how every probe in this session was run, and it is strictly better
  than going through the gateway: it needs no token and cannot be confused by a
  stage prefix.
- **The claim returns the level *after* the increment, and reading it as-is skips
  a rung.** `escalation_level = escalation_level + 1 ... RETURNING` means a dose
  stored at level 0 comes back as 1, so the rung being taken is at index
  `level - 1`. Off by one here is not a crash: it sends the second rung first,
  which today means substituting SMS-to-push and looking almost right. Asserted
  in `escalate.test.mjs` for that reason.
- **The server sends notification copy and has no locale to select it with.**
  `escalate.mjs` mirrors `notifications.doseEscalationTitle`/`Body` from the two
  locale files and defaults to zh-Hant. Reusing 4.2's existing wording avoided
  new keys, and that wording already names neither the medication nor the
  patient — correct for a push readable on a locked phone. But the duplication is
  real and the reason is structural: there is no `users.locale` column, for
  exactly the same reason there is no `users.timezone` one. **Both want the
  migration runner**, and whoever builds it should treat them as its first two
  customers rather than only `timezone`.
- **5.8's receipts poll needs somewhere to put ticket ids, and there isn't one.**
  Expo's tickets come back synchronously and its *receipts* are only available
  minutes later, so a single run cannot poll its own. Persisting the ids means a
  `push_tickets` table, which means another reset or the migration runner — so
  the poll is deliberately not built. **Ticket-level `DeviceNotRegistered`
  reaping does ship**, and that is the common case: an uninstalled app is usually
  reported immediately. What the missing poll costs is the delayed failures —
  a token that Expo accepts and only later finds undeliverable stays in
  `push_tokens` until it fails synchronously.
- **⚠ The Lambda execution role could only write logs for `operation-strix`, so
  the two new functions ran completely blind.** `logs:PutLogEvents` in the
  inline `CloudWatchLogsApEast2` policy was scoped to
  `log-group:/aws/lambda/operation-strix:*` — a single literal name, not a
  prefix — so `tish-escalate-db` and `tish-escalate-dispatch` could create a log
  group and then not write a single line to it. **The functions still ran and
  still returned correct results**, which is what makes this easy to miss: the
  only symptom is an absent log group, and nothing fails.

  That matters more here than it would elsewhere. D-8 *requires* the channel
  substitution to be logged rather than merely performed, and 5.4's whole job is
  to act unattended — a scheduled safety mechanism you cannot observe is one you
  cannot trust. Fixed by widening the resource list to the three function log
  groups by name (still not a wildcard). **Any fourth Lambda will hit this
  again**, so add it to that list rather than wondering why the logs are empty.
- **⚠ The dispatcher skipped its own summary log on empty runs, which is the
  wrong way round.** The `console.info('escalation run', ...)` sat after the
  dispatch loop, so a run that claimed nothing returned early and logged nothing
  at all. Since the job runs every five minutes and *usually* has nothing to do,
  that meant the overwhelming majority of runs were invisible — and a dead
  schedule looked exactly like a quiet one. For a mechanism whose correct
  behaviour is silence, "did it run?" is the only question the logs can answer.
  Now logged on both paths.

  Found by reading CloudWatch rather than by reasoning, and only reachable
  *because* the permission above was fixed first. Worth noting as a pair: the
  first bug hid the second.
- **⚠ `interruptionLevel` is spelled differently on the device and in Expo's push
  API, and the wrong one 400s the entire request.** 5.3 sets
  `interruptionLevel: 'timeSensitive'` through `expo-notifications` on the
  client, which is correct there. Expo's push HTTP API validates against
  `'active' | 'critical' | 'passive' | 'time-sensitive'` — **kebab-case** — and
  rejects `'timeSensitive'` for the whole batch, not just the offending message.
  Copying the known-good client value across is the obvious move and it is wrong.

  **Only a live send could have found this, and that is the point.** The unit
  tests mock `fetch`, so the suite was green while every real send failed with a
  400. The first live run reported `claimed: 1, pushed: 0` — the claim, the
  ladder and the database work were all correct and the last hop silently was
  not. There is now a test pinning the literal, which cannot catch a future
  change to Expo's enum but does stop someone "tidying" it back to match the
  client.

  Worth generalising, since it is the third time in this plan: **a mocked
  boundary asserts your assumptions about the other side, not the other side.**
  The materialisation bug in session 3 and this one have the same shape.
- **Expo's error response reports every parse it attempted, so the first message
  in it is usually not the problem.** The 400 above reads
  `["$": Expected object, received array, "0.interruptionLevel": Invalid enum
  value ...]` — the first clause looks like the request shape is wrong and sent
  the diagnosis off in the wrong direction. It is not: the API accepts a single
  object *or* an array, so it tries both and lists both failures. The real error
  is always the one naming a field.
- **Expo answers positionally and never names the token, so a length mismatch
  must reap nothing.** `tokensToReap` refuses to zip arrays of different lengths
  rather than pairing as far as it can, because the failure mode of the obvious
  implementation is deleting a *working* device's token because a different
  device was uninstalled — silent, and only visible as a caregiver who stops
  getting escalations. The credential errors (`InvalidCredentials`,
  `MismatchSenderId`) are deliberately not reapable for the same family of
  reason: they make every token look dead at once, and acting on them would empty
  `push_tokens` and force every user to reopen the app to recover.
- **⚠ 5.6's occurrence segment must be a *date*, not an index, and §0.3 asked for
  the index.** Both fix the collision §0.3 names — today's alert *n* and
  tomorrow's alert *n* being one identifier — but an index only fixes it *within
  one scheduling pass*. It is relative to when the pass ran, so `-o0` means today
  in this pass and tomorrow in the next, which is the same "one identifier, two
  alarms" fact one level up. It would have reappeared the first time two writers
  disagreed about which day was day zero, and the two writers exist: the
  reconciliation pass and the chain-forward.

  Shipped as `YYYYMMDD` in the device's local zone, hyphen-free because `-` is
  the segment separator. Three consequences worth knowing:

  - **Both writers became idempotent**, which is what let the chain-forward be a
    full rewrite rather than an append (below). Writing an occurrence that is
    already scheduled replaces it with an identical alert.
  - **The key comes from the occurrence's trigger, not from each burst member's
    own time.** A burst starting at 23:59:45 crosses midnight partway through,
    and members of one occurrence must share a key or an occurrence-scoped cancel
    clears half of it. There is a test that asserts the scenario actually crosses
    midnight, because the version that does not proves nothing.
  - **It is read in local time, not UTC.** In UTC+8 a 23:50 alarm and an 08:00
    one fall on different UTC dates, so a UTC key would file two slots of one
    reminder under different days.
- **⚠ The cancel-then-reschedule ordering has stopped being load-bearing, and
  leaving the old claim in place would have been worse than removing it.** §0.6's
  earlier finding — reschedule first and today's un-fired alerts are dragged into
  tomorrow — was true because the identifiers were shared. With an occurrence
  segment the cancel is scoped to the day that fired and the rewrite only writes
  days after it, so the two touch disjoint identifiers and either order works.

  `_layout.tsx` still sequences them, for one narrow reason that is now the whole
  justification: an alarm scheduled by a build from **before** 5.6 carries no
  occurrence key, so its cancel is still reminder-and-slot-wide and would eat a
  horizon written first. Such an alarm also chains only one occurrence forward,
  collapsing its slot's horizon to a day — self-repairing, because the listener
  that runs it only fires when the app is running, and the app re-syncs at launch.
- **⚠ The budget is device-wide and `syncFor` is called with one owner, which
  §0.3 step 1 half-anticipated.** Step 1 correctly said the plan must be computed
  in `use-notification-sync`, where the full set is known — but that is only true
  of `syncOwners`, the launch path. `medications.tsx` calls `syncFor` for a single
  owner on every screen focus, and on a caregiver's device budgeting a dependent's
  reminders as though they were alone on the phone is how you overrun the 64-slot
  cap without noticing.

  Resolved with a module-level map of per-owner costs, so a single-owner pass
  still budgets against the whole device. Two properties make it safe: entries for
  owners not in this pass are stale only in the *cost* dimension, which changes
  when a reminder is edited rather than minute to minute; and the direction of
  error is conservative, because a reminder that has since been deleted still
  counts and therefore shortens the horizon. **Nothing clears it on sign-out,
  deliberately** — signing out does not cancel the alarms already on the device,
  so those slots really are still consumed.
- **Three callers schedule a single reminder and none of them can compute a
  budget**, which §0.3's "pass `daysAhead` down through `ScheduleOptions`" does
  not cover. The form's optimistic save, the medications screen's status toggle,
  and the profile screen's meal-time regeneration each call
  `scheduleMedicationNotifications` for one reminder after a user action, and
  each begins by cancelling that reminder's alarms. Falling back to one occurrence
  would therefore have *collapsed* a reminder's horizon every time someone toggled
  it — 5.6's own invisible degradation, arriving through 5.6's own machinery, and
  lasting until the next launch because the toggle does not re-sync.

  Resolved by remembering the last plan (`rememberBudgetPlan`) rather than
  threading it through every call site, which no call site could supply anyway.
  It is mildly stale by construction — a reminder that has just been activated was
  not in the set the plan was costed against — and that is bounded and
  self-correcting.
- **The chain-forward rewrites the whole forward horizon rather than appending
  one day, and §0.3 step 4 asked for that decision.** Appending is the obvious
  top-up and it is wrong in the case that matters: if the app has not run for
  three days, those occurrences fired and are gone, so appending a single far-end
  day leaves the gap in the middle. The rewrite covers the whole forward window
  and is idempotent, so it repairs the gap. It costs up to `horizon × burst`
  scheduling calls per dose, once, because the first burst member's arrival
  cancels the rest.
- **⚠ The session-5 handoff got the commit facts wrong in two ways, and both
  would send a session looking for something that is not there.** It said the work
  was "committed on `reminder-delivery-phases-1-5` (`e7c3cf1`), *not* merged to
  `main`". There is no such branch — `git branch -a` lists only `main` and
  `origin/main` — and the work is on `main` as **two** commits, `e7c3cf1` and
  `a1454c8` (5.6's policy half plus the handoff itself), not one. "Nothing has
  been pushed" was right: `main` is 4 ahead of `origin/main`.

  Not a code problem, but the same class as the stale-plan entries this section
  exists for: §0.4 simultaneously said "nothing is committed", three sections
  below §0.3 saying it was. **`git log --oneline -3` costs nothing; a handoff's
  claim about the repo is worth exactly as much as `tish-migrate status` is worth
  against a claim about the database.**
- **⚠ 5.9 cannot send on the write, and §8 assumes it can.** "Any write to a
  reminder sends a data-only push" describes `index.mjs` calling Expo. That
  function is VPC-attached because RDS is private, and a VPC-attached function in
  this account has **no outbound anything** — not `exp.host`, and not the Lambda
  API either, so it cannot even ask the non-VPC dispatcher to send on its behalf.
  §0.6 recorded the same constraint for 5.4 and predicted it would reach 5.9;
  this is that prediction landing.

  **Verified in one command rather than reasoned about**, which is worth noting
  because the earlier finding needed a throwaway Lambda to prove:
  `aws ec2 describe-vpc-endpoints` and `describe-nat-gateways` both return `[]`
  in `ap-east-2`. If either ever stops being empty, this constraint has changed.

  Resolved with an outbox table drained by the dispatcher. **Two things that
  makes better than the direct send, rather than merely possible:** a send that
  fails because Expo is unreachable is retried instead of lost, and several edits
  in a minute coalesce into one push per device — which matters, because iOS
  rate-limits silent pushes and the naive version would send four.

  The cost is latency, and it was bought back by tightening the EventBridge rate
  to one minute. **The upgrade path, if sub-second ever matters:** a Lambda
  interface endpoint (~US$8/month, much cheaper than the NAT gateway the owner
  declined for 5.4) would let the write path nudge the dispatcher directly. The
  outbox stays either way — it is the durability, not the transport.
- **⚠ The dispatcher's empty-claims early return would have silently disabled
  5.9.** `dispatchHandler` returned as soon as there were no doses to escalate,
  which is the overwhelming majority of runs, and both the outbox drain and the
  receipts poll are steps after it. The feature would have worked *only on runs
  that happened to be escalating something* — that is, almost never, and
  non-deterministically, which is the worst possible way to fail.

  Restructured into three isolated steps, each in its own try/catch. **The
  isolation is the point, not the tidiness**: 5.4 is a safety mechanism and 5.9
  is an optimisation, and neither must be able to take the other down. There is a
  test named `THE REGRESSION` for the early return specifically.
- **5.9's recipients are the owner's devices *and* their active caregivers', one
  step wider than §8.** §8 says "the owner's devices". Under 4.2 item 2 a
  caregiver's phone holds escalation copies of every escalation-enabled reminder
  their dependent has, and those copies go stale on exactly the edit that
  enqueued the row — so the owner-only reading would leave the one
  server-to-device channel in the system reaching half the devices that hold the
  schedule.

  Resolved at **drain** time rather than enqueue time, which is what makes a
  relationship created between the write and the drain honoured, and a **revoked**
  one correctly not: the recipient query filters `status = 'active'`. Worth
  knowing before 3.2 lands, because it means revocation already stops the silent
  push without any extra work — and equally that it does *nothing* about the
  alarms already sitting on the revoked caregiver's device.
- **⚠ `Number(null)` is 0, and it passes `Number.isInteger`.** The obvious
  sanitiser for a list of ids arriving over an untrusted Lambda payload —
  `.map(Number).filter(Number.isInteger)` — turns `null` into a request to update
  row 0, and `''` likewise. Harmless against a SERIAL column that starts at 1,
  and exactly the class of quiet coercion this plan keeps finding the hard way
  (`Math.max(NaN, 1)` is the same shape). Check the type before coercing, not
  after. Found by a test asserting nothing reached the database.
- **⚠ A `);` inside a SQL comment truncates the `SCHEMA_SQL` parity check, and the
  failure names the wrong problem.** `migrate.test.mjs` extracts a table block
  with a non-greedy match up to the first close-paren-semicolon, so a comment
  containing one — `-- 'dose-escalation' (5.4) or 'schedule-changed' (5.9);` —
  ends the block early and every column below it is reported as **missing from
  `SCHEMA_SQL`**, which is not what is wrong. Cost two attempts in session 7, the
  second being the comment written to warn about the first. Either avoid the
  sequence in comments or strip comments before extracting; the current code does
  the former and says so at the site.

### 0.7 — Blocked on you

1. **✅ RESOLVED, session 3 (2026-07-31) — nothing here is outstanding.** The
   backend was deployed and the database rebuilt with `/reset-db` + `/seed-data`
   under D-11, which supersedes running 001 and 002: the recreated tables already
   carry every column both migrations add, plus `alarm_labels`, which no migration
   ever added and which was the actual cause. `POST`/`PUT /medication-reminders`,
   the status toggle and `/meal-times` all work; see the probe table in §0.4.

   The VPC-attached-runner problem below therefore never had to be solved. It
   still stands as the answer if a migration ever has to be applied to a database
   whose data must survive — which is the moment D-11 stops holding. **Kept as
   context; do not action it as a to-do.** The original text follows.

   ---

   **⚠ `medication_reminders` is behind the code and migrations alone won't fix
   it.** Verified by probing the deployed Lambda, 2026-07-30:

   | Probe | Result | Conclusion |
   |---|---|---|
   | `GET /meal-times`, nonexistent user | 404 "User not found" | **migration 001's `users` columns ARE applied** |
   | live `users` column list via `/debug/users` | 15 columns incl. all four meal times | confirms the above |
   | `PUT /medication-reminders` | 500 `column "alarm_labels" does not exist` | table is missing a **base-schema** column |
   | `PUT` with `alarm_repeat_count: 99` | 500, not 400 | 4.6 is not deployed (expected — written after the 11:45 deploy) |

   So: 001's `users` half is applied; `alarm_sources` and all of 002 are **unknown**
   because Postgres reports only the first unresolved column; and
   `alarm_labels` — which no migration adds — is missing, so reminder create and
   edit stay broken after 001 and 002 run. See the drift finding in §0.6.

   Everything named below still holds for the `users`-side routes, and the
   `medication_reminders` ones now have a second cause:

   | Route | Column | Effect right now |
   |---|---|---|
   | `POST /medication-reminders` | `alarm_sources` in the INSERT | every new reminder 500s |
   | `PUT /medication-reminders` | `alarm_sources` in the UPDATE | every edit **and every status toggle** 500s |
   | `GET`/`PUT /meal-times` | four `users` TIME columns | 500s |

   `toggleStatus` on the medications screen is a PUT, so the active/inactive
   switch is broken until this runs.

   **Only Taipei needs it.** `season1` in `ap-east-2` is the live database (Track
   C4 done, all five integrations repointed). Sydney is still up for build-7
   users but runs the *old* Lambda code, which doesn't reference these columns —
   so it does not need 001 unless it is ever repointed at current code, which
   C5 is decommissioning it instead.

   **This cannot be run from a dev machine, by design.** RDS is private and
   `tish-rds-sg` allows 5432 from the Lambda SG only — that is D3/D3b, which
   were deliberately closed. So it needs to run from inside the VPC: a
   throwaway VPC-attached Lambda using the same security group is the cleanest
   route. Do **not** solve it by adding a migration route to the API — that
   recreates the P0.1 class of problem. `npm run migrate:dry-run` first.

   The owner has AWS CLI access via the `aws login` browser flow, and **that
   session expires often** — check `aws sts get-caller-identity` before planning
   any AWS work and ask them to re-login if it has lapsed, rather than working
   around it. Credentials alone are not enough here anyway: they unblock creating
   the VPC-attached runner, not running `migrate.mjs` locally.

   **Migration `002` is now waiting too** (2.4 + 2.6). It is additive and no
   deployed route touches its columns, so unlike 001 it breaks nothing while
   unapplied — but it must be applied **before 4.6's API changes are deployed**,
   or `POST`/`PUT /medication-reminders` breaks exactly the way 001 just did.
   Apply both in one pass.
2. **✅ RESOLVED, session 5 (2026-07-31) — nothing here is outstanding.** The
   owner chose `/reset-db` + `/seed-data`. The Lambda was deployed first (the
   reset executes `SCHEMA_SQL` *from the deployed code*, so the ordering is
   forced, not stylistic), then the reset and seed were run by direct
   `aws lambda invoke` — see §0.6 on why the gateway refuses them.

   All four preserved tables came through: `users` (2), `genders` (4),
   `conditions` (4) and `user_relationships` (1, still caregiver 1 → dependent
   2). `push_tokens` exists and `POST`/`DELETE /push-tokens` were exercised
   against it end to end; the probe table in §0.4 has the results.

   **The fixture was recreated escalation-enabled rather than as it was.**
   Reminder 1 came back with the same id and the same 200mg 08:00/20:00 daily
   shape, but with `escalation_enabled: true` — the old row had it false, so 5.4
   could not have been tested against it and it would have needed a write either
   way.

   **Kept as context; do not action it as a to-do.** The original text follows.

   ---

   **⚠ `push_tokens` has to reach the live database, and how is your call.** The
   table exists in `SCHEMA_SQL` and as migration `004`; the route and the client
   are written and tested. Nothing is live.

   **The ordering risk is contained, unlike the `alarm_labels` incident.** That
   one broke two pre-existing write paths because deployed code referenced a
   column that was not there. Here, `push_tokens` is referenced by exactly one
   new route and nothing else, so **deploying the Lambda before the table exists
   breaks only `POST /push-tokens`** — every other route is untouched. The
   client swallows that failure by design (see `utils/push-token.ts`), so the
   visible symptom is push simply not working yet. Deploy-then-create is
   therefore safe here, which is *not* the general rule.

   Three ways to create it, and they are not equally priced:

   | Option | Cost | Notes |
   |---|---|---|
   | **`/reset-db` + `/seed-data`** | Loses `medication_reminders` and `medication_doses` | Recommended. D-11 sanctions it, and the fixture is now cheap: one `POST /medication-reminders` recreates reminder 1, and its doses materialise automatically. `users`, `genders`, `conditions` and `user_relationships` all survive, so the caregiver link is kept. |
   | **Build the VPC-attached migration runner** | Half a day | The answer §0.7 item 1 always pointed at. It is genuinely owed — `users.timezone` (§0.6) cannot be added any other way, and that is the next schema change that will need it. Worth doing deliberately rather than under time pressure for a table a reset creates for free. |
   | **A migration route on the API** | — | **Do not.** Recreates the P0.1 class of problem. |

   The fixture in §0.4 is the only thing a reset costs, and session 3's note to
   leave it was written when it was the only way to test 4.4 and 5.7 — both of
   which are now built. Recreating it is one API call.

2b. **⚠ THE NATIVE REBUILD IS NOW THE SINGLE LARGEST THING OWED, AND IT IS
   YOURS TO TRIGGER.** It has not been made since the `app.json` plugin changes,
   and eleven separate pieces of work are waiting on it — every one of them
   built, tested and unverifiable without it:

   | Waiting on the rebuild | Item |
   |---|---|
   | The three alarm sounds | 4.7a |
   | The alarm burst firing as a burst | 4.7b |
   | Android channel audibility (alarm stream) | 4.7e |
   | Android exact alarms | 5.2 |
   | The iOS time-sensitive interruption level | 5.3 |
   | The snooze alarm actually firing | 4.4 |
   | Tray dismissal on response | 4.7c |
   | Push token registration on a real device | 5.8 |
   | 5.4's last hop — Expo to a physical phone | 5.4 |
   | **5.6's entire seven-day horizon** | 5.6 |
   | **5.9's silent push, which needs `UIBackgroundModes`** | 5.9 |

   The last two are new since session 5 and are the biggest: 5.6 has never had a
   single alarm accepted by an OS under its new identifier scheme, and 5.9's iOS
   half literally cannot work until the background mode is in a built app.

   **Session 10 is scheduled for this** (see the directive in §0.3). It cannot
   start until the build exists.

3. **4.7a needs a native rebuild**, not an EAS update — a config plugin changes
   the native project. Sounds can only be confirmed on a physical device.
4. **P0.2** (Apple Critical Alerts entitlement) is unfiled and **no longer blocks
   anything** — owner's instruction, 2026-07-31. 5.3 shipped `timeSensitive`,
   which needs no approval and covers Focus modes; the entitlement would add
   ring-silent and Do Not Disturb on top. If it is ever granted, the client change
   is `CRITICAL_ALERTS_ENTITLED` in `constants/config.ts`, the entitlement in
   `app.json`, and a build. Do not set that flag before the entitlement is really
   in the provisioning profile — see 5.3 for why it costs more than it gains.
5. **`USE_EXACT_ALARM` needs a Play Console declaration** before Android ships —
   not blocking now (there is no Android submit config in `eas.json`, so no
   listing exists), but decide it deliberately rather than at submission. P0.3
   decision 5 has the policy language and the fallback if it is refused.
6. **✅ SATISFIED — 4.7e landed in session 2, before any native build was made.**
   The constraint was that Android channel settings are frozen at creation, so
   audibility changes are free before a build ships and awkward afterwards. It
   landed inside that window and no build has been made since, so nothing is
   owed. Kept only so a cold session does not re-derive the constraint and think
   it is outstanding.

### 0.8 — Deliberately not done

- ~~**3.1**~~ — **resolved 2026-07-30: the owner chose to action it in this plan**
  as functional correctness, on the grounds that it is one file that is already
  dirty and already awaiting a manual deploy, so it costs no extra deploy. Done in
  session 2; see the ledger. Note it stays *dependent-only* on both branches — a
  caregiver withdrawing their own request is 3.2's revocation route, not this.
- ~~**Client-side unit tests.**~~ **DONE — session 3, 2026-07-31, at the owner's
  request.** `tish-app` now has `npm test` (`node --test "utils/*.test.ts"`),
  **52 tests in the repo**, and a `client-utils` job in
  `.github/workflows/test.yml`. The estimate of ~1h and the diagnosis of the
  single obstacle both held: `meal-alarms.ts` importing `./date` without an
  extension was the whole blocker, and it needed `allowImportingTsExtensions` in
  `tsconfig.json` alongside the extension itself, because tsc rejects the form
  Node requires. Safe here — nothing in this project emits through tsc; Metro
  builds, and the only tsc invocation is `--noEmit`.

  What is covered, at **183** as of session 6: `utils/date.ts` (20),
  `utils/notification-identifiers.ts` (48), `utils/meal-alarms.ts` (19 — session
  1's 14 were lost with their scratchpad and were rewritten, not recovered),
  `utils/dose-queue-policy.ts` (22) and `utils/doses.ts` (13) from session 4,
  `utils/notification-budget.ts` (38) from sessions 5 and 6, and
  `utils/alarm-schedule.ts` (25) from session 6.

  **`utils/alarm-schedule.ts` exists because of this constraint**, in the same
  way session 4's two modules did. The layout of a reminder's horizon — which
  identifier each alert is written under — was going to live inside
  `notification-helper`, which imports `expo-notifications` and therefore cannot
  be tested at all. Splitting it out is what makes eight separate assertions
  possible about a rule that has already produced three unpredicted bugs (§0.6)
  and whose every failure is silent: scheduling onto an existing identifier
  replaces it without an error, and iOS discards an over-budget queue without one
  either.

  **Session 4's two new modules exist in this shape because of this
  constraint, not in spite of it.** The retry queue and the dose reader both
  needed AsyncStorage and the API client, which cannot load outside a native
  runtime — so each was split into a dependency-free half holding the decisions
  and an I/O half holding nothing else. Every rule in the pure halves fails
  *silently* in production: a queue that drops an entry loses a confirmation
  without saying so, and one that keeps an entry too long eventually records the
  wrong dose. That is the argument for the split, and it is the same one that
  moved `computeNextTriggerDate` into `date.ts`.

  One mechanical trap that comes with it: **a type imported by name must use
  `import type`** or Node's stripper fails at load. See §0.6.

  **What this deliberately does not cover, so nobody reads "the client has
  tests" too broadly.** Only dependency-free modules can be reached this way.
  Anything importing `expo-notifications`, `react-native` or AsyncStorage —
  `notification-helper.tsx`, the overlay, the hooks — needs jest + jest-expo,
  which is a much larger commitment: new dev dependencies, a mocking layer, and
  a jest-expo version pinned to the SDK, so it becomes another thing to carry
  through every SDK bump. Nothing here forecloses that; it can be added later
  alongside this rather than instead of it.

  The three modules that *are* covered are the ones that decide **when a
  medication alarm fires**, which is why `computeNextTriggerDate` was moved into
  `date.ts` in the first place.

  Two things verified beyond the suite passing, because both were real risks of
  the change rather than hypotheticals: `npx tsc --noEmit` stays clean and
  eslint stays at exactly its 41 pre-existing warnings with no new ones from the
  test files; and **the app still bundles** — `expo start --web` builds 1898
  modules with no resolution error and renders the login screen with an empty
  console, which is the check that matters, since Metro had to accept the
  explicit `.ts` extension too.
- **Component and hook tests** remain not done — see the jest-expo note above.

---

## 1. Orientation

### Repo layout

| Path | What it is |
|---|---|
| `tish-app/` | Expo / React Native app (iOS, Android, web). Expo SDK 55, expo-router. |
| `tish-app/backend/index.mjs` | The app's entire API — a single-file Lambda behind API Gateway REST (`TISCv1`, `ap-east-2`), routed via `/{proxy+}`. |
| `tish-app/backend/index.test.mjs` | Functional tests for the above. Real handler, scripted pool via the `_setPoolForTests` seam. |
| `dashboard/` | Vite + React admin dashboard (separate Cognito pool). |
| `dashboard/server/index.mjs` | Admin API Lambda, HTTP API payload v2. **Better-engineered than the app backend — use it as the reference for error shape, numeric casts, and route matching.** |
| `MIGRATION.md` | Infrastructure migration plan and known-issues log (Track D). |

### Commands

```bash
cd tish-app/backend && npm test     # node --test, no DB needed
```

```bash
cd dashboard/server && npm test
```

CI runs the Lambda tests on push (`.github/workflows/test.yml`).

### Deploy reality — read before planning any backend change

- **Backend deploys are manual.** `.github/workflows/deploy-backend.yml` assumes
  a GitHub OIDC role that does not exist in the account (`MIGRATION.md` D0), so
  it fails at the credentials step. Lambda updates are done by hand.
- **A deploy is one zip and *three* `update-function-code` calls**, since session
  5. `operation-strix`, `tish-escalate-db` and `tish-escalate-dispatch` all run
  from the same artifact and differ only by handler. **Updating one and not the
  others is the failure mode to watch**: the two escalation halves talk to each
  other over a private `{op}` protocol, and a half-deploy leaves them disagreeing
  about it with no error until the next scheduled run does the wrong thing.
  Verify by checking all three report the same `CodeSha256` as the uploaded zip.

  The build itself, which has bitten more than one session:

  1. Stage `index.mjs`, `escalate.mjs`, `escalation-policy.mjs`, `package.json`
     and `package-lock.json` into a scratch directory — **resolved to its long
     path first.** The `SEMAPH~1` 8.3 short form mangles every entry in the zip.
  2. `npm ci --omit=dev` there. The `--omit=dev` is load-bearing: it keeps
     `@aws-sdk/client-lambda` out of the artifact, which the runtime supplies.
  3. Zip those plus `node_modules` **with forward-slash entry paths**. There is
     no `zip` binary on this machine and PowerShell's `Compress-Archive` writes
     backslashes, which Lambda cannot read — build it with
     `System.IO.Compression.ZipFile` and set each entry name explicitly.
  4. `aws lambda update-function-code` for each of the three.
- **The data plane is mid-migration to `ap-east-2`** (`MIGRATION.md` Track C).
  Schema changes made before the RDS snapshot must be re-applied after it.
- **Build 8 is in TestFlight** (commit `a6fd0c1`). Client changes need a new
  build. Do not delete the Sydney Lambda Function URL — build 7 users still call
  it (`MIGRATION.md` D1).

### Testing against the deployed environment is fine

**Confirmed by the project owner, 2026-07-30.** The deployed stack is not truly
live: the only accounts on it are the owner's and one beta tester's. So wherever
a change can only really be confirmed against the real thing — sending a Cognito
password-reset code, exercising SMS or email delivery, calling the deployed API
Gateway, running a migration against RDS — **do that rather than stopping at
"verified as far as is possible locally."**

This is a deliberate relaxation of the usual caution about side effects on real
users, and it is specific to this project at this stage. It does **not** extend
to the destructive routes below, which would still cost real data.

Revisit this the moment the tester base grows beyond people who have agreed to
be experimented on.

### Guardrails

- Do not commit or push unless explicitly asked.

> **⚠ Read this before deciding something is too risky to do against live.**
> **Act freely against the deployed stack.** `ALTER TABLE` on a live table,
> `/reset-db` + `/seed-data`, deploying Lambdas, running migrations, creating and
> deleting fixture rows — all of it is fine and none of it needs permission.
> **Anything other than signing up new users is negligible** until the security
> refactor is finished. Owner's instruction, 2026-07-31, and the *third* time it
> has been given in three framings — each time prompted by a session being too
> cautious with something live.
>
> **This has cost real time, which is why it is at the top of the guardrails
> rather than buried in D-11.** Several items in this document were designed
> around a constraint that was never real: `APP_TIMEZONE` existed as a constant
> for two sessions because "`users` can't pick up a column", the migration runner
> was deferred four times, and §0.6 records two bugs — 5.1's non-idempotent
> lookup and 5.4's Expo casing — that green test suites could not see and one
> live request found immediately. **Stopping at "verified as far as is possible
> locally" is the habit to break.**
>
> The one genuinely expensive thing is a lost account: profiles key on the
> Cognito `sub`, so dropping a `users` row strands a working login. That is what
> `RESET_PRESERVED_TABLES` protects, and it is the whole of the exception.
>
> Time-limited by its own terms — revisit before any real patient exists.

- `/reset-db` and `/seed-data` **are** run against the deployed database, under
  **D-11**. The reset preserves `users`, `genders`, `conditions` and
  `user_relationships`. This reverses the original guardrail here, which predates
  D-11.
- **A schema change no longer needs a reset.** `tish-migrate` is the VPC-attached
  runner (session 5): add a numbered `.sql`, mirror it into `SCHEMA_SQL`, invoke
  `{"command":"up"}`. Check `{"command":"status"}` before believing any claim in
  this document about what is applied — `schema_migrations` survives a reset by
  omission, so its history is older than you expect.
- **`/debug/*` may be widened freely — add the table and move on.** Owner's
  instruction, 2026-07-31, given after session 7 declined to add the push tables
  to `allowedTables` and was told that was overthinking it. The whole surface is
  unauthenticated by deliberate choice and belongs to the security refactor **as
  a unit**; keeping individual tables out of the list buys nothing while the
  other thirteen are in, and it costs exactly the observability the dump exists
  to provide. This is the same failure mode as §1's first guardrail: a session
  being cautious with something the owner has already priced.

  It is *not* how you reach `/reset-db` — the gateway refuses that; use a direct
  `aws lambda invoke`.
- Do not add credentials or fallback secrets to source. Both Lambdas read
  everything from env vars by design, and the files carry comments saying so.
- `tish-app/key.p8` is an Apple auth key. It is correctly gitignored and
  untracked — leave it that way.
- Locale files (`tish-app/locales/en.json`, `zh-Hant.json`) are parity-checked in
  CI. Any new user-facing string needs a key in **both**.

---

## 2. Decisions already made

Recorded so a fresh session doesn't re-open them.

**D-1 — A caregiver's phone should alarm for a dependent's dose when available.**
Confirmed by the project owner. This is a redundancy mechanism: single-device
notification delivery cannot be guaranteed by either mobile platform, and the
caregiver relationship provides a second device and a second person with
independent failure modes. Consequences are worked into items 4.2, 4.3, 5.4 and
5.6 below.

**D-2 — Missed doses are never replayed.** The scheduler only computes
occurrences forward from now (`computeNextTriggerDate` with `isFirstSchedule`,
`notification-helper.tsx:41`). A phone that was off all day comes back with its
next alarm in the future and no backlog. The take-late-versus-skip rule is
drug-specific and needs clinical input the software does not have, so it does
not guess. Keep this property when changing the scheduler.

**D-3 — Escalation is configured per medication: an on/off toggle and a
delay.** Not a global constant. A morning vitamin and an insulin dose do not
warrant the same urgency, so each reminder carries `escalation_enabled` and
`escalation_delay_minutes`. Both the device-local caregiver alarm (4.2) and the
server-side job (5.4) read these rather than a hardcoded value. Schema in 2.4,
wiring and UI in 4.6.

Two defaults that must differ, and are easy to get wrong:

- **Column default `false`.** The migration must not retroactively switch
  escalation on for every reminder that already exists — that would page
  caregivers about historical doses the moment the feature ships.
- **Form default on.** New reminders created through the app should opt in, with
  a sensible starting delay (30 minutes is a reasonable first guess), because a
  safety net nobody enables isn't one.

**D-4 — Missed doses are surfaced as an in-app list.** D-2 means a missed dose is
never fired late, which is safe but currently leaves no trace at all. A passive
list ("yesterday's 8pm dose was not confirmed") is a different thing from an
alarm and does not conflict with D-2.

This has a consequence that reaches further than the UI, and it was under-
specified in the first draft of this plan: **a missed dose can only be shown if
the expected dose exists as a record.** Confirmations alone are not enough —
absence of a confirmation row is indistinguishable from a dose that was never
scheduled. So `medication_doses` rows must be **materialised when a dose is
scheduled, not when it is confirmed**. See 5.1.

The same requirement already sat implicitly under 5.4: the escalation query
selects doses "with no `confirmed_at`", which only works if unconfirmed rows
exist. Materialisation is therefore a shared prerequisite for both the missed
list and escalation, not a feature of either.

**D-5 — Push is used for two things, and deliberately not for a third.**

- **Yes: silent push to the patient's device when their schedule changes.**
  Triggered by any write to a reminder. The device re-syncs on receipt, which
  collapses the staleness window from "whenever the app is next opened" to
  seconds. This is the only mechanism in the system that lets the server reach a
  device at all, and it is what finally makes a caregiver's edit propagate.
- **Yes: push to the caregiver when the patient hasn't responded** to the initial
  reminder after `escalation_delay_minutes` (D-3).
- **No: push to the patient as a reminder or backup alarm.** Considered and
  declined. Local notifications remain the patient's only alarm channel. *Do not
  add this without revisiting the decision* — a future session looking at the
  delivery-reliability problem will find it an obvious gap, and it was a choice.

**D-6 — "Responded" includes snoozing, not just confirming.** A snooze means the
patient is awake and aware, so it must not be treated the same as silence. It
**re-anchors the escalation clock**: snoozing at 08:05 with a 30-minute delay
moves the caregiver escalation to 08:15 + 30 minutes (the new alarm time plus
the delay), rather than firing at 08:30 as originally scheduled.

Consequence for the schema: escalation anchors on
`COALESCE(snoozed_until, scheduled_for)`, not on `scheduled_for`. See 2.2.

**D-7 — Both the patient and their caregiver may change escalation settings, for
now.** Explicitly provisional. It means a patient can switch off the safety net
that exists to protect them, and a caregiver can switch off one the patient
wanted. Accepted for the current stage. When revisited, the likely first step is
visibility rather than restriction — making a change by either party apparent to
the other — rather than locking one side out.

**D-8 — Escalation order is configurable per medication: SMS to the patient
first, or the caregiver first.** Both rungs still fire if the patient stays
unresponsive; the setting decides which comes first. Step 1 fires at
`escalation_delay_minutes` after the anchor (D-6); step 2 one further
`escalation_delay_minutes` later, if there is still no confirmation or snooze.

**This amends D-5, and the distinction matters.** D-5 declined a push *reminder
to the patient at dose time* — a second alarm competing with the local one. An
SMS sent only after the patient has failed to respond is a different mechanism
with a different trigger, and is in scope. Do not read D-8 as reopening the
backup-alarm question.

Two constraints that fall out of this:

- **SMS to a patient requires a verified number.** While
  `SMS_VERIFICATION_ENABLED` is false, `phone_number` is written to RDS but never
  verified through Cognito (see `constants/config.ts`), so the number on file is
  unconfirmed. Texting medication reminders to an unverified number risks sending
  PHI to a stranger. `sms_first` must not be selectable until Track B lands and
  numbers are verified.
- **A configured channel that can't send must fall through, not fail silently.**
  If SMS is chosen while SNS is still sandboxed, the escalation must fall back to
  the caregiver rather than doing nothing. A safety net that a configuration
  setting can quietly disable is worse than no setting at all.

**D-9 — Audibility comes from a configurable burst of consecutive notifications,
and any response cancels the rest of the burst.**

Context, because this is easy to get wrong twice. The app has **two unrelated
sound paths**. The notification's own sound is played by the OS on delivery and
**does not loop on either platform**. The looping audio in `AlarmOverlay` is
played by `expo-audio` and only runs while the overlay is on screen — which
requires the app to be foregrounded, or the user to have tapped through. With the
app closed, a dose reminder is currently one short chime and a banner. It is not
an alarm, despite the overlay being built like one.

iOS offers no way to loop a local notification. The workaround, which is what
alarm apps do, is to schedule several consecutive notifications each carrying a
sound of up to 30 seconds — iOS silently falls back to the default for anything
longer — spaced so the audio runs continuously.

- **Configurable per medication**: `alarm_repeat_count`, how many consecutive
  30-second alerts one dose schedules. Default 3, bounded 1–6. This multiplies
  directly against the iOS pending-notification cap; see 5.6.
- **Any response cancels the remainder.** Confirming, snoozing, or merely opening
  the notification must clear the rest of the burst. This has **two distinct
  halves**, and missing either leaves the patient being chimed at after they have
  already acted: alerts not yet fired are removed with
  `cancelScheduledNotificationAsync`, while alerts that *have* fired are sitting
  in the tray and need `dismissNotificationAsync`. Separate APIs over separate
  queues.
- **Android may not need the burst** if a full-screen intent lands (P0.3), since
  that launches an activity which can loop audio directly. Treat the burst as
  primarily an iOS mechanism and let the platform decide whether to use it.

**D-11 — While the project is internal-testing only, application data is
disposable and the fix for schema drift is to rebuild, not to reconcile.**
Owner's decision, 2026-07-30, prompted by discovering that `medication_reminders`
was missing a base-schema column that no migration adds (§0.6).

- **`users` is the exception, and so are `genders` and `conditions`.** Accounts are
  Cognito-backed and profiles key on the Cognito `sub`, so dropping a profile row
  strands a login that still works. `genders` and `conditions` are preserved not
  for their contents but because `users` has foreign keys to them, and
  `DROP TABLE ... CASCADE` on a referenced table *drops the referencing constraint
  instead of refusing*. Recreating the table does not bring it back, so one reset
  would silently leave `users.gender_id` unconstrained and the next would renumber
  the lookup rows underneath the values still stored in `users`.
- `SCHEMA_SQL` is now assembled from a per-table list, and `/reset-db` runs a
  derived `RESET_SQL` that rebuilds everything *except* those three. The seed is
  idempotent for the preserved lookup tables.
- **This is time-limited by its own terms.** Revisit when the security work lands,
  and certainly before any real patient exists. It also does not make `/reset-db`
  safe — that route is still unauthenticated, which is P0.1's problem, and this
  decision is what makes leaving it open tolerable rather than what fixes it.
- A reset leaves `schema_migrations` untouched. Rebuilt tables already contain
  every migration's columns, and both migrations are `ADD COLUMN IF NOT EXISTS`,
  so a replay is harmless — but a future non-idempotent migration would make this
  a trap worth handling properly.

**D-12 — Escalation fires regardless once a dose has been snoozed more than
three times.** Owner's decision, 2026-07-31, closing §10 item 1.

D-6 makes a snooze re-anchor the escalation clock, which is right: the patient is
demonstrably awake. But it means unlimited snoozing defers escalation forever,
and a patient who snoozes an insulin dose four times is precisely who the
caregiver escalation exists for. Above the threshold, 5.4 ignores `snoozed_until`
and anchors on `scheduled_for`.

Global rather than per-medication, unlike the delay in D-3: this is a
circuit-breaker on a mechanism, not a clinical judgement about a drug. Lives as
`SNOOZE_ESCALATION_THRESHOLD` in `backend/index.mjs`. The snooze response carries
`escalates_regardless` so the client never has to know the constant, and so the
threshold being crossed is visible in a response rather than only inside 5.4.

**D-10 — Android's alarm is an exact alarm on the alarm stream. Not a burst, and
not a full-screen intent.** Settled by the P0.3 spike, 2026-07-30; the evidence
is in §3 P0.3 and is worth reading before changing any of this.

- **Exact alarms**: declare `USE_EXACT_ALARM` plus `SCHEDULE_EXACT_ALARM` bounded
  to `maxSdkVersion="32"`. `expo-notifications` already calls
  `setExactAndAllowWhileIdle` when the permission is present, so this is a
  manifest change and nothing more. It needs a small local config plugin because
  `app.json` cannot express `maxSdkVersion`. This is all of 5.2.
- **No burst on Android.** `setAndAllowWhileIdle` and
  `setExactAndAllowWhileIdle` are capped at one alarm per nine minutes per app
  while the device is idle, and they are the only APIs the library uses. A
  30-second-spaced burst degrades to a single alert overnight — the exact case it
  was designed for. D-9's burst is **iOS-only**. Do not "fix" this by shortening
  the spacing; the cap is on frequency, not spacing.
- **No full-screen intent.** Not exposed by `expo-notifications`; the only
  practical alternatives are a bespoke native module or a four-month-old
  single-maintainer fork of the now-archived notifee. Declined, with the
  conditions for revisiting written into P0.3's decision 3.
- **Audibility instead comes from the notification channel** — `usage: ALARM`
  puts the alert on the alarm stream at alarm volume, where ring-silent does not
  reach it. New sub-item 4.7e. Channel settings are immutable after creation, so
  this must land before the next native build or it needs new channel ids again.

---

## 3. Phase 0 — Immediate

### P0.1 — Destructive and data-dump routes sit above the auth guard

`tish-app/backend/index.mjs` matches routes in one long `else if` chain. The auth
guard is `else if (!cognitoSub)` at **line 276**. Three routes match earlier and
therefore never reach it:

| Route | Line | Effect |
|---|---|---|
| `/reset-db` | 174 | `DROP TABLE` on every table, then recreates them empty |
| `/seed-data` | 178 | Inserts fixture rows |
| `/debug/{table}` | 183 | Returns 100 rows of any allowlisted table, including `users` and `test_results` |

API Gateway's `/{proxy+}` uses `COGNITO_USER_POOLS`, so a caller needs a valid
token from the pool — but every registered beta tester has one. In effect **any
registered user can drop the production database or dump every user's PII and
lab results.**

The `/debug` handler validates the table name against an allowlist, which
defends against injection and is probably why the missing auth check went
unnoticed. The allowlist is not the problem; the ordering is.

**Do:**
- Delete the `/reset-db` and `/seed-data` route branches. They have no callers
  anywhere in the app (verified). Keep `SCHEMA_SQL` and `SEED_SQL` as exported
  constants for local use.
- Delete `/debug/{table}`. The dashboard's `GET /tables/{name}` already provides
  this properly, behind a separate admin Cognito pool
  (`dashboard/server/index.mjs`).
- Add tests asserting all three now 404 or 401.

**Done when:** `npm test` passes with new cases, and no route matches before the
`!cognitoSub` guard except the intentionally public ones (`/genders`,
`/conditions`, `/check-availability`, `/register-profile`, and the `OPTIONS`
preflight).

Effort ~1h.

> **DEFERRED by decision, 2026-07-26 — do not action from this document.**
> The project owner has moved all security work to a separate plan, on the basis
> that the environment is currently dev-team-only. Recorded here so it isn't
> lost, not so it gets picked up. Two facts to carry into that plan: TestFlight
> build 8 is with external testers, so if any of their accounts live in this
> database the exposure is not purely internal; and this must be resolved before
> the Taipei cutover, since `/reset-db` against the migrated instance would drop
> production tables.
>
> **⚠ Updated 2026-07-31 — the exposure is now wider than this section
> describes, by the owner's explicit instruction.** `/debug` and
> `/debug/{proxy+}` were given `authorizationType: NONE` at API Gateway, and the
> Lambda routing bug that was accidentally masking them (§0.6) is fixed and
> deployed. So the three routes below no longer need *any* Cognito token: they
> are reachable by anyone who knows the URL.
>
> Concretely public on `https://u91xzojfja.execute-api.ap-east-2.amazonaws.com/production`
> right now: `/debug/users` (2 rows — `cognito_id`, `email`, `phone_number`,
> `full_name`, `birth_date`), `/debug/test_results`, `/debug/appointments`, and
> the rest of the allowlist, plus `/debug/link` and `/debug/unlink`, which can
> pair any two account ids as caregiver and dependent. `/reset-db` and
> `/seed-data` are still behind the Cognito authorizer via `/{proxy+}` — only the
> `/debug/*` prefix was opened.
>
> This is a deliberate trade for testability while the tester base is two
> accounts, and it belongs in the security plan alongside the rest. **The cheapest
> mitigation if it ever needs one, without giving up bookmarkable URLs, is an API
> Gateway resource policy restricting `/debug/*` by `aws:SourceIp`** — that keeps
> the convenience and closes the internet.

### P0.2 — File the iOS Critical Alerts entitlement request

Critical Alerts bypass Do Not Disturb, Focus modes, and the mute switch. This
matters disproportionately here because bedtime doses fire during exactly the
hours a phone is silenced. Requires an entitlement request to Apple; medical and
health apps are among the stated categories granted it. Verify current criteria
at time of filing.

Lead time is outside our control — file early and let it run in parallel, the
same way `MIGRATION.md` treats A0 and B0. Blocks 5.3. Effort ~1h to file.

### P0.3 — Spike: Android exact alarms under expo-notifications 55

> **SPIKE COMPLETE — session 2, 2026-07-30.** The answer is in **Findings** and
> **Decision** at the end of this section, and the settled part is restated as
> **D-10** in §2 for items that consume it. The text immediately below is the
> original question, kept as context — one of its premises is now stale, see
> finding 1.

Without `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM`, Android alarms are inexact
and Doze can defer them, potentially well past the dose time. Android 13+ offers
`USE_EXACT_ALARM` as a normal permission for apps whose core function is alarms;
Play policy language covers medication reminders. Confirm both against current
docs.

`tish-app/app.json` currently has **no `expo-notifications` plugin block and no
alarm-related Android permissions** — the app is using the weakest scheduling
primitive available. Determine what `expo-notifications@~55.0.24` exposes and
whether this needs a config plugin or a prebuild change.

While in there, also determine whether a **full-screen intent** is reachable
(4.7d). If it is, Android gets a real alarm — an activity over the lock screen
with looping audio — and can skip the notification burst entirely. Android 14
gates `USE_FULL_SCREEN_INTENT` to apps whose core function is alarms or calling.
The two questions share the same investigation, so answer them together.

Output is a written decision, not code. Blocks 5.2 and 4.7d. Effort ~3h.

#### Findings

Verified against `tish-app/node_modules/expo-notifications` at 55.0.24 — the
resolved version, not the range — plus current Android and Play documentation.
File references below are into that package.

**1. One premise above is stale.** `app.json` *does* now have an
`expo-notifications` plugin block: session 1 added one for 4.7a. It carries
`sounds` only. The rest holds — `android.permissions` is still `RECORD_AUDIO`
alone, and there is no `android/` directory (managed prebuild, EAS builds).

**2. The library already asks for exact alarms. It just never declares the
permission.** `ExpoSchedulingDelegate.setupAlarm`
(`android/.../service/delegates/ExpoSchedulingDelegate.kt:105-121`) is:

```kotlin
if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms()) {
  AlarmManagerCompat.setExactAndAllowWhileIdle(...)   // exact
} else {
  AlarmManagerCompat.setAndAllowWhileIdle(...)        // inexact
}
```

The library's own `android/src/main/AndroidManifest.xml` declares
`RECEIVE_BOOT_COMPLETED` and `POST_NOTIFICATIONS` and nothing else, and its
CHANGELOG says the permission "should be explicitly added to
**AndroidManifest.xml**" by the app. So **no config plugin or native change is
needed to get the exact-alarm code path — only the manifest permission.** Until
it is declared, every Android 12+ device silently takes the inexact branch. This
makes 5.2 much smaller than its ~2h estimate.

Corollary worth keeping: `RECEIVE_BOOT_COMPLETED` and the boot receiver come from
the library, so scheduled alarms already survive a reboot. That was never in
doubt but was never verified either.

**3. Take `USE_EXACT_ALARM`, not `SCHEDULE_EXACT_ALARM`.** Expo 55 defaults to
`targetSdkVersion 36` / `minSdkVersion 24`
(`expo-modules-core/android/ExpoModulesCorePlugin.gradle:65-69`). Android 14
"no longer pre-grant[s]" `SCHEDULE_EXACT_ALARM` to apps targeting 33 and higher —
it defaults to denied. `USE_EXACT_ALARM` is granted at install and cannot be
revoked.

The deciding factor is not convenience, it is observability: **expo-notifications
exposes no JS API for any of this.** There is no `canScheduleExactAlarms()`, no
way to launch `ACTION_REQUEST_SCHEDULE_EXACT_ALARM`, and no permission hook
beyond `POST_NOTIFICATIONS`/iOS authorization (`build/index.d.ts`,
`NotificationPermissions`). Under `SCHEDULE_EXACT_ALARM` the app therefore could
not detect that it had been denied and could not ask the user to fix it — alarms
would quietly become inexact with nothing in the UI and nothing in a log. That is
precisely the silent-failure class this whole plan exists to remove.
`USE_EXACT_ALARM` has no denied state to detect.

**4. Android 12 still needs the old permission.** `USE_EXACT_ALARM` is API 33+;
with `minSdk 24`, API 31–32 devices are in range and need
`SCHEDULE_EXACT_ALARM`, where it is still pre-granted. Declare both, and bound
the old one to `maxSdkVersion="32"` so it stops applying where the new one takes
over.

**5. `app.json` cannot express `maxSdkVersion`.** `setAndroidPermissions`
(`@expo/config-plugins/build/android/Permissions.js:135-141`) writes exactly
`{ 'android:name': permission }` and nothing else. So finding 4 needs a small
local config plugin using `withAndroidManifest` — roughly 15 lines, no native
code, no new dependency.

**6. The D-9 burst cannot work on Android, and the exact-alarm permission does
not help.** From the Doze documentation: "Neither `setAndAllowWhileIdle()` nor
`setExactAndAllowWhileIdle()` can fire alarms more than once per nine minutes,
per app." Those are the only two APIs expo-notifications uses (finding 2). So on
an idle phone — overnight, which is exactly the bedtime-dose case P0.2 also cares
about — a 3-alert burst spaced 30 seconds apart is delivered as **one** alert
followed by nine minutes of silence. This is a separate restriction from
exactness: the permission buys accurate delivery, not frequency.

`setAlarmClock()` is the one exempt API — "Alarms set with `setAlarmClock()`
continue to fire normally. The system exits Doze shortly before those alarms
fire" — and expo-notifications neither uses nor exposes it.

Two consequences beyond 4.7:

- **5.6 inherits a floor.** Two *different* reminders less than nine minutes
  apart (08:00 and 08:05) collide the same way on Android. Nothing in the app
  prevents a user creating them.
- **4.2's caregiver alarm is unaffected**, because 4.6's presets start at 15
  minutes. Worth not lowering that floor below 9 minutes for a reason unrelated
  to the UI.

**7. Full-screen intent is not reachable without shipping native code.** Zero
occurrences of `fullScreenIntent` or `FULL_SCREEN` anywhere in the module's
Android source. `NotificationsService.getSchedulingDelegate`
(`service/NotificationsService.kt:624`) is `protected open`, so the seam exists —
but `ExpoSchedulingDelegate` is a final class, so using it means implementing the
`SchedulingDelegate` interface from scratch, subclassing the receiver,
registering the subclass, and removing the library's own manifest registration.
That is real native work and it is re-broken by every expo-notifications upgrade.

**8. The obvious third-party route closed three months ago.** Notifee — which is
where full-screen intent, foreground services and looping alarm audio normally
come from in React Native — was archived by Invertase in April 2026; its README
now points at `expo-notifications` or at a community fork. The fork
(`react-native-notify-kit`) is real and active: v10.5.0 published 2026-07-24,
Apache-2.0, New Architecture support. It is also four months old, has a single
maintainer, and draws 15.8k weekly downloads against the archived notifee's
421k and expo-notifications' 3.2M. That is not a dependency to put a medication
alarm on top of.

**9. There is a large Android audibility win available today that is not
full-screen intent.** `setNotificationChannelAsync` already exposes, per
`build/NotificationChannelManager.types.d.ts`:

- `audioAttributes.usage: AndroidAudioUsage.ALARM` — plays the alert on the
  **alarm stream** at alarm volume. Not silenced by ring-silent, and not governed
  by notification volume. This is the single biggest change available and it is
  one line.
- `audioAttributes.flags.enforceAudibility` — the `FLAG_AUDIBILITY_ENFORCED`
  attribute.
- `bypassDnd` — Android's nearest equivalent to iOS Critical Alerts (P0.2).
  Requires the user to grant notification-policy access; without it the flag is
  ignored rather than erroring, so it must not be relied on silently.
- `lockscreenVisibility` — relevant to the PHI notes in 4.2 and 4.3.

`setupNotificationChannels` (`utils/notification-helper.tsx:21-35`) currently
sets `importance`, `vibrationPattern`, `lightColor` and `sound` only.

**A channel's settings are fixed at creation** — the trap session 1 already hit
with `sound` (§0.6). `audioAttributes` and `bypassDnd` are subject to it too, so
adding them to an already-created channel does nothing. **The current
`medication-alarms-{key}` channel ids exist on no device**, because 4.7a has
never been in a native build (§0.4). So this can be amended in place *if it lands
before the next native build*, and needs a third generation of channel ids if it
lands after. That is a real deadline, not a preference.

#### Decision

**Android gets exact alarms and an alarm-stream channel. It does not get the
burst, and it does not get a full-screen intent.** Restated as D-10 in §2.

1. **Declare both permissions** via a local config plugin (findings 3–5):

   ```xml
   <uses-permission android:name="android.permission.USE_EXACT_ALARM" />
   <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM"
                    android:maxSdkVersion="32" />
   ```

   This is the whole of 5.2. Revised effort ~45m including the plugin.

2. **The D-9 burst is iOS-only** (finding 6). 4.7b schedules
   `alarm_repeat_count` alerts on iOS and exactly one on Android; 4.7c's
   cancel-the-remainder logic stays platform-neutral, since it must already
   tolerate identifiers that don't exist. Keep the
   `med-{ownerUserId}-{reminderId}-{time}-{n}` scheme on both platforms so the
   two paths don't diverge structurally — Android simply only ever has `n = 1`.
   The 4.7 form control should not offer a burst count on Android.

3. **4.7d is declined, not deferred** (findings 7–8). The cost is a bespoke
   native module or a single-maintainer dependency; the benefit over item 4 below
   is looping audio and an activity over the lock screen. Revisit only if a
   device test shows item 4 is not enough to wake a sleeping user, or if
   `expo-notifications` adds full-screen intent support upstream — not on general
   principle. Recorded so it isn't silently re-opened.

4. **Android audibility comes from the channel instead** (finding 9). Add
   `audioAttributes: { usage: ALARM, flags: { enforceAudibility: true } }` to
   `setupNotificationChannels`, plus `lockscreenVisibility: PRIVATE` for the PHI
   reason in 4.2/4.3. This is a new sub-item, **4.7e**, and it is the Android half
   of 4.7's audibility goal. **Land it before the next native build** or pay for a
   third set of channel ids.

   `bypassDnd` is deliberately *not* included: it needs a user-granted policy
   exemption and a UI to request it, it is silently ignored otherwise, and it is
   the Android counterpart of P0.2 rather than part of this. Track it with P0.2.

5. **Owner action, not blocking today.** `USE_EXACT_ALARM` is Play-restricted:
   the policy names "an alarm or timer app" and calendar apps with event
   notifications, and declaring it subjects the listing to review. A medication
   reminder is a strong but not certain fit. `eas.json` has no Android submit
   configuration, so there is no Play listing yet and nothing is blocked — but
   the declaration has to be made before Android ships, and if it is refused the
   fallback is `SCHEDULE_EXACT_ALARM` plus the native permission check that
   finding 3 says the library cannot currently give us. Decide at declaration
   time; don't discover it at submission time.

---

## 4. Phase 1 — Silent failures

> **DONE — session 1, 2026-07-30.** Written and verified locally; see §0.2
> for where it landed and §0.4 for what is still undeployed. The text below
> describes the original defect and is kept as context.

**All 18 items (1.1–1.18) are done**, plus the web date picker from the D6 list
at the end of this section. Backend tests went 15 → 51.

Independent of one another, all small. Ship as one batch with tests. Each was
verified by running the real handler against a scripted pool.

| # | Item | Location | Effort |
|---|---|---|---|
| 1.1 | `/me` returns **200 with an empty body** when a Cognito user has no RDS row. Two faults on adjacent lines: `res.rows.count` is always `undefined` (arrays have `.length`), so the not-found branch never runs; and missing braces make `statusCode = '200'` unconditional. The client's `res.json()` then throws `SyntaxError: Unexpected end of JSON input`, which means `AuthContext`'s incomplete-profile recovery branch (`AuthContext.tsx:91-104`) is unreachable — it tests `!res.ok`, but the response *is* ok. Presents as an infinite bounce to `/login`. | `backend/index.mjs:286` | 15m |
| 1.2 | Double `JSON.stringify`. `apiRequest` serializes `body` for you (`utils/api.tsx:46`), but two callers pre-serialize. The server's `JSON.parse` then yields a *string*, `payload.id` is `undefined`, node-postgres coerces that to `NULL`, and `DELETE ... WHERE id = NULL` deletes nothing while returning `200 {"message":"Deleted"}`. The UI reloads and the row is still there. Fix both callers **and** narrow the wrapper's `body` type from `any` to `object` so it can't recur. | `(tabs)/results.tsx:103`, `medication-library.tsx:85`, `utils/api.tsx:6` | 30m |
| 1.3 | `POST /medication-library` is method-blind — the route matches on path only, so a POST falls into the GET branch, returns the unchanged list with 200, and the screen's `if (res.ok)` reports success. Add the INSERT, or reject non-GET explicitly. | `backend/index.mjs:219` | 30m |
| 1.4 | `/register-profile` reads `event.requestContext.authorizer.claims.sub` unguarded, and sits above the auth guard. A tokenless call is a `TypeError` → 500 rather than 401. | `backend/index.mjs:257` | 15m |
| 1.5 | `/admin/stats` returns counts as strings — node-postgres returns `bigint` as string, so the response is `{"totalUsers":"42"}` and `totalUsers + 1` is `"421"`. Use `COUNT(*)::int`, which is what `dashboard/server/index.mjs:237` already does. | `backend/index.mjs:407` | 15m |
| 1.6 | Scope changes don't invalidate fetched data. `(tabs)/results.tsx:71` and `(tabs)/index.tsx:66` key their `useFocusEffect` on `[]`, so switching active dependent leaves stale records on screen. `medications.tsx` and `appointments.tsx` already key on `[activeDependent?.id]` — match them. Separately, `index.tsx:44-46` passes `user?.id` rather than `activeDependent?.id`, so Home ignores the switch entirely. | `(tabs)/results.tsx`, `(tabs)/index.tsx` | 30m |
| 1.7 | `statusCode` is emitted as strings (`'200'`, `'404'`). Tolerated by REST API Gateway; the admin Lambda uses numbers. Normalise, and update the existing tests, which assert on strings (`index.test.mjs:61,66,85`). | `backend/index.mjs` | 30m |
| 1.8 | `birth_date` is a `DATE` column but the client sends a full `toISOString()`. For a UTC+8 user signing up before 08:00 local, the UTC date is the previous day and Postgres truncates to it, so the birthday is stored one day early. Send `YYYY-MM-DD` formatted in local time. | `signup.tsx:257` | 20m |
| 1.9 | `/my-id` returns a bare JSON scalar (`5`) rather than an object, and when the user isn't found returns `undefined` — which serialises to an **empty body with status 200**, the same failure shape as 1.1. Currently unreachable in practice (no caller in the app), so this is pre-emptive: return `{ id }` and 404 on miss, or delete the route. | `backend/index.mjs:280` | 15m |
| 1.10 | `/my-dependents` is defined **twice** in the route chain. The second branch is unreachable dead code, and the two queries differ — the live one selects `relationship_type`, the dead one doesn't. Delete the second. | `backend/index.mjs:289` and `:322` | 10m |
| 1.11 | `/register-profile` upserts with `ON CONFLICT (cognito_id) DO UPDATE SET full_name = EXCLUDED.full_name` — only `full_name` is refreshed. Retrying a partial signup with corrected `gender_id`, `condition_id`, `birth_date` or `phone_number` silently keeps the old values. Since idempotent retry is the recovery path for the Cognito/RDS split (see 1.1), this quietly undermines it. Update all mutable profile columns. | `backend/index.mjs:264` | 20m |

| 1.12 | `(tabs)/results.tsx:302` gates each field on `val ? … : null`, so a reading is hidden when falsy. It works today only because node-postgres returns `NUMERIC` as the string `"0"`, which is truthy — if a type parser is ever added, or the value arrives as a real `0`, legitimate readings of zero silently disappear from the report. Test explicitly for `null`/`undefined`. | `(tabs)/results.tsx:302` | 15m |
| 1.13 | **A failed config fetch breaks three forms, three different ways.** `medication-reminder-form.tsx:98-107` and `results-form.tsx:42-49` are `.then()` chains with no `.catch()`, and clear their loading flag only on success — so offline or a 5xx leaves a **permanent spinner** with no error and no retry. `appointment-form.tsx:57-72` has `try/finally` with no `catch`, so it renders, but `dbStatuses` stays empty, `selectedStatusId` stays null, and `handleSave` then silently refuses to save because its own validation blocks on `status`. The user gets no explanation in any of the three. | `medication-reminder-form.tsx`, `results-form.tsx`, `appointment-form.tsx` | 2h |
| 1.14 | **A `PUT` that matches no rows returns an empty body** on `/appointments`, `/medication-reminders` and `/test-results` — all three do `rows[0]`, which is `undefined` when the `WHERE id = … AND user_id = …` matches nothing. Same failure shape as 1.1. Worse in `medication-reminder-form.tsx:155-159`, where the resulting `res.json()` throw is caught and ignored, so the app then schedules notifications from local state for a reminder the server never updated. Return 404 on no match. | `backend/index.mjs:342,371,397` | 45m |
| 1.15 | Editing an **inactive** reminder schedules alarms for it. `medication-reminder-form.tsx:164` hardcodes `status: 'active'` in the object it passes to `scheduleMedicationNotifications`, regardless of the reminder's real status. Self-heals on the next visit to the medications screen (which re-syncs), but until then the device holds alarms for a reminder the server considers inactive. Pass the actual status. | `medication-reminder-form.tsx:164` | 15m |
| 1.16 | **Home writes to the dependent but reads from self** — the concrete consequence of 1.6, worth fixing together. `appointment-form.tsx:99` posts with `activeDependent?.id`, while `(tabs)/index.tsx:44-46` reads with `user?.id`. So creating an appointment from Home while managing a dependent files it under the dependent, and Home never shows it. It looks like the save silently failed. | `(tabs)/index.tsx`, `appointment-form.tsx` | (with 1.6) |
| 1.17 | No validation on the results form. `results-form.tsx:65` runs `parseFloat` on every field, so a typo like `"12o"` becomes `NaN`, serialises to JSON `null`, and is stored as a missing reading with no warning. No required fields and no bounds either. At minimum reject non-numeric input before save. | `results-form.tsx:51-84` | 1h |
| 1.18 | `(tabs)/index.tsx:68-75` `updateStatus` never checks `res.ok` and gives no feedback — a failed appointment status change just refetches and silently shows the old value. `medications.tsx:toggleStatus` already does this properly with an optimistic update, rollback and alert; match it. | `(tabs)/index.tsx:68` | 30m |

Total ~9h plus tests. Backend items need a manual deploy.

1.13 through 1.18 came from a second review pass on 2026-07-26 covering the write
paths and screens the first pass had only grepped. They share a theme worth
naming: **the read paths handle failure and the write paths mostly don't.** Every
form either hangs, silently refuses, or reports success it can't verify. Worth
fixing as a group rather than individually.

**Also outstanding from `MIGRATION.md` D6, functional and not covered above:**

- **Web date picker renders `null`**, so birth date can't be set or changed in a
  web build (`components/platform-date-picker.tsx:54` returns `null` for web).
  Needs a different input entirely — the web branches in `results.tsx` use a
  native `<input type="date">`, which is the pattern to follow.
- ~~`medications.frequencyEvery_one` missing from `zh-Hant.json`~~ — **verified
  resolved 2026-07-26.** Both `frequencyEvery_one` and `frequencyEvery_other` are
  present in both locale files, and the two files are at parity. The
  `MIGRATION.md` D6 entry is stale; no action, and D6 should be corrected.
- **The translation CI gate has a coverage hole worth knowing before Phases 3–5,
  all of which add strings.** `.github/workflows/translations.yml` triggers only
  on `paths: tish-app/locales/**`, and the validator compares en against zh-Hant.
  So adding a `t('some.new.key')` in code and forgetting *both* locale files
  touches no locale path, runs no check, and ships the raw key as visible UI
  text. Parity is enforced; coverage is not. Consider a check that greps `t('…')`
  call sites against the locale keys.
- 5 × `react/no-children-prop` lint errors from `<HelperText children={undefined} />`
  in `appointment-form`, `results-form` and `medication-reminder-form`.

---

## 5. Phase 2 — Migration mechanism

**Prerequisite for Phases 3–5.** There is currently no way to add a table to a
live database. Schema lives in `SCHEMA_SQL` (`backend/index.mjs:20`) as
`DROP TABLE ... CREATE TABLE`, invoked only by `/reset-db` — which P0.1 deletes.
`tish-app/backend/` contains no migration tooling and `pg` is its only
dependency (verified).

- **2.1 — Establish additive migrations.** *(DONE — see §0.2.)* Minimum viable and sufficient: a
  `tish-app/backend/migrations/` directory of numbered `.sql` files, a
  `schema_migrations` table recording applied versions, and a small script run
  manually against RDS. No framework. Keep `SCHEMA_SQL` as the from-scratch
  definition, and require every migration to be reflected in both. *(~2h)*
- **2.2 — `medication_doses`.** Columns: `id`, `reminder_id`, `user_id`,
  `scheduled_for` (timestamptz — the *original* due time, never overwritten, so
  the missed list stays honest), `confirmed_at` (timestamptz, nullable),
  `confirmed_by` (user id — **not** necessarily `user_id`, since under D-1 a
  caregiver may confirm), `snoozed_until` (timestamptz, nullable — the escalation
  anchor per D-6), `snooze_count` (integer, default 0). Unique on
  `(reminder_id, scheduled_for)` so repeat responses from two devices are
  idempotent rather than duplicated. *(~1h)*
- **2.3 — Relationship revocation columns.** Add `revoked_at`, `revoked_by` to
  `user_relationships`. Keep the row rather than deleting it, so access history
  survives revocation. *(~30m)*
- **2.4 — Escalation settings** *(D-3)*. Add to `medication_reminders`:
  `escalation_enabled BOOLEAN DEFAULT false` and
  `escalation_delay_minutes INTEGER DEFAULT 30`. Column default **must** be
  `false` — see D-3. Also add `escalated_at TIMESTAMPTZ` to `medication_doses`
  (2.2), used as the idempotency marker so the device-local alarm and the server
  job can't both notify for one dose.

  Per D-8 also add `escalation_order TEXT DEFAULT 'caregiver_first'`
  (`'caregiver_first'` | `'sms_first'`) to `medication_reminders`. On
  `medication_doses`, replace the single `escalated_at` with
  `escalation_level INTEGER DEFAULT 0` plus `last_escalated_at TIMESTAMPTZ`, so
  the job can tell which rungs have already fired. *(~45m)*
- **2.5 — `push_tokens`** *(D-5)*. *(DONE — session 4, migration `004`, mirrored
  into `SCHEMA_SQL`. The 30-minute estimate held. **The one thing this text gets
  dangerously close to under-specifying is the UNIQUE**: on `token` alone, never
  `(user_id, token)` — §0.6 has why the composite form is a disclosure bug rather
  than a style choice. Not preserved across a reset, unlike
  `user_relationships`: a token costs one launch to recreate.)*
  `id`, `user_id`, `token`, `platform`,
  `created_at`, `last_seen_at`. Unique on `token`, indexed on `user_id`. Rows are
  deleted when the push service reports the token dead — see 5.8. *(~30m)*
- **2.6 — Alarm burst setting** *(D-9)*. Add
  `alarm_repeat_count INTEGER DEFAULT 3` to `medication_reminders`. Enforce the
  1–6 bound at the API, not just in the form. *(~15m)*
- **2.7 — Meal time preferences** (for 4.8). *(DONE — migration 001, with 4.8.)* Add `breakfast_time`, `lunch_time`,
  `dinner_time`, `bedtime_time` to `users`, as `TIME` columns with sensible
  defaults (08:00 / 12:30 / 18:30 / 22:00). These are what make meal-relative
  reminders resolvable at all. *(~30m)*

Timing relative to `MIGRATION.md` Track C: if the Taipei snapshot has not been
taken, prefer doing this after cutover. If it has, apply to both databases until
they converge.

---

## 6. Phase 3 — Account and consent model

### 3.1 — Enforce responder identity *(correctness, not a feature)*

> **DONE — session 2, 2026-07-30**, after the owner ruled it belongs in this plan
> rather than the security one. Both branches are now scoped by `dependent_id` in
> the `WHERE` clause, so there is no check-then-write window; not-yours is a 404
> rather than a 403 because `id` is guessable and 403 would confirm a relationship
> exists. 6 tests, which assert the *parameters of the write* rather than only the
> status code — a 404 with an unscoped `UPDATE` still behind it would satisfy a
> status-only test. Undeployed; see §0.7. The text below is the original defect.


`/relationships/respond` (`backend/index.mjs:312`) verifies the handshake code
but never checks that the responder **is** the dependent. The deny branch is a
bare `DELETE FROM user_relationships WHERE id = $1` with no ownership check at
all.

Because the caregiver is shown the code when they request access
(`managed-users.tsx:42` displays it), and `id` is a sequential `SERIAL`, a
caregiver can approve their own request. Separately, any authenticated user can
delete any relationship by guessing an id.

Require `dependent_id = (SELECT id FROM users WHERE cognito_id = <sub>)` on both
branches. Tests: wrong responder rejected; correct responder accepted; deny by a
non-participant rejected. *(~1h with tests)*

### 3.2 — Revocation

There is no way to withdraw access once granted. The `status` column supports it
and nothing exercises it.

- `POST /relationships/revoke` — either participant may revoke. Sets
  `status = 'revoked'` plus the columns from 2.3. `checkAccess`
  (`backend/index.mjs:167`) already filters on `status = 'active'`, so
  enforcement follows automatically.
- Profile screen: a "who can see my records" list with a revoke action, next to
  the existing pending-requests section (`profile.tsx:111`).
- Tests: a revoked relationship denies access on every scoped route.

*(~4h across both ends, plus locale keys in both files)*

### 3.3 — Revalidate persisted scope on launch

`activeDependent` is restored from AsyncStorage (`AuthContext.tsx:54`) without
checking the relationship still exists, so after revocation a caregiver stays in
a stale scope until some request 403s. Cross-check against `/my-dependents`
inside `checkUser()` and clear if absent. *(~30m)*

### 3.4 — Relationship type

`relationship_type` is hardcoded `'Family'` client-side
(`managed-users.tsx:38`). Offer a selection at request time. Note this does not
change access scope — the model stays all-or-nothing, which is a known
limitation rather than a defect. *(~1h)*

### 3.5 — There is no password reset flow at all

> **DONE — session 1, 2026-07-30.** Written and verified locally; see §0.2
> for where it landed and §0.4 for what is still undeployed. The text below
> describes the original defect and is kept as context.


Verified by search: nothing in `tish-app/` calls `resetPassword` or
`confirmResetPassword`, and there is no forgot-password entry point on the login
screen. The only Amplify auth calls in the app are `signIn`, `signUp`,
`confirmSignUp`, `resendSignUpCode` and `signOut`.

**A user who forgets their password is permanently locked out**, with no recovery
path short of an administrator intervening in the Cognito console. This affects
TestFlight build 8 testers today, and it is the kind of gap that reads as broken
rather than incomplete.

Needs: a "forgot password" link on `login.tsx`, a screen that calls
`resetPassword({ username })`, a code-entry step calling
`confirmResetPassword({ username, confirmationCode, newPassword })`, and locale
keys in both files. The delivery-medium caveat from `constants/config.ts` applies
— while the SNS sandbox is active, reset codes should go by email, so mirror the
handling that signup already does rather than assuming SMS works.

*(~1 day including both screens and locale keys)*

### 3.6 — Unhandled sign-in next-steps leave the user with no feedback

> **DONE — session 1, 2026-07-30.** Written and verified locally; see §0.2
> for where it landed and §0.4 for what is still undeployed. The text below
> describes the original defect and is kept as context.


`login.tsx:43` branches on `nextStep.signInStep` for `CONFIRM_SIGN_UP` only. Any
other step Cognito can return — `RESET_PASSWORD`, `CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED`,
or any MFA step — matches neither branch, so `isSignedIn` is false, nothing
happens, and the spinner simply stops. The user is given no indication that
anything is required of them, or that anything went wrong.

`RESET_PASSWORD` is the realistic one: it is exactly what Cognito returns after
an administrator forces a reset, which is currently the *only* way to recover a
forgotten password (3.5). So the two failures compound — the recovery path an
admin triggers dead-ends silently in the app.

At minimum, handle the remaining steps with an explanatory message; ideally route
`RESET_PASSWORD` into the 3.5 flow. *(~2h)*

---

## 7. Phase 4 — Reminder integrity (device side)

### 4.1 — Move notification re-sync to app launch

> **DONE — session 1, 2026-07-30.** Written and verified locally; see §0.2
> for where it landed and §0.4 for what is still undeployed. The text below
> describes the original defect and is kept as context.


`loadData()` in `(tabs)/medications.tsx:33-38` is currently the **only** thing
that reconciles local notifications against the backend. Opening the app to Home
never repairs a broken chain, which is precisely the case the re-sync exists
for. Extract to a hook and call it from `app/_layout.tsx`. *(~1h)*

### 4.2 — Multi-user alarm sets *(shaped by D-1)*

Notification identifiers are `med-{reminderId}-{time}`
(`notification-helper.tsx:68`) and reminder ids are globally unique, so nothing
records *whose* alarms are resident on a device. Today a caregiver who views a
dependent's medications leaves those alarms scheduled on their own phone
permanently, with no indication of who they belong to.

Under D-1 this is intended behaviour rather than a leak, but it needs to be
deliberate:

1. **Namespace identifiers by owner** — `med-{ownerUserId}-{reminderId}-{time}`
   — so a device can reconcile one person's set without touching another's.
2. **Reconcile for self plus all active dependents**, not just the currently
   selected scope. The device holds several sets at once. This means the re-sync
   in 4.1 fetches `/my-dependents` and then reminders per dependent.
3. **Attribute the alarm in the UI.** `alarm-overlay.tsx` currently renders only
   medication name and dosage. On a caregiver's device it must lead with *whose*
   dose it is — an unattributed "take 200mg" on the wrong person's phone is a
   safety problem, not a UX one.
4. **Fire the caregiver's copy on the reminder's configured delay** *(D-3)*.
   Schedule at dose time + `escalation_delay_minutes`, only for reminders with
   `escalation_enabled`, and cancel it on the next sync if the dose has been
   confirmed. Simultaneous firing would make the caregiver an alarm clock for
   every dose their dependent successfully takes, which desensitises quickly;
   delayed firing makes them an escalation path, which is the point of D-1. If
   the caregiver's phone is offline the alarm still fires — the correct failure
   direction, since it errs toward notifying rather than staying silent.

   Useful side effect: because the caregiver's device only holds alarms for
   reminders with escalation switched on, the pressure this puts on the iOS
   64-notification cap (5.6) is far lower than holding a full mirror of every
   dependent's schedule.
5. **Minimise lock-screen content on the caregiver's device.** A dependent's
   medication names are PHI appearing on a third party's lock screen. Prefer
   "Margaret has an unconfirmed dose" over naming the drug; resolve detail
   in-app after unlock. Works naturally with 4.3.

Interacts with 5.4 — the server-side escalation must not double-notify a
caregiver whose device already alarmed. Single source of truth is the
`medication_doses` row.

> **DONE — items 1, 3 and 5 in session 2 (2026-07-30); items 2 and 4 in session 3
> (2026-07-31), together, which was the whole point of holding them.** One half of
> item 4 is carried forward to 2.2 + 5.1 — see the end of this note and §0.6.
>
> **Item 2 (reconcile self + dependents) — done.** `_layout.tsx`'s launch effect
> now syncs the signed-in user plus every active dependent from `/my-dependents`,
> via a new `syncOwners` on `useNotificationSync`. Owners are tracked in a `Set`
> rather than behind a single "have we synced" flag, because `dependents`
> populates a moment after `user` does — `loadDependents` is fired off inside
> `checkUser` without being awaited — so the effect necessarily runs more than
> once per sign-in and must be able to pick up the dependents without redoing the
> user's own set. The user's own id is now passed explicitly rather than left
> `undefined`, which also fixes a smaller pre-existing bug: `cacheReminders` could
> not evict a set that came back empty, so deleting a last reminder left its
> details cached indefinitely.
>
> **Item 4 (fire on the configured delay) — scheduling done, cancellation
> deferred.** `scheduleMedicationNotifications` takes a `ScheduleOptions`
> `{ viewerUserId }`; when it differs from the reminder's `user_id` this device is
> holding a caregiver's copy, which is scheduled at dose time +
> `escalation_delay_minutes` and only when `escalation_enabled`. Both ids must be
> known before it will treat a copy as a caregiver's — guessing would delay a
> patient's own alarm, which is the one failure direction that must never happen
> quietly. Switching escalation off now actively removes the caregiver's alarms,
> because the cancel-then-reschedule pass runs before the escalation gate rather
> than after it.
>
> Three things that are easy to get wrong here and are worth not rediscovering:
>
> - **The offset is applied before the has-it-passed comparison**, not after. A
>   caregiver's device syncing at 08:05 for an 08:00 dose with a 30-minute delay
>   must schedule today's escalation at 08:30; comparing the un-offset dose time
>   sees 08:00 as past, rolls to tomorrow, and drops the escalation for the dose
>   actually in doubt. There is a test named for this case.
> - **The offset is carried in the notification payload** as
>   `escalationOffsetMinutes`, because `rescheduleNextOccurrence` chains the next
>   occurrence from the payload alone. Without it the caregiver's second
>   occurrence lands back on the dose time and the escalation quietly becomes the
>   duplicate alarm clock this item exists to prevent — after one firing, on a
>   device nobody is watching. A payload from an earlier build has no such field,
>   reads as zero, and behaves exactly as before.
> - **The escalation copy has its own title and body.** A caregiver whose phone
>   rings thirty minutes after a dose they had no part in otherwise reads it as
>   their own reminder misfiring. It still names nobody — attribution is item 3's
>   job, in the overlay, behind the lock screen.
>
> **The carried third — cancelling the caregiver's alarm when the dose is
> confirmed — landed in session 4.** The re-sync now fetches the owner's
> materialised doses alongside their reminders and passes them in as
> `ScheduleOptions.doses`; `confirmedDoseKeys` reduces them to reminder + local
> wall-clock minute, and a slot whose dose is already confirmed is skipped. The
> cancel-then-reschedule pass above the gate is what makes "skip" equal
> "cancel": the copy is removed before the loop decides not to rewrite it.
>
> Three things about it worth not rediscovering:
>
> - **The key is the dose time, not the trigger time.** The offset has already
>   been applied by then, and the dose row knows nothing about the caregiver's
>   delay.
> - **The doses request is skipped entirely on a patient's own device.** Only a
>   caregiver's copy is scheduled *after* its dose and can therefore be obsolete
>   before it fires; the patient's own alarm is always the next occurrence. The
>   common launch stays at one round trip.
> - **A failed fetch returns `[]`, which schedules every escalation rather than
>   none.** "We could not tell" must fail toward alarming. A caregiver woken
>   about a dose that was taken is an annoyance; one not woken about a dose that
>   was missed is the failure the plan exists to remove.
>
> A **snoozed** dose is deliberately not treated as confirmed — see §0.6, and
> expect 5.4 and the device to disagree on those until 5.4 lands.
>
> ---
>
> *The session-2 note follows, kept for the ordering argument it records.*
>
> **PARTIALLY DONE — session 2, 2026-07-30. Items 1, 3 and 5 have landed; items
> 2 and 4 are blocked on 2.4, and the block is deliberate.**
>
> - **Item 1 (namespaced identifiers) — done.** `utils/notification-identifiers.ts`
>   holds `identifierFor` and `belongsToReminder`, dependency-free so it can be
>   tested outside a native runtime. Cancellation parses identifiers by segment
>   rather than matching a prefix: once an owner segment exists, `med-7-` is a
>   prefix of both "reminder 7, un-namespaced" and "every alarm owned by user 7",
>   so prefix matching could wipe one person's entire set while cancelling a
>   single reminder. 11 tests cover that collision in both directions.
> - **Item 3 (attribution) — done.** The overlay leads with whose dose it is when
>   the owner is not the signed-in user. Names come from a small AsyncStorage map
>   written by `AuthContext.loadDependents`, which already has them — the alarm
>   path must not depend on a network call that can fail.
> - **Item 5 (lock-screen minimisation) — done as part of 4.3.** The banner no
>   longer names a medication, which is the same change both items wanted.
> - **Items 2 and 4 — not done, and item 2 must not ship without item 4.**
>   Item 2 reconciles dependents' sets onto the caregiver's device; item 4 is what
>   makes those copies fire at dose time + `escalation_delay_minutes` instead of
>   at dose time. Item 4 reads `escalation_enabled` and
>   `escalation_delay_minutes`, which do not exist yet — that is 2.4, still `—`.
>
>   Shipping item 2 alone would turn today's *accidental* leak (a caregiver who
>   views a dependent's medications keeps their alarms) into a systematic mirror
>   that alarms the caregiver simultaneously for every dose their dependent takes
>   correctly. The section above already identifies that as the failure mode to
>   avoid: it desensitises quickly, and a desensitised caregiver is worse than no
>   caregiver alarm. So the ordering is **2.4 → 4.6 → 4.2 items 2 and 4**, not
>   4.2 in one pass.
>
>   Item 3 is still worth having now precisely *because* the accidental leak
>   exists: those alarms are on caregivers' devices today, and until this change
>   they rendered an unattributed "take 200mg".

*(~1 day, up from the original estimate, because D-1 makes this a feature rather
than a cleanup)*

### 4.3 — Slim the notification payload

The payload carries `medName`, `dosage`, `soundKey`, `label` and more
(`notification-helper.tsx:77-85`), and the title/body text is composed at
schedule time (`:73-76`). An alarm scheduled a week ago therefore displays
whatever the dose was then — if a caregiver reduced it since, the phone shows
the superseded instruction.

Carry only `reminderId` (plus `ownerUserId` per 4.2) and resolve display values
when the overlay opens.

**What this actually buys — state it correctly, because the obvious version is
wrong.** It does not make an offline device current; nothing can. A phone that
hasn't synced since the dose changed will show old values either way. What it
does is collapse **two** copies of the dosage on the device into **one**. Today
the value exists both in the OS notification queue (written days ago, unreachable,
never updated in place) and in the app's own copy — and they can disagree, with
the unreachable one being the one that rings. After this change there is a single
copy that the app controls, so the alarm can no longer contradict the medications
screen. Consistency, not currency; how stale that single copy gets is then
bounded by the sync (4.1, 5.9) rather than frozen at whenever the notification
happened to be written.

**Prerequisite: there is no persistent local copy today.** `medications.tsx`
holds reminders in `useState`, and `_layout.tsx` builds the alarm overlay
entirely from the notification payload. When an alarm cold-starts the app, no
such state exists — so "resolve from local data" currently has nothing to
resolve against, and the overlay would render blank. That is a worse outcome than
the stale text this item is meant to fix.

So this item includes a small persistence layer:

- The reconciliation pass (4.1) writes the reminder set to AsyncStorage —
  already a dependency, used for `active_dependent` in `AuthContext`.
- The overlay reads from there, keyed by `reminderId` and `ownerUserId`.
- **Degrade, don't blank.** If the store is empty or the id is missing — fresh
  install, cleared data, a reminder deleted since scheduling — show a generic
  medication-reminder prompt and resolve fully once the app is online. Never
  render an alarm with no content.

**Refresh at open, don't just read the cache.** The overlay is rendered by the
app, not by the OS, so at that moment there *is* network access and running code.
Fetch the reminder on open and fall back to the cache — that way the number the
patient acts on is fetched at the moment they act on it, rather than being merely
as fresh as the last sync.

- **Render from cache first, update in place.** Never block the first paint on a
  network call.
- **Hard timeout, 2–3 seconds.** An alarm that doesn't ring because a fetch
  stalled is a far worse failure than a stale dosage. Cache wins on timeout.
- Show a quiet "last updated" marker when the fetch didn't land, so the patient
  knows what they're looking at.

**Keep the banner text non-committal.** The OS-rendered banner is baked at
schedule time and cannot be corrected — that is exactly the content this item
can't fix. So it should not assert a dose: "Medication reminder — tap to view"
rather than a name and a quantity. The authoritative numbers appear in the
overlay, where they can be refreshed. This is the same change the lock-screen PHI
note in 4.2 asks for, so one decision covers both.

*(~4h, up from 1h)*

### 4.4 — Make snooze snooze

> **DONE — session 4, 2026-07-31.** Client-only, as session 3 forecast, and the
> two easy parts were easy. The third was not, and the difference is worth
> reading before touching the queue:
>
> - **Re-arm locally first.** `scheduleSnoozeAlert` schedules a single alert ten
>   minutes out. Single, not a burst: the burst (D-9) exists to wake someone
>   asleep, and a snooze is pressed by someone demonstrably awake — the same
>   premise D-6 rests on. It is also the honest option, since the overlay knows
>   the reminder's id, slot and sound from the payload and does **not** know
>   `alarm_repeat_count`. Its identifier sits outside the burst series for a
>   reason recorded in §0.6, and the reconciliation pass had to be taught to
>   leave it alone.
> - **Then record it.** `recordDoseAction` posts `action: 'snooze'`, and queues
>   the send if it fails.
> - **The retry is where the work was.** §0.6 has the full finding; the short
>   version is that a replay cannot re-send the original request, because the
>   server resolves "which dose" by proximity to `now()` and a retry hours later
>   resolves to a different dose. A replay reads the dose list around the moment
>   the button was pressed and posts the exact `scheduled_for` back.
>
> **Confirms are queued too**, not just snoozes. The plan only asks for the
> snooze, but the mechanism is identical and the argument is stronger: 4.2 item
> 4 now cancels a caregiver's escalation alarm on the strength of a
> confirmation, so a dropped confirm rings a caregiver about a dose taken on
> time.
>
> The snooze label was `Snooze (5m)` in both locale files while nothing snoozed
> at all. It now interpolates `SNOOZE_MINUTES`, so the button and the behaviour
> cannot drift apart again.
>
> **Two live bugs were fixed in the same code path** — a reminder-wide cancel
> deleting sibling slots, and the overlay's cancel deleting the next occurrence.
> Both are in §0.6. Neither is 4.4's, and 4.4 could not have been correct on top
> of either.


`alarm-overlay.tsx:57,69` — the confirm and snooze buttons both call
`onDismiss` and are behaviourally identical.

Reschedule the local alarm +10 minutes, and POST the snooze so the server sets
`snoozed_until` and increments `snooze_count`. Under D-6 this is what defers
caregiver escalation, so it is not a client-only concern — a snooze that never
reaches the server will escalate to the caregiver anyway. That is the correct
failure direction, but it means the POST should retry on next sync rather than
being fire-and-forget.

*(~2h, after 5.1)*

### 4.5 — Remove dead code

> **DONE — session 1, 2026-07-30.** Written and verified locally; see §0.2
> for where it landed and §0.4 for what is still undeployed. The text below
> describes the original defect and is kept as context.


`startVibration` in `alarm-overlay.tsx:34` is defined and never called. Delete
it, or call it and clear the interval properly on unmount. *(~1m)*

### 4.6 — Escalation settings, end to end *(D-3)*

> **DONE — session 2, 2026-07-30.** API and form both. Three deviations from the
> text below, each recorded in §0.6: the parameter counts were already 15/16
> rather than 14/15, and the tests now read parameters by column name instead of
> by position so the next column addition touches no index; the delay UI floors at
> 15 with a custom minimum of 10 rather than 5, because Android's nine-minute Doze
> throttle can defer a caregiver alarm scheduled inside that window; and the burst
> control is left *enabled* on Android with a note saying that phone will sound
> once, rather than hidden — the setting lives on the reminder, not the device, so
> a patient on Android may have a caregiver on iOS that honours it.
>
> The API validates all three bounded fields and returns 400 before touching
> Postgres. That matters more than it looks: migration 002 puts CHECK constraints
> on them, so without the guard an out-of-range value returns as a 500 carrying
> internal English prose through the one-line error contract (Phase 6).
>
> **Do not deploy this until migration 002 is applied** — see §0.7 item 1.


Wire the two columns from 2.4 through the API and expose them in the form.

- **API.** Add both fields to the `/medication-reminders` POST insert and the
  PUT `COALESCE` update (`backend/index.mjs:356-374`).
- **Watch the existing tests.** They assert exact parameter counts —
  `inserted.length === 14` (`index.test.mjs:182`) and `updated.length === 15`
  (`:200`), with positional assertions after them. Both break when the columns
  are added; update the counts and the indices together, and extend the cases to
  cover the new fields rather than just repairing the numbers.
- **Form.** `medication-reminder-form.tsx` gets a toggle, a delay control, and an
  order control (D-8). Prefer presets (15 / 30 / 60 / 120 minutes) with a custom
  option over a raw number input — the primary users are elderly, and the app
  already leans on large targets, TTS and dictation elsewhere. Bound the custom
  value (5–240). The order control should disable `sms_first` with an
  explanation while Track B is outstanding, rather than offering a choice that
  silently falls back. The alarm-burst control from 4.7 lives on the same screen
  — build them together rather than touching this form twice.
- **Locale keys** in both `en.json` and `zh-Hant.json`. CI enforces parity.
- **Editable by both parties** (D-7). No permission check beyond the existing
  `checkAccess` — a caregiver acting as a dependent edits their reminders as
  normal. Provisional; see D-7 for what to revisit.

*(~4h including tests and locale keys)*

### 4.7 — Alarm audibility *(D-9)* — highest-value functional item in the plan

Everything else in Phases 4 and 5 assumes the alarm is heard and asks whether it
was *correct* or *delivered*. This item asks whether it is loud enough to wake
someone with the app closed, which for a medication reminder is the first
question, not the last.

**4.7a — The notification sound file does not exist.** *(DONE — see §0.2 and
the three amendments in §0.6. Still unverified on a physical device.)*
`notification-helper.tsx` references `alarm.wav` twice — on the Android channel
(`:22`) and per-notification (`:87`) — and there is no such file anywhere in the
repo. `assets/sounds/` holds `default.mp3`, `emergency.mp3` and `calm.mp3`, and
`SOUND_MAP` wires those to the **overlay only**. There is also no
`expo-notifications` config plugin in `app.json`, so nothing places a custom
sound into Android's `res/raw` or the iOS bundle.

Consequence: Android falls back to the default notification sound, and **the
per-reminder sound a user picks has no effect on what they actually hear unless
the app is already open.** A user-visible feature that silently does nothing.

Fix: add the config plugin, register all three sounds as notification sounds,
keep each under 30 seconds, and select per-notification from `reminder_sound` so
the existing setting becomes real. Verify on a physical device — this cannot be
confirmed in a simulator.

**4.7b — Schedule the burst.** *(DONE — session 3.)* Per D-9, one dose schedules
`alarm_repeat_count`
consecutive notifications ~30 seconds apart. Extend the identifier scheme to
`med-{ownerUserId}-{reminderId}-{time}-{n}` so a burst stays enumerable and the
existing prefix-matching cancellation keeps working.

> **Two exceptions, both already implied by decisions elsewhere and neither
> obvious from this paragraph.**
>
> - **Android always schedules one** (D-10, the nine-minute Doze cap). The
>   identifier still carries `-1` so the two platforms don't diverge structurally.
> - **A caregiver's escalation copy is always one alert**, and 5.6's notification
>   budget already assumes exactly this — it multiplies only the owner's own
>   alarms by `alarm_repeat_count` and counts dependents' escalations singly.
>   Bursting them would multiply iOS 64-slot pressure by up to six per dependent,
>   to make an alert louder for the person who is the backstop rather than the one
>   taking the dose.
>
> **The burst index is only ever appended to an owner-namespaced identifier**,
> because segment count alone cannot tell `med-{owner}-{id}-{slot}` from
> `med-{id}-{slot}-{n}` — both are four. An un-namespaced burst identifier would
> be parsed with the slot in the reminder position, and `Number('0800')` is 800,
> so a real reminder with id 800 would have its alarms cancelled by an unrelated
> cancel. `identifierFor` makes that shape unconstructible; the scheduler degrades
> to a single alert and warns if a reminder ever arrives without a `user_id`.

**4.7c — Cancel the remainder on any response.** *(DONE — session 3.
`cancelAlarmBurst` in `notification-helper.tsx`, called from both listeners in
`_layout.tsx` and from the overlay's confirm and snooze. One thing this section
did not anticipate: it must run **before** the chain-forward reschedule, not
after — see §0.6.)* Both halves, or the patient is
chimed at after acting:

- `cancelScheduledNotificationAsync` for burst members not yet fired
- `dismissNotificationAsync` for members already sitting in the tray

Trigger from the response listener *and* from the overlay's confirm and snooze
actions. Must be idempotent and tolerate identifiers that no longer exist, since
a chime can fire mid-dismissal. Handle the cold-start case: tapping alert 2 of 5
launches the app from scratch, and must still cancel 3–5 and clear 1–2. All of
this is local, so it works offline.

**4.7d — Android full-screen intent.** *(DECLINED by the P0.3 spike — see D-10
and P0.3 decision 3 for the evidence and for the conditions under which to
revisit. Not available through `expo-notifications`; the alternatives are a
bespoke native module or a single-maintainer fork of archived notifee.)* Folded
into the P0.3 spike. If available,
Android gets a real alarm — an activity over the lock screen with looping audio —
and can skip the burst entirely. Android 14 gates `USE_FULL_SCREEN_INTENT` to
apps whose core function is alarms or calling; medication reminders plausibly
qualify, but confirm against current Play policy. Needs a config plugin or native
module either way.

**4.7e — Android channel audibility.** *(New, from the P0.3 spike; replaces 4.7d
as Android's answer to the audibility question.)* `setupNotificationChannels`
(`utils/notification-helper.tsx:21-35`) sets importance, vibration, light and
sound, but not `audioAttributes`. Add
`usage: AndroidAudioUsage.ALARM` and `flags.enforceAudibility` so the alert plays
on the alarm stream at alarm volume rather than the notification stream, plus
`lockscreenVisibility: PRIVATE` for the PHI reason in 4.2 and 4.3.

**Channel settings are fixed at creation**, exactly as with `sound` in 4.7a — so
this must land **before the next native build**, while the
`medication-alarms-{key}` channels still exist on no device. After that it needs
a third generation of channel ids. *(~30m if it goes in before the build; ~1h and
an awkward comment if not.)*

**Form control:** number of alerts, 1–6, built alongside 4.6's controls. iOS
only, per D-10 — Android always schedules one.

*(~1.5 days, plus whatever 4.7d turns out to require)*

### 4.8 — Meal-relative reminders are collected, stored, displayed, and never scheduled

> **DONE — session 1, 2026-07-30.** Written and verified locally; see §0.2
> for where it landed and §0.4 for what is still undeployed. The text below
> describes the original defect and is kept as context.


**This is the second-highest-value functional item after 4.7a, and the most
user-deceiving bug found.** Trace it end to end:

| Stage | State |
|---|---|
| Form | `medication-reminder-form.tsx:75-78` builds `mealSelections`; `:134-137` sends `at_breakfast` / `breakfast_timing` / `at_lunch` / … |
| Schema | All seven columns exist on `medication_reminders` (`index.mjs:69-75`) |
| API | Persisted correctly by both POST and PUT |
| Medications list | `(tabs)/medications.tsx:162` renders them back — "Breakfast • Lunch • Dinner" |
| Scheduler | `scheduleMedicationNotifications` reads **only** `reminder.alarms` |

So a patient sets "with breakfast, before dinner," the app displays that setting
back to them as though it is active, and **no alarm ever fires for it.** Every
other bug in this plan either fails visibly or fails silently; this one shows the
user a confirmation of something that does not exist.

**Why it was never built:** "before dinner" isn't computable without knowing when
this person eats, and the app never observes that. 2.7 resolves it the way it has
to be resolved — ask once, store a preference, treat it as an estimate the user
can adjust.

**Where to resolve — decide before writing code.** Recommended: resolve meal
selections into concrete clock times **when the reminder is saved**, and write
them into `alarms[]` alongside a label. Then the device scheduler and the
server-side dose materialiser (5.1) both read one representation, and neither
needs meal logic. The alternative — keeping the flags authoritative and resolving
at read time in both places — is more correct when preferences change but
duplicates the logic in two languages on two sides.

Taking the recommended path, two sub-problems follow:

- **Re-resolve on preference change.** If a user moves their dinner time, every
  meal-derived alarm needs regenerating. Cheap, but must not be forgotten.
- **Distinguish derived from manual alarms**, so re-resolution doesn't overwrite
  times the user set by hand. A parallel `alarm_sources TEXT[]`, or a convention
  in `alarm_labels`.

**Also needed:** a documented before/after offset (30 minutes is a reasonable
default), a profile screen for the four times, and locale keys in both files.

*(~1 day)*

---

## 8. Phase 5 — Delivery

The part that addresses the underlying problem: **neither mobile platform
guarantees notification delivery, and nothing in the current design compensates
for that.** The current implementation makes the *schedule* reliable; it does
nothing to make the *alarm arrive*.

- **5.1 — Dose records: materialise, then confirm.** Two halves, and the first
  is easy to miss.

  **Materialisation.** Expected doses must exist as rows before they happen, or
  neither the missed list (D-4) nor escalation (5.4) can distinguish "not taken"
  from "never scheduled." Write `medication_doses` rows with `scheduled_for` set
  and `confirmed_at` null, for a rolling window ahead (align with 5.6's
  horizon — ~7 days). Regenerate when a reminder's schedule changes, and delete
  future unconfirmed rows when a reminder is deleted or deactivated. Server-side
  is the right home for this, since escalation must work when the device never
  comes back.

  The alternative — deriving expected doses from `alarms[]` and `frequency_days`
  at query time — avoids the storage but has to reproduce exactly what the device
  scheduled, including schedule edits mid-window and timezone handling. Not worth
  it; volume is trivial at this scale (roughly 3,000 rows per user per year for
  three medications taken three times daily). Add a retention policy later rather
  than avoiding the rows now.

  **Confirmation.** `POST /medication-doses` wired to the overlay's confirm
  button, setting `confirmed_at` and `confirmed_by`. Idempotent per 2.2's unique
  constraint, since under D-1 two devices may confirm the same dose.

  *(~1 day for both halves)*
- **5.2 — Android exact alarms.** *(DONE — session 2. `plugins/with-exact-alarms.js`
  declares `USE_EXACT_ALARM` plus `SCHEDULE_EXACT_ALARM` bounded to
  `maxSdkVersion="32"`; a plugin rather than `app.json`'s `android.permissions`
  because that array cannot express `maxSdkVersion`. Verified against
  `npx expo config --type introspect`. Takes effect only in a new native build.)*
  Apply P0.3's finding: permission in
  `app.json`, plus whatever the module requires. *(~2h, gated on P0.3)*
- **5.3 — iOS alert urgency.** *(DONE — session 3, 2026-07-31, and **no longer
  gated on P0.2**. The owner's instruction was to do the best available now and
  upgrade later if Apple grants the entitlement.)*

  The original text below assumed one lever, Critical Alerts, and therefore one
  blocker. There are actually two levels, and only the higher one needs Apple:

  | Level | Gets through | Entitlement |
  |---|---|---|
  | `timeSensitive` | Focus modes, the scheduled notification summary | `com.apple.developer.usernotifications.time-sensitive` — **self-service** |
  | `critical` | the above, plus the mute switch and Do Not Disturb | `...critical-alerts` — **Apple approval** (P0.2) |

  Shipped: `timeSensitive` on every alert, the self-service entitlement in
  `app.json`, and an authorization request that names its iOS options explicitly
  instead of passing none. This covers the bedtime-dose case for anyone using
  Sleep Focus, which is the majority of the population P0.2 was concerned about.
  What is *not* covered is a phone on ring-silent or in Do Not Disturb proper.

  **The upgrade path is one flag.** `resolveInterruptionLevel` reads the
  permission iOS actually reports, so a build carrying the entitlement uses
  `critical` and every other build uses the strongest level it is allowed. If the
  entitlement arrives: set `CRITICAL_ALERTS_ENTITLED` in `constants/config.ts`,
  add `com.apple.developer.usernotifications.critical-alerts` to `app.json`, and
  rebuild. No scheduling code changes.

  **Do not set that flag speculatively.** iOS treats a request for an unentitled
  authorization option as an error on the *whole* request, so a build that asks
  for critical alerts without the entitlement can lose alert, sound and badge
  along with it — a far worse outcome than the level it was reaching for. The
  flag gates the request for exactly this reason.

  *Original text:* Entitlement in `app.json`, and request the permission at
  runtime alongside the existing call in `_layout.tsx:44`.
  *(~2h, gated on P0.2 approval)*
- **5.4 — Server-side caregiver escalation.** EventBridge schedule → small
  Lambda. Per D-3 the threshold is per-reminder and per D-6 it anchors on the
  snooze if there was one, so the query joins `medication_doses` to
  `medication_reminders` and selects rows where `escalation_enabled`,
  `confirmed_at IS NULL`, `escalated_at IS NULL`, and

  ```sql
  COALESCE(snoozed_until, scheduled_for)
    + ((escalation_level + 1) * escalation_delay_minutes || ' minutes')::interval
    < now()
  ```

  Per D-8 this is a two-rung ladder, and `escalation_order` decides which rung is
  which: `caregiver_first` sends push-to-caregiver at level 1 and SMS-to-patient
  at level 2; `sms_first` reverses them. Increment `escalation_level` and set
  `last_escalated_at` **before** dispatching, so a retry or a concurrent run
  can't double-send. Stop at level 2.

  **Channel fallback (D-8).** If the rung's configured channel is unavailable —
  SNS still sandboxed, patient's number unverified, caregiver has no registered
  push token — dispatch the *other* channel for that rung rather than skipping
  it, and log the substitution. Silently doing nothing because a setting points
  at an unavailable transport is the failure this whole phase exists to remove.

  **Unbounded snooze is a hole here.** Each snooze pushes the anchor forward, so
  a patient who snoozes repeatedly never triggers escalation — which is exactly
  the scenario the feature is for. `snooze_count` exists in 2.2 for this;
  recommend escalating regardless once it exceeds a small threshold (3 is a
  reasonable starting point). Flagged as an open decision rather than assumed.

  This is the layer that survives the dependent's phone being off entirely,
  which 4.2 cannot. Needs a caregiver notification channel — push token storage,
  or 5.5.

  **Coordinating with 4.2.** Both paths key off the same delay, so in the normal
  case they'd fire together. Give this job a small grace period beyond the
  configured delay (~2 minutes) so the device-local alarm normally wins, and
  have the caregiver's device mark `escalated_at` best-effort when its alarm
  fires. If the caregiver's device is offline, both fire and the caregiver is
  notified twice — an acceptable failure, and the right direction to fail in.

  *(~1–2 days including infrastructure)*
- **5.5 — SMS escalation** *(required under D-8, was optional)*. One of the two
  configurable rungs, not a nice-to-have. Keep medication names out of the
  message body for the same reason as 4.2's lock-screen note — an SMS is
  readable on a locked phone and on any device sharing the number. SNS SMS is
  already being provisioned in
  `ap-east-2` for signup verification (`MIGRATION.md` Track B). Once out of the
  sandbox the same channel can carry an escalation, with failure modes
  independent of both push and local notifications. Gated on B0/B1. *(~4h)*
- **5.6 — Schedule N occurrences ahead** *(now recommended, not optional)*.
  *(DONE — policy half session 5, wiring session 6. `utils/notification-budget.ts`
  decides the horizon and the cost model; `utils/alarm-schedule.ts` lays the
  alerts out; `use-notification-sync.ts` computes one plan per pass and
  `notification-helper.tsx` writes it. 63 tests across the two modules.*

  *Four decisions the text below does not make. **The occurrence segment is a
  date, not an index** — an index is relative to the pass that wrote it, which
  reintroduces the collision one level up (§0.6). **The chain-forward became a
  full rewrite of the forward horizon**, not a no-op and not an append, because
  only a rewrite repairs the gap left by days that fired while the app was not
  running. **The budget is remembered on the device**, because three callers
  schedule a single reminder after a user action and none of them can compute
  one. And **the horizon is clamped to `DOSE_HORIZON_DAYS`**, so the device never
  holds an alarm for a day 5.1 has materialised no dose row for — otherwise 5.7's
  missed list disagrees with what actually rang.)*

  Currently one occurrence is scheduled and re-armed when it fires, so a broken
  chain stops the alarm until the app is next opened. Scheduling ~7 days ahead
  degrades gracefully instead.

  **D-1 makes the iOS 64-pending-notification cap a real constraint rather than a
  theoretical one**, because a caregiver's device holds their own alarms plus an
  escalation alarm for each dependent reminder with `escalation_enabled` (D-3
  keeps this well below a full mirror, but it is no longer just their own).
  **D-9 then multiplies the whole thing by `alarm_repeat_count`**, and this is
  what makes the cap genuinely binding rather than merely worth noting. Three
  medications taken three times daily with the default burst of 3 is 27
  notifications *per day*, which fits roughly two days of look-ahead inside 64
  slots — not seven.

  Budget explicitly:

  ```
  (own reminders × alarms each × alarm_repeat_count
     + dependents' escalation-enabled reminders)
  × days ahead  ≤  64
  ```

  **Priority rule when it doesn't fit: audibility before horizon.** Reduce the
  look-ahead first and keep the full burst, because an alarm the patient sleeps
  through today is a worse failure than one that stops working on day five —
  the launch re-sync (4.1) and silent push (5.9) both exist to repair the
  horizon, and nothing repairs an alarm that wasn't heard. Hold a floor of two
  days; below that, start trimming the burst instead. Then own alarms before
  dependents', dependents by soonest dose, then truncate. Log every truncation —
  a silently shortened horizon is exactly the kind of invisible degradation this
  phase exists to eliminate. *(~4h)*

- **5.7 — Missed dose list** *(D-4)*. *(DONE — server half session 3, client half
  session 4. `missedDoses` in `utils/doses.ts` with 13 tests; a section on
  `medications.tsx` above the reminder list, rendered only when non-empty;
  `medications.missedTitle` / `missedSubtitle` / `missedFootnote` in both locale
  files.*

  *Four decisions the text below does not make. **A dose still inside its snooze
  is not yet missed** — the patient answered the alarm and asked for it later,
  and listing it meanwhile is precisely the reprimand this item asks the list not
  to be. **The section disappears when empty** rather than saying "0 missed",
  because a permanent panel turns a record into a scoreboard. **The tone is
  carried by the styling as much as the words** — a neutral slate surface rather
  than the error red used elsewhere on that screen, a clock rather than an alert
  triangle, and no count in the heading. And **the footnote says not to act on
  it**: D-2 means take-late-versus-skip is a clinical judgement the software does
  not have, so it points at a doctor or pharmacist instead of implying the dose
  should be taken now.*

  *A failed fetch leaves the previous list standing rather than clearing it: an
  empty section is a claim that nothing was missed, and a network error is not
  evidence of that. §0.6's phase caveat is unfixable here and is noted in the
  code — trust this for daily reminders until a reminder anchor date exists.)*

  `GET /medication-doses?from=&to=` returning
  materialised doses with their confirmation state, scoped through `checkAccess`
  like every other route so a caregiver sees a dependent's list. Client: a
  section on the medications screen, or a filter on it, showing unconfirmed past
  doses. Should read as a record rather than a reprimand — the users are people
  who missed a dose, often elderly, and the tone matters. Locale keys in both
  files. *(~4h)*

- **5.8 — Push token infrastructure** *(required, not optional)*.
  *(**HALF DONE — session 4.** The item splits cleanly and was split
  deliberately, because the two halves have very different readiness.*

  ***Done — registration.*** *2.5's table; `POST /push-tokens` upserting on the
  token and reassigning its owner; `DELETE /push-tokens` scoped by owner as well
  as token; `utils/push-token.ts`; registration on sign-in from `_layout.tsx` in
  its own effect; unregistration on sign-out from `AuthContext`, before
  `signOut()` because it needs the session to authenticate. 12 route tests.*

  ***Not done — sending, which is the larger half.*** *The Expo push call, the
  tickets it returns, the separate receipts poll, and deleting tokens Expo
  reports as `DeviceNotRegistered`. **Build it as 5.4's dispatch step, not as a
  standalone module** — it has no caller until 5.4 or 5.9 exists, and a sender
  written without one is a sender written against a guess.*

  *Two things decided along the way that the text below does not cover.
  **Sign-out unregisters**, which the item never mentions: a token outlives the
  session, so without it the previous user's escalations keep arriving on a phone
  somebody else may now be holding. And **registration is not retry-queued** the
  way 4.4's dose actions are — it re-runs on every launch, so the retry is
  already there for free.*

  *Not deployed and the table is not live — §0.7 item 2.)*

  D-5 puts push
  on the critical path for **every** user, not just caregivers: the silent
  schedule-change push (5.9) targets patients. So this is groundwork for two
  features, and the token record is simply "a device belonging to whoever is
  logged in" — no caregiver special-casing.

  `Notifications.getExpoPushTokenAsync()` returns a token per device (needs the
  EAS `projectId`, already in `app.json`). The Lambda POSTs to Expo's push
  service, which fans out to APNs and FCM — no SNS platform application, no
  certificate management. What it entails beyond the happy path:

  - `push_tokens` table (2.5): `user_id`, `token`, `platform`, `last_seen_at`,
    unique on token. One user may have several devices; send to all of them.
  - `POST /push-tokens` called on launch after permission is granted, refreshing
    `last_seen_at`.
  - **Rotation and death.** Tokens change on reinstall and can be invalidated
    silently. Expo returns `DeviceNotRegistered` for dead tokens and you must
    delete them on receipt, or you accumulate addresses that fail quietly —
    precisely the silent-failure mode this whole phase exists to remove.
  - Sending returns *tickets*; delivery status arrives via a separate *receipts*
    poll. Receipts confirm hand-off to APNs/FCM, **not** display. Log them —
    they're the only delivery observability in the system.
  - Payloads pass through Expo's servers and then Apple's or Google's. Keep
    medication names out; send an identifier and resolve detail in-app,
    consistent with 4.3 and the lock-screen note in 4.2.

  *(~1 day)*

- **5.9 — Silent push on schedule change** *(D-5)*. Any write to a reminder
  (create, edit, toggle, delete) sends a data-only push to the owner's devices;
  the client handles it by running the same reconciliation as 4.1. This is the
  only server→device channel in the system and it's what makes a caregiver's
  edit reach the patient's phone without waiting for an app open.

  Treat as an optimisation, never a guarantee: silent pushes are rate-limited on
  iOS and Doze-affected on Android, and may simply not arrive. The launch-time
  re-sync in 4.1 remains the backstop and must not be removed on the assumption
  that this replaces it. *(~4h)*

### On the two escalation channels

Both are now first-class under D-8, and they fail independently — which is the
point. Push needs a live token and a device that's online; SMS needs neither, but
costs per message, and is gated on Track B leaving the SNS sandbox.

Sequencing note: D-5 already puts push on the critical path for 5.9, so the token
infrastructure (5.8) is built regardless and `caregiver_first` is deliverable
first. `sms_first` cannot ship until Track B clears **and** phone numbers are
actually verified — see the constraint in D-8. Build the ladder so the order is
data-driven from day one, but expect to ship with only one rung reachable.

---

## 9. Phase 6 — Error contract

One string comparison is the entire taxonomy (`backend/index.mjs:411`):
`Access Denied` → 403, everything else → 500 carrying `err.message`. Deliberate
4xx conditions (`"Agent not found"`, `"Security Mismatch"`) surface as 500s with
internal English prose. Because the app ships en/zh-Hant, these **cannot be
translated** — there is no code to key a translation off.

- **6.1** Typed errors with codes and correct statuses. Mirror the admin
  Lambda's shape: `{ error, code, problems? }` (`dashboard/server/index.mjs`).
  *(~3h)*
- **6.2** Map codes to i18n keys client-side; add keys to both locale files. CI
  enforces parity. *(~2h)*

Lowest urgency here, but it is the item that most directly addresses the
"error handling across the stack" framing if that matters for write-ups.

---

## 10. Open decisions

D-1 through D-7 are settled (section 2). Still outstanding:

1. ~~**Snooze cap.**~~ **ANSWERED 2026-07-31 — threshold 3.** The owner took the
   recommendation. Recorded as **D-12** in §2 and implemented as
   `SNOOZE_ESCALATION_THRESHOLD`; 5.4 must read it rather than re-deciding.

2. ~~**The migration runner now has three customers.**~~ **ANSWERED and BUILT,
   session 5** — the owner's instruction was to set the existing users' timezone
   and locale to defaults and carry on, so the runner was built rather than
   deferred a fifth time. `tish-migrate`, migration `005`, both columns live on
   both rows. `push_tickets` (the third customer, for 5.8's receipts poll) is now
   cheap whenever 5.9 or a receipts pass wants it: one `.sql` file and one
   invoke. Original text follows.

   ---

   **The migration runner now has three customers, and its
   priority is your call.** It has been deferred four times, each time correctly:
   a reset was always cheaper than building it. That reasoning is wearing out,
   because the things that need it are accumulating and none of them are
   reachable by a reset:

   | Wants it | Why a reset cannot do it |
   |---|---|
   | `users.timezone` (§0.6) | `users` is preserved, so it never picks up a column from a rebuild. `APP_TIMEZONE` is a constant standing in for it |
   | `users.locale` (§0.6) | same table, same reason. The server picks zh-Hant for every push |
   | `push_tickets` (5.8's receipts poll) | a new table *could* come from a reset, but only at the cost of the doses and reminders each time |

   The first two are the real argument: they are wrong the moment one patient
   travels or the product ships outside Taiwan, and **no amount of resetting will
   ever fix them.** The third would merely be convenient.

   Against: it is half a day, nothing is broken today, and D-11 still holds.
   Estimated at half a day in §0.7 item 1, which also has the design — a
   throwaway VPC-attached Lambda using the Lambda security group. **Not urgent,
   but no longer free to keep deferring**, and worth deciding deliberately rather
   than defaulting to "next time".

**Nothing else is outstanding here.** Two questions that arose in session 3 and
were resolved rather than left open: whether `user_relationships` should survive
a reset (yes — see D-11), and whether to block on Apple's Critical Alerts
entitlement (no — see 5.3 and P0.2). Two more from session 5, both answered by
the owner at the time: how `push_tokens` reached the database (reset), and
whether to buy a NAT gateway for 5.4 (no — two Lambdas instead).

---

## 11. Suggested order

**P0.1 is deferred to a separate security plan** — see the note under it. This
ordering is functionality only.

> **This ordering is the original plan and is not kept up to date — §0.2 is.**
> Read the ledger first, then use the list below only to decide what comes next
> among the items still marked `—`.
>
> Two things learned in session 1 change the sequencing, though:
>
> - ~~**P0.3 is now the binding constraint.**~~ **Done in session 2.** It cleared
>   4.7b, 4.7c and 5.2, declined 4.7d, and added 4.7e — which carries a deadline
>   (before the next native build) that nothing else in the plan does. See D-10.
> - **Testing against the deployed stack is sanctioned** (see §1), so items that
>   could previously only be verified "as far as possible locally" — the reset
>   flow against Cognito, migrations against RDS, SNS/SES behaviour — should now
>   be confirmed for real rather than reasoned about.

1. **P0.2, P0.3** filed and started immediately — both have external lead times
   and block later items, so they should be running while other work proceeds.
2. **4.7a** out of order, on its own. One missing sound asset is the difference
   between the core feature working and only appearing to. Small, isolated, no
   dependencies.
3. **Phase 1** as one batch with tests.
4. **Phase 2** (2.1 first — nothing schema-related can proceed without it).
5. **4.8**, next-highest functional value: the app currently confirms
   meal-relative reminders that never fire.
6. **Phase 4** remainder — 4.1 and 4.3 before 4.2, since a working reconciliation
   is the foundation the multi-user sets build on.
7. **Phase 3.** Do **3.5 and 3.6 first** — there is currently no password reset
   in the app at all, which affects live TestFlight testers, and the admin-forced
   reset that is the only workaround dead-ends silently on the login screen. Then
   3.1 (an authorization fix; move it if it reads as security under the new
   split), then 3.2 (revocation doesn't exist) and 3.3.
8. **Phase 5**, 5.1 before 5.4 and 5.7; 5.8 before 5.9.
9. **Phase 6** when convenient.

Rough totals: **~7 days** excluding 5.4/5.5 infrastructure; **~13 days** with the
full delivery layer. D-1 added roughly a day to Phase 4; D-3 about half a day
across 2.4 and 4.6; D-4 about a day across 5.1 and 5.7; D-5 about a day and a
half across 2.5, 5.8 and 5.9; D-8 about half a day across 2.4, 4.6 and 5.4, and
promotes 5.5 from optional into the critical path; D-9 about two days across 2.6,
4.7 and 5.6, plus an hour on the P0.3 spike.

4.8 and the 4.3 expansion add roughly another day and a half between them. The
second review pass (1.13–1.18, 3.5, 3.6) adds about two days more.

**The three items to do first, if nothing else ships:** **3.5**, because there is
no password reset in the app and a locked-out tester has no route back in;
**4.7a**, because the
notification sound file it references does not exist, so the alarm is quieter than
designed on every Android device today and the sound users pick does nothing
outside the app; and **4.8**, because meal-relative reminders are collected,
stored, and displayed back to the patient without ever being scheduled. Both are
small relative to their effect, and both concern whether the core feature actually
does what the interface says it does.

Three dependency chains worth keeping in view:

- **2.1 → 2.4 → 4.6 → 5.4.** The escalation job can't be built before the
  per-reminder settings exist, and those can't be added before there's a way to
  migrate schema at all.
- **2.2 → 5.1 (materialisation) → 5.4 and 5.7.** Escalation and the missed list
  both depend on expected doses existing as rows. This is the item most likely to
  be skipped by someone reading only the section headings, because it looks like
  it belongs to the confirmation feature rather than being load-bearing for two
  others.
- **2.5 → 5.8 → 5.9 and 5.4.** Push tokens underpin both the silent
  schedule-change push and caregiver escalation, so 5.8 is groundwork for two
  features rather than part of either.
