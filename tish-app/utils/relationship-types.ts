/**
 * 3.4 — the relationship a caregiver declares when requesting access.
 *
 * **Stored as a stable key, rendered as a translated label, and those must not
 * be the same string.** `managed-users.tsx` hardcoded `'Family'` at request time
 * and then displayed `dep.relationship_type` straight from the row — so the
 * moment a user picks their own value, whatever language they were in is baked
 * into the database and shown to everyone else in that language forever. The
 * column already holds two different spellings for the same idea (`'Family'`
 * from the client, `'family'` from `/debug/link`), which is the same drift a
 * size smaller.
 *
 * Deliberately dependency-free so it can be exercised by `node --test`, like
 * `date.ts` and `notification-identifiers.ts` before it.
 *
 * **This does not change access scope.** The model stays all-or-nothing: a
 * caregiver sees everything or nothing regardless of what they call themselves.
 * That is a known limitation rather than a defect, and the label is descriptive
 * only — worth stating here because "relationship type" is exactly the field a
 * later reader would expect to be load-bearing for permissions.
 */

export const RELATIONSHIP_TYPES = [
  'family',
  'spouse',
  'parent',
  'child',
  'sibling',
  'carer',
  'other',
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/**
 * What the form starts on, and what a row with an unreadable value falls back
 * to. Matches the value the hardcoded client has been writing since before 3.4,
 * so existing rows keep their meaning.
 */
export const DEFAULT_RELATIONSHIP_TYPE: RelationshipType = 'family';

/**
 * A stored value reduced to one of the known keys, or `null` if it is not one.
 *
 * Case-insensitive and trimmed, because the column already holds `'Family'` and
 * `'family'` from two different writers. `null` rather than the default for an
 * unrecognised value: the caller can then choose between showing the raw string
 * — which is right for a row somebody typed something else into — and showing
 * nothing, and neither is served by silently relabelling it "family".
 */
export function normaliseRelationshipType(value: unknown): RelationshipType | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return (RELATIONSHIP_TYPES as readonly string[]).includes(key) ? (key as RelationshipType) : null;
}

/**
 * The i18n key for a stored value, or `null` when there is no translation for
 * it.
 *
 * Callers render `key ? t(key) : rawValue`. The fallback matters more than it
 * looks: every relationship row that exists today was written before this
 * module, and a display path that showed nothing for them would blank the
 * subtitle on every card in the managed-users list.
 */
export function relationshipTypeLabelKey(value: unknown): RelationshipTypeLabelKey | null {
  const key = normaliseRelationshipType(value);
  return key ? `relationshipTypes.${key}` : null;
}

/**
 * Typed as the literal union rather than `string`, so `t()` accepts it without a
 * cast. `t` is typed against the generated key union, which is the mechanism
 * §0.6 credits with making a key missing from *both* locale files a `tsc` error
 * — widening to `string` here would have opted this module out of it.
 */
export type RelationshipTypeLabelKey = `relationshipTypes.${RelationshipType}`;
