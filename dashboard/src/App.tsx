import { useEffect } from "react"
import { Navigate, Route, Routes } from "react-router-dom"

import { Layout } from "@/components/layout"
import { Skeleton } from "@/components/ui/skeleton"
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

  // Admin tool: go straight to the hosted login rather than showing a landing page
  useEffect(() => {
    if (missing.length === 0 && !auth.isLoading && !auth.isAuthenticated && !auth.error) {
      auth.signIn()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.isLoading, auth.isAuthenticated, auth.error])

  if (missing.length > 0) {
    return (
      <CenteredNote title="Dashboard not configured">
        Missing environment variables: <code>{missing.join(", ")}</code>. Set them in{" "}
        <code>.env.local</code> (dev) or the Amplify Hosting console (deploys) — see{" "}
        <code>AWS-SETUP.md</code>. For UI development without AWS, set <code>VITE_MOCK=1</code>.
      </CenteredNote>
    )
  }

  if (auth.error) {
    return (
      <CenteredNote title="Sign-in failed">
        {auth.error} —{" "}
        <button className="underline" onClick={auth.signIn}>
          try again
        </button>
      </CenteredNote>
    )
  }

  if (auth.isLoading || !auth.isAuthenticated) {
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
