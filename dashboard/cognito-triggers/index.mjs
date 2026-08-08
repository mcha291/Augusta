// Cognito Pre Sign-up trigger for the tish-admin user pool.
//
// Self-signup is open on this pool so staff can register themselves, which
// means this function is the only thing standing between the public internet
// and a row in the user directory. It enforces one rule: the address must be
// on the company domain.
//
// That rule is not cosmetic. SES in ap-northeast-2 is still in the sandbox, so
// it can only deliver to verified identities — and the verified identity is the
// *domain* ti-smarthealth.com. A gmail.com signup would be accepted by Cognito,
// then never receive its verification code, and sit UNCONFIRMED forever with no
// indication to the user of why. Failing loudly at sign-up is the honest
// outcome. When SES production access is granted, relax ALLOWED_DOMAINS.
//
// Approval is deliberately NOT handled here. Signing up gets you an account;
// it does not get you data. The admin API checks for membership of the
// `approved` group on every request, so an unapproved account can sign in and
// see nothing. Gating there rather than at sign-in means removing someone takes
// effect within the ID token's hour, instead of waiting out a 30-day refresh
// token.

// Comma-separated, configurable without a redeploy.
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'ti-smarthealth.com')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export function domainOf(email) {
  if (typeof email !== 'string') return '';
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
}

export function isAllowedEmail(email, allowed = ALLOWED_DOMAINS) {
  if (typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  // A non-empty local part is required too: "@ti-smarthealth.com" has an
  // allowed domain but is not an address anyone can receive mail at.
  if (at <= 0) return false;
  return allowed.includes(domainOf(email));
}

// Message shown verbatim by Cognito to whoever is signing up, so it has to
// explain the fix rather than just state the rule.
export function rejectionMessage(allowed = ALLOWED_DOMAINS) {
  const list = allowed.map((d) => `@${d}`).join(' or ');
  return `Sign-up is limited to ${list} email addresses. Use your work email, or ask an administrator to create the account for you.`;
}

export async function handler(event) {
  // PreSignUp fires for three sources; only self-service registration should be
  // filtered. An admin creating a user from the console must never be blocked,
  // otherwise the domain rule locks the owner out of their own escape hatch.
  if (event.triggerSource !== 'PreSignUp_SignUp') return event;

  const email = event.request?.userAttributes?.email ?? '';
  if (!isAllowedEmail(email)) {
    // Throwing is how a Cognito trigger rejects; the message reaches the client.
    throw new Error(rejectionMessage());
  }

  // Leave autoConfirm/autoVerify false: the user proves they own the address by
  // entering the emailed code. Auto-confirming here would let anyone register
  // an address they do not control.
  return event;
}
