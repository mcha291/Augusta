import { COLORS } from '@/constants/theme';
import { changeLanguage, LANGUAGE_LABELS, SUPPORTED_LANGUAGES, SupportedLanguage } from '@/i18n';
import { apiRequest } from '@/utils/api';
import { apiErrorMessage, describeApiFailure } from '@/utils/api-errors';
import { confirmUserAttribute, fetchUserAttributes, sendUserAttributeVerificationCode } from 'aws-amplify/auth';
import { useFocusEffect, useRouter } from 'expo-router';
import { goBackOrHome } from '@/utils/navigation';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Appbar, Avatar, Button, Dialog, Divider, List, Menu, Portal, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import ActiveProfileBadge from '../components/active-profile-badge';
import PlatformDatePicker from '../components/platform-date-picker';
import { useAuth } from '../context/AuthContext';
import {
  DEFAULT_MEAL_TIMES,
  MEAL_LABEL_KEY,
  TIMING_LABEL_KEY,
  dateToTimeString,
  regenerateForMealTimes,
  timeStringToDate,
  type MealKey,
  type MealTimes,
} from '../utils/meal-alarms';
import { scheduleMedicationNotifications } from '../utils/notification-helper';

interface PendingRequest {
  id: number;
  full_name: string;
  username: string;
}

/**
 * 3.2 — one live relationship, seen from the caller's end.
 *
 * `role` describes the *other* party: `caregiver` means they can see my
 * records, `dependent` means I can see theirs. The server computes it so no
 * screen has to compare ids to work out which name it is showing.
 */
interface GrantedAccess {
  id: number;
  status: 'pending' | 'active';
  role: 'caregiver' | 'dependent';
  other_user_id: number;
  other_username: string | null;
  other_full_name: string | null;
}
interface Gender {
  id: number;
  name: string;
}

interface Condition {
  id: number;
  name: string;
  description?: string;
}
const MEAL_ROWS: { key: MealKey; column: keyof MealTimes; icon: string }[] = [
  { key: 'breakfast', column: 'breakfast_time', icon: 'coffee-outline' },
  { key: 'lunch', column: 'lunch_time', icon: 'food-outline' },
  { key: 'dinner', column: 'dinner_time', icon: 'silverware-fork-knife' },
  { key: 'bedtime', column: 'bedtime_time', icon: 'bed-outline' },
];

