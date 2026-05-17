import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View
} from 'react-native';
import {
  Avatar,
  Button,
  Divider,
  IconButton,
  List,
  Surface,
  Switch,
  Text,
  useTheme
} from 'react-native-paper';

const BASE_URL = 'https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws';
const PRIMARY_TEAL = '#26ba9d';

export default function MedicationsScreen() {
  const theme = useTheme();
  const router = useRouter();
  
  const [reminders, setReminders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const loadData = async () => {
    try {
      if (reminders.length === 0) setLoading(true);
      const res = await fetch(`${BASE_URL}/medication-reminders`);
      const data = await res.json();
      setReminders(data);
    } catch (e) {
      console.error("Fetch error:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useFocusEffect(useCallback(() => { loadData(); }, []));

  const onRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const toggleStatus = async (id: number, currentStatus: string) => {
    const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
    try {
      setReminders(prev => prev.map(r => r.id === id ? { ...r, status: newStatus } : r));
      await fetch(`${BASE_URL}/medication-reminders`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: newStatus })
      });
    } catch (e) { loadData(); }
  };

  const deleteReminder = (id: number) => {
    const logic = async () => {
      await fetch(`${BASE_URL}/medication-reminders`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      loadData();
    };

    if (Platform.OS === 'web') {
      if (window.confirm("Remove this reminder?")) logic();
    } else {
      Alert.alert("Delete Reminder", "Are you sure you want to remove this?", [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: logic }
      ]);
    }
  };

  const navigateToEdit = (item: any) => {
    router.push({
      pathname: '/medication-reminder-form',
      params: { reminder: JSON.stringify(item) }
    });
  };

  // Helper to format meal timings
  const getMealLabels = (item: any) => {
    const labels = [];
    if (item.at_breakfast) labels.push(`${item.breakfast_timing === 'before' ? 'Before' : 'After'} Breakfast`);
    if (item.at_lunch) labels.push(`${item.lunch_timing === 'before' ? 'Before' : 'After'} Lunch`);
    if (item.at_dinner) labels.push(`${item.dinner_timing === 'before' ? 'Before' : 'After'} Dinner`);
    if (item.at_bedtime) labels.push(`Before Bed`);
    return labels;
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <IconButton icon="account-circle-outline" iconColor={theme.colors.primary} size={28} onPress={() => router.push('/profile')} />
        <View style={styles.headerRightActions}>
          <IconButton icon="pill-multiple" size={24} onPress={() => router.push('/medication-library')} />
          <IconButton icon="plus-circle-outline" size={28} onPress={() => router.push('/medication-reminder-form')} />
        </View>
      </View>

      <ScrollView 
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <Text variant="headlineMedium" style={styles.title}>Medications</Text>

        <View style={styles.listContainer}>
          {loading && !refreshing ? (
            <ActivityIndicator size="large" style={{ marginTop: 20 }} color={PRIMARY_TEAL} />
          ) : (
            reminders.map((item) => {
              const isActive = item.status === 'active';
              const isExpanded = expandedId === item.id;
              const mealLabels = getMealLabels(item);
              
              return (
                <View key={item.id} style={styles.listItemContainer}>
                  <View style={styles.accordionRow}>
                    <List.Accordion
                      title={item.med_name}
                      description={`${item.selected_dosage} • Every ${item.frequency_days} Day(s)`}
                      expanded={isExpanded}
                      onPress={() => setExpandedId(isExpanded ? null : item.id)}
                      titleStyle={[styles.medTitle, !isActive && styles.inactiveText]}
                      right={() => null}
                      left={(props) => (
                        <Avatar.Icon 
                          {...props} 
                          icon="pill" 
                          size={40} 
                          style={{ backgroundColor: isActive ? theme.colors.primaryContainer : theme.colors.surfaceVariant }}
                          color={isActive ? theme.colors.primary : theme.colors.onSurfaceVariant}
                        />
                      )}
                      style={styles.accordion}
                    >
                      {/* --- MIRRORED DETAILS BOX STYLE --- */}
                      <View style={[styles.detailsBox, { backgroundColor: theme.colors.surfaceVariant }]}>
                        
                        <View style={styles.detailSection}>
                          <Text variant="labelSmall" style={styles.label}>MEDICATION NAME</Text>
                          <Text variant="bodyLarge" style={styles.value}>{item.med_name}</Text>
                        </View>

                        <Divider style={styles.divider} />

                        <View style={styles.splitRow}>
                          <View style={{ flex: 1 }}>
                            <Text variant="labelSmall" style={styles.label}>STATUS</Text>
                            <Text variant="bodyMedium" style={[styles.value, { color: isActive ? 'green' : 'gray', fontWeight: 'bold' }]}>
                              {item.status.toUpperCase()}
                            </Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text variant="labelSmall" style={styles.label}>DOSAGE</Text>
                            <Text variant="bodyMedium" style={styles.value}>{item.selected_dosage}</Text>
                          </View>
                        </View>

                        <Divider style={styles.divider} />

                        <View style={styles.detailSection}>
                          <Text variant="labelSmall" style={styles.label}>MEAL SCHEDULE</Text>
                          <View style={styles.tagContainer}>
                            {mealLabels.length > 0 ? mealLabels.map((l, i) => (
                              <Surface key={i} style={styles.miniTag} elevation={0}>
                                <Text variant="labelSmall">{l}</Text>
                              </Surface>
                            )) : <Text variant="bodySmall" style={styles.noneText}>No specific meal times set.</Text>}
                          </View>
                        </View>

                        <View style={styles.detailSection}>
                          <Text variant="labelSmall" style={styles.label}>DAILY ALARMS</Text>
                          <View style={styles.tagContainer}>
                            {item.alarms && item.alarms.length > 0 ? item.alarms.map((time: string, i: number) => (
                              <View key={i} style={styles.alarmBadge}>
                                <MaterialCommunityIcons name="alarm" size={12} color={PRIMARY_TEAL} style={{marginRight: 4}} />
                                <Text variant="labelSmall" style={{fontWeight: 'bold'}}>{time}</Text>
                              </View>
                            )) : <Text variant="bodySmall" style={styles.noneText}>No specific alarms set.</Text>}
                          </View>
                        </View>

                        <Divider style={styles.divider} />

                        {/* Side-by-side action buttons */}
                        <View style={styles.actionButtonRow}>
                          <Button 
                            mode="outlined" 
                            icon="delete" 
                            onPress={() => deleteReminder(item.id)}
                            style={[styles.footerBtn, { borderColor: theme.colors.error }]}
                            textColor={theme.colors.error}
                          >
                            Delete
                          </Button>
                          <Button 
                            mode="contained-tonal" 
                            icon="pencil" 
                            onPress={() => navigateToEdit(item)}
                            style={styles.footerBtn}
                          >
                            Edit Details
                          </Button>
                        </View>
                      </View>
                    </List.Accordion>

                    {/* Right Side Icons - Matches Appointments */}
                    <View style={styles.rightActionGroup}>
                      <IconButton 
                        icon="delete-outline" 
                        size={20} 
                        iconColor={theme.colors.error}
                        onPress={() => deleteReminder(item.id)} 
                      />
                      <Switch
                        value={isActive}
                        onValueChange={() => toggleStatus(item.id, item.status)}
                        color={theme.colors.primary}
                      />
                      <Pressable 
                        onPress={() => setExpandedId(isExpanded ? null : item.id)}
                        style={({ pressed }) => [styles.chevronWrapper, { opacity: pressed ? 0.5 : 1 }]}
                      >
                        <MaterialCommunityIcons 
                          name={isExpanded ? 'chevron-up' : 'chevron-down'} 
                          size={24} 
                          color={theme.colors.onSurfaceVariant}
                        />
                      </Pressable>
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    paddingTop: Platform.OS === 'ios' ? 50 : 40, 
    paddingHorizontal: 8,
    alignItems: 'center'
  },
  headerRightActions: { flexDirection: 'row', alignItems: 'center' },
  scrollContent: { padding: 16, paddingBottom: 100 },
  title: { fontWeight: 'bold', marginBottom: 20 },
  listContainer: { marginTop: 8 },
  listItemContainer: { marginBottom: 4 },
  accordionRow: { position: 'relative' },
  accordion: {
    backgroundColor: 'transparent',
    paddingRight: 110, 
  },
  medTitle: { fontWeight: 'bold', fontSize: 16 },
  inactiveText: { opacity: 0.5 },
  rightActionGroup: {
    position: 'absolute',
    right: 0,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    height: 72,
    paddingRight: 8,
  },
  chevronWrapper: { padding: 8, justifyContent: 'center', alignItems: 'center' },
  
  // Expanded Content Style matched to Appointments
  detailsBox: { 
    padding: 16, 
    marginLeft: 52, 
    marginRight: 16,
    borderRadius: 12, 
    marginTop: -8, 
    marginBottom: 16
  },
  detailSection: { marginBottom: 12 },
  label: { opacity: 0.6, fontSize: 10, letterSpacing: 1, fontWeight: 'bold' },
  value: { fontWeight: '500', marginTop: 2 },
  splitRow: { flexDirection: 'row', marginBottom: 12 },
  divider: { marginVertical: 8, opacity: 0.15 },
  
  // Tag / Alarm Styles
  tagContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  miniTag: { backgroundColor: 'rgba(0,0,0,0.05)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  alarmBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#e0f2f1', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  noneText: { fontStyle: 'italic', opacity: 0.3, fontSize: 11, marginTop: 4 },

  // Footer Buttons
  actionButtonRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  footerBtn: { flex: 1, borderRadius: 8 }
});