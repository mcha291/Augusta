import { Link } from "react-router-dom"
import { LogIn, UserPlus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * Shown to anyone without a session, in place of bouncing straight to the
 * Cognito hosted login.
 *
 * The automatic redirect made the custom sign-up page effectively unreachable:
 * every visitor landed on the hosted login, whose own "Sign up" link leads to
 * Cognito's form instead. That form only collects email and password, so staff
 * following the obvious path would register without the name or mobile number
 * this app asks for. This screen puts both routes in front of them.
 */
export function LandingPage({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4">
        <div className="text-center text-lg font-bold tracking-tight">Tish Admin</div>

        <Card>
          <CardHeader>
            <CardTitle>Staff sign-in</CardTitle>
            <CardDescription>
              Internal tool for the Tish app. Accounts are approved by an administrator before
              they can see any data.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button className="w-full" onClick={onSignIn}>
              <LogIn />
              Sign in
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link to="/signup">
                <UserPlus />
                Create an account
              </Link>
            </Button>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          Sign-up is limited to @ti-smarthealth.com addresses.
        </p>
      </div>
    </div>
  )
}
