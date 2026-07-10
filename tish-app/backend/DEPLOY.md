# Lambda auto-deploy setup (one-time)

Pushing to `main` auto-deploys Lambda code via GitHub Actions:

- **This repo** → `.github/workflows/deploy-backend.yml` → the app backend Lambda
  (triggers on changes under `tish-app/backend/`)
- **Dashboard repo** → `.github/workflows/deploy-admin-api.yml` → the admin API Lambda
  (triggers on changes under `server/`)

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

## 3. Set GitHub repository variables

(Repo → Settings → Secrets and variables → Actions → **Variables** tab)

**This repo (Augusta):**
| Variable | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | the role ARN from step 2 |
| `AWS_REGION` | region of the backend Lambda |
| `BACKEND_FUNCTION_NAME` | the backend Lambda's function name |

**Dashboard repo:**
| Variable | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | same role ARN |
| `AWS_REGION` | region of the admin Lambda |
| `ADMIN_FUNCTION_NAME` | the admin Lambda's function name (e.g. `tish-admin-api`) |

## Notes

- The workflows **update** existing functions; they don't create them. Create
  each Lambda once by hand first (admin Lambda: see the dashboard repo's
  `AWS-SETUP.md`).
- If a repo is renamed on GitHub, update the `repo:...` entries in the trust
  policy — the old name stops matching immediately.
- If the two Lambdas live in different regions, that's fine: `AWS_REGION` is
  set per-repo, and IAM roles are global.
