import ProfileHeader from '@/components/profile-header';
import { useAuth } from '@/context/AuthContext';
import { apiRequest } from '@/utils/api';
import { cancelMedicationNotifications, scheduleMedicationNotifications } from '@/utils/notification-helper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Platform, RefreshControl, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Button, Divider, IconButton, Surface, Text } from 'react-native-paper';
import { COLORS, RADIUS, SHADOWS } from '../../constants/theme';
import { GlobalStyles } from '../../styles/globalstyles';

export default function MedicationsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { activeDependent } = useAuth();
  const [reminders, setReminders] = useState<any[]>([]);
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

      // Keep local notifications in sync with backend state on every load —
      // this covers cases like reinstalls or notifications not persisting.
      if (Platform.OS !== 'web') {
        //console.log("Scheduling notifications for reminders...");
        await Promise.all(data.map((r: any) => scheduleMedicationNotifications(r)));
      }
    } finally {
      //console.log("Finished loading medication reminders.");
      setLoading(false);
      setRefreshing(false);
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
        await scheduleMedicationNotifications({ ...target, status: next });
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