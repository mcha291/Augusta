import { useAuth } from "react-oidc-context"

import { config, MOCK } from "@/lib/config"
import { mockApi } from "@/lib/mock"
import type {
  Announcement,
  AnnouncementListResponse,
  AnnouncementType,
  AnnouncementTypeListResponse,
  SaveAnnouncementRequest,
  SaveAnnouncementTypeRequest,
  SaveTranslationsRequest,
  SaveTranslationsResponse,
  TableDataResponse,
  TableListResponse,
  TranslationsResponse,
} from "@/lib/types"

export class ApiError extends Error {
  status: number
  problems?: string[]
  constructor(status: number, message: string, problems?: string[]) {
    super(message)
    this.status = status
    this.problems = problems
  }
}

async function request<T>(token: string | undefined, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, body.problems)
  }
  return body as T
}

type Api = {
  getTranslations: () => Promise<TranslationsResponse>
  saveTranslations: (req: SaveTranslationsRequest) => Promise<SaveTranslationsResponse>
  listTables: () => Promise<TableListResponse>
  getTable: (
    name: string,
    params: { limit: number; offset: number; sort?: string; dir?: string }
  ) => Promise<TableDataResponse>
  listAnnouncements: () => Promise<AnnouncementListResponse>
  createAnnouncement: (req: SaveAnnouncementRequest) => Promise<{ announcement: Announcement }>
  updateAnnouncement: (id: number, req: SaveAnnouncementRequest) => Promise<{ announcement: Announcement }>
  deleteAnnouncement: (id: number) => Promise<{ deleted: number }>
  listAnnouncementTypes: () => Promise<AnnouncementTypeListResponse>
  createAnnouncementType: (req: SaveAnnouncementTypeRequest) => Promise<{ type: AnnouncementType }>
  updateAnnouncementType: (id: number, req: SaveAnnouncementTypeRequest) => Promise<{ type: AnnouncementType }>
  deleteAnnouncementType: (id: number) => Promise<{ deleted: number }>
}

function useRealApi(): Api {
  const auth = useAuth()
  // The HTTP API's JWT authorizer validates the ID token (its `aud` claim is
  // the app client id, which is what the authorizer's audience check expects).
  const token = auth.user?.id_token

  return {
    getTranslations: () => request<TranslationsResponse>(token, "/translations"),
    saveTranslations: (req) =>
      request<SaveTranslationsResponse>(token, "/translations", { method: "PUT", body: JSON.stringify(req) }),
    listTables: () => request<TableListResponse>(token, "/tables"),
    getTable: (name, params) => {
      const q = new URLSearchParams({
        limit: String(params.limit),
        offset: String(params.offset),
        ...(params.sort ? { sort: params.sort } : {}),
        ...(params.dir ? { dir: params.dir } : {}),
      })
      return request<TableDataResponse>(token, `/tables/${name}?${q}`)
    },
    listAnnouncements: () => request<AnnouncementListResponse>(token, "/announcements"),
    createAnnouncement: (req) =>
      request<{ announcement: Announcement }>(token, "/announcements", {
        method: "POST",
        body: JSON.stringify(req),
      }),
    updateAnnouncement: (id, req) =>
      request<{ announcement: Announcement }>(token, `/announcements/${id}`, {
        method: "PUT",
        body: JSON.stringify(req),
      }),
    deleteAnnouncement: (id) =>
      request<{ deleted: number }>(token, `/announcements/${id}`, { method: "DELETE" }),
    listAnnouncementTypes: () => request<AnnouncementTypeListResponse>(token, "/announcement-types"),
    createAnnouncementType: (req) =>
      request<{ type: AnnouncementType }>(token, "/announcement-types", {
        method: "POST",
        body: JSON.stringify(req),
      }),
    updateAnnouncementType: (id, req) =>
      request<{ type: AnnouncementType }>(token, `/announcement-types/${id}`, {
        method: "PUT",
        body: JSON.stringify(req),
      }),
    deleteAnnouncementType: (id) =>
      request<{ deleted: number }>(token, `/announcement-types/${id}`, { method: "DELETE" }),
  }
}

/**
 * API surface for the admin Lambda. In mock mode (VITE_MOCK=1, a build-time
 * constant) all calls are served from in-memory fixtures so the UI can be
 * developed and demoed before the AWS side is provisioned.
 */
export const useApi: () => Api = MOCK ? () => mockApi : useRealApi
