import { COLORS } from '@/constants/theme';
import { apiRequest } from '@/utils/api';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { Appbar, Avatar, Button, Divider, List, Surface, Text, TextInput, useTheme } from 'react-native-paper';
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

  // Data States
  const [handshakeInput, setHandshakeInput] = useState('');
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [genderList, setGenderList] = useState<Gender[]>([]);
  const [conditionList, setConditionList] = useState<Condition[]>([]);
  const [loadingLookups, setLoadingLookups] = useState(true);

  // 1. Fetch Lookup Tables (Genders/Conditions) and Pending Requests
  const loadProfileData = async () => {
    try {
      const [gRes, cRes, pRes] = await Promise.all([
        fetch('https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws/genders'),
        fetch('https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws/conditions'),
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
    if (!user?.gender_id) return 'Not specified';
    return genderList.find(g => g.id === user.gender_id)?.name || 'Loading...';
  };

  const getConditionName = () => {
    if (!user?.condition_id) return 'General Health';
    return conditionList.find(c => c.id === user.condition_id)?.name || 'Loading...';
  };

  const respondToRequest = async (id: number, action: 'active' | 'decline') => {
    const res = await apiRequest('/relationships/respond', {
      method: 'POST',
      body: { request_id: id, action, provided_code: handshakeInput.toUpperCase() }
    });
    if (res.ok) {
      loadProfileData();
      setHandshakeInput('');
      Alert.alert("Authorized", "Security clearance granted.");
    } else {
      Alert.alert("Access Denied", "Handshake code incorrect.");
    }
  };

  if (!user) return null;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Appbar.Header elevated style={{ backgroundColor: COLORS.background }}>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title="User Profile" titleStyle={{ fontWeight: '800' }} />
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
            <Text style={{ fontSize: 12, marginBottom: 10, color: COLORS.slate }}>is requesting access to your medical dossier.</Text>
            <TextInput
              label="Handshake Code"
              placeholder="WISE-000"
              mode="outlined"
              dense
              value={handshakeInput}
              onChangeText={setHandshakeInput}
              autoCapitalize="characters"
              style={{ backgroundColor: 'white' }}
            />
            <View style={styles.requestActions}>
              <Button onPress={() => respondToRequest(req.id, 'decline')} textColor="red">Decline</Button>
              <Button mode="contained" onPress={() => respondToRequest(req.id, 'active')} buttonColor="#22C55E">Verify</Button>
            </View>
          </Surface>
        ))}

        {/* Personal Details Surface */}
        <Surface style={styles.surface} elevation={1}>
          <List.Item title="Full Name" description={user.full_name || 'Not provided'} left={p => <List.Icon {...p} icon="account" />} />
          <Divider />
          <List.Item title="Email" description={user.email} left={p => <List.Icon {...p} icon="email" />} />
          <Divider />
          <List.Item
            title="Phone Number"
            description={user?.phone_number || 'Not provided'}
            left={p => <List.Icon {...p} icon="phone" />}
          />
          <Divider />
          <List.Item 
            title="Birth Date" 
            description={user.birth_date ? new Date(user.birth_date).toLocaleDateString() : 'Not provided'} 
            left={p => <List.Icon {...p} icon="cake" />} 
          />
          
          <Divider />
          
          {/* Mapped Gender Column */}
          <List.Item 
            title="Gender" 
            description={getGenderName()} 
            left={p => <List.Icon {...p} icon="human-male-female" />} 
          />
          
          <Divider />
          
          {/* Mapped Condition Column */}
          <List.Item 
            title="Condition" 
            description={getConditionName()} 
            left={p => <List.Icon {...p} icon="clipboard-pulse-outline" />} 
          />
          
          <Divider />
          
          <List.Item
            title="Managed Accounts"
            description="Manage family members & dependents"
            left={p => <List.Icon {...p} icon="account-group-outline" color={COLORS.primary} />}
            right={p => <List.Icon {...p} icon="chevron-right" />}
            onPress={() => router.push('/managed-users')}
          />
        </Surface>

        <Button
          mode="outlined"
          onPress={logout}
          icon="logout"
          style={styles.logoutBtn}
          textColor={theme.colors.error}
        >
          Logout / End Session
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