/**
 * Client-side resolution of a localised announcement (migration 009).
 *
 * **The server already resolves these**, using the `?locale=` the client sends,
 * and returns flat `title`/`content` alongside the per-locale columns. So why
 * resolve again here: **the user can change language without refetching.**
 * `changeLanguage` swaps i18next's language and re-renders, but the list held in
 * state still carries whatever the server resolved when it was fetched. Reading
 * the per-locale fields makes the switch immediate instead of leaving the news
 * section in the previous language until something happens to reload it.
 *
 * Pure and dependency-free for the reason `dose-queue-policy` and
 * `relationship-types` are: every rule here fails silently. Picking the wrong
 * side shows a patient a language they may not read, and there is no error and
 * no log — it simply looks like the article was written that way.
 */

export const ANNOUNCEMENT_LOCALES = { en: 'en', 'zh-Hant': 'zh_hant' } as const;

export type AnnouncementLocale = keyof typeof ANNOUNCEMENT_LOCALES;

/** Matches `users.locale`'s default and the backend's own fallback. */
export const DEFAULT_ANNOUNCEMENT_LOCALE: AnnouncementLocale = 'zh-Hant';

/** A row as the API returns it: both languages, plus the server's own resolution. */
export interface RawAnnouncement {
  id: number;
  title_en?: string | null;
  title_zh_hant?: string | null;
  content_en?: string | null;
  content_zh_hant?: string | null;
  published_at?: string | null;
  /**
   * The article type's label, per locale (migration 010). Types are rows staff
   * edit, so these arrive as text rather than as a key into the locale files —
   * a category invented this afternoon has no `news.type.*` key and never will.
   */
  type_label_en?: string | null;
  type_label_zh_hant?: string | null;
  type_color?: string | null;
  /** The server's resolution. Kept as the fallback for a row missing the pairs above. */
  title?: string | null;
  content?: string | null;
  type?: string | null;
}

export interface ResolvedAnnouncement {
  id: number;
  /** The type's label in the reader's language — display text, not an identifier. */
  type: string;
  typeColor: string | null;
  title: string;
  content: string;
  publishedAt: string | null;
  /** Which language this actually came from, which is not always the one asked for. */
  locale: AnnouncementLocale;
}

const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function isAnnouncementLocale(value: unknown): value is AnnouncementLocale {
  return typeof value === 'string' && value in ANNOUNCEMENT_LOCALES;
}

/**
 * Narrow i18next's language to one this module knows.
 *
 * i18next hands back things like `en-GB` or `zh-Hant-TW` depending on the
 * device, so an exact match is not enough — an unmatched value would silently
 * resolve every article to the default language.
 */
export function announcementLocaleFrom(language: string | undefined): AnnouncementLocale {
  if (isAnnouncementLocale(language)) return language;
  if (typeof language === 'string' && language.toLowerCase().startsWith('zh')) return 'zh-Hant';
  if (typeof language === 'string' && language.toLowerCase().startsWith('en')) return 'en';
  return DEFAULT_ANNOUNCEMENT_LOCALE;
}

/**
 * Resolve one row for one reader.
 *
 * **An article falls back as a unit**, chosen by which side carries a title —
 * the same rule the server applies, and for the same reason. Resolving the
 * headline and the body independently would let a half-translated article
 * render a Chinese headline over an English paragraph, which reads as a bug
 * rather than as a missing translation.
 */
export function resolveAnnouncement(
  row: RawAnnouncement,
  locale: AnnouncementLocale
): ResolvedAnnouncement {
  const preferred = isAnnouncementLocale(locale) ? locale : DEFAULT_ANNOUNCEMENT_LOCALE;
  const other: AnnouncementLocale = preferred === 'en' ? 'zh-Hant' : 'en';

  const titleFor = (l: AnnouncementLocale) => row[`title_${ANNOUNCEMENT_LOCALES[l]}`];
  const contentFor = (l: AnnouncementLocale) => row[`content_${ANNOUNCEMENT_LOCALES[l]}`];

  let chosen: AnnouncementLocale | null = null;
  if (filled(titleFor(preferred))) chosen = preferred;
  else if (filled(titleFor(other))) chosen = other;

  // No per-locale title on either side means a row this build does not
  // understand — an older API, or a shape that changed. Falling back to the
  // server's flat pair keeps the article readable rather than blanking it.
  const title = chosen ? titleFor(chosen) : row.title;
  const content = chosen ? contentFor(chosen) : row.content;

  // **The tag resolves independently of the body, and that asymmetry is
  // deliberate.** The body falls back as a unit because a Chinese headline over
  // an English paragraph reads as a bug. A tag is one word beside the headline,
  // so showing it in the reader's language over an article that fell back is
  // better than showing no tag at all. They are separate reading tasks.
  const typeLabelFor = (l: AnnouncementLocale) => row[`type_label_${ANNOUNCEMENT_LOCALES[l]}`];
  const typeLabel = [typeLabelFor(preferred), typeLabelFor(other), row.type].find(filled) ?? '';

  return {
    id: row.id,
    type: typeLabel,
    typeColor: filled(row.type_color) ? row.type_color : null,
    title: filled(title) ? title : '',
    content: filled(content) ? content : '',
    publishedAt: row.published_at ?? null,
    locale: chosen ?? preferred,
  };
}

/** Resolve a list, dropping anything with nothing to show. */
export function resolveAnnouncements(
  rows: RawAnnouncement[] | null | undefined,
  locale: AnnouncementLocale
): ResolvedAnnouncement[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => resolveAnnouncement(r, locale)).filter((a) => a.title !== '');
}
