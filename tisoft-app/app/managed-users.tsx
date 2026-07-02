import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Appbar, Avatar, Button, Dialog, IconButton, Portal, Surface, Text, TextInput } from 'react-native-paper';
import { COLORS, SHADOWS } from '../constants/theme';
import { useAuth } from '../context/AuthContext';
import { GlobalStyles } from '../styles/globalstyles';
import { apiRequest } from '../utils/api';

export default function ManagedUsersScreen() {
  const { user, setActiveDependent, activeDependent } = useAuth();
  const router = useRouter();
  const [dependents, setDependents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Form State
  const [searchQuery, setSearchQuery] = useState('');
  const [requestDialog, setRequestDialog] = useState(false);
  const [handshakeCode, setHandshakeCode] = useState<string | null>(null);

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
      body: { dependent_email: searchQuery, relationship_type: 'Family' }
    });
    const data = await res.json();
    if (res.ok) {
      setHandshakeCode(data.handshakeCode);
    } else {
      Alert.alert("Error", data.error);
    }
  };

  return (
    <View style={GlobalStyles.container}>
      <Appbar.Header style={{ backgroundColor: COLORS.background }}>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title="Family Management" titleStyle={{ fontWeight: '800' }} />
      </Appbar.Header>

      <ScrollView contentContainerStyle={GlobalStyles.scrollContent}>
        <Text style={GlobalStyles.sectionTitle}>Active Profiles</Text>
        
        {/* Switch back to Self */}
        <Pressable onPress={() => { setActiveDependent(null); router.replace('/(tabs)'); }}>
          <Surface style={[styles.userCard, !activeDependent && styles.activeCard]} elevation={0}>
            <Avatar.Text size={40} label="ME" />
            <Text style={styles.userName}>Your Own Records</Text>
            {!activeDependent && <IconButton icon="check-circle" iconColor={COLORS.primary} />}
          </Surface>
        </Pressable>

        {dependents.map(dep => (
          <Pressable key={dep.id} onPress={() => { setActiveDependent(dep); router.replace('/(tabs)'); }}>
            <Surface style={[styles.userCard, activeDependent?.id === dep.id && styles.activeCard]} elevation={0}>
              <Avatar.Image size={40} source={{ uri: `https://api.dicebear.com/7.x/initials/svg?seed=${dep.username}` }} />
              <View style={{ flex: 1, marginLeft: 15 }}>
                <Text style={styles.userName}>{dep.full_name}</Text>
                <Text style={styles.userSub}>{dep.relationship_type}</Text>
              </View>
              {activeDependent?.id === dep.id && <IconButton icon="check-circle" iconColor={COLORS.primary} />}
            </Surface>
          </Pressable>
        ))}

        <Button icon="account-plus" mode="contained" onPress={() => setRequestDialog(true)} style={{ marginTop: 20 }}>
          Request Access to Another
        </Button>
      </ScrollView>

      {/* Request Access Dialog */}
      <Portal>
        <Dialog visible={requestDialog} onDismiss={() => { setRequestDialog(false); setHandshakeCode(null); }}>
          <Dialog.Title>Security Clearance Request</Dialog.Title>
          <Dialog.Content>
            {!handshakeCode ? (
              <>
                <Text style={{ marginBottom: 15 }}>Enter the Email or Codename of the agent you wish to manage.</Text>
                <TextInput label="Email / Codename" mode="outlined" value={searchQuery} onChangeText={setSearchQuery} autoCapitalize="none" />
              </>
            ) : (
              <View style={{ alignItems: 'center' }}>
                <Text style={{ textAlign: 'center', marginBottom: 10 }}>Request Sent! Give this code to the dependent to verify:</Text>
                <Text style={styles.handshakeText}>{handshakeCode}</Text>
              </View>
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setRequestDialog(false)}>Close</Button>
            {!handshakeCode && <Button onPress={handleSendRequest}>Send Request</Button>}
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
  handshakeText: { fontSize: 32, fontWeight: '900', color: COLORS.primary, letterSpacing: 4, marginVertical: 10 }
});