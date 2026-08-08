# Tish Admin Dashboard — AWS setup

**Status: provisioned and live, with one thing outstanding.** This was a
step-by-step runbook to be worked through by hand; everything in it has now
been done, so it is a record of what exists and how to change it. Account
`180891490019`. Provisioned 2026-08-08.

**Live URL: <https://main.d1x8yq4r6ivp8n.amplifyapp.com>**

## ⚠ Outstanding — the localization editor is not functional yet

`GITHUB_TOKEN` on the admin Lambda is the literal placeholder
`REPLACE_WITH_GITHUB_PAT`. A personal access token can't be created on your
behalf, so it's the one step left.

Until it is replaced: **the database viewer works, the translations page does
not** (both `/translations` routes return a sanitized 500; the real 401 from
GitHub is in CloudWatch). Nothing else is affected — the placeholder is there
rather than the variable being absent because the handler fails closed on *any*
missing env var, which would have taken the database viewer down too.

1. GitHub → Settings → Developer settings → Fine-grained personal access tokens
   → **Generate new token**.
2. Repository access: **only** `mcha291/Augusta`.
3. Permissions: **Contents → Read and write**. Nothing else.
4. Expiration: your policy — note it somewhere, commits stop working when it lapses.
5. Install it (the token never reaches the browser; it lives only in the Lambda):

```bash
aws lambda update-function-configuration --region ap-east-2 --function-name tish-admin-api --environment "Variables={DB_HOST=season1.c308e88466sa.ap-east-2.rds.amazonaws.com,DB_USER=mcha291,DB_PASSWORD=$DB_PASSWORD,DB_NAME=postgres,GITHUB_REPO=mcha291/Augusta,GITHUB_LOCALES_DIR=tish-app/locales,ALLOWED_ORIGIN=https://main.d1x8yq4r6ivp8n.amplifyapp.com,GITHUB_TOKEN=$NEW_PAT}"
```

`update-function-configuration` **replaces** the whole environment map, so every
variable has to be present in that one call — omitting `DB_PASSWORD` would take
the database viewer down. Set `DB_PASSWORD` and `NEW_PAT` in your shell first.

## Accounts: staff sign themselves up, you approve

Self-registration is open at **<https://main.d1x8yq4r6ivp8n.amplifyapp.com/signup>**.
Signing up gets someone an account; it does **not** get them data.

1. Staff fill in name, work email, optional mobile, password.
2. A Pre Sign-up Lambda rejects anything that isn't `@ti-smarthealth.com`.
3. Cognito emails a six-digit code; entering it confirms the address.
4. They land on "waiting for approval" and stay there until you act.
5. **You approve** by adding them to the `approved` group — Cognito console →
   User pools → `tish-admin` → Users → pick the user → Group memberships →
   Add. Or:

```bash
aws cognito-idp admin-add-user-to-group --region ap-east-2 --user-pool-id ap-east-2_RkCillRxC --username someone@ti-smarthealth.com --group-name approved
```

**Membership of `approved` is the authorization.** The admin API checks it on
every request and returns 403 without it, so an unapproved account can sign in
and see nothing. Removing someone from the group revokes access within the ID
token's lifetime — up to an hour, not immediately.

The check is enforced server-side in `server/index.mjs`; the dashboard reads the
same `cognito:groups` claim only to decide whether to show the waiting screen
instead of firing requests that would all 403.

> Approval reaches a session at sign-in. Someone approved while signed in has to
> sign out and back in — the waiting screen says so.

Your own account (`admin@ti-smarthealth.com`) was created before self-signup
existed and is already in `approved`.

MFA (authenticator app) is **enabled but optional**. To make it mandatory:

```bash
aws cognito-idp set-user-pool-mfa-config --region ap-east-2 --user-pool-id ap-east-2_RkCillRxC --software-token-mfa-configuration Enabled=true --mfa-configuration ON
```

### Changing who may register

The domain rule lives in the Lambda's `ALLOWED_EMAIL_DOMAINS` env var
(comma-separated), so widening it needs no code change:

```bash
aws lambda update-function-configuration --region ap-east-2 --function-name tish-admin-presignup --environment "Variables={ALLOWED_EMAIL_DOMAINS=ti-smarthealth.com,partner.example}"
```

Admin-created users bypass the rule deliberately — otherwise a bad value here
would lock you out of your own escape hatch.

## Email comes from ti-smarthealth.com

The pool is on `EmailSendingAccount: DEVELOPER`, sending as
**`Tish Admin <no-reply@ti-smarthealth.com>`** through the SES domain identity
in **ap-northeast-2 (Seoul)** — DKIM verified, SPF already in the apex record.
Taipei has no SES endpoint and Seoul is its designated alternate.

