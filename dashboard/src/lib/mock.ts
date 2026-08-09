// Mock data source for local development and UI demos before the AWS side
// is provisioned. Enabled with VITE_MOCK=1. Locale fixtures are copies of the
// real app's locales/*.json.

import enFixture from "@/fixtures/en.json"
import zhHantFixture from "@/fixtures/zh-Hant.json"
import type {
  Announcement,
  AnnouncementListResponse,
  AnnouncementType,
  AnnouncementTypeListResponse,
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
}
