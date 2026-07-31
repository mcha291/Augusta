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
      } else {
        // Not signed in, and Cognito wants something more. Every branch below
        // must say *something*: an unhandled step used to leave the spinner
        // simply stopping, with no indication that anything was required.
        handleNextStep(nextStep.signInStep, identifier.trim());
      }
    } catch (error: any) {
      console.error("Login Error:", error);
      notifyUser(t('login.loginFailedTitle'), error.message || t('login.invalidCredentials'));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Cognito can return a dozen different `signInStep` values and this screen
   * only ever knew two of them. Anything else fell through both branches, so
   * `isSignedIn` stayed false, nothing navigated, and the spinner just
   * stopped — the user was told nothing at all.
   *
   * RESET_PASSWORD is the one that actually bites: it is what Cognito returns
   * after an administrator forces a password reset, which was the only
   * recovery route for a forgotten password. That is now routed into the
   * reset flow rather than dead-ending here.
   */
  const handleNextStep = (signInStep: string, username: string) => {
    switch (signInStep) {
      case 'CONFIRM_SIGN_UP':
        // Signed up but never verified. Hand the username across so signup
        // opens on the confirm step — sending them to a blank registration
        // form left them stuck, since re-registering hits "already exists".
        notifyUser(t('login.verifyAccountTitle'), t('login.verifyAccountMessage'));
        router.push({
          pathname: '/signup',
          params: { username, pendingConfirm: '1' },
        });
        return;

      case 'RESET_PASSWORD':
        router.push({
          pathname: '/forgot-password',
          params: { username, reason: 'reset_required' },
        });
        return;

      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
        // A pool-side temporary password. Amplify wants confirmSignIn() with
        // the new password, which this app has no screen for — say so plainly
        // rather than appearing to do nothing.
        notifyUser(t('login.actionNeededTitle'), t('login.newPasswordRequired'));
        return;

      case 'CONFIRM_SIGN_IN_WITH_SMS_CODE':
      case 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE':
      case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
      case 'CONFIRM_SIGN_IN_WITH_PASSWORD':
      case 'CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE':
      case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION':
      case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION':
      case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP':
      case 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP':
      case 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION':
        // MFA is not configured on this pool today. If it ever is, these need
        // real screens; until then the user at least learns why they're stuck.
        notifyUser(t('login.actionNeededTitle'), t('login.mfaNotSupported'));
        return;

      default:
        // Includes 'DONE' arriving with isSignedIn false, which shouldn't
        // happen. Carry the step name so a tester's screenshot is diagnosable.
        console.warn('[login] unhandled signInStep:', signInStep);
        notifyUser(t('login.actionNeededTitle'), t('login.unexpectedStep', { step: signInStep }));
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
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
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

        {/* Carry whatever they already typed across, so the reset screen
            doesn't ask for the identifier a second time. */}
        <Button
          mode="text"
          onPress={() => router.push({
            pathname: '/forgot-password',
            params: identifier.trim() ? { username: identifier.trim() } : {},
          })}
          textColor={COLORS.slate}
          compact
        >
          {t('login.forgotPassword')}
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