import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, FileText, Loader2, Plus, Send, Settings2, Trash2, Undo2 } from "lucide-react"

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
import { Textarea } from "@/components/ui/textarea"
import { ApiError, useApi } from "@/lib/api"
import type { Announcement, AnnouncementType, SaveAnnouncementRequest } from "@/lib/types"
import { cn } from "@/lib/utils"

import { TypeManagerDialog } from "./TypeManagerDialog"

/**
 * Editor state. Kept as strings rather than `string | null` so a cleared field
 * round-trips as "" instead of flipping the input to uncontrolled; the server
 * stores "" as NULL.
 */
type Draft = {
  type_id: number
  title_en: string
  title_zh_hant: string
  content_en: string
  content_zh_hant: string
}

const draftFrom = (a: Announcement): Draft => ({
  type_id: a.type_id,
  title_en: a.title_en ?? "",
  title_zh_hant: a.title_zh_hant ?? "",
  content_en: a.content_en ?? "",
  content_zh_hant: a.content_zh_hant ?? "",
})

const filled = (v: string) => v.trim() !== ""

/**
 * Mirrors `validateAnnouncement` on the server. This copy is UX — it disables
 * the Publish button and says why before a round trip — and the server's is the
 * gate. Both exist for the same reason the translations editor has two: the
 * client cannot be trusted, and the server cannot explain itself in time.
 */
function publishBlockers(d: Draft): string[] {
  const problems: string[] = []
  for (const [locale, t, c] of [
    ["English", d.title_en, d.content_en],
    ["中文", d.title_zh_hant, d.content_zh_hant],
  ] as const) {
    if (filled(c) && !filled(t)) problems.push(`${locale}: a body with no headline`)
  }
  const complete =
    (filled(d.title_en) && filled(d.content_en)) ||
    (filled(d.title_zh_hant) && filled(d.content_zh_hant))
  if (!complete) problems.push("needs a headline and body in at least one language")
  return problems
}

/** Same rule, minus the publish-completeness half: a draft may be half-written. */
const saveBlockers = (d: Draft) => publishBlockers(d).filter((p) => !p.startsWith("needs a headline"))

