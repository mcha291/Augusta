// Mock data source for local development and UI demos before the AWS side
// is provisioned. Enabled with VITE_MOCK=1. Locale fixtures are copies of the
// real app's locales/*.json.

import enFixture from "@/fixtures/en.json"
import zhHantFixture from "@/fixtures/zh-Hant.json"
import type {
  AdherenceDay,
  AdherencePatient,
  AdherencePatientListResponse,
  AdherenceResponse,
  Announcement,
  AnnouncementListResponse,
  AnnouncementType,
  AnnouncementTypeListResponse,
  AdherenceDose,
  DailyOpen,
  DailyOpensResponse,
  MetabasePowerResult,
  MetabaseStatus,
  LocaleContent,
  SaveAnnouncementRequest,
  SaveAnnouncementTypeRequest,
  SaveTranslationsRequest,
  SaveTranslationsResponse,
  TableDataResponse,
  TableListResponse,
  TranslationsResponse,
} from "@/lib/types"

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// In-memory state so edits + saves behave realistically within a session
const state = {
  en: { content: structuredClone(enFixture) as LocaleContent, sha: "mock-sha-en-1" },
  "zh-Hant": { content: structuredClone(zhHantFixture) as LocaleContent, sha: "mock-sha-zh-1" },
  saves: 0,
}

const MOCK_TABLES: Record<string, Record<string, unknown>[]> = {
  users: [
    { id: 1, username: "robinchang", email: "demo@example.com", role: "civilian", full_name: "Robin Chang", birth_date: "1990-01-01" },
    { id: 2, username: "casey", email: "casey@example.com", role: "civilian", full_name: "Casey Song", birth_date: "1955-06-12" },
  ],
  medication_library: [
    { id: 1, name: "Anti-Telepathy Serum", default_dosage: "200mg, 500mg" },
    { id: 2, name: "High-Grade Peanut Extract", default_dosage: "30mg" },
    { id: 3, name: "Starlight Stamina Mints", default_dosage: "5mg" },
  ],
  appointments: [
    { id: 1, user_id: 1, doctor_name: "Dr Yu Lennex", hospital: "123", appointment_date: "2026-07-02T16:37:00Z", status_id: 1 },
  ],
  genders: [
    { id: 1, name: "Female" },
    { id: 2, name: "Male" },
    { id: 3, name: "Non-binary" },
  ],
}

const EMPTY_TABLES = [
  "medication_reminders",
  "test_results",
  "test_config",
  "user_relationships",
  "conditions",
  "appointment_statuses",
  "announcements",
  "announcement_types",
]

// The three migration 010 seeds.
let mockTypes: AnnouncementType[] = [
  { id: 1, label_en: "System Updates", label_zh_hant: "系統更新", color: "#6366F1", sort_order: 1 },
  { id: 2, label_en: "News", label_zh_hant: "最新消息", color: "#22C55E", sort_order: 2 },
  { id: 3, label_en: "Announcements", label_zh_hant: "公告", color: "#F59E0B", sort_order: 3 },
]

let nextTypeId = 4

const typeById = (id: number) => mockTypes.find((t) => t.id === id)

// Deliberately includes one published article, one draft, and one that is
// published but only translated into English — the three states the editor has
// to render differently, and the third is the one easiest to get wrong.
let mockAnnouncements: Announcement[] = [
  {
    id: 3,
    type_id: 1,
    title_en: "Clinic closed Monday",
    title_zh_hant: "週一休診",
    content_en: "The clinic is closed all day on Monday for maintenance.",
    content_zh_hant: "診所週一全日休診以進行維護。",
    created_at: "2026-08-05T02:00:00.000Z",
    updated_at: "2026-08-05T02:00:00.000Z",
    published_at: "2026-08-05T02:00:00.000Z",
  },
  {
    id: 2,
    type_id: 2,
    title_en: "New blood test tracking",
    title_zh_hant: null,
    content_en: "You can now chart your results over time.",
    content_zh_hant: null,
    created_at: "2026-08-02T02:00:00.000Z",
    updated_at: "2026-08-02T02:00:00.000Z",
    published_at: "2026-08-02T02:00:00.000Z",
  },
  {
    id: 1,
    type_id: 3,
    title_en: "Support group — September",
    title_zh_hant: "九月支持團體",
    content_en: "",
    content_zh_hant: "",
    created_at: "2026-07-28T02:00:00.000Z",
    updated_at: "2026-07-28T02:00:00.000Z",
    published_at: null,
  },
]

