import DateTimePicker from '@react-native-community/datetimepicker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Appbar,
  Button,
  Chip,
  HelperText,
  Text,
  TextInput,
  useTheme
} from 'react-native-paper';

interface AppointmentStatus { id: number; label: string; color: string; }

const BASE_URL = 'https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws';

export default function AppointmentFormScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams();

  // 1. Determine Mode (Add vs Edit)
  const isEdit = !!params.appointment;
  const initialData = isEdit ? JSON.parse(params.appointment as string) : null;

  // 2. Form State
  const [name, setName] = useState(initialData?.doctor_name || '');
  const [desc, setDesc] = useState(initialData?.title || '');
  const [hospital, setHospital] = useState(initialData?.hospital || '');
  const [department, setDepartment] = useState(initialData?.department || '');
  const [roomNumber, setRoomNumber] = useState(initialData?.room_number || '');
  const [appointmentNumber, setAppointmentNumber] = useState(initialData?.appointment_number || '');
  const [details, setDetails] = useState(initialData?.details || '');
  const [selectedStatusId, setSelectedStatusId] = useState<number | null>(initialData?.status_id || null);
  const [date, setDate] = useState(initialData ? new Date(initialData.appointment_date) : new Date());

  // 3. Error State (Tracks which fields are invalid)
  const [errors, setErrors] = useState<Record<string, boolean>>({
    name: false,
    desc: false,
    hospital: false,
    department: false,
    status: false,
  });

  // 4. UI Logic States
  const [showPicker, setShowPicker] = useState(false);
  const [dbStatuses, setDbStatuses] = useState<AppointmentStatus[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const res = await fetch(`${BASE_URL}/appointment-statuses`);
        const data = await res.json();
        setDbStatuses(data);
        if (!isEdit) {
          const defaultStatus = data.find((s: any) => s.label === 'New');
          if (defaultStatus) setSelectedStatusId(defaultStatus.id);
        }
      } catch (e) {
        console.error("Config load error", e);
      } finally {
        setIsLoadingConfig(false);
      }
    };
    loadConfig();
  }, []);

  const handleSave = async () => {
    // Validate fields
    const newErrors = {
      name: !name.trim(),
      desc: !desc.trim(),
      hospital: !hospital.trim(),
      department: !department.trim(),
      status: !selectedStatusId,
    };

    setErrors(newErrors);

    // If any value is true, stop submission
    if (Object.values(newErrors).some(v => v)) {
      return; 
    }

    try {
      setIsSaving(true);
      const payload = {
        id: initialData?.id, 
        user_id: 1, // Hardcoded for demo
        appointment_date: date.toISOString(),
        doctor_name: name,
        title: desc,
        hospital,
        department,
        room_number: roomNumber,
        appointment_number: appointmentNumber,
        details,
        status_id: selectedStatusId
      };

      const response = await fetch(`${BASE_URL}/appointments`, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        if (Platform.OS === 'web') {
            window.alert(`Appointment ${isEdit ? 'updated' : 'saved'} successfully!`);
            router.back();
        } else {
            Alert.alert("Success", `Appointment ${isEdit ? 'updated' : 'saved'}!`, [{ text: "OK", onPress: () => router.back() }]);
        }
      } else {
        throw new Error("Server error");
      }
    } catch (error) {
      const msg = "Could not save. Please check your connection.";
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert("Error", msg);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoadingConfig) return <View style={styles.centered}><ActivityIndicator size="large" /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Appbar.Header elevated>
        <Appbar.BackAction onPress={() => router.back()} disabled={isSaving} />
        <Appbar.Content title={isEdit ? "Edit Appointment" : "New Appointment"} />
      </Appbar.Header>

      <ScrollView contentContainerStyle={styles.content}>
        
        {/* Doctor Name */}
        <TextInput 
          label="Doctor / Provider Name *" 
          value={name} 
          onChangeText={(val) => { setName(val); setErrors({...errors, name: false}); }} 
          mode="outlined" 
          error={errors.name}
          style={styles.input} 
          disabled={isSaving}
        />
        <HelperText type="error" visible={errors.name}>Doctor name is required.</HelperText>
        
        {/* Date Selector */}
        <Pressable onPress={() => !isSaving && setShowPicker(true)}>
          <View pointerEvents="none">
            <TextInput 
              label="Date *" 
              value={date.toLocaleDateString()} 
              mode="outlined" 
              style={styles.input} 
              editable={false} 
              right={<TextInput.Icon icon="calendar" />} 
            />
          </View>
        </Pressable>

        {showPicker && (
          <DateTimePicker 
            value={date} 
            mode="date" 
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={(e, d) => { setShowPicker(false); if(d) setDate(d); }} 
          />
        )}

        {/* Reason / Title */}
        <TextInput 
          label="Reason / Short Description *" 
          value={desc} 
          onChangeText={(val) => { setDesc(val); setErrors({...errors, desc: false}); }} 
          mode="outlined" 
          error={errors.desc}
          style={styles.input} 
          disabled={isSaving}
        />
        <HelperText type="error" visible={errors.desc}>Please provide a reason for the visit.</HelperText>

        <View style={styles.sectionHeader}>
            <Text variant="titleSmall" style={{ color: theme.colors.primary }}>LOCATION & LOGISTICS</Text>
        </View>

        {/* Hospital */}
        <TextInput 
          label="Hospital / Facility *" 
          value={hospital} 
          onChangeText={(val) => { setHospital(val); setErrors({...errors, hospital: false}); }} 
          mode="outlined" 
          error={errors.hospital}
          style={styles.input} 
          disabled={isSaving}
        />
        <HelperText type="error" visible={errors.hospital}>Hospital name is required.</HelperText>

        {/* Department */}
        <TextInput 
          label="Department Name *" 
          value={department} 
          onChangeText={(val) => { setDepartment(val); setErrors({...errors, department: false}); }} 
          mode="outlined" 
          error={errors.department}
          style={styles.input} 
          disabled={isSaving}
        />
        <HelperText type="error" visible={errors.department}>Department is required.</HelperText>
        
        <View style={styles.row}>
          <TextInput label="Room #" value={roomNumber} onChangeText={setRoomNumber} mode="outlined" style={[styles.input, { flex: 1, marginRight: 8 }]} disabled={isSaving} />
          <TextInput label="Appt #" value={appointmentNumber} onChangeText={setAppointmentNumber} mode="outlined" style={[styles.input, { flex: 1 }]} disabled={isSaving} />
        </View>

        <TextInput 
          label="Full Appointment Details" 
          value={details} 
          onChangeText={setDetails} 
          mode="outlined" 
          multiline 
          numberOfLines={3} 
          style={styles.input} 
          disabled={isSaving} 
        />

        {/* Status Selection */}
        <View style={styles.statusSection}>
          <Text variant="titleMedium" style={{color: errors.status ? theme.colors.error : theme.colors.onSurface}}>
            Select Status *
          </Text>
          <View style={styles.chipRow}>
            {dbStatuses.map((s) => (
              <Chip 
                key={s.id} 
                selected={selectedStatusId === s.id} 
                onPress={() => { setSelectedStatusId(s.id); setErrors({...errors, status: false}); }} 
                mode="outlined"
                style={[styles.chip, selectedStatusId === s.id && { backgroundColor: s.color + '33' }]}
                selectedColor={s.color}
                disabled={isSaving}
              >
                {s.label}
              </Chip>
            ))}
          </View>
          <HelperText type="error" visible={errors.status}>Please select a status.</HelperText>
        </View>

        <Button 
          mode="contained" 
          onPress={handleSave} 
          loading={isSaving} 
          disabled={isSaving} 
          icon="check" 
          style={styles.button}
        >
          {isEdit ? "Update Appointment" : "Save Appointment"}
        </Button>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 20, paddingBottom: 80 },
  input: { marginBottom: 0 }, // HelperText handles the margin now
  row: { flexDirection: 'row', marginTop: 8 },
  sectionHeader: { marginTop: 16, marginBottom: 12 },
  statusSection: { marginBottom: 20 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chip: { marginBottom: 4 },
  button: { borderRadius: 12, paddingVertical: 4, marginTop: 10 },
});