This works despite SES still being **in the sandbox**, and that is the reason
sign-up is restricted to the company domain. Sandbox rules allow sending only to
verified identities — and the verified identity is the *domain*, so any
`@ti-smarthealth.com` recipient is fine while `someone@gmail.com` is not. A
gmail signup would be accepted by Cognito and then never receive its code, so
the trigger rejects it up front with an explanation instead.

**Once SES production access is granted** (still `ProductionAccessEnabled:
false` as of 2026-08-08, filed per MIGRATION.md A0), external addresses become
deliverable and `ALLOWED_EMAIL_DOMAINS` can be widened. Nothing else changes.

The SES sending authorization policy `CognitoTaipei` on the identity now lists
**both** pools — the app's and this one. It trusts the regional principal
`cognito-idp.ap-east-2.amazonaws.com`; the global one fails silently.

## SMS verification: wired, but blocked upstream

Everything on the AWS side is in place — the pool has an `SmsConfiguration`
pointing at `CognitoIdpSNSServiceRole-tish-admin` (its own `ExternalId`, not
shared with the app pool's role), and the sign-up form already collects a
mobile number in E.164.

**It is not switched on, because SNS in ap-east-2 is still in the sandbox.**
Two verified numbers exist (`+886905115797` and one AU number); SMS to anyone
else is silently dropped. The monthly spend cap is also still the `$1` default.

To turn it on once SNS production access lands and the cap is raised — add
`phone_number` to the auto-verified attributes:

```bash
aws cognito-idp update-user-pool --region ap-east-2 --user-pool-id ap-east-2_RkCillRxC --auto-verified-attributes email phone_number
```

⚠ `update-user-pool` **replaces** every setting it accepts, so a bare call like
that resets the email config, the Lambda trigger and the password policy. Build
the payload from a live `describe-user-pool` first — the same footgun
MIGRATION.md flags for the app pool.

## What exists

| Resource | Identifier | Region |
| --- | --- | --- |
| Cognito user pool | `ap-east-2_RkCillRxC` (`tish-admin`) | ap-east-2 |
| App client (SPA, no secret) | `3ke31mij0lu8u4mulvkt388npk` | ap-east-2 |
| Hosted UI domain | `https://tish-admin.auth.ap-east-2.amazoncognito.com` | ap-east-2 |
| Authorization group | `approved` — membership is the actual access grant | ap-east-2 |
| Lambda | `tish-admin-api`, nodejs24.x, 256 MB, 15s, VPC-attached | ap-east-2 |
| Lambda | `tish-admin-presignup`, nodejs24.x, 128 MB, 5s, no VPC | ap-east-2 |
| Lambda execution roles | `tish-admin-api-role`, `tish-admin-presignup-role` | global |
| SES identity | `ti-smarthealth.com`, policy `CognitoTaipei` | ap-northeast-2 |
| SNS caller role (SMS) | `CognitoIdpSNSServiceRole-tish-admin` | global |
| REST API | `0u10zqz4r0`, stage `prod` | ap-east-2 |
| API invoke URL | `https://0u10zqz4r0.execute-api.ap-east-2.amazonaws.com/prod` | ap-east-2 |
| Cognito authorizer | `tish-admin-pool` on all four authorized methods | ap-east-2 |
| Amplify app | `d1x8yq4r6ivp8n` (`tish-dashboard`), branch `main` | **ap-northeast-2** |

The Lambda shares the app backend's VPC placement — subnets
`subnet-0ef1ccc6d175653c3`, `subnet-05a4cca510c84174d`, `subnet-02d53fa57a84c5a23`
and security group `sg-04bc9817aedc7ba73` (`tish-lambda-sg`), which is what
`tish-rds-sg` accepts 5432 from. `season1` is private, so that group membership
is the only route to it.

### Two things are not in Taipei, and can't be

`ap-east-2` has **no API Gateway HTTP APIs** and **no Amplify Hosting**. Both
were assumed by the original plan and neither is available:

- **The gateway is a REST API, not an HTTP API.** This is not cosmetic — REST
  sends Lambda proxy payload format **1.0** (`httpMethod`, `path`) where HTTP
  APIs send **2.0** (`requestContext.http.method`, `rawPath`). The handler reads
  both; see `eventMethod`/`eventPath` in `server/index.mjs`. Consequences: the
  stage name is in the URL (`/prod`), and CORS preflight is a MOCK integration
  per resource rather than one API-level CORS block.
- **Amplify Hosting is in ap-northeast-2 (Seoul).** Only the build and control
  plane live there; the assets are served from CloudFront either way, so Taiwan
  users are not taking a Seoul round-trip. Seoul was chosen because the account's
  other Amplify app and the SES identity are already there.

The API and Lambda *are* in Taipei, next to RDS, so no request touches two
regions.

## CORS, and why local dev uses mock mode

`ALLOWED_ORIGIN` is a single origin (the Amplify URL) — the handler echoes
exactly one value, and the preflight MOCK integrations are hard-coded to the
same one. So `npm run dev` on `http://localhost:5173` **cannot** call the real
API; the browser blocks the response. That is what `VITE_MOCK=1` in
`.env.local` is for.

`http://localhost:5173` is registered as a Cognito callback URL, so a real
*login* works locally — it's only the API calls that are blocked. To develop
against real data, point `ALLOWED_ORIGIN` at localhost temporarily and change
the three preflight integration responses to match, then put them back.

## Deploys

All three deployables ship from GitHub Actions on push to `main`, using one
OIDC role (`github-lambda-deploy`) — no AWS keys in GitHub. See
`tish-app/backend/DEPLOY.md`.

| Change under | Workflow | Target |
| --- | --- | --- |
| `dashboard/server/**` | `deploy-admin-api.yml` | Lambda `tish-admin-api` |
| `dashboard/cognito-triggers/**` | `deploy-cognito-triggers.yml` | Lambda `tish-admin-presignup` |
| `dashboard/**` (excl. `server/`) | `deploy-dashboard.yml` | Amplify `d1x8yq4r6ivp8n` |
| `tish-app/backend/**` | `deploy-backend.yml` | Lambda `operation-strix` |

The Amplify app is deliberately **not** connected to the GitHub repo. Connecting
it requires an interactive OAuth authorization in the console and monorepo-root
plumbing; deploying from Actions reuses the OIDC role the Lambdas already use.
The trade-off is that Amplify's console shows manual deployments with no commit
metadata — the commit that produced a build is in the Actions run, not Amplify.

`VITE_*` values are baked into the bundle at build time from repo *variables*
(not secrets — they ship to every browser that loads the app). Changing the API
URL or pool means updating the variable **and** re-running the deploy; editing
Amplify's own environment variables does nothing, because Amplify never builds.

## Smoke test

1. Open <https://main.d1x8yq4r6ivp8n.amplifyapp.com> → redirected to the Cognito
   hosted UI → sign in (password change on first use).
2. Database page: pick `genders` → 4 rows, read-only.
3. Translations page: needs the PAT above; until then it errors.

Verified at provisioning time, without signing in:

- `GET /tables` direct Lambda invoke → 200, real row counts from `season1`.
- `GET /tables` through the gateway, no token → **401**; with a malformed token → **401**.
- `OPTIONS /tables` → 200 with `Access-Control-Allow-Origin` set to the Amplify URL.
- The deployed SPA redirects to the hosted UI with the right `client_id`,
  `redirect_uri` and PKCE (`code_challenge_method=S256`), no console errors.
- Deep link `/database` → 200 (SPA rewrite rule works).
- Approval gate against the deployed Lambda: claims without `approved` → **403
  NOT_APPROVED with no database query issued**; `cognito:groups=[approved]` → 200 with data.
- Sign-up form at `/signup` with a `@gmail.com` address → the trigger's own
  message rendered in the form, **and no user created in the pool**.

**Not yet verified: that a verification email actually arrives.** Cognito
accepted the SES configuration (it validates the identity and the sending
policy when `DEVELOPER` is set), and the domain is verified with DKIM passing —
but no mail has been sent through the path end to end, because doing so means
creating a real account. The first staff sign-up is the test. If no code
arrives, look at SES Seoul's sending metrics and the pool's CloudWatch logs
before suspecting the client.

## Known gaps

Recorded, not fixed — these belong to the security plan rather than this setup:

- `DB_PASSWORD` and `GITHUB_TOKEN` are plaintext Lambda env vars, readable by
  anyone with `lambda:GetFunctionConfiguration`. Secrets Manager is the fix.
  Same finding as D2 in `MIGRATION.md`, which the app backend also has.
- The Lambda connects as `mcha291`, the RDS master user, but only ever SELECTs.
  A read-only Postgres role would be least privilege.
- `pg` connects with `ssl: { rejectUnauthorized: false }`, so the database
  connection is encrypted but unauthenticated.
- The `github-lambda-deploy` trust policy matches `repo:mcha291/*` — any repo
  in the account, any ref — where `DEPLOY.md` documents two specific repos on
  `refs/heads/main`. Whoever widened it may have had a reason; noting it because
  the doc and reality disagree.
