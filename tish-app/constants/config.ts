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

// --- Verification delivery -------------------------------------------------

/**
 * Whether users may choose SMS for their signup confirmation code.
 *
 * Keep this false while the account's SNS SMS sandbox is active: in the
 * sandbox, texts only reach manually verified numbers, so an SMS signup
 * silently delivers nothing and strands the account unconfirmed.
 *
 * This is not hypothetical — it is what beta testers actually hit. Cognito
 * prefers SMS whenever phone_number is in the signUp() payload, and the app
 * always sent it, so signup codes were texted into the sandbox and vanished.
 * Testers only ever saw email from the *resend* action. Leaving this false
 * omits phone_number and forces the working email route.
 *
 * Checked on 2026-07-24: sandbox ON in both ap-east-2 and ap-southeast-2,
 * with zero verified destination numbers. Flip this to true once production
 * SMS access is granted (SNS console -> Text messaging -> Exit sandbox).
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
