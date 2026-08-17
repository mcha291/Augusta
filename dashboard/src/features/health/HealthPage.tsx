import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, BellOff, CircleCheck, CircleHelp } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useApi } from "@/lib/api"
import type { Alarm, AlarmState } from "@/lib/types"

/**
 * Operational health, read from CloudWatch.
 *
 * **This page exists because nothing alerted on anything.** The escalation
 * sweep decides whether a caregiver is told about a missed dose, and it could
 * have failed every minute for a fortnight without producing a single signal
 * anybody would see. Alarms now exist and publish to an SNS topic — but until
 * something subscribes to that topic, *this page is the only place a firing
 * alarm is visible*, which is why unsubscribed alarms are called out rather
 * than quietly rendered as healthy.
 *
 * Alarms are discovered by the `tish-` naming convention, so one added later
 * appears here without a dashboard deploy.
 */

const STATE: Record<AlarmState, { label: string; icon: typeof CircleCheck; tone: string }> = {
  ALARM: { label: "Firing", icon: AlertTriangle, tone: "text-destructive" },
  INSUFFICIENT_DATA: { label: "No data", icon: CircleHelp, tone: "text-muted-foreground" },
  OK: { label: "Healthy", icon: CircleCheck, tone: "text-muted-foreground" },
}

export function HealthPage() {
  const api = useApi()
  const query = useQuery({
    queryKey: ["alarms"],
    queryFn: api.getAlarms,
    // Cheap, and this is the page someone leaves open when they suspect
    // something is wrong.
    refetchInterval: 60000,
  })

  const alarms = query.data?.alarms ?? []
  const firing = query.data?.inAlarm ?? 0
  // **Zero subscribers means no alarm reaches anyone**, no matter how many are
  // configured or how correctly they are wired. That is the one thing on this
  // page most likely to be assumed rather than checked.
  const nobodySubscribed = query.data?.subscribers === 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Health</h1>
        <p className="text-sm text-muted-foreground">
          CloudWatch alarms across the stack. Refreshes every minute.
        </p>
      </div>

      {query.isPending ? <Skeleton className="h-40 w-full" /> : null}
      {query.error ? (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            Couldn't read alarms: {(query.error as Error).message}
          </CardContent>
        </Card>
      ) : null}

      {query.data ? (
        <>
          <Card className={firing > 0 ? "border-destructive" : undefined}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {firing > 0 ? (
                  <>
                    <AlertTriangle className="h-5 w-5 text-destructive" />
                    {firing} alarm{firing === 1 ? "" : "s"} firing
                  </>
                ) : (
                  <>
                    <CircleCheck className="h-5 w-5" />
                    Nothing firing
                  </>
                )}
              </CardTitle>
              <CardDescription>
                {alarms.length} alarm{alarms.length === 1 ? "" : "s"} configured.
                {nobodySubscribed ? (
                  <>
                    {" "}
                    <span className="font-medium text-destructive">
                      Nothing is subscribed to the alarm topic
                    </span>
                    , so none of them reach a person — this page is the only place they show.
                    Subscribe an address to <code>tish-alarms</code> to change that.
                  </>
                ) : null}
              </CardDescription>
            </CardHeader>
          </Card>

          <div className="space-y-3">
            {alarms.map((alarm) => (
              <AlarmRow key={alarm.name} alarm={alarm} />
            ))}
            {alarms.length === 0 ? (
              <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">
                  No alarms found. They're discovered by the <code>tish-</code> name prefix —
                  see <code>alarms.sh</code> at the repo root.
                </CardContent>
              </Card>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

function AlarmRow({ alarm }: { alarm: Alarm }) {
  const meta = STATE[alarm.state] ?? STATE.INSUFFICIENT_DATA
  const Icon = meta.icon
  const firing = alarm.state === "ALARM"

  return (
    <Card className={firing ? "border-destructive" : undefined}>
      <CardContent className="flex flex-wrap items-start gap-4 p-4">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${meta.tone}`} />

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{alarm.name}</span>
            <Badge variant={firing ? "destructive" : "outline"}>{meta.label}</Badge>
            {/* An alarm nothing is subscribed to only ever reaches whoever
                happens to open this page. Worth saying on the row, not just in
                the summary above. */}
            {!alarm.notifies ? (
              <Badge variant="outline" className="gap-1">
                <BellOff className="h-3 w-3" />
                no action wired
              </Badge>
            ) : null}
          </div>

          {alarm.description ? (
            <p className="text-sm text-muted-foreground">{alarm.description}</p>
          ) : null}

          {/* Only when firing: CloudWatch's OK reason is boilerplate, and
              repeating it on every healthy row buries the one that matters. */}
          {firing && alarm.reason ? (
            <p className="text-xs text-muted-foreground">{alarm.reason}</p>
          ) : null}
        </div>

        {alarm.since ? (
          <div className="text-right text-xs text-muted-foreground">
            <div>since</div>
            <div className="tabular-nums">
              {new Date(alarm.since).toLocaleString("en-GB", { timeZone: "Asia/Taipei" })}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
