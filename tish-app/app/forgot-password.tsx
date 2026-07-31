import { MaterialCommunityIcons } from '@expo/vector-icons';
import { confirmResetPassword, resetPassword } from 'aws-amplify/auth';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Platform, StyleSheet, View } from 'react-native';
import { Button, Text, TextInput } from 'react-native-paper';

import { COLORS, RADIUS, SHADOWS } from '../constants/theme';
import { GlobalStyles } from '../styles/globalstyles';

// Mirrors AuthDeliveryMedium from aws-amplify/auth, same as signup.tsx.
type DeliveryMedium = 'EMAIL' | 'SMS' | 'PHONE' | 'UNKNOWN';

/**
 * Password recovery. Two steps: ask Cognito to send a code, then exchange the
 * code plus a new password.
 *
 * Reached three ways, and all three matter:
 *  - the "forgot password" link on the login screen (the normal route);
 *  - login.tsx handing over a RESET_PASSWORD sign-in step, which is what
 *    Cognito returns after an administrator forces a reset. That used to
 *    dead-end silently on the login screen — see `reason=reset_required`;
 *  - the confirm step's own "start over" action.
 *
 * Delivery medium is *read back* from Cognito rather than assumed. While the
 * SNS sandbox is on (constants/config.ts) accounts are verified by email, so
 * that is where reset codes go — but the pool decides, not this screen, and
 * telling someone to check their texts when we emailed them is how testers get
 * stranded.
 */