function formatDate(iso: string | null) {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

export function NewsPage() {
  const api = useApi()
  const queryClient = useQueryClient()

  const query = useQuery({ queryKey: ["announcements"], queryFn: api.listAnnouncements })

  const [editing, setEditing] = useState<Announcement | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Announcement | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [managingTypes, setManagingTypes] = useState(false)

  const types: AnnouncementType[] = useMemo(() => query.data?.types ?? [], [query.data])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d))

  const closeEditor = () => {
    setEditing(null)
    setDraft(null)
    setProblems([])
  }

  const save = useMutation({
    mutationFn: ({ id, req }: { id: number | null; req: SaveAnnouncementRequest }) =>
      id === null ? api.createAnnouncement(req) : api.updateAnnouncement(id, req),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["announcements"] })
      closeEditor()
    },
    onError: (e) => setProblems(e instanceof ApiError && e.problems ? e.problems : [String((e as Error).message)]),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteAnnouncement(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["announcements"] })
      setConfirmDelete(null)
    },
  })

  // Publishing straight from the list, without opening the editor first. Uses
  // the row's own fields, so it can only ever republish what is already stored.
  const setPublished = useMutation({
    mutationFn: ({ a, published }: { a: Announcement; published: boolean }) =>
      api.updateAnnouncement(a.id, { ...draftFrom(a), published }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["announcements"] }),
    onError: (e) => setProblems(e instanceof ApiError && e.problems ? e.problems : [String((e as Error).message)]),
  })

  // Memoised because `?? []` is a fresh array every render, which would make
  // the counts below recompute on each one.
  const articles = useMemo(() => query.data?.announcements ?? [], [query.data])
  const blockers = draft ? publishBlockers(draft) : []
  const cannotSave = draft ? saveBlockers(draft) : []

  const counts = useMemo(
    () => ({
      published: articles.filter((a) => a.published_at).length,
      drafts: articles.filter((a) => !a.published_at).length,
    }),
    [articles]
  )

  const openEditor = (a: Announcement | null) => {
    setEditing(a)
    // A new article defaults to the first configured type rather than a
    // hardcoded one — there is no guaranteed type any more, so the picker's
    // own first entry is the only defensible default.
    setDraft(a ? draftFrom(a) : {
      type_id: types[0]?.id ?? 0,
      title_en: "", title_zh_hant: "", content_en: "", content_zh_hant: "",
    })
    setProblems([])
  }

  const submit = (published: boolean) => {
    if (!draft) return
    save.mutate({ id: editing?.id ?? null, req: { ...draft, published } })
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">News</h1>
          <p className="text-sm text-muted-foreground">
            Published articles appear on every patient's home screen. {counts.published} published,{" "}
            {counts.drafts} draft{counts.drafts === 1 ? "" : "s"}.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={() => setManagingTypes(true)} className="gap-2">
            <Settings2 className="size-4" />
            Manage types
          </Button>
          <Button onClick={() => openEditor(null)} className="gap-2" disabled={types.length === 0}>
            <Plus className="size-4" />
            New article
          </Button>
        </div>
      </header>

      {query.isSuccess && types.length === 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          There are no article types configured, so an article has nothing to be filed under. Add one
          under <span className="font-medium">Manage types</span> first.
        </div>
      )}

      {query.isError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          Couldn't load articles: {(query.error as Error).message}
        </div>
      )}

      {query.isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {query.isSuccess && articles.length === 0 && (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          No articles yet. The home screen's news section stays empty until one is published.
        </div>
      )}

      <div className="space-y-3">
        {articles.map((a) => {
          const isDraft = !a.published_at
          const missingZh = !a.title_zh_hant?.trim()
          const missingEn = !a.title_en?.trim()
          return (
            <div
              key={a.id}
              className={cn(
                "flex items-start justify-between gap-4 rounded-lg border p-4 transition-colors",
                isDraft && "border-dashed bg-muted/30"
              )}
            >
              <button className="min-w-0 flex-1 text-left" onClick={() => openEditor(a)}>
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  {/* Colour comes from the row, so a type staff add looks like
                      one they were given rather than falling back to grey. */}
                  <Badge
                    variant="secondary"
                    style={a.type_color ? { backgroundColor: `${a.type_color}22`, color: a.type_color } : undefined}
                  >
                    {a.type_label_en ?? a.type_label_zh_hant ?? "—"}
                  </Badge>
                  {isDraft ? (
                    <Badge variant="outline" className="gap-1">
                      <FileText className="size-3" />
                      draft
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      published {formatDate(a.published_at)}
                    </span>
                  )}
                  {/* A published article missing a language is the case worth
                      surfacing: it still renders, via the server's fallback,
                      but in the wrong language for half the patients. */}
                  {!isDraft && (missingZh || missingEn) && (
                    <Badge variant="outline" className="gap-1 text-amber-600 dark:text-amber-500">
                      <AlertTriangle className="size-3" />
                      {missingZh ? "no 中文" : "no English"}
                    </Badge>
                  )}
                </div>
                <div className="truncate font-medium">
                  {a.title_en || a.title_zh_hant || <span className="text-muted-foreground">Untitled</span>}
                </div>
                {a.title_en && a.title_zh_hant && (
                  <div className="truncate text-sm text-muted-foreground">{a.title_zh_hant}</div>
                )}
              </button>

              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant={isDraft ? "default" : "outline"}
                  size="sm"
                  className="gap-2"
                  disabled={setPublished.isPending}
                  onClick={() => setPublished.mutate({ a, published: isDraft })}
                >
                  {isDraft ? <Send className="size-3.5" /> : <Undo2 className="size-3.5" />}
                  {isDraft ? "Publish" : "Unpublish"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(a)}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Editor                                                            */}
      {/* ---------------------------------------------------------------- */}
      <Dialog open={draft !== null} onOpenChange={(open) => !open && closeEditor()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit article" : "New article"}</DialogTitle>
            <DialogDescription>
              Both languages sit side by side on purpose — a patient reading 中文 sees the English only
              because the Chinese is missing.
            </DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-5">
              <div className="space-y-2">
                <Label>Type</Label>
                <div className="flex flex-wrap gap-2">
                  {types.map((t) => (
                    <Button
                      key={t.id}
                      type="button"
                      size="sm"
                      variant={draft.type_id === t.id ? "default" : "outline"}
                      onClick={() => set("type_id", t.id)}
                    >
                      {t.label_en}
                      {t.label_zh_hant && (
                        <span className="ml-1.5 opacity-60">{t.label_zh_hant}</span>
                      )}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                {(
                  [
                    ["English", "title_en", "content_en"],
                    ["中文 (繁體)", "title_zh_hant", "content_zh_hant"],
                  ] as const
                ).map(([label, titleKey, contentKey]) => (
                  <div key={titleKey} className="space-y-3">
                    <div className="text-sm font-medium">{label}</div>
                    <div className="space-y-1">
                      <Label htmlFor={titleKey} className="text-xs text-muted-foreground">
                        Headline
                      </Label>
                      <Input
                        id={titleKey}
                        value={draft[titleKey]}
                        onChange={(e) => set(titleKey, e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={contentKey} className="text-xs text-muted-foreground">
                        Body
                      </Label>
                      <Textarea
                        id={contentKey}
                        rows={8}
                        value={draft[contentKey]}
                        onChange={(e) => set(contentKey, e.target.value)}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {(problems.length > 0 || blockers.length > 0) && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                  <ul className="list-inside list-disc space-y-1">
                    {[...problems, ...blockers].map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={closeEditor}>
              Cancel
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              disabled={save.isPending || cannotSave.length > 0}
              onClick={() => submit(false)}
            >
              {save.isPending && <Loader2 className="size-4 animate-spin" />}
              Save as draft
            </Button>
            <Button
              className="gap-2"
              disabled={save.isPending || blockers.length > 0}
              onClick={() => submit(true)}
            >
              {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {editing?.published_at ? "Save and keep live" : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TypeManagerDialog open={managingTypes} onOpenChange={setManagingTypes} />

      {/* ---------------------------------------------------------------- */}
      {/* Delete confirmation                                               */}
      {/* ---------------------------------------------------------------- */}
      <Dialog open={confirmDelete !== null} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this article?</DialogTitle>
            <DialogDescription>
              {confirmDelete?.published_at
                ? "It is live on patients' home screens now, and this cannot be undone. Unpublishing keeps it as a draft instead."
                : "This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="gap-2"
              disabled={remove.isPending}
              onClick={() => confirmDelete && remove.mutate(confirmDelete.id)}
            >
              {remove.isPending && <Loader2 className="size-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
