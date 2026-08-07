import { useMemo, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table"
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Lock } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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

const PAGE_SIZE = 50

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

export function DatabasePage() {
  const api = useApi()

  const [table, setTable] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<string | undefined>(undefined)
  const [dir, setDir] = useState<"asc" | "desc">("asc")

  const tablesQuery = useQuery({ queryKey: ["tables"], queryFn: api.listTables })
  const selected = table ?? tablesQuery.data?.tables[0]?.name ?? null

  const dataQuery = useQuery({
    queryKey: ["table", selected, page, sort, dir],
    queryFn: () => api.getTable(selected!, { limit: PAGE_SIZE, offset: page * PAGE_SIZE, sort, dir }),
    enabled: selected !== null,
    placeholderData: keepPreviousData,
  })

  const data = dataQuery.data

  const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () =>
      (data?.columns ?? []).map((col) => ({
        id: col,
        accessorFn: (row) => row[col],
        header: col,
        cell: (info) => formatCell(info.getValue()),
      })),
    [data?.columns]
  )

  const tableInstance = useReactTable({
    data: data?.rows ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  function toggleSort(col: string) {
    if (sort === col) {
      setDir(dir === "asc" ? "desc" : "asc")
    } else {
      setSort(col)
      setDir("asc")
    }
    setPage(0)
  }

  const totalPages = data ? Math.max(Math.ceil(data.total / PAGE_SIZE), 1) : 1

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            Database <Badge variant="outline" className="gap-1"><Lock className="size-3" /> read-only</Badge>
          </h1>
          <p className="text-sm text-muted-foreground">Live view of the production tables (allowlisted).</p>
        </div>

        <Select
          value={selected ?? undefined}
          onValueChange={(v) => {
            setTable(v)
            setPage(0)
            setSort(undefined)
          }}
        >
          <SelectTrigger className="w-64">
            <SelectValue placeholder="Select a table" />
          </SelectTrigger>
          <SelectContent>
            {(tablesQuery.data?.tables ?? []).map((t) => (
              <SelectItem key={t.name} value={t.name}>
                {t.name} ({t.rowCount})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {(tablesQuery.isLoading || (dataQuery.isLoading && selected)) && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {(tablesQuery.isError || dataQuery.isError) && (
        <div className="text-sm text-destructive">
          Failed to load: {((tablesQuery.error ?? dataQuery.error) as Error)?.message ?? "unknown error"}
        </div>
      )}

      {data && (
        <>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                {tableInstance.getHeaderGroups().map((hg) => (
                  <TableRow key={hg.id}>
                    {hg.headers.map((header) => (
                      <TableHead key={header.id}>
                        <button
                          className="inline-flex items-center gap-1 font-medium hover:text-foreground"
                          onClick={() => toggleSort(header.column.id)}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {data.sort === header.column.id &&
                            (data.dir === "DESC" ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                        </button>
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {tableInstance.getRowModel().rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={Math.max(columns.length, 1)} className="h-24 text-center text-muted-foreground">
                      No rows.
                    </TableCell>
                  </TableRow>
                ) : (
                  tableInstance.getRowModel().rows.map((row) => (
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="max-w-96 truncate font-mono text-xs">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {data.total} row{data.total === 1 ? "" : "s"} · page {page + 1} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                <ChevronLeft className="size-4" /> Prev
              </Button>
              <Button variant="outline" size="sm" disabled={page + 1 >= totalPages} onClick={() => setPage(page + 1)}>
                Next <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
