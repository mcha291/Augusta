/**
 * 6.2 — the client half of the error contract.
 *
 * The server (6.1) answers a failure with `{ error, code, problems? }`. `error`
 * is developer-facing English; `code` is the stable identifier this module
 * turns into a locale key. Every message the app used to build by showing
 * `data.error` straight from the response now comes through here, because the
 * app ships en and zh-Hant and a server-authored sentence is only ever one of
 * them.
 *
 * Deliberately dependency-free so `node --test` can exercise it, like
 * `relationship-types.ts`, `doses.ts` and `date.ts` before it — and `t` is
 * injected rather than imported for the same reason.
 *
 * **The fallback is the part that needed a decision rather than a default**, and
 * it is the reason this returns keys for every input rather than `null` for an
 * unrecognised one. A code this build has never heard of is not an edge case: it
 * is *guaranteed* on the next backend deploy after any client build, permanently
 * and by design, because the two ship independently — build 8 is in TestFlight
 * and a client change needs a new build. So an unknown code must still produce a
 * real sentence. It degrades down a ladder:
 *
 *   1. recognised `problems[]` codes — the specific, per-field sentences;
 *   2. a recognised `code`;
 *   3. **the HTTP status**, which the client always has even when it has never
 *      heard of the code;
 *   4. `errors.network`, for a request that never got a status at all.
 *
 * Rung 3 is what makes rung 2 safe to miss. It is keyed on the status and never
 * on the code, which is also what keeps the `/me` decision intact: a 404 from an
 * unmapped future code says "we couldn't find that", never "your session
 * ended", so nothing here can talk a client into signing a half-registered user
 * out. §0.6 records why that matters.
 */

/** One bad field, as 6.1's `problems[]` carries it. */
export interface ApiProblem {
  field?: string;
  code?: string;
  /** The server's English default. Kept for logs; never rendered to a user. */
  message?: string;
}

/** The body 6.1 returns on any failure. Every field is optional on the wire. */
export interface ApiErrorBody {
  error?: string;
  code?: string;
  problems?: ApiProblem[];
}

/**
 * Codes a user can actually cause, mapped to the sentence they should read.
 *
 * **Not every code the server can emit is here, and that is the design rather
 * than an omission.** `ROUTE_NOT_FOUND`, `METHOD_NOT_ALLOWED` and
 * `DEBUG_TABLE_NOT_ALLOWED` mean the client asked for something that does not
 * exist — a bug in this app, not a thing a patient did — and inventing patient-
 * facing copy for them would be writing sentences nobody should ever see. The
 * status ladder answers those, which is exactly what it is for.
 */
const CODE_KEYS = {
  AUTH_REQUIRED: 'errors.authRequired',
  ACCESS_DENIED: 'errors.accessDenied',
  VERIFICATION_CODE_MISMATCH: 'errors.verificationCodeMismatch',
  // Distinct from USER_NOT_FOUND on purpose: this one means *you* have no
  // profile row yet, and the copy has to send the user forward into finishing
  // signup rather than backward into signing in again.
  PROFILE_NOT_FOUND: 'errors.profileNotFound',
  USER_NOT_FOUND: 'errors.userNotFound',
  REMINDER_NOT_FOUND: 'errors.reminderNotFound',
  APPOINTMENT_NOT_FOUND: 'errors.appointmentNotFound',
  TEST_RESULT_NOT_FOUND: 'errors.testResultNotFound',
  DOSE_NOT_FOUND: 'errors.doseNotFound',
  RELATIONSHIP_NOT_FOUND: 'errors.relationshipNotFound',
  RELATIONSHIP_REQUEST_NOT_FOUND: 'errors.relationshipRequestNotFound',
  RELATIONSHIP_TARGET_NOT_FOUND: 'errors.relationshipTargetNotFound',
  RELATIONSHIP_ALREADY_ACTIVE: 'errors.relationshipAlreadyActive',
  DOSE_ALREADY_CONFIRMED: 'errors.doseAlreadyConfirmed',
  VALIDATION_FAILED: 'errors.validationFailed',
  INTERNAL_ERROR: 'errors.internal',
} as const;

/** `problems[].code` — one sentence per rule, with the bounds already in it. */
const PROBLEM_KEYS = {
  FIELD_REQUIRED: 'errors.field.required',
  EMAIL_OR_PHONE_REQUIRED: 'errors.field.emailOrPhoneRequired',
  ESCALATION_DELAY_OUT_OF_RANGE: 'errors.field.escalationDelayRange',
  ALARM_REPEAT_COUNT_OUT_OF_RANGE: 'errors.field.alarmRepeatCountRange',
  SNOOZE_MINUTES_OUT_OF_RANGE: 'errors.field.snoozeMinutesRange',
  ESCALATION_ORDER_INVALID: 'errors.field.escalationOrderInvalid',
  TIME_FORMAT_INVALID: 'errors.field.timeFormatInvalid',
} as const;

