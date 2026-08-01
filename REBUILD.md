# Native rebuild — what you need to do

Written at the end of session 9 (2026-08-01). This is the one thing blocking
session 10, and session 10 is the last unblocked work in `PLAN.md` apart from
5.5, which waits on SNS.

**The short version:** bump `version` in `app.json`, run one EAS build, get it
onto a real phone. Everything else here is why, and what to check afterwards.

---

## 1. Why a rebuild is needed at all

Four things have been sitting in `app.json` since sessions 1–7 that **only take
effect when a new binary is compiled**. The build currently in TestFlight is
**build 8**, commit `a6fd0c1`, and it has none of them — verified by reading
that commit's `app.json`:

| What | Plan item | In build 8? |
|---|---|---|
| `expo-notifications` plugin bundling `alarm_*.wav` | 4.7a | **no** — no plugin block at all |
| `plugins/with-exact-alarms` (Android manifest) | 5.2 | **no** |
| `com.apple.developer.usernotifications.time-sensitive` entitlement | 5.3 | **no** — `ios.entitlements` was absent |
| `UIBackgroundModes: ["remote-notification"]` | 5.9 | **no** — `ios.infoPlist` had no such key |

These are compiled into the app bundle, the entitlements file and the
`AndroidManifest.xml`. No amount of JS shipping changes them.

**The failure mode if you skip this is silence, not an error.** iOS accepts a
notification naming a sound that isn't in the bundle and plays the default chime
instead (§0.6). So a build without the plugin *looks* like it works — alarms
appear — while every custom sound, the time-sensitive interruption level, and
background silent-push delivery are quietly absent.

---

## 2. ⚠ Do this first: bump the version

`app.json` has:

```json
"version": "1.0.0",
"runtimeVersion": { "policy": "appVersion" }
```

Build 8 also has `version: "1.0.0"`. So **build 8 and your new build would share
runtime version `1.0.0`**, which means any `eas update` you publish to the
`production` channel reaches *both*. The new JS assumes native capabilities
build 8 does not have — bundled sounds, the entitlement, the background mode —
and build 8 would take that update and degrade silently in exactly the way
described above.

Change one line in `tish-app/app.json` before building:

```json
"version": "1.1.0",
```

That gives the new build its own runtime version, and build 8 stops being a
possible recipient of JS written for build 9. The number is your call — `1.1.0`
matches the amount of behaviour added since build 8 — but **do not leave it at
`1.0.0`.**

You do *not* need to touch the build number. `eas.json` has
`appVersionSource: "remote"` with `autoIncrement: true` on the `production`
profile, so EAS increments 8 → 9 for you.

I have not made this change; say the word and I will.

---

## 3. Before you build — five-minute checklist

Run from `tish-app/`:

```bash
npx expo config --type introspect
```

Confirm in the output: the three `alarm_*.wav` sounds, the `time-sensitive`
entitlement, `UIBackgroundModes: ["remote-notification"]`, and both
`USE_EXACT_ALARM` / `SCHEDULE_EXACT_ALARM` (the latter carrying
`android:maxSdkVersion="32"`). All four were confirmed present in earlier
sessions; this is to catch the version bump breaking something, not to
re-litigate them.

Then confirm the suites are still green, since a build freezes whatever is in
the tree:

```bash
cd tish-app && npx tsc --noEmit && npx eslint . && npm run validate-translations && npm test
```

Expected: clean, 0 errors / 40 warnings, 373 keys, 209 tests.

**And check your APNs key is on EAS.** `getExpoPushTokenAsync` is the single
prerequisite for half of session 10's work, and it needs Apple push credentials
registered with EAS, not just `tish-app/key.p8` sitting on disk:

```bash
npx eas-cli@latest credentials --platform ios
```

Look for a Push Key. If there isn't one, EAS will offer to create it during the
build — but knowing that in advance is better than discovering it at the point
where you expected a phone to buzz.

---

## 4. The build

```bash
cd tish-app && npx eas-cli@latest build --platform ios --profile production
```

Then submit to TestFlight:

```bash
cd tish-app && npx eas-cli@latest submit --platform ios --latest
```

`eas.json` already carries the submit config (`ascAppId 6792648557`, team
`H26QSNNRY6`), so this should not prompt for App Store details.

Expect 15–30 minutes for the build, plus Apple's processing time before it
appears in TestFlight. **Install it on a physical phone** — a simulator cannot
produce a push token, which is what makes half of session 10 impossible without
real hardware.

### Android, if you want it in the same pass

```bash
cd tish-app && npx eas-cli@latest build --platform android --profile preview
```

`preview` gives an internal-distribution APK you can sideload, which is enough
for session 10's Android checks. **One thing to know before you go further than
that:** `USE_EXACT_ALARM` is Play-restricted to apps whose core function is
alarms, timers or calendar notifications, and declaring it puts the listing
through review. That is §0.7 item 5, and it is not blocking now — there is no
Android submit config in `eas.json`, so no listing exists. It blocks *shipping*
to Play, not testing.

---

## 5. Immediately after installing — a 10-minute smoke test

Do this yourself before handing over to session 10. It is not the verification
work; it is confirming the build is worth verifying, and each of these fails
loudly rather than silently.

1. **Sign in.** Then check the token actually registered:
   ```bash
   curl -s "https://u91xzojfja.execute-api.ap-east-2.amazonaws.com/production/debug/push_tokens"
   ```
   You want a row whose `token` looks like `ExponentPushToken[...]`. **Every
   token this project has ever tested with was synthetic**, which is why the
   dead-token reaping path is well exercised and delivery has never been tested
   once. If this row does not appear, nothing else in session 10 is reachable
   and the problem is credentials or permissions, not code.

2. **Create a reminder with a non-default sound**, let it fire, and listen. If
   you hear the standard iOS chime instead of the alarm, the
   `expo-notifications` plugin did not take — that is 4.7a, and it is the check
   that a plugin-level failure would otherwise hide.

3. **Check the alarm breaks through Focus.** Turn on a Focus mode and let one
   fire. Getting through is 5.3's `timeSensitive` level working. (Ring-silent
   and Do Not Disturb proper still need Critical Alerts, which is P0.2 and
   deliberately not blocked on.)

If all three pass, the build is good and session 10 has something to work with.

---

## 6. What this unblocks

Session 10's directive is already written into `PLAN.md` §0.3, with a ready
prompt to paste. It covers, in order: registering a real token, letting one dose
escalate to a caregiver, then `cancelAlarmsForOtherOwners` — which is ordered
third deliberately, because it *deletes* alarms and on a real phone the evidence
is gone the moment it misbehaves. After those, 5.6's seven-day horizon, which is
the largest unverified thing in the project: **no alarm written under the
six-segment identifier scheme has ever been handed to an operating system.**

One flag worth carrying into that session: if nothing rings at all, check
whether `scheduleNotificationAsync` is rejecting the six-segment identifier
before assuming a scheduling bug. It would present as a scheduling failure and
be a string-length problem.

Session 9's own work needs a device too, but only lightly — 6.2's translated
error messages render in alerts that only appear for a signed-in user. The
cheapest check is the one the whole contract was built for: request access from
an email address that does not exist, and confirm the alert says so in the
phone's language rather than showing English or a blank box.
