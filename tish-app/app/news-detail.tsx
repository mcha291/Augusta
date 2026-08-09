import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { Appbar, IconButton, Surface, Text } from 'react-native-paper';

import { useAuth } from '@/context/AuthContext';
import { useTextToSpeech } from '@/hooks/use-text-to-speech';
import {
  announcementLocaleFrom,
  resolveAnnouncements,
  type ResolvedAnnouncement
} from '@/utils/announcements';
import { apiRequest } from '@/utils/api';
import { goBackOrHome } from '@/utils/navigation';
import { COLORS, RADIUS, SPACING } from '../constants/theme';
import { GlobalStyles } from '../styles/globalstyles';

export default function NewsDetailScreen() {
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const { user, activeDependent } = useAuth();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { speakingId, toggle: toggleSpeech } = useTextToSpeech();

  const locale = announcementLocaleFrom(i18n.language);
  const articleId = Number(id);

  const [article, setArticle] = useState<ResolvedAnnouncement | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const scopedUserId = activeDependent?.id ?? user?.id;

  const load = useCallback(async () => {
    // **There is no GET /announcements/{id}.** The list is small, bounded by
    // what staff have published, and already scoped and localised by the same
    // route — so this filters the list rather than adding a second endpoint
    // that would need its own auth, its own locale handling and its own tests.
    try {
      setFailed(false);
      const res = await apiRequest(`/announcements?locale=${encodeURIComponent(locale)}`, {}, scopedUserId);
      const rows = await res.json();
      const found = resolveAnnouncements(rows, locale).find((a) => a.id === articleId) ?? null;
      setArticle(found);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [articleId, locale, scopedUserId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const speechText = article ? `${article.title}. ${article.content}` : '';

  return (
    <View style={GlobalStyles.container}>
      <Appbar.Header style={{ backgroundColor: COLORS.surface }}>
        <Appbar.BackAction onPress={() => goBackOrHome(router)} />
        <Appbar.Content title={t('news.title')} />
        {article && (
          <IconButton
            testID="news-speak"
            icon={speakingId === article.id ? 'stop' : 'volume-high'}
            onPress={() => toggleSpeech(article.id, speechText)}
          />
        )}
      </Appbar.Header>

      {loading ? (
        <ActivityIndicator style={{ marginTop: SPACING.xxl }} testID="news-detail-loading" />
      ) : (
        <ScrollView contentContainerStyle={GlobalStyles.scrollContent}>
          {!article ? (
            <Surface style={GlobalStyles.card} elevation={0}>
              {/* An article can vanish between list and detail: staff may have
                  unpublished it. Saying so beats an empty screen. */}
              <Text style={styles.emptyText}>
                {failed ? t('news.loadFailed') : t('news.notFound')}
              </Text>
            </Surface>
          ) : (
            <Surface style={GlobalStyles.card} elevation={0}>
              <View style={styles.tag}>
                <Text style={styles.tagText}>{article.type.toUpperCase()}</Text>
              </View>
              <Text style={styles.headline}>{article.title}</Text>
              {article.publishedAt && (
                <Text style={styles.date}>
                  {new Date(article.publishedAt).toLocaleDateString(i18n.language)}
                </Text>
              )}
              <Text style={styles.body}>{article.content}</Text>
            </Surface>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    alignSelf: 'flex-start',
    backgroundColor: COLORS.background,
    borderRadius: RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    marginBottom: SPACING.sm
  },
  tagText: { fontSize: 11, fontWeight: '800', color: COLORS.secondary, letterSpacing: 0.5 },
  headline: { fontSize: 22, fontWeight: '800', color: COLORS.ink, marginBottom: SPACING.xs },
  date: { fontSize: 12, color: COLORS.secondary, marginBottom: SPACING.lg },
  body: { fontSize: 16, color: COLORS.slate, lineHeight: 24 },
  emptyText: { fontSize: 14, color: COLORS.slate, textAlign: 'center' }
});
