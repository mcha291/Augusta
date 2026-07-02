import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View
} from 'react-native';
import {
  Appbar,
  Button,
  Dialog,
  FAB,
  HelperText,
  Portal,
  Searchbar,
  Surface,
  Text,
  TextInput
} from 'react-native-paper';

// Design System Imports
import { COLORS, SHADOWS } from '../constants/theme';
import { GlobalStyles } from '../styles/globalstyles';

interface MedicationLibraryItem {
  id: number;
  name: string;
  default_dosage: string;
}

const BASE_URL = 'https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws/medication-library';

export default function MedicationLibraryScreen() {
  const router = useRouter();

  // Data State
  const [medications, setMedications] = useState<MedicationLibraryItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Form State
  const [visible, setVisible] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDosage, setNewDosage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState(false);

  const loadLibrary = async () => {
    try {
      const res = await fetch(BASE_URL);
      const data = await res.json();
      setMedications(data);
    } catch (e) {
      console.error("Library Load Error:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { loadLibrary(); }, []);

  const handleAddMedication = async () => {
    if (!newName.trim() || !newDosage.trim()) {
      setFormError(true);
      return;
    }

    try {
      setIsSaving(true);
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, default_dosage: newDosage })
      });

      if (res.ok) {
        setNewName('');
        setNewDosage('');
        setFormError(false);
        setVisible(false);
        loadLibrary();
      }
    } catch (e) {
      Alert.alert("Error", "Connection to library failed.");
    } finally {
      setIsSaving(false);
    }
  };

  // Filter logic for search
  const filteredMeds = medications.filter(med => 
    med.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <View style={GlobalStyles.container}>
      <Appbar.Header style={{ backgroundColor: COLORS.background }}>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title="Medication Library" titleStyle={styles.headerTitle} />
      </Appbar.Header>

      <View style={styles.searchSection}>
        <Searchbar
          placeholder="Search medications..."
          onChangeText={setSearchQuery}
          value={searchQuery}
          style={styles.searchBar}
          inputStyle={styles.searchBarInput}
          elevation={0}
        />
      </View>

      <ScrollView 
        contentContainerStyle={GlobalStyles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadLibrary(); }} tintColor={COLORS.primary} />}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.sectionInfo}>
            Select or add medications to the master list. Standardized dosages help ensure accurate tracking.
        </Text>

        {loading && !refreshing ? (
          <ActivityIndicator size="large" color={COLORS.primary} style={{ marginTop: 50 }} />
        ) : (
          <View style={styles.listContainer}>
            {filteredMeds.length === 0 ? (
                <View style={styles.emptyState}>
                    <MaterialCommunityIcons name="pill-off" size={48} color={COLORS.secondary} />
                    <Text style={styles.emptyText}>No medications found.</Text>
                </View>
            ) : (
                filteredMeds.map((item) => (
                    <Surface key={item.id} style={styles.medListItem} elevation={0}>
                      <View style={styles.iconBox}>
                        <MaterialCommunityIcons name="pill" size={24} color={COLORS.primary} />
                      </View>
                      <View style={styles.medInfo}>
                        <Text style={styles.medName}>{item.name}</Text>
                        <Text style={styles.medDosages}>Available: {item.default_dosage}</Text>
                      </View>
                      <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.secondary} />
                    </Surface>
                ))
            )}
          </View>
        )}
      </ScrollView>

      {/* Primary Action FAB */}
      <FAB
        icon="plus"
        label={Platform.OS !== 'web' ? "Add Medicine" : undefined}
        style={styles.fab}
        color="white"
        onPress={() => setVisible(true)}
      />

      {/* Professional Add Dialog */}
      <Portal>
        <Dialog visible={visible} onDismiss={() => !isSaving && setVisible(false)} style={styles.dialog}>
          <Dialog.Title style={styles.dialogTitle}>Add New Medicine</Dialog.Title>
          <Dialog.Content>
            <View style={styles.dialogForm}>
                <TextInput
                  label="Medicine Name *"
                  value={newName}
                  onChangeText={(t) => { setNewName(t); setFormError(false); }}
                  mode="outlined"
                  outlineColor={COLORS.background}
                  style={styles.dialogInput}
                  error={formError && !newName}
                />
                <TextInput
                  label="Available Dosages *"
                  placeholder="e.g. 200mg, 400mg"
                  value={newDosage}
                  onChangeText={(t) => { setNewDosage(t); setFormError(false); }}
                  mode="outlined"
                  outlineColor={COLORS.background}
                  style={styles.dialogInput}
                  error={formError && !newDosage}
                />
                {formError && <HelperText type="error">Please provide both name and dosages.</HelperText>}
            </View>
          </Dialog.Content>
          <Dialog.Actions style={styles.dialogActions}>
            <Button onPress={() => setVisible(false)} textColor={COLORS.slate}>Cancel</Button>
            <Button 
              onPress={handleAddMedication} 
              loading={isSaving} 
              mode="contained"
              buttonColor={COLORS.primary}
              style={{ borderRadius: 10 }}
            >
              Add to Library
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  headerTitle: { fontWeight: '800', fontSize: 18, color: COLORS.ink },
  
  // Search Section
  searchSection: {
    paddingHorizontal: 24,
    paddingBottom: 16,
    backgroundColor: COLORS.background,
  },
  searchBar: {
    backgroundColor: 'white',
    borderRadius: 16,
    height: 50,
    ...SHADOWS.soft,
  },
  searchBarInput: {
    fontSize: 15,
    minHeight: 0, // Fixes vertical alignment on Web
  },

  sectionInfo: {
    fontSize: 13,
    color: COLORS.slate,
    lineHeight: 20,
    marginBottom: 24,
    textAlign: 'center',
  },

  // List Items
  listContainer: { gap: 10 },
  medListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'white',
    padding: 14,
    borderRadius: 20,
    ...SHADOWS.soft,
  },
  iconBox: {
    width: 44,
    height: 44,
    backgroundColor: COLORS.background,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  medInfo: {
    flex: 1,
    marginLeft: 16,
  },
  medName: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.ink,
  },
  medDosages: {
    fontSize: 12,
    color: COLORS.slate,
    marginTop: 2,
  },

  // FAB
  fab: {
    position: 'absolute',
    margin: 24,
    right: 0,
    bottom: 0,
    backgroundColor: COLORS.ink,
    borderRadius: 16,
  },

  // Dialog Styles
  dialog: { borderRadius: 24, backgroundColor: 'white' },
  dialogTitle: { fontWeight: '800', color: COLORS.ink, textAlign: 'center' },
  dialogForm: { gap: 4 },
  dialogInput: { backgroundColor: COLORS.background },
  dialogActions: { paddingHorizontal: 20, paddingBottom: 16 },

  emptyState: { alignItems: 'center', marginTop: 60, opacity: 0.4 },
  emptyText: { marginTop: 12, fontWeight: '600' }
});