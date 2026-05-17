import DateTimePicker from '@react-native-community/datetimepicker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Appbar, Button, Chip, Text, TextInput, useTheme } from 'react-native-paper';

const BASE_URL = 'https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws';

export default function EditAppointmentScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams();
  
  // Parse the appointment object passed from the previous screen
  const initialData = JSON.parse(params.appointment as string);

  // Form State initialized with existing data
  const [name, setName] = useState(initialData.doctor_name);
  const [desc, setDesc] = useState(initialData.title);
  const [hospital, setHospital] = useState(initialData.hospital);
  const [department, setDepartment] = useState(initialData.department);
  const [roomNumber, setRoomNumber] = useState(initialData.room_number);
  const [appointmentNumber, setAppointmentNumber] = useState(initialData.appointment_number);
  const [details, setDetails] = useState(initialData.details);
  const [selectedStatusId, setSelectedStatusId] = useState<number>(initialData.status_id);
  
  const [date, setDate] = useState(new Date(initialData.appointment_date));
  const [showPicker, setShowPicker] = useState(false);
  const [dbStatuses, setDbStatuses] = useState<any[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetch(`${BASE_URL}/appointment-statuses`).then(res => res.json()).then(setDbStatuses);
  }, []);

  const handleUpdate = async () => {
    if (!name.trim() || !desc.trim()) return Alert.alert("Required", "Please fill mandatory fields.");

    try {
      setIsSaving(true);
      const payload = {
        id: initialData.id,
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

      const response = await fetch(`${BASE_URL}/appointments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        Alert.alert("Success", "Appointment updated!", [{ text: "OK", onPress: () => router.back() }]);
      }
    } catch (error) {
      Alert.alert("Error", "Failed to update.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Appbar.Header elevated>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title="Edit Appointment" />
      </Appbar.Header>

      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <TextInput label="Doctor Name *" value={name} onChangeText={setName} mode="outlined" style={styles.input} />
        
        <Pressable onPress={() => setShowPicker(true)}>
          <TextInput label="Date *" value={date.toLocaleDateString()} mode="outlined" style={styles.input} editable={false} pointerEvents="none" right={<TextInput.Icon icon="calendar" />} />
        </Pressable>

        {showPicker && (
          <DateTimePicker 
            value={date} 
            mode="date" 
            onChange={(e, d) => { setShowPicker(false); if(d) setDate(d); }} 
          />
        )}

        <TextInput label="Reason *" value={desc} onChangeText={setDesc} mode="outlined" style={styles.input} />
        <TextInput label="Hospital *" value={hospital} onChangeText={setHospital} mode="outlined" style={styles.input} />
        <TextInput label="Department *" value={department} onChangeText={setDepartment} mode="outlined" style={styles.input} />
        
        <View style={{ flexDirection: 'row', gap: 10 }}>
            <TextInput label="Room #" value={roomNumber} onChangeText={setRoomNumber} mode="outlined" style={[styles.input, { flex: 1 }]} />
            <TextInput label="Appt #" value={appointmentNumber} onChangeText={setAppointmentNumber} mode="outlined" style={[styles.input, { flex: 1 }]} />
        </View>

        <TextInput label="Details" value={details} onChangeText={setDetails} mode="outlined" multiline numberOfLines={3} style={styles.input} />

        <Text variant="titleMedium" style={{ marginBottom: 10 }}>Status</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 30 }}>
          {dbStatuses.map((s) => (
            <Chip 
              key={s.id} 
              selected={selectedStatusId === s.id} 
              onPress={() => setSelectedStatusId(s.id)}
              mode="outlined"
            >
              {s.label}
            </Chip>
          ))}
        </View>

        <Button mode="contained" onPress={handleUpdate} loading={isSaving} disabled={isSaving} icon="check">
          Update Appointment
        </Button>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  input: { marginBottom: 16 }
});