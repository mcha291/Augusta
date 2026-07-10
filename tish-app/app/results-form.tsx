import DateTimePicker from '@react-native-community/datetimepicker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { goBackOrHome } from '@/utils/navigation';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  Appbar,
  Button,
  HelperText,
  Text,
  TextInput
} from 'react-native-paper';

// Design System Imports
import ActiveProfileBadge from '@/components/active-profile-badge';
import { useAuth } from '@/context/AuthContext';
import { COLORS, RADIUS, SHADOWS } from '../constants/theme';
import { GlobalStyles } from '../styles/globalstyles';



export default function ResultsFormScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { t } = useTranslation();
  const { activeDependent } = useAuth();

  // 1. Determine Mode (Add vs Edit)
  const isEdit = !!params.result;
  const initialData = isEdit ? JSON.parse(params.result as string) : null;

  const [configs, setConfigs] = useState<any[]>([]);
  const [formValues, setFormValues] = useState<any>(initialData || {});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // --- Date State ---
  const [date, setDate] = useState(new Date(initialData?.test_date || new Date()));
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    apiRequest(`/test-config`)
      .then(res => res.json())
      .then(data => {
        setConfigs(data);
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    try {
      setSaving(true);
      
      const payload = {
        id: initialData?.id,
        test_date: date.toISOString(),
        ...formValues
      };

      // Ensure numeric fields are cast to floats
      configs.forEach(cfg => {
        const key = `field_${cfg.field_number}`;
        if (payload[key] !== undefined && payload[key] !== "") {
          payload[key] = parseFloat(payload[key]);
        }
      });

      const res = await apiRequest(`/test-results`, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      }, activeDependent?.id);

      if (res.ok) {
        if (Platform.OS === 'web') window.alert(isEdit ? t('resultsForm.saveSuccessUpdated') : t('resultsForm.saveSuccessRecorded'));
        goBackOrHome(router);
      }
    } catch (e) {
      Alert.alert(t('common.error'), t('resultsForm.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <View style={GlobalStyles.centered}><ActivityIndicator color={COLORS.primary} size="large" /></View>;

  return (
    <View style={GlobalStyles.container}>
      <Appbar.Header style={{ backgroundColor: COLORS.background }}>
        <Appbar.BackAction onPress={() => goBackOrHome(router)} disabled={saving} />
        <Appbar.Content title={isEdit ? t('resultsForm.editTitle') : t('resultsForm.newTitle')} titleStyle={styles.headerTitle} />
        <ActiveProfileBadge />
      </Appbar.Header>

      <ScrollView 
        contentContainerStyle={GlobalStyles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        
        {/* --- DATE SELECTION SECTION --- */}
        <View style={styles.sectionHeader}>
            <Text style={styles.sectionHeaderText}>{t('resultsForm.testDetails')}</Text>
        </View>

        <View style={styles.fieldContainer}>
            <Text style={styles.sectionLabel}>{t('resultsForm.testDate')}</Text>
            {Platform.OS === 'web' ? (
              <input
                type="date"
                value={date.toISOString().split('T')[0]}
                onChange={(e) => setDate(new Date(e.target.value))}
                style={webInputStyle}
              />
            ) : (
              <Pressable onPress={() => !saving && setShowPicker(true)}>
                <View pointerEvents="none">
                    <TextInput
                        label={t('resultsForm.dateOfTest')}
                        value={date.toLocaleDateString()}
                        mode="outlined"
                        outlineColor={COLORS.background}
                        activeOutlineColor={COLORS.primary}
                        editable={false}
                        style={styles.input}
                        right={<TextInput.Icon icon="calendar" color={COLORS.primary} />}
                    />
                </View>
              </Pressable>
            )}
            {/* Standardized Helper height for vertical rhythm */}
            <HelperText type="info" visible={false} style={styles.helper} children={undefined} />
        </View>

        {showPicker && Platform.OS !== 'web' && (
          <DateTimePicker
            value={date}
            mode="date"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={(e, d) => {
              if (Platform.OS === 'android') setShowPicker(false);
              if (d) setDate(d);
            }}
          />
        )}

        {/* --- NUMERIC RESULTS SECTION --- */}
        <View style={[styles.sectionHeader, { marginTop: 8 }]}>
            <Text style={styles.sectionHeaderText}>{t('resultsForm.numericValues')}</Text>
        </View>

        {configs.map((cfg) => (
          <View key={cfg.field_number} style={styles.fieldContainer}>
            <TextInput
              label={`${cfg.display_name} (${cfg.units})`}
              value={formValues[`field_${cfg.field_number}`]?.toString() || ''}
              mode="outlined"
              outlineColor={COLORS.background}
              activeOutlineColor={COLORS.primary}
              keyboardType="numeric"
              style={styles.input}
              onChangeText={(val) => setFormValues({ ...formValues, [`field_${cfg.field_number}`]: val })}
              disabled={saving}
            />
            {/* Empty space to keep alignment same as screens with validation */}
            <HelperText type="info" visible={false} style={styles.helper} children={undefined} />
          </View>
        ))}

        <Button 
          mode="contained" 
          onPress={handleSave} 
          loading={saving} 
          disabled={saving}
          buttonColor={COLORS.primary}
          style={styles.saveButton}
          labelStyle={styles.saveButtonLabel}
          icon="check-circle"
        >
          {isEdit ? t('resultsForm.updateReport') : t('resultsForm.saveReport')}
        </Button>
      </ScrollView>
    </View>
  );
}

// Imports for Styles
import { apiRequest } from '@/utils/api';

const webInputStyle = {
    padding: '14px',
    borderRadius: '12px',
    border: '1px solid #E2E8F0',
    backgroundColor: 'white',
    width: '100%',
    fontFamily: 'inherit',
    fontSize: '16px',
    outline: 'none'
};

const styles = StyleSheet.create({
  headerTitle: { fontWeight: '800', fontSize: 18, color: COLORS.ink },
  
  // Consistency logic
  fieldContainer: {
    marginBottom: 4,
  },
  input: {
    backgroundColor: 'white',
    borderRadius: RADIUS.md,
  },
  helper: {
    height: 20,
    marginTop: -2,
  },

  sectionLabel: { 
    fontSize: 16, 
    fontWeight: '800', 
    color: COLORS.ink, 
    marginBottom: 8 
  },
  sectionHeader: { 
    marginTop: 12, 
    marginBottom: 16, 
    borderLeftWidth: 4, 
    borderLeftColor: COLORS.primary, 
    paddingLeft: 12 
  },
  sectionHeaderText: { 
    fontSize: 11, 
    fontWeight: '800', 
    color: COLORS.primary, 
    letterSpacing: 1 
  },

  saveButton: { 
    marginTop: 20, 
    borderRadius: RADIUS.lg, 
    height: 56, 
    justifyContent: 'center',
    ...SHADOWS.medium 
  },
  saveButtonLabel: { 
    fontSize: 16, 
    fontWeight: '800', 
    letterSpacing: 0.5 
  }
});