/** Rung 3. Keyed on the status class, never on the code. */
const STATUS_KEYS = {
  400: 'errors.badRequest',
  401: 'errors.authRequired',
  403: 'errors.forbidden',
  404: 'errors.notFound',
  405: 'errors.badRequest',
  409: 'errors.conflict',
  422: 'errors.badRequest',
} as const;

export const NETWORK_KEY = 'errors.network';
export const UNEXPECTED_KEY = 'errors.unexpected';
const SERVER_KEY = 'errors.server';

export type ApiErrorKey =
  | (typeof CODE_KEYS)[keyof typeof CODE_KEYS]
  | (typeof PROBLEM_KEYS)[keyof typeof PROBLEM_KEYS]
  | (typeof STATUS_KEYS)[keyof typeof STATUS_KEYS]
  | typeof NETWORK_KEY
  | typeof UNEXPECTED_KEY
  | typeof SERVER_KEY;

/** What a failed response looks like to this module. */
export interface ApiFailure {
  /** `res.status`. Omit when the request never completed. */
  status?: number;
  /** The parsed body, or anything at all — this validates it itself. */
  body?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The locale key for a top-level code, or `null` if this build has not heard of it. */
export function errorKeyFor(code: unknown): ApiErrorKey | null {
  if (typeof code !== 'string') return null;
  return (CODE_KEYS as Record<string, ApiErrorKey>)[code] ?? null;
}

/** The locale key for one `problems[]` entry, or `null`. */
export function problemKeyFor(code: unknown): ApiErrorKey | null {
  if (typeof code !== 'string') return null;
  return (PROBLEM_KEYS as Record<string, ApiErrorKey>)[code] ?? null;
}

/**
 * Rung 3 and 4: a sentence derived from the status alone.
 *
 * Every 5xx collapses to one key. The distinction between a 500 and a 503 is
 * real to an operator and meaningless to a patient holding a phone, and it is
 * `errors.server` rather than `errors.internal` because at this rung the client
 * has no evidence about *whose* fault it was.
 */
export function statusFallbackKey(status?: number): ApiErrorKey {
  if (typeof status !== 'number' || !Number.isFinite(status)) return NETWORK_KEY;
  if (status >= 500) return SERVER_KEY;
  return (STATUS_KEYS as Record<number, ApiErrorKey>)[status] ?? UNEXPECTED_KEY;
}

/**
 * Every key worth showing for a failure, most specific first.
 *
 * Returns at least one key, always. A caller rendering only `keys[0]` still
 * gets a correct sentence; one rendering all of them gets the per-field detail.
 */
export function apiErrorKeys({ status, body }: ApiFailure): ApiErrorKey[] {
  const parsed: ApiErrorBody = isObject(body) ? (body as ApiErrorBody) : {};

  // 1 — per-field problems. Unrecognised entries are dropped rather than
  // rendered raw: `problems[].message` is English from the server, and showing
  // it is the exact behaviour 6.2 exists to remove.
  if (Array.isArray(parsed.problems)) {
    const keys: ApiErrorKey[] = [];
    for (const problem of parsed.problems) {
      const key = problemKeyFor(isObject(problem) ? problem.code : undefined);
      // De-duplicated: three bad meal times are one sentence, not three.
      if (key && !keys.includes(key)) keys.push(key);
    }
    if (keys.length > 0) return keys;
  }

  // 2 — the code itself.
  const codeKey = errorKeyFor(parsed.code);
  if (codeKey) return [codeKey];

  // 3 and 4.
  return [statusFallbackKey(status)];
}

/**
 * The whole failure as one translated string.
 *
 * `translate` is injected so this module stays dependency-free and testable;
 * callers pass `t` from `useTranslation()`.
 */
export function apiErrorMessage(
  failure: ApiFailure,
  translate: (key: ApiErrorKey) => string
): string {
  return apiErrorKeys(failure)
    .map((key) => translate(key))
    .join('\n');
}

/**
 * Read a `Response` and describe why it failed, without throwing.
 *
 * The `.catch` matters: a 502 from the gateway is HTML, and a parse failure
 * there must degrade to the status ladder rather than becoming a second,
 * unrelated error inside the error handler.
 */
export async function describeApiFailure(response: {
  status?: number;
  json: () => Promise<unknown>;
}): Promise<ApiFailure> {
  const body = await response.json().catch(() => undefined);
  return { status: response.status, body };
}