let nextAnnouncementId = 4

function applyToMock(req: SaveAnnouncementRequest, existing?: Announcement): Announcement {
  const now = new Date().toISOString()
  return {
    id: existing?.id ?? nextAnnouncementId++,
    type_id: req.type_id,
    title_en: req.title_en || null,
    title_zh_hant: req.title_zh_hant || null,
    content_en: req.content_en || null,
    content_zh_hant: req.content_zh_hant || null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    // Mirrors the server's COALESCE: an edit to a live article keeps its
    // original date, unpublishing clears it.
    published_at: req.published ? (existing?.published_at ?? now) : null,
  }
}

export const mockApi = {
  async getTranslations(): Promise<TranslationsResponse> {
    await delay(400)
    return {
      en: structuredClone(state.en),
      "zh-Hant": structuredClone(state["zh-Hant"]),
      repo: "mock/repo",
      branch: "main",
    }
  },

  async saveTranslations(req: SaveTranslationsRequest): Promise<SaveTranslationsResponse> {
    await delay(700)
    if (req.sha !== state[req.locale].sha) {
      throw new Error("File changed since you loaded it — reload and reapply your edits.")
    }
    state.saves += 1
    const newSha = `mock-sha-${req.locale}-${state.saves + 1}`
    state[req.locale] = { content: structuredClone(req.content), sha: newSha }
    return { commitUrl: "https://github.com/mock/repo/commit/abc123", sha: newSha }
  },

  async listTables(): Promise<TableListResponse> {
    await delay(300)
    const tables = [
      ...Object.entries(MOCK_TABLES).map(([name, rows]) => ({ name, rowCount: rows.length })),
      ...EMPTY_TABLES.map((name) => ({ name, rowCount: 0 })),
    ]
    return { tables }
  },

  async getTable(name: string, params: { limit: number; offset: number; sort?: string; dir?: string }): Promise<TableDataResponse> {
    await delay(300)
    const rows = MOCK_TABLES[name] ?? []
    const columns = rows.length > 0 ? Object.keys(rows[0]) : ["id"]
    return {
      columns,
      rows: rows.slice(params.offset, params.offset + params.limit),
      total: rows.length,
      limit: params.limit,
      offset: params.offset,
      sort: params.sort ?? columns[0],
      dir: params.dir === "desc" ? "DESC" : "ASC",
    }
  },

  async listAnnouncements(): Promise<AnnouncementListResponse> {
    await delay(300)
    const ordered = [...mockAnnouncements].sort((a, b) =>
      (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at)
    )
    // Denormalised the way the real handler's JOIN does, so the page renders
    // the same shape in mock mode as against the API.
    const withLabels = ordered.map((a) => ({
      ...a,
      type_label_en: typeById(a.type_id)?.label_en ?? null,
      type_label_zh_hant: typeById(a.type_id)?.label_zh_hant ?? null,
      type_color: typeById(a.type_id)?.color ?? null,
    }))
    return { announcements: structuredClone(withLabels), types: structuredClone(mockTypes) }
  },

  async listAnnouncementTypes(): Promise<AnnouncementTypeListResponse> {
    await delay(250)
    const withCounts = [...mockTypes]
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
      .map((t) => ({ ...t, article_count: mockAnnouncements.filter((a) => a.type_id === t.id).length }))
    return { types: structuredClone(withCounts) }
  },

  async createAnnouncementType(req: SaveAnnouncementTypeRequest): Promise<{ type: AnnouncementType }> {
    await delay(350)
    // Mirrors the unique index on lower(label_en).
    if (mockTypes.some((t) => t.label_en.toLowerCase() === req.label_en.trim().toLowerCase())) {
      throw new Error("a type with that English label already exists")
    }
    const created: AnnouncementType = { id: nextTypeId++, ...req, label_en: req.label_en.trim() }
    mockTypes = [...mockTypes, created]
    return { type: structuredClone(created) }
  },

  async updateAnnouncementType(id: number, req: SaveAnnouncementTypeRequest): Promise<{ type: AnnouncementType }> {
    await delay(350)
    const existing = mockTypes.find((t) => t.id === id)
    if (!existing) throw new Error(`No article type with id ${id}`)
    if (mockTypes.some((t) => t.id !== id && t.label_en.toLowerCase() === req.label_en.trim().toLowerCase())) {
      throw new Error("a type with that English label already exists")
    }
    const updated: AnnouncementType = { ...existing, ...req, label_en: req.label_en.trim() }
    mockTypes = mockTypes.map((t) => (t.id === id ? updated : t))
    return { type: structuredClone(updated) }
  },

  async deleteAnnouncementType(id: number): Promise<{ deleted: number }> {
    await delay(300)
    // Mirrors ON DELETE RESTRICT, which is the whole reason the editor shows a
    // count next to each type.
    if (mockAnnouncements.some((a) => a.type_id === id)) {
      throw new Error("That type is still used by one or more articles. Move them to another type first.")
    }
    mockTypes = mockTypes.filter((t) => t.id !== id)
    return { deleted: id }
  },

  async createAnnouncement(req: SaveAnnouncementRequest): Promise<{ announcement: Announcement }> {
    await delay(500)
    const created = applyToMock(req)
    mockAnnouncements = [created, ...mockAnnouncements]
    return { announcement: structuredClone(created) }
  },

  async updateAnnouncement(id: number, req: SaveAnnouncementRequest): Promise<{ announcement: Announcement }> {
    await delay(500)
    const existing = mockAnnouncements.find((a) => a.id === id)
    if (!existing) throw new Error(`No article with id ${id}`)
    const updated = applyToMock(req, existing)
    mockAnnouncements = mockAnnouncements.map((a) => (a.id === id ? updated : a))
    return { announcement: structuredClone(updated) }
  },

  async deleteAnnouncement(id: number): Promise<{ deleted: number }> {
    await delay(400)
    mockAnnouncements = mockAnnouncements.filter((a) => a.id !== id)
    return { deleted: id }
  },

  // --- Adherence drill-down (TELEMETRY.md §4) -------------------------------
  //
  // Generated rather than hand-listed, because the view is only interesting
  // against a shape: a right-skewed latency distribution with a long tail is
  // what real confirmation timing looks like, and a flat fixture would make a
  // broken histogram look correct.

  async listAdherencePatients(): Promise<AdherencePatientListResponse> {
    await delay(300)
    return { patients: structuredClone(mockPatients) }
  },

  async getPatientAdherence(userId: number, range: { from: string; to: string }): Promise<AdherenceResponse> {
    await delay(450)
    return { ...generateAdherence(userId, range), from: range.from, to: range.to }
  },

  // Power control, with the transitions actually simulated — a mock that
  // flipped straight from stopped to running would hide the state the real UI
  // spends most of its visible time in.
  async getMetabaseStatus(): Promise<MetabaseStatus> {
    await delay(250)
    return { ...mockMetabase }
  },

  async setMetabasePower(action: "start" | "stop"): Promise<MetabasePowerResult> {
    await delay(400)
    const settled = action === "start" ? "running" : "stopped"
    if (mockMetabase.state === settled) return { state: settled, changed: false }

    mockMetabase.state = action === "start" ? "pending" : "stopping"
    mockMetabase.transitional = true
    setTimeout(() => {
      mockMetabase.state = settled
      mockMetabase.transitional = false
      mockMetabase.since = settled === "running" ? new Date().toISOString() : null
    }, 6000)
    return { state: mockMetabase.state, changed: true }
  },

  async getDailyOpens(range: { from: string; to: string }): Promise<DailyOpensResponse> {
    await delay(300)
    const opens: DailyOpen[] = []
    const start = new Date(range.from)
    const days = Math.min(Math.max(Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000), 1), 60)
    for (let i = 0; i < days; i++) {
      const day = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10)
      // Notification-driven opens dominate, which is the whole reason §3 tags
      // the source — a mock where they did not would hide the point.
      opens.push({ day, source: "notification", opens: 18 + (i % 5), users: 6, refreshed_at: new Date().toISOString() })
      opens.push({ day, source: "cold", opens: 4 + (i % 3), users: 4, refreshed_at: new Date().toISOString() })
      opens.push({ day, source: "foreground", opens: 7 + (i % 4), users: 5, refreshed_at: new Date().toISOString() })
    }
    return { opens }
  },
}

