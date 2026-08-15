import { ExternalLink } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { config } from "@/lib/config"

/**
 * TELEMETRY.md §4 — Metabase, brought into the portal as far as it can be.
 *
 * **Metabase is a separate app, and §4 lists that first among its limits.** It
 * has its own accounts and its own login; SAML and JWT SSO are paid, so signing
 * in with Cognito is not available. The link below therefore goes to Metabase's
 * own login screen, and that is the reliable half of this page.
 *
 * **The Metabase UI itself can never be embedded.** It serves
 * `X-Frame-Options: DENY` and `frame-ancestors 'none'` on the app, which is a
 * deliberate anti-clickjacking measure and not a setting — the login page in
 * particular will never render in an iframe from anywhere. Only `/embed/*`
 * routes are frameable, and those show **one** dashboard or question, signed
 * with the embedding secret, read-only and Metabase-themed. Interactive
 * embedding with drill-through and row-level sandboxing is paid.
 *
 * So the embed slot below is for a signed static embed of a specific dashboard,
 * and it stays empty and explains itself until three things are true. That is
 * deliberate: a blank iframe that fails silently is worse than a panel saying
 * what is missing.
 */

/** Whether an `http://` frame would be blocked inside this page. */
function isMixedContent(url: string | undefined): boolean {
  if (!url) return false
  return window.location.protocol === "https:" && url.startsWith("http://")
}

export function AnalyticsPage() {
  const base = config.metabaseUrl
  const embed = config.metabaseEmbedUrl
  const blocked = isMixedContent(embed) || isMixedContent(base)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Ad-hoc questions over both stores — care data in Postgres, product analytics in Athena.
          </p>
        </div>

        {base ? (
          <Button asChild>
            {/*
              `noreferrer` alongside `noopener`: the target is an internal BI
              tool, and there is no reason to hand it the portal's URL.
            */}
            <a href={base} target="_blank" rel="noopener noreferrer">
              Open Metabase
              <ExternalLink className="ml-2 h-4 w-4" />
            </a>
          </Button>
        ) : null}
      </div>

      {!base ? (
        <Card>
          <CardHeader>
            <CardTitle>Metabase isn't configured</CardTitle>
            <CardDescription>
              Set <code>VITE_METABASE_URL</code> to its base URL — in{" "}
              <code>.env.local</code> for dev, or the Amplify Hosting console for deploys.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Signing in</CardTitle>
            <CardDescription>
              Metabase keeps its own accounts, so it asks for a separate login rather than
              reusing this one. SSO would need the paid tier.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>
              Both data sources are connected there: <strong>TISH App</strong> for doses,
              reminders and patients, and <strong>TISH Analytics</strong> for app-open events.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Embedded dashboard</CardTitle>
          <CardDescription>
            A signed, read-only view of one Metabase dashboard, shown inside the portal.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {embed && !blocked ? (
            <iframe
              src={embed}
              title="Metabase dashboard"
              className="h-[720px] w-full rounded-md border"
              // The embed is read-only and same-purpose, but it is still a
              // separate origin rendering inside the admin portal.
              sandbox="allow-scripts allow-same-origin allow-popups"
              allowTransparency
            />
          ) : (
            <NotEmbeddableYet blocked={blocked} hasEmbed={Boolean(embed)} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Says exactly what is missing, because all three prerequisites are invisible
 * from here and each one fails as a blank frame.
 */
function NotEmbeddableYet({ blocked, hasEmbed }: { blocked: boolean; hasEmbed: boolean }) {
  return (
    <div className="space-y-4 rounded-md border border-dashed p-6 text-sm">
      <p className="font-medium">Nothing embedded yet. Three things have to be true:</p>

      <ol className="ml-5 list-decimal space-y-3 text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">Metabase has to be served over HTTPS.</span>{" "}
          This portal is HTTPS, so a browser refuses to load an <code>http://</code> frame
          inside it — a hard block with no override.
          {blocked ? (
            <span className="ml-1 font-medium text-destructive">
              This is currently what's stopping it.
            </span>
          ) : null}
        </li>
        <li>
          <span className="font-medium text-foreground">Static embedding has to be enabled</span>{" "}
          in Metabase under Admin → Embedding, and the dashboard marked embeddable. That yields
          the signing secret.
        </li>
        <li>
          <span className="font-medium text-foreground">
            A signed embed URL has to reach this page
          </span>{" "}
          as <code>VITE_METABASE_EMBED_URL</code>.
          {hasEmbed ? null : " It isn't set."}
        </li>
      </ol>

      <p className="text-muted-foreground">
        The Metabase app itself can't be embedded at all — it sends{" "}
        <code>X-Frame-Options: DENY</code>, so the login page will never render in a frame.
        Only a specific signed dashboard can. Use the button above in the meantime.
      </p>
    </div>
  )
}
