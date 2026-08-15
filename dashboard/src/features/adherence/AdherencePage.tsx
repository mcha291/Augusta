import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useApi } from "@/lib/api"
import type { AdherenceDose, AdherencePatient, AdherenceResponse } from "@/lib/types"

/**
 * TELEMETRY.md §4 — the per-patient drill-down.
 *
 * **The one view §4 says earns its keep**, and the reason is worth restating
 * because the cohort overview beside it was cut for the opposite reason: this
 * is a domain-specific timeline that no general BI tool draws. Metabase does
 * stat tiles and trend lines completely, so building those in shadcn is
 * rebuilding Metabase badly; a dose timeline showing confirmed/missed/snoozed
 * against scheduled times per reminder is not a standard chart type, the join
 * to `medication_reminders` is the whole point of it, and it is the view most
 * likely to grow actions attached to it.
 *
 * **Nothing here aggregates in the browser.** Every number on this page arrives
 * pre-aggregated: the histogram as 24 buckets, the trend as one row per day,
 * the summary as five integers. §4 calls that the decision that makes or breaks
 * the view — a patient with a year of three-times-daily doses is ~1,100 rows,
 * and the existing `GET /medication-doses` caps at 500 and cannot back a chart
 * at all.
 */

const RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last year" },
]

/** `width_bucket(…, 0, 120, 24)` — bucket n covers minutes (n-1)*5 to n*5. */
const BUCKET_MINUTES = 5
const OVERFLOW_BUCKET = 25

const trendConfig = {
  confirmed: { label: "Confirmed", color: "var(--chart-1)" },
  missed: { label: "Missed", color: "var(--chart-2)" },
} satisfies ChartConfig

const latencyConfig = {
  n: { label: "Doses", color: "var(--chart-1)" },
} satisfies ChartConfig

export function AdherencePage() {
  const api = useApi()
  const [chosen, setChosen] = useState<number | null>(null)
  const [days, setDays] = useState("30")

  /**
   * The range, recomputed only when the day count changes.
   *
   * `useMemo` and not a plain expression: the range is a react-query key, and a
   * fresh `new Date()` on every render would make the key different every time
   * and refetch forever.
   */
  const range = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - Number(days) * 86400000)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [days])

  const patientsQuery = useQuery({
    queryKey: ["adherence-patients"],
    queryFn: api.listAdherencePatients,
  })
  const patients: AdherencePatient[] | undefined = patientsQuery.data?.patients

  // Defaulting by derivation rather than by writing state from an effect: the
  // selection is "whatever was chosen, or else the first patient", which needs
  // no synchronisation and cannot cascade a render.
  const selected = chosen ?? patients?.[0]?.id ?? null

  const adherenceQuery = useQuery({
    queryKey: ["adherence", selected, range.from, range.to],
    queryFn: () => api.getPatientAdherence(selected as number, range),
    enabled: selected != null,
    // **The stale-response race, handled by the query key rather than by hand.**
    // Switching patients twice quickly issues two requests; keyed caching means
    // the answer for a patient you have navigated away from can never be
    // rendered under the current patient's name.
    placeholderData: keepPreviousData,
  })

  const data: AdherenceResponse | undefined = adherenceQuery.data
  const error = (patientsQuery.error ?? adherenceQuery.error) as Error | null
  const loading = adherenceQuery.isPending && selected != null

  const patient = patients?.find((p) => p.id === selected)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Adherence</h1>
          <p className="text-sm text-muted-foreground">
            Doses over a range: confirmed, missed, snoozed, and how long after the alarm.
          </p>
        </div>

        <div className="flex gap-2">
          <Select
            value={selected == null ? undefined : String(selected)}
            onValueChange={(v) => setChosen(Number(v))}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder={patients ? "Select a patient" : "Loading…"} />
            </SelectTrigger>
            <SelectContent>
              {(patients ?? []).map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.full_name || p.username || `User ${p.id}`} ({p.doses})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

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
        </div>
      </div>

      {error ? (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">{error.message}</CardContent>
        </Card>
      ) : null}

      {patients?.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No patient has any materialised doses yet. Doses appear once a medication reminder
            has been created and its schedule has been materialised.
          </CardContent>
        </Card>
      ) : null}

      {loading && !data ? <LoadingSkeleton /> : null}

      {data ? (
        <>
          <SummaryTiles data={data} patientName={patient?.full_name || patient?.username || null} />
          <div className="grid gap-6 lg:grid-cols-2">
            <TrendCard data={data} />
            <LatencyCard data={data} />
          </div>
          <TimelineCard data={data} />
        </>
      ) : null}
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  )
}

