import { MaterialCommunityIcons } from '@expo/vector-icons';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { goBackOrHome } from '@/utils/navigation';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
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
import PlatformDatePicker from '../components/platform-date-picker';
import { COLORS, RADIUS, SHADOWS } from '../constants/theme';
import { GlobalStyles } from '../styles/globalstyles';

import { SMS_VERIFICATION_ENABLED } from '@/constants/config';
import { apiRequest } from '@/utils/api';
import { apiErrorMessage, describeApiFailure } from '@/utils/api-errors';
import {
    DEFAULT_MEAL_TIMES,
    MEAL_LABEL_KEY,
    TIMING_LABEL_KEY,
    buildAlarmSet,
    dateToTimeString,
    type MealKey,
    type MealTimes,
} from '@/utils/meal-alarms';
import { snoozeMinutesFor } from '@/utils/alarm-settings';
import { scheduleMedicationNotifications } from '@/utils/notification-helper';
import ActiveProfileBadge from '@/components/active-profile-badge';
import { useAuth } from '@/context/AuthContext';


type MealTiming = 'before' | 'after' | 'none';
interface MealSelection { enabled: boolean; timing: MealTiming; }
interface MealSelectionsState { breakfast: MealSelection; lunch: MealSelection; dinner: MealSelection; bedtime: MealSelection; }

const formatTimeForWeb = (date: Date) => date.toTimeString().slice(0, 5);

/** 4.6 — escalation delay presets, in minutes. */
const DELAY_PRESETS = [15, 30, 60, 120];

/**
 * The custom delay floor is 10, not the 5 the plan originally proposed, and the
 * reason is Android rather than taste: 4.2 schedules the caregiver's copy
 * locally at dose time + delay, and Android throttles the app to one alarm per
 * nine minutes while the device is idle (P0.3). A 5-minute delay puts the
 * escalation alarm inside that window, where it can be silently deferred. The
 * database keeps the wider 5-240 bound so this stays a UI decision.
 */
const CUSTOM_DELAY_MIN = 10;
const CUSTOM_DELAY_MAX = 240;

/** D-9 / 2.6 — how many consecutive alerts one dose schedules. */
const BURST_OPTIONS = [1, 2, 3, 4, 5, 6];

/**
 * Migration 008 — how long the snooze button defers the alarm, in minutes.
 *
 * Presets rather than a number field, the same call the escalation delay makes
 * below: the primary users are elderly and the app leans on large targets
 * throughout.
 *
 * Capped at 30 here against the column's 120 on purpose. A snooze re-anchors the
 * escalation clock (D-6), so a long one is indistinguishable to the caregiver
 * from a patient who has quietly stopped responding — and D-12 only rescues that
 * after four presses. Nothing stops a longer value being stored; the form simply
 * does not lead anyone into it.
 */
const SNOOZE_OPTIONS = [5, 10, 15, 30];

