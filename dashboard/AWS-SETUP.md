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

## Your login

A user has been created for `admin@ti-smarthealth.com` and Cognito has emailed
it a temporary password. First sign-in forces a password change. Only people
created in this pool can reach the dashboard — **pool membership is the
authorization**, which is why self-signup is disabled
(`AllowAdminCreateUserOnly=true`).

Add another admin:

```bash
aws cognito-idp admin-create-user --region ap-east-2 --user-pool-id ap-east-2_RkCillRxC --username someone@example.com --user-attributes Name=email,Value=someone@example.com Name=email_verified,Value=true --desired-delivery-mediums EMAIL
```

MFA (authenticator app) is **enabled but optional** — enrol from the hosted UI.
To make it mandatory for everyone:

```bash
aws cognito-idp set-user-pool-mfa-config --region ap-east-2 --user-pool-id ap-east-2_RkCillRxC --software-token-mfa-configuration Enabled=true --mfa-configuration ON
```

## What exists

| Resource | Identifier | Region |
| --- | --- | --- |
| Cognito user pool | `ap-east-2_RkCillRxC` (`tish-admin`) | ap-east-2 |
| App client (SPA, no secret) | `3ke31mij0lu8u4mulvkt388npk` | ap-east-2 |
| Hosted UI domain | `https://tish-admin.auth.ap-east-2.amazoncognito.com` | ap-east-2 |
| Lambda | `tish-admin-api`, nodejs24.x, 256 MB, 15s, VPC-attached | ap-east-2 |
| Lambda execution role | `tish-admin-api-role` (+ `AWSLambdaVPCAccessExecutionRole`) | global |
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
