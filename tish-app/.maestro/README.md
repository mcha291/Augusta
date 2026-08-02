# End-to-end flows (Maestro)

Maestro drives the real app on a real emulator or simulator. It is the only
layer of the test pyramid here that runs native code — the 209 client tests in
`utils/` and the 266 in `backend/` are all pure-module tests that stop at the
first `expo-*` or `react-native` import.

## What these cover, and what they deliberately do not

Two flows today, both smoke-level, both green on iPhone 17 Pro / iOS 26.4:

| Flow | What breaks it |
|---|---|
| `01-sign-in.yml` | Amplify misconfiguration, a Cognito pool change, `/me` returning 500, `AuthContext` failing to populate |
| `02-tab-navigation.yml` | Any of the four tab screens throwing on mount |

**Not covered: whether an alarm actually fires.** That is the app's highest-risk
behaviour and the reason Maestro was chosen over Playwright — but it needs a
scheduled notification to come due, and Maestro cannot move the device clock.
Reaching it means either seeding a reminder a minute out and waiting, or an
`adb`-driven clock change on Android only. Neither is written yet; the
`notification-budget`, `alarm-schedule` and `notification-identifiers` unit
suites remain the real coverage for *when* an alarm is due.

## Selectors

Match on `testID`, never on visible text. The app ships `en` and `zh-Hant`, so
a flow matching "Medications" passes in English and fails the moment the device
locale changes. The IDs in use:

- `login-identifier`, `login-password`, `login-submit` — [`app/login.tsx`](../app/login.tsx)
- `tab-index`, `tab-appointments`, `tab-medications`, `tab-results` — generated
  from the route name by `getTestID` in [`app/(tabs)/_layout.tsx`](<../app/(tabs)/_layout.tsx>)
- `screen-home`, `screen-appointments`, `screen-medications`, `screen-results` —
  the root `View` of each tab screen

Adding a flow that touches a new control means adding a `testID` to that
control first.

## Credentials

Flows read `MAESTRO_USERNAME` and `MAESTRO_PASSWORD`. Maestro automatically
exposes any `MAESTRO_`-prefixed shell variable to a flow under the same name,
so nothing needs passing on the command line and no credential is ever
committed.

The account must already exist — `sign-in.yml` signs in, it does not register.
`launchApp: clearState: true` wipes app data on every run, so the account
accumulates nothing between runs.

## Checking flows without a device

```bash
npm run e2e:check
```

Runs `maestro check-syntax` over every flow. Needs no emulator, no build and no
credentials, so it belongs next to `npm test` and `tsc --noEmit` in the normal
loop — it catches a typo'd command in a second instead of twenty minutes into
an EAS run. It verifies only that Maestro can parse and understand each step;
it says nothing about whether selectors exist or a flow passes. If Maestro is
not installed it prints a notice and exits 0, so a fresh checkout is unaffected.

## Where these actually run

The project ships iOS first, and **an iOS simulator needs macOS** — this is a
Windows machine, so the flows cannot be run against iOS locally at all. That
single fact determines the whole setup:

| | Where | Status |
|---|---|---|
| **iOS** | [`.github/workflows/e2e-ios.yml`](../../.github/workflows/e2e-ios.yml), GitHub macOS runner | **Live.** PRs touching the app, plus manual dispatch |
| iOS via EAS | [`.eas/workflows/e2e-test-ios.yml`](../.eas/workflows/e2e-test-ios.yml) | Parked — `maestro` jobs need a paid EAS plan |
| Android | [`.eas/workflows/e2e-test-android.yml`](../.eas/workflows/e2e-test-android.yml) | Parked until after the security refactor |

EAS has a purpose-built `maestro` job and the workflow for it is written and
ready, but it requires a paid plan — `eas workflow:validate` rejects it with
exactly that message. GitHub's macOS runners are free and unmetered for public
repositories, which buys the same test for nothing. If the project ever moves
to a paid EAS plan, the EAS workflow is the better home: it handles simulator
provisioning, sharding, retries and video capture that the GitHub Actions
version spells out by hand.