export default function MedicationReminderForm() {
    const router = useRouter();
    const params = useLocalSearchParams();
    const { t } = useTranslation();
    const { activeDependent, user } = useAuth();
    const [selectedSound, setSelectedSound] = useState('default');
    const previewPlayer = useRef<AudioPlayer | null>(null);

    // Free the preview player when leaving the screen
    useEffect(() => () => { previewPlayer.current?.remove(); }, []);

    // Play a preview when the user taps a sound chip
    const playPreview = (soundKey: string) => {
        previewPlayer.current?.remove();
        const player = createAudioPlayer(SOUND_MAP[soundKey]);
        previewPlayer.current = player;
        player.play();
        setSelectedSound(soundKey);
    };
    const theme = useTheme();

    // Determine Edit Mode
    const isEdit = !!params.reminder;
    const initialData = isEdit ? JSON.parse(params.reminder as string) : null;

    const [library, setLibrary] = useState<any[]>([]);
    const [mealTimes, setMealTimes] = useState<MealTimes>(DEFAULT_MEAL_TIMES);
    const [loadingConfig, setLoadingConfig] = useState(true);
    const [configError, setConfigError] = useState(false);

    // Localised display label for a derived alarm, e.g. "Before dinner".
    const labelForMeal = (meal: MealKey, timing: 'before' | 'after' | 'at'): string =>
        timing === 'at'
            ? t(MEAL_LABEL_KEY[meal])
            : t('medicationReminderForm.mealAlarmLabel', {
                timing: t(TIMING_LABEL_KEY[timing]),
                meal: t(MEAL_LABEL_KEY[meal]),
            });
    const [medMenuVisible, setMedMenuVisible] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const notifyUser = (title: string, message: string) => {
        if (Platform.OS === 'web') window.alert(`${title}: ${message}`);
        else Alert.alert(title, message);
    };

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
            ? initialData.alarms.map((alarmTime: string) => {
                const [h, m] = alarmTime.split(':').map(Number);
                const d = new Date(); d.setHours(h, m, 0, 0); return d;
            })
            : [new Date(new Date().setHours(8, 0, 0, 0)), new Date(new Date().setHours(12, 0, 0, 0)), new Date(new Date().setHours(18, 0, 0, 0)), new Date(new Date().setHours(21, 0, 0, 0))]
    );
    const [activeAlarms, setActiveAlarms] = useState(initialData?.alarms ? [true, true, true, true].map((_, i) => i < initialData.alarms.length) : [true, false, false, false]);
    const [alarmLabels, setAlarmLabels] = useState<string[]>(
        [0, 1, 2, 3].map((i) => initialData?.alarm_labels?.[i] || t('medications.alarmDefaultLabel', { number: i + 1 }))
    );
    // --- 4.6 / 2.4 / 2.6 — escalation and alarm-burst settings (D-3, D-8, D-9) ---
    //
    // **The form default is ON while the column default is OFF, and that is
    // deliberate** (D-3). The column must not retroactively switch escalation on
    // for reminders that already exist — that would page caregivers about
    // historical doses the moment this ships. But a safety net nobody enables
    // isn't one, so new reminders opt in.
    const initialDelay = Number(initialData?.escalation_delay_minutes) || 30;
    const [escalationEnabled, setEscalationEnabled] = useState(
        initialData ? !!initialData.escalation_enabled : true
    );
    const [escalationDelay, setEscalationDelay] = useState(initialDelay);
    const [useCustomDelay, setUseCustomDelay] = useState(!DELAY_PRESETS.includes(initialDelay));
    const [customDelayText, setCustomDelayText] = useState(
        DELAY_PRESETS.includes(initialDelay) ? '' : String(initialDelay)
    );
    const [escalationOrder, setEscalationOrder] = useState<'caregiver_first' | 'sms_first'>(
        initialData?.escalation_order === 'sms_first' ? 'sms_first' : 'caregiver_first'
    );
    const [alarmRepeatCount, setAlarmRepeatCount] = useState(
        Number(initialData?.alarm_repeat_count) || 3
    );
    // Migration 008. Normalised through `alarm-settings` rather than with a
    // local `|| 10`, so the form, the scheduler and the server cannot disagree
    // about what an absent or malformed value means.
    const [snoozeMinutes, setSnoozeMinutes] = useState(
        snoozeMinutesFor(initialData?.snooze_minutes)
    );

    // Presets over a raw number input: the primary users are elderly, and the app
    // already leans on large targets elsewhere.
    const effectiveDelay = useCustomDelay ? parseInt(customDelayText, 10) : escalationDelay;
    const delayIsValid = Number.isInteger(effectiveDelay)
        && effectiveDelay >= CUSTOM_DELAY_MIN
        && effectiveDelay <= CUSTOM_DELAY_MAX;

    const [showTimePicker, setShowTimePicker] = useState<number | null>(null);

    // Error State
    const [errors, setErrors] = useState({ med: false, dosage: false, frequency: false, delay: false });

    // Was a bare .then() chain with no .catch(), clearing the loading flag only
    // on success — offline or a 5xx left a permanent spinner with no error and
    // no retry.
    const loadLibrary = async () => {
        setLoadingConfig(true);
        setConfigError(false);
        try {
            const [libRes, mealRes] = await Promise.all([
                apiRequest(`/medication-library`),
                apiRequest(`/meal-times`, {}, activeDependent?.id),
            ]);

            if (!libRes.ok) throw new Error(`HTTP ${libRes.status}`);
            const data = await libRes.json();
            setLibrary(Array.isArray(data) ? data : []);
            if (isEdit) {
                const fullMed = data.find((m: any) => m.id === initialData.med_id);
                if (fullMed) setSelectedMed(fullMed);
            }

            // Meal times are not fatal to this screen — a failure here just
            // means meal selections resolve against the defaults, which is a
            // better outcome than blocking the whole form.
            if (mealRes.ok) {
                const times = await mealRes.json();
                setMealTimes({ ...DEFAULT_MEAL_TIMES, ...times });
            } else {
                console.warn('Meal times unavailable; falling back to defaults');
            }
        } catch (e) {
            console.error('Medication library load failed:', e);
            setConfigError(true);
        } finally {
            setLoadingConfig(false);
        }
    };

    useEffect(() => { loadLibrary(); }, []);

    const toggleMealTiming = (meal: keyof MealSelectionsState, timing: MealTiming) => {
        setMealSelections(prev => {
            const isCurrentlySelected = prev[meal].timing === timing && prev[meal].enabled;
            return { ...prev, [meal]: { enabled: !isCurrentlySelected, timing: isCurrentlySelected ? 'none' : timing } };
        });
    };

    const handleSave = async () => {
        const finalDosage = customDosage.trim() !== '' ? customDosage : dosage;
        const newErrors = {
            med: !selectedMed,
            dosage: !finalDosage,
            frequency: !frequencyDays,
            // Only blocks when escalation is actually on — an invalid custom
            // delay on a reminder with escalation switched off is not a reason to
            // refuse the save.
            delay: escalationEnabled && !delayIsValid,
        };
        setErrors(newErrors);
        if (Object.values(newErrors).some(v => v)) return;

        try {
            setIsSaving(true);

            const activeIndexes = [0, 1, 2, 3].filter(i => activeAlarms[i]);
            const manualTimes = activeIndexes.map(i => dateToTimeString(alarmTimes[i]));
            const manualLabels = activeIndexes.map(i => alarmLabels[i].trim() || t('medications.alarmDefaultLabel', { number: i + 1 }));

            // Meal selections become real alarms here. They were previously
            // collected, stored and displayed back to the patient, but the
            // scheduler only ever reads `alarms` — so "with breakfast" showed
            // as active and never fired. Resolving at save time means the
            // device scheduler needs no meal logic of its own.
            const resolved = buildAlarmSet({
                manualTimes,
                manualLabels,
                mealSelections,
                mealTimes,
                labelForMeal,
            });

            const payload = {
                id: initialData?.id,
                med_id: selectedMed.id,
                selected_dosage: finalDosage,
                at_breakfast: mealSelections.breakfast.enabled, breakfast_timing: mealSelections.breakfast.timing,
                at_lunch: mealSelections.lunch.enabled, lunch_timing: mealSelections.lunch.timing,
                at_dinner: mealSelections.dinner.enabled, dinner_timing: mealSelections.dinner.timing,
                at_bedtime: mealSelections.bedtime.enabled,
                frequency_days: parseInt(frequencyDays) || 1,
                alarms: resolved.alarms,
                alarm_labels: resolved.alarm_labels,
                alarm_sources: resolved.alarm_sources,
                reminder_sound: selectedSound, // <-- was missing entirely before
                // 4.6 — the delay is only meaningful when escalation is on, but
                // it is sent either way so switching escalation back on later
                // restores the value the user chose rather than the default.
                escalation_enabled: escalationEnabled,
                escalation_delay_minutes: effectiveDelay,
                escalation_order: escalationOrder,
                alarm_repeat_count: alarmRepeatCount,
                snooze_minutes: snoozeMinutes,
            };

            const res = await apiRequest(`/medication-reminders`, {
                method: isEdit ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload
            }, activeDependent?.id);

            if (res.ok) {
                // Try to get the saved record's id (needed for new reminders so we can
                // key their scheduled notifications). Falls back to the existing id on edit.
                let savedId = initialData?.id;
                try {
                    const saved = await res.json();
                    if (saved?.id) savedId = saved.id;
                } catch {
                    // no JSON body returned — fine for edits, we already have the id
                }

                if (savedId && Platform.OS !== 'web') {
                    await scheduleMedicationNotifications({
                        id: savedId,
                        // 4.2 — the owner, so this alarm gets an owner-namespaced
                        // identifier straight away. Without it the alarm is
                        // written un-namespaced and only gets rewritten at the
                        // next reconciliation; it would still be cancellable, but
                        // the device would briefly hold a set it can't attribute.
                        user_id: activeDependent?.id ?? user?.id,
                        // Carry the reminder's real status. Hardcoding 'active'
                        // meant editing an *inactive* reminder scheduled alarms
                        // for it — the device then held alarms the server
                        // considered inactive until the next medications-screen
                        // re-sync repaired it.
                        status: initialData?.status ?? 'active',
                        med_name: selectedMed.name,
                        selected_dosage: finalDosage,
                        alarms: resolved.alarms,
                        alarm_labels: resolved.alarm_labels,
                        reminder_sound: selectedSound,
                        frequency_days: parseInt(frequencyDays) || 1, // <-- added
                        // 4.2 item 4 — carried so a caregiver saving a
                        // dependent's reminder schedules the *escalation* copy
                        // straight away, at dose time + delay, rather than a
                        // duplicate alarm that only gets corrected at the next
                        // reconciliation. Without these the object below would
                        // read as escalation-off and the caregiver's device
                        // would schedule nothing at all until then.
                        escalation_enabled: escalationEnabled,
                        escalation_delay_minutes: effectiveDelay,
                        // Carried for the same reason as the two above: this
                        // object is what the scheduler writes into the OS queue
                        // right now, and anything missing from it is a setting
                        // the alarms do not honour until the next reconcile.
                        // `alarm_repeat_count` was already missing here — a
                        // reminder saved with a burst of 5 scheduled 3 until
                        // the medications screen next re-synced.
                        alarm_repeat_count: alarmRepeatCount,
                        snooze_minutes: snoozeMinutes,
                    }, { viewerUserId: user?.id });
                }

                goBackOrHome(router);
            } else {
                // A non-2xx used to fall straight through to the finally block,
                // leaving the form looking like nothing had happened.
                // 6.2 — `detail.error` was the server's English, shown as-is.
                // This is also the form 4.6's field validation answers, so the
                // `problems` rung earns its keep here: a delay outside 5–240
                // now names the delay rather than reporting a generic failure.
                notifyUser(t('common.error'), apiErrorMessage(await describeApiFailure(res), t));
            }
        } catch (e) {
            console.error('Reminder save failed:', e);
            notifyUser(t('common.error'), t('medicationReminderForm.saveFailed'));
        } finally { setIsSaving(false); }
    };

    if (loadingConfig) return <View style={GlobalStyles.centered}><ActivityIndicator color={COLORS.primary} /></View>;

    if (configError) {
        return (
            <View style={GlobalStyles.centered}>
                <Text style={styles.errorTitle}>{t('medicationReminderForm.configLoadFailed')}</Text>
                <Text style={styles.errorBody}>{t('medicationReminderForm.configLoadFailedHint')}</Text>
                <Button mode="contained" onPress={loadLibrary} icon="refresh" style={{ marginTop: 16 }}>
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
                <Appbar.BackAction onPress={() => goBackOrHome(router)} disabled={isSaving} />
                <Appbar.Content title={isEdit ? t('medicationReminderForm.editTitle') : t('medicationReminderForm.newTitle')} titleStyle={styles.headerTitle} />
                <ActiveProfileBadge />
            </Appbar.Header>

            <ScrollView contentContainerStyle={GlobalStyles.scrollContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

                {/* 1. MEDICATION */}
                <View style={styles.fieldContainer}>
                    <Text style={styles.sectionLabel}>{t('medicationReminderForm.selectMedication')}</Text>
                    <Menu
                        visible={medMenuVisible}
                        onDismiss={() => setMedMenuVisible(false)}
                        anchor={
                            <Button mode="outlined" onPress={() => setMedMenuVisible(true)} style={styles.pickerButton} icon="pill" contentStyle={{ height: 50 }} textColor={selectedMed ? COLORS.ink : COLORS.slate}>
                                {selectedMed ? selectedMed.name : t('medicationReminderForm.chooseMedication')}
                            </Button>
                        }
                    >
                        {library.map(m => (
                            <Menu.Item key={m.id} onPress={() => { setSelectedMed(m); setDosage(''); setMedMenuVisible(false); setErrors({ ...errors, med: false }); }} title={m.name} leadingIcon="pill" />
                        ))}
                    </Menu>
                    <HelperText type="error" visible={errors.med} style={styles.helper}>{t('common.required')}</HelperText>
                </View>

                {/* 2. DOSAGE */}
                {selectedMed && (
                    <View style={styles.fieldContainer}>
                        <Text style={styles.sectionLabel}>{t('medicationReminderForm.dosageLabel')}</Text>
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
                        <TextInput label={t('medicationReminderForm.customDosage')} value={customDosage} onChangeText={(val) => { setCustomDosage(val); setDosage(''); setErrors({ ...errors, dosage: false }); }} mode="outlined" style={styles.input} dense />
                        <HelperText type="error" visible={errors.dosage} style={styles.helper}>{t('medicationReminderForm.doseRequired')}</HelperText>
                    </View>
                )}

                {/* 3. MEAL SCHEDULE */}
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionHeaderText}>{t('medicationReminderForm.scheduleSection')}</Text>
                </View>
                <Surface style={styles.scheduleSurface} elevation={0}>
                    {(['breakfast', 'lunch', 'dinner'] as const).map((meal) => (
                        <View key={meal} style={styles.mealRow}>
                            <Text style={styles.mealLabel}>{t(`mealTypes.${meal}`)}</Text>
                            <View style={styles.timingToggle}>
                                {(['before', 'after'] as const).map((timing) => {
                                    const isSel = mealSelections[meal].enabled && mealSelections[meal].timing === timing;
                                    return (
                                        <Chip key={timing} selected={isSel} onPress={() => toggleMealTiming(meal, timing)}
                                            style={[styles.miniChip, { backgroundColor: isSel ? COLORS.primary : 'white' }]}
                                            textStyle={{ color: isSel ? 'white' : COLORS.slate, fontSize: 11 }} showSelectedCheck={false}>
                                            {t(`mealTypes.${timing}`)}
                                        </Chip>
                                    );
                                })}
                            </View>
                        </View>
                    ))}
                    <View style={[styles.mealRow, { borderBottomWidth: 0 }]}>
                        <Text style={styles.mealLabel}>{t('medicationReminderForm.beforeBed')}</Text>
                        <Chip selected={mealSelections.bedtime.enabled} onPress={() => setMealSelections({ ...mealSelections, bedtime: { enabled: !mealSelections.bedtime.enabled, timing: 'before' } })}
                            style={[styles.miniChip, { backgroundColor: mealSelections.bedtime.enabled ? COLORS.primary : 'white' }]}
                            textStyle={{ color: mealSelections.bedtime.enabled ? 'white' : COLORS.slate, fontSize: 11 }} showSelectedCheck={false}>
                            {t('medicationReminderForm.enable')}
                        </Chip>
                    </View>
                </Surface>

                {/* 4. ALARMS */}
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionHeaderText}>{t('medicationReminderForm.alarmsSection')}</Text>
                </View>
                <Surface style={styles.alarmSurface} elevation={0}>
                    {[0, 1, 2, 3].map((i) => (
                        <View key={i} style={styles.alarmRow}>
                            <Pressable
                                style={[styles.alarmCheckbox, {
                                    backgroundColor: activeAlarms[i] ? COLORS.primary : 'white',
                                    borderColor: activeAlarms[i] ? COLORS.primary : COLORS.background
                                }]}
                                onPress={() => {
                                    const next = [...activeAlarms]; next[i] = !next[i]; setActiveAlarms(next);
                                }}>
                                {activeAlarms[i] && <MaterialCommunityIcons name="check" size={16} color="white" />}
                            </Pressable>
                            <TextInput
                                style={[styles.alarmLabel, { opacity: activeAlarms[i] ? 1 : 0.3 }]}
                                value={alarmLabels[i]}
                                onChangeText={(val) => { const n = [...alarmLabels]; n[i] = val; setAlarmLabels(n); }}
                                editable={activeAlarms[i]}
                                placeholder={t('medications.alarmDefaultLabel', { number: i + 1 })}
                                dense
                                underlineColor="transparent"
                                activeUnderlineColor={COLORS.primary}
                            />
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
                        </View>
                    ))}
                </Surface>

                {/* --- 5. ALERT SOUNDS (REFACTORED & ALIGNED) --- */}
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionHeaderText}>{t('medicationReminderForm.soundSection')}</Text>
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
                                    {t(opt.labelKey)}
                                </Chip>
                            );
                        })}
                    </View>
                    <Text variant="labelSmall" style={styles.audioHint}>{t('medicationReminderForm.tapToPreview')}</Text>
                </Surface>

                {/* --- 5b. ALARM REPEATS (D-9 / 2.6) --- */}
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionHeaderText}>{t('medicationReminderForm.burstSection')}</Text>
                </View>
                <Surface style={[styles.cardSurface, { padding: 12 }]} elevation={0}>
                    <Text style={styles.sectionLabel}>{t('medicationReminderForm.burstLabel')}</Text>
                    <View style={styles.chipRow}>
                        {BURST_OPTIONS.map((count) => {
                            const isSel = alarmRepeatCount === count;
                            return (
                                <Chip
                                    key={count}
                                    selected={isSel}
                                    onPress={() => setAlarmRepeatCount(count)}
                                    style={[styles.chip, { backgroundColor: isSel ? COLORS.primary : 'white' }]}
                                    selectedColor={isSel ? 'white' : COLORS.primary}
                                    showSelectedCheck={false}
                                >
                                    {String(count)}
                                </Chip>
                            );
                        })}
                    </View>
                    {/*
                      Left enabled on Android rather than hidden: the setting lives
                      on the reminder, not the device, and a patient on Android may
                      have a caregiver on iOS whose phone honours it. But say
                      plainly what Android will do — one alert regardless, because
                      the platform rate-limits an app to one alarm per nine minutes
                      while idle (D-10).
                    */}
                    {Platform.OS === 'android' ? (
                        <Text variant="labelSmall" style={styles.audioHint}>{t('medicationReminderForm.burstAndroidNote')}</Text>
                    ) : null}
                </Surface>

                {/* --- 5c. SNOOZE (4.4 / migration 008) --- */}
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionHeaderText}>{t('medicationReminderForm.snoozeSection')}</Text>
                </View>
                <Surface style={[styles.cardSurface, { padding: 12 }]} elevation={0}>
                    <Text style={styles.sectionLabel}>{t('medicationReminderForm.snoozeLabel')}</Text>
                    <View style={styles.chipRow}>
                        {SNOOZE_OPTIONS.map((minutes) => {
                            const isSel = snoozeMinutes === minutes;
                            return (
                                <Chip
                                    key={minutes}
                                    selected={isSel}
                                    onPress={() => setSnoozeMinutes(minutes)}
                                    style={[styles.chip, { backgroundColor: isSel ? COLORS.primary : 'white' }]}
                                    selectedColor={isSel ? 'white' : COLORS.primary}
                                    showSelectedCheck={false}
                                >
                                    {t('medicationReminderForm.snoozeOption', { minutes })}
                                </Chip>
                            );
                        })}
                    </View>
                    {/*
                      Said out loud because it is the one thing about this setting
                      a patient cannot infer, and it has a consequence: a snooze
                      re-anchors the caregiver escalation clock (D-6), so a longer
                      snooze is also a longer wait before anyone else is told. Only
                      shown when escalation is actually on — otherwise there is no
                      caregiver to delay and the sentence would be noise.
                    */}
                    {escalationEnabled ? (
                        <Text variant="labelSmall" style={styles.audioHint}>{t('medicationReminderForm.snoozeEscalationNote')}</Text>
                    ) : null}
                </Surface>

                {/* --- 5d. CAREGIVER ESCALATION (D-3 / D-8 / 2.4) --- */}
                <View style={styles.sectionHeader}>
                    <Text style={styles.sectionHeaderText}>{t('medicationReminderForm.escalationSection')}</Text>
                </View>
                <Surface style={[styles.cardSurface, { padding: 12 }]} elevation={0}>
                    <Chip
                        selected={escalationEnabled}
                        onPress={() => setEscalationEnabled(!escalationEnabled)}
                        icon={escalationEnabled ? 'account-alert' : 'account-off-outline'}
                        style={[styles.chip, { backgroundColor: escalationEnabled ? COLORS.primary : 'white', alignSelf: 'flex-start' }]}
                        selectedColor={escalationEnabled ? 'white' : COLORS.primary}
                        showSelectedCheck={false}
                    >
                        {t('medicationReminderForm.escalationEnabledLabel')}
                    </Chip>

                    {escalationEnabled ? (
                        <View style={{ marginTop: 14 }}>
                            <Text style={styles.sectionLabel}>{t('medicationReminderForm.escalationDelayLabel')}</Text>
                            <View style={styles.chipRow}>
                                {DELAY_PRESETS.map((minutes) => {
                                    const isSel = !useCustomDelay && escalationDelay === minutes;
                                    return (
                                        <Chip
                                            key={minutes}
                                            selected={isSel}
                                            onPress={() => {
                                                setUseCustomDelay(false);
                                                setEscalationDelay(minutes);
                                                setErrors({ ...errors, delay: false });
                                            }}
                                            style={[styles.chip, { backgroundColor: isSel ? COLORS.primary : 'white' }]}
                                            selectedColor={isSel ? 'white' : COLORS.primary}
                                            showSelectedCheck={false}
                                        >
                                            {t('medicationReminderForm.escalationDelayOption', { minutes })}
                                        </Chip>
                                    );
                                })}
                                <Chip
                                    selected={useCustomDelay}
                                    onPress={() => setUseCustomDelay(true)}
                                    style={[styles.chip, { backgroundColor: useCustomDelay ? COLORS.primary : 'white' }]}
                                    selectedColor={useCustomDelay ? 'white' : COLORS.primary}
                                    showSelectedCheck={false}
                                >
                                    {t('medicationReminderForm.escalationDelayCustom')}
                                </Chip>
                            </View>

                            {useCustomDelay ? (
                                <TextInput
                                    label={t('medicationReminderForm.escalationDelayCustomLabel')}
                                    value={customDelayText}
                                    onChangeText={(val) => { setCustomDelayText(val); setErrors({ ...errors, delay: false }); }}
                                    keyboardType="numeric"
                                    mode="outlined"
                                    error={errors.delay}
                                    style={styles.input}
                                    dense
                                />
                            ) : null}
                            <HelperText type="error" visible={errors.delay} style={styles.helper}>
                                {t('medicationReminderForm.escalationDelayInvalid', { min: CUSTOM_DELAY_MIN, max: CUSTOM_DELAY_MAX })}
                            </HelperText>

                            <Text style={styles.sectionLabel}>{t('medicationReminderForm.escalationOrderLabel')}</Text>
                            <View style={styles.chipRow}>
                                <Chip
                                    selected={escalationOrder === 'caregiver_first'}
                                    onPress={() => setEscalationOrder('caregiver_first')}
                                    style={[styles.chip, { backgroundColor: escalationOrder === 'caregiver_first' ? COLORS.primary : 'white' }]}
                                    selectedColor={escalationOrder === 'caregiver_first' ? 'white' : COLORS.primary}
                                    showSelectedCheck={false}
                                >
                                    {t('medicationReminderForm.escalationOrderCaregiver')}
                                </Chip>
                                {/*
                                  D-8: sms_first stays unselectable until Track B
                                  lands and phone numbers are actually verified.
                                  Texting a medication reminder to an unverified
                                  number risks sending PHI to a stranger. Disabled
                                  with a reason rather than hidden, and rather than
                                  offered as a choice that silently falls back.
                                */}
                                <Chip
                                    selected={escalationOrder === 'sms_first'}
                                    disabled={!SMS_VERIFICATION_ENABLED}
                                    onPress={() => setEscalationOrder('sms_first')}
                                    style={[styles.chip, { backgroundColor: escalationOrder === 'sms_first' ? COLORS.primary : 'white' }]}
                                    selectedColor={escalationOrder === 'sms_first' ? 'white' : COLORS.primary}
                                    showSelectedCheck={false}
                                >
                                    {t('medicationReminderForm.escalationOrderSms')}
                                </Chip>
                            </View>
                            {!SMS_VERIFICATION_ENABLED ? (
                                <Text variant="labelSmall" style={styles.audioHint}>{t('medicationReminderForm.escalationOrderSmsUnavailable')}</Text>
                            ) : null}
                        </View>
                    ) : null}
                </Surface>

                <PlatformDatePicker
                    visible={showTimePicker !== null}
                    value={showTimePicker !== null ? alarmTimes[showTimePicker] : new Date()}
                    mode="time"
                    is24Hour={true}
                    onConfirm={d => {
                        if (showTimePicker !== null) {
                            const n = [...alarmTimes];
                            n[showTimePicker] = d;
                            setAlarmTimes(n);
                        }
                        setShowTimePicker(null);
                    }}
                    onDismiss={() => setShowTimePicker(null)}
                />

                {/* 5. FREQUENCY */}
                <View style={[styles.fieldContainer, { marginTop: 20 }]}>
                    <Text style={styles.sectionLabel}>{t('medicationReminderForm.repeatFrequency')}</Text>
                    <TextInput label={t('medicationReminderForm.repeatEveryDays')} value={frequencyDays} onChangeText={setFrequencyDays} keyboardType="numeric" mode="outlined" style={styles.input} left={<TextInput.Icon icon="calendar-refresh" color={COLORS.primary} />} />
                    <HelperText type="info" visible={false} style={styles.helper}>{null}</HelperText>
                </View>


                <Button mode="contained" onPress={handleSave} loading={isSaving} disabled={isSaving} style={styles.saveButton} buttonColor={COLORS.primary}>
                    {isEdit ? t('medicationReminderForm.updateSchedule') : t('medicationReminderForm.addToSchedule')}
                </Button>
            </ScrollView>
        </View>
    );
}

const webTimeInputStyle = { border: '1px solid #E2E8F0', padding: '10px', borderRadius: '8px', width: '100%', fontFamily: 'inherit', fontSize: '16px', textAlign: 'center' as const };

const styles = StyleSheet.create({
    headerTitle: { fontWeight: '800', fontSize: 18 },
    errorTitle: { fontSize: 18, fontWeight: '800', color: COLORS.ink, textAlign: 'center', paddingHorizontal: 24 },
    errorBody: { fontSize: 14, color: COLORS.slate, textAlign: 'center', marginTop: 8, paddingHorizontal: 32, lineHeight: 20 },
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
    timeInputWrapper: { width: 100, marginRight: 12 },
    alarmLabel: { flex: 1, textAlign: 'left', fontSize: 14, fontWeight: '800', color: COLORS.primary },
    timeBtn: { backgroundColor: COLORS.background, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
    timeText: { fontSize: 16, fontWeight: '700', color: COLORS.ink, letterSpacing: 1 },
    audioHint: { opacity: 0.4, marginTop: 8, textAlign: 'center' },

    saveButton: { borderRadius: RADIUS.lg, height: 56, justifyContent: 'center', marginTop: 10, ...SHADOWS.medium }
});