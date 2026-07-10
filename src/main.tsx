import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { AuthProvider } from "react-oidc-context"
import { BrowserRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { oidcConfig } from "@/lib/auth"
import { MOCK } from "@/lib/config"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
})

const app = (
  <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </ThemeProvider>
)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* In mock mode there is no OIDC provider — useAdminAuth/useApi never touch it */}
    {MOCK ? app : <AuthProvider {...oidcConfig()}>{app}</AuthProvider>}
  </StrictMode>
)
