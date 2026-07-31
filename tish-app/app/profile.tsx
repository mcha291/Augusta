import { COLORS } from '@/constants/theme';
import { changeLanguage, LANGUAGE_LABELS, SUPPORTED_LANGUAGES, SupportedLanguage } from '@/i18n';
import { apiRequest } from '@/utils/api';
import { useFocusEffect, useRouter } from 'expo-router';
import { goBackOrHome } from '@/utils/navigation';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Appbar, Avatar, Button, Divider, List, Menu, Surface, Text, TextInput, useTheme } from 'react-native-paper';
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
  const { user, logout, activeDependent } = useAuth();
  const theme = useTheme();
  const router = useRouter();
  const { t, i18n } = useTranslation();

  // Data States
  const [handshakeInput, setHandshakeInput] = useState('');
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
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
      const [gRes, cRes, pRes, mRes] = await Promise.all([
        apiRequest('/genders'),
        apiRequest('/conditions'),
        apiRequest('/relationships/pending'),
        apiRequest('/meal-times', {}, activeDependent?.id)
      ]);

      const gData = await gRes.json();
      const cData = await cRes.json();
      const pData = await pRes.json();

      setGenderList(Array.isArray(gData) ? gData : []);
      setConditionList(Array.isArray(cData) ? cData : []);
      setPendingRequests(Array.isArray(pData) ? pData : []);

      if (mRes.ok) setMealTimes({ ...DEFAULT_MEAL_TIMES, ...(await mRes.json()) });
    } catch (e) {
      console.error("Profile load error:", e);
    } finally {
      setLoadingLookups(false);
    }
  };

  useFocusEffect(useCallback(() => { loadProfileData(); }, [activeDependent?.id]));

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
      Alert.alert(t('profile.accessDeniedTitle'), t('profile.accessDeniedMessage'));
    }
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

        {/* Personal Details Surface */}
        <Surface style={styles.surface} elevation={1}>
          <List.Item title={t('profile.fullName')} description={user.full_name || t('common.notProvided')} left={p => <List.Icon {...p} icon="account" />} />
          <Divider />
          <List.Item title={t('profile.email')} description={user.email} left={p => <List.Icon {...p} icon="email" />} />
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