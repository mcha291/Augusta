import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View
} from 'react-native';
import {
  Button,
  Chip,
  Divider,
  IconButton,
  Surface,
  Text
} from 'react-native-paper';

// Import your new professional styling system
import { useAuth } from '@/context/AuthContext';
import { apiRequest } from '@/utils/api';
import { COLORS, RADIUS, SHADOWS } from '../../constants/theme';
import { GlobalStyles } from '../../styles/globalstyles';


export default function AppointmentsScreen() {
  const router = useRouter();

  const [appointments, setAppointments] = useState<any[]>([]);
  const { user, activeDependent } = useAuth();
  const [dbStatuses, setDbStatuses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [filter, setFilter] = useState('Upcoming');

  const loadData = async () => {
    try {
      if (appointments.length === 0) setLoading(true);
      const [apptRes, statusRes] = await Promise.all([
        apiRequest(`/appointments`, {}, activeDependent?.id),
        apiRequest(`/appointment-statuses`, {}, activeDependent?.id)
      ]);

      setAppointments(await apptRes.json());
      setDbStatuses(await statusRes.json());
    } catch (error) {
      console.error("Failed to fetch appointments:", error);
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

  if (loading && !refreshing) {
    return (
      <View style={GlobalStyles.centered}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  return (
    <View style={GlobalStyles.container}>
      {/* 1. PROFESSIONAL HEADER */}
      <View style={GlobalStyles.header}>
        <IconButton
          icon="account-circle-outline"
          iconColor={COLORS.primary}
          size={28}
          onPress={() => router.push('/profile')}
        />
        <IconButton
          icon="plus-circle-outline"
          iconColor={COLORS.ink}
          size={28}
          onPress={() => router.push('/appointment-form')}
        />
      </View>

      <ScrollView
        contentContainerStyle={GlobalStyles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.pageTitle}>Appointments</Text>

        {/* 2. WRAPPING CHIPS (Themed) */}
        <View style={styles.filterContainer}>
          {getUiFilters().map((f) => (
            <Chip
              key={f}
              selected={filter === f}
              onPress={() => setFilter(f)}
              style={[
                styles.filterChip,
                filter === f ? { backgroundColor: COLORS.ink } : { backgroundColor: COLORS.surface }
              ]}
              textStyle={[
                styles.filterText,
                filter === f ? { color: 'white' } : { color: COLORS.slate }
              ]}
              showSelectedCheck={false}
            >
              {f}
            </Chip>
          ))}
        </View>

        {/* 3. LIST OF APPOINTMENTS */}
        <View style={styles.listContainer}>
          {filteredData.length === 0 ? (
            <View style={styles.emptyState}>
              <MaterialCommunityIcons name="calendar-blank" size={48} color={COLORS.secondary} />
              <Text style={styles.emptyText}>No appointments found in {filter}</Text>
            </View>
          ) : (
            filteredData.map((item) => {
              const isExpanded = expandedId === item.id;
              const dateObj = new Date(item.appointment_date);

              return (
                <Surface key={item.id} style={styles.appointmentCard} elevation={0}>
                  <View style={styles.cardHeader}>
                    {/* Date Indicator Box */}
                    <View style={styles.dateBox}>
                      <Text style={styles.dateDay}>{dateObj.getDate()}</Text>
                      <Text style={styles.dateMonth}>
                        {dateObj.toLocaleString('default', { month: 'short' }).toUpperCase()}
                      </Text>
                    </View>

                    {/* Main Info */}
                    <View style={styles.mainInfo}>
                      <Text style={styles.doctorName} numberOfLines={1}>{item.doctor_name}</Text>
                      <Text style={styles.hospitalName} numberOfLines={1}>{item.hospital}</Text>
                      <View style={[styles.statusBadge, { backgroundColor: item.status_color + '15' }]}>
                        <Text style={[styles.statusBadgeText, { color: item.status_color }]}>
                          {item.status_label.toUpperCase()}
                        </Text>
                      </View>
                    </View>

                    {/* Action Group */}
                    <View style={styles.actionGroup}>
                      <IconButton
                        icon="pencil-outline"
                        size={18}
                        onPress={() => router.push({ pathname: '/appointment-form', params: { appointment: JSON.stringify(item) } })}
                      />
                      <IconButton
                        icon={isExpanded ? "chevron-up" : "chevron-down"}
                        size={22}
                        onPress={() => setExpandedId(isExpanded ? null : item.id)}
                      />
                    </View>
                  </View>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <View style={styles.detailsContainer}>
                      <View style={{ marginTop: 16 }}>
                        <Text style={GlobalStyles.labelMini}>Purpose</Text>
                        <Text style={styles.detailValue}>{item.title || 'Not specified.'}</Text>
                      </View>
                      <Divider style={styles.divider} />
                      <View style={styles.detailRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={GlobalStyles.labelMini}>Department</Text>
                          <Text style={styles.detailValue}>{item.department}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={GlobalStyles.labelMini}>Room</Text>
                          <Text style={styles.detailValue}>{item.room_number || 'N/A'}</Text>
                        </View>
                      </View>

                      <View style={{ marginTop: 16 }}>
                        <Text style={GlobalStyles.labelMini}>Notes</Text>
                        <Text style={styles.notesText}>{item.details || 'No additional details provided.'}</Text>
                      </View>

                      <Button
                        mode="contained"
                        buttonColor={COLORS.background}
                        textColor={COLORS.ink}
                        onPress={() => router.push({ pathname: '/appointment-form', params: { appointment: JSON.stringify(item) } })}
                        style={styles.editFullBtn}
                        labelStyle={{ fontWeight: 'bold', fontSize: 12 }}
                      >
                        Update Appointment
                      </Button>
                    </View>
                  )}
                </Surface>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  pageTitle: { fontSize: 28, fontWeight: '800', color: COLORS.ink, marginBottom: 20 },

  // Filter System
  filterContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 24 },
  filterChip: { borderRadius: 12, height: 36, ...SHADOWS.soft },
  filterText: { fontSize: 13, fontWeight: '600' },

  // Card Styling
  listContainer: { gap: 12 },
  appointmentCard: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: 12,
    ...SHADOWS.soft
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },

  // Date Box
  dateBox: {
    width: 50,
    height: 52,
    backgroundColor: COLORS.background,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center'
  },
  dateDay: { fontSize: 18, fontWeight: '800', color: COLORS.ink },
  dateMonth: { fontSize: 9, fontWeight: '700', color: COLORS.secondary },

  // Info
  mainInfo: { flex: 1, marginLeft: 16 },
  doctorName: { fontSize: 16, fontWeight: '700', color: COLORS.ink },
  hospitalName: { fontSize: 13, color: COLORS.slate, marginBottom: 4 },
  statusBadge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  statusBadgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },

  // Actions
  actionGroup: { flexDirection: 'row', alignItems: 'center' },

  // Expanded
  detailsContainer: { marginTop: 4 },
  divider: { marginVertical: 12, backgroundColor: COLORS.background },
  detailRow: { flexDirection: 'row' },
  detailValue: { fontSize: 14, fontWeight: '600', color: COLORS.ink },
  notesText: { fontSize: 14, color: COLORS.slate, lineHeight: 20 },
  editFullBtn: { marginTop: 20, borderRadius: 12 },

  // Empty States
  emptyState: { alignItems: 'center', marginTop: 60, opacity: 0.5 },
  emptyText: { marginTop: 12, fontSize: 14, fontWeight: '600', color: COLORS.slate }
});