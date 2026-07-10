import { COLORS } from '@/constants/theme';
import { changeLanguage, LANGUAGE_LABELS, SUPPORTED_LANGUAGES, SupportedLanguage } from '@/i18n';
import { apiRequest } from '@/utils/api';
import { useFocusEffect, useRouter } from 'expo-router';
import { goBackOrHome } from '@/utils/navigation';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { Appbar, Avatar, Button, Divider, List, Menu, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import ActiveProfileBadge from '../components/active-profile-badge';
import { useAuth } from '../context/AuthContext';

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
export default function ProfileScreen() {
  const { user, logout } = useAuth();
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

  // 1. Fetch Lookup Tables (Genders/Conditions) and Pending Requests
  const loadProfileData = async () => {
    try {
      const [gRes, cRes, pRes] = await Promise.all([
        apiRequest('/genders'),
        apiRequest('/conditions'),
        apiRequest('/relationships/pending')
      ]);

      const gData = await gRes.json();
      const cData = await cRes.json();
      const pData = await pRes.json();

      setGenderList(Array.isArray(gData) ? gData : []);
      setConditionList(Array.isArray(cData) ? cData : []);
      setPendingRequests(Array.isArray(pData) ? pData : []);
    } catch (e) {
      console.error("Profile load error:", e);
    } finally {
      setLoadingLookups(false);
    }
  };

  useFocusEffect(useCallback(() => { loadProfileData(); }, []));

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

      <ScrollView contentContainerStyle={styles.container}>
        
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
  surface: { borderRadius: 16, overflow: 'hidden', backgroundColor: 'white' },
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