import { useAuth } from "react-oidc-context"

import { config, MOCK } from "@/lib/config"

/** Membership of this Cognito group is what the admin API actually checks. */
export const APPROVED_GROUP = "approved"

export interface AdminAuth {
  isLoading: boolean
  isAuthenticated: boolean
  email: string | undefined
  /**
   * Read from the ID token's `cognito:groups` claim. This is presentation only
   * — it decides whether to show the dashboard or a waiting screen, saving a
   * round trip that would only come back 403. The API enforces the same rule
   * server-side on every request, which is the check that matters.
   */
  isApproved: boolean
  error: string | undefined
  signIn: () => void
  signOut: () => void
}

/** Cognito sends this as an array; be tolerant of a string just in case. */
function groupsOf(profile: Record<string, unknown> | undefined): string[] {
  const raw = profile?.["cognito:groups"]
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === "string") return raw.split(",").map((g) => g.trim())
  return []
}

/** oidc-client-ts settings for the Cognito admin pool (Hosted UI, code + PKCE) */
export function oidcConfig() {
  return {
    authority: config.cognitoAuthority ?? "",
    client_id: config.cognitoClientId ?? "",
    redirect_uri: window.location.origin,
    response_type: "code",
    scope: "openid email",
    // strip ?code=&state= from the URL after the callback is processed
    onSigninCallback: () => {
      window.history.replaceState({}, document.title, window.location.pathname)
    },
  }
}

function useRealAdminAuth(): AdminAuth {
  const auth = useAuth()
  return {
    isLoading: auth.isLoading,
    isAuthenticated: auth.isAuthenticated,
    email: auth.user?.profile?.email,
    isApproved: groupsOf(auth.user?.profile).includes(APPROVED_GROUP),
    error: auth.error?.message,
    signIn: () => void auth.signinRedirect(),
    signOut: () => {
      void auth.removeUser()
      // Full Cognito-side sign-out when the hosted domain is configured;
      // otherwise the local session removal above is sufficient to force
      // a fresh login on next visit.
      if (config.cognitoDomain && config.cognitoClientId) {
        const logout = new URL(`${config.cognitoDomain}/logout`)
        logout.searchParams.set("client_id", config.cognitoClientId)
        logout.searchParams.set("logout_uri", window.location.origin)
        window.location.assign(logout.toString())
      }
    },
  }
}

function useMockAdminAuth(): AdminAuth {
  return {
    isLoading: false,
    isAuthenticated: true,
    email: "demo@mock.local",
    isApproved: true,
    error: undefined,
    signIn: () => {},
    signOut: () => window.alert("Mock mode — no real session to sign out of."),
  }
}

export const useAdminAuth: () => AdminAuth = MOCK ? useMockAdminAuth : useRealAdminAuth
