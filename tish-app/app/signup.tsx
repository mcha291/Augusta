import { MaterialCommunityIcons } from '@expo/vector-icons';
import { confirmSignUp, resendSignUpCode, signIn, signOut, signUp } from 'aws-amplify/auth';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { goBackOrHome } from '@/utils/navigation';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View
} from 'react-native';
import {
  Appbar,
  Button,
  HelperText,
  Menu,
  SegmentedButtons,
  Surface,
  Text,
  TextInput
} from 'react-native-paper';
import PlatformDatePicker from '../components/platform-date-picker';
import { DEFAULT_VERIFICATION_MEDIUM, SMS_VERIFICATION_ENABLED } from '../constants/config';
import { GeneralOption } from '../constants/interfaces';
import { toLocalDateString } from '../utils/date';

// Design System
import { COLORS, RADIUS, SHADOWS } from '../constants/theme';
import { useAuth } from '../context/AuthContext';
import { GlobalStyles } from '../styles/globalstyles';
import { apiRequest } from '../utils/api';
import { apiErrorMessage, describeApiFailure } from '../utils/api-errors';

// Mirrors AuthDeliveryMedium from aws-amplify/auth.
type DeliveryMedium = 'EMAIL' | 'SMS' | 'PHONE' | 'UNKNOWN';

