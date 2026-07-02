import { MaterialCommunityIcons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Audio } from 'expo-av';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
    Appbar,
    Button,
    Chip,
    HelperText,
    Menu,
    Surface,
    Text,
    TextInput,
    useTheme
} from 'react-native-paper';
import { SOUND_MAP, SOUND_OPTIONS } from '../constants/sounds';

// Design System Imports
import { COLORS, RADIUS, SHADOWS } from '../constants/theme';
import { GlobalStyles } from '../styles/globalstyles';

import { apiRequest } from '@/utils/api';


type MealTiming = 'before' | 'after' | 'none';
interface MealSelection { enabled: boolean; timing: MealTiming; }
interface MealSelectionsState { breakfast: MealSelection; lunch: MealSelection; dinner: MealSelection; bedtime: MealSelection; }

const formatTimeForWeb = (date: Date) => date.toTimeString().slice(0, 5);

export default function MedicationReminderForm() {
    const router = useRouter();
    const params = useLocalSearchParams();
    const [selectedSound, setSelectedSound] = useState('default');
    const [previewSound, setPreviewSound] = useState<Audio.Sound | null>(null);

    // Play a preview when the user taps a sound chip
    const playPreview = async (soundKey: string) => {
        if (previewSound) await previewSound.unloadAsync();
        const { sound } = await Audio.Sound.createAsync(SOUND_MAP[soundKey]);
        setPreviewSound(sound);
        await sound.playAsync();
        setSelectedSound(soundKey);
    };
    const theme = useTheme();

    // Determine Edit Mode
    const isEdit = !!params.reminder;
    const initialData = isEdit ? JSON.parse(params.reminder as string) : null;

    const [library, setLibrary] = useState<any[]>([]);
    const [loadingConfig, setLoadingConfig] = useState(true);
    const [medMenuVisible, setMedMenuVisible] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    // --- FORM STATE ---
    const [selectedMed, setSelectedMed] = useState<any>(initialData ? { id: initialData.med_id, name: initialData.med_name, default_dosage: '' } : null);
    const [dosage, setDosage] = useState(initialData?.selected_dosage || '');
    const [customDosage, setCustomDosage] = useState('');
    const [frequencyDays, setFrequencyDays] = useState(initialData?.frequency_days?.toString() || '1');

    const [mealSelections, setMealSelections] = useState<MealSelectionsState>({
        breakfast: { enabled: initialData?.at_breakfast || false, timing: initialData?.breakfast_timing || 'none' },
        lunch: { enabled: initialData?.at_lunch || false, timing: initialData?.lunch_timing || 'none' },
        dinner: { enabled: initialData?.at_dinner || false, timing: initialData?.dinner_timing || 'none' },
        bedtime: { enabled: initialData?.at_bedtime || false, timing: 'none' }
    });

    const [alarmTimes, setAlarmTimes] = useState<Date[]>(
        initialData?.alarms
            ? initialData.alarms.map((t: string) => {
                const [h, m] = t.split(':').map(Number);
                const d = new Date(); d.setHours(h, m, 0, 0); return d;
            })
            : [new Date(new Date().setHours(8, 0, 0, 0)), new Date(new Date().setHours(12, 0, 0, 0)), new Date(new Date().setHours(18, 0, 0, 0)), new Date(new Date().setHours(21, 0, 0, 0))]
    );
    const [activeAlarms, setActiveAlarms] = useState(initialData?.alarms ? [true, true, true, true].map((_, i) => i < initialData.alarms.length) : [true, false, false, false]);
    const [showTimePicker, setShowTimePicker] = useState<number | null>(null);

    // Error State
    const [errors, setErrors] = useState({ med: false, dosage: false, frequency: false });

    useEffect(() => {
        apiRequest(`/medication-library`).then(res => res.json()).then(data => {
            setLibrary(data);
            if (isEdit) {
                const fullMed = data.find((m: any) => m.id === initialData.med_id);
                if (fullMed) setSelectedMed(fullMed);
            }
            setLoadingConfig(false);
        });
    }, []);

    const toggleMealTiming = (meal: keyof MealSelectionsState, timing: MealTiming) => {
        setMealSelections(prev => {
            const isCurrentlySelected = prev[meal].timing === timing && prev[meal].enabled;
            return { ...prev, [meal]: { enabled: !isCurrentlySelected, timing: isCurrentlySelected ? 'none' : timing } };
        });
    };

    const handleSave = async () => {
        const finalDosage = customDosage.trim() !== '' ? customDosage : dosage;
        const newErrors = { med: !selectedMed, dosage: !finalDosage, frequency: !frequencyDays };
        setErrors(newErrors);
        if (Object.values(newErrors).some(v => v)) return;

        try {
            setIsSaving(true);
            const payload = {
                id: initialData?.id,
                user_id: 1, med_id: selectedMed.id,
                selected_dosage: finalDosage,
                at_breakfast: mealSelections.breakfast.enabled, breakfast_timing: mealSelections.breakfast.timing,
                at_lunch: mealSelections.lunch.enabled, lunch_timing: mealSelections.lunch.timing,
                at_dinner: mealSelections.dinner.enabled, dinner_timing: mealSelections.dinner.timing,
                at_bedtime: mealSelections.bedtime.enabled,
                frequency_days: parseInt(frequencyDays) || 1,
                alarms: alarmTimes.filter((_, i) => activeAlarms[i]).map(d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }))
            };
            const res = await apiRequest(`/medication-reminders`, {
                method: isEdit ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            });
            if (res.ok) router.back();
        } finally { setIsSaving(false); }
    };

    if (loadingConfig) return <View style={GlobalStyles.centered}><ActivityIndicator color={COLORS.primary} /></View>;

    return (
        <View style={GlobalStyles.container}>
            <Appbar.Header style={{ backgroundColor: COLORS.background }}>
                <Appbar.BackAction onPress={() => router.back()} disabled={isSaving} />
                <Appbar.Content title={isEdit ? "Edit Reminder" : "New Reminder"} titleStyle={styles.headerTitle} />
            </Appbar.Header>

            <ScrollView contentContainerStyle={GlobalStyles.scrollContent} showsVerticalScrollIndicator={false}>

                {/* 1. MEDICATION */}
                <View style={styles.fieldContainer}>
                    <Text style={styles.sectionLabel}>Select Medication *</Text>
                    <Menu
                        visible={medMenuVisible}
                        onDismiss={() => setMedMenuVisible(false)}
                        anchor={
                            <Button mode="outlined" onPress={() => setMedMenuVisible(true)} style={styles.pickerButton} icon="pill" contentStyle={{ height: 50 }} textColor={selectedMed ? COLORS.ink : COLORS.slate}>
                                {selectedMed ? selectedMed.name : "Choose medication..."}
                            </Button>
                        }
                    >
                        {library.map(m => (
                            <Menu.Item key={m.id} onPress={() => { setSelectedMed(m); setDosage(''); setMedMenuVisible(false); setErrors({ ...errors, med: false }); }} title={m.name} leadingIcon="pill" />
                        ))}
                    </Menu>
                    <HelperText type="error" visible={errors.med} style={styles.helper}>Required</HelperText>
                </View>

                {/* 2. DOSAGE */}
                {selectedMed && (
                    <View style={styles.fieldContainer}>
                        <Text style={styles.sectionLabel}>Dosage *</Text>
                        <View style={styles.chipRow}>
                            {selectedMed.default_dosage.split(',').map((opt: string) => {
                                const isSel = dosage === opt.trim() && !customDosage;
                                return (
                                    <Chip key={opt} selected={isSel} onPress={() => { setDosage(opt.trim()); setCustomDosage(''); setErrors({ ...errors, dosage: false }); }}
                                        style={[styles.chip, { backgroundColor: isSel ? COLORS.ink : 'white' }]}
                                        textStyle={{ color: isSel ? 'white' : COLORS.slate, fontWeight: 'bold' }} showSelectedCheck={false}>
                                        {opt.trim()}
                                    </Chip>
                                );
                            })}
                        </View>
                        <TextInput label="Custom Dosage" value={customDosage} onChangeText={(t) => { setCustomDosage(t); setDosage(''); setErrors({ ...errors, dosage: false }); }} mode="outlined" style={styles.input} dense />
                        <HelperText type="error" visible={errors.dosage} style={styles.helper}>Please select or enter a dose</HelperText>
                    </View>
                )}

                {/* 3. MEAL SCHEDULE */}
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionHeaderText}>MEAL SCHEDULE</Text>
                </View>
                <Surface style={styles.scheduleSurface} elevation={0}>
                    {(['breakfast', 'lunch', 'dinner'] as const).map((meal) => (
                        <View key={meal} style={styles.mealRow}>
                            <Text style={styles.mealLabel}>{meal.charAt(0).toUpperCase() + meal.slice(1)}</Text>
                            <View style={styles.timingToggle}>
                                {(['before', 'after'] as const).map((t) => {
                                    const isSel = mealSelections[meal].enabled && mealSelections[meal].timing === t;
                                    return (
                                        <Chip key={t} selected={isSel} onPress={() => toggleMealTiming(meal, t)}
                                            style={[styles.miniChip, { backgroundColor: isSel ? COLORS.primary : 'white' }]}
                                            textStyle={{ color: isSel ? 'white' : COLORS.slate, fontSize: 11 }} showSelectedCheck={false}>
                                            {t.charAt(0).toUpperCase() + t.slice(1)}
                                        </Chip>
                                    );
                                })}
                            </View>
                        </View>
                    ))}
                    <View style={[styles.mealRow, { borderBottomWidth: 0 }]}>
                        <Text style={styles.mealLabel}>Before Bed</Text>
                        <Chip selected={mealSelections.bedtime.enabled} onPress={() => setMealSelections({ ...mealSelections, bedtime: { enabled: !mealSelections.bedtime.enabled, timing: 'before' } })}
                            style={[styles.miniChip, { backgroundColor: mealSelections.bedtime.enabled ? COLORS.primary : 'white' }]}
                            textStyle={{ color: mealSelections.bedtime.enabled ? 'white' : COLORS.slate, fontSize: 11 }} showSelectedCheck={false}>
                            Enable
                        </Chip>
                    </View>
                </Surface>

                {/* 4. ALARMS */}
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionHeaderText}>TRIGGER ALARMS</Text>
                </View>
                <Surface style={styles.alarmSurface} elevation={0}>
                    {[0, 1, 2, 3].map((i) => (
                        <View key={i} style={styles.alarmRow}>
                            <Pressable style={[styles.alarmCheckbox, { backgroundColor: activeAlarms[i] ? COLORS.primary : 'white', borderColor: activeAlarms[i] ? COLORS.primary : COLORS.background }]}
                                onPress={() => { const next = [...activeAlarms]; next[i] = !next[i]; setActiveAlarms(next); }}>
                                {activeAlarms[i] && <MaterialCommunityIcons name="check" size={16} color="white" />}
                            </Pressable>
                            <View style={styles.timeInputWrapper}>
                                {Platform.OS === 'web' ? (
                                    <input type="time" disabled={!activeAlarms[i]} value={formatTimeForWeb(alarmTimes[i])} style={webTimeInputStyle}
                                        onChange={(e) => { const [h, m] = e.target.value.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); const n = [...alarmTimes]; n[i] = d; setAlarmTimes(n); }}
                                    />
                                ) : (
                                    <Pressable style={[styles.timeBtn, { opacity: activeAlarms[i] ? 1 : 0.3 }]} onPress={() => activeAlarms[i] && setShowTimePicker(i)}>
                                        <Text style={styles.timeText}>{alarmTimes[i].toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</Text>
                                    </Pressable>
                                )}
                            </View>
                            <Text style={styles.alarmLabel}>Alarm {i + 1}</Text>
                        </View>
                    ))}
                </Surface>

                {/* --- 5. ALERT SOUNDS (REFACTORED & ALIGNED) --- */}
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionHeaderText}>ALERT SOUND</Text>
                </View>
                <Surface style={[styles.cardSurface, { padding: 12 }]} elevation={0}>
                    <View style={styles.chipRow}>
                        {SOUND_OPTIONS.map((opt) => {
                            const isSel = selectedSound === opt.value;
                            return (
                                <Chip
                                    key={opt.value}
                                    selected={isSel}
                                    onPress={() => playPreview(opt.value)}
                                    icon={opt.icon}
                                    style={[styles.chip, { backgroundColor: isSel ? COLORS.primary : 'white' }]}
                                    selectedColor={isSel ? 'white' : COLORS.primary}
                                    showSelectedCheck={false}
                                >
                                    {opt.label}
                                </Chip>
                            );
                        })}
                    </View>
                    <Text variant="labelSmall" style={styles.audioHint}>Tap to preview sound</Text>
                </Surface>

                {showTimePicker !== null && Platform.OS !== 'web' && (
                    <DateTimePicker value={alarmTimes[showTimePicker]} mode="time" is24Hour={true} display="default" onChange={(e, d) => { if (Platform.OS === 'android') setShowTimePicker(null); if (d && e.type === 'set') { const n = [...alarmTimes]; n[showTimePicker] = d; setAlarmTimes(n); } }} />
                )}

                {/* 5. FREQUENCY */}
                <View style={[styles.fieldContainer, { marginTop: 20 }]}>
                    <Text style={styles.sectionLabel}>Repeat Frequency</Text>
                    <TextInput label="Repeat every (days)" value={frequencyDays} onChangeText={setFrequencyDays} keyboardType="numeric" mode="outlined" style={styles.input} left={<TextInput.Icon icon="calendar-refresh" color={COLORS.primary} />} />
                    <HelperText type="info" visible={false} style={styles.helper} children={undefined} />
                </View>


                <Button mode="contained" onPress={handleSave} loading={isSaving} disabled={isSaving} style={styles.saveButton} buttonColor={COLORS.primary}>
                    {isEdit ? "Update Schedule" : "Add to My Schedule"}
                </Button>
            </ScrollView>
        </View>
    );
}

