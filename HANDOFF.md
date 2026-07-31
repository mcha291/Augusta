# Handoff — paste the block below into a new session

Everything below the line is the prompt. `PLAN.md` §0 carries the detail; this
only has to get a cold session to the right starting point without re-deriving
what session 4 already established.

---

Read PLAN.md, starting with §0 (Progress). It is the ledger and the only part
that tracks what is actually done. §0.3 says what comes next; §0.6 is the list of
places the plan turned out to be wrong, and it is worth reading before trusting
any section below §2 — session 4 added eight entries to it.

**Nothing is half-edited.** But unlike the last handoff, this one is not a clean
"just start the next feature": there is **one decision I need from you and a
deploy that depends on it**, and it should be settled before any new backend work.

## Start here — the decision, §0.7 item 2

`push_tokens` (2.5) and `POST`/`DELETE /push-tokens` (5.8's registration half)
are written, tested and **not live**. The table has to reach the Taipei database
and there are two real options:

- **`/reset-db` + `/seed-data`** — cheapest. Recommended. It costs
  `medication_reminders` and `medication_doses`, which today means reminder 1 and
  its 16 doses. That fixture was worth protecting when it was the only way to test
  4.4 and 5.7; both are now built, and one `POST /medication-reminders` recreates
  it with its doses materialising automatically. `users`, `genders`, `conditions`
  and `user_relationships` all survive, so the caregiver link (user 1 → user 2)
  is kept.
- **Build the VPC-attached migration runner** — half a day, and genuinely owed:
  `users.timezone` (§0.6) cannot be added any other way. But it is worth doing
  deliberately rather than under pressure for a table a reset creates for free.

**Do not** add a migration route to the API — that recreates the P0.1 class of
problem.

The ordering risk here is contained, unlike the `alarm_labels` incident:
`push_tokens` is read by exactly one *new* route, so deploying the Lambda before
the table exists breaks only `POST /push-tokens`, and the client swallows that by
design. Deploy-then-create is safe in this specific case. It is not the general
rule.

Once that is settled: rebuild the zip, deploy, and verify `CodeSha256` against
**the zip you just uploaded** — not a fresh rebuild, the hash is not stable
across builds (§0.6). Then probe `POST /push-tokens`.

## Then — 5.4, server-side caregiver escalation

**It is blocked on nothing but work now**, which is new. 5.1 materialises the
rows it queries, 4.4 keeps `snooze_count` honest enough for D-12's circuit
breaker, and 5.8's registration half gives it somewhere to send. §8 has the query
and D-8's two-rung ladder.

**Build 5.8's send half as 5.4's dispatch step, not as a separate module.** The
Expo push call, the tickets it returns, the receipts poll and dead-token reaping
have no caller until 5.4 exists, and a sender written without one is written
against a guess. §0.3 says the same thing.

This is the first item in a while that adds infrastructure (EventBridge + a small
Lambda) rather than only code.

## State you can rely on

- **Tests: 129/129 backend, 100/100 client.** `tsc` clean, eslint 0 errors (41
  pre-existing warnings, none new), translations 325 keys. The app bundles —
  1866 modules, login screen renders, empty error console.
- **The deployed Lambda is behind the tree** by exactly 2.5 + `/push-tokens`.
  Every route that was live still is and none of them changed.
- **The live database still has the session-3 fixture** — reminder 1 for user 1,
  200mg at 08:00 and 20:00 daily, 16 doses, one confirmed — unless you take the
  reset option above.
- **Nothing is committed.** Sessions 1–4 all sit in the working tree on `main`,
  ~60 files.

## Before starting any item, check the described state against the code

§0.6 now records nineteen places this plan was already out of date or incomplete.
Sections §3–§9 describe the *original* defects and are deliberately not updated
as work lands.

Three limits recorded there that will bite whoever touches this next:

- **`APP_TIMEZONE` is a constant, not a `users.timezone` column**, because
  `users` survives `/reset-db` and so cannot pick up a column from a rebuild. It
  needs the migration runner that has never been built.
- **The materialised window is anchored on today**, exact for
  `frequency_days = 1` and only approximate for longer intervals. The missed list
  is trustworthy for daily reminders only.
- **The device and 5.4 will disagree about snoozed doses.** 4.2 item 4's
  confirmed-check deliberately treats a snoozed dose as still escalatable rather
  than mirroring D-12's threshold on the device. Expect a duplicate escalation in
  that window and do not read it as a bug — decide in 5.4 whether to close it.

## Constraints

- **Do not commit or push unless I ask.**
- **Backend deploys are manual.** Rebuild the zip (stage `index.mjs` +
  `package.json` + `package-lock.json`, `npm ci --omit=dev`, zip those plus
  `node_modules` with forward-slash entry paths, resolving the staging directory
  to its long path first — the `SEMAPH~1` short form mangles every entry). Deploy
  with `aws lambda update-function-code`.
- **`aws login` expires often.** Check `aws sts get-caller-identity` before any
  AWS work; if it has lapsed, ask me and wait rather than working around it. It
  was valid at the end of session 4.
- Tests: `cd tish-app/backend && npm test` (129) and `cd tish-app && npm test`
  (100). Extend coverage rather than renumbering assertions.
- Any new user-facing string needs a key in **both** locale files.
- `/debug/*` is unauthenticated by my deliberate choice — `/debug/users`,
  `/debug/link?caregiver=&dependent=`, `/debug/unlink?all=1` and the rest are
  bookmarkable. Recorded under P0.1; do not widen it further without asking.

## Not verified, and why

Everything native-only is still unverified on a device, and the list has grown:
the alarm burst (4.7b), the iOS interruption level (5.3), all three notification
sounds (4.7a), the Android channel (4.7e), exact alarms (5.2), and now **4.4's
snooze alarm actually firing**, **4.7c's tray dismissal**, and **5.8's token
registration** — `getExpoPushTokenAsync` cannot run on web or a simulator, so
nothing has ever produced a real token. **They all need one native rebuild**,
which has not been made since the `app.json` plugin changes. That rebuild is the
single highest-value verification step available and it is mine to trigger, not
yours.

Also unverified: 4.2's attribution line, the delayed caregiver escalation, and
5.7's missed-dose section, which all need a signed-in session on a device. Ask me
for a screenshot rather than attempting to sign in.

## Open questions

§10 is empty. The only thing needing a decision is §0.7 item 2 above, which is a
sequencing choice rather than a design one. If something else needs deciding, ask
rather than assuming, and add it to §10.