**Before the first CI run**, add two repository secrets (Settings → Secrets and
variables → Actions): `MAESTRO_USERNAME` and `MAESTRO_PASSWORD`. The workflow
fails with an explicit message rather than a confusing timeout if they are
missing. `MAESTRO_APP_ID` is set by the workflow itself, since the iOS bundle
ID (`com.ti-smarthealth.app`) and Android package (`com.mcha2910.tish`) differ.

**The iOS simulator build is known to work.** EAS build `77329077` produced one
in 4m20s from the `e2e-test` profile on 2026-08-01 — the first time this app had
ever been compiled for iOS. The `with-exact-alarms` plugin is
`withAndroidManifest`-only, so it correctly no-ops rather than breaking the
build. If the GitHub runner's own `expo run:ios` step turns out to be slow or
flaky, the fallback is to build on EAS instead and have the runner download the
artifact — at 4 minutes a build that is the faster half of the job, though it
draws on the free plan's build quota on every run, which building on the runner
does not.

Note the flows sign in against the **live** backend — `API_BASE_URL` in
`constants/config.ts` is a hardcoded production API Gateway URL, so the test
account's data goes to the same place as everyone else's.

## What actually bit on iOS, and what didn't

Both flows pass on iPhone 17 Pro / iOS 26.4. Two things caused real failures,
and neither was one of the upstream bugs anticipated up front.

**1. The keyboard covered the submit button.** With the keyboard up,
`login-submit` occupies y=531..587 while the keyboard starts at y=539, so the
button's centre is underneath it. Maestro still reports `tapOn` as COMPLETED —
the element it targeted is present and on screen, merely occluded — and the tap
lands on the keyboard. `handleLogin` never ran, so there was no network call, no
error alert, and no navigation, which made it look like a selector or
credentials problem for three runs.

`sign-in.yml` presses Return to blur the last field rather than calling
`hideKeyboard`, which Maestro documents as unreliable on iOS.
`scrollUntilVisible` alone is *not* enough: scrolling does not dismiss a
keyboard.

**2. iOS offers to save the password.** A system dialog appears a second or two
after a successful credential submission and covers the app. It is dismissed in
the subflow, optionally and with a wait before the tap, because it does not
appear every time — notably not on a fresh simulator's first sign-in, which is
why it failed the second flow of a run but not the first. Suppressing it at the
simulator level was not attempted: recent iOS is reported to show it even with
password AutoFill disabled.

**Anticipated and never observed**, so do not design around them without
evidence:

- [expo/eas-cli#3153](https://github.com/expo/eas-cli/issues/3153) — the
  `inputText` hang under the new architecture. Both fields type cleanly.
- [maestro#3318](https://github.com/mobile-dev-inc/maestro/issues/3318) — the
  XCUITest driver dropping between flows. The workflow still runs one flow per
  invocation, which is cheap insurance, but the batch failure never appeared.

**testIDs on plain container `View`s do resolve on iOS.** `screen-home` and the
three other screen roots assert fine. An earlier version of these flows assumed
the opposite — that XCUITest drops containers because they are not accessibility
elements — and that assumption was wrong; the dialog above was the real cause of
the one result that seemed to support it.

## Running locally (Android only, parked)

Kept for whenever Android comes back. Maestro 2.8.0 runs natively on Windows —
no WSL — and is installed at `C:\maestro`; Java 17, the Android SDK and an AVD
(`Medium_Phone_API_36.1`) are all already present.

**`C:\maestro\bin` still needs adding to PATH** — through **System Properties →
Environment Variables**, not `setx PATH "%PATH%;..."`, which truncates at 1024
characters and merges the system PATH into the user PATH. Until then:

```bash
$env:PATH = "C:\maestro\bin;$env:PATH"
```

Then build an APK (`eas build --profile e2e-test --platform android`), install
it with `adb install`, set `MAESTRO_USERNAME` / `MAESTRO_PASSWORD` in the shell,
and run `maestro test -e MAESTRO_APP_ID=com.mcha2910.tish .maestro`.

Useful during authoring: `maestro studio` opens an inspector that shows the
live view hierarchy and the selector for anything you click.
