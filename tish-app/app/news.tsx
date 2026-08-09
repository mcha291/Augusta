import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View
} from 'react-native';
import { Appbar, Surface, Text } from 'react-native-paper';

import { useAuth } from '@/context/AuthContext';
import {
  announcementLocaleFrom,
  resolveAnnouncements,
  type ResolvedAnnouncement
} from '@/utils/announcements';
import { apiRequest } from '@/utils/api';
import { goBackOrHome } from '@/utils/navigation';
import { COLORS, RADIUS, SPACING } from '../constants/theme';
import { GlobalStyles } from '../styles/globalstyles';

export default function NewsScreen() {
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const { user, activeDependent } = useAuth();
  const locale = announcementLocaleFrom(i18n.language);

  const [items, setItems] = useState<ResolvedAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);

  const scopedUserId = activeDependent?.id ?? user?.id;

  const load = useCallback(async () => {
    try {
      setFailed(false);
      const res = await apiRequest(`/announcements?locale=${encodeURIComponent(locale)}`, {}, scopedUserId);
      const rows = await res.json();
      setItems(resolveAnnouncements(rows, locale));
    } catch {
      // A news list that silently shows nothing is indistinguishable from a
      // quiet week, which is the failure mode Phase 1 exists to remove.
      setFailed(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [locale, scopedUserId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  return (
    <View style={GlobalStyles.container}>
      <Appbar.Header style={{ backgroundColor: COLORS.surface }}>
        <Appbar.BackAction onPress={() => goBackOrHome(router)} />
        <Appbar.Content title={t('news.title')} />
      </Appbar.Header>

      {loading ? (
        <ActivityIndicator style={{ marginTop: SPACING.xxl }} testID="news-loading" />
      ) : (
        <ScrollView
          contentContainerStyle={GlobalStyles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {failed && (
            <Surface style={GlobalStyles.card} elevation={0}>
              <Text style={styles.emptyText}>{t('news.loadFailed')}</Text>
            </Surface>
          )}

          {!failed && items.length === 0 && (
            <Surface style={GlobalStyles.card} elevation={0}>
              <Text style={styles.emptyText}>{t('news.empty')}</Text>
            </Surface>
          )}

          {items.map((item) => (
            <Pressable
              key={item.id}
              testID={`news-item-${item.id}`}
              onPress={() => router.push(`/news-detail?id=${item.id}`)}
            >
              <Surface style={GlobalStyles.card} elevation={0}>
                <View style={styles.tag}>
                  <Text style={styles.tagText}>{item.type.toUpperCase()}</Text>
                </View>
                <Text style={styles.headline}>{item.title}</Text>
                <Text numberOfLines={3} style={styles.body}>{item.content}</Text>
              </Surface>
            </Pressable>
          ))}
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
  headline: { fontSize: 17, fontWeight: '800', color: COLORS.ink, marginBottom: SPACING.xs },
  body: { fontSize: 14, color: COLORS.slate, lineHeight: 20 },
  emptyText: { fontSize: 14, color: COLORS.slate, textAlign: 'center' }
});
