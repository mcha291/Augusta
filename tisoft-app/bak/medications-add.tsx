import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { Appbar, Button, Chip, Text, TextInput, useTheme } from 'react-native-paper';

// Your Lambda URL for medications
const API_URL = 'https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws/medications';

export default function AddMedicationScreen() {
  const theme = useTheme();
  const router = useRouter();

  // Form State
  const [name, setName] = useState('');
  const [instruction, setInstruction] = useState(''); // Maps to 'dosage'
  const [note, setNote] = useState('');               // Maps to 'frequency'
  const [status, setStatus] = useState('Current');     // Maps to 'active'/'inactive'
  
  // UI State
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    // Basic Validation
    if (!name || !instruction) {
      Alert.alert("Missing Info", "Please provide a Medication Name and Dosage instructions.");
      return;
    }

    try {
      setIsSaving(true);

      const payload = {
        user_id: 1, // Defaulting to 1 (Twilight) for development
        name: name,
        dosage: instruction,
        frequency: note,
        // Match the string values used in your seed data ('active' or 'inactive')
        status: status === 'Current' ? 'active' : 'inactive'
      };

      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        Alert.alert("Success", "Medication added successfully!", [
          { text: "OK", onPress: () => router.back() }
        ]);
      } else {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to save to database");
      }
    } catch (error: any) {
      Alert.alert("Error", error.message || "An unexpected error occurred.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Appbar.Header elevated>
        <Appbar.BackAction onPress={() => router.back()} disabled={isSaving} />
        <Appbar.Content title="New Medication" />
      </Appbar.Header>

      <ScrollView contentContainerStyle={styles.content}>
        <TextInput
          label="Medication Name"
          value={name}
          onChangeText={setName}
          mode="outlined"
          style={styles.input}
          placeholder="e.g. High-Grade Peanuts"
          disabled={isSaving}
        />

        <TextInput
          label="Dosage / Instruction"
          value={instruction}
          onChangeText={setInstruction}
          mode="outlined"
          style={styles.input}
          placeholder="e.g. Take 1 mouthful after breakfast"
          disabled={isSaving}
        />

        <TextInput
          label="Notes / Frequency"
          value={note}
          onChangeText={setNote}
          mode="outlined"
          multiline
          numberOfLines={3}
          style={styles.input}
          placeholder="e.g. Every 4 hours"
          disabled={isSaving}
        />

        <View style={styles.statusSection}>
          <Text variant="titleMedium" style={styles.label}>Status</Text>
          <View style={styles.chipRow}>
            {['Current', 'Inactive'].map((option) => (
              <Chip
                key={option}
                selected={status === option}
                onPress={() => setStatus(option)}
                style={styles.chip}
                mode="outlined"
                showSelectedCheck
                disabled={isSaving}
              >
                {option}
              </Chip>
            ))}
          </View>
        </View>

        <Button 
          mode="contained" 
          onPress={handleSave} 
          style={styles.button}
          icon="plus"
          loading={isSaving}
          disabled={isSaving}
        >
          {isSaving ? "Adding..." : "Add Medication"}
        </Button>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20 },
  input: { marginBottom: 20 },
  statusSection: { marginBottom: 30 },
  label: { marginBottom: 12, fontWeight: '600' },
  chipRow: { flexDirection: 'row', gap: 8 },
  chip: { borderRadius: 8 },
  button: { borderRadius: 12, paddingVertical: 4 },
});