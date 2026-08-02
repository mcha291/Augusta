# Handoff — paste the block below into a new session

Everything below the line is the prompt. `PLAN.md` §0 carries the detail; this
only has to get a cold session to the right starting point without re-deriving
what session 11 already established.

---

Read PLAN.md, starting with §0 (Progress) — it is the ledger and the only part
that tracks what is actually done. Read the guardrails in §1 before deciding
anything is too risky to try.

**Two things are waiting, both cost or credential decisions the owner has to
make: a failed TestFlight build needing an Apple portal action, and a CI setup
that stopped being free when the repository went private.**

## ⚠ TestFlight build 10 failed — provisioning profile is stale

`eas build --platform ios --profile production --auto-submit` failed in fastlane:

```
Provisioning profile "*[expo] com.ti-smarthealth.app AppStore 2026-07-15..."
  doesn't include the Time Sensitive Notifications capability
  doesn't include the com.apple.developer.usernotifications.time-sensitive entitlement
```

**Not a regression.** `app.json` gained that entitlement in `e7c3cf1` on
2026-07-31 at 14:39; the last successful production build (number 9) started the
same day at 02:34, twelve hours earlier, and the provisioning profile dates from
2026-07-15. Build 10 is simply the first production build to exercise it, and the
profile predates it by two weeks.

The fix needs an Apple login, so it is the owner's:

1. Try regenerating the profile first — EAS syncs capabilities from the
   entitlements when it creates a *new* profile, so this may be sufficient on its
   own:
   ```
   cd tish-app && npx eas-cli credentials
   ```
   iOS → production → Build Credentials → regenerate the provisioning profile.
2. If it still fails, the capability is not enabled on the App ID. Apple Developer
   portal → Identifiers → `com.ti-smarthealth.app` → enable **Time Sensitive
   Notifications**, then repeat step 1.
3. Then rebuild: `npx eas-cli build --platform ios --profile production --auto-submit`

Worth knowing why it matters beyond the build: the entitlement is what makes
5.3's `interruptionLevel: 'timeSensitive'` work, which is how a medication alarm
breaks through Focus modes. A build without it degrades silently.

## State in one paragraph

Session 11 built the project's first test layer that runs native code — Maestro
E2E against a real iOS build — and, in the course of getting a test account, found
that **user registration had been broken for everyone** and fixed it. Both E2E
flows are green on iPhone 17 Pro / iOS 26.4. A TestFlight build (number 10) was
submitted at the end of the session.

## Merged

Session 11's nine commits were rebased onto **`main`** (`ec25847..8db80fb`), so
`main` has the registration fix. The `e2e-maestro-ios` branch still exists and
now points at pre-rebase SHAs; it is safe to delete.

`opus 5 vs 4.8.txt` at the repo root is deliberately untracked; it is a scratch
file from an unrelated project.

## ⚠ The repository went private, and that breaks the CI plan

It was public for most of session 11 and is now private. This matters more than
it sounds, because **the choice to run E2E on GitHub Actions was made *because*
the repo was public**: standard runners are free and unmetered for public repos,
which made GitHub's macOS runners a free alternative to EAS's `maestro` job,
which needs a paid plan.

On a private repo that is no longer true. Minutes come out of the plan allowance
and **macOS bills at 10× wall-clock**, so one ~25-minute iOS E2E run consumes
roughly 250 minutes of allowance. A free plan's 2,000 minutes/month is about
eight runs, and session 11 alone used more than that.

Runs after the switch fail in 3–11 seconds with **no failed step**, on ubuntu as
well as macOS — the signature of an exhausted allowance or a spending limit
rather than anything in the code. The last run on real runners was green.

Three ways out; the owner has to pick, and it is a cost decision, not a technical
one:

1. **Make the repo public again** — restores free unmetered runners, changes
   nothing else.
2. **Pay for GitHub Actions minutes**, budgeting for the 10× macOS multiplier.
3. **Pay for EAS and un-park `tish-app/.eas/workflows/e2e-test-ios.yml`** — it is
   written, and its `maestro` job handles simulator provisioning, sharding,
   retries and video capture that the GitHub Actions version spells out by hand.

Until one is chosen, **iOS E2E cannot run in CI**. The flows themselves are
unaffected and `npm run e2e:check` still validates them locally in a second.

## What changed

- **Registration was failing for every user.** `signUp()` omitted `phone_number`
  whenever `SMS_VERIFICATION_ENABLED` was false — which is always — and the pool
  marks that attribute `Required`. Every attempt returned "Attributes did not
  conform to the schema". The omission was deliberate and could never have
  worked: a required attribute cannot be omitted, and `Required` cannot be
  changed after a pool is created.
- **A live Cognito change was made.** `phone_number` was removed from
  `AutoVerifiedAttributes` on `ap-east-2_Z97Td3kcS`, leaving `email` alone there,
  so codes go by email even though a number is now always sent. Cognito forces
  `AttributesRequireVerificationBeforeUpdate` to be a subset, so that dropped to
  `["email"]` too. Applied by round-tripping the live config through
  `update-user-pool`, which resets any parameter it is not given; a before/after
  diff confirmed only those two keys moved. **Re-enabling SMS is now two changes,
  not one:** exit the SNS sandbox *and* restore `phone_number` to
  `AutoVerifiedAttributes`.
