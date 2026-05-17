import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Text, TextInput, useTheme } from 'react-native-paper';
import { useAuth } from '../context/AuthContext';

export default function LoginScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { login } = useAuth();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [identifier, setIdentifier] = useState(''); // renamed for clarity
  const [password, setPassword] = useState('');

  const handleLogin = async () => {
    setLoading(true);
    try {
      const res = await fetch('https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }) // send as 'identifier'
      });
      const data = await res.json();
      if (res.ok) {
        login(data);
      } else {
        setError(data.error || "Login failed");
      }
    } catch (e) {
      setError("Server connection failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Text variant="headlineLarge" style={styles.title}>WISE Login</Text>
      <Text variant="bodyMedium" style={styles.subtitle}>Enter your credentials, Agent.</Text>
      <TextInput
        label="Email or Phone Number"
        value={identifier}
        onChangeText={setIdentifier}
        mode="outlined"
        style={styles.input}
        autoCapitalize="none"
        keyboardType="email-address" // Works for both on most keyboards
      />
      <TextInput label="Password" value={password} onChangeText={setPassword} mode="outlined" style={styles.input} secureTextEntry />

      {error ? <Text style={{ color: theme.colors.error, marginBottom: 10 }}>{error}</Text> : null}

      <Button mode="contained" onPress={handleLogin} loading={loading} style={styles.button}>Sign In</Button>
      <Button mode="text" onPress={() => router.push('/signup')}>Don't have an account? Sign Up</Button>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 30, justifyContent: 'center' },
  title: { fontWeight: 'bold', textAlign: 'center' },
  subtitle: { textAlign: 'center', marginBottom: 30, opacity: 0.6 },
  input: { marginBottom: 12 },
  button: { marginTop: 10, paddingVertical: 5, borderRadius: 8 }
});