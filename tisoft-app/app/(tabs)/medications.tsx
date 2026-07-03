import ProfileHeader from '@/components/profile-header';
import { apiRequest } from '@/utils/api';
import { cancelMedicationNotifications, scheduleMedicationNotifications } from '@/utils/notification-helper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Platform, RefreshControl, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Button, Divider, IconButton, Surface, Text } from 'react-native-paper';
import { COLORS, RADIUS, SHADOWS } from '../../constants/theme';
import { GlobalStyles } from '../../styles/globalstyles';

export default function MedicationsScreen() {
  const router = useRouter();
  const [reminders, setReminders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useFocusEffect(useCallback(() => { loadData(); }, []));

  const loadData = async () => {
    try {
      //console.log("Loading medication reminders...");
      if (reminders.length === 0) setLoading(true);
      const res = await apiRequest('/medication-reminders');
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
        body: JSON.stringify({ id, status: next })
      });
      if (!res.ok) throw new Error('Failed to update status');

      if (Platform.OS !== 'web' && target) {
        await scheduleMedicationNotifications({ ...target, status: next });
      }
    } catch (e) {
      // Roll back the optimistic UI update if the backend call failed
      setReminders(prev => prev.map(r => r.id === id ? { ...r, status: currentStatus } : r));
      Alert.alert("Error", "Failed to update reminder status. Please try again.");
    }
  };

  const deleteReminder = (id: number) => {
    const logic = async () => {
      await apiRequest('/medication-reminders', {
        method: 'DELETE',
        body: JSON.stringify({ id })
      });
      if (Platform.OS !== 'web') await cancelMedicationNotifications(id);
      loadData();
    };
    if (Platform.OS === 'web') { if (window.confirm("Delete?")) logic(); }
    else { Alert.alert("Delete", "Remove reminder?", [{ text: "No" }, { text: "Yes", onPress: logic, style: 'destructive' }]); }
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
      >
        <Text style={styles.pageTitle}>Medications</Text>

        <View style={styles.listContainer}>
          {loading && !refreshing ?
            ( <ActivityIndicator color={COLORS.primary} />)
            : reminders.length === 0 ? (
              /* --- PROFESSIONAL EMPTY STATE --- */
              <View style={styles.emptyState}>
                <View style={styles.emptyIconCircle}>
                  <MaterialCommunityIcons name="pill-off" size={48} color={COLORS.secondary} />
                </View>
                <Text style={styles.emptyTitle}>Medication Schedule Empty</Text>
                <Text style={styles.emptySubtext}>
                  No medication reminder has been configured. Add one to start receiving alerts.
                </Text>
                <Button
                  mode="contained"
                  buttonColor={COLORS.primary}
                  onPress={() => router.push('/medication-reminder-form')}
                  style={styles.emptyBtn}
                  icon="plus"
                >
                  Set Up Reminder
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
                        <Text style={styles.medSub}>{item.selected_dosage} • Every {item.frequency_days} day(s)</Text>
                      </View>
                      <View style={styles.actionGroup}>
                        <Switch value={isActive} onValueChange={() => toggleStatus(item.id, item.status)} thumbColor={isActive ? COLORS.primary : COLORS.secondary} />
                        <IconButton icon={isExpanded ? "chevron-up" : "chevron-down"} size={22} onPress={() => setExpandedId(isExpanded ? null : item.id)} />
                      </View>
                    </View>

                    {isExpanded && (
                      <View style={styles.details}>
                        <Divider style={styles.divider} />
                        <Text style={GlobalStyles.labelMini}>Schedule</Text>
                        <Text style={styles.detailValue}>
                          {[item.at_breakfast && "Breakfast", item.at_lunch && "Lunch", item.at_dinner && "Dinner", item.at_bedtime && "Bedtime"].filter(Boolean).join(' • ')}
                        </Text>
                        <View style={styles.footerActions}>
                          <Button icon="delete-outline" textColor={COLORS.error} onPress={() => deleteReminder(item.id)}>Delete</Button>
                          <Button icon="pencil-outline" onPress={() => router.push({ pathname: '/medication-reminder-form', params: { reminder: JSON.stringify(item) } })}>Edit</Button>
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