import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ExternalLink, Loader2, Power } from "lucide-react"
import { useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { useApi } from "@/lib/api"
import { config } from "@/lib/config"
import type { DailyOpen, MetabaseState } from "@/lib/types"

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

const RANGES = [
  { value: "14", label: "Last 14 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
]

const opensConfig = {
  cold: { label: "Cold start", color: "var(--chart-1)" },
  foreground: { label: "Returned", color: "var(--chart-2)" },
  notification: { label: "From a reminder", color: "var(--chart-3)" },
} satisfies ChartConfig

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
            What's in the telemetry data, and where to go when you need more than this.
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

      <TelemetryOverview />

      {!base ? (
        <Card>
          <CardHeader>
            <CardTitle>Metabase isn't configured</CardTitle>
            <CardDescription>
              Set the <code>VITE_METABASE_URL</code> repo variable to its base URL and re-run
              the dashboard deploy — the value is baked into the bundle at build time.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <PowerCard />
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

const STATE_LABELS: Record<MetabaseState, string> = {
  running: "Running",
  stopped: "Stopped",
  pending: "Starting…",
  stopping: "Stopping…",
  "shutting-down": "Stopping…",
  terminated: "Terminated",
  unknown: "Unknown",
}

/**
 * Start and stop the Metabase host from here.
 *
 * **Because it is meant to be off most of the time.** §4 stands it up to find
 * out which questions get asked repeatedly, and it costs ~$25/month running
 * against ~$7 stopped — so switching it off between beta programmes is the
 * plan, not an exception. A cost control that requires a console trip is one
 * that quietly stops being used.
 *
 * Nothing is lost by stopping it: the application database is a container on
 * the instance's own EBS volume, so dashboards, accounts and data sources all
 * survive, and the Elastic IP means the address does not change.
 */
function PowerCard() {
  const api = useApi()
  const queryClient = useQueryClient()
  const [confirmingStop, setConfirmingStop] = useState(false)

  const status = useQuery({
    queryKey: ["metabase-status"],
    queryFn: api.getMetabaseStatus,
    // **Polls only while something is in flight.** Starting takes a couple of
    // minutes, and a page that sat on "Starting…" until manually reloaded would
    // send people to the console to find out — which is the thing this replaces.
    refetchInterval: (query) => (query.state.data?.transitional ? 4000 : false),
  })

  const power = useMutation({
    mutationFn: (action: "start" | "stop") => api.setMetabasePower(action),
    onSuccess: () => {
      setConfirmingStop(false)
      queryClient.invalidateQueries({ queryKey: ["metabase-status"] })
    },
  })

  const state = status.data?.state
  const busy = status.data?.transitional === true || power.isPending
  const running = state === "running"

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            Metabase
            {status.isPending ? (
              <Skeleton className="h-5 w-20" />
            ) : (
              <Badge variant={running ? "secondary" : "outline"}>
                {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                {STATE_LABELS[state ?? "unknown"]}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Off between beta programmes — roughly $25/month running, $7 stopped. Dashboards,
            accounts and both data sources survive a stop; the address doesn't change.
          </CardDescription>
        </div>

        <div className="flex gap-2">
          {running && confirmingStop ? (
            <>
              <Button variant="destructive" disabled={busy} onClick={() => power.mutate("stop")}>
                Confirm stop
              </Button>
              <Button variant="outline" onClick={() => setConfirmingStop(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant={running ? "outline" : "default"}
              disabled={busy || state === "terminated" || state === "unknown"}
              // **Stopping asks twice, starting does not.** Starting costs
              // money and two minutes; stopping cuts off anyone mid-query.
              onClick={() => (running ? setConfirmingStop(true) : power.mutate("start"))}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Power className="mr-2 h-4 w-4" />
              )}
              {running ? "Stop" : "Start"}
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-2 text-sm text-muted-foreground">
        {power.error ? (
          <p className="text-destructive">{(power.error as Error).message}</p>
        ) : null}
        {status.error ? (
          <p className="text-destructive">
            Couldn't read the instance state: {(status.error as Error).message}
          </p>
        ) : null}

        {state === "stopped" ? (
          <p>Starting takes a couple of minutes before the login page answers.</p>
        ) : null}
        {running && status.data?.since ? (
          <p>Running since {new Date(status.data.since).toLocaleString("en-GB")}.</p>
        ) : null}

        <p>
          Metabase keeps its own accounts, so it asks for a separate login rather than reusing
          this one — SSO would need the paid tier. Both data sources are connected there:{" "}
          <strong>TISH App</strong> for doses, reminders and patients, and{" "}
          <strong>TISH Analytics</strong> for app-open events.
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * What is actually in the telemetry data, without Metabase running.
 *
 * **This exists so that turning Metabase on is an informed decision rather than
 * a hopeful one.** It costs ~$25/month to leave running and the plan is to
 * switch it off between beta programmes, so the question "is there enough here
 * to be worth starting it?" gets asked repeatedly — and answering it by
 * starting the thing you were trying to avoid starting is a poor trade.
 *
 * Reads `telemetry_daily_opens`, which the nightly rollup writes (TELEMETRY.md
 * §4). **No Athena query happens on this page load**, which is the entire point
 * of that job: Athena is asynchronous and polled, bills a 10 MB minimum per
 * query, and is minutes stale anyway, so a live query would be slow, billed per
 * viewer, and no fresher than this.
 */
function TelemetryOverview() {
  const api = useApi()
  const [days, setDays] = useState("30")

  const range = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - Number(days) * 86400000)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [days])

  const query = useQuery({
    queryKey: ["daily-opens", range.from, range.to],
    queryFn: () => api.getDailyOpens(range),
  })

  // Memoised rather than `?? []` inline: a fresh array literal on every render
  // makes both memos below recompute every time, which defeats the point of
  // having them.
  const rows: DailyOpen[] = useMemo(() => query.data?.opens ?? [], [query.data])
  const summary = useMemo(() => summarise(rows), [rows])
  const chart = useMemo(() => toChartRows(rows), [rows])

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>App opens</CardTitle>
          <CardDescription>
            From the nightly rollup, so this page never queries Athena. Enough to tell whether
            there's anything worth digging into.
          </CardDescription>
        </div>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>

      <CardContent className="space-y-6">
        {query.isPending ? <Skeleton className="h-[300px] w-full" /> : null}

        {query.error ? (
          <p className="text-sm text-destructive">{(query.error as Error).message}</p>
        ) : null}

        {/*
          Gated on the open count, not the row count. The rollup can hold rows
          that sum to zero, and a page of zeroed tiles beside an empty chart
          reads as broken rather than as "nothing has happened yet".
        */}
        {!query.isPending && !query.error && summary.opens === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">No app opens recorded in this range.</p>
            <p className="pt-2">
              Either nobody has opened the app, or no build carrying telemetry has shipped yet.
              Events buffer on the device and flush on the next launch, and the rollup runs
              once a night at 04:10 — so a first data point can be a day behind the first use.
            </p>
          </div>
        ) : null}

        {summary.opens > 0 ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Opens" value={String(summary.opens)} detail={`over ${summary.days} days with activity`} />
              <Stat
                label="Busiest day"
                value={summary.peak ? String(summary.peak.opens) : "—"}
                detail={summary.peak ? shortDay(summary.peak.day) : "no data"}
              />
              <Stat
                label="From a reminder"
                value={summary.opens > 0 ? `${Math.round((summary.notification / summary.opens) * 100)}%` : "—"}
                // §3 trap 2: counted together with spontaneous opens, this
                // metric mostly measures how many medications someone is on.
                detail="the OS opening the app, not the user"
              />
              <Stat
                label="Last rolled up"
                value={summary.refreshedAt ? shortDay(summary.refreshedAt) : "never"}
                detail={summary.stale ? "stale — check the nightly job" : "nightly at 04:10 Taipei"}
              />
            </div>

            <ChartContainer config={opensConfig} className="h-[260px] w-full">
              <BarChart data={chart} margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} />
                <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                {/* Stacked, because the split between them is the whole point. */}
                <Bar dataKey="cold" stackId="a" fill="var(--color-cold)" radius={[0, 0, 2, 2]} />
                <Bar dataKey="foreground" stackId="a" fill="var(--color-foreground)" />
                <Bar dataKey="notification" stackId="a" fill="var(--color-notification)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ChartContainer>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="pt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="pt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}

/**
 * **`users` is deliberately not summed anywhere here.** The rollup counts
 * distinct users per day *and per source*, so somebody who opened from a
 * reminder and again from cold appears in two rows — adding them up would
 * invent people. Opens are additive; users are not.
 */
function summarise(rows: DailyOpen[]) {
  const byDay = new Map<string, number>()
  let opens = 0
  let notification = 0
  let refreshedAt: string | null = null

  for (const row of rows) {
    opens += row.opens
    if (row.source === "notification") notification += row.opens
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.opens)
    if (!refreshedAt || row.refreshed_at > refreshedAt) refreshedAt = row.refreshed_at
  }

  // **Days with opens, not days with rows.** The rollup can legitimately hold a
  // row of zero — a day whose events were deleted, or recomputed after the
  // source data went away — and counting those as "days with activity" reports
  // a busy fortnight that never happened.
  let activeDays = 0
  for (const n of byDay.values()) if (n > 0) activeDays++

  let peak: { day: string; opens: number } | null = null
  for (const [day, n] of byDay) {
    if (!peak || n > peak.opens) peak = { day, opens: n }
  }

  // A nightly job that quietly stopped looks exactly like a quiet fortnight,
  // which is why the tile says so rather than just showing a date.
  const stale = refreshedAt ? Date.now() - Date.parse(refreshedAt) > 36 * 3600 * 1000 : false

  return { opens, notification, days: activeDays, peak, refreshedAt, stale }
}

/** One row per day with a column per source, which is what a stacked bar needs. */
function toChartRows(rows: DailyOpen[]) {
  const byDay = new Map<string, Record<string, string | number>>()
  for (const row of rows) {
    const entry = byDay.get(row.day) ?? { day: row.day, cold: 0, foreground: 0, notification: 0 }
    entry[row.source] = (Number(entry[row.source]) || 0) + row.opens
    byDay.set(row.day, entry)
  }
  return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)))
}

function shortDay(day: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" }).format(new Date(day))
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
