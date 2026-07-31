import ProfileHeader from '@/components/profile-header';
import { useAuth } from '@/context/AuthContext';
import { useNotificationSync } from '@/hooks/use-notification-sync';
import { apiRequest } from '@/utils/api';
import { missedDoses } from '@/utils/doses';
import type { DoseRow } from '@/utils/doses';
import { cancelMedicationNotifications, scheduleMedicationNotifications } from '@/utils/notification-helper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Platform, RefreshControl, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Button, Divider, IconButton, Surface, Text } from 'react-native-paper';
import { COLORS, RADIUS, SHADOWS } from '../../constants/theme';
import { GlobalStyles } from '../../styles/globalstyles';

/** 5.7 — how far back the missed-dose list looks. A week is a review, not an archive. */
const MISSED_WINDOW_DAYS = 7;

export default function MedicationsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { activeDependent, user } = useAuth();
  const { syncFor } = useNotificationSync();
  const [reminders, setReminders] = useState<any[]>([]);
  const [missed, setMissed] = useState<DoseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useFocusEffect(useCallback(() => { loadData(); }, [activeDependent?.id]));

  const loadData = async () => {
    try {
      //console.log("Loading medication reminders...");
      if (reminders.length === 0) setLoading(true);
      const res = await apiRequest('/medication-reminders', {}, activeDependent?.id);
      const data = await res.json();
      setReminders(data);

      // 5.7 — deliberately not awaited alongside the reminders it sits under.
      // The list of medications is the screen's job; the missed-dose section is
      // a supplement, and a slow or failed dose fetch must not hold up or blank
      // the thing the user came here for.
      loadMissed();

      // Keep local notifications in sync with backend state on every load —
      // this covers cases like reinstalls or notifications not persisting.
      //
      // The reconciliation itself now lives in useNotificationSync so app
      // launch can run it too (4.1). It was previously inline here, which made
      // this screen the only thing in the app that ever repaired a broken
      // alarm chain — opening to Home never did.
      // The viewer is passed alongside the scope so that when a caregiver is
      // looking at a dependent, the alarms this leaves on the device are the
      // delayed escalation copies (4.2 item 4) rather than duplicates of the
      // dependent's own.
      //
      // The owner falls back to `user?.id` rather than staying undefined so the
      // reminder cache can evict a set that comes back empty — same reason the
      // launch reconciliation passes it explicitly.
      if (Platform.OS !== 'web') {
        await syncFor(activeDependent?.id ?? user?.id, user?.id);
      }
    } finally {
      //console.log("Finished loading medication reminders.");
      setLoading(false);
      setRefreshing(false);
    }
  };

  /**
   * 5.7 / D-4 — the doses whose time passed without a confirmation.
   *
   * D-2 says a missed dose is never fired late, which is safe but leaves no
   * trace at all; this is the trace. It is a *passive record*, not an alarm, so
   * nothing here notifies, badges or nags — see the tone note on the section
   * below.
   *
   * A failure leaves the previous list standing rather than clearing it: an
   * empty section is a claim that nothing was missed, and a network error is not
   * evidence of that.
   */
  const loadMissed = async () => {
    const now = new Date();
    const from = new Date(now.getTime() - MISSED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    try {
      const res = await apiRequest(
        `/medication-doses?from=${encodeURIComponent(from)}&to=${encodeURIComponent(now.toISOString())}`,
        {},
        activeDependent?.id
      );
      if (!res.ok) {
        console.warn('[medications] missed doses unavailable:', res.status);
        return;
      }
      const rows = await res.json();
      setMissed(missedDoses(Array.isArray(rows) ? rows : [], new Date()));
    } catch (e) {
      console.warn('[medications] could not load missed doses', e);
    }
  };

  const toggleStatus = async (id: number, currentStatus: string) => {
    const next = currentStatus === 'active' ? 'inactive' : 'active';
    const target = reminders.find(r => r.id === id);

    setReminders(prev => prev.map(r => r.id === id ? { ...r, status: next } : r));

    try {
      const res = await apiRequest('/medication-reminders', {
        method: 'PUT',
        body: { id, status: next }
      }, activeDependent?.id);
      if (!res.ok) throw new Error('Failed to update status');

      if (Platform.OS !== 'web' && target) {
        await scheduleMedicationNotifications({ ...target, status: next }, { viewerUserId: user?.id });
      }
    } catch (e) {
      // Roll back the optimistic UI update if the backend call failed
      setReminders(prev => prev.map(r => r.id === id ? { ...r, status: currentStatus } : r));
      Alert.alert(t('common.error'), t('medications.updateStatusFailed'));
    }
  };

  const deleteReminder = (id: number) => {
    const logic = async () => {
      await apiRequest('/medication-reminders', {
        method: 'DELETE',
        body: { id }
      }, activeDependent?.id);
      // No owner argument, deliberately: the reminder is gone for everyone, so
      // every copy on this device should go — the patient's own set and any
      // caregiver copy alike (4.2).
      if (Platform.OS !== 'web') await cancelMedicationNotifications(id);
      loadData();
    };
    if (Platform.OS === 'web') { if (window.confirm(t('medications.deleteConfirmWeb'))) logic(); }
    else { Alert.alert(t('medications.deleteConfirmTitle'), t('medications.deleteConfirmMessage'), [{ text: t('common.no') }, { text: t('common.yes'), onPress: logic, style: 'destructive' }]); }
  };

  return (
    <View style={GlobalStyles.container}>
      
      {/* --- 2. THE REFACTORED HEADER --- */}
      <ProfileHeader 
        rightActions={
          <View style={{ flexDirection: 'row' }}>
            <IconButton 
                icon="pill-multiple" 
                iconColor={COLORS.ink} 
                size={26} 
                onPress={() => router.push('/medication-library')} 
            />
            <IconButton 
                icon="plus-circle-outline" 
                iconColor={COLORS.ink} 
                size={26} 
                onPress={() => router.push('/medication-reminder-form')} 
            />
          </View>
        }
      />

      <ScrollView
        contentContainerStyle={GlobalStyles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadData(); }} />}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.pageTitle}>{t('medications.title')}</Text>

        {/*
          5.7 / D-4 — the missed-dose record.

          **Tone is a requirement here, not a preference.** The people reading
          this are often elderly and have just been told they missed a dose;
          D-4 asks for something that reads as a record rather than a reprimand.
          So: a neutral slate surface rather than the error red used elsewhere on
          this screen, a "clock-outline" rather than an alert triangle, no count
          in the heading, and a footnote that says plainly what to do — which is
          to ask someone, not to take the dose late. D-2 is why: whether to take
          a dose late or skip it is drug-specific and needs clinical input the
          software does not have.

          Absent entirely when there is nothing to show. A permanent "0 missed"
          panel turns a record into a scoreboard.
        */}
        {missed.length > 0 && (
          <Surface style={styles.missedCard} elevation={0}>
            <View style={styles.missedHeader}>
              <MaterialCommunityIcons name="clock-outline" size={20} color={COLORS.slate} />
              <Text style={styles.missedTitle}>{t('medications.missedTitle')}</Text>
            </View>
            <Text style={styles.missedSubtitle}>{t('medications.missedSubtitle')}</Text>

            {missed.map((dose, i) => {
              const at = new Date(String(dose.scheduled_for));
              return (
                <View key={dose.id ?? `${dose.reminder_id}-${dose.scheduled_for}`} style={styles.missedRow}>
                  {i > 0 && <Divider style={styles.missedDivider} />}
                  <View style={styles.missedRowBody}>
                    <Text style={styles.missedWhen}>
                      {at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      {'  '}
                      {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                    <Text style={styles.missedWhat} numberOfLines={1}>
                      {dose.med_name || t('alarmOverlay.unknownMedication')}
                      {dose.selected_dosage ? ` • ${dose.selected_dosage}` : ''}
                    </Text>
                  </View>
                </View>
              );
            })}

            <Text style={styles.missedFootnote}>{t('medications.missedFootnote')}</Text>
          </Surface>
        )}

        <View style={styles.listContainer}>
          {loading && !refreshing ?
            ( <ActivityIndicator color={COLORS.primary} />)
            : reminders.length === 0 ? (
              /* --- PROFESSIONAL EMPTY STATE --- */
              <View style={styles.emptyState}>
                <View style={styles.emptyIconCircle}>
                  <MaterialCommunityIcons name="pill-off" size={48} color={COLORS.secondary} />
                </View>
                <Text style={styles.emptyTitle}>{t('medications.emptyTitle')}</Text>
                <Text style={styles.emptySubtext}>
                  {t('medications.emptySubtext')}
                </Text>
                <Button
                  mode="contained"
                  buttonColor={COLORS.primary}
                  onPress={() => router.push('/medication-reminder-form')}
                  style={styles.emptyBtn}
                  icon="plus"
                >
                  {t('medications.setUpReminder')}
                </Button>
              </View>
            )
              : ( reminders.map((item) => {
                const isActive = item.status === 'active';
                const isExpanded = expandedId === item.id;

                return (
                  <Surface key={item.id} style={[styles.medCard, !isActive && { opacity: 0.6 }]} elevation={0}>
                    <View style={styles.cardHeader}>
                      <View style={[styles.pillIconBox, { backgroundColor: isActive ? COLORS.primary + '15' : COLORS.background }]}>

                        <MaterialCommunityIcons name="pill" size={24} color={isActive ? COLORS.primary : COLORS.secondary} />
                      </View>
                      <View style={styles.mainInfo}>
                        <Text style={styles.medName}>{item.med_name}</Text>
                        <Text style={styles.medSub}>{item.selected_dosage} • {t('medications.frequencyEvery', { count: item.frequency_days })}</Text>
                      </View>
                      <View style={styles.actionGroup}>
                        <Switch value={isActive} onValueChange={() => toggleStatus(item.id, item.status)} thumbColor={isActive ? COLORS.primary : COLORS.secondary} />
                        <IconButton icon={isExpanded ? "chevron-up" : "chevron-down"} size={22} onPress={() => setExpandedId(isExpanded ? null : item.id)} />
                      </View>
                    </View>

                    {isExpanded && (
                      <View style={styles.details}>
                        <Divider style={styles.divider} />
                        <Text style={GlobalStyles.labelMini}>{t('medications.schedule')}</Text>
                        <Text style={styles.detailValue}>
                          {[item.at_breakfast && t('mealTypes.breakfast'), item.at_lunch && t('mealTypes.lunch'), item.at_dinner && t('mealTypes.dinner'), item.at_bedtime && t('mealTypes.bedtime')].filter(Boolean).join(' • ')}
                        </Text>
                        {item.alarms?.length > 0 && (
                          <>
                            <Text style={GlobalStyles.labelMini}>{t('medications.alarms')}</Text>
                            <Text style={styles.detailValue}>
                              {item.alarms.map((alarmTime: string, i: number) => `${item.alarm_labels?.[i] || t('medications.alarmDefaultLabel', { number: i + 1 })} (${alarmTime})`).join(' • ')}
                            </Text>
                          </>
                        )}
                        <View style={styles.footerActions}>
                          <Button icon="delete-outline" textColor={COLORS.error} onPress={() => deleteReminder(item.id)}>{t('common.delete')}</Button>
                          <Button icon="pencil-outline" onPress={() => router.push({ pathname: '/medication-reminder-form', params: { reminder: JSON.stringify(item) } })}>{t('common.edit')}</Button>
                        </View>
                      </View>
                    )}
                  </Surface>
                );
              }))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  emptyIconCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'white',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    ...SHADOWS.soft, // Uses your global soft shadow
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.ink,
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: COLORS.slate,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  emptyBtn: {
    borderRadius: 16,
    paddingHorizontal: 12,
    height: 48,
    justifyContent: 'center',
  },
  pageTitle: { fontSize: 28, fontWeight: '800', color: COLORS.ink, marginBottom: 20 },
  // 5.7 — deliberately the quietest card on the screen. See the tone note above.
  missedCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: 16, marginBottom: 16, ...SHADOWS.soft },
  missedHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  missedTitle: { fontSize: 16, fontWeight: '700', color: COLORS.ink },
  missedSubtitle: { fontSize: 13, color: COLORS.slate, marginTop: 4, lineHeight: 18 },
  missedRow: { marginTop: 10 },
  missedDivider: { backgroundColor: COLORS.background, marginBottom: 10 },
  missedRowBody: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  missedWhen: { fontSize: 13, fontWeight: '700', color: COLORS.slate, minWidth: 96 },
  missedWhat: { flex: 1, fontSize: 15, fontWeight: '600', color: COLORS.ink },
  missedFootnote: { fontSize: 12, color: COLORS.slate, marginTop: 14, lineHeight: 17 },
  listContainer: { gap: 12 },
  medCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, padding: 12, ...SHADOWS.soft },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  pillIconBox: { width: 48, height: 48, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  mainInfo: { flex: 1, marginLeft: 16 },
  medName: { fontSize: 16, fontWeight: '700', color: COLORS.ink },
  medSub: { fontSize: 13, color: COLORS.slate, marginTop: 2 },
  actionGroup: { flexDirection: 'row', alignItems: 'center' },
  details: { marginTop: 4 },
  divider: { marginVertical: 12, backgroundColor: COLORS.background },
  detailValue: { fontSize: 14, fontWeight: '600', color: COLORS.ink, marginBottom: 12 },
  footerActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }
});