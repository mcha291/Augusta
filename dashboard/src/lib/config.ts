// Runtime configuration, injected at build time via VITE_* env vars
// (set in .env.local for dev, in the Amplify Hosting console for deploys).

export const MOCK = import.meta.env.VITE_MOCK === "1"

export const config = {
  /** e.g. https://cognito-idp.ap-east-2.amazonaws.com/ap-east-2_XXXXXXX */
  cognitoAuthority: import.meta.env.VITE_COGNITO_AUTHORITY as string | undefined,
  cognitoClientId: import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined,
  /** Optional: hosted UI domain (https://xxx.auth.region.amazoncognito.com) — enables full sign-out */
  cognitoDomain: import.meta.env.VITE_COGNITO_DOMAIN as string | undefined,
  /** HTTP API invoke URL, no trailing slash */
  apiUrl: import.meta.env.VITE_API_URL as string | undefined,

  /**
   * Metabase's own base URL, e.g. `https://bi.ti-smarthealth.com`. Used for the
   * "open Metabase" link, which goes to its own login — Metabase has its own
   * accounts, and SSO from Cognito is a paid feature (TELEMETRY.md §4).
   */
  metabaseUrl: import.meta.env.VITE_METABASE_URL as string | undefined,

  /**
   * A **signed static-embed URL** for one dashboard, e.g.
   * `https://bi.../embed/dashboard/<jwt>#bordered=false&titled=false`.
   *
   * Optional, and the page is correct without it — see `AnalyticsPage` for the
   * three things that have to be true before an embed can render at all.
   * Deliberately not the Metabase base URL: the app itself sends
   * `X-Frame-Options: DENY` and `frame-ancestors 'none'`, so only `/embed/*`
   * routes are frameable and the login page can never be.
   */
  metabaseEmbedUrl: import.meta.env.VITE_METABASE_EMBED_URL as string | undefined,
}

export function missingConfig(): string[] {
  if (MOCK) return []
  const missing: string[] = []
  if (!config.cognitoAuthority) missing.push("VITE_COGNITO_AUTHORITY")
  if (!config.cognitoClientId) missing.push("VITE_COGNITO_CLIENT_ID")
  if (!config.apiUrl) missing.push("VITE_API_URL")
  return missing
}