export default function SignupScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { user, checkUser } = useAuth();
  // Set by login.tsx when it meets an unverified account, so we can open
  // straight on the confirm step instead of a blank registration form.
  const params = useLocalSearchParams<{ username?: string; pendingConfirm?: string }>();
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const [emailStatus, setEmailStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'error'>('idle');
  const [phoneStatus, setPhoneStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'error'>('idle');
  // 'profile' = Cognito account already exists (id === 0) and just needs an RDS profile
  const [step, setStep] = useState<'form' | 'confirm' | 'profile' | 'fix-conflict'>('form');
  const [loading, setLoading] = useState(false);
  const [fetchingOptions, setFetchingOptions] = useState(true);

  const [genders, setGenders] = useState<GeneralOption[]>([]);
  const [conditions, setConditions] = useState<GeneralOption[]>([]);

  // --- FORM STATE ---
  const [form, setForm] = useState({
    username: '',
    email: '',
    phone_number: '',
    password: '',
    full_name: '',
    role: 'civilian',
    gender_id: null as number | null,
    condition_id: null as number | null,
    birth_date: new Date()
  });

  const [authCode, setAuthCode] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [resendNote, setResendNote] = useState('');
  // Where Cognito actually sent the code. Cognito picks this itself from the
  // pool's auto-verified attributes, so it has to be read back rather than
  // assumed — the confirm screen used to just claim "email" unconditionally.
  const [codeDelivery, setCodeDelivery] = useState<{ medium?: DeliveryMedium; destination?: string }>({});
  const [verifyVia, setVerifyVia] = useState<'sms' | 'email'>(DEFAULT_VERIFICATION_MEDIUM);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [menus, setMenus] = useState({ gender: false, condition: false });

  // Nobody is born tomorrow.
  const [today] = useState(() => new Date());

  // 1. Helper for alerts
  const notifyUser = (title: string, message: string) => {
    if (Platform.OS === 'web') window.alert(`${title}: ${message}`);
    else Alert.alert(title, message);
  };

  // 2. Phone Validation (E.164 Format: +[country][number])
  const validatePhone = (phone: string) => {
    const regex = /^\+[1-9]\d{1,14}$/;
    return phone === "" || regex.test(phone);
  };

  // 3. Detect an already-authenticated-but-incomplete-profile user.
  // This happens when Cognito signup/login succeeded but RDS profile
  // creation failed previously — the person is bounced here by _layout.tsx.
  // We must NOT call signUp() again (the Cognito user already exists),
  // just prefill what we know and let them finish the profile directly.
  useEffect(() => {
    if (user && user.id === 0) {
      setStep('profile');
      setForm(prev => ({
        ...prev,
        username: user.username || prev.username,
        email: user.email || prev.email,
      }));
    }
  }, [user]);

  // 3b. Arriving from the login screen with an unverified Cognito account.
  // Without this the user lands on an empty registration form they can never
  // submit (the account already exists), with no route back to the code entry.
  useEffect(() => {
    if (params.pendingConfirm === '1' && params.username) {
      setForm(prev => ({ ...prev, username: String(params.username) }));
      setStep('confirm');
    }
  }, [params.pendingConfirm, params.username]);

  useEffect(() => {
    async function loadLookupData() {
      try {
        const [gRes, cRes] = await Promise.all([
          apiRequest(`/genders`),
          apiRequest(`/conditions`)
        ]);
        setGenders(await gRes.json());
        setConditions(await cRes.json());
      } catch (e) {
        console.error("Lookup error", e);
      } finally {
        setFetchingOptions(false);
      }
    }
    loadLookupData();
  }, []);

  // --- STEP 1: SIGN UP (brand new account) ---
  const handleSignUp = async () => {
    const cleanUser = form.username.trim();
    const cleanEmail = form.email.trim().toLowerCase();
    const cleanPhone = form.phone_number.trim();
    const cleanPass = form.password.trim();

    if (!cleanUser || !cleanEmail || !cleanPass || !cleanPhone || !form.full_name || !form.gender_id) {
      notifyUser(t('signup.requiredTitle'), t('signup.fillMandatoryFields'));
      return;
    }

    if (cleanUser.includes('@')) {
      notifyUser(t('signup.invalidCodenameTitle'), t('signup.usernameNotEmail'));
      return;
    }

    if (cleanPhone && !validatePhone(cleanPhone)) {
      notifyUser(t('signup.invalidPhoneTitle'), t('signup.phoneFormatError'));
      return;
    }

    setLoading(true);

    // --- PRE-SIGNUP AVAILABILITY CHECK ---
    try {
      // API Gateway already exposes /check-availability with authorizationType
      // NONE, so this pre-auth call goes through the normal front door like
      // everything else. apiRequest simply omits the Authorization header when
      // there's no session yet.
      const checkRes = await apiRequest(
        `/check-availability?email=${encodeURIComponent(cleanEmail)}&phone_number=${encodeURIComponent(cleanPhone)}`
      );
      const availability = await checkRes.json();

      if (availability.exists) {
        setLoading(false);
        notifyUser(t('signup.accountExistsTitle'), t('signup.fieldAlreadyRegistered', { field: availability.field }));
        return;
      }
    } catch (e) {
      console.warn("Availability check failed, proceeding to Cognito anyway...");
    }

    try {
      // `phone_number` is **always** sent, because the pool marks it
      // `Required: true` — omitting it fails the call outright with
      // "Attributes did not conform to the schema", which is what registration
      // did for every user until this was fixed.
      //
      // This used to be conditional. The reasoning was that Cognito picks the
      // delivery medium from the pool's auto-verified attributes and prefers
      // SMS whenever a phone_number is present, so leaving it out was treated
      // as the only available lever for forcing the email route. That lever
      // does not exist on this pool: a required attribute cannot be omitted,
      // and `Required` cannot be changed after a pool is created.
      //
      // **The real lever is pool-side, not payload-side.** `phone_number` was
      // removed from the pool's `AutoVerifiedAttributes`, which leaves `email`
      // as the only auto-verified attribute — so Cognito emails the code even
      // though a phone number is supplied. Unlike `Required`, that field *can*
      // be updated after creation.
      //
      // Consequence worth knowing: `verifyVia` can no longer influence
      // delivery from here. If SMS is ever wanted again, `phone_number` has to
      // go back into `AutoVerifiedAttributes` — at which point Cognito will
      // prefer SMS for *everyone*, because the number is now always present.
      // Per-user choice would then need a different mechanism entirely.
      //
      // The number reaches RDS through /register-profile either way. What
      // changes is that Cognito now stores it too, unverified — so it will not
      // work as a sign-in alias until it is verified.
      const { nextStep } = await signUp({
        username: cleanUser,
        password: cleanPass,
        options: {
          userAttributes: {
            email: cleanEmail,
            name: form.full_name,
            phone_number: cleanPhone,
          }
        }
      });

      if (nextStep.signUpStep === 'CONFIRM_SIGN_UP') {
        const { deliveryMedium, destination } = nextStep.codeDeliveryDetails;
        // Logged deliberately: when a tester says "no code arrived", this is
        // the one line that says whether it was a text or an email, and to what.
        console.log('[signup] code delivery ->', deliveryMedium, destination);
        setCodeDelivery({ medium: deliveryMedium as DeliveryMedium, destination });
        setStep('confirm');
      } else {
        // Pool auto-confirmed the account (e.g. a PreSignUp trigger); there is
        // no code to enter, so go straight to the rest of the flow.
        console.log('[signup] no confirmation required, step =', nextStep.signUpStep);
        await finishSignup(cleanUser);
      }
    } catch (e: any) {
      notifyUser(e.name || t('signup.accessDeniedTitle'), e.message);
    } finally {
      setLoading(false);
    }
  };

  // Shared tail of registration: sign in with the credentials still held in
  // state, then create the RDS profile. Reached both after a confirmation code
  // is accepted and when the pool auto-confirms and there's no code at all.
  // Callers own the loading flag.
  const finishSignup = async (cleanUser: string) => {
    // Arriving from the login screen we never had the password, so we can't
    // sign in here. Verification did stick, so send them to log in.
    if (!form.password) {
      notifyUser(t('signup.verifiedTitle'), t('signup.verifiedPleaseSignIn'));
      router.replace('/login');
      return;
    }

    try {
      await signIn({ username: cleanUser, password: form.password });
    } catch (e: any) {
      console.error("Post-confirm sign-in failed:", e?.message);
      notifyUser(t('signup.verifiedTitle'), t('signup.verifiedPleaseSignIn'));
      router.replace('/login');
      return;
    }

    try {
      const regres = await apiRequest('/register-profile', {
        method: 'POST',
        body: {
          username: cleanUser,
          full_name: form.full_name,
          birth_date: toLocalDateString(form.birth_date),
          gender_id: form.gender_id,
          condition_id: form.condition_id,
          phone_number: form.phone_number.trim() || null,
          role: form.role
        }
      });

      if (!regres.ok) {
        // 6.2 — `data.error` was the server's English. The message still
        // travels as a thrown Error because the catch below renders it, but it
        // is a translated sentence by the time it is thrown.
        throw new Error(apiErrorMessage(await describeApiFailure(regres), t));
      }

      // Must refresh auth state before navigating: _layout only registers the
      // (tabs) route once user.id !== 0, so replacing without this bounces
      // straight back to /login.
      await checkUser();
      router.replace('/(tabs)');
    } catch (e: any) {
      console.error("Setup Error:", e.message);
      // The Cognito account is verified and signed in at this point. Signing
      // out and dumping them at /login used to strand the account with no way
      // back to the profile form — drop into the retryable profile step.
      notifyUser(t('signup.setupErrorTitle'), (e.message || '') + "\n\n" + t('signup.verifiedButProfileFailed'));
      setStep('profile');
    }
  };

  // Turn a Cognito confirmation failure into something a person can act on.
  const confirmErrorMessage = (e: any) => {
    switch (e?.name) {
      case 'CodeMismatchException': return t('signup.codeMismatch');
      case 'ExpiredCodeException': return t('signup.codeExpired');
      case 'LimitExceededException':
      case 'TooManyFailedAttemptsException': return t('signup.tooManyAttempts');
      case 'NotAuthorizedException': return t('signup.alreadyConfirmed');
      case 'UserNotFoundException': return t('signup.userNotFound');
      default: return e?.message || t('common.error');
    }
  };

  // --- STEP 2: CONFIRM (brand new account) ---
  // Split into phases on purpose. A wrong code is an everyday mistake and must
  // leave the user exactly where they are; only a failure *after* the account
  // is verified warrants moving them somewhere else.
  const handleConfirm = async () => {
    const cleanUser = form.username.trim();

    if (!authCode.trim()) {
      setConfirmError(t('signup.enterCode'));
      return;
    }

    setLoading(true);
    setConfirmError('');
    setResendNote('');

    // --- Phase 1: the verification code. Fully recoverable — stay put. ---
    try {
      await confirmSignUp({ username: cleanUser, confirmationCode: authCode.trim() });
    } catch (e: any) {
      console.warn("Confirmation failed:", e?.name, e?.message);
      setConfirmError(confirmErrorMessage(e));
      setLoading(false);
      return;
    }

    await finishSignup(cleanUser);
    setLoading(false);
  };

  // --- STEP 3: COMPLETE PROFILE (Cognito already authenticated, id === 0) ---
  const handleCompleteProfile = async () => {
    if (!form.full_name || !form.gender_id) {
      notifyUser(t('signup.requiredTitle'), t('signup.fillMandatoryFields'));
      return;
    }

    const cleanPhone = form.phone_number.trim();
    if (cleanPhone && !validatePhone(cleanPhone)) {
      notifyUser(t('signup.invalidPhoneTitle'), t('signup.phoneFormatError'));
      return;
    }

    setLoading(true);
    try {
      const regres = await apiRequest('/register-profile', {
        method: 'POST',
        body: {
          username: form.username.trim(),
          full_name: form.full_name,
          birth_date: toLocalDateString(form.birth_date),
          gender_id: form.gender_id,
          condition_id: form.condition_id,
          phone_number: cleanPhone || null,
          role: form.role
        }
      });

      if (!regres.ok) {
        throw new Error(apiErrorMessage(await describeApiFailure(regres), t));
      }

      await checkUser(); // pulls the new RDS profile in, sets user.id !== 0
      router.replace('/(tabs)');
    } catch (e: any) {
      console.error("Profile completion error:", e.message);
      notifyUser(t('signup.setupErrorTitle'), e.message || t('signup.completeProfileFailed'));
      // Stay authenticated and on this screen so they can retry — no signOut here.
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setConfirmError('');
    setResendNote('');
    try {
      const { destination, deliveryMedium } = await resendSignUpCode({ username: form.username.trim() });
      // Cognito masks the destination (e.g. "j***@g***.com"); prefer it over
      // form.email, which is empty when we arrived here from the login screen.
      console.log('[signup] resend delivery ->', deliveryMedium, destination);
      setCodeDelivery({ medium: deliveryMedium as DeliveryMedium, destination });
      setResendNote(t('signup.resentMessage', { email: destination || form.email }));
    } catch (e: any) {
      setConfirmError(confirmErrorMessage(e));
    }
  };


  // 2. Debounced Email Check
  useEffect(() => {
    // Only check if it looks like a valid email length
    if (!form.email || form.email.length < 4) {
      setEmailStatus('idle');
      return;
    }

    if (!EMAIL_REGEX.test(form.email)) {
      setEmailStatus('error');      
      return;
    }

    setEmailStatus('checking');

    // Create the timer
    const delayDebounceFn = setTimeout(async () => {
      try {
        const url = `/check-availability?email=${encodeURIComponent(form.email.toLowerCase().trim())}`;
        const res = await apiRequest(url);
        const data = await res.json();
        setEmailStatus(data.exists ? 'taken' : 'available');
      } catch (e) {
        setEmailStatus('idle');
      }
    }, 600); // 600ms delay

    // CLEANUP: This runs whenever form.email changes, killing the previous timer
    return () => clearTimeout(delayDebounceFn);
  }, [form.email]);

  // 3. Debounced Phone Check
  useEffect(() => {

    if (!form.phone_number || form.phone_number.length < 6) {
      setPhoneStatus('idle')
      return;
    }

    if (!validatePhone(form.phone_number)) {
      setPhoneStatus('error');
      return;
    }

    setPhoneStatus('checking');

    const delayDebounceFn = setTimeout(async () => {
      try {
        const url = `/check-availability?phone_number=${encodeURIComponent(form.phone_number.trim())}`;
        const res = await apiRequest(url);
        const data = await res.json();
        setPhoneStatus(data.exists ? 'taken' : 'available');
      } catch (e) {
        setPhoneStatus('idle');
      }
    }, 600);

    return () => clearTimeout(delayDebounceFn);
  }, [form.phone_number]);

  const handleEmailChange = (v: string) => {
    setForm({ ...form, email: v });
  };

  // The "+" is rendered as a permanent affix rather than placeholder text, so
  // state keeps digits only and re-attaches it. Testers were reading the old
  // "+886..." placeholder as a prefilled value and typing a bare local number
  // over the top of it, which then failed E.164 validation.
  const handlePhoneChange = (v: string) => {
    const digits = v.replace(/\D/g, '');
    setForm({ ...form, phone_number: digits ? `+${digits}` : '' });
  };

  // What the phone TextInput shows: state minus the affixed "+".
  const phoneDigits = form.phone_number.replace(/^\+/, '');

  if (fetchingOptions) {
    return <View style={GlobalStyles.centered}><ActivityIndicator color={COLORS.primary} /></View>;
  }

  if (step === 'confirm') {
    // Trust Cognito's answer over anything the form thinks it asked for.
    const sentBySms = codeDelivery.medium === 'SMS' || codeDelivery.medium === 'PHONE';
    const codeDestination = codeDelivery.destination
      || (sentBySms ? form.phone_number : form.email)
      || form.username;

    return (
      <View style={[GlobalStyles.container, styles.centeredContent]}>
        <MaterialCommunityIcons
          name={sentBySms ? 'cellphone-message' : 'email-seal'}
          size={80}
          color={COLORS.primary}
        />
        <Text variant="headlineMedium" style={styles.stepTitle}>{t('signup.confirmIdentity')}</Text>
        <Text style={styles.stepSubtitle}>
          {sentBySms
            ? t('signup.codeSentSms', { destination: codeDestination })
            : t('signup.codeSentEmail', { destination: codeDestination })}
        </Text>
        {/* Spam advice only makes sense for the email route. */}
        {!sentBySms && <Text style={styles.spamHint}>{t('signup.checkSpamFolder')}</Text>}

        <TextInput
          mode="outlined"
          placeholder={t('signup.codePlaceholder')}
          value={authCode}
          onChangeText={v => { setAuthCode(v); if (confirmError) setConfirmError(''); }}
          keyboardType="number-pad"
          error={!!confirmError}
          style={styles.codeInput}
        />

        {!!confirmError && (
          <Text style={styles.confirmError}>{confirmError}</Text>
        )}
        {!!resendNote && (
          <Text style={styles.confirmNote}>{resendNote}</Text>
        )}

        <Button mode="contained" onPress={handleConfirm} loading={loading} disabled={loading} style={styles.primaryBtn}>
          {t('signup.activateAccount')}
        </Button>
        <Button mode="text" onPress={handleResend} disabled={loading} textColor={COLORS.slate}>
          {t('signup.resendCode')}
        </Button>
        {/* Always leave a way out of this screen. */}
        <Button mode="text" onPress={() => router.replace('/login')} disabled={loading} textColor={COLORS.slate}>
          {t('signup.backToSignIn')}
        </Button>
      </View>
    );
  }

  if (step === 'profile') {
    return (
      <View style={GlobalStyles.container}>
        <Appbar.Header style={{ backgroundColor: COLORS.background }}>
          <Appbar.Content title={t('signup.completeYourProfile')} titleStyle={{ fontWeight: '800' }} />
        </Appbar.Header>

        <ScrollView contentContainerStyle={GlobalStyles.scrollContent} showsVerticalScrollIndicator={true} keyboardShouldPersistTaps="handled">
          <Text style={styles.pageTitle}>{t('signup.almostThere')}</Text>
          <Text style={styles.stepSubtitle}>
            {t('signup.verifiedFinishSetup', { identifier: form.email || form.username })}
          </Text>

          <View style={[styles.fieldContainer, { marginTop: 20 }]}>
            <Text style={styles.fieldLabel}>{t('signup.fullNameLabel')}</Text>
            <TextInput
              mode="outlined"
              value={form.full_name}
              autoComplete="name"
              style={styles.input}
              onChangeText={v => setForm({ ...form, full_name: v })}
            />
          </View>

          <View style={styles.sectionHeader}><Text style={styles.sectionHeaderText}>{t('signup.medicalProfileSection')}</Text></View>

          <View style={styles.fieldContainer}>
            <Text style={styles.fieldLabel}>{t('signup.genderLabel')}</Text>
            <Menu
              visible={menus.gender}
              onDismiss={() => setMenus({ ...menus, gender: false })}
              anchor={
                <Button mode="outlined" onPress={() => setMenus({ ...menus, gender: true })} style={styles.pickerBtn} textColor={form.gender_id ? COLORS.ink : COLORS.slate}>
                  {genders.find(c => c.id === form.gender_id)?.name || t('common.selectPlaceholder')}
                </Button>
              }
            >
              {genders.map(g => <Menu.Item key={g.id} onPress={() => { setForm({ ...form, gender_id: g.id }); setMenus({ ...menus, gender: false }); }} title={g.name} />)}
            </Menu>
          </View>

          <View style={styles.fieldContainer}>
            <Text style={styles.fieldLabel}>{t('signup.conditionLabel')}</Text>
            <Menu
              visible={menus.condition}
              onDismiss={() => setMenus({ ...menus, condition: false })}
              anchor={
                <Button mode="outlined" onPress={() => setMenus({ ...menus, condition: true })} style={styles.pickerBtn} textColor={form.condition_id ? COLORS.ink : COLORS.slate}>
                  {conditions.find(c => c.id === form.condition_id)?.name || t('common.selectPlaceholder')}
                </Button>
              }
            >
              {conditions.map(c => <Menu.Item key={c.id} onPress={() => { setForm({ ...form, condition_id: c.id }); setMenus({ ...menus, condition: false }); }} title={c.name} />)}
            </Menu>
          </View>

          <View style={styles.fieldContainer}>
            <Text style={styles.fieldLabel}>{t('signup.birthDateLabel')}</Text>
            <Pressable onPress={() => setShowDatePicker(true)}>
              <Surface style={styles.dateSurface} elevation={0}>
                <MaterialCommunityIcons name="calendar-account" size={20} color={COLORS.primary} style={{ marginRight: 12 }} />
                <Text style={styles.dateText}>{form.birth_date.toLocaleDateString()}</Text>
              </Surface>
            </Pressable>
          </View>

          <PlatformDatePicker
            visible={showDatePicker}
            value={form.birth_date}
            mode="date"
            maximumDate={today}
            onConfirm={d => { setForm({ ...form, birth_date: d }); setShowDatePicker(false); }}
            onDismiss={() => setShowDatePicker(false)}
          />

          <Button mode="contained" onPress={handleCompleteProfile} loading={loading} style={styles.saveButton}>
            {t('signup.completeProfile')}
          </Button>

          <Button
            mode="text"
            onPress={async () => { await signOut(); router.replace('/login'); }}
            textColor={COLORS.slate}
            style={{ marginTop: 10 }}
          >
            {t('signup.signOut')}
          </Button>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={GlobalStyles.container}>
      <Appbar.Header style={{ backgroundColor: COLORS.background }}>
        <Appbar.BackAction onPress={() => goBackOrHome(router, '/login')} />
        <Appbar.Content title={t('signup.accountRegistration')} titleStyle={{ fontWeight: '800' }} />
      </Appbar.Header>

      <ScrollView contentContainerStyle={GlobalStyles.scrollContent} showsVerticalScrollIndicator={true} keyboardShouldPersistTaps="handled">
        <Text style={styles.pageTitle}>{t('signup.newUser')}</Text>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>{t('signup.usernameLabel')}</Text>
          <TextInput
            value={form.username}
            autoComplete="username"
            mode="outlined"
            placeholder={t('signup.usernamePlaceholder')}
            style={styles.input}
            onChangeText={v => setForm({ ...form, username: v })}
          />
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>{t('signup.fullNameLabel')}</Text>
          <TextInput mode="outlined"
            value={form.full_name}
            autoComplete="name"
            style={styles.input}
            onChangeText={v => setForm({ ...form, full_name: v })} />
        </View>


        {/* EMAIL FIELD WITH LIVE FEEDBACK */}
        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>{t('signup.emailLabel')}</Text>
          <TextInput
            value={form.email}
            onChangeText={handleEmailChange}
            mode="outlined"
            style={styles.input}
            autoComplete="email"
            keyboardType="email-address"
            autoCapitalize="none"
            placeholder={t('signup.emailPlaceholder')}
            activeOutlineColor={emailStatus === 'taken' ? COLORS.error : COLORS.primary}
            error={emailStatus === 'taken'}
            right={
              emailStatus === 'checking' ? <TextInput.Icon icon={() => <ActivityIndicator size="small" />} /> :
                emailStatus === 'available' ? <TextInput.Icon icon="check-circle" color="green" /> :
                  emailStatus === 'taken' ? <TextInput.Icon icon="alert-circle" color="red" /> : null
            }
          />
          <HelperText type={(emailStatus === 'taken' || emailStatus === 'error') ? "error" : "info"} visible={emailStatus !== 'idle'}>
            {emailStatus === 'checking' ? t('signup.checkingEmail') :
              emailStatus === 'taken' ? t('signup.emailTaken') :
                emailStatus === 'available' ? t('signup.emailAvailable') :
                emailStatus === 'error' ? t('signup.emailInvalid') : ""}
          </HelperText>
        </View>

        {/* PHONE FIELD WITH LIVE FEEDBACK */}
        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>{t('signup.phoneLabel')}</Text>
          <TextInput
            value={phoneDigits}
            onChangeText={handlePhoneChange}
            mode="outlined"
            keyboardType="phone-pad"
            style={styles.input}
            placeholder={t('signup.phonePlaceholder')}
            left={<TextInput.Affix text="+" />}
            activeOutlineColor={phoneStatus === 'taken' ? COLORS.error : COLORS.primary}
            error={phoneStatus === 'taken' || phoneStatus === 'error'}
            right={
              phoneStatus === 'checking' ? <TextInput.Icon icon={() => <ActivityIndicator size="small" />} /> :
                phoneStatus === 'available' ? <TextInput.Icon icon="check-circle" color="green" /> :
                  phoneStatus === 'taken' ? <TextInput.Icon icon="alert-circle" color="red" /> : null
            }
          />
          {/* Always visible — the country-code hint is the whole point, so it
              must not vanish the moment the user starts typing. */}
          <HelperText type={(phoneStatus === 'taken' || phoneStatus === 'error') ? "error" : "info"} visible>
            {phoneStatus === 'taken' ? t('signup.phoneTaken') :
              phoneStatus === 'available' ? t('signup.phoneAvailable') :
                phoneStatus === 'error' ? t('signup.phoneInvalid') : t('signup.phoneHint')}
          </HelperText>
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>{t('signup.passwordLabel')}</Text>
          <TextInput
            value={form.password}
            mode="outlined"
            secureTextEntry
            style={styles.input}
            onChangeText={v => setForm({ ...form, password: v })} />
        </View>

        {/* Only worth showing once SMS can actually be delivered — while the
            SNS sandbox is on, a text reaches nobody, so email is the only
            honest option and the choice is hidden rather than offered-but-broken. */}
        {SMS_VERIFICATION_ENABLED && (
          <View style={styles.fieldContainer}>
            <Text style={styles.fieldLabel}>{t('signup.verifyViaLabel')}</Text>
            <SegmentedButtons
              value={verifyVia}
              onValueChange={v => setVerifyVia(v as 'sms' | 'email')}
              buttons={[
                { value: 'sms', label: t('signup.verifyViaSms'), icon: 'cellphone-message' },
                { value: 'email', label: t('signup.verifyViaEmail'), icon: 'email-outline' },
              ]}
            />
            <HelperText type="info" visible>
              {verifyVia === 'sms' ? t('signup.verifyViaSmsHint') : t('signup.verifyViaEmailHint')}
            </HelperText>
          </View>
        )}

        <View style={styles.sectionHeader}><Text style={styles.sectionHeaderText}>{t('signup.medicalProfileSection')}</Text></View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>{t('signup.genderLabel')}</Text>
          <Menu
            visible={menus.gender}
            onDismiss={() => setMenus({ ...menus, gender: false })}
            anchor={
              <Button mode="outlined" onPress={() => setMenus({ ...menus, gender: true })} style={styles.pickerBtn} textColor={form.gender_id ? COLORS.ink : COLORS.slate}>
                {genders.find(c => c.id === form.gender_id)?.name || t('common.selectPlaceholder')}
              </Button>
            }
          >
            {genders.map(g => <Menu.Item key={g.id} onPress={() => { setForm({ ...form, gender_id: g.id }); setMenus({ ...menus, gender: false }); }} title={g.name} />)}
          </Menu>
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>{t('signup.conditionLabel')}</Text>
          <Menu
            visible={menus.condition}
            onDismiss={() => setMenus({ ...menus, condition: false })}
            anchor={
              <Button mode="outlined" onPress={() => setMenus({ ...menus, condition: true })} style={styles.pickerBtn} textColor={form.condition_id ? COLORS.ink : COLORS.slate}>
                {conditions.find(c => c.id === form.condition_id)?.name || t('common.selectPlaceholder')}
              </Button>
            }
          >
            {conditions.map(c => <Menu.Item key={c.id} onPress={() => { setForm({ ...form, condition_id: c.id }); setMenus({ ...menus, condition: false }); }} title={c.name} />)}
          </Menu>
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>{t('signup.birthDateLabel')}</Text>
          <Pressable onPress={() => setShowDatePicker(true)}>
            <Surface style={styles.dateSurface} elevation={0}>
              <MaterialCommunityIcons name="calendar-account" size={20} color={COLORS.primary} style={{ marginRight: 12 }} />
              <Text style={styles.dateText}>{form.birth_date.toLocaleDateString()}</Text>
            </Surface>
          </Pressable>
        </View>

        <PlatformDatePicker
          visible={showDatePicker}
          value={form.birth_date}
          mode="date"
          maximumDate={today}
          onConfirm={d => { setForm({ ...form, birth_date: d }); setShowDatePicker(false); }}
          onDismiss={() => setShowDatePicker(false)}
        />

        <Button mode="contained" onPress={handleSignUp} loading={loading} style={styles.saveButton} disabled={loading || emailStatus === 'taken' || emailStatus === 'error' || phoneStatus === 'taken' || phoneStatus === 'error'}>
          {t('signup.register')}
        </Button>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  centeredContent: { justifyContent: 'center', alignItems: 'center', padding: 30 },
  pageTitle: { fontSize: 28, fontWeight: '800', color: COLORS.ink, marginBottom: 24 },
  fieldContainer: { marginBottom: 12 },
  fieldLabel: { fontSize: 13, fontWeight: '700', color: COLORS.slate, marginBottom: 6, marginLeft: 4 },
  input: { backgroundColor: 'white' },
  pickerBtn: { borderRadius: RADIUS.md, backgroundColor: 'white', borderColor: '#E2E8F0', height: 50, justifyContent: 'center' },
  dateSurface: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'white', height: 50, borderRadius: RADIUS.md, borderWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 16 },
  dateText: { fontSize: 16, color: COLORS.ink, fontWeight: '600' },
  sectionHeader: { marginTop: 20, marginBottom: 12, borderLeftWidth: 4, borderLeftColor: COLORS.primary, paddingLeft: 12 },
  sectionHeaderText: { fontSize: 11, fontWeight: '800', color: COLORS.primary, letterSpacing: 1 },
  saveButton: { marginTop: 30, borderRadius: 16, height: 56, justifyContent: 'center', ...SHADOWS.medium },
  stepTitle: { fontWeight: '800', color: COLORS.ink, marginTop: 20 },
  stepSubtitle: { textAlign: 'center', color: COLORS.slate, marginVertical: 10, lineHeight: 20 },
  spamHint: { textAlign: 'center', color: COLORS.slate, fontSize: 13, marginBottom: 20, lineHeight: 18 },
  codeInput: { backgroundColor: 'white', width: '100%', textAlign: 'center', fontSize: 26, fontWeight: 'bold', letterSpacing: 10, marginBottom: 20 },
  confirmError: { color: COLORS.error, textAlign: 'center', marginBottom: 12, fontWeight: '600' },
  confirmNote: { color: COLORS.primary, textAlign: 'center', marginBottom: 12, fontWeight: '600' },
  primaryBtn: { width: '100%', borderRadius: 16, height: 56, justifyContent: 'center' }
});