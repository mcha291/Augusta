# Deploy setup (one-time)

**Done — the OIDC provider, the role and the repo variables all exist.** Kept as
the record of how it is wired and what to change if a name or region moves.

Pushing to `main` auto-deploys, all from this one repo:

| Workflow | Triggers on | Target |
| --- | --- | --- |
| `deploy-backend.yml` | `tish-app/backend/**` | Lambda `operation-strix` |
| `deploy-admin-api.yml` | `dashboard/server/**` | Lambda `tish-admin-api` |
| `deploy-dashboard.yml` | `dashboard/**` (excl. `server/`) | Amplify app `d1x8yq4r6ivp8n` |

> The dashboard used to be a separate repository with its own copy of the first
> two workflow files. It was imported here as a subtree on 2026-08-08 and those
> copies were moved to this repo's `.github/workflows/` — GitHub only reads
> workflows from the repository root, so where they sat before, they no longer
> ran at all.

Auth uses **GitHub OIDC**: the workflow assumes an IAM role with short-lived
credentials — no AWS access keys are ever stored in GitHub. Deploys replace
*code only*; Lambda environment variables (DB credentials etc.) are untouched.

## 1. Create the GitHub OIDC identity provider (once per AWS account)

IAM console → Identity providers → **Add provider**:
- Provider type: **OpenID Connect**
- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

## 2. Create the deploy role (once — one role covers both Lambdas)

IAM console → Roles → **Create role** → Web identity → the provider above,
audience `sts.amazonaws.com`. After creation, replace its **trust policy** with
(substitute your account id, and the repo names if they ever change):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:mcha291/Augusta:ref:refs/heads/main",
            "repo:mcha291/tish-dashboard:ref:refs/heads/main"
          ]
        }
      }
    }
  ]
}
```

Attach an inline **permissions policy** scoped to exactly the two functions
(substitute region/account/function names):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "lambda:UpdateFunctionCode",
      "Resource": [
        "arn:aws:lambda:<REGION>:<ACCOUNT_ID>:function:<BACKEND_FUNCTION_NAME>",
        "arn:aws:lambda:<REGION>:<ACCOUNT_ID>:function:<ADMIN_FUNCTION_NAME>"
      ]
    }
  ]
}
```

Name it e.g. `github-lambda-deploy` and note the **role ARN**.

## 3. GitHub repository variables

(Repo → Settings → Secrets and variables → Actions → **Variables** tab.) All set;
current values:

| Variable | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::180891490019:role/github-lambda-deploy` |
| `AWS_REGION` | `ap-east-2` |
| `BACKEND_FUNCTION_NAME` | `operation-strix` |
| `ADMIN_FUNCTION_NAME` | `tish-admin-api` |
| `AMPLIFY_APP_ID` | `d1x8yq4r6ivp8n` |
| `AMPLIFY_REGION` | `ap-northeast-2` |
| `VITE_COGNITO_AUTHORITY` | `https://cognito-idp.ap-east-2.amazonaws.com/ap-east-2_RkCillRxC` |
| `VITE_COGNITO_CLIENT_ID` | `3ke31mij0lu8u4mulvkt388npk` |
| `VITE_COGNITO_DOMAIN` | `https://tish-admin.auth.ap-east-2.amazoncognito.com` |
| `VITE_API_URL` | `https://0u10zqz4r0.execute-api.ap-east-2.amazonaws.com/prod` |

Two separate regions on purpose: `AWS_REGION` is Taipei, where both Lambdas and
the databases live; `AMPLIFY_REGION` is Seoul, because Amplify Hosting has no
ap-east-2 endpoint. See `dashboard/AWS-SETUP.md`.

The `VITE_*` four are compiled into the dashboard bundle at build time and are
public values — variables, not secrets, deliberately. Changing one requires a
re-deploy of the dashboard to take effect.

## Tests

Both Lambdas' functional tests (`index.test.mjs`) run automatically in three places:

- **Locally on every commit** — via the committed pre-commit hook, which checks
  each Lambda independently and only runs the suite whose files are staged.
  Enable once per clone:
  ```
  git config core.hooksPath .githooks
  ```
- **On every push/PR** — `.github/workflows/test.yml` for the app backend,
  `dashboard-tests.yml` for the admin Lambda and the SPA. Both are path-filtered
  so a change to one never pays for the other's runners.
- **Before every deploy** — each deploy workflow refuses to ship a failing handler.

Run manually with `npm test` in the relevant folder.

## Notes

- The workflows **update** existing functions; they don't create them. Both
  Lambdas and the Amplify app already exist — see `dashboard/AWS-SETUP.md` for
  the admin side's identifiers.
- If a repo is renamed on GitHub, update the `repo:...` entries in the trust
  policy — the old name stops matching immediately. (The live trust policy is
  currently broader than the one shown above; see the Known gaps section of
  `dashboard/AWS-SETUP.md`.)
- Regions are per-target, not per-repo: `AWS_REGION` covers both Lambdas and
  `AMPLIFY_REGION` the dashboard. IAM roles are global, so one role spans both.
