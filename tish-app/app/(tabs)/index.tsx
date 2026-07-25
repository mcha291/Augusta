import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  View
} from 'react-native';
import {
  Avatar,
  Button,
  IconButton,
  Surface,
  Text
} from 'react-native-paper';

// Import our new professional styling system
import { useTextToSpeech } from '@/hooks/use-text-to-speech';
import { apiRequest } from '@/utils/api';
import { upcomingAppointmentsToSpeechText } from '@/utils/appointment-speech';
import { COLORS, SHADOWS, SPACING } from '../../constants/theme';
import { useAuth } from '../../context/AuthContext';
import { GlobalStyles } from '../../styles/globalstyles';

export default function HomeScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { speakingId, toggle: toggleSpeech } = useTextToSpeech();
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>({ appointments: [], meds: [], news: [] });
  const [checkInAppt, setCheckInAppt] = useState<any>(null);

  const fetchData = async () => {
    if (!user || user.id === 0) return;
    try {
      setLoading(true);
      const [apptRes, newsRes, medRes] = await Promise.all([
        apiRequest(`/appointments`, {}, user?.id),
        apiRequest(`/announcements`, {}, user?.id),
        apiRequest(`/medication-reminders`, {}, user?.id)
      ]);

      const appts = await apptRes.json();
      const news = await newsRes.json();
      const meds = await medRes.json();
      console.log("Fetched Data:", { appts, news, meds });
      const now = new Date();
      // Logic: Find the soonest appointment with "New" status for the Hero Card
      const overdueOrSoon = appts?.find((a: any) => a.status_label === 'New');

      setData({ appointments: appts, meds, news });
      setCheckInAppt(overdueOrSoon || null);
    } catch (e) {
      console.error("Dashboard Load Error:", e);
    } finally {
      setLoading(false);
    }
  };

  useFocusEffect(useCallback(() => { fetchData(); }, []));

  const updateStatus = async (id: number, statusId: number) => {
    setLoading(true);
    await apiRequest(`/appointments`, {
      method: 'PUT',
      body: { id, status_id: statusId }
    }, user?.id);
    fetchData();
  };

  if (loading && !data.appointments.length) {
    return (
      <View style={GlobalStyles.centered}>
        <ActivityIndicator color={COLORS.primary} size="large" />
      </View>
    );
  }

  const upcomingAppointments = data.appointments.filter((a: any) => a.status_label === 'New').slice(0, 3);

  return (
    <View style={GlobalStyles.container}>
      {/* 1. PROFESSIONAL HEADER (Uses GlobalStyles) */}
      <View style={GlobalStyles.header}>
        <View>
          <Text style={styles.greeting}>{t('home.goodMorning')}</Text>
          <Text style={styles.userName}>{user?.username || t('home.agentFallback')}</Text>
        </View>
        <Pressable onPress={() => router.push('/profile')}>
          <Avatar.Image
            size={52}
            source={{ uri: `https://api.dicebear.com/7.x/initials/svg?seed=${user?.username}&backgroundColor=6366f1` }}
          />
        </Pressable>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={GlobalStyles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >

        {/* 2. HERO ACTION CARD (Check-in) */}
        {checkInAppt ? (
          <Surface style={styles.heroCard} elevation={0}>
            <View style={styles.statusPill}>
              <View style={styles.pulseDot} />
              <Text style={styles.statusText}>{t('home.pendingAction')}</Text>
            </View>
            <Text style={styles.heroTitle}>{checkInAppt.title}</Text>
            <Text style={styles.heroSubtitle}>
              {checkInAppt.doctor_name} • {new Date(checkInAppt.appointment_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>

            <View style={styles.heroActions}>
              <Button
                mode="contained"
                buttonColor={COLORS.surface}
                textColor={COLORS.ink}
                onPress={() => updateStatus(checkInAppt.id, 4)} // Completed
                style={styles.heroBtn}
                labelStyle={{ fontWeight: 'bold' }}
              >
                {t('home.markCompleted')}
              </Button>
              <IconButton
                icon="close"
                iconColor={COLORS.surface}
                size={24}
                onPress={() => updateStatus(checkInAppt.id, 2)} // Missed/Cancel
              />
            </View>
          </Surface>
        ) : (
          <Surface style={[styles.heroCard, { backgroundColor: COLORS.success }]} elevation={0}>
            <Text style={styles.heroTitle}>{t('home.allClear')}</Text>
            <Text style={styles.heroSubtitle}>{t('home.noPendingAppointments')}</Text>
          </Surface>
        )}

        {/* 3. METRICS ROW */}
        <View style={styles.metricsRow}>
          <MetricItem icon="calendar-month" label={t('home.metricAppointments')} value={data.appointments.length} onPress={() => router.push('/appointments')} />
          <MetricItem icon="pill" label={t('home.metricMeds')} value={data.meds.length} onPress={() => router.push('/medications')} />
          <MetricItem icon="flask-outline" label={t('home.metricReports')} value="12" onPress={() => router.push('/results')} />
        </View>

        {/* 4. UPCOMING LIST (Uses GlobalStyles.listItem) */}
        <View style={GlobalStyles.sectionHeader}>
          <Text style={GlobalStyles.sectionTitle}>{t('home.upcomingSchedule')}</Text>
          <View style={styles.sectionHeaderActions}>
            <IconButton
              icon={speakingId === 'upcoming' ? "volume-off" : "volume-high"}
              iconColor={speakingId === 'upcoming' ? COLORS.primary : COLORS.ink}
              size={20}
              onPress={() => toggleSpeech('upcoming', upcomingAppointmentsToSpeechText(upcomingAppointments))}
            />
            <Button textColor={COLORS.primary} onPress={() => router.push('/appointments')}>{t('home.viewAll')}</Button>
          </View>
        </View>

        {upcomingAppointments.map((item: any) => (
          <Pressable key={item.id} onPress={() => router.push('/appointments')}>
            <Surface style={GlobalStyles.listItem} elevation={0}>
              <View style={styles.itemDateBox}>
                <Text style={styles.itemDateDay}>{new Date(item.appointment_date).getDate()}</Text>
                <Text style={styles.itemDateMonth}>
                  {new Date(item.appointment_date).toLocaleString('default', { month: 'short' })}
                </Text>
              </View>
              <View style={styles.itemInfo}>
                <Text style={styles.itemTitle}>{item.doctor_name}</Text>
                <Text style={styles.itemSub}>{item.hospital}</Text>
              </View>
              <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.secondary} />
            </Surface>
          </Pressable>
        ))}

        {/* 5. NEWS SECTION */}
        <View style={GlobalStyles.sectionHeader}>
          <Text style={GlobalStyles.sectionTitle}>{t('home.newsAndAnnouncements')}</Text>
        </View>

        {data.news.slice(0, 1).map((item: any) => (
          <Surface key={item.id} style={GlobalStyles.card} elevation={0}>
            <View style={styles.newsTag}>
              <Text style={styles.newsTagText}>{item.type.toUpperCase()}</Text>
            </View>
            <Text style={styles.newsHeadline}>{item.title}</Text>
            <Text numberOfLines={2} style={styles.newsContent}>{item.content}</Text>
          </Surface>
        ))}

      </ScrollView>
    </View>
  );
}

/**
 * Internal Sub-component for Metrics
 */
function MetricItem({ icon, label, value, onPress }: any) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <Surface style={styles.metricItem} elevation={0}>
        <MaterialCommunityIcons name={icon} size={20} color={COLORS.primary} />
        <Text style={styles.metricValue}>{value}</Text>
        <Text style={styles.metricLabel}>{label.toUpperCase()}</Text>
      </Surface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sectionHeaderActions: { flexDirection: 'row', alignItems: 'center' },

  // Typography
  greeting: { fontSize: 14, color: COLORS.slate, fontWeight: '500' },
  userName: { fontSize: 26, fontWeight: '800', color: COLORS.ink, letterSpacing: -0.5 },

  // Hero Card (The large dark action card)
  heroCard: {
    backgroundColor: COLORS.ink,
    borderRadius: 32,
    padding: 24,
    ...SHADOWS.medium, // Uses the stronger shadow from Theme.ts
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 100,
    alignSelf: 'flex-start',
    marginBottom: 16
  },
  pulseDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.success, marginRight: 8 },
  statusText: { color: 'white', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  heroTitle: { color: 'white', fontSize: 22, fontWeight: '800', marginBottom: 4 },
  heroSubtitle: { color: 'rgba(255,255,255,0.5)', fontSize: 14, marginBottom: 24 },
  heroActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  heroBtn: { borderRadius: 16, flex: 1, height: 48, justifyContent: 'center' },

  // Metrics Row
  metricsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACING.xl },
  metricItem: {
    width: (Dimensions.get('window').width / 3) - 24,
    backgroundColor: COLORS.surface,
    padding: 16,
    borderRadius: 24,
    alignItems: 'center',
    ...SHADOWS.soft
  },
  metricValue: { fontSize: 20, fontWeight: '800', color: COLORS.ink, marginTop: 6 },
  metricLabel: { fontSize: 9, color: COLORS.secondary, fontWeight: '700', letterSpacing: 0.5 },

  // List Specifics
  itemDateBox: {
    width: 48,
    height: 48,
    backgroundColor: COLORS.background,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center'
  },
  itemDateDay: { fontSize: 18, fontWeight: '800', color: COLORS.ink },
  itemDateMonth: { fontSize: 10, fontWeight: '700', color: COLORS.secondary, textTransform: 'uppercase' },
  itemInfo: { flex: 1, marginLeft: 16 },
  itemTitle: { fontSize: 16, fontWeight: '700', color: COLORS.ink },
  itemSub: { fontSize: 13, color: COLORS.slate, marginTop: 2 },

  // News Specifics
  newsTag: {
    backgroundColor: COLORS.background,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 10
  },
  newsTagText: { fontSize: 10, fontWeight: '800', color: COLORS.primary },
  newsHeadline: { fontSize: 18, fontWeight: '800', color: COLORS.ink, marginBottom: 6 },
  newsContent: { fontSize: 14, color: COLORS.slate, lineHeight: 20 }
});