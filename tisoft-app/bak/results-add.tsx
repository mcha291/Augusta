import DateTimePicker from '@react-native-community/datetimepicker';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Appbar, Button, Text, TextInput, useTheme } from 'react-native-paper';



export default function AddResultScreen() {
  const theme = useTheme();
  const router = useRouter();
  
  const [configs, setConfigs] = useState<any[]>([]);
  const [formValues, setFormValues] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // --- Date State ---
  const [date, setDate] = useState(new Date());
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    fetch(`${BASE_URL}/test-config`)
      .then(res => res.json())
      .then(data => {
        setConfigs(data);
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    try {
      setSaving(true);
      
      // Convert inputs to numbers
      const formattedValues = { ...formValues };
      Object.keys(formattedValues).forEach(key => {
        if (formattedValues[key] !== "") {
          formattedValues[key] = parseFloat(formattedValues[key]);
        }
      });

      const payload = { 
        user_id: 1, 
        test_date: date.toISOString(), // Include the selected date
        ...formattedValues 
      };

      const res = await fetch(`${BASE_URL}/test-results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        if (Platform.OS === 'web') window.alert("Lab results recorded.");
        router.replace('/results');
      }
    } catch (e) {
      Alert.alert("Error", "Failed to save results.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <ActivityIndicator style={{ flex: 1 }} />;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Appbar.Header elevated>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title="Enter Test Results" />
      </Appbar.Header>

      <ScrollView contentContainerStyle={{ padding: 20 }}>
        
        {/* --- DATE SELECTION SECTION --- */}
        <Text variant="titleMedium" style={styles.label}>Test Date</Text>
        {Platform.OS === 'web' ? (
          <input
            type="date"
            value={date.toISOString().split('T')[0]}
            onChange={(e) => setDate(new Date(e.target.value))}
            style={webInputStyle}
          />
        ) : (
          <Pressable onPress={() => setShowPicker(true)}>
            <TextInput
              label="Date of Test"
              value={date.toLocaleDateString()}
              mode="outlined"
              editable={false}
              pointerEvents="none"
              style={styles.input}
              right={<TextInput.Icon icon="calendar" />}
            />
          </Pressable>
        )}

        {showPicker && Platform.OS !== 'web' && (
          <View style={styles.pickerBox}>
             <DateTimePicker
                value={date}
                mode="date"
                display="spinner"
                onChange={(e, d) => {
                    if (Platform.OS === 'android') setShowPicker(false);
                    if (d) setDate(d);
                }}
             />
             {Platform.OS === 'ios' && <Button onPress={() => setShowPicker(false)}>Done</Button>}
          </View>
        )}

        <Divider style={{ marginVertical: 20 }} />

        {/* --- DYNAMIC FIELDS --- */}
        <Text variant="titleMedium" style={styles.label}>Numeric Results</Text>
        {configs.map((cfg) => (
          <TextInput
            key={cfg.field_number}
            label={`${cfg.display_name} (${cfg.units})`}
            mode="outlined"
            keyboardType="numeric"
            style={styles.input}
            onChangeText={(val) => setFormValues({ ...formValues, [`field_${cfg.field_number}`]: val })}
          />
        ))}

        <Button 
          mode="contained" 
          onPress={handleSave} 
          loading={saving} 
          disabled={saving}
          style={styles.saveBtn}
          icon="check"
        >
          Save Lab Report
        </Button>
      </ScrollView>
    </View>
  );
}

const webInputStyle = {
    padding: '12px',
    borderRadius: '4px',
    border: '1px solid #79747E',
    backgroundColor: 'transparent',
    width: '100%',
    marginBottom: 20,
    fontSize: '16px'
};

const styles = StyleSheet.create({
  label: { marginBottom: 10, fontWeight: 'bold', opacity: 0.7 },
  input: { marginBottom: 12 },
  saveBtn: { marginTop: 20, borderRadius: 8, paddingVertical: 4 },
  pickerBox: { backgroundColor: 'white', borderRadius: 12, padding: 10, marginBottom: 20, borderWidth: 1, borderColor: '#ddd' }
});

const Divider = ({ style }: { style?: any }) => <View style={[{ height: 1, backgroundColor: '#e0e0e0' }, style]} />;