- **Profile screen can verify an email address** — needed because
  `AccountRecoverySetting` lists `verified_email` first, so an unverified account
  has no working password reset.
- **Maestro E2E**, iOS-only. See `tish-app/.maestro/README.md`; it is current and
  worth reading before touching a flow.

## State you can rely on

- **Tests: 266 backend, 209 client.** `tsc` clean, eslint 0 errors (36 warnings,
  none new), translations 383 keys across both locales.
- **iOS E2E was green** on `.github/workflows/e2e-ios.yml`, a GitHub `macos-26`
  runner — both flows passing on iPhone 17 Pro / iOS 26.4. It **cannot currently
  run**; see the private-repo section above. `tish-app/.eas/workflows/` holds the
  EAS equivalents, parked.
- **Test account `maestro`** exists in the pool, confirmed, email verified, with a
  matching RDS row (`id: 4`). Its credentials are GitHub repo secrets
  `MAESTRO_USERNAME` / `MAESTRO_PASSWORD`. The flows sign in against the **live**
  backend — `API_BASE_URL` is a hardcoded production URL.
- **TestFlight build 10 FAILED, and this is the one thing owed.** See the section
  below — it needs an Apple Developer portal action that only the owner can take.

## Tooling on this machine

- **`gh` is installed but not on PATH** in tool shells — use
  `"/c/Program Files/GitHub CLI/gh.exe"`. If `gh auth status` says logged out,
  ask and wait, same as `aws login`.
- **Maestro 2.8.0 is at `C:\maestro`, also not on PATH.** Prefix a shell with
  `$env:PATH = "C:\maestro\bin;$env:PATH"`.
- `npm run e2e:check` syntax-checks every flow in about a second, needs no
  device, and skips cleanly if Maestro is absent. Run it before pushing a flow
  change; a CI round trip is ~25 minutes.

## Diagnose CI from artifacts, not from log text

This is the most transferable thing session 11 learned. Three consecutive E2E
failures were misdiagnosed from log text — two confidently wrong root causes,
~25 minutes of CI each. The first artifact download settled it immediately,
because the UI hierarchy carries element bounds and the screenshots show what was
actually on screen.

```
gh run download <id> --name maestro-debug-output --dir <tmp>
```

Two real failures, both invisible in the logs:

1. **The keyboard covered the submit button** — `login-submit` at y=531..587, the
   keyboard from y=539. Maestro reports `tapOn` as COMPLETED because the element
   is present and on screen, merely occluded, and the tap lands on the keyboard.
2. **iOS's "Save Password?" system dialog** covered the app after a successful
   sign-in, so it hit the second flow of a run but not the first.

Both upstream bugs the flows were originally designed around —
`expo/eas-cli#3153` (`inputText` hanging) and `maestro#3318` (driver dropping
between flows) — **never appeared**. Do not design around them without evidence.
testIDs on plain container `View`s *do* resolve on iOS; an earlier assumption
that they do not was wrong.

## Known broken, deliberately parked

**The gender/condition pickers on signup are unusable on web.** `react-native-paper`'s
`Menu` mounts at `opacity: 0, scale(0)` and never animates in, leaving an
invisible full-screen backdrop, so the next tap dismisses instead of opening it.
Root cause: Paper drives its entire show/hide state machine from animation
completion callbacks, and those never fire on this web stack. **Probably web-only**
— the console reports the native animated module missing, which is not the case on
iOS — but that is unconfirmed, and opening a menu on the TestFlight build would
settle it in seconds. Seven `<Menu>` usages are affected, including
`components/profile-header.tsx`, which every tab screen renders.

A `patch-package` fix was built, verified as infrastructure, and then **reverted at
the owner's request** because it did not fix this bug — it repaired a different,
latent unresolved-promise hang in the same component. Upgrading will not help:
the code is identical in Paper 5.15.3.

## Constraints

- **Do not commit or push unless asked.**
- **Act freely against the live stack.** Only new-user signup is worth protecting
  until the security refactor lands — and note session 11 changed signup, so
  regressions there are the expensive kind.
- **Security belongs to the security plan** — do not raise it, gate on it, or
  unilaterally fix it.
- `aws login` and `gh auth login` both expire — check, then ask and wait.
- Any new user-facing string needs a key in both locale files;
  `npm run validate-translations` enforces parity.
- **Android E2E is parked until after the security refactor** (iOS-first). The
  flows are platform-neutral; restoring it is a workflow trigger and two npm
  scripts, both documented in the parked workflow's header comment.

## Next

The obvious target is an E2E flow that proves **an alarm actually fires** — the
highest-risk silent-failure behaviour in the app, and the original reason Maestro
was chosen over Playwright. It is a real design problem, not another flow file:
Maestro cannot move the device clock, so it needs either a reminder seeded a
minute out and a genuine wait, or an `adb`-driven clock change, which is Android
only and therefore parked. Worth its own session.
