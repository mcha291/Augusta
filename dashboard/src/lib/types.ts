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

/**
 * An article type (migration 010) — a row staff edit, not a fixed vocabulary.
 * The labels live here rather than in the locale files because a category
 * invented this afternoon has no translation key and never will.
 */
export interface AnnouncementType {
  id: number
  label_en: string
  label_zh_hant: string | null
  color: string | null
  sort_order: number
  /** Only present on the dedicated types list — what makes a delete refusable up front. */
  article_count?: number
}

export interface AnnouncementTypeListResponse {
  types: AnnouncementType[]
}

export interface SaveAnnouncementTypeRequest {
  label_en: string
  label_zh_hant: string | null
  color: string | null
  sort_order: number
}

/**
 * An article as the editor sees it: both languages, unresolved, drafts included.
 * The app's own read of the same row is the opposite on both counts — resolved
 * to the reader's language, published only.
 */
export interface Announcement {
  id: number
  type_id: number
  type_label_en?: string | null
  type_label_zh_hant?: string | null
  type_color?: string | null
  title_en: string | null
  title_zh_hant: string | null
  content_en: string | null
  content_zh_hant: string | null
  created_at: string
  updated_at: string
  /** NULL means draft. The whole publish state. */
  published_at: string | null
}

export interface AnnouncementListResponse {
  announcements: Announcement[]
  types: AnnouncementType[]
}

export interface SaveAnnouncementRequest {
  type_id: number
  title_en: string
  title_zh_hant: string
  content_en: string
  content_zh_hant: string
  published: boolean
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
