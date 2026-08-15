// --- API endpoints ---------------------------------------------------------
//
// One front door. API Gateway `TISCv1` (ap-east-2) fronts everything, with
// per-route authorization:
//
//   /{proxy+}            COGNITO_USER_POOLS — all authenticated traffic
//   /check-availability  NONE — runs during signup, before a token exists
//   /genders /conditions NONE — lookup data loaded on the signup form
//
// The app previously called /check-availability on a Lambda Function URL with
// AuthType NONE, because it was assumed API Gateway would reject a tokenless
// request. That route already existed and was already unauthenticated, so the
// Function URL was never needed. It is scheduled for deletion — see D1 in
// MIGRATION.md — but must outlive the currently-shipped TestFlight build,
// which still calls it.

export const API_BASE_URL = 'https://u91xzojfja.execute-api.ap-east-2.amazonaws.com/production';

// --- Product analytics ingest (TELEMETRY.md §3) ----------------------------

/**
 * Where `utils/telemetry.ts` flushes buffered events, or `null` for a build
 * that should buffer locally and never send.
 *
 * **This is an explicit API Gateway resource, not a path the `/{proxy+}` catch-
 * all handles**, and that distinction is the whole of §3's ingestion argument.
 * `/{proxy+}` routes to `operation-strix`, which is VPC-attached and holds a
 * `pg` pool against a `db.t4g.micro` — putting high-frequency telemetry on it
 * would contend with the query path that decides whether an alarm fires, which
 * is precisely the contention that moved product analytics out of Postgres in
 * the first place. API Gateway prefers the more specific resource, so
 * `/telemetry` reaches `tish-telemetry-ingest` instead: non-VPC, no database
 * client, no ENI cold start.
 *
 * Setting this back to `null` is a complete and safe off switch. The buffer
 * still fills, still collapses flaps and still prunes past its age cap; it
 * simply stops sending, and nothing else in the app changes.
 */
export const TELEMETRY_ENDPOINT: string | null = '/telemetry';

// --- Verification delivery -------------------------------------------------

/**
 * Whether the signup screen offers SMS as a delivery choice for the
 * confirmation code.
 *
 * Keep this false while the account's SNS SMS sandbox is active: in the
 * sandbox, texts only reach manually verified numbers, so an SMS signup
 * silently delivers nothing and strands the account unconfirmed. That is not
 * hypothetical — it is what beta testers actually hit, and the pool still
 * reports `SmsConfigurationFailure: SNSSandbox`.
 *
 * **This flag no longer controls delivery, only whether the choice is
 * offered.** It used to do both, by deciding whether `phone_number` was part
 * of the `signUp()` payload — but that never worked on this pool, which marks
 * `phone_number` as a *required* attribute. Omitting it did not route around
 * SMS; it failed registration outright for every user with
 * "Attributes did not conform to the schema". A required attribute cannot be
 * omitted, and `Required` cannot be changed after a pool is created.
 *
 * Delivery is now decided pool-side: `phone_number` was removed from the
 * pool's `AutoVerifiedAttributes`, leaving `email` alone there, so Cognito
 * emails the code even though a number is supplied. The number is stored
 * unverified, which is what the profile screen's verify action exists to fix
 * for `email`; a phone equivalent would need `phone_number` auto-verified
 * again.
 *
 * Re-enabling SMS is therefore two changes, not one: exit the SNS sandbox,
 * *and* put `phone_number` back into `AutoVerifiedAttributes` — at which point
 * Cognito prefers SMS for everyone, since the number is now always sent.
 *
 * Checked on 2026-08-02: sandbox still ON. Verify before flipping:
 *
 *   aws sns get-sms-sandbox-account-status --region ap-east-2
 */
export const SMS_VERIFICATION_ENABLED = false;

/**
 * Which delivery medium to offer first once SMS is available. The product
 * preference is SMS; email stays selectable for people who'd rather not hand
 * over a phone number.
 */
export const PREFERRED_VERIFICATION_MEDIUM: 'sms' | 'email' = 'sms';

/** What the signup form should default to right now. */
export const DEFAULT_VERIFICATION_MEDIUM: 'sms' | 'email' =
  SMS_VERIFICATION_ENABLED ? PREFERRED_VERIFICATION_MEDIUM : 'email';

// --- iOS alert urgency (5.3) ----------------------------------------------

/**
 * Whether this build carries Apple's **Critical Alerts** entitlement.
 *
 * Critical Alerts bypass the mute switch, Do Not Disturb and every Focus mode.
 * They need `com.apple.developer.usernotifications.critical-alerts`, which is
 * granted by Apple on request rather than self-served, and P0.2 is unfiled.
 *
 * **Nothing waits on it.** 5.3 ships the strongest level available without an
 * entitlement request — `interruptionLevel: 'timeSensitive'`, which breaks
 * through Focus modes and the scheduled notification summary and is covered by
 * `com.apple.developer.usernotifications.time-sensitive` in `app.json`, a
 * self-service capability. The gap that remains is exactly two things: ring-
 * silent and Do Not Disturb proper.
 *
 * Flipping this to true is the *whole* client change if the entitlement is
 * granted. It does two things: adds `allowCriticalAlerts` to the runtime
 * authorization request, and lets `resolveInterruptionLevel` return `'critical'`.
 * The scheduling code branches on the permission the OS actually reports, so a
 * build with the flag on but the entitlement missing degrades to timeSensitive
 * rather than failing.
 *
 * Do **not** set this true before the entitlement is in the provisioning
 * profile: iOS treats a request for an unauthorized option as an error, and the
 * failure mode is losing the whole authorization request, not just that option.
 *
 * Also needs, at that point: the entitlement added to `app.json`'s
 * `ios.entitlements`, and a new native build. See §0.7 and 5.3.
 */
export const CRITICAL_ALERTS_ENTITLED = false;
