import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
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
  Chip,
  Divider,
  IconButton,
  List,
  Text,
  useTheme
} from 'react-native-paper';

const BASE_URL = 'https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws';

export default function AppointmentsScreen() {
  const theme = useTheme();
  const router = useRouter();
  
  const [appointments, setAppointments] = useState<any[]>([]);
  const [dbStatuses, setDbStatuses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [filter, setFilter] = useState('Upcoming');

  const loadData = async () => {
    try {
      if (appointments.length === 0) setLoading(true);
      const [apptRes, statusRes] = await Promise.all([
        fetch(`${BASE_URL}/appointments`),
        fetch(`${BASE_URL}/appointment-statuses`)
      ]);
      setAppointments(await apptRes.json());
      setDbStatuses(await statusRes.json());
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useFocusEffect(useCallback(() => { loadData(); }, []));

  // --- NEW: CANCEL LOGIC ---
  const handleCancel = (id: number) => {
    const performCancel = async () => {
      try {
        const res = await fetch(`${BASE_URL}/appointments`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            id: id, 
            status_id: 3 // ID 3 is 'Cancelled' based on our SQL seed
          })
        });
        if (res.ok) loadData();
      } catch (e) {
        Alert.alert("Error", "Failed to cancel appointment.");
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm("Are you sure you want to cancel this appointment?")) performCancel();
    } else {
      Alert.alert("Cancel Appointment", "This will mark the appointment as cancelled.", [
        { text: "No", style: "cancel" },
        { text: "Yes, Cancel it", onPress: performCancel, style: "destructive" }
      ]);
    }
  };

  const navigateToEdit = (item: any) => {
    router.push({ pathname: '/appointment-form', params: { appointment: JSON.stringify(item) } });
  };

  const getUiFilters = () => {
    const uiFilters: string[] = [];
    dbStatuses.forEach(s => {
      if (s.label === 'New') uiFilters.push('Upcoming', 'Expired');
      else uiFilters.push(s.label);
    });
    return uiFilters;
  };

  const filteredData = appointments.filter(item => {
    const now = new Date();
    const apptDate = new Date(item.appointment_date);
    if (item.status_label === 'New') {
        if (filter === 'Upcoming') return apptDate > now;
        if (filter === 'Expired') return apptDate <= now;
        return false;
    }
    return item.status_label === filter;
  });

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <IconButton icon="account-circle-outline" iconColor={theme.colors.primary} size={28} onPress={() => router.push('/profile')} />
        <IconButton icon="plus-circle-outline" size={28} onPress={() => router.push('/appointment-form')} />
      </View>

      <ScrollView 
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => {setRefreshing(true); loadData();}} />}
      >
        <Text variant="headlineMedium" style={styles.title}>Appointments</Text>

        <View style={styles.filterRow}>
          {getUiFilters().map((f) => (
            <Chip key={f} selected={filter === f} onPress={() => setFilter(f)} style={styles.chip} mode="outlined">{f}</Chip>
          ))}
        </View>

        <View style={styles.listContainer}>
          {filteredData.map((item) => {
            const isExpanded = expandedId === item.id;
            const isCancelable = item.status_label === 'New'; // Only 'New' (Upcoming/Expired) can be cancelled

            return (
              <View key={item.id} style={styles.listItemContainer}>
                <View style={styles.accordionRow}>
                  <List.Accordion
                    title={item.doctor_name}
                    description={`${new Date(item.appointment_date).toLocaleDateString()} • ${item.hospital}`}
                    expanded={isExpanded}
                    onPress={() => setExpandedId(isExpanded ? null : item.id)}
                    left={(props) => <Avatar.Icon {...props} icon="calendar-clock" size={40} style={{ backgroundColor: item.status_color }} />}
                    right={() => null}
                    style={styles.accordion}
                  >
                    <View style={[styles.detailsBox, { backgroundColor: theme.colors.surfaceVariant }]}>
                      <Text variant="labelSmall" style={styles.label}>PURPOSE</Text>
                      <Text variant="bodyLarge" style={styles.value}>{item.title}</Text>
                      <Divider style={styles.divider} />
                      
                      <View style={styles.splitRow}>
                        <View style={{ flex: 1 }}>
                          <Text variant="labelSmall" style={styles.label}>STATUS</Text>
                          <Text variant="bodyMedium" style={{ color: item.status_color, fontWeight: 'bold' }}>{item.status_label.toUpperCase()}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text variant="labelSmall" style={styles.label}>ROOM</Text>
                          <Text variant="bodyMedium" style={styles.value}>{item.room_number || 'N/A'}</Text>
                        </View>
                      </View>
                      
                      <Divider style={styles.divider} />
                      <Text variant="labelSmall" style={styles.label}>NOTES</Text>
                      <Text variant="bodyMedium" style={styles.value}>{item.details || 'No notes.'}</Text>

                      <Divider style={styles.divider} />

                      {/* --- EXPANDED BUTTON ROW --- */}
                      <View style={styles.actionButtonRow}>
                        {isCancelable && (
                          <Button 
                            mode="outlined" 
                            icon="calendar-remove" 
                            onPress={() => handleCancel(item.id)}
                            style={{ flex: 1, borderColor: theme.colors.error }}
                            textColor={theme.colors.error}
                          >
                            Cancel
                          </Button>
                        )}
                        <Button 
                          mode="contained-tonal" 
                          icon="pencil" 
                          onPress={() => navigateToEdit(item)}
                          style={{ flex: 1, marginLeft: isCancelable ? 8 : 0 }}
                        >
                          Edit
                        </Button>
                      </View>
                    </View>
                  </List.Accordion>

                  {/* --- COLLAPSED ACTION GROUP --- */}
                  <View style={styles.rightActionGroup}>
                    {isCancelable && (
                      <IconButton 
                        icon="calendar-remove" 
                        size={20} 
                        iconColor={theme.colors.error} 
                        onPress={() => handleCancel(item.id)} 
                      />
                    )}
                    <IconButton 
                      icon="pencil-outline" 
                      size={20} 
                      onPress={() => navigateToEdit(item)} 
                    />
                    <Pressable onPress={() => setExpandedId(isExpanded ? null : item.id)} style={styles.chevron}>
                      <MaterialCommunityIcons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={24} color="#bbb" />
                    </Pressable>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: Platform.OS === 'ios' ? 50 : 40, paddingHorizontal: 8 },
  scrollContent: { padding: 16, paddingBottom: 100 },
  title: { fontWeight: 'bold', marginBottom: 20 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 20, gap: 8 },
  chip: { borderRadius: 8 },
  listContainer: { marginTop: 8 },
  listItemContainer: { marginBottom: 4 },
  accordionRow: { position: 'relative' },
  accordion: { backgroundColor: 'transparent', paddingRight: 110 },
  rightActionGroup: { position: 'absolute', right: 0, top: 0, flexDirection: 'row', alignItems: 'center', height: 72, paddingRight: 8 },
  chevron: { padding: 8 },
  detailsBox: { padding: 16, marginLeft: 52, marginRight: 16, borderRadius: 12, marginTop: -8, marginBottom: 16 },
  label: { opacity: 0.6, fontSize: 10, letterSpacing: 1, fontWeight: 'bold' },
  value: { fontWeight: '500', marginTop: 2 },
  splitRow: { flexDirection: 'row' },
  divider: { marginVertical: 12, opacity: 0.15 },
  actionButtonRow: { flexDirection: 'row', marginTop: 8 },
});