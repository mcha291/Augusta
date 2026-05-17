import DateTimePicker from '@react-native-community/datetimepicker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Appbar, Button, Divider, Text, TextInput, useTheme } from 'react-native-paper';

const BASE_URL = 'https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws';

export default function ResultsFormScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams();

  // 1. Determine Mode
  const isEdit = !!params.result;
  const initialData = isEdit ? JSON.parse(params.result as string) : null;

  const [configs, setConfigs] = useState<any[]>([]);
  const [formValues, setFormValues] = useState<any>(initialData || {});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [date, setDate] = useState(new Date(initialData?.test_date || new Date()));
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    fetch(`${BASE_URL}/test-config`).then(res => res.json()).then(data => {
      setConfigs(data);
      setLoading(false);
    });
  }, []);

  const handleSave = async () => {
    try {
      setSaving(true);
      const payload = { 
        id: initialData?.id,
        user_id: 1, 
        test_date: date.toISOString(),
        ...formValues 
      };

      // Clean payload: ensure values are numbers
      configs.forEach(cfg => {
          const key = `field_${cfg.field_number}`;
          if (payload[key] !== undefined && payload[key] !== "") {
              payload[key] = parseFloat(payload[key]);
          }
      });

      const res = await fetch(`${BASE_URL}/test-results`, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        if (Platform.OS === 'web') window.alert(`Results ${isEdit ? 'updated' : 'saved'}.`);
        router.back();
      }
    } catch (e) {
      Alert.alert("Error", "Action failed.");
    } finally { setSaving(false); }
  };

  if (loading) return <View style={styles.centered}><ActivityIndicator size="large" /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Appbar.Header elevated>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={isEdit ? "Edit Lab Results" : "New Lab Results"} />
      </Appbar.Header>

      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <Text variant="titleMedium" style={styles.label}>Test Date</Text>
        {Platform.OS === 'web' ? (
          <input type="date" value={date.toISOString().split('T')[0]} onChange={(e) => setDate(new Date(e.target.value))} style={webStyle} />
        ) : (
          <Pressable onPress={() => setShowPicker(true)}>
            <TextInput label="Date" value={date.toLocaleDateString()} mode="outlined" editable={false} pointerEvents="none" right={<TextInput.Icon icon="calendar" />} />
          </Pressable>
        )}

        {showPicker && <DateTimePicker value={date} mode="date" display="spinner" onChange={(e, d) => { setShowPicker(false); if(d) setDate(d); }} />}

        <Divider style={{ marginVertical: 20 }} />
        <Text variant="titleMedium" style={styles.label}>Numeric Values</Text>
        {configs.map((cfg) => (
          <TextInput
            key={cfg.field_number}
            label={`${cfg.display_name} (${cfg.units})`}
            value={formValues[`field_${cfg.field_number}`]?.toString() || ''}
            mode="outlined"
            keyboardType="numeric"
            style={{ marginBottom: 12 }}
            onChangeText={(val) => setFormValues({ ...formValues, [`field_${cfg.field_number}`]: val })}
          />
        ))}

        <Button mode="contained" onPress={handleSave} loading={saving} disabled={saving} icon="check" style={{ marginTop: 20 }}>
          {isEdit ? "Update Report" : "Save Report"}
        </Button>
      </ScrollView>
    </View>
  );
}

const webStyle = { padding: '12px', borderRadius: '4px', border: '1px solid #79747E', width: '100%', marginBottom: 20 };
const styles = StyleSheet.create({ centered: { flex: 1, justifyContent: 'center' }, label: { marginBottom: 10, fontWeight: 'bold', opacity: 0.7 } });