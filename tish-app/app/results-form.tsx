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
import PlatformDatePicker from '../components/platform-date-picker';
import { COLORS, RADIUS, SHADOWS } from '../constants/theme';
import { GlobalStyles } from '../styles/globalstyles';
import { toLocalDateString } from '../utils/date';



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
  const [configError, setConfigError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, boolean>>({});

  // --- Date State ---
  const [date, setDate] = useState(new Date(initialData?.test_date || new Date()));
  const [showPicker, setShowPicker] = useState(false);

  const notifyUser = (title: string, message: string) => {
    if (Platform.OS === 'web') window.alert(`${title}: ${message}`);
    else Alert.alert(title, message);
  };

  // Was a bare .then() chain with no .catch(), and it cleared the loading flag
  // only on success — so offline or a 5xx left a permanent spinner with no
  // error and no way to retry.
  const loadConfigs = async () => {
    setLoading(true);
    setConfigError(false);
    try {
      const res = await apiRequest(`/test-config`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConfigs(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Test config load failed:', e);
      setConfigError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadConfigs(); }, []);

  /**
   * parseFloat("12o") is 12, and parseFloat("abc") is NaN which serialises to
   * JSON null — so a typo was silently stored as a missing reading. Validate
   * before saving rather than after.
   */
  const validate = () => {
    const errors: Record<string, boolean> = {};
    for (const cfg of configs) {
      const key = `field_${cfg.field_number}`;
      const raw = formValues[key];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue; // blank is allowed
      // Number() rejects trailing junk that parseFloat happily truncates.
      if (!Number.isFinite(Number(String(raw).trim()))) errors[key] = true;
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) {
      notifyUser(t('common.error'), t('resultsForm.fixInvalidFields'));
      return;
    }

    try {
      setSaving(true);

      const payload: any = {
        id: initialData?.id,
        test_date: date.toISOString(),
        ...formValues
      };

      // Ensure numeric fields are cast to floats
      configs.forEach(cfg => {
        const key = `field_${cfg.field_number}`;
        const raw = payload[key];
        if (raw === undefined || raw === null || String(raw).trim() === '') {
          // Send an explicit null rather than "" so the column is cleared.
          if (key in payload) payload[key] = null;
          return;
        }
        payload[key] = Number(String(raw).trim());
      });

      const res = await apiRequest(`/test-results`, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      }, activeDependent?.id);

      if (res.ok) {
        if (Platform.OS === 'web') window.alert(isEdit ? t('resultsForm.saveSuccessUpdated') : t('resultsForm.saveSuccessRecorded'));
        goBackOrHome(router);
      } else {
        // Previously fell through silently on a non-2xx, so the form just sat
        // there looking like nothing had happened.
        const detail = await res.json().catch(() => ({}));
        notifyUser(t('common.error'), detail.error || t('resultsForm.saveFailed'));
      }
    } catch (e) {
      notifyUser(t('common.error'), t('resultsForm.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <View style={GlobalStyles.centered}><ActivityIndicator color={COLORS.primary} size="large" /></View>;

  if (configError) {
    return (
      <View style={GlobalStyles.centered}>
        <Text style={styles.errorTitle}>{t('resultsForm.configLoadFailed')}</Text>
        <Text style={styles.errorBody}>{t('resultsForm.configLoadFailedHint')}</Text>
        <Button mode="contained" onPress={loadConfigs} icon="refresh" style={{ marginTop: 16 }}>
          {t('common.retry')}
        </Button>
        <Button mode="text" onPress={() => goBackOrHome(router)} textColor={COLORS.slate}>
          {t('common.cancel')}
        </Button>
      </View>
    );
  }

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
        keyboardShouldPersistTaps="handled"
      >
        
        {/* --- DATE SELECTION SECTION --- */}
        <View style={styles.sectionHeader}>
            <Text style={styles.sectionHeaderText}>{t('resultsForm.testDetails')}</Text>
        </View>

        <View style={styles.fieldContainer}>
            <Text style={styles.sectionLabel}>{t('resultsForm.testDate')}</Text>
            {/* Local-time formatting both ways below. `toISOString()` showed the
                previous day for anyone east of UTC before their offset, and
                `new Date('2026-07-30')` parses as UTC midnight — the same
                off-by-one-day defect in each direction. */}
            {Platform.OS === 'web' ? (
              <input
                type="date"
                value={toLocalDateString(date)}
                onChange={(e) => {
                  const [y, m, d] = e.target.value.split('-').map(Number);
                  if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
                    setDate(new Date(y, m - 1, d));
                  }
                }}
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
            <HelperText type="info" visible={false} style={styles.helper}>{''}</HelperText>
        </View>

        <PlatformDatePicker
          visible={showPicker}
          value={date}
          mode="date"
          onConfirm={d => { setDate(d); setShowPicker(false); }}
          onDismiss={() => setShowPicker(false)}
        />

        {/* --- NUMERIC RESULTS SECTION --- */}
        <View style={[styles.sectionHeader, { marginTop: 8 }]}>
            <Text style={styles.sectionHeaderText}>{t('resultsForm.numericValues')}</Text>
        </View>

        {configs.map((cfg) => {
          const key = `field_${cfg.field_number}`;
          const hasError = !!fieldErrors[key];
          return (
            <View key={cfg.field_number} style={styles.fieldContainer}>
              <TextInput
                label={`${cfg.display_name} (${cfg.units})`}
                value={formValues[key]?.toString() || ''}
                mode="outlined"
                outlineColor={COLORS.background}
                activeOutlineColor={hasError ? COLORS.error : COLORS.primary}
                error={hasError}
                keyboardType="numeric"
                style={styles.input}
                onChangeText={(val) => {
                  setFormValues({ ...formValues, [key]: val });
                  if (hasError) setFieldErrors(prev => ({ ...prev, [key]: false }));
                }}
                disabled={saving}
              />
              {/* Reserved space keeps vertical rhythm whether or not the
                  message is showing. */}
              <HelperText type="error" visible={hasError} style={styles.helper}>
                {t('resultsForm.invalidNumber')}
              </HelperText>
            </View>
          );
        })}

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
  errorTitle: { fontSize: 18, fontWeight: '800', color: COLORS.ink, textAlign: 'center', paddingHorizontal: 24 },
  errorBody: { fontSize: 14, color: COLORS.slate, textAlign: 'center', marginTop: 8, paddingHorizontal: 32, lineHeight: 20 },
  
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