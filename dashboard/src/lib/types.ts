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

// --- Adherence drill-down (TELEMETRY.md §4) --------------------------------

export interface AdherencePatient {
  id: number
  full_name: string | null
  username: string | null
  doses: number
  confirmed: number
  last_dose_at: string | null
}

export interface AdherencePatientListResponse {
  patients: AdherencePatient[]
}

export interface AdherenceSummary {
  total: number
  confirmed: number
  missed: number
  snoozed: number
  /** Confirmed by somebody other than the patient (D-1). Segmented, not averaged in. */
  by_caregiver: number
}

export interface AdherenceDay {
  day: string
  scheduled: number
  confirmed: number
  missed: number
}

/**
 * One bar of the latency histogram, already bucketed by Postgres.
 *
 * `bucket` is a `width_bucket` index over 0–120 minutes in 24 bins, so bucket
 * *n* covers minutes `(n-1)*5` to `n*5`. Bucket 25 is the overflow — anything
 * past two hours — which `width_bucket` returns for out-of-range values.
 */
export interface AdherenceLatencyBucket {
  bucket: number
  n: number
}

export interface AdherenceDose {
  id: number
  user_id: number
  scheduled_for: string
  confirmed_at: string | null
  confirmed_by: number | null
  /** Device clock at the press, telemetry-only (§2). Null on older rows. */
  confirmed_reported_at: string | null
  /** Device clock when the alarm appeared, telemetry-only (§2). */
  alarm_shown_at: string | null
  snoozed_until: string | null
  snooze_count: number
  med_name: string | null
  selected_dosage: string | null
  /** Resolved in SQL against the server clock, never in the browser. */
  status: "confirmed" | "missed" | "scheduled"
}

export interface AdherenceResponse {
  from: string
  to: string
  summary: AdherenceSummary
  daily: AdherenceDay[]
  latency: AdherenceLatencyBucket[]
  timeline: AdherenceDose[]
}

export interface DailyOpen {
  day: string
  source: string
  opens: number
  users: number
  refreshed_at: string
}

export interface DailyOpensResponse {
  opens: DailyOpen[]
}

// --- Metabase power control (TELEMETRY.md §4) ------------------------------

export type MetabaseState =
  | "running"
  | "stopped"
  | "pending"
  | "stopping"
  | "shutting-down"
  | "terminated"
  | "unknown"

export interface MetabaseStatus {
  state: MetabaseState
  /** When it last started. Null while stopped. */
  since: string | null
  /** Mid-transition, so nothing can be asked of it yet. */
  transitional: boolean
}

export interface MetabasePowerResult {
  state: MetabaseState
  /** False when it was already in the requested state — not an error. */
  changed: boolean
}
