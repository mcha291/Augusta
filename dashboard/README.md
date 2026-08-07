# Tish Admin Dashboard

Internal admin tool for the Tish app: a read-only database viewer and a
localization editor that commits locale changes straight to this repo.

**Live: <https://main.d1x8yq4r6ivp8n.amplifyapp.com>** — access is Cognito pool
membership; there is no self-signup.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | React 19 + Vite SPA (shadcn/ui, TanStack Query/Table) |
| `server/` | The admin API Lambda — a single-file handler, its own npm package |
| `AWS-SETUP.md` | Every AWS resource behind this, with identifiers |

`server/` is deployed and versioned independently of the SPA; the two share
nothing but the API contract in `src/lib/types.ts`.

## Local development

```bash
npm install && npm run dev
```

`.env.local` ships with `VITE_MOCK=1`, so this runs against in-memory fixtures
with a fake signed-in user — no AWS, no credentials, no network. That is the
normal way to work on the UI.

Running against the **real** API from localhost does not work out of the box:
the Lambda and the API's CORS preflight both allow exactly one origin, the
deployed URL. See the CORS section of `AWS-SETUP.md` for what to change if you
need it.

## Tests

```bash
npm test --prefix server   # admin Lambda, node's built-in runner, no deps
npm run typecheck          # SPA
```

The Lambda tests stub Postgres and the GitHub API, so they need neither. They
also run on every commit that touches `server/` via the repo's pre-commit hook
(`git config core.hooksPath .githooks`), and in CI.

## Deploying

Push to `main`. Changes under `server/` deploy the Lambda; changes anywhere else
under `dashboard/` rebuild and deploy the SPA. Both go through GitHub Actions
with an OIDC role — see `../tish-app/backend/DEPLOY.md`.

Note that the SPA's configuration (Cognito pool, API URL) is compiled into the
bundle at build time from GitHub repo variables. Amplify never builds this app,
so setting environment variables in the Amplify console has no effect.

## History

This was a standalone git repository until 2026-08-08, when it was imported
into the app monorepo as a subtree with its history intact.