export default function ForgotPasswordScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ username?: string; reason?: string }>();

  const [step, setStep] = useState<'request' | 'confirm'>('request');
  const [loading, setLoading] = useState(false);

  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [codeDelivery, setCodeDelivery] = useState<{ medium?: DeliveryMedium; destination?: string }>({});

  // Prefill when login.tsx hands us the identifier the person already typed.
  useEffect(() => {
    if (params.username) setIdentifier(String(params.username));
  }, [params.username]);

  const notifyUser = (title: string, message: string) => {
    if (Platform.OS === 'web') window.alert(`${title}: ${message}`);
    else Alert.alert(title, message);
  };

  // Turn a Cognito failure into something a person can act on. Same shape as
  // signup.tsx's confirmErrorMessage, with the reset-specific cases added.
  const resetErrorMessage = (e: any) => {
    switch (e?.name) {
      case 'CodeMismatchException': return t('forgotPassword.codeMismatch');
      case 'ExpiredCodeException': return t('forgotPassword.codeExpired');
      case 'LimitExceededException':
      case 'TooManyRequestsException':
      case 'TooManyFailedAttemptsException': return t('forgotPassword.tooManyAttempts');
      case 'UserNotFoundException': return t('forgotPassword.userNotFound');
      case 'InvalidPasswordException': return t('forgotPassword.invalidPassword');
      // Cognito cannot send a code to an account with no verified email or
      // phone — typically one that never completed signup verification.
      case 'InvalidParameterException': return t('forgotPassword.noDeliveryMethod');
      case 'NotAuthorizedException': return t('forgotPassword.cannotReset');
      default: return e?.message || t('common.error');
    }
  };

  // --- STEP 1: ask Cognito to send a code ---
  const handleSendCode = async () => {
    const cleanId = identifier.trim();
    if (!cleanId) {
      setError(t('forgotPassword.enterIdentifier'));
      return;
    }

    setLoading(true);
    setError('');
    setNote('');

    try {
      const { nextStep } = await resetPassword({ username: cleanId });

      if (nextStep.resetPasswordStep === 'CONFIRM_RESET_PASSWORD_WITH_CODE') {
        const { deliveryMedium, destination } = nextStep.codeDeliveryDetails;
        // Logged deliberately, same reasoning as signup: when someone says "no
        // code arrived", this is the one line that says text or email, and where.
        console.log('[forgot-password] code delivery ->', deliveryMedium, destination);
        setCodeDelivery({ medium: deliveryMedium as DeliveryMedium, destination });
        setStep('confirm');
      } else {
        // 'DONE' — the pool reset it without a code. Nothing left to confirm.
        notifyUser(t('forgotPassword.successTitle'), t('forgotPassword.successMessage'));
        router.replace('/login');
      }
    } catch (e: any) {
      console.warn('[forgot-password] request failed:', e?.name, e?.message);
      setError(resetErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  // --- STEP 2: exchange code + new password ---
  const handleConfirmReset = async () => {
    if (!code.trim()) {
      setError(t('forgotPassword.enterCode'));
      return;
    }
    if (!newPassword) {
      setError(t('forgotPassword.enterNewPassword'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('forgotPassword.passwordsDoNotMatch'));
      return;
    }

    setLoading(true);
    setError('');
    setNote('');

    try {
      await confirmResetPassword({
        username: identifier.trim(),
        confirmationCode: code.trim(),
        newPassword,
      });

      // Deliberately do not auto-sign-in. The password just changed, and
      // landing on the login screen with it fresh in mind is the clearer
      // outcome than a silent jump into the app.
      notifyUser(t('forgotPassword.successTitle'), t('forgotPassword.successMessage'));
      router.replace('/login');
    } catch (e: any) {
      console.warn('[forgot-password] confirm failed:', e?.name, e?.message);
      setError(resetErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError('');
    setNote('');
    try {
      const { nextStep } = await resetPassword({ username: identifier.trim() });
      if (nextStep.resetPasswordStep === 'CONFIRM_RESET_PASSWORD_WITH_CODE') {
        const { deliveryMedium, destination } = nextStep.codeDeliveryDetails;
        setCodeDelivery({ medium: deliveryMedium as DeliveryMedium, destination });
        setNote(t('forgotPassword.resentMessage', { destination: destination || identifier.trim() }));
      }
    } catch (e: any) {
      setError(resetErrorMessage(e));
    }
  };

  // --- STEP 2 RENDER ---
  if (step === 'confirm') {
    const sentBySms = codeDelivery.medium === 'SMS' || codeDelivery.medium === 'PHONE';
    const destination = codeDelivery.destination || identifier.trim();

    return (
      <View style={[GlobalStyles.container, styles.centeredContent]}>
        <MaterialCommunityIcons
          name={sentBySms ? 'cellphone-message' : 'email-seal'}
          size={72}
          color={COLORS.primary}
        />
        <Text variant="headlineMedium" style={styles.stepTitle}>{t('forgotPassword.newPasswordTitle')}</Text>
        <Text style={styles.stepSubtitle}>
          {sentBySms
            ? t('forgotPassword.codeSentSms', { destination })
            : t('forgotPassword.codeSentEmail', { destination })}
        </Text>
        {/* Spam advice only makes sense for the email route. */}
        {!sentBySms && <Text style={styles.spamHint}>{t('forgotPassword.checkSpamFolder')}</Text>}

        <TextInput
          mode="outlined"
          placeholder={t('forgotPassword.codePlaceholder')}
          value={code}
          onChangeText={v => { setCode(v); if (error) setError(''); }}
          keyboardType="number-pad"
          error={!!error}
          style={styles.codeInput}
        />

        <TextInput
          mode="outlined"
          label={t('forgotPassword.newPasswordLabel')}
          value={newPassword}
          onChangeText={v => { setNewPassword(v); if (error) setError(''); }}
          secureTextEntry
          autoCapitalize="none"
          style={styles.input}
          left={<TextInput.Icon icon="lock-reset" />}
        />

        <TextInput
          mode="outlined"
          label={t('forgotPassword.confirmPasswordLabel')}
          value={confirmPassword}
          onChangeText={v => { setConfirmPassword(v); if (error) setError(''); }}
          secureTextEntry
          autoCapitalize="none"
          style={styles.input}
          left={<TextInput.Icon icon="lock-check" />}
        />

        {!!error && <Text style={styles.errorText}>{error}</Text>}
        {!!note && <Text style={styles.noteText}>{note}</Text>}

        <Button
          mode="contained"
          onPress={handleConfirmReset}
          loading={loading}
          disabled={loading}
          style={styles.primaryBtn}
        >
          {t('forgotPassword.resetButton')}
        </Button>

        <Button mode="text" onPress={handleResend} disabled={loading} textColor={COLORS.slate}>
          {t('forgotPassword.resendCode')}
        </Button>

        {/* Always leave a way out of this screen. */}
        <Button
          mode="text"
          onPress={() => { setStep('request'); setError(''); setNote(''); setCode(''); }}
          disabled={loading}
          textColor={COLORS.slate}
        >
          {t('forgotPassword.startOver')}
        </Button>
      </View>
    );
  }

  // --- STEP 1 RENDER ---
  return (
    <View style={[GlobalStyles.container, styles.centeredContent]}>
      <MaterialCommunityIcons name="lock-question" size={72} color={COLORS.primary} />
      <Text variant="headlineMedium" style={styles.stepTitle}>{t('forgotPassword.title')}</Text>

      {/* Arriving here because Cognito demanded a reset (e.g. an admin forced
          one) needs saying out loud — otherwise the sign-in attempt just
          appeared to fail for no reason. */}
      {params.reason === 'reset_required' ? (
        <Text style={styles.reasonBanner}>{t('forgotPassword.resetRequiredExplanation')}</Text>
      ) : (
        <Text style={styles.stepSubtitle}>{t('forgotPassword.subtitle')}</Text>
      )}

      <TextInput
        mode="outlined"
        label={t('forgotPassword.identifierLabel')}
        value={identifier}
        onChangeText={v => { setIdentifier(v); if (error) setError(''); }}
        autoCapitalize="none"
        keyboardType="email-address"
        error={!!error}
        style={styles.input}
        left={<TextInput.Icon icon="account" />}
      />

      {!!error && <Text style={styles.errorText}>{error}</Text>}

      <Button
        mode="contained"
        onPress={handleSendCode}
        loading={loading}
        disabled={loading}
        style={styles.primaryBtn}
        icon="email-fast"
      >
        {t('forgotPassword.sendCode')}
      </Button>

      <Button
        mode="text"
        onPress={() => router.replace('/login')}
        disabled={loading}
        textColor={COLORS.slate}
      >
        {t('forgotPassword.backToSignIn')}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  centeredContent: { justifyContent: 'center', alignItems: 'center', padding: 30 },
  stepTitle: { fontWeight: '800', color: COLORS.ink, marginTop: 20, textAlign: 'center' },
  stepSubtitle: { textAlign: 'center', color: COLORS.slate, marginVertical: 10, lineHeight: 20 },
  reasonBanner: {
    textAlign: 'center',
    color: COLORS.ink,
    backgroundColor: '#FEF3C7',
    borderRadius: RADIUS.md,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginVertical: 14,
    lineHeight: 20,
    fontWeight: '600',
  },
  spamHint: { textAlign: 'center', color: COLORS.slate, fontSize: 13, marginBottom: 16, lineHeight: 18 },
  input: { backgroundColor: 'white', width: '100%', marginBottom: 12 },
  codeInput: {
    backgroundColor: 'white',
    width: '100%',
    textAlign: 'center',
    fontSize: 26,
    fontWeight: 'bold',
    letterSpacing: 10,
    marginBottom: 16,
  },
  errorText: { color: COLORS.error, textAlign: 'center', marginBottom: 12, fontWeight: '600' },
  noteText: { color: COLORS.primary, textAlign: 'center', marginBottom: 12, fontWeight: '600' },
  primaryBtn: {
    width: '100%',
    borderRadius: RADIUS.lg,
    height: 56,
    justifyContent: 'center',
    marginTop: 8,
    ...SHADOWS.medium,
  },
});
