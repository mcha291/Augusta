import { MaterialCommunityIcons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { confirmSignUp, resendSignUpCode, signIn, signOut, signUp } from 'aws-amplify/auth';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
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

export default function SignupScreen() {
  const router = useRouter();
  const { user, checkUser } = useAuth();

  // 'profile' = Cognito account already exists (id === 0) and just needs an RDS profile
  const [step, setStep] = useState<'form' | 'confirm' | 'profile'>('form');
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

    if (!cleanUser || !cleanEmail || !cleanPass || !form.full_name || !form.gender_id) {
      notifyUser("Required", "Please fill in all mandatory (*) fields.");
      return;
    }

    if (cleanUser.includes('@')) {
      notifyUser("Invalid Codename", "Your username cannot be an email address.");
      return;
    }

    if (cleanPhone && !validatePhone(cleanPhone)) {
      notifyUser("Invalid Phone", "Phone number must be in international format (e.g., +61412345678).");
      return;
    }

    setLoading(true);
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
      notifyUser(e.name || "Access Denied", e.message);
    } finally {
      setLoading(false);
    }
  };

  // --- STEP 2: CONFIRM (brand new account) ---
  const handleConfirm = async () => {
    setLoading(true);
    try {
      await confirmSignUp({
        username: form.username.trim(),
        confirmationCode: authCode
      });

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

      if (!regres.ok) {
        const errBody = await regres.json().catch(() => ({}));
        throw new Error(errBody.error || "Profile creation failed on the server.");
      }

      router.replace('/(tabs)');
    } catch (e: any) {
      console.error("Setup Error:", e.message);

      // Unlike before, we do NOT sign the user out here. They're now correctly
      // authenticated in Cognito; _layout.tsx will detect the missing RDS
      // profile (id === 0) and route them straight back into the 'profile'
      // step above so they can retry without redoing signup from scratch.
      notifyUser(
        "Setup Error",
        e.message + "\n\nYour account was verified, but profile creation failed. Please try again."
      );

      await checkUser(); // refresh auth state — this will flip step to 'profile' via the effect above
    } finally {
      setLoading(false);
    }
  };

  // --- STEP 3: COMPLETE PROFILE (Cognito already authenticated, id === 0) ---
  const handleCompleteProfile = async () => {
    if (!form.full_name || !form.gender_id) {
      notifyUser("Required", "Please fill in all mandatory (*) fields.");
      return;
    }

    const cleanPhone = form.phone_number.trim();
    if (cleanPhone && !validatePhone(cleanPhone)) {
      notifyUser("Invalid Phone", "Phone number must be in international format (e.g., +61412345678).");
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
        throw new Error(errBody.error || "Profile creation failed on the server.");
      }

      await checkUser(); // pulls the new RDS profile in, sets user.id !== 0
      router.replace('/(tabs)');
    } catch (e: any) {
      console.error("Profile completion error:", e.message);
      notifyUser("Setup Error", e.message || "Failed to complete your profile. Please try again.");
      // Stay authenticated and on this screen so they can retry — no signOut here.
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    try {
      await resendSignUpCode({ username: form.username.trim() });
      notifyUser("Resent", "Verification code sent to " + form.email);
    } catch (e: any) {
      notifyUser("Error", e.message);
    }
  };

  if (fetchingOptions) {
    return <View style={GlobalStyles.centered}><ActivityIndicator color={COLORS.primary} /></View>;
  }

  if (step === 'confirm') {
    return (
      <View style={[GlobalStyles.container, styles.centeredContent]}>
        <MaterialCommunityIcons name="email-seal" size={80} color={COLORS.primary} />
        <Text variant="headlineMedium" style={styles.stepTitle}>Confirm Identity</Text>
        <Text style={styles.stepSubtitle}>Verification code sent to: {form.email}</Text>

        <TextInput
          mode="outlined"
          placeholder="Code"
          value={authCode}
          onChangeText={setAuthCode}
          keyboardType="number-pad"
          style={styles.codeInput}
        />

        <Button mode="contained" onPress={handleConfirm} loading={loading} style={styles.primaryBtn}>
          Activate Profile
        </Button>
        <Button mode="text" onPress={handleResend} textColor={COLORS.slate}>
          Resend Verification Code
        </Button>
      </View>
    );
  }

  if (step === 'profile') {
    return (
      <View style={GlobalStyles.container}>
        <Appbar.Header style={{ backgroundColor: COLORS.background }}>
          <Appbar.Content title="Complete Your Profile" titleStyle={{ fontWeight: '800' }} />
        </Appbar.Header>

        <ScrollView contentContainerStyle={GlobalStyles.scrollContent} showsVerticalScrollIndicator={true}>
          <Text style={styles.pageTitle}>Almost there</Text>
          <Text style={styles.stepSubtitle}>
            Your account ({form.email || form.username}) is verified. Finish setting up your
            medical profile to continue.
          </Text>

          <View style={[styles.fieldContainer, { marginTop: 20 }]}>
            <Text style={styles.fieldLabel}>Full Name *</Text>
            <TextInput
              mode="outlined"
              value={form.full_name}
              autoComplete="name"
              style={styles.input}
              onChangeText={v => setForm({ ...form, full_name: v })}
            />
          </View>

          <View style={styles.fieldContainer}>
            <Text style={styles.fieldLabel}>Phone Number</Text>
            <TextInput
              value={form.phone_number}
              autoComplete="tel"
              keyboardType="phone-pad"
              mode="outlined"
              placeholder="+886912345678"
              style={styles.input}
              onChangeText={v => setForm({ ...form, phone_number: v })}
            />
            <HelperText type="info">Must start with + and country code</HelperText>
          </View>

          <View style={styles.sectionHeader}><Text style={styles.sectionHeaderText}>MEDICAL PROFILE</Text></View>

          <View style={styles.fieldContainer}>
            <Text style={styles.fieldLabel}>Gender *</Text>
            <Menu
              visible={menus.gender}
              onDismiss={() => setMenus({ ...menus, gender: false })}
              anchor={
                <Button mode="outlined" onPress={() => setMenus({ ...menus, gender: true })} style={styles.pickerBtn} textColor={form.gender_id ? COLORS.ink : COLORS.slate}>
                  {genders.find(c => c.id === form.gender_id)?.name || "Select..."}
                </Button>
              }
            >
              {genders.map(g => <Menu.Item key={g.id} onPress={() => { setForm({ ...form, gender_id: g.id }); setMenus({ ...menus, gender: false }); }} title={g.name} />)}
            </Menu>
          </View>

          <View style={styles.fieldContainer}>
            <Text style={styles.fieldLabel}>Condition</Text>
            <Menu
              visible={menus.condition}
              onDismiss={() => setMenus({ ...menus, condition: false })}
              anchor={
                <Button mode="outlined" onPress={() => setMenus({ ...menus, condition: true })} style={styles.pickerBtn} textColor={form.condition_id ? COLORS.ink : COLORS.slate}>
                  {conditions.find(c => c.id === form.condition_id)?.name || "Select..."}
                </Button>
              }
            >
              {conditions.map(c => <Menu.Item key={c.id} onPress={() => { setForm({ ...form, condition_id: c.id }); setMenus({ ...menus, condition: false }); }} title={c.name} />)}
            </Menu>
          </View>

          <View style={styles.fieldContainer}>
            <Text style={styles.fieldLabel}>Birth Date *</Text>
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
            Complete Profile
          </Button>

          <Button
            mode="text"
            onPress={async () => { await signOut(); router.replace('/login'); }}
            textColor={COLORS.slate}
            style={{ marginTop: 10 }}
          >
            Sign Out
          </Button>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={GlobalStyles.container}>
      <Appbar.Header style={{ backgroundColor: COLORS.background }}>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title="Account Registration" titleStyle={{ fontWeight: '800' }} />
      </Appbar.Header>

      <ScrollView contentContainerStyle={GlobalStyles.scrollContent} showsVerticalScrollIndicator={true}>
        <Text style={styles.pageTitle}>New User</Text>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Username *</Text>
          <TextInput
            value={form.username}
            autoComplete="username"
            mode="outlined"
            placeholder="e.g. Twilight"
            style={styles.input}
            onChangeText={v => setForm({ ...form, username: v })}
          />
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Full Name *</Text>
          <TextInput mode="outlined"
            value={form.full_name}
            autoComplete="name"
            style={styles.input}
            onChangeText={v => setForm({ ...form, full_name: v })} />
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Email Address *</Text>
          <TextInput
            value={form.email}
            autoComplete="email"
            keyboardType="email-address"
            mode="outlined"
            autoCapitalize="none"
            placeholder="name@gmail.com"
            style={styles.input}
            onChangeText={v => setForm({ ...form, email: v })}
          />
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Phone Number *</Text>
          <TextInput
            value={form.phone_number}
            autoComplete="tel"
            keyboardType="phone-pad"
            mode="outlined"
            placeholder="+886912345678"
            style={styles.input}
            onChangeText={v => setForm({ ...form, phone_number: v })}
          />
          <HelperText type="info">Must start with + and country code</HelperText>
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Password *</Text>
          <TextInput
            value={form.password}
            mode="outlined"
            secureTextEntry
            style={styles.input}
            onChangeText={v => setForm({ ...form, password: v })} />
        </View>

        <View style={styles.sectionHeader}><Text style={styles.sectionHeaderText}>MEDICAL PROFILE</Text></View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Gender *</Text>
          <Menu
            visible={menus.gender}
            onDismiss={() => setMenus({ ...menus, gender: false })}
            anchor={
              <Button mode="outlined" onPress={() => setMenus({ ...menus, gender: true })} style={styles.pickerBtn} textColor={form.gender_id ? COLORS.ink : COLORS.slate}>
                {genders.find(c => c.id === form.gender_id)?.name || "Select..."}
              </Button>
            }
          >
            {genders.map(g => <Menu.Item key={g.id} onPress={() => { setForm({ ...form, gender_id: g.id }); setMenus({ ...menus, gender: false }); }} title={g.name} />)}
          </Menu>
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Condition *</Text>
          <Menu
            visible={menus.condition}
            onDismiss={() => setMenus({ ...menus, condition: false })}
            anchor={
              <Button mode="outlined" onPress={() => setMenus({ ...menus, condition: true })} style={styles.pickerBtn} textColor={form.condition_id ? COLORS.ink : COLORS.slate}>
                {conditions.find(c => c.id === form.condition_id)?.name || "Select..."}
              </Button>
            }
          >
            {conditions.map(c => <Menu.Item key={c.id} onPress={() => { setForm({ ...form, condition_id: c.id }); setMenus({ ...menus, condition: false }); }} title={c.name} />)}
          </Menu>
        </View>

        <View style={styles.fieldContainer}>
          <Text style={styles.fieldLabel}>Birth Date *</Text>
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

        <Button mode="contained" onPress={handleSignUp} loading={loading} style={styles.saveButton}>
          Register
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