# Tish Admin Dashboard — AWS setup runbook

One-time provisioning steps performed in **your** AWS/GitHub accounts. Everything
code-side is already in this repo. Estimated time: ~45 minutes.

Recommended region for all new resources: the region your RDS instance lives in
(so the Lambda sits next to the database).

## 1. Admin Cognito user pool (separate from the app's pool — by design)

1. Cognito console → **Create user pool**.
2. Application type: **Single-page application (SPA)**. Name the app client `tish-dashboard`.
3. Sign-in identifier: **Email**. Required attribute: email.
4. Under the app client's **Login pages / Hosted UI** settings:
   - Allowed callback URLs: `http://localhost:5173` and (after step 6) your Amplify URL, e.g. `https://main.dXXXX.amplifyapp.com`
   - Allowed sign-out URLs: same two URLs
   - OAuth grant: **Authorization code grant**; scopes: **openid, email**
5. Set up a **Hosted UI domain** (e.g. `tish-admin` prefix). Note the full domain URL.
6. **Users** → Create user (yourself). Only people created here can access the dashboard — pool membership *is* the authorization.
7. Strongly recommended for a health-data admin tool: enable **MFA** (Sign-in experience → MFA → Required, authenticator apps).
8. Note down: **Pool ID** (`<region>_XXXXXXX`), **App client ID**, **Hosted UI domain**.

## 2. Admin Lambda

1. Prepare the deploy zip locally:
   ```
   cd server
   npm install --omit=dev
   ```
   Then zip the contents of `server/` (`index.mjs`, `package.json`, `node_modules/`) — on Windows: select those three → right-click → Compress to ZIP. The zip root must contain `index.mjs` directly (not a `server/` folder).
2. Lambda console → **Create function** → Author from scratch → name `tish-admin-api`, runtime **Node.js 22.x**.
3. Upload the zip (Code → Upload from → .zip file). Handler: `index.handler` (default).
4. Configuration → Environment variables — set all of these (the function fails closed if any are missing):
   | Key | Value |
   |---|---|
   | `DB_HOST` | your RDS endpoint |
   | `DB_USER` | your RDS user |
   | `DB_PASSWORD` | your RDS password |
   | `DB_NAME` | `postgres` |
   | `GITHUB_TOKEN` | the PAT from step 4 |
   | `GITHUB_REPO` | e.g. `mcha291/Augusta` (owner/repo of the **app** repo) |
   | `ALLOWED_ORIGIN` | your Amplify URL (use `http://localhost:5173` until step 6 is done) |
5. Configuration → General → timeout **15s** (GitHub round-trips), memory 256 MB.

## 3. HTTP API (API Gateway)

1. API Gateway console → **Create API** → **HTTP API**.
2. Integration: the `tish-admin-api` Lambda. Routes — create exactly:
   - `GET /tables`
   - `GET /tables/{name}`
   - `GET /translations`
   - `PUT /translations`
3. **Authorization** → create a **JWT authorizer**:
   - Issuer URL: `https://cognito-idp.<region>.amazonaws.com/<admin-pool-id>`
   - Audience: the app client ID from step 1
   - Attach it to **all four routes**.
4. **CORS**: allowed origins = `http://localhost:5173` + your Amplify URL; allowed headers = `authorization, content-type`; allowed methods = `GET, PUT, OPTIONS`.
5. Use the default `$default` stage with auto-deploy (the code expects no stage prefix in the path).
6. Note the **Invoke URL** (`https://XXXX.execute-api.<region>.amazonaws.com`).

## 4. GitHub fine-grained PAT (for the localization editor)

1. GitHub → Settings → Developer settings → Fine-grained personal access tokens → **Generate new token**.
2. Repository access: **only** the app repo (the one containing `locales/`).
3. Permissions: **Contents → Read and write**. Nothing else.
4. Expiration: your policy (note it somewhere — commits stop working when it lapses).
5. Put it in the Lambda's `GITHUB_TOKEN` env var. It never reaches the browser.

## 5. Dashboard GitHub repo

This folder is already a git repo with the history preserved. Create an empty GitHub repo (e.g. `tish-dashboard`), then:
```
git remote add origin https://github.com/<you>/tish-dashboard.git
git push -u origin main
```

## 6. Amplify Hosting

1. Amplify console → **Create new app** → GitHub → select the `tish-dashboard` repo, branch `main`.
2. Build settings are read from the committed `amplify.yml` — no changes needed.
3. **Environment variables** (App settings → Environment variables):
   - `VITE_COGNITO_AUTHORITY` = `https://cognito-idp.<region>.amazonaws.com/<admin-pool-id>`
   - `VITE_COGNITO_CLIENT_ID` = app client ID
   - `VITE_COGNITO_DOMAIN` = Hosted UI domain URL
   - `VITE_API_URL` = HTTP API invoke URL
   - (`VITE_MOCK` unset or `0`)
4. **SPA routing**: App settings → Rewrites and redirects → add:
   - Source: `</^[^.]+$|\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json)$)([^.]+$)/>`
   - Target: `/index.html`, Type: **200 (Rewrite)**
5. Deploy, note the app URL, then go back and add it to: Cognito callback/sign-out URLs (step 1.4), Lambda `ALLOWED_ORIGIN` (step 2.4), and API CORS (step 3.4).
6. Optional hardening: attach **AWS WAF** to the Amplify app; or enable branch **password protection** as an extra gate.

## 7. Smoke test

1. Open the Amplify URL → you should be redirected to the Cognito login → sign in with the step-1.6 user (MFA enrollment if enabled).
2. Database page: pick `genders` (small table) → rows appear, read-only.
3. Translations page: change one English value → Save → follow the commit link → confirm the **Translations** GitHub Action runs and publishes the EAS Update.

## Security notes / future improvements

- Move `DB_PASSWORD` and `GITHUB_TOKEN` from Lambda env vars to **Secrets Manager** and read them at cold start.
- Create a **read-only Postgres role** for this Lambda (it only ever SELECTs; least privilege beats trusting code).
- The app backend currently contains hardcoded DB credential fallbacks in source (`backend/index.mjs` in the app repo) — remove them and rotate that password.
