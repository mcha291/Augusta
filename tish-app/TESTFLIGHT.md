# Shipping to TestFlight

How the Tish app reaches iOS beta testers. Two ways to submit: manually with
`npx eas-cli submit` from your machine (Windows-friendly), or automatically via
the `iOS build + TestFlight` GitHub Action. Both use the same config below.

> **Running the CLI:** `eas-cli` isn't installed globally here, so use
> **`npx eas-cli …`** (note: the package is `eas-cli`, not `eas` — `npx eas`
> fails). To type plain `eas` instead, install it once with
> `npm install -g eas-cli`. Inside GitHub Actions the bare `eas` command *is*
> correct, because the Expo action installs the CLI globally on the runner.

## One-time setup

### 1. Create the App Store Connect app record

At [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Apps** →
**+** → New App:
- Platform: iOS
- Bundle ID: **`com.ti-smarthealth.app`** (must match `app.json`)
- Note the **Apple ID** it assigns the app (a number like `6448123456`) — this
  is your `ascAppId`.

### 2. Create an App Store Connect API key (the secret)

App Store Connect → **Users and Access** → **Integrations** (or **Keys**) tab →
**App Store Connect API** → **+**:
- Name it e.g. `eas-submit`
- Access: **App Manager** (or Admin)
- **Download the `.p8` file** — Apple lets you download it exactly once.
- Note the **Key ID** and the **Issuer ID** shown on that page.

Keep the `.p8` out of the repo. It's already covered by `.gitignore`
(`*.p8`), but the right home for it is EAS, not your disk — see step 4.

### 3. Fill in the non-secret IDs

Edit `tish-app/eas.json` → `submit.production.ios` and replace the placeholders:
```json
"ios": {
  "ascAppId": "<the app's Apple ID from step 1>",
  "appleTeamId": "<your Apple Developer Team ID>"
}
```
(Find the Team ID at [developer.apple.com](https://developer.apple.com) →
Membership.) These are identifiers, not secrets — safe to commit.

### 4. Upload the API key to EAS (so no secret lives anywhere in git)

```
cd tish-app
npx eas-cli credentials
```
Choose **iOS → production → App Store Connect API Key → Set up a new key**, and
point it at the `.p8` from step 2 (it'll ask for the Key ID and Issuer ID).
EAS stores it server-side. After this, both `npx eas-cli submit` and the CI
workflow authenticate to Apple automatically — you never reference the `.p8`
again.

(If you haven't authenticated this machine to Expo yet, run
`npx eas-cli login` first.)

## Submitting

### Option A — manually from your machine (Windows OK)

You already have a build. Submit the latest EAS build:
```
cd tish-app
npx eas-cli submit --platform ios --profile production
```
…or submit a specific local `.ipa`:
```
npx eas-cli submit --platform ios --path /path/to/app.ipa
```

To build and submit in one step next time:
```
npx eas-cli build --platform ios --profile production --auto-submit
```

### Option B — automatically via GitHub Actions

The `iOS build + TestFlight` workflow (`.github/workflows/submit-ios.yml`) runs
`eas build … --auto-submit`. Trigger it either way:
- **Manually:** GitHub → Actions → *iOS build + TestFlight* → Run workflow.
- **On a version tag:** `git tag v1.0.1 && git push origin v1.0.1`.

Requires one GitHub secret: **`EXPO_TOKEN`** (the same Expo access token used by
the translations pipeline — repo Settings → Secrets and variables → Actions).
No Apple secrets are needed in GitHub because the ASC API key lives in EAS
(step 4).

> **CI reads `eas.json` from the pushed commit, not your working copy.** If the
> IDs from step 3 are only committed locally, the workflow checks out the old
> file and fails with *"Invalid Apple App Store Connect App ID"* — even though
> `npx eas-cli submit` works fine on your machine. Push before you trigger it.
> The workflow's *Validate TestFlight submit config* step catches this in
> seconds, before any build minutes are spent.

## After the upload

1. Apple processes the build (~5–15 min); it appears in App Store Connect →
   your app → **TestFlight**.
2. **Internal testers** (up to 100 team members): add them to an internal group
   — they get the build in minutes, no review.
3. **External testers** (up to 10,000, via email/public link): the *first*
   build needs a one-time **Beta App Review** (hours); later builds usually
   auto-approve.
4. Testers install the **TestFlight** app from the App Store and accept the invite.

## Cadence: TestFlight vs EAS Update

- **New TestFlight build** (this doc) is only needed for **native** changes —
  new native modules, SDK bumps, permission/config changes.
- **JS/asset changes** (translations, most fixes, UI) reach already-installed
  TestFlight builds **over-the-air** via **EAS Update** — no re-upload. See the
  translations pipeline (`.github/workflows/translations.yml`).

## Notes

- `app.json` sets `ITSAppUsesNonExemptEncryption: false`, which pre-answers the
  export-compliance question so uploads don't stall on it.
- Builds expire after **90 days**; testers need a fresh build after that.
- `eas.json` uses `appVersionSource: remote` and `autoIncrement` on the
  production profile, so the build number increments automatically each build —
  you don't hand-manage it.
