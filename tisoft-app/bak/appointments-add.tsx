import { apiRequest } from '@/utils/api';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Appbar, Button, Chip, Text, TextInput, useTheme } from 'react-native-paper';

interface AppointmentStatus {
  id: number;
  label: string;
  color: string;
}



export default function AddAppointmentScreen() {
  const theme = useTheme();
  const router = useRouter();

  // Form State
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [hospital, setHospital] = useState('');
  const [department, setDepartment] = useState('');
  const [roomNumber, setRoomNumber] = useState('');
  const [appointmentNumber, setAppointmentNumber] = useState('');
  const [details, setDetails] = useState('');
  
  // Status State
  const [dbStatuses, setDbStatuses] = useState<AppointmentStatus[]>([]);
  const [selectedStatusId, setSelectedStatusId] = useState<number | null>(null);

  // Date State
  const [date, setDate] = useState(new Date());
  const [showPicker, setShowPicker] = useState(false);
  const [dateString, setDateString] = useState(new Date().toLocaleDateString());
  
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const res = await apiRequest(`/appointment-statuses`);
        const data: AppointmentStatus[] = await res.json();
        setDbStatuses(data);
        const defaultStatus = data.find(s => s.label === 'New');
        if (defaultStatus) setSelectedStatusId(defaultStatus.id);
      } catch (e) {
        console.error("Failed to load statuses", e);
      } finally {
        setIsLoadingConfig(false);
      }
    };
    loadConfig();
  }, []);

  const onDateChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS === 'android') setShowPicker(false);
    if (selectedDate) {
      setDate(selectedDate);
      setDateString(selectedDate.toLocaleDateString());
    }
  };

  const handleSave = async () => {
    // UPDATED VALIDATION: Check all mandatory fields
    const missingFields = [];
    if (!name.trim()) missingFields.push("Doctor Name");
    if (!dateString) missingFields.push("Date");
    if (!desc.trim()) missingFields.push("Reason");
    if (!hospital.trim()) missingFields.push("Hospital");
    if (!department.trim()) missingFields.push("Department");
    if (!selectedStatusId) missingFields.push("Status");

    if (missingFields.length > 0) {
      Alert.alert(
        "Missing Information", 
        `Please fill in the following mandatory fields:\n• ${missingFields.join('\n• ')}`
      );
      return;
    }

    try {
      setIsSaving(true);
      const payload = {
        user_id: 1, 
        appointment_date: date.toISOString(),
        doctor_name: name,
        title: desc,
        hospital: hospital,
        department: department,
        room_number: roomNumber,
        appointment_number: appointmentNumber,
        details: details,
        status_id: selectedStatusId
      };

      const response = await apiRequest(`/appointments`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        Alert.alert("Success", "Appointment saved!", [{ text: "OK", onPress: () => router.back() }]);
      } else {
        throw new Error("Failed to save");
      }
    } catch (error: any) {
      Alert.alert("Save Error", error.message);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoadingConfig) {
    return <View style={styles.centered}><ActivityIndicator size="large" /></View>;
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Appbar.Header elevated>
        <Appbar.BackAction onPress={() => router.back()} disabled={isSaving} />
        <Appbar.Content title="New Appointment" />
      </Appbar.Header>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Mandatory: Doctor Name */}
        <TextInput 
            label="Doctor / Provider Name *" 
            value={name} 
            onChangeText={setName} 
            mode="outlined" 
            style={styles.input} 
            disabled={isSaving} 
        />
        
        {/* Mandatory: Date */}
        <Pressable onPress={() => setShowPicker(true)} disabled={isSaving}>
          <TextInput 
            label="Date *" 
            value={dateString} 
            mode="outlined" 
            style={styles.input} 
            editable={false} 
            pointerEvents="none" 
            right={<TextInput.Icon icon="calendar" />} 
          />
        </Pressable>

        {showPicker && <DateTimePicker value={date} mode="date" display="default" onChange={onDateChange} />}

        {/* Mandatory: Reason */}
        <TextInput 
            label="Reason / Short Description *" 
            value={desc} 
            onChangeText={setDesc} 
            mode="outlined" 
            style={styles.input} 
            disabled={isSaving} 
        />

        <View style={styles.sectionHeader}>
          <Text variant="titleSmall" style={{ color: theme.colors.primary }}>LOCATION & LOGISTICS</Text>
        </View>
        
        {/* Mandatory: Hospital */}
        <TextInput 
            label="Hospital / Facility *" 
            value={hospital} 
            onChangeText={setHospital} 
            mode="outlined" 
            style={styles.input} 
            disabled={isSaving} 
        />
        
        {/* Mandatory: Department */}
        <TextInput 
            label="Department Name *" 
            value={department} 
            onChangeText={setDepartment} 
            mode="outlined" 
            style={styles.input} 
            disabled={isSaving} 
        />
        
        <View style={styles.row}>
          <TextInput label="Room #" value={roomNumber} onChangeText={setRoomNumber} mode="outlined" style={[styles.input, { flex: 1, marginRight: 8 }]} disabled={isSaving} />
          <TextInput label="Appt #" value={appointmentNumber} onChangeText={setAppointmentNumber} mode="outlined" style={[styles.input, { flex: 1 }]} disabled={isSaving} />
        </View>

        <TextInput label="Details" value={details} onChangeText={setDetails} mode="outlined" multiline numberOfLines={3} style={styles.input} disabled={isSaving} />

        <View style={styles.statusSection}>
          <Text variant="titleMedium" style={styles.label}>Select Status *</Text>
          <View style={styles.chipRow}>
            {dbStatuses.map((status) => (
              <Chip 
                key={status.id} 
                selected={selectedStatusId === status.id} 
                onPress={() => setSelectedStatusId(status.id)} 
                style={[styles.chip, selectedStatusId === status.id && { backgroundColor: status.color + '33' }]} 
                selectedColor={status.color}
                mode="outlined"
                disabled={isSaving}
              >
                {status.label}
              </Chip>
            ))}
          </View>
        </View>

        <Button mode="contained" onPress={handleSave} style={styles.button} loading={isSaving} disabled={isSaving} icon="check">
          Save Appointment
        </Button>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 20, paddingBottom: 60 },
  input: { marginBottom: 16 },
  row: { flexDirection: 'row' },
  sectionHeader: { marginTop: 8, marginBottom: 12 },
  statusSection: { marginBottom: 30 },
  label: { marginBottom: 12, fontWeight: '600' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { marginBottom: 4 },
  button: { borderRadius: 12, paddingVertical: 4 },
});