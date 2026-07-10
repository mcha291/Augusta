import { signIn } from 'aws-amplify/auth';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Image, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Text, TextInput, useTheme } from 'react-native-paper';

import { COLORS, RADIUS, SHADOWS } from '../constants/theme';
import { useAuth } from '../context/AuthContext';

export default function LoginScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const { checkUser } = useAuth(); // We need this to refresh the global state

  const [loading, setLoading] = useState(false);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  const handleLogin = async () => {
    if (!identifier.trim() || !password) {
      notifyUser(t('common.error'), t('login.fillBothFields'));
      return;
    }

    try {
      setLoading(true);
      
      // 1. Authenticate with Cognito via Amplify
      const { isSignedIn, nextStep } = await signIn({
        username: identifier.trim(),
        password: password,
      });

      if (isSignedIn) {
        // 2. CRITICAL: Sync the Cognito session with your RDS profile 
        // before navigating. This populates the 'user' object.
        await checkUser(); 
        
        // 3. Move to the main app
        router.replace('/(tabs)');
      } else if (nextStep.signInStep === 'CONFIRM_SIGN_UP') {
        // Handle users who signed up but haven't verified their email code
        Alert.alert(t('login.verifyAccountTitle'), t('login.verifyAccountMessage'));
        router.push('/signup');
      }
    } catch (error: any) {
      console.error("Login Error:", error);
      notifyUser(t('login.loginFailedTitle'), error.message || t('login.invalidCredentials'));
    } finally {
      setLoading(false);
    }
  };

  const notifyUser = (title: string, message: string) => {
    if (Platform.OS === 'web') {
      window.alert(`${title}: ${message}`);
    } else {
      Alert.alert(title, message);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.brandSection}>
        <View style={styles.logoCircle}>
          <Image 
            source={require('../assets/images/icon.png')} 
            style={styles.logoImage}
            resizeMode="contain" 
          />
        </View>
        <Text variant="headlineLarge" style={styles.title}>{t('common.appName')}</Text>
        <Text variant="bodyMedium" style={styles.subtitle}>
          {t('login.subtitle')}
        </Text>
      </View>

      <View style={styles.formCard}>
        <TextInput
          label={t('login.identifierLabel')}
          value={identifier}
          onChangeText={setIdentifier}
          mode="outlined"
          outlineColor={COLORS.background}
          activeOutlineColor={COLORS.primary}
          style={styles.input}
          autoCapitalize="none"
          keyboardType="email-address"
          left={<TextInput.Icon icon="account" />}
        />

        <TextInput
          label={t('login.passwordLabel')}
          value={password} 
          onChangeText={setPassword} 
          mode="outlined" 
          outlineColor={COLORS.background}
          activeOutlineColor={COLORS.primary}
          style={styles.input} 
          secureTextEntry 
          left={<TextInput.Icon icon="lock" />}
        />

        <Button 
          mode="contained" 
          onPress={handleLogin} 
          icon="shield-key"
          loading={loading} 
          disabled={loading}
          style={styles.button}
          contentStyle={{ height: 56 }}
        >
          {t('login.authenticate')}
        </Button>
      </View>

      <Button
        mode="text"
        onPress={() => router.push('/signup')}
        textColor={COLORS.slate}
        style={{ marginTop: 20 }}
      >
        {t('login.registerHere')}
      </Button>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { 
    flexGrow: 1, 
    padding: 30, 
    justifyContent: 'center', 
    backgroundColor: COLORS.background 
  },
  brandSection: { 
    alignItems: 'center', 
    marginBottom: 40 
  },
  logoCircle: { 
    width: 80, 
    height: 80, 
    borderRadius: 40, 
    backgroundColor: COLORS.ink, 
    justifyContent: 'center', 
    alignItems: 'center',
    marginBottom: 20,
    ...SHADOWS.medium
  },
  logoImage: {
    width: '70%',
    height: '70%',
  },
  title: { 
    fontWeight: '800', 
    color: COLORS.ink, 
    letterSpacing: -1 
  },
  subtitle: { 
    textAlign: 'center', 
    opacity: 0.6, 
    color: COLORS.slate,
    marginTop: 4 
  },
  formCard: {
    backgroundColor: 'white',
    padding: 20,
    borderRadius: RADIUS.xl,
    ...SHADOWS.soft,
    gap: 15
  },
  input: { 
    backgroundColor: 'white',
  },
  button: { 
    marginTop: 10, 
    borderRadius: RADIUS.lg,
    ...SHADOWS.medium 
  }
});