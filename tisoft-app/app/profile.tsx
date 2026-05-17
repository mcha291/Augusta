import { useRouter } from 'expo-router';
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Appbar, Avatar, Button, Divider, List, Surface, Text, useTheme } from 'react-native-paper';
import { useAuth } from '../context/AuthContext';

export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const theme = useTheme();
  const router = useRouter();

  if (!user) return null;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <Appbar.Header elevated>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title="Agent Profile" />
      </Appbar.Header>

      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <Avatar.Text size={80} label={user.username.substring(0, 2).toUpperCase()} />
          <Text variant="headlineMedium" style={styles.username}>{user.username}</Text>
          <Text variant="bodyLarge" style={{ color: theme.colors.primary, textTransform: 'capitalize' }}>{user.role}</Text>
        </View>

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
          <List.Item title="Birth Date" description={user.birth_date ? new Date(user.birth_date).toLocaleDateString() : 'Not provided'} left={p => <List.Icon {...p} icon="cake" />} />
          <Divider />
          <List.Item title="Gender" description={user.gender || 'Not provided'} left={p => <List.Icon {...p} icon="human-male-female" />} />
          <Divider />
          <List.Item title="Blood Type" description={user.blood_type || 'Unknown'} left={p => <List.Icon {...p} icon="water" />} />
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
  container: { padding: 20 },
  header: { alignItems: 'center', marginBottom: 30 },
  username: { fontWeight: 'bold', marginTop: 10 },
  surface: { borderRadius: 12, overflow: 'hidden' },
  logoutBtn: { marginTop: 30, borderColor: 'red' }
});