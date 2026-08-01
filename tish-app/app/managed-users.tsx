import { useFocusEffect, useRouter } from 'expo-router';
import { goBackOrHome } from '@/utils/navigation';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Appbar, Avatar, Button, Chip, Dialog, IconButton, Portal, Surface, Text, TextInput } from 'react-native-paper';
import ActiveProfileBadge from '../components/active-profile-badge';
import { COLORS, SHADOWS } from '../constants/theme';
import { useAuth } from '../context/AuthContext';
import { GlobalStyles } from '../styles/globalstyles';
import { apiRequest } from '../utils/api';
import { apiErrorMessage, describeApiFailure } from '../utils/api-errors';
import {
  DEFAULT_RELATIONSHIP_TYPE,
  RELATIONSHIP_TYPES,
  relationshipTypeLabelKey,
  type RelationshipType,
} from '../utils/relationship-types';

export default function ManagedUsersScreen() {
  const { user, setActiveDependent, activeDependent } = useAuth();
  const router = useRouter();
  const { t } = useTranslation();
  const [dependents, setDependents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Form State
  const [searchQuery, setSearchQuery] = useState('');
  const [requestDialog, setRequestDialog] = useState(false);
  const [handshakeCode, setHandshakeCode] = useState<string | null>(null);
  // 3.4 — was hardcoded 'Family' on the request below.
  const [relationshipType, setRelationshipType] = useState<RelationshipType>(DEFAULT_RELATIONSHIP_TYPE);

  /** A stored type as a translated label, falling back to whatever the row holds. */
  const labelForType = (value: unknown): string => {
    const key = relationshipTypeLabelKey(value);
    return key ? t(key) : String(value ?? '');
  };

  const loadData = async () => {
    try {
      const res = await apiRequest('/my-dependents');
      const data = await res.json();
      setDependents(Array.isArray(data) ? data : []);
    } finally { setLoading(false); }
  };

  useFocusEffect(useCallback(() => { loadData(); }, []));

  const handleSendRequest = async () => {
    const res = await apiRequest('/relationships/request', {
      method: 'POST',
      // The stable key, never the translated label — the value goes into the
      // database and is read back by a device that may be in the other language.
      body: { dependent_email: searchQuery, relationship_type: relationshipType }
    });
    if (res.ok) {
      const data = await res.json();
      setHandshakeCode(data.handshakeCode);
    } else {
      // 6.2 — this line used to be `Alert.alert(t('common.error'), data.error)`,
      // i.e. the server's English shown verbatim to a zh-Hant user. It is also
      // the site that made the contract worth building: the two things that
      // realistically go wrong here — a mistyped address and asking someone who
      // already granted access — were a 500 and a 409 carrying prose, and are
      // now two codes with two sentences in both languages.
      Alert.alert(t('common.error'), apiErrorMessage(await describeApiFailure(res), t));
    }
  };

  return (
    <View style={GlobalStyles.container}>
      <Appbar.Header style={{ backgroundColor: COLORS.background }}>
        <Appbar.BackAction onPress={() => goBackOrHome(router)} />
        <Appbar.Content title={t('managedUsers.title')} titleStyle={{ fontWeight: '800' }} />
        <ActiveProfileBadge />
      </Appbar.Header>

      <ScrollView contentContainerStyle={GlobalStyles.scrollContent} keyboardShouldPersistTaps="handled">
        <Text style={GlobalStyles.sectionTitle}>{t('managedUsers.activeProfiles')}</Text>

        {/* Switch back to Self */}
        <Pressable onPress={() => { setActiveDependent(null); router.replace('/(tabs)'); }}>
          <Surface style={[styles.userCard, !activeDependent && styles.activeCard]} elevation={0}>
            <Avatar.Text size={40} label={t('managedUsers.selfAvatarInitials')} />
            <Text style={styles.userName}>{t('managedUsers.yourOwnRecords')}</Text>
            {!activeDependent && <IconButton icon="check-circle" iconColor={COLORS.primary} />}
          </Surface>
        </Pressable>

        {dependents.map(dep => (
          <Pressable key={dep.id} onPress={() => { setActiveDependent(dep); router.replace('/(tabs)'); }}>
            <Surface style={[styles.userCard, activeDependent?.id === dep.id && styles.activeCard]} elevation={0}>
              <Avatar.Image size={40} source={{ uri: `https://api.dicebear.com/7.x/initials/svg?seed=${dep.username}` }} />
              <View style={{ flex: 1, marginLeft: 15 }}>
                <Text style={styles.userName}>{dep.full_name}</Text>
                <Text style={styles.userSub}>{labelForType(dep.relationship_type)}</Text>
              </View>
              {activeDependent?.id === dep.id && <IconButton icon="check-circle" iconColor={COLORS.primary} />}
            </Surface>
          </Pressable>
        ))}

        <Button icon="account-plus" mode="contained" onPress={() => setRequestDialog(true)} style={{ marginTop: 20 }}>
          {t('managedUsers.requestAccess')}
        </Button>
      </ScrollView>

      {/* Request Access Dialog */}
      <Portal>
        <Dialog visible={requestDialog} onDismiss={() => { setRequestDialog(false); setHandshakeCode(null); }}>
          <Dialog.Title>{t('managedUsers.requestDialogTitle')}</Dialog.Title>
          <Dialog.Content>
            {!handshakeCode ? (
              <>
                <Text style={{ marginBottom: 15 }}>{t('managedUsers.requestDialogInstructions')}</Text>
                <TextInput label={t('managedUsers.identifierLabel')} mode="outlined" value={searchQuery} onChangeText={setSearchQuery} autoCapitalize="none" />

                {/* 3.4 — how the caregiver describes the relationship.
                    Chips rather than a dropdown: seven short options, and the
                    selected one has to stay visible while the identifier field
                    above it is being filled in. */}
                <Text style={styles.typeLabel}>{t('managedUsers.relationshipTypeLabel')}</Text>
                <View style={styles.typeRow}>
                  {RELATIONSHIP_TYPES.map((type) => (
                    <Chip
                      key={type}
                      selected={relationshipType === type}
                      showSelectedCheck={false}
                      onPress={() => setRelationshipType(type)}
                      style={styles.typeChip}
                    >
                      {t(`relationshipTypes.${type}`)}
                    </Chip>
                  ))}
                </View>
                {/* Stated because this is exactly the field a user would expect
                    to narrow what the other person can see. It does not — the
                    model is all-or-nothing, and saying so here is cheaper than
                    letting somebody infer a limit that is not there. */}
                <Text style={styles.typeHint}>{t('managedUsers.relationshipTypeHint')}</Text>
              </>
            ) : (
              <View style={{ alignItems: 'center' }}>
                <Text style={{ textAlign: 'center', marginBottom: 10 }}>{t('managedUsers.requestSentMessage')}</Text>
                <Text style={styles.handshakeText}>{handshakeCode}</Text>
              </View>
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setRequestDialog(false)}>{t('common.close')}</Button>
            {!handshakeCode && <Button onPress={handleSendRequest}>{t('managedUsers.sendRequest')}</Button>}
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  userCard: { flexDirection: 'row', alignItems: 'center', padding: 15, borderRadius: 16, backgroundColor: 'white', marginBottom: 10, ...SHADOWS.soft, borderWidth: 2, borderColor: 'transparent' },
  activeCard: { borderColor: COLORS.primary },
  userName: { fontSize: 16, fontWeight: '700', color: COLORS.ink, marginLeft: 15 },
  userSub: { fontSize: 12, color: COLORS.slate },
  handshakeText: { fontSize: 32, fontWeight: '900', color: COLORS.primary, letterSpacing: 4, marginVertical: 10 },
  typeLabel: { marginTop: 18, marginBottom: 8, fontWeight: '700', color: COLORS.ink },
  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  typeChip: { marginBottom: 4 },
  typeHint: { marginTop: 12, fontSize: 12, color: COLORS.slate }
});