const mockMetabase: MetabaseStatus = { state: "stopped", since: null, transitional: false }

const mockPatients: AdherencePatient[] = [
  { id: 4, full_name: "陳秀英", username: "hsiuying", doses: 186, confirmed: 171, last_dose_at: new Date().toISOString() },
  { id: 7, full_name: "林建宏", username: "chienhung", doses: 124, confirmed: 96, last_dose_at: new Date(Date.now() - 86400000).toISOString() },
  { id: 11, full_name: null, username: "mei", doses: 62, confirmed: 60, last_dose_at: new Date(Date.now() - 3 * 86400000).toISOString() },
]

/**
 * A deterministic pseudo-random adherence history.
 *
 * Seeded on the patient id so switching between them shows genuinely different
 * shapes while a reload shows the same one — a fixture that reshuffled on every
 * render makes it impossible to tell a rendering bug from new data.
 */
function generateAdherence(userId: number, range: { from: string; to: string }) {
  let seed = userId * 7919
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }

  const days = Math.min(Math.max(Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000), 1), 90)
  const start = new Date(range.from)
  const adherence = 0.7 + (userId % 3) * 0.1

  const daily: AdherenceDay[] = []
  const timeline: AdherenceDose[] = []
  const buckets = new Map<number, number>()
  let confirmed = 0
  let missed = 0
  let snoozed = 0
  let byCaregiver = 0

  for (let d = 0; d < days; d++) {
    const dayStart = new Date(start.getTime() + d * 86400000)
    let dayConfirmed = 0
    let dayMissed = 0

    for (const hour of [8, 13, 20]) {
      const scheduled = new Date(dayStart)
      scheduled.setHours(hour, 0, 0, 0)
      const took = rand() < adherence
      const snoozeCount = rand() < 0.18 ? 1 + Math.floor(rand() * 2) : 0

      // Right-skewed: most confirmations are quick, a few are very late.
      const lagMinutes = took ? Math.round(Math.pow(rand(), 2.4) * 130) : 0
      const confirmedAt = took ? new Date(scheduled.getTime() + lagMinutes * 60000) : null
      const caregiver = took && rand() < 0.12

      // **The alarm usually appears on time, and sometimes does not.** That gap
      // is the entire reason §2 records `alarm_shown_at` separately: a patient
      // whose phone was in another room scores badly on dose-due-to-pressed and
      // instantly on alarm-to-pressed, and the two columns only look redundant
      // until you see a row where they disagree.
      const alarmDelay = rand() < 0.15 ? Math.round(rand() * Math.min(lagMinutes, 90)) : 0.5

      if (took) {
        confirmed++
        dayConfirmed++
        if (caregiver) byCaregiver++
        const bucket = Math.min(Math.floor(lagMinutes / 5) + 1, 25)
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
      } else {
        missed++
        dayMissed++
      }
      if (snoozeCount > 0) snoozed++

      timeline.push({
        // `d * 3 + hour` collided — day 4's 08:00 and day 0's 20:00 both landed
        // on 20, so React saw duplicate keys and dropped rows from the table.
        id: d * 100 + hour,
        user_id: userId,
        scheduled_for: scheduled.toISOString(),
        confirmed_at: confirmedAt?.toISOString() ?? null,
        confirmed_by: took ? (caregiver ? 99 : userId) : null,
        confirmed_reported_at: confirmedAt?.toISOString() ?? null,
        alarm_shown_at: took ? new Date(scheduled.getTime() + alarmDelay * 60000).toISOString() : null,
        snoozed_until: snoozeCount > 0 ? new Date(scheduled.getTime() + 600000).toISOString() : null,
        snooze_count: snoozeCount,
        med_name: hour === 8 ? "Metformin" : hour === 13 ? "Amlodipine" : "Atorvastatin",
        selected_dosage: hour === 8 ? "500mg" : "10mg",
        status: took ? ("confirmed" as const) : scheduled.getTime() < Date.now() ? ("missed" as const) : ("scheduled" as const),
      })
    }

    daily.push({
      day: dayStart.toISOString().slice(0, 10),
      scheduled: 3,
      confirmed: dayConfirmed,
      missed: dayMissed,
    })
  }

  return {
    summary: { total: days * 3, confirmed, missed, snoozed, by_caregiver: byCaregiver },
    daily,
    latency: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([bucket, n]) => ({ bucket, n })),
    timeline: timeline.reverse().slice(0, 500),
  }
}
