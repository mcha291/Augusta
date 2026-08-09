import test from 'node:test';
import assert from 'node:assert/strict';

import {
  announcementLocaleFrom,
  DEFAULT_ANNOUNCEMENT_LOCALE,
  resolveAnnouncement,
  resolveAnnouncements,
  type RawAnnouncement,
} from './announcements.ts';

const row = (over: Partial<RawAnnouncement> = {}): RawAnnouncement => ({
  id: 1,
  type_label_en: 'System Updates',
  type_label_zh_hant: '系統更新',
  type_color: '#6366F1',
  title_en: 'Clinic closed Monday',
  title_zh_hant: '週一休診',
  content_en: 'The clinic is closed.',
  content_zh_hant: '診所休診。',
  published_at: '2026-08-01T00:00:00.000Z',
  ...over,
});

test('resolves to the reader’s language', () => {
  assert.equal(resolveAnnouncement(row(), 'en').title, 'Clinic closed Monday');
  assert.equal(resolveAnnouncement(row(), 'zh-Hant').title, '週一休診');
});

test('AN ARTICLE FALLS BACK AS A UNIT, never a headline in one language over a body in the other', () => {
  const enOnly = row({ title_zh_hant: null, content_zh_hant: null });
  const got = resolveAnnouncement(enOnly, 'zh-Hant');
  assert.equal(got.locale, 'en');
  assert.equal(got.title, 'Clinic closed Monday');
  assert.equal(got.content, 'The clinic is closed.');
});

test('a whitespace-only translation counts as absent', () => {
  // What an editor leaves behind after tabbing through the Chinese fields.
  const got = resolveAnnouncement(row({ title_zh_hant: '   ' }), 'zh-Hant');
  assert.equal(got.locale, 'en');
});

test('THE SERVER’S FLAT PAIR IS THE LAST RESORT, so an older API shape still renders', () => {
  // A row with no per-locale columns at all — what a build newer than the
  // deployed Lambda would see. Blanking the card would be worse than showing
  // whatever the server resolved.
  const legacy: RawAnnouncement = { id: 9, type: 'News', title: 'Legacy headline', content: 'Legacy body' };
  const got = resolveAnnouncement(legacy, 'zh-Hant');
  assert.equal(got.title, 'Legacy headline');
  assert.equal(got.content, 'Legacy body');
});

test('the type label follows the reader, since 010 made types editable rows', () => {
  assert.equal(resolveAnnouncement(row(), 'en').type, 'System Updates');
  assert.equal(resolveAnnouncement(row(), 'zh-Hant').type, '系統更新');
  assert.equal(resolveAnnouncement(row(), 'en').typeColor, '#6366F1');
});

test('THE TAG RESOLVES SEPARATELY FROM THE BODY, so a fallen-back article keeps its own language tag', () => {
  // A staff member who translated the type but not this article should still
  // see 系統更新 over the English text, rather than the tag falling back too.
  const enOnlyBody = row({ title_zh_hant: null, content_zh_hant: null });
  const got = resolveAnnouncement(enOnlyBody, 'zh-Hant');
  assert.equal(got.locale, 'en', 'the body fell back');
  assert.equal(got.type, '系統更新', 'the tag did not');
});

test('an untranslated type falls back rather than leaving the tag blank', () => {
  const got = resolveAnnouncement(row({ type_label_zh_hant: null }), 'zh-Hant');
  assert.equal(got.type, 'System Updates');
});

test('a row with no type labels at all falls back to the server’s flat field', () => {
  const legacy = row({ type_label_en: null, type_label_zh_hant: null, type: 'News' });
  assert.equal(resolveAnnouncement(legacy, 'en').type, 'News');
});

test('i18next regional tags narrow to a supported locale', () => {
  // The device decides this, not the app: getLocales() yields en-GB, zh-Hant-TW.
  assert.equal(announcementLocaleFrom('en-GB'), 'en');
  assert.equal(announcementLocaleFrom('zh-Hant-TW'), 'zh-Hant');
  assert.equal(announcementLocaleFrom('zh'), 'zh-Hant');
  assert.equal(announcementLocaleFrom('en'), 'en');
});

test('an unrecognised language falls back to the default rather than to English', () => {
  // The user base is Taiwan, so the default is the safer wrong answer.
  assert.equal(announcementLocaleFrom('fr-FR'), DEFAULT_ANNOUNCEMENT_LOCALE);
  assert.equal(announcementLocaleFrom(undefined), DEFAULT_ANNOUNCEMENT_LOCALE);
});

test('an article with no usable title in either language is dropped from a list', () => {
  const rows = [row(), row({ id: 2, title_en: null, title_zh_hant: null, title: null })];
  const got = resolveAnnouncements(rows, 'en');
  assert.equal(got.length, 1);
  assert.equal(got[0].id, 1);
});

test('a non-array response does not throw', () => {
  // The home screen fetches three endpoints at once and one failing should not
  // take the others down with it.
  assert.deepEqual(resolveAnnouncements(null, 'en'), []);
  assert.deepEqual(resolveAnnouncements(undefined, 'en'), []);
});
