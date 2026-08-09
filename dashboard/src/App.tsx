import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom"

import { Layout } from "@/components/layout"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { LandingPage } from "@/features/auth/LandingPage"
import { SignUpPage } from "@/features/auth/SignUpPage"
import { DatabasePage } from "@/features/database/DatabasePage"
import { TranslationsPage } from "@/features/translations/TranslationsPage"
import { useAdminAuth } from "@/lib/auth"
import { missingConfig } from "@/lib/config"

function CenteredNote({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md space-y-2 text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        <div className="text-sm text-muted-foreground">{children}</div>
      </div>
    </div>
  )
}

export default function App() {
  const auth = useAdminAuth()
  const missing = missingConfig()
  // Sign-up is reachable without a session, and so is the landing screen below.
  const isSignUp = useLocation().pathname === "/signup"

  if (missing.length > 0) {
    return (
      <CenteredNote title="Dashboard not configured">
        Missing environment variables: <code>{missing.join(", ")}</code>. Set them in{" "}
        <code>.env.local</code> (dev) or the Amplify Hosting console (deploys) — see{" "}
        <code>AWS-SETUP.md</code>. For UI development without AWS, set <code>VITE_MOCK=1</code>.
      </CenteredNote>
    )
  }

  // Rendered before the auth checks below: reaching this page is the whole
  // point of not having a session yet.
  if (isSignUp) {
    return (
      <Routes>
        <Route path="/signup" element={<SignUpPage />} />
      </Routes>
    )
  }

  if (auth.error) {
    return (
      <CenteredNote title="Sign-in failed">
        {auth.error} —{" "}
        <button className="underline" onClick={auth.signIn}>
          try again
        </button>
        <div className="pt-4">
          <Link to="/signup" className="underline underline-offset-4">
            Create an account
          </Link>
        </div>
      </CenteredNote>
    )
  }

  // Still true immediately after the Cognito callback, while oidc-client-ts
  // exchanges the ?code= for tokens — so this has to stay ahead of the landing
  // screen, or a returning user sees "Sign in" flash before their session lands.
  if (auth.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-64 space-y-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-52" />
        </div>
      </div>
    )
  }

  if (!auth.isAuthenticated) {
    return <LandingPage onSignIn={auth.signIn} />
  }

  // Signed in, but not yet in the `approved` group. Showing the dashboard would
  // mean every panel rendering the same 403; this says the one useful thing
  // instead. The API enforces this independently — see isApproved in auth.ts.
  if (!auth.isApproved) {
    return (
      <CenteredNote title="Waiting for approval">
        <p>
          You're signed in as <span className="font-medium">{auth.email}</span>, but an administrator
          hasn't approved this account yet. It will work as soon as they do.
        </p>
        <p className="pt-3 text-xs">
          Already been approved? Sign out and back in — approval only reaches your session on a fresh
          sign-in.
        </p>
        <div className="pt-4">
          <Button variant="outline" size="sm" onClick={auth.signOut}>
            Sign out
          </Button>
        </div>
      </CenteredNote>
    )
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/translations" replace />} />
        <Route path="/translations" element={<TranslationsPage />} />
        <Route path="/database" element={<DatabasePage />} />
        <Route path="*" element={<Navigate to="/translations" replace />} />
      </Route>
    </Routes>
  )
}
