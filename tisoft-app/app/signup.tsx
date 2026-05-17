import DateTimePicker from '@react-native-community/datetimepicker';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Chip, Text, TextInput, useTheme } from 'react-native-paper';

// Helper for Web formatting
const formatDateForWeb = (date: Date) => date.toISOString().split('T')[0];

export default function SignupScreen() {
  const theme = useTheme();
  const router = useRouter();

  const [form, setForm] = useState({
    username: '',
    email: '',
    password: '',
    role: 'civilian',
    full_name: '',
    phone_number: '', // Add this
    gender: '',
    blood_type: '',
    birth_date: new Date().toISOString()
  });

  const [loading, setLoading] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);

  const handleSignup = async () => {
    if (!form.username || !form.email || !form.password || !form.full_name) {
      const msg = "Please fill in all mandatory fields.";
      Platform.OS === 'web' ? window.alert(msg) : Alert.alert("Error", msg);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });

      if (res.ok) {
        if (Platform.OS === 'web') window.alert("Account created! Please login.");
        router.replace('/login');
      } else {
        const data = await res.json();
        throw new Error(data.error || "Signup failed");
      }
    } catch (e: any) {
      Platform.OS === 'web' ? window.alert(e.message) : Alert.alert("Error", e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="headlineLarge" style={styles.title}>Join Operation Strix</Text>

      <TextInput
        label="Full Name *"
        mode="outlined"
        style={styles.input}
        onChangeText={v => setForm({ ...form, full_name: v })}
      />

      {/* New Optional Phone Field */}
      <TextInput
        label="Phone Number"
        placeholder="e.g. +61 412 345 678"
        mode="outlined"
        keyboardType="phone-pad"
        style={styles.input}
        onChangeText={v => setForm({ ...form, phone_number: v })}
      />

      <TextInput label="Codename (Username) *" mode="outlined" style={styles.input} onChangeText={v => setForm({ ...form, username: v })} />

      <TextInput
        label="Codename (Username) *"
        mode="outlined"
        style={styles.input}
        onChangeText={v => setForm({ ...form, username: v })}
      />

      {/* --- BIRTH DATE SELECTOR --- */}
      <Text variant="labelMedium" style={styles.dateLabel}>BIRTH DATE</Text>
      {Platform.OS === 'web' ? (
        <input
          type="date"
          value={formatDateForWeb(new Date(form.birth_date))}
          onChange={(e) => setForm({ ...form, birth_date: new Date(e.target.value).toISOString() })}
          style={webInputStyle}
        />
      ) : (
        <Pressable onPress={() => setShowDatePicker(true)}>
          <TextInput
            label="Select Birthday"
            value={new Date(form.birth_date).toLocaleDateString()}
            mode="outlined"
            style={styles.input}
            editable={false}
            pointerEvents="none"
            right={<TextInput.Icon icon="calendar" />}
          />
        </Pressable>
      )}

      {showDatePicker && Platform.OS !== 'web' && (
        <View style={styles.pickerBox}>
          <DateTimePicker
            value={new Date(form.birth_date)}
            mode="date"
            display="spinner"
            onChange={(e, d) => {
              if (Platform.OS === 'android') setShowDatePicker(false);
              if (d) setForm({ ...form, birth_date: d.toISOString() });
            }}
          />
          {Platform.OS === 'ios' && (
            <Button onPress={() => setShowDatePicker(false)}>Confirm Date</Button>
          )}
        </View>
      )}

      <TextInput label="Gender" mode="outlined" style={styles.input} onChangeText={v => setForm({ ...form, gender: v })} />

      <TextInput label="Blood Type" mode="outlined" style={styles.input} onChangeText={v => setForm({ ...form, blood_type: v })} />

      <TextInput label="Email *" mode="outlined" style={styles.input} autoCapitalize="none" onChangeText={v => setForm({ ...form, email: v })} />

      <TextInput label="Password *" mode="outlined" style={styles.input} secureTextEntry onChangeText={v => setForm({ ...form, password: v })} />

      <Text variant="titleMedium" style={{ marginTop: 10 }}>Select Role</Text>
      <View style={styles.roles}>
        {['type1', 'type2', 'type3', 'type4'].map(r => (
          <Chip
            key={r}
            selected={form.role === r}
            onPress={() => setForm({ ...form, role: r })}
            style={styles.chip}
            showSelectedCheck
          >
            {r.charAt(0).toUpperCase() + r.slice(1)}
          </Chip>
        ))}
      </View>

      <Button mode="contained" onPress={handleSignup} loading={loading} style={styles.button}>
        Create Account
      </Button>

      <Button mode="text" onPress={() => router.replace('/login')}>
        Already have an account? Login
      </Button>
    </ScrollView>
  );
}

const webInputStyle = {
  padding: '12px',
  borderRadius: '4px',
  border: '1px solid #79747E',
  backgroundColor: 'transparent',
  width: '100%',
  marginBottom: 15,
  fontSize: '16px'
};

const styles = StyleSheet.create({
  container: { padding: 30, flexGrow: 1, justifyContent: 'center', paddingBottom: 60 },
  title: { fontWeight: 'bold', textAlign: 'center', marginBottom: 20 },
  input: { marginBottom: 12 },
  dateLabel: { opacity: 0.6, marginBottom: 5, fontWeight: 'bold' },
  roles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 15 },
  chip: { marginBottom: 4 },
  button: { marginTop: 10, borderRadius: 8, paddingVertical: 5 },
  pickerBox: { backgroundColor: 'white', borderRadius: 12, padding: 10, marginBottom: 20, borderWidth: 1, borderColor: '#ddd' }
});