import { useAuth } from "react-oidc-context"

import { config, MOCK } from "@/lib/config"

export interface AdminAuth {
  isLoading: boolean
  isAuthenticated: boolean
  email: string | undefined
  error: string | undefined
  signIn: () => void
  signOut: () => void
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
    error: undefined,
    signIn: () => {},
    signOut: () => window.alert("Mock mode — no real session to sign out of."),
  }
}

export const useAdminAuth: () => AdminAuth = MOCK ? useMockAdminAuth : useRealAdminAuth