function SummaryTiles({ data, patientName }: { data: AdherenceResponse; patientName: string | null }) {
  const { summary } = data
  // **Of the doses whose time has passed**, not of every dose in the range —
  // a range extending into the future would otherwise count tonight's dose as
  // already missed and drag the rate down all day.
  const settled = summary.confirmed + summary.missed
  const rate = settled > 0 ? Math.round((summary.confirmed / settled) * 100) : null

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label="Confirmed"
        value={rate == null ? "—" : `${rate}%`}
        detail={`${summary.confirmed} of ${settled} doses due`}
      />
      <Tile label="Missed" value={String(summary.missed)} detail="past due, never confirmed" />
      <Tile label="Snoozed" value={String(summary.snoozed)} detail="doses snoozed at least once" />
      <Tile
        label="By caregiver"
        value={String(summary.by_caregiver)}
        // D-1 / §2: a caregiver pressing confirm is different behaviour and has
        // to be segmented rather than averaged into the patient's own timing.
        detail={patientName ? `confirmed for ${patientName} by someone else` : "confirmed by someone else"}
      />
    </div>
  )
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 text-xs text-muted-foreground">{detail}</CardContent>
    </Card>
  )
}

function TrendCard({ data }: { data: AdherenceResponse }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirmed and missed</CardTitle>
        <CardDescription>Per day, Taipei time — bucketed in SQL, not here.</CardDescription>
      </CardHeader>
      <CardContent>
        {data.daily.length === 0 ? (
          <EmptyNote>No doses were scheduled in this range.</EmptyNote>
        ) : (
          <ChartContainer config={trendConfig} className="h-[260px] w-full">
            <LineChart data={data.daily} margin={{ left: 4, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={shortDay}
              />
              <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Line
                dataKey="confirmed"
                type="monotone"
                stroke="var(--color-confirmed)"
                strokeWidth={2}
                dot={false}
              />
              <Line
                dataKey="missed"
                type="monotone"
                stroke="var(--color-missed)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

function LatencyCard({ data }: { data: AdherenceResponse }) {
  // The server returns only non-empty buckets. Filling the gaps here keeps the
  // x-axis linear in time — a bar chart that silently skips the quiet buckets
  // reads as a much tighter distribution than the real one.
  const bars = useMemo(() => {
    const byBucket = new Map(data.latency.map((b) => [b.bucket, b.n]))
    const filled = []
    for (let bucket = 1; bucket <= 24; bucket++) {
      filled.push({
        bucket,
        label: `${(bucket - 1) * BUCKET_MINUTES}`,
        n: byBucket.get(bucket) ?? 0,
      })
    }
    const overflow = byBucket.get(OVERFLOW_BUCKET) ?? 0
    if (overflow > 0) filled.push({ bucket: OVERFLOW_BUCKET, label: "2h+", n: overflow })
    return filled
  }, [data.latency])

  const total = data.latency.reduce((sum, b) => sum + b.n, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Time from dose due to confirmed</CardTitle>
        <CardDescription>
          Five-minute buckets. Uses the device's press time where it has one, so an offline
          confirm replayed later is not counted as hours late.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <EmptyNote>No confirmed doses in this range.</EmptyNote>
        ) : (
          <ChartContainer config={latencyConfig} className="h-[260px] w-full">
            <BarChart data={bars} margin={{ left: 4, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={16}
              />
              <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
              <ChartTooltip
                content={<ChartTooltipContent labelFormatter={(v) => (v === "2h+" ? "Over 2 hours" : `${v}–${Number(v) + BUCKET_MINUTES} min`)} />}
              />
              <Bar dataKey="n" fill="var(--color-n)" radius={2} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

function TimelineCard({ data }: { data: AdherenceResponse }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Doses</CardTitle>
        <CardDescription>
          Newest first, capped at 500. Reaction time is measured from when the alarm actually
          appeared on the phone.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scheduled</TableHead>
                <TableHead>Medication</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">After due</TableHead>
                <TableHead className="text-right">After alarm</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.timeline.map((dose) => (
                <DoseRow key={dose.id} dose={dose} />
              ))}
              {data.timeline.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    No doses in this range.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

function DoseRow({ dose }: { dose: AdherenceDose }) {
  const pressedAt = dose.confirmed_reported_at ?? dose.confirmed_at
  const afterDue = pressedAt ? minutesBetween(dose.scheduled_for, pressedAt) : null
  // §2's free second metric: `confirmed_reported_at - alarm_shown_at` is the
  // one that separates "did not hear it" from "heard it and did not act".
  const afterAlarm =
    pressedAt && dose.alarm_shown_at ? minutesBetween(dose.alarm_shown_at, pressedAt) : null

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap tabular-nums">{taipei(dose.scheduled_for)}</TableCell>
      <TableCell>
        {dose.med_name ?? "—"}
        {dose.selected_dosage ? (
          <span className="text-muted-foreground"> · {dose.selected_dosage}</span>
        ) : null}
      </TableCell>
      <TableCell>
        <StatusBadge dose={dose} />
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatMinutes(afterDue)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatMinutes(afterAlarm)}</TableCell>
    </TableRow>
  )
}

function StatusBadge({ dose }: { dose: AdherenceDose }) {
  // **`status` comes from the server**, resolved against its own clock in SQL.
  // Deciding it here would mean the badges disagreeing with the summary tiles
  // whenever the viewer's clock is off — and "missed" is the one label on this
  // page that reads as a judgement about a person (D-4), so it is the last one
  // that should depend on a browser being right about the time.
  const byCaregiver =
    dose.status === "confirmed" && dose.confirmed_by != null && dose.confirmed_by !== dose.user_id

  if (dose.status === "confirmed") {
    return (
      <div className="flex flex-wrap gap-1">
        <Badge variant="secondary">{byCaregiver ? "Confirmed by caregiver" : "Confirmed"}</Badge>
        {dose.snooze_count > 0 ? (
          <Badge variant="outline">Snoozed ×{dose.snooze_count}</Badge>
        ) : null}
      </div>
    )
  }
  // Not yet due is not missed, and conflating them is how a record turns into a
  // reprimand.
  if (dose.status === "scheduled") return <Badge variant="outline">Scheduled</Badge>
  return <Badge variant="destructive">Missed</Badge>
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * Taipei, always, and stated rather than inferred.
 *
 * §4: a dashboard opened from another timezone must not silently shift what it
 * shows. The aggregates are bucketed by Taipei day in SQL, so a timestamp
 * rendered in the viewer's local zone would disagree with the chart above it.
 */
function taipei(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

function shortDay(day: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" }).format(new Date(day))
}

function minutesBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000)
}

/**
 * **Negative is shown, not hidden.** §2 is explicit that a negative lag is
 * legitimate: the POST resolves to the nearest dose within ±12h, so confirming
 * at 07:00 for an 08:00 dose matches the 08:00 row. Showing "−60m" is honest;
 * clamping it to zero would invent punctuality in the one place a reader is
 * most likely to trust the number.
 */
function formatMinutes(minutes: number | null): string {
  if (minutes == null) return "—"
  if (Math.abs(minutes) < 60) return `${minutes}m`
  const hours = minutes / 60
  return `${hours >= 0 ? "" : "−"}${Math.abs(hours).toFixed(1)}h`
}
