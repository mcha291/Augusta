// Client-side mirror of the translation validation used by the admin Lambda
// and the app repo's CI (scripts/validate-translations.mjs). Kept as three
// small independent copies on purpose — a shared package across three repos
// would be heavier than the ~60 lines it deduplicates. If the rules change,
// change all three.

import type { LocaleContent } from "@/lib/types"

const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"]

export function stemOf(key: string): string {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length)
  }
  return key
}

export function placeholdersIn(text: unknown): Set<string> {
  if (typeof text !== "string") return new Set()
  const matches = text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)
  return new Set(Array.from(matches, (m) => m[1]))
}

function flatten(obj: LocaleContent): Record<string, string> {
  const out: Record<string, string> = {}
  for (const ns of Object.keys(obj)) {
    for (const key of Object.keys(obj[ns])) {
      out[`${ns}.${key}`] = obj[ns][key]
    }
  }
  return out
}

function groupByStem(flat: Record<string, string>): Map<string, string[]> {
  const stems = new Map<string, string[]>()
  for (const [key, value] of Object.entries(flat)) {
    const stem = stemOf(key)
    if (!stems.has(stem)) stems.set(stem, [])
    stems.get(stem)!.push(value)
  }
  return stems
}

/** Returns human-readable problems; empty array = the pair is valid. */
export function validateLocalePair(en: LocaleContent, zhHant: LocaleContent): string[] {
  const problems: string[] = []
  const enStems = groupByStem(flatten(en))
  const zhStems = groupByStem(flatten(zhHant))

  for (const stem of enStems.keys()) {
    if (!zhStems.has(stem)) problems.push(`Missing in zh-Hant: "${stem}"`)
  }
  for (const stem of zhStems.keys()) {
    if (!enStems.has(stem)) problems.push(`Missing in en: "${stem}"`)
  }

  for (const stem of enStems.keys()) {
    if (!zhStems.has(stem)) continue
    const enPh = new Set<string>()
    for (const v of enStems.get(stem)!) for (const p of placeholdersIn(v)) enPh.add(p)
    const zhPh = new Set<string>()
    for (const v of zhStems.get(stem)!) for (const p of placeholdersIn(v)) zhPh.add(p)

    for (const p of enPh) if (!zhPh.has(p)) problems.push(`"${stem}": {{${p}}} missing from zh-Hant`)
    for (const p of zhPh) if (!enPh.has(p)) problems.push(`"${stem}": {{${p}}} missing from en`)
  }

  return problems
}
