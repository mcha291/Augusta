export type LocaleId = "en" | "zh-Hant"

/** Nested translation JSON: namespace -> key -> string (one level of nesting, as authored) */
export type LocaleContent = Record<string, Record<string, string>>

export interface LocaleFile {
  content: LocaleContent
  sha: string
}

export interface TranslationsResponse {
  en: LocaleFile
  "zh-Hant": LocaleFile
  repo?: string
  branch?: string
}

export interface SaveTranslationsRequest {
  locale: LocaleId
  content: LocaleContent
  sha: string
  message: string
}

export interface SaveTranslationsResponse {
  commitUrl?: string
  sha: string
}

export interface TableInfo {
  name: string
  rowCount: number
}

export interface TableListResponse {
  tables: TableInfo[]
}

export interface TableDataResponse {
  columns: string[]
  rows: Record<string, unknown>[]
  total: number
  limit: number
  offset: number
  sort: string
  dir: "ASC" | "DESC"
}
