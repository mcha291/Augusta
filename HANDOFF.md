# Handoff — paste the block below into a new session

Everything below the line is the prompt. `PLAN.md` §0 carries the detail; this
only has to get a cold session to the right starting point without re-deriving
what session 11 already established.

---

Read PLAN.md, starting with §0 (Progress) — it is the ledger and the only part
that tracks what is actually done. Read the guardrails in §1 before deciding
anything is too risky to try.

**There is one decision waiting for you: whether to merge the open PR.** Nothing
else is owed.

## State in one paragraph

Session 11 built the project's first test layer that runs native code — Maestro
E2E against a real iOS build — and, in the course of getting a test account, found
that **user registration had been broken for everyone** and fixed it. Both E2E
flows are green on iPhone 17 Pro / iOS 26.4. A TestFlight build (number 10) was
submitted at the end of the session.

## ⚠ Not merged

Seven commits sit on **`e2e-maestro-ios`**, pushed, with an open PR whose CI is
green. `main` is at `ec25847` and **does not have the registration fix**. If you
start from `main` you will be working on a tree where signup is still broken.
Merging is the owner's call — ask.

`opus 5 vs 4.8.txt` at the repo root is deliberately untracked; it is a scratch
file from an unrelated project.

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
- **iOS E2E green.** `.github/workflows/e2e-ios.yml` on a GitHub `macos-26`
  runner. Not EAS: `maestro` jobs there need a paid plan, and this repo is public
  so GitHub's macOS runners are free. `tish-app/.eas/workflows/` holds the EAS
  equivalents, parked, for if the project ever goes paid.
- **Test account `maestro`** exists in the pool, confirmed, email verified, with a
  matching RDS row (`id: 4`). Its credentials are GitHub repo secrets
  `MAESTRO_USERNAME` / `MAESTRO_PASSWORD`. The flows sign in against the **live**
  backend — `API_BASE_URL` is a hardcoded production URL.
- **TestFlight build 10** was built and auto-submitted at the end of the session.
  Confirm it actually reached App Store Connect rather than trusting this line.

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
