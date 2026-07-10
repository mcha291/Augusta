import { MaterialCommunityIcons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { confirmSignUp, resendSignUpCode, signIn, signOut, signUp } from 'aws-amplify/auth';
import { useRouter } from 'expo-router';
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
  Surface,
  Text,
  TextInput
} from 'react-native-paper';
import { GeneralOption } from '../constants/interfaces';

// Design System
import { COLORS, RADIUS, SHADOWS } from '../constants/theme';
import { useAuth } from '../context/AuthContext';
import { GlobalStyles } from '../styles/globalstyles';
import { apiRequest } from '../utils/api';

const BASE_URL = 'https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws';

export default function SignupScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { user, checkUser } = useAuth();
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
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [menus, setMenus] = useState({ gender: false, condition: false });

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
      const checkUrl = `${BASE_URL}/check-availability?email=${encodeURIComponent(cleanEmail)}&phone_number=${encodeURIComponent(cleanPhone)}`;
      const checkRes = await fetch(checkUrl);
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
      await signUp({
        username: cleanUser,
        password: cleanPass,
        options: {
          userAttributes: {
            email: cleanEmail,
            name: form.full_name,
            ...(cleanPhone ? { phone_number: cleanPhone } : {}),
          }
        }
      });
      setStep('confirm');
    } catch (e: any) {
      notifyUser(e.name || t('signup.accessDeniedTitle'), e.message);
    } finally {
      setLoading(false);
    }
  };

  // --- STEP 2: CONFIRM (brand new account) ---
  const handleConfirm = async () => {
    setLoading(true);
    try {
      await confirmSignUp({ username: form.username.trim(), confirmationCode: authCode });
      await signIn({ username: form.username.trim(), password: form.password });

      const regres = await apiRequest('/register-profile', {
        method: 'POST',
        body: {
          username: form.username.trim(),
          full_name: form.full_name,
          birth_date: form.birth_date.toISOString(),
          gender_id: form.gender_id,
          condition_id: form.condition_id,
          phone_number: form.phone_number.trim() || null,
          role: form.role
        }
      });

      const data = await regres.json();

      if (!regres.ok) {
        throw new Error(data.message || 'Registration failed');
      }

      router.replace('/(tabs)');
    } catch (e: any) {
      console.error("Setup Error:", e.message);
      try { await signOut(); } catch { }
      notifyUser(t('signup.setupErrorTitle'), e.message + "\n\n" + t('signup.verifiedButProfileFailed'));
      router.replace('/login');
    } finally {
      setLoading(false);
    }
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
          birth_date: form.birth_date.toISOString(),
          gender_id: form.gender_id,
          condition_id: form.condition_id,
          phone_number: cleanPhone || null,
          role: form.role
        }
      });

      if (!regres.ok) {
        const errBody = await regres.json().catch(() => ({}));
        throw new Error(errBody.error || t('signup.profileCreationFailed'));
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
    try {
      await resendSignUpCode({ username: form.username.trim() });
      notifyUser(t('signup.resentTitle'), t('signup.resentMessage', { email: form.email }));
    } catch (e: any) {
      notifyUser(t('common.error'), e.message);
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

  const handlePhoneChange = (v: string) => {
    setForm({ ...form, phone_number: v });
  };

  if (fetchingOptions) {
    return <View style={GlobalStyles.centered}><ActivityIndicator color={COLORS.primary} /></View>;
  }

  if (step === 'confirm') {
    return (
      <View style={[GlobalStyles.container, styles.centeredContent]}>
        <MaterialCommunityIcons name="email-seal" size={80} color={COLORS.primary} />
        <Text variant="headlineMedium" style={styles.stepTitle}>{t('signup.confirmIdentity')}</Text>
        <Text style={styles.stepSubtitle}>{t('signup.verificationCodeSentTo', { email: form.email })}</Text>

        <TextInput
          mode="outlined"
          placeholder={t('signup.codePlaceholder')}
          value={authCode}
          onChangeText={setAuthCode}
          keyboardType="number-pad"
          style={styles.codeInput}
        />

        <Button mode="contained" onPress={handleConfirm} loading={loading} style={styles.primaryBtn}>
          {t('signup.activateAccount')}
        </Button>
        <Button mode="text" onPress={handleResend} textColor={COLORS.slate}>
          {t('signup.resendCode')}
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

        <ScrollView contentContainerStyle={GlobalStyles.scrollContent} showsVerticalScrollIndicator={true}>
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

          {showDatePicker && (
            <DateTimePicker value={form.birth_date} mode="date" display="default" onChange={(e, d) => { setShowDatePicker(false); if (d) setForm({ ...form, birth_date: d }); }} />
          )}

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

      <ScrollView contentContainerStyle={GlobalStyles.scrollContent} showsVerticalScrollIndicator={true}>
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
            value={form.phone_number}
            onChangeText={handlePhoneChange}
            mode="outlined"
            placeholder={t('signup.phonePlaceholder')}
            activeOutlineColor={phoneStatus === 'taken' ? COLORS.error : COLORS.primary}
            error={phoneStatus === 'taken'}
            right={
              phoneStatus === 'checking' ? <TextInput.Icon icon={() => <ActivityIndicator size="small" />} /> :
                phoneStatus === 'available' ? <TextInput.Icon icon="check-circle" color="green" /> :
                  phoneStatus === 'taken' ? <TextInput.Icon icon="alert-circle" color="red" /> : null
            }
          />
          <HelperText type={phoneStatus === 'taken' ? "error" : "info"} visible={phoneStatus !== 'idle'}>
            {phoneStatus === 'taken' ? t('signup.phoneTaken') :
              phoneStatus === 'available' ? t('signup.phoneAvailable') :
                phoneStatus === 'error' ? t('signup.phoneInvalid') : ""}
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

        {showDatePicker && (
          <DateTimePicker value={form.birth_date} mode="date" display="default" onChange={(e, d) => { setShowDatePicker(false); if (d) setForm({ ...form, birth_date: d }); }} />
        )}

        <Button mode="contained" onPress={handleSignUp} loading={loading} style={styles.saveButton} disabled={loading || emailStatus === 'taken' || phoneStatus === 'taken'}>
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
  codeInput: { backgroundColor: 'white', width: '100%', textAlign: 'center', fontSize: 26, fontWeight: 'bold', letterSpacing: 10, marginBottom: 20 },
  primaryBtn: { width: '100%', borderRadius: 16, height: 56, justifyContent: 'center' }
});