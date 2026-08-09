import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Loader2, Plus, Trash2, X } from "lucide-react"

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
import { ApiError, useApi } from "@/lib/api"
import type { AnnouncementType, SaveAnnouncementTypeRequest } from "@/lib/types"

type Row = {
  label_en: string
  label_zh_hant: string
  color: string
  sort_order: number
}

const EMPTY_ROW: Row = { label_en: "", label_zh_hant: "", color: "#6366F1", sort_order: 0 }

const rowFrom = (t: AnnouncementType): Row => ({
  label_en: t.label_en,
  label_zh_hant: t.label_zh_hant ?? "",
  color: t.color ?? "#6366F1",
  sort_order: t.sort_order,
})

const toRequest = (r: Row): SaveAnnouncementTypeRequest => ({
  label_en: r.label_en.trim(),
  label_zh_hant: r.label_zh_hant.trim() || null,
  color: r.color || null,
  sort_order: Number.isInteger(r.sort_order) ? r.sort_order : 0,
})

/**
 * Editor for the article types (migration 010).
 *
 * **Only the English label is required**, matching the server. It is the key,
 * unique case-insensitively, and the app falls back to it when a translation is
 * missing — so a type with no 中文 label still renders. Demanding both would
 * mean staff cannot file an article until a Chinese reader is free, which is the
 * opposite of why these became rows.
 */
export function TypeManagerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useApi()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ["announcement-types"],
    queryFn: api.listAnnouncementTypes,
    enabled: open,
  })

  const [editingId, setEditingId] = useState<number | null>(null)
  const [row, setRow] = useState<Row | null>(null)
  const [problems, setProblems] = useState<string[]>([])

  const types = query.data?.types ?? []

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["announcement-types"] })
    // The article list embeds the types for its picker and its badges, so it is
    // stale the moment one changes.
    queryClient.invalidateQueries({ queryKey: ["announcements"] })
  }

  const fail = (e: unknown) =>
    setProblems(e instanceof ApiError && e.problems ? e.problems : [String((e as Error).message)])

  const save = useMutation({
    mutationFn: ({ id, req }: { id: number | null; req: SaveAnnouncementTypeRequest }) =>
      id === null ? api.createAnnouncementType(req) : api.updateAnnouncementType(id, req),
    onSuccess: () => {
      invalidate()
      setEditingId(null)
      setRow(null)
      setProblems([])
    },
    onError: fail,
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteAnnouncementType(id),
    onSuccess: () => {
      invalidate()
      setProblems([])
    },
    onError: fail,
  })

  const startNew = () => {
    setEditingId(null)
    setRow({ ...EMPTY_ROW, sort_order: (types.at(-1)?.sort_order ?? 0) + 1 })
    setProblems([])
  }

  const startEdit = (t: AnnouncementType) => {
    setEditingId(t.id)
    setRow(rowFrom(t))
    setProblems([])
  }

  const cancel = () => {
    setEditingId(null)
    setRow(null)
    setProblems([])
  }

  const canSave = row !== null && row.label_en.trim() !== ""

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) cancel(); onOpenChange(next) }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Article types</DialogTitle>
          <DialogDescription>
            These are the tags patients see on a news card. Only the English label is required — the
            app falls back to it wherever a 中文 label is missing.
          </DialogDescription>
        </DialogHeader>

        {query.isLoading && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        )}

        <div className="space-y-2">
          {types.map((t) =>
            editingId === t.id && row ? (
              <TypeForm key={t.id} row={row} setRow={setRow} onCancel={cancel}
                onSave={() => save.mutate({ id: t.id, req: toRequest(row) })}
                saving={save.isPending} canSave={canSave} />
            ) : (
              <div key={t.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => startEdit(t)}>
                  <span
                    className="size-4 shrink-0 rounded-full border"
                    style={{ backgroundColor: t.color ?? "transparent" }}
                    aria-hidden
                  />
                  <span className="truncate font-medium">{t.label_en}</span>
                  {t.label_zh_hant ? (
                    <span className="truncate text-sm text-muted-foreground">{t.label_zh_hant}</span>
                  ) : (
                    <Badge variant="outline" className="text-amber-600 dark:text-amber-500">no 中文</Badge>
                  )}
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t.article_count ?? 0} article{(t.article_count ?? 0) === 1 ? "" : "s"}
                  </span>
                  {/* Disabled rather than allowed-then-refused: the server's
                      RESTRICT is the real guard, and the count is here so the
                      user never has to discover it by being told no. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={remove.isPending || (t.article_count ?? 0) > 0}
                    title={(t.article_count ?? 0) > 0 ? "Articles still use this type" : "Delete"}
                    onClick={() => remove.mutate(t.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            )
          )}

          {editingId === null && row && (
            <TypeForm row={row} setRow={setRow} onCancel={cancel}
              onSave={() => save.mutate({ id: null, req: toRequest(row) })}
              saving={save.isPending} canSave={canSave} />
          )}
        </div>

        {problems.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            <ul className="list-inside list-disc space-y-1">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
        )}

        <DialogFooter className="justify-between gap-2 sm:justify-between">
          <Button variant="outline" onClick={startNew} disabled={row !== null} className="gap-2">
            <Plus className="size-4" />
            Add type
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TypeForm({
  row, setRow, onSave, onCancel, saving, canSave,
}: {
  row: Row
  setRow: (r: Row) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  canSave: boolean
}) {
  return (
    <div className="space-y-3 rounded-lg border border-primary/40 bg-muted/30 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="type-en" className="text-xs text-muted-foreground">English label</Label>
          <Input id="type-en" value={row.label_en} onChange={(e) => setRow({ ...row, label_en: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="type-zh" className="text-xs text-muted-foreground">中文 label</Label>
          <Input id="type-zh" value={row.label_zh_hant} onChange={(e) => setRow({ ...row, label_zh_hant: e.target.value })} />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="type-color" className="text-xs text-muted-foreground">Colour</Label>
          <input
            id="type-color"
            type="color"
            className="block h-9 w-16 cursor-pointer rounded border bg-transparent"
            value={row.color}
            onChange={(e) => setRow({ ...row, color: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="type-order" className="text-xs text-muted-foreground">Order</Label>
          <Input
            id="type-order"
            type="number"
            className="w-20"
            value={row.sort_order}
            onChange={(e) => setRow({ ...row, sort_order: parseInt(e.target.value, 10) || 0 })}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} className="gap-1">
            <X className="size-4" />
            Cancel
          </Button>
          <Button size="sm" onClick={onSave} disabled={saving || !canSave} className="gap-1">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
