import { MaterialCommunityIcons } from '@expo/vector-icons';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
    ActivityIndicator,
    Appbar,
    Button,
    Chip,
    Divider,
    Menu,
    Text,
    TextInput,
    useTheme,
} from 'react-native-paper';

const BASE_URL = 'https://zagxjje3mvzinf23amf46czfoy0vwctw.lambda-url.ap-southeast-2.on.aws';

type MealTiming = 'before' | 'after' | 'none';
interface MealSelection { enabled: boolean; timing: MealTiming; }
interface MealSelectionsState { breakfast: MealSelection; lunch: MealSelection; dinner: MealSelection; bedtime: MealSelection; }

const formatTimeForWeb = (date: Date) => date.toTimeString().slice(0, 5);

export default function MedicationReminderForm() {
    const theme = useTheme();
    const router = useRouter();

    const [library, setLibrary] = useState<any[]>([]);
    const [loadingConfig, setLoadingConfig] = useState(true);
    const [medMenuVisible, setMedMenuVisible] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const [selectedMed, setSelectedMed] = useState<any>(null);
    const [dosage, setDosage] = useState('');
    const [customDosage, setCustomDosage] = useState('');
    const [frequencyDays, setFrequencyDays] = useState('1');

    const [mealSelections, setMealSelections] = useState<MealSelectionsState>({
        breakfast: { enabled: false, timing: 'none' },
        lunch: { enabled: false, timing: 'none' },
        dinner: { enabled: false, timing: 'none' },
        bedtime: { enabled: false, timing: 'none' }
    });

    const [alarmTimes, setAlarmTimes] = useState<Date[]>([
        new Date(new Date().setHours(8, 0, 0, 0)),
        new Date(new Date().setHours(12, 0, 0, 0)),
        new Date(new Date().setHours(18, 0, 0, 0)),
        new Date(new Date().setHours(21, 0, 0, 0)),
    ]);
    const [activeAlarms, setActiveAlarms] = useState([true, false, false, false]);
    const [showTimePicker, setShowTimePicker] = useState<number | null>(null);

    useEffect(() => {
        fetch(`${BASE_URL}/medication-library`).then(res => res.json()).then(data => {
            setLibrary(data);
            setLoadingConfig(false);
        });
    }, []);

    const toggleMealTiming = (meal: keyof MealSelectionsState, timing: MealTiming) => {
        setMealSelections(prev => {
            const isCurrentlySelected = prev[meal].timing === timing && prev[meal].enabled;
            return {
                ...prev,
                [meal]: { enabled: !isCurrentlySelected, timing: isCurrentlySelected ? 'none' : timing }
            };
        });
    };

    const onTimeChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
        if (Platform.OS === 'android') setShowTimePicker(null);
        if (event.type === 'set' && selectedDate && showTimePicker !== null) {
            const newTimes = [...alarmTimes];
            newTimes[showTimePicker] = selectedDate;
            setAlarmTimes(newTimes);
        }
        if (Platform.OS === 'ios' && event.type === 'dismissed') setShowTimePicker(null);
    };

    const handleSave = async () => {
        const finalDosage = customDosage.trim() !== '' ? customDosage : dosage;
        if (!selectedMed || !finalDosage) { Alert.alert("Error", "Select medication and dosage."); return; }
        try {
            setIsSaving(true);
            const payload = {
                user_id: 1, med_id: selectedMed.id, selected_dosage: finalDosage,
                at_breakfast: mealSelections.breakfast.enabled, breakfast_timing: mealSelections.breakfast.timing,
                at_lunch: mealSelections.lunch.enabled, lunch_timing: mealSelections.lunch.timing,
                at_dinner: mealSelections.dinner.enabled, dinner_timing: mealSelections.dinner.timing,
                at_bedtime: mealSelections.bedtime.enabled, frequency_days: parseInt(frequencyDays) || 1,
                alarms: alarmTimes.filter((_, i) => activeAlarms[i]).map(d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }))
            };
            const res = await fetch(`${BASE_URL}/medication-reminders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (res.ok) router.back();
        } finally { setIsSaving(false); }
    };

    if (loadingConfig) return <View style={styles.centered}><ActivityIndicator size="large" /></View>;

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
            <Appbar.Header elevated>
                <Appbar.BackAction onPress={() => router.back()} />
                <Appbar.Content title="Setup Reminder" />
            </Appbar.Header>

            <ScrollView contentContainerStyle={styles.content}>
                <Text variant="titleMedium" style={styles.label}>1. Select Medication</Text>
                <Menu
                    visible={medMenuVisible}
                    onDismiss={() => setMedMenuVisible(false)}
                    anchor={
                        <Button mode="outlined" onPress={() => setMedMenuVisible(true)} style={styles.pickerButton} icon="pill">
                            {selectedMed ? selectedMed.name : "Choose medication..."}
                        </Button>
                    }
                >
                    {library.map(m => (
                        <Menu.Item key={m.id} onPress={() => { setSelectedMed(m); setDosage(''); setCustomDosage(''); setMedMenuVisible(false); }} title={m.name} leadingIcon="pill" />
                    ))}
                </Menu>

                {selectedMed && (
                    <View style={styles.dosageSection}>
                        <Text variant="labelMedium" style={styles.subLabel}>DOSAGE *</Text>
                        <View style={styles.chipGroup}>
                            {selectedMed.default_dosage.split(',').map((opt: string) => {
                                const isSel = dosage === opt.trim() && !customDosage;
                                return (
                                    <Chip
                                        key={opt}
                                        selected={isSel}
                                        onPress={() => {setDosage(opt.trim()); setCustomDosage('');}}
                                        style={[styles.chip, { backgroundColor: isSel ? theme.colors.primary : 'white' }]}
                                        selectedColor={isSel ? 'white' : theme.colors.primary}
                                        showSelectedCheck={false}
                                    >
                                        {opt.trim()}
                                    </Chip>
                                );
                            })}
                        </View>
                        <TextInput label="Custom Dosage" value={customDosage} onChangeText={(t) => {setCustomDosage(t); setDosage('');}} mode="outlined" dense style={{marginTop: 8, backgroundColor: 'white'}} />
                    </View>
                )}

                <Divider style={styles.divider} />

                <Text variant="titleMedium" style={styles.label}>2. Meal Schedule</Text>
                <View style={styles.checkboxGroup}>
                    {(['breakfast', 'lunch', 'dinner'] as const).map((meal) => (
                        <View key={meal} style={styles.mealRow}>
                            <Text variant="bodyLarge" style={styles.mealLabel}>{meal.charAt(0).toUpperCase() + meal.slice(1)}</Text>
                            <View style={styles.timingToggle}>
                                {(['before', 'after'] as const).map((t) => {
                                    const isSel = mealSelections[meal].enabled && mealSelections[meal].timing === t;
                                    return (
                                        <Chip 
                                            key={t}
                                            selected={isSel} 
                                            onPress={() => toggleMealTiming(meal, t)}
                                            style={[styles.miniChip, { backgroundColor: isSel ? theme.colors.primary : 'white' }]}
                                            selectedColor={isSel ? 'white' : theme.colors.onSurfaceVariant}
                                            showSelectedCheck={false}
                                        >{t.charAt(0).toUpperCase() + t.slice(1)}</Chip>
                                    );
                                })}
                            </View>
                        </View>
                    ))}
                    <View style={[styles.mealRow, { borderBottomWidth: 0 }]}>
                        <Text variant="bodyLarge" style={styles.mealLabel}>Before Bed</Text>
                        <Chip 
                            selected={mealSelections.bedtime.enabled} 
                            onPress={() => setMealSelections({...mealSelections, bedtime: { enabled: !mealSelections.bedtime.enabled, timing: 'before' }})}
                            style={[styles.miniChip, { backgroundColor: mealSelections.bedtime.enabled ? theme.colors.primary : 'white' }]}
                            selectedColor={mealSelections.bedtime.enabled ? 'white' : theme.colors.onSurfaceVariant}
                            showSelectedCheck={false}
                        >Enable</Chip>
                    </View>
                </View>

                <Divider style={styles.divider} />

                <Text variant="titleMedium" style={styles.label}>3. Trigger Alarms</Text>
                <View style={styles.alarmContainer}>
                    {[0, 1, 2, 3].map((i) => (
                        <View key={i} style={styles.alarmRow}>
                            <Pressable 
                                style={[styles.alarmCheckbox, { 
                                    backgroundColor: activeAlarms[i] ? theme.colors.primary : 'white', 
                                    borderColor: activeAlarms[i] ? theme.colors.primary : theme.colors.outline 
                                }]}
                                onPress={() => {
                                    const next = [...activeAlarms];
                                    next[i] = !next[i];
                                    setActiveAlarms(next);
                                }}
                            >
                                {activeAlarms[i] && <MaterialCommunityIcons name="check" size={16} color="white" />}
                            </Pressable>

                            <View style={styles.timeInputWrapper}>
                                {Platform.OS === 'web' ? (
                                    <input type="time" disabled={!activeAlarms[i]} value={formatTimeForWeb(alarmTimes[i])} onChange={(e) => {
                                        const [h, m] = e.target.value.split(':').map(Number);
                                        const d = new Date(); d.setHours(h, m, 0, 0);
                                        const n = [...alarmTimes]; n[i] = d; setAlarmTimes(n);
                                    }} style={{...webTimeInputStyle, backgroundColor: activeAlarms[i] ? 'white' : '#f0f0f0', opacity: activeAlarms[i] ? 1 : 0.5}} />
                                ) : (
                                    <Pressable style={[styles.timePickerBtn, { opacity: activeAlarms[i] ? 1 : 0.3 }]} onPress={() => activeAlarms[i] && setShowTimePicker(i)}>
                                        <Text variant="titleMedium">{alarmTimes[i].toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</Text>
                                    </Pressable>
                                )}
                            </View>
                            <Text variant="labelSmall" style={styles.alarmLabel}>Alarm {i+1}</Text>
                        </View>
                    ))}
                </View>

                {Platform.OS !== 'web' && showTimePicker !== null && (
                    <DateTimePicker value={alarmTimes[showTimePicker]} mode="time" is24Hour={true} display={Platform.OS === 'ios' ? 'spinner' : 'default'} onChange={onTimeChange} />
                )}

                <Divider style={styles.divider} />

                <Text variant="titleMedium" style={styles.label}>4. Cycle Frequency</Text>
                <TextInput label="Repeat every (days)" value={frequencyDays} onChangeText={setFrequencyDays} keyboardType="numeric" mode="outlined" style={{marginBottom: 30, backgroundColor: 'white'}} left={<TextInput.Icon icon="calendar-refresh" />} />

                <Button mode="contained" onPress={handleSave} loading={isSaving} disabled={isSaving || (!dosage && !customDosage)} style={styles.saveButton} icon="bell-plus">
                    Add to My Schedule
                </Button>
            </ScrollView>
        </View>
    );
}

const webTimeInputStyle = { padding: '10px', borderRadius: '4px', border: '1px solid #ccc', fontFamily: 'inherit', fontSize: '16px', width: '100%', cursor: 'pointer', textAlign: 'center' as const };

const styles = StyleSheet.create({
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    content: { padding: 20, paddingBottom: 100 },
    label: { marginBottom: 12, fontWeight: 'bold' },
    subLabel: { opacity: 0.6, marginBottom: 8, fontSize: 10, letterSpacing: 1 },
    pickerButton: { marginBottom: 20, borderRadius: 8, backgroundColor: 'white' },
    dosageSection: { marginBottom: 10 },
    chipGroup: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { marginBottom: 4, borderWidth: 1, borderColor: '#e0e0e0' },
    divider: { marginVertical: 20, opacity: 0.3 },
    checkboxGroup: { backgroundColor: 'rgba(0,0,0,0.02)', borderRadius: 12, overflow: 'hidden', paddingVertical: 8 },
    mealRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.05)' },
    mealLabel: { flex: 1, fontWeight: '500' },
    timingToggle: { flexDirection: 'row', gap: 8 },
    miniChip: { height: 32, justifyContent: 'center', borderWidth: 1, borderColor: '#e0e0e0' },
    alarmContainer: { padding: 12, backgroundColor: 'rgba(0,0,0,0.02)', borderRadius: 12 },
    alarmRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
    alarmCheckbox: { width: 28, height: 28, borderRadius: 6, borderWidth: 2, justifyContent: 'center', alignItems: 'center' },
    timeInputWrapper: { flex: 1, marginRight: 12 },
    timePickerBtn: { paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#ccc', alignItems: 'center', backgroundColor: 'white', borderRadius: 4 },
    alarmLabel: { opacity: 0.5, width: 60, textAlign: 'right', fontWeight: 'bold' },
    saveButton: { paddingVertical: 6, borderRadius: 12 }
});