export default function ProfileScreen() {
  const { user, logout, activeDependent, loadDependents } = useAuth();
  const theme = useTheme();
  const router = useRouter();
  const { t, i18n } = useTranslation();

  // Data States
  const [handshakeInput, setHandshakeInput] = useState('');
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  // 3.2 — "who can see my records", and the revoke action next to each one.
  const [granted, setGranted] = useState<GrantedAccess[]>([]);
  const [revoking, setRevoking] = useState<number | null>(null);
  const [genderList, setGenderList] = useState<Gender[]>([]);
  const [conditionList, setConditionList] = useState<Condition[]>([]);
  const [loadingLookups, setLoadingLookups] = useState(true);
  const [langMenuVisible, setLangMenuVisible] = useState(false);

  // Meal times (2.7). These exist so "before dinner" is computable at all —
  // without them a meal-relative reminder cannot be turned into a clock time,
  // which is why meal selections were never scheduled.
  const [mealTimes, setMealTimes] = useState<MealTimes>(DEFAULT_MEAL_TIMES);
  const [editingMeal, setEditingMeal] = useState<MealKey | null>(null);
  const [savingMealTimes, setSavingMealTimes] = useState(false);

  // Email verification. `null` means "not looked up yet" and is deliberately
  // distinct from `false`: an unreachable Cognito must not render the account
  // as unverified, because the fix it offers — send me a code — would fail for
  // the same reason and the user would be told their email is bad when it is
  // the network that is bad.
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [verifyDialogVisible, setVerifyDialogVisible] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [confirmingCode, setConfirmingCode] = useState(false);

  const notifyUser = (title: string, message: string) => {
    if (Platform.OS === 'web') window.alert(`${title}: ${message}`);
    else Alert.alert(title, message);
  };

  const labelForMeal = (meal: MealKey, timing: 'before' | 'after' | 'at'): string =>
    timing === 'at'
      ? t(MEAL_LABEL_KEY[meal])
      : t('medicationReminderForm.mealAlarmLabel', {
          timing: t(TIMING_LABEL_KEY[timing]),
          meal: t(MEAL_LABEL_KEY[meal]),
        });

  // 1. Fetch Lookup Tables (Genders/Conditions) and Pending Requests
  const loadProfileData = async () => {
    try {
      const [gRes, cRes, pRes, mRes, aRes] = await Promise.all([
        apiRequest('/genders'),
        apiRequest('/conditions'),
        apiRequest('/relationships/pending'),
        apiRequest('/meal-times', {}, activeDependent?.id),
        // 3.2. Deliberately *not* scoped to `activeDependent`: this is about the
        // signed-in account's own consents, and viewing a dependent's records
        // does not make you the person who may withdraw theirs.
        apiRequest('/relationships/granted'),
      ]);

      const gData = await gRes.json();
      const cData = await cRes.json();
      const pData = await pRes.json();

      setGenderList(Array.isArray(gData) ? gData : []);
      setConditionList(Array.isArray(cData) ? cData : []);
      setPendingRequests(Array.isArray(pData) ? pData : []);

      if (aRes.ok) {
        const aData = await aRes.json();
        setGranted(Array.isArray(aData) ? aData : []);
      }

      if (mRes.ok) setMealTimes({ ...DEFAULT_MEAL_TIMES, ...(await mRes.json()) });
    } catch (e) {
      console.error("Profile load error:", e);
    } finally {
      setLoadingLookups(false);
    }
  };

  useFocusEffect(useCallback(() => { loadProfileData(); }, [activeDependent?.id]));

  /**
   * Whether Cognito considers this account's email address verified.
   *
   * **Why this screen needs to ask at all.** The pool marks `phone_number`
   * required but only auto-verifies `email`, so registration emails the code
   * and a completed signup arrives here already verified. Three routes do not:
   * an account created administratively (`admin-create-user`), one whose
   * confirmation was completed against a different attribute, and — once the
   * address is editable — any future change to it, since `email` is the sole
   * entry in the pool's `AttributesRequireVerificationBeforeUpdate`.
   *
   * Unverified is not cosmetic. `AccountRecoverySetting` lists
   * `verified_email` first, so an account with an unverified address has no
   * working password-reset route.
   *
   * Read from Cognito rather than from the RDS profile on purpose: RDS stores
   * the address, but only Cognito knows whether it has been proven.
   */
  const loadEmailVerified = useCallback(async () => {
    try {
      const attrs = await fetchUserAttributes();
      setEmailVerified(attrs.email_verified === 'true');
    } catch (e) {
      // Leave the previous answer standing — see the `null` note on the state.
      console.warn('[profile] could not read email verification state', e);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadEmailVerified(); }, [loadEmailVerified]));

  const startEmailVerification = async () => {
    setSendingCode(true);
    try {
      const { destination, deliveryMedium } = await sendUserAttributeVerificationCode({
        userAttributeKey: 'email',
      });
      // Logged for the same reason signup logs it: when someone says "no code
      // arrived", this is the line that says where it actually went.
      console.log('[profile] email verification code sent via', deliveryMedium, 'to', destination);
      setVerifyCode('');
      setVerifyDialogVisible(true);
    } catch (e: any) {
      console.error('[profile] could not send email verification code', e);
      notifyUser(t('common.error'), e?.message || t('profile.emailVerifySendFailed'));
    } finally {
      setSendingCode(false);
    }
  };

  const submitEmailVerification = async () => {
    const code = verifyCode.trim();
    if (!code) return;

    setConfirmingCode(true);
    try {
      await confirmUserAttribute({ userAttributeKey: 'email', confirmationCode: code });
      setVerifyDialogVisible(false);
      setVerifyCode('');
      setEmailVerified(true);
      notifyUser(t('profile.emailVerifiedTitle'), t('profile.emailVerifiedMessage'));
    } catch (e: any) {
      // The dialog stays open: a mistyped code is the common case and closing
      // it would mean sending a whole new code to fix a typo.
      console.error('[profile] email verification failed', e);
      notifyUser(t('common.error'), e?.message || t('profile.emailVerifyFailed'));
    } finally {
      setConfirmingCode(false);
    }
  };

  /**
   * Save one meal time, then regenerate every reminder whose alarms were
   * derived from it.
   *
   * The regeneration is the part that's easy to leave out and hard to notice
   * missing: moving dinner an hour later has to move the "before dinner" doses
   * with it, or the setting and the alarms quietly disagree. Hand-set alarms
   * are left exactly where they are — that's what `alarm_sources` is for.
   */
  const saveMealTime = async (meal: MealKey, picked: Date) => {
    const column = `${meal === 'bedtime' ? 'bedtime' : meal}_time` as keyof MealTimes;
    const next: MealTimes = { ...mealTimes, [column]: dateToTimeString(picked) };

    setEditingMeal(null);
    setSavingMealTimes(true);
    const previous = mealTimes;
    setMealTimes(next); // optimistic

    try {
      const res = await apiRequest('/meal-times', {
        method: 'PUT',
        body: { [column]: dateToTimeString(picked) },
      }, activeDependent?.id);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMealTimes({ ...DEFAULT_MEAL_TIMES, ...(await res.json()) });

      await regenerateDerivedAlarms(next);
    } catch (e) {
      console.error('Meal time save failed:', e);
      setMealTimes(previous);
      notifyUser(t('common.error'), t('profile.mealTimeSaveFailed'));
    } finally {
      setSavingMealTimes(false);
    }
  };

  const regenerateDerivedAlarms = async (times: MealTimes) => {
    const res = await apiRequest('/medication-reminders', {}, activeDependent?.id);
    if (!res.ok) return;

    const reminders = await res.json();
    if (!Array.isArray(reminders)) return;

    for (const reminder of reminders) {
      const next = regenerateForMealTimes(reminder, times, labelForMeal);
      if (!next) continue; // nothing derived from a meal changed

      const updated = await apiRequest('/medication-reminders', {
        method: 'PUT',
        body: { id: reminder.id, ...next },
      }, activeDependent?.id);

      if (!updated.ok) {
        console.warn('Could not regenerate alarms for reminder', reminder.id);
        continue;
      }

      if (Platform.OS !== 'web') {
        await scheduleMedicationNotifications({ ...reminder, ...next }, { viewerUserId: user?.id });
      }
    }
  };

  // 2. Mapping Logic: Find Name by ID
  const getGenderName = () => {
    if (!user?.gender_id) return t('profile.notSpecified');
    return genderList.find(g => g.id === user.gender_id)?.name || t('common.loading');
  };

  const getConditionName = () => {
    if (!user?.condition_id) return t('profile.generalHealth');
    return conditionList.find(c => c.id === user.condition_id)?.name || t('common.loading');
  };

  const respondToRequest = async (id: number, action: 'active' | 'decline') => {
    const res = await apiRequest('/relationships/respond', {
      method: 'POST',
      body: { request_id: id, action, provided_code: handshakeInput.toUpperCase() }
    });
    if (res.ok) {
      loadProfileData();
      setHandshakeInput('');
      Alert.alert(t('profile.authorizedTitle'), t('profile.authorizedMessage'));
    } else {
      // 6.2 — every failure here reported "Handshake code incorrect", because
      // that was the only thing this screen could guess. It is now the only one
      // that says so: a wrong code is a 403 with its own code, while a request
      // that has since been withdrawn or answered on another device is a 404
      // that says *that* instead of blaming the user for typing correctly.
      Alert.alert(t('profile.accessDeniedTitle'), apiErrorMessage(await describeApiFailure(res), t));
    }
  };

  const nameFor = (row: GrantedAccess) => row.other_full_name || row.other_username || `#${row.other_user_id}`;

  /**
   * 3.2 — withdraw access, after an explicit confirmation.
   *
   * **Confirmed rather than immediate**, unlike the decline button above it. A
   * declined request has cost nobody anything; revoking is the action that
   * silences a caregiver's alarms for a patient who may be relying on them
   * (D-1), and it is one tap away from a list of names.
   *
   * `loadDependents()` afterwards is what makes the *device* act on it: the
   * launch reconcile sweeps alarms belonging to anyone no longer in that list,
   * so refreshing it here is how a caregiver revoking their own access sees
   * their copies disappear without waiting for a relaunch. On the dependent's
   * device it is a no-op, which is why it is not conditional — the caregiver's
   * own devices are reached by the server's `access-revoked` push instead.
   */
  const revokeAccess = (row: GrantedAccess) => {
    const name = nameFor(row);
    const confirmTitle = t('profile.revokeConfirmTitle');
    const confirmBody = row.role === 'caregiver'
      ? t('profile.revokeConfirmCaregiver', { name })
      : t('profile.revokeConfirmDependent', { name });

    const run = async () => {
      setRevoking(row.id);
      try {
        const res = await apiRequest('/relationships/revoke', {
          method: 'POST',
          body: { relationship_id: row.id },
        });
        if (!res.ok) {
          // 6.2 — carries the failure rather than only its status, so the
          // catch below can say which failure it was. An already-revoked
          // relationship is a 200 (3.2 made it idempotent), so anything
          // arriving here is genuinely worth reporting.
          notifyUser(t('common.error'), apiErrorMessage(await describeApiFailure(res), t));
          return;
        }
        // Dropped locally rather than waiting for the refetch, so the row does
        // not sit there looking un-revoked while the list reloads.
        setGranted((rows) => rows.filter((r) => r.id !== row.id));
        await loadDependents();
        loadProfileData();
      } catch (e) {
        console.error('Revoke failed:', e);
        notifyUser(t('common.error'), t('profile.revokeFailed'));
      } finally {
        setRevoking(null);
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm(`${confirmTitle}\n\n${confirmBody}`)) run();
      return;
    }
    Alert.alert(confirmTitle, confirmBody, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('profile.revoke'), style: 'destructive', onPress: run },
    ]);
  };

  if (!user) return null;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Appbar.Header elevated style={{ backgroundColor: COLORS.background }}>
        <Appbar.BackAction onPress={() => goBackOrHome(router)} />
        <Appbar.Content title={t('profile.title')} titleStyle={{ fontWeight: '800' }} />
        <ActiveProfileBadge />
      </Appbar.Header>

      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        
        {/* Profile Header */}
        <View style={styles.header}>
          <Avatar.Text size={80} label={user.username?.substring(0, 2).toUpperCase() || '??'} />
          <Text variant="headlineMedium" style={styles.username}>{user.full_name}</Text>
          <Text variant="bodyLarge" style={{ color: theme.colors.primary }}>@{user.username}</Text>
        </View>

        {/* Pending Requests Section */}
        {pendingRequests.map((req: any) => (
          <Surface key={req.id} style={styles.requestCard} elevation={2}>
            <Text style={{ fontWeight: 'bold', color: COLORS.ink }}>{req.full_name} (@{req.username})</Text>
            <Text style={{ fontSize: 12, marginBottom: 10, color: COLORS.slate }}>{t('profile.requestingAccess')}</Text>
            <TextInput
              label={t('profile.handshakeCodeLabel')}
              placeholder={t('profile.handshakeCodePlaceholder')}
              mode="outlined"
              dense
              value={handshakeInput}
              onChangeText={setHandshakeInput}
              autoCapitalize="characters"
              style={{ backgroundColor: 'white' }}
            />
            <View style={styles.requestActions}>
              <Button onPress={() => respondToRequest(req.id, 'decline')} textColor="red">{t('profile.decline')}</Button>
              <Button mode="contained" onPress={() => respondToRequest(req.id, 'active')} buttonColor="#22C55E">{t('profile.verify')}</Button>
            </View>
          </Surface>
        ))}

        {/* 3.2 — who can see my records, and who I can see.
            Hidden entirely when empty rather than shown as an empty state: for a
            user with no caregivers this is a question they have never had to
            think about, and a permanent "nobody has access" panel invites them
            to. */}
        {granted.length > 0 && (
          <Surface style={styles.surface} elevation={1}>
            <List.Subheader style={styles.sectionSubheader}>{t('profile.accessSection')}</List.Subheader>
            <Text style={styles.sectionHint}>{t('profile.accessHint')}</Text>

            {granted.map((row, i) => (
              <React.Fragment key={row.id}>
                {i > 0 && <Divider />}
                <List.Item
                  title={nameFor(row)}
                  description={
                    row.status === 'pending'
                      ? t('profile.accessPending')
                      : row.role === 'caregiver'
                        ? t('profile.accessCanSeeMine')
                        : t('profile.accessICanSee')
                  }
                  left={p => (
                    <List.Icon
                      {...p}
                      icon={row.role === 'caregiver' ? 'shield-account-outline' : 'account-heart-outline'}
                      color={COLORS.primary}
                    />
                  )}
                  right={() => (
                    <Button
                      compact
                      textColor="red"
                      disabled={revoking != null}
                      loading={revoking === row.id}
                      onPress={() => revokeAccess(row)}
                    >
                      {t('profile.revoke')}
                    </Button>
                  )}
                />
              </React.Fragment>
            ))}
          </Surface>
        )}

        {/* Meal Times — what makes meal-relative reminders schedulable (2.7).
            Presented as an estimate the user adjusts, not a fact we know. */}
        <Surface style={styles.surface} elevation={1}>
          <List.Subheader style={styles.sectionSubheader}>{t('profile.mealTimesSection')}</List.Subheader>
          <Text style={styles.sectionHint}>{t('profile.mealTimesHint')}</Text>

          {MEAL_ROWS.map((row, i) => (
            <React.Fragment key={row.key}>
              {i > 0 && <Divider />}
              <List.Item
                title={t(MEAL_LABEL_KEY[row.key])}
                description={timeStringToDate(mealTimes[row.column]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                left={p => <List.Icon {...p} icon={row.icon} color={COLORS.primary} />}
                right={p => <List.Icon {...p} icon="pencil-outline" />}
                disabled={savingMealTimes}
                onPress={() => setEditingMeal(row.key)}
              />
            </React.Fragment>
          ))}
        </Surface>

        {editingMeal && (
          <PlatformDatePicker
            visible
            mode="time"
            value={timeStringToDate(mealTimes[MEAL_ROWS.find(r => r.key === editingMeal)!.column])}
            onConfirm={(picked) => saveMealTime(editingMeal, picked)}
            onDismiss={() => setEditingMeal(null)}
          />
        )}

        <Portal>
          <Dialog visible={verifyDialogVisible} onDismiss={() => setVerifyDialogVisible(false)}>
            <Dialog.Title>{t('profile.emailVerifyDialogTitle')}</Dialog.Title>
            <Dialog.Content>
              <Text variant="bodyMedium" style={{ marginBottom: 14 }}>
                {t('profile.emailVerifyDialogBody', { email: user.email })}
              </Text>
              <TextInput
                testID="profile-verify-email-code"
                mode="outlined"
                label={t('profile.emailVerifyCodeLabel')}
                value={verifyCode}
                onChangeText={setVerifyCode}
                keyboardType="number-pad"
                autoCapitalize="none"
                autoComplete="one-time-code"
              />
            </Dialog.Content>
            <Dialog.Actions>
              <Button onPress={() => setVerifyDialogVisible(false)} disabled={confirmingCode}>
                {t('common.cancel')}
              </Button>
              <Button
                testID="profile-verify-email-submit"
                onPress={submitEmailVerification}
                loading={confirmingCode}
                disabled={confirmingCode || !verifyCode.trim()}
              >
                {t('profile.emailVerifyConfirm')}
              </Button>
            </Dialog.Actions>
          </Dialog>
        </Portal>

        {/* Personal Details Surface */}
        <Surface style={styles.surface} elevation={1}>
          <List.Item title={t('profile.fullName')} description={user.full_name || t('common.notProvided')} left={p => <List.Icon {...p} icon="account" />} />
          <Divider />
          <List.Item
            title={t('profile.email')}
            description={emailVerified === false
              ? t('profile.emailNotVerified', { email: user.email })
              : user.email}
            left={p => <List.Icon {...p} icon="email" />}
            // `emailVerified === null` renders neither control: until Cognito
            // has answered, the account is neither confirmed good nor offered a
            // fix it might not need.
            right={p => emailVerified === false ? (
              <Button
                testID="profile-verify-email"
                mode="text"
                compact
                loading={sendingCode}
                disabled={sendingCode}
                onPress={startEmailVerification}
              >
                {t('profile.emailVerifyAction')}
              </Button>
            ) : emailVerified ? (
              <List.Icon {...p} icon="check-decagram" color={COLORS.primary} />
            ) : null}
          />
          <Divider />
          <List.Item
            title={t('profile.phoneNumber')}
            description={user?.phone_number || t('common.notProvided')}
            left={p => <List.Icon {...p} icon="phone" />}
          />
          <Divider />
          <List.Item
            title={t('profile.birthDate')}
            description={user.birth_date ? new Date(user.birth_date).toLocaleDateString() : t('common.notProvided')}
            left={p => <List.Icon {...p} icon="cake" />}
          />

          <Divider />

          {/* Mapped Gender Column */}
          <List.Item
            title={t('profile.gender')}
            description={getGenderName()}
            left={p => <List.Icon {...p} icon="human-male-female" />}
          />

          <Divider />

          {/* Mapped Condition Column */}
          <List.Item
            title={t('profile.condition')}
            description={getConditionName()}
            left={p => <List.Icon {...p} icon="clipboard-pulse-outline" />}
          />

          <Divider />

          <List.Item
            title={t('profile.managedAccounts')}
            description={t('profile.manageFamilyDesc')}
            left={p => <List.Icon {...p} icon="account-group-outline" color={COLORS.primary} />}
            right={p => <List.Icon {...p} icon="chevron-right" />}
            onPress={() => router.push('/managed-users')}
          />

          <Divider />

          <Menu
            visible={langMenuVisible}
            onDismiss={() => setLangMenuVisible(false)}
            anchor={
              <List.Item
                title={t('profile.language')}
                description={LANGUAGE_LABELS[i18n.language as SupportedLanguage] || LANGUAGE_LABELS.en}
                left={p => <List.Icon {...p} icon="translate" color={COLORS.primary} />}
                right={p => <List.Icon {...p} icon="chevron-right" />}
                onPress={() => setLangMenuVisible(true)}
              />
            }
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <Menu.Item
                key={lang}
                title={LANGUAGE_LABELS[lang]}
                onPress={() => { changeLanguage(lang); setLangMenuVisible(false); }}
              />
            ))}
          </Menu>
        </Surface>

        <Button
          mode="outlined"
          onPress={logout}
          icon="logout"
          style={styles.logoutBtn}
          textColor={theme.colors.error}
        >
          {t('profile.logout')}
        </Button>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 50 },
  header: { alignItems: 'center', marginBottom: 30 },
  username: { fontWeight: 'bold', marginTop: 10, color: COLORS.ink },
  surface: { borderRadius: 16, overflow: 'hidden', backgroundColor: 'white', marginBottom: 16 },
  sectionSubheader: { fontWeight: '800', color: COLORS.ink },
  sectionHint: { fontSize: 12, color: COLORS.slate, paddingHorizontal: 16, paddingBottom: 8, lineHeight: 17 },
  logoutBtn: { marginTop: 30, borderColor: 'red', borderRadius: 12 },
  requestCard: { 
    padding: 16, 
    backgroundColor: '#FFFBEB', 
    borderColor: '#F59E0B', 
    borderWidth: 1, 
    borderRadius: 12, 
    marginBottom: 20 
  },
  requestActions: { 
    flexDirection: 'row', 
    justifyContent: 'flex-end', 
    marginTop: 10, 
    gap: 8 
  }
});