const webTimeInputStyle = { border: '1px solid #E2E8F0', padding: '10px', borderRadius: '8px', width: '100%', fontFamily: 'inherit', fontSize: '16px', textAlign: 'center' as const };

const styles = StyleSheet.create({
    headerTitle: { fontWeight: '800', fontSize: 18 },
    fieldContainer: { marginBottom: 4 },
    sectionLabel: { fontSize: 16, fontWeight: '800', color: COLORS.ink, marginBottom: 8 },
    pickerButton: { borderRadius: RADIUS.md, backgroundColor: 'white', borderColor: COLORS.background },
    input: { backgroundColor: 'white' },
    helper: { height: 20, marginTop: -2 },

    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
    chip: { borderRadius: 12, ...SHADOWS.soft },

    cardSurface: { backgroundColor: 'white', borderRadius: RADIUS.lg, paddingVertical: 4, ...SHADOWS.soft, marginBottom: 12 },
    sectionHeader: { marginTop: 12, marginBottom: 16, borderLeftWidth: 4, borderLeftColor: COLORS.primary, paddingLeft: 12 },
    sectionHeaderText: { fontSize: 11, fontWeight: '800', color: COLORS.primary, letterSpacing: 1 },

    scheduleSurface: { backgroundColor: 'white', borderRadius: RADIUS.lg, paddingVertical: 4, ...SHADOWS.soft, marginBottom: 12 },
    mealRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.background },
    mealLabel: { fontSize: 15, fontWeight: '600', color: COLORS.ink },
    timingToggle: { flexDirection: 'row', gap: 8 },
    miniChip: { height: 32, borderRadius: 10, borderWidth: 1, borderColor: COLORS.background },

    alarmSurface: { backgroundColor: 'white', borderRadius: RADIUS.lg, padding: 16, ...SHADOWS.soft },
    alarmRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
    alarmCheckbox: { width: 28, height: 28, borderRadius: 8, borderWidth: 2, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
    timeInputWrapper: { flex: 1, marginRight: 12 },
    timeBtn: { backgroundColor: COLORS.background, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
    timeText: { fontSize: 16, fontWeight: '700', color: COLORS.ink, letterSpacing: 1 },
    alarmLabel: { width: 60, textAlign: 'right', fontSize: 11, fontWeight: '800', color: COLORS.secondary },
    audioHint: { opacity: 0.4, marginTop: 8, textAlign: 'center' },

    saveButton: { borderRadius: RADIUS.lg, height: 56, justifyContent: 'center', marginTop: 10, ...SHADOWS.medium }
});