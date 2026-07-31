import { useLocalSearchParams, useRouter } from 'expo-router';
import { goBackOrHome } from '@/utils/navigation';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Appbar,
  Button,
  Chip,
  HelperText,
  Text,
  TextInput
} from 'react-native-paper';

import PlatformDatePicker from '../components/platform-date-picker';
import { COLORS, SHADOWS } from '../constants/theme';
import { GlobalStyles } from '../styles/globalstyles';

interface AppointmentStatus { id: number; label: string; color: string; }

import ActiveProfileBadge from '@/components/active-profile-badge';
import { useAuth } from '@/context/AuthContext';
import { apiRequest } from '@/utils/api';
import { useVoiceDictation } from '@/hooks/use-voice-dictation';


export default function AppointmentFormScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { t } = useTranslation();
  const { activeDependent } = useAuth();
  const { activeField: dictatingField, start: startDictation, stop: stopDictation } = useVoiceDictation();

  const isEdit = !!params.appointment;
  const initialData = isEdit ? JSON.parse(params.appointment as string) : null;

  const [name, setName] = useState(initialData?.doctor_name || '');
  const [desc, setDesc] = useState(initialData?.title || '');
  const [hospital, setHospital] = useState(initialData?.hospital || '');
  const [department, setDepartment] = useState(initialData?.department || '');
  const [roomNumber, setRoomNumber] = useState(initialData?.room_number || '');
  const [appointmentNumber, setAppointmentNumber] = useState(initialData?.appointment_number || '');
  const [details, setDetails] = useState(initialData?.details || '');
  const [selectedStatusId, setSelectedStatusId] = useState<number | null>(initialData?.status_id || null);
  const [date, setDate] = useState(initialData ? new Date(initialData.appointment_date) : new Date());

  const [errors, setErrors] = useState<Record<string, boolean>>({
    name: false, desc: false, hospital: false, department: false, status: false,
  });

  const [showPicker, setShowPicker] = useState(false);
  const [dbStatuses, setDbStatuses] = useState<AppointmentStatus[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);
  const [configError, setConfigError] = useState(false);

  const notifyUser = (title: string, message: string) => {
    if (Platform.OS === 'web') window.alert(`${title}: ${message}`);
    else Alert.alert(title, message);
  };

  // try/finally with no catch: the screen rendered, but dbStatuses stayed
  // empty and selectedStatusId stayed null, so handleSave's own validation
  // then blocked on `status` and refused to save with no explanation at all.
  const loadConfig = async () => {
    setIsLoadingConfig(true);
    setConfigError(false);
    try {
      const res = await apiRequest(`/appointment-statuses`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) throw new Error('No appointment statuses returned');
      setDbStatuses(data);
      if (!isEdit) {
        const defaultStatus = data.find((s: any) => s.label === 'New');
        if (defaultStatus) setSelectedStatusId(defaultStatus.id);
      }
    } catch (e) {
      console.error('Appointment status config load failed:', e);
      setConfigError(true);
    } finally {
      setIsLoadingConfig(false);
    }
  };

  useEffect(() => { loadConfig(); }, []);

  const handleSave = async () => {
    const newErrors = {
      name: !name.trim(),
      desc: !desc.trim(),
      hospital: !hospital.trim(),
      department: !department.trim(),
      status: !selectedStatusId,
    };
    setErrors(newErrors);
    if (Object.values(newErrors).some(v => v)) return; 

    try {
      setIsSaving(true);
      const payload = {
        id: initialData?.id,
        appointment_date: date.toISOString(),
        doctor_name: name, title: desc, hospital, department,
        room_number: roomNumber, appointment_number: appointmentNumber,
        details, status_id: selectedStatusId
      };

      const response = await apiRequest(`/appointments`, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      }, activeDependent?.id);

      if (response.ok) {
        if (Platform.OS === 'web') window.alert(t('appointmentForm.successAlert'));
        goBackOrHome(router);
      } else {
        const detail = await response.json().catch(() => ({}));
        notifyUser(t('common.error'), detail.error || t('appointmentForm.saveFailed'));
      }
    } catch (e) {
      console.error('Appointment save failed:', e);
      notifyUser(t('common.error'), t('appointmentForm.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDescChange = (val: string) => { setDesc(val); setErrors({ ...errors, desc: false }); };

  const micIcon = (fieldKey: string, value: string, onChangeText: (val: string) => void) => (
    <TextInput.Icon
      icon={dictatingField === fieldKey ? "microphone" : "microphone-outline"}
      color={dictatingField === fieldKey ? COLORS.primary : undefined}
      disabled={isSaving}
      onPress={() => dictatingField === fieldKey ? stopDictation() : startDictation(fieldKey, value, onChangeText)}
    />
  );

  if (isLoadingConfig) return <View style={GlobalStyles.centered}><ActivityIndicator color={COLORS.primary} /></View>;

  if (configError) {
    return (
      <View style={GlobalStyles.centered}>
        <Text style={styles.errorTitle}>{t('appointmentForm.configLoadFailed')}</Text>
        <Text style={styles.errorBody}>{t('appointmentForm.configLoadFailedHint')}</Text>
        <Button mode="contained" onPress={loadConfig} icon="refresh" style={{ marginTop: 16 }}>
          {t('common.retry')}
        </Button>
        <Button mode="text" onPress={() => goBackOrHome(router)} textColor={COLORS.slate}>
          {t('common.cancel')}
        </Button>
      </View>
    );
  }

  return (
    <View style={GlobalStyles.container}>
      <Appbar.Header style={{ backgroundColor: COLORS.background }}>
        <Appbar.BackAction onPress={() => goBackOrHome(router)} />
        <Appbar.Content title={isEdit ? t('appointmentForm.editTitle') : t('appointmentForm.newTitle')} titleStyle={styles.headerTitle} />
        <ActiveProfileBadge />
      </Appbar.Header>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        
        {/* Each Field is now wrapped in a Container for uniform spacing */}
        <View style={styles.fieldContainer}>
            <TextInput
                label={t('appointmentForm.doctorLabel')}
                value={name}
                onChangeText={(val) => { setName(val); setErrors({...errors, name: false}); }}
                mode="outlined"
                error={errors.name}
                style={styles.input}
                disabled={isSaving}
            />
            <HelperText type="error" visible={errors.name} style={styles.helper}>{t('common.required')}</HelperText>
        </View>

        <View style={styles.fieldContainer}>
            <Pressable onPress={() => !isSaving && setShowPicker(true)}>
                <View pointerEvents="none">
                    <TextInput
                        label={t('appointmentForm.dateLabel')}
                        value={date.toLocaleDateString()}
                        mode="outlined" 
                        style={styles.input} 
                        editable={false} 
                        right={<TextInput.Icon icon="calendar" color={COLORS.primary} />} 
                    />
                </View>
            </Pressable>
            <HelperText type="info" visible={false} style={styles.helper}>{null}</HelperText>
        </View>

        <PlatformDatePicker
          visible={showPicker}
          value={date}
          mode="date"
          onConfirm={d => { setDate(d); setShowPicker(false); }}
          onDismiss={() => setShowPicker(false)}
        />

        <View style={styles.fieldContainer}>
            <TextInput
                label={t('appointmentForm.reasonLabel')}
                value={desc}
                onChangeText={handleDescChange}
                mode="outlined"
                error={errors.desc}
                style={styles.input}
                disabled={isSaving}
                right={micIcon('desc', desc, handleDescChange)}
            />
            <HelperText type="error" visible={errors.desc} style={styles.helper}>{t('common.required')}</HelperText>
        </View>

        <View style={styles.sectionHeader}>
            <Text style={styles.sectionHeaderText}>{t('appointmentForm.locationSection')}</Text>
        </View>

        <View style={styles.fieldContainer}>
            <TextInput
                label={t('appointmentForm.hospitalLabel')}
                value={hospital}
                onChangeText={(val) => { setHospital(val); setErrors({...errors, hospital: false}); }}
                mode="outlined"
                error={errors.hospital}
                style={styles.input}
                disabled={isSaving}
            />
            <HelperText type="error" visible={errors.hospital} style={styles.helper}>{t('common.required')}</HelperText>
        </View>

        <View style={styles.fieldContainer}>
            <TextInput
                label={t('appointmentForm.departmentLabel')}
                value={department}
                onChangeText={(val) => { setDepartment(val); setErrors({...errors, department: false}); }}
                mode="outlined"
                error={errors.department}
                style={styles.input}
                disabled={isSaving}
            />
            <HelperText type="error" visible={errors.department} style={styles.helper}>{t('common.required')}</HelperText>
        </View>

        {/* Row needs to be handled carefully to keep height same as single fields */}
        <View style={[styles.row, { marginBottom: 12 }]}>
          <TextInput label={t('appointmentForm.roomLabel')} value={roomNumber} onChangeText={setRoomNumber} mode="outlined" style={[styles.input, { flex: 1, marginRight: 10 }]} disabled={isSaving} />
          <TextInput label={t('appointmentForm.apptNumberLabel')} value={appointmentNumber} onChangeText={setAppointmentNumber} mode="outlined" style={[styles.input, { flex: 1 }]} disabled={isSaving} />
        </View>

        <View style={styles.fieldContainer}>
            <TextInput
                label={t('appointmentForm.detailsLabel')}
                value={details}
                onChangeText={setDetails}
                mode="outlined"
                multiline
                numberOfLines={3}
                style={styles.input}
                disabled={isSaving}
                right={micIcon('details', details, setDetails)}
            />
            <HelperText type="info" visible={false} style={styles.helper}>{null}</HelperText>
        </View>

        <View style={styles.statusSection}>
          <Text style={[styles.statusLabel, errors.status && { color: COLORS.error }]}>{t('appointmentForm.selectStatus')}</Text>
          <View style={styles.chipRow}>
            {dbStatuses.map((s) => (
              <Chip 
                key={s.id} 
                selected={selectedStatusId === s.id} 
                onPress={() => { setSelectedStatusId(s.id); setErrors({...errors, status: false}); }} 
                style={[styles.chip, selectedStatusId === s.id && { backgroundColor: COLORS.ink }]}
                textStyle={{ color: selectedStatusId === s.id ? 'white' : COLORS.slate }}
                showSelectedCheck={false}
              >
                {s.label}
              </Chip>
            ))}
          </View>
        </View>

        <Button 
          mode="contained" 
          onPress={handleSave} 
          loading={isSaving} 
          style={styles.saveButton}
          buttonColor={COLORS.primary}
        >
          {isEdit ? t('appointmentForm.updateButton') : t('appointmentForm.saveButton')}
        </Button>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  headerTitle: { fontWeight: '800', fontSize: 18 },
  scrollContent: { padding: 24, paddingBottom: 60 },
  errorTitle: { fontSize: 18, fontWeight: '800', color: COLORS.ink, textAlign: 'center', paddingHorizontal: 24 },
  errorBody: { fontSize: 14, color: COLORS.slate, textAlign: 'center', marginTop: 8, paddingHorizontal: 32, lineHeight: 20 },
  
  // FIXED SPACING LOGIC
  fieldContainer: {
    marginBottom: 4, // Tight gap between fields
  },
  input: {
    backgroundColor: 'white',
  },
  helper: {
    height: 20, // Forces space even when hidden, ensuring consistent alignment
    marginTop: -2,
    paddingLeft: 0,
  },

  row: { flexDirection: 'row', alignItems: 'center' },
  sectionHeader: { marginTop: 12, marginBottom: 16, borderLeftWidth: 4, borderLeftColor: COLORS.primary, paddingLeft: 12 },
  sectionHeaderText: { fontSize: 12, fontWeight: '800', color: COLORS.primary, letterSpacing: 1 },
  
  statusSection: { marginBottom: 30 },
  statusLabel: { fontSize: 16, fontWeight: '800', marginBottom: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 12 },
  
  saveButton: { borderRadius: 16, height: 56, justifyContent: 'center', ...SHADOWS.medium },
});