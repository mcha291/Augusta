import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Check, ExternalLink, Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { useApi, ApiError } from "@/lib/api"
import type { LocaleContent, LocaleId } from "@/lib/types"
import { cn } from "@/lib/utils"
import { validateLocalePair } from "./validation"

const LOCALES: LocaleId[] = ["en", "zh-Hant"]

type Drafts = Record<LocaleId, LocaleContent>

function cloneContent(c: LocaleContent): LocaleContent {
  return structuredClone(c)
}

export function TranslationsPage() {
  const api = useApi()
  const queryClient = useQueryClient()

  const query = useQuery({ queryKey: ["translations"], queryFn: api.getTranslations })

  // Drafts are keyed off the fetched sha so a background refetch after save
  // re-seeds them; edits live only here until Save commits them.
  const [drafts, setDrafts] = useState<Drafts | null>(null)
  const [draftsFor, setDraftsFor] = useState<string>("")
  const [selectedNs, setSelectedNs] = useState<string | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [note, setNote] = useState("")
  const [problems, setProblems] = useState<string[]>([])
  const [commitUrls, setCommitUrls] = useState<string[]>([])

  const data = query.data
  const shaKey = data ? `${data.en.sha}:${data["zh-Hant"].sha}` : ""

  if (data && draftsFor !== shaKey) {
    setDrafts({ en: cloneContent(data.en.content), "zh-Hant": cloneContent(data["zh-Hant"].content) })
    setDraftsFor(shaKey)
  }

  const namespaces = useMemo(() => (data ? Object.keys(data.en.content) : []), [data])
  const ns = selectedNs && namespaces.includes(selectedNs) ? selectedNs : namespaces[0]

  const dirtyByLocale = useMemo(() => {
    const dirty: Record<LocaleId, boolean> = { en: false, "zh-Hant": false }
    if (!data || !drafts) return dirty
    for (const locale of LOCALES) {
      dirty[locale] = JSON.stringify(drafts[locale]) !== JSON.stringify(data[locale].content)
    }
    return dirty
  }, [data, drafts])

  const dirtyCount = useMemo(() => {
    if (!data || !drafts) return 0
    let n = 0
    for (const locale of LOCALES) {
      for (const nsKey of Object.keys(drafts[locale])) {
        for (const key of Object.keys(drafts[locale][nsKey])) {
          if (drafts[locale][nsKey][key] !== data[locale].content[nsKey]?.[key]) n++
        }
      }
    }
    return n
  }, [data, drafts])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!data || !drafts) return []
      const urls: string[] = []
      for (const locale of LOCALES) {
        if (!dirtyByLocale[locale]) continue
        const res = await api.saveTranslations({
          locale,
          content: drafts[locale],
          sha: data[locale].sha,
          message: note.trim() || "edit via dashboard",
        })
        if (res.commitUrl) urls.push(res.commitUrl)
      }
      return urls
    },
    onSuccess: (urls) => {
      setCommitUrls(urls)
      setSaveOpen(false)
      setNote("")
      void queryClient.invalidateQueries({ queryKey: ["translations"] })
    },
  })

  function setValue(locale: LocaleId, nsKey: string, key: string, value: string) {
    if (!drafts) return
    setCommitUrls([])
    setDrafts({
      ...drafts,
      [locale]: { ...drafts[locale], [nsKey]: { ...drafts[locale][nsKey], [key]: value } },
    })
  }

  function openSaveDialog() {
    if (!drafts) return
    const found = validateLocalePair(drafts.en, drafts["zh-Hant"])
    setProblems(found)
    if (found.length === 0) setSaveOpen(true)
  }

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (query.isError || !data || !drafts) {
    return (
      <div className="text-sm text-destructive">
        Failed to load translations: {query.error instanceof Error ? query.error.message : "unknown error"}
      </div>
    )
  }

  const keys = Array.from(
    new Set([...Object.keys(drafts.en[ns] ?? {}), ...Object.keys(drafts["zh-Hant"][ns] ?? {})])
  )

  const saveError = saveMutation.error
    ? saveMutation.error instanceof ApiError && saveMutation.error.problems
      ? saveMutation.error.problems.join("; ")
      : (saveMutation.error as Error).message
    : null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Translations</h1>
          <p className="text-sm text-muted-foreground">
            Edits commit to <code>{data.repo ?? "the app repo"}</code> ({data.branch ?? "main"}); CI validates and
            ships them to the app automatically (~minutes). Values only — new keys are added in code.
          </p>
        </div>
        <Button onClick={openSaveDialog} disabled={dirtyCount === 0 || saveMutation.isPending}>
          {saveMutation.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
          Save changes{dirtyCount > 0 ? ` (${dirtyCount})` : ""}
        </Button>
      </div>

      {problems.length > 0 && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
          <div className="mb-1 flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="size-4" /> Fix these before saving:
          </div>
          <ul className="ml-5 list-disc text-destructive">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {saveError && <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{saveError}</div>}

      {commitUrls.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-green-600/40 bg-green-600/10 p-3 text-sm">
          <Check className="size-4 text-green-600" />
          Saved. CI is validating and shipping via EAS Update.
          {commitUrls.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
              view commit <ExternalLink className="size-3" />
            </a>
          ))}
        </div>
      )}

      <div className="flex gap-6">
        <nav className="w-48 shrink-0 space-y-1">
          {namespaces.map((n) => {
            const nsDirty =
              JSON.stringify(drafts.en[n]) !== JSON.stringify(data.en.content[n]) ||
              JSON.stringify(drafts["zh-Hant"][n]) !== JSON.stringify(data["zh-Hant"].content[n])
            return (
              <button
                key={n}
                onClick={() => setSelectedNs(n)}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-sm",
                  n === ns ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
                )}
              >
                {n}
                {nsDirty && <Badge variant="secondary">edited</Badge>}
              </button>
            )
          })}
        </nav>

        <div className="min-w-0 flex-1 space-y-3">
          {keys.map((key) => {
            const enVal = drafts.en[ns]?.[key] ?? ""
            const zhVal = drafts["zh-Hant"][ns]?.[key] ?? ""
            const enDirty = enVal !== (data.en.content[ns]?.[key] ?? "")
            const zhDirty = zhVal !== (data["zh-Hant"].content[ns]?.[key] ?? "")
            return (
              <div key={key} className="grid grid-cols-[minmax(10rem,14rem)_1fr_1fr] items-center gap-3">
                <code className="truncate text-xs text-muted-foreground" title={`${ns}.${key}`}>
                  {key}
                </code>
                <Input
                  value={enVal}
                  onChange={(e) => setValue("en", ns, key, e.target.value)}
                  className={cn(enDirty && "border-amber-500")}
                  aria-label={`${ns}.${key} (en)`}
                />
                <Input
                  value={zhVal}
                  onChange={(e) => setValue("zh-Hant", ns, key, e.target.value)}
                  className={cn(zhDirty && "border-amber-500")}
                  aria-label={`${ns}.${key} (zh-Hant)`}
                />
              </div>
            )
          })}
        </div>
      </div>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save {dirtyCount} change{dirtyCount === 1 ? "" : "s"}</DialogTitle>
            <DialogDescription>
              This commits to {data.branch ?? "main"}; CI re-validates and ships the update to the app automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="note">Change note (appears in the commit message)</Label>
            <Input
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. reword medication reminder texts"
              maxLength={200}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
              Commit &amp; ship
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
