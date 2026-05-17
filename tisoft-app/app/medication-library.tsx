import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import {
    Appbar,
    Avatar,
    Button,
    Card,
    Dialog,
    FAB,
    HelperText,
    Portal,
    Text,
    TextInput,
    useTheme
} from 'react-native-paper';

interface MedicationLibraryItem {
  id: number;
  name: string;
  default_dosage: string;
}

const BASE_URL = 'https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws/medication-library';

export default function MedicationLibraryScreen() {
  const theme = useTheme();
  const router = useRouter();

  // Data State
  const [medications, setMedications] = useState<MedicationLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Form State
  const [visible, setVisible] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDosage, setNewDosage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(false);

  const loadLibrary = async () => {
    try {
      const res = await fetch(BASE_URL);
      const data = await res.json();
      setMedications(data);
    } catch (e) {
      console.error("Failed to load library", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadLibrary();
  }, []);

  const handleAddMedication = async () => {
    if (!newName.trim() || !newDosage.trim()) {
      setError(true);
      return;
    }

    try {
      setIsSaving(true);
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          default_dosage: newDosage
        })
      });

      if (res.ok) {
        setNewName('');
        setNewDosage('');
        setError(false);
        setVisible(false);
        loadLibrary(); // Refresh list
      } else {
        throw new Error("Failed to save");
      }
    } catch (e) {
      Alert.alert("Error", "Could not add to library.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Appbar.Header elevated>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title="Medication Library" subtitle="Master List" />
      </Appbar.Header>

      <ScrollView 
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadLibrary(); }} />}
      >
        <Text variant="bodyMedium" style={styles.introText}>
          Select or add medications to the global library. These become available when setting up reminders.
        </Text>

        {loading && !refreshing ? (
          <ActivityIndicator size="large" style={{ marginTop: 50 }} />
        ) : (
          medications.map((item) => (
            <Card key={item.id} style={styles.card} mode="outlined">
              <Card.Title
                title={item.name}
                titleStyle={styles.medTitle}
                subtitle={`Available Doses: ${item.default_dosage}`}
                left={(props) => <Avatar.Icon {...props} icon="pill" style={{ backgroundColor: theme.colors.primaryContainer }} />}
              />
            </Card>
          ))
        )}
      </ScrollView>

      {/* Floating Action Button to Add New */}
      <FAB
        icon="plus"
        label={Platform.OS !== 'web' ? "Add New" : undefined}
        style={[styles.fab, { backgroundColor: theme.colors.primaryContainer }]}
        onPress={() => setVisible(true)}
      />

      {/* Add Medication Dialog */}
      <Portal>
        <Dialog visible={visible} onDismiss={() => !isSaving && setVisible(false)}>
          <Dialog.Title>Add to Library</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Medication Name"
              value={newName}
              onChangeText={(t) => { setNewName(t); setError(false); }}
              mode="outlined"
              style={styles.input}
              placeholder="e.g. Paracetamol"
              disabled={isSaving}
              error={error && !newName}
            />
            <TextInput
              label="Available Dosages"
              value={newDosage}
              onChangeText={(t) => { setNewDosage(t); setError(false); }}
              mode="outlined"
              style={styles.input}
              placeholder="e.g. 200mg, 400mg"
              disabled={isSaving}
              error={error && !newDosage}
            />
            <HelperText type="error" visible={error}>
              Both fields are required.
            </HelperText>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setVisible(false)} disabled={isSaving}>Cancel</Button>
            <Button 
              onPress={handleAddMedication} 
              loading={isSaving} 
              disabled={isSaving}
              mode="contained"
            >
              Add Medication
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 100 },
  introText: { marginBottom: 20, opacity: 0.7, textAlign: 'center' },
  card: { marginBottom: 12, borderRadius: 12 },
  medTitle: { fontWeight: 'bold' },
  input: { marginBottom: 8 },
  fab: {
    position: 'absolute',
    margin: 16,
    right: 0,
    bottom: 0,
  },
});