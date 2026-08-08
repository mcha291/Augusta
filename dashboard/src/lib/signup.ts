// Cognito self-registration, called straight from the browser.
//
// SignUp / ConfirmSignUp / ResendConfirmationCode are *unauthenticated* Cognito
// operations — no SigV4 signing, no credentials, nothing to keep secret. The
// app client is public and has no secret, so these are three plain JSON POSTs
// and pulling in an AWS SDK to make them would add a lot of bundle for nothing.
//
// The one thing this file has to get right is error handling: Cognito's error
// bodies are machine-readable but its messages are not always fit to show a
// user, so `friendlyError` maps the ones staff will actually hit.

import { config } from "@/lib/config"

/** Derived from the OIDC authority: https://cognito-idp.<region>.amazonaws.com/<poolId> */
function cognitoEndpoint(): string {
  const authority = config.cognitoAuthority ?? ""
  const match = authority.match(/^(https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com)\//)
  if (!match) throw new Error("VITE_COGNITO_AUTHORITY is not a Cognito issuer URL")
  return match[1]
}

/** The pool id is the last path segment of the authority. */
export function poolIdFromAuthority(authority: string | undefined): string {
  return (authority ?? "").split("/").filter(Boolean).pop() ?? ""
}

export class CognitoError extends Error {
  /** Cognito's __type, e.g. "UsernameExistsException" */
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

async function call<T>(target: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(cognitoEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}) as Record<string, string>)
    // __type looks like "com.amazonaws...#UsernameExistsException"
    const code = String(payload.__type ?? "UnknownError").split("#").pop() ?? "UnknownError"
    throw new CognitoError(code, String(payload.message ?? `Request failed (${res.status})`))
  }
  return (await res.json()) as T
}

export interface SignUpInput {
  name: string
  email: string
  /** E.164, e.g. +886912345678. Optional while SMS verification is off. */
  phone?: string
  password: string
}

export interface SignUpResult {
  /** Where Cognito sent the code, e.g. "EMAIL" */
  medium: string
  /** Obfuscated destination Cognito reports, e.g. "n***@t***.com" */
  destination: string
  /** True when Cognito considers the account already usable (no code needed) */
  confirmed: boolean
}

interface SignUpResponse {
  UserConfirmed?: boolean
  CodeDeliveryDetails?: { DeliveryMedium?: string; Destination?: string }
}

export async function signUp(input: SignUpInput): Promise<SignUpResult> {
  const attributes = [
    { Name: "email", Value: input.email.trim() },
    { Name: "name", Value: input.name.trim() },
  ]
  // Only sent when supplied: Cognito rejects an empty phone_number outright,
  // and the attribute is optional on this pool until SMS verification is on.
  if (input.phone?.trim()) attributes.push({ Name: "phone_number", Value: input.phone.trim() })

  const res = await call<SignUpResponse>("SignUp", {
    ClientId: config.cognitoClientId,
    Username: input.email.trim(),
    Password: input.password,
    UserAttributes: attributes,
  })

  return {
    medium: res.CodeDeliveryDetails?.DeliveryMedium ?? "EMAIL",
    destination: res.CodeDeliveryDetails?.Destination ?? input.email,
    confirmed: res.UserConfirmed === true,
  }
}

export async function confirmSignUp(email: string, code: string): Promise<void> {
  await call("ConfirmSignUp", {
    ClientId: config.cognitoClientId,
    Username: email.trim(),
    ConfirmationCode: code.trim(),
  })
}

export async function resendCode(email: string): Promise<SignUpResult> {
  const res = await call<{ CodeDeliveryDetails?: { DeliveryMedium?: string; Destination?: string } }>(
    "ResendConfirmationCode",
    { ClientId: config.cognitoClientId, Username: email.trim() }
  )
  return {
    medium: res.CodeDeliveryDetails?.DeliveryMedium ?? "EMAIL",
    destination: res.CodeDeliveryDetails?.Destination ?? email,
    confirmed: false,
  }
}

/**
 * Cognito's raw messages range from fine to actively confusing. Notably, a
 * Pre Sign-up trigger rejection arrives as UserLambdaValidationException with
 * the thrown message buried behind a prefix like
 * "PreSignUp failed with error <message>" — staff should see the message, not
 * the plumbing.
 */
export function friendlyError(e: unknown): string {
  if (!(e instanceof CognitoError)) {
    return e instanceof Error ? e.message : "Something went wrong. Try again."
  }
  switch (e.code) {
    case "UserLambdaValidationException":
      // Arrives as: "PreSignUp failed with error <our message>." — Cognito
      // prepends the trigger name and appends its own full stop, so a message
      // that already ends in one comes through as "...for you..".
      return e.message.replace(/^.*?failed with error\s*/i, "").replace(/[.;\s]+$/, "") + "."
    case "UsernameExistsException":
      return "An account with this email already exists. Try signing in, or ask an administrator whether it still needs approving."
    case "InvalidPasswordException":
      return "That password does not meet the policy: at least 12 characters, with upper and lower case, a number and a symbol."
    case "InvalidParameterException":
      // Most commonly a malformed phone number.
      return e.message.includes("phone")
        ? "Phone number must include the country code, e.g. +886912345678."
        : e.message
    case "CodeMismatchException":
      return "That code is not right. Check it and try again."
    case "ExpiredCodeException":
      return "That code has expired. Request a new one."
    case "LimitExceededException":
    case "TooManyRequestsException":
      return "Too many attempts. Wait a few minutes and try again."
    case "NotAuthorizedException":
      // Confirming an already-confirmed user lands here.
      return "This account is already confirmed. Try signing in."
    default:
      return e.message
  }
}
