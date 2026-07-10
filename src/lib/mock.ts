// Mock data source for local development and UI demos before the AWS side
// is provisioned. Enabled with VITE_MOCK=1. Locale fixtures are copies of the
// real app's locales/*.json.

import enFixture from "@/fixtures/en.json"
import zhHantFixture from "@/fixtures/zh-Hant.json"
import type {
  LocaleContent,
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
]

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
}
