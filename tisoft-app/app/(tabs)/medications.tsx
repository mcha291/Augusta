import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Platform, RefreshControl, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Button, Divider, IconButton, Surface, Text } from 'react-native-paper';
import { COLORS, RADIUS, SHADOWS } from '../../constants/theme';
import { GlobalStyles } from '../../styles/globalstyles';

const API_URL = 'https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws/medication-reminders';

export default function MedicationsScreen() {
  const router = useRouter();
  const [reminders, setReminders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const loadData = async () => {
    try {
      if (reminders.length === 0) setLoading(true);
      const res = await fetch(API_URL);
      setReminders(await res.json());
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useFocusEffect(useCallback(() => { loadData(); }, []));

  const toggleStatus = async (id: number, currentStatus: string) => {
    const next = currentStatus === 'active' ? 'inactive' : 'active';
    setReminders(prev => prev.map(r => r.id === id ? { ...r, status: next } : r));
    await fetch(API_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status: next }) });
  };

  const deleteReminder = (id: number) => {
    const logic = async () => {
      await fetch(API_URL, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      loadData();
    };
    if (Platform.OS === 'web') { if (window.confirm("Delete?")) logic(); }
    else { Alert.alert("Delete", "Remove reminder?", [{ text: "No" }, { text: "Yes", onPress: logic, style: 'destructive' }]); }
  };

  return (
    <View style={GlobalStyles.container}>
      <View style={GlobalStyles.header}>
        <IconButton icon="account-circle-outline" iconColor={COLORS.primary} size={28} onPress={() => router.push('/profile')} />
        <View style={{ flexDirection: 'row' }}>
          <IconButton icon="pill-multiple" iconColor={COLORS.ink} size={24} onPress={() => router.push('/medication-library')} />
          <IconButton icon="plus-circle-outline" iconColor={COLORS.ink} size={28} onPress={() => router.push('/medication-reminder-form')} />
        </View>
      </View>

      <ScrollView 
        contentContainerStyle={GlobalStyles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadData(); }} />}
      >
        <Text style={styles.pageTitle}>Medications</Text>

        <View style={styles.listContainer}>
          {loading && !refreshing ? <ActivityIndicator color={COLORS.primary} /> : reminders.map((item) => {
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
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
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