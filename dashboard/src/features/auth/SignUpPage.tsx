import { useState } from "react"
import { Link } from "react-router-dom"
import { CheckCircle2, Loader2, MailCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { confirmSignUp, friendlyError, resendCode, signUp } from "@/lib/signup"

type Stage = "form" | "confirm" | "awaitingApproval"

function Field({
  id,
  label,
  hint,
  ...props
}: { id: string; label: string; hint?: string } & React.ComponentProps<"input">) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function SignUpPage() {
  const [stage, setStage] = useState<Stage>("form")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [code, setCode] = useState("")
  const [destination, setDestination] = useState("")

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault()
    setError(undefined)
    setNotice(undefined)

    // Checked here rather than relying on Cognito, which has no notion of a
    // confirmation field and would happily create the account.
    if (password !== confirmPassword) {
      setError("The two passwords do not match.")
      return
    }

    setBusy(true)
    try {
      const result = await signUp({ name, email, phone, password })
      setDestination(result.destination)
      // A pool configured to auto-confirm would skip the code entirely; this
      // one does not, but the branch keeps the flow correct either way.
      setStage(result.confirmed ? "awaitingApproval" : "confirm")
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault()
    setError(undefined)
    setNotice(undefined)
    setBusy(true)
    try {
      await confirmSignUp(email, code)
      setStage("awaitingApproval")
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleResend() {
    setError(undefined)
    setNotice(undefined)
    setBusy(true)
    try {
      const result = await resendCode(email)
      setDestination(result.destination)
      setNotice(`A new code is on its way to ${result.destination}.`)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4">
        <div className="text-center text-lg font-bold tracking-tight">Tish Admin</div>

        <Card>
          {stage === "form" && (
            <>
              <CardHeader>
                <CardTitle>Create your account</CardTitle>
                <CardDescription>
                  For staff only. An administrator approves each account before it can see any data.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSignUp} className="space-y-4">
                  <Field
                    id="name"
                    label="Preferred name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    required
                    disabled={busy}
                    hint="How you'll be shown in the dashboard."
                  />
                  <Field
                    id="email"
                    label="Work email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    required
                    disabled={busy}
                    hint="Must be a @ti-smarthealth.com address."
                  />
                  <Field
                    id="phone"
                    label="Mobile number (optional)"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="tel"
                    disabled={busy}
                    placeholder="+886912345678"
                    hint="Include the country code. Not used yet — stored for SMS verification later."
                  />
                  <Field
                    id="password"
                    label="Password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                    disabled={busy}
                    hint="At least 12 characters, with upper and lower case, a number and a symbol."
                  />
                  <Field
                    id="confirmPassword"
                    label="Confirm password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                    disabled={busy}
                  />

                  {error && <p className="text-sm text-destructive">{error}</p>}

                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy && <Loader2 className="animate-spin" />}
                    Create account
                  </Button>
                </form>
              </CardContent>
            </>
          )}

          {stage === "confirm" && (
            <>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MailCheck className="size-4" />
                  Check your email
                </CardTitle>
                <CardDescription>
                  We sent a six-digit code to <span className="font-medium">{destination}</span>. Enter it
                  below to confirm the address.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleConfirm} className="space-y-4">
                  <Field
                    id="code"
                    label="Verification code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    disabled={busy}
                  />

                  {error && <p className="text-sm text-destructive">{error}</p>}
                  {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy && <Loader2 className="animate-spin" />}
                    Confirm
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={handleResend}
                    disabled={busy}
                  >
                    Send a new code
                  </Button>
                </form>
              </CardContent>
            </>
          )}

          {stage === "awaitingApproval" && (
            <>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="size-4" />
                  Account created
                </CardTitle>
                <CardDescription>
                  Your email is confirmed. An administrator now has to approve the account before it can
                  reach any data — you'll be able to sign in once they have.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild className="w-full">
                  <Link to="/">Go to sign in</Link>
                </Button>
              </CardContent>
            </>
          )}
        </Card>

        {stage === "form" && (
          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link to="/" className="underline underline-offset-4">
              Sign in
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}
