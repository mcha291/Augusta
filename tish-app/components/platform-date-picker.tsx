import DateTimePicker from '@react-native-community/datetimepicker';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Button } from 'react-native-paper';

import { COLORS, RADIUS } from '../constants/theme';
import { toLocalDateString, toLocalTimeString } from '../utils/date';

/**
 * Parse an <input type="date|time"> value back into a local Date.
 *
 * `new Date('2026-07-30')` parses as UTC midnight, which lands on the previous
 * day for anyone west of UTC — so the components are pulled apart and fed to
 * the Date constructor, which is local-time.
 */
function parseLocalInputValue(raw: string, mode: 'date' | 'time', base: Date): Date | null {
  if (!raw) return null;

  if (mode === 'time') {
    const [hours, minutes] = raw.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    const next = new Date(base);
    next.setHours(hours, minutes, 0, 0);
    return next;
  }

  const [year, month, day] = raw.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const next = new Date(base);
  next.setFullYear(year, month - 1, day);
  next.setHours(0, 0, 0, 0);
  return next;
}

const webInputStyle = {
  padding: '14px',
  borderRadius: '12px',
  border: '1px solid #E2E8F0',
  backgroundColor: 'white',
  width: '100%',
  fontFamily: 'inherit',
  fontSize: '16px',
  outline: 'none',
  marginBottom: '12px',
} as const;

type Props = {
  visible: boolean;
  value: Date;
  mode?: 'date' | 'time';
  is24Hour?: boolean;
  minimumDate?: Date;
  maximumDate?: Date;
  /** User picked a value. The parent stores it AND closes the picker. */
  onConfirm: (d: Date) => void;
  /** User backed out. The parent just closes the picker. */
  onDismiss: () => void;
};

/**
 * Wraps @react-native-community/datetimepicker so the two platforms behave the
 * same way from the caller's point of view: exactly one of onConfirm/onDismiss
 * fires per interaction.
 *
 * This exists because the raw component is wildly different per platform, and
 * the naive `onChange={() => { setShow(false); ... }}` handler that reads fine
 * on Android silently breaks iOS — see the comments on each branch.
 */
export default function PlatformDatePicker({
  visible,
  value,
  mode = 'date',
  is24Hour,
  minimumDate,
  maximumDate,
  onConfirm,
  onDismiss,
}: Props) {
  const { t } = useTranslation();

  // iOS edits a draft copy so the wheels can be spun freely; nothing is
  // committed to the parent until "Done". Keyed on the timestamp rather than
  // the Date instance so a caller passing a fresh object each render (e.g.
  // `new Date()` as a fallback) can't drive this into a re-render loop.
  const [draft, setDraft] = useState(value);
  const valueTime = value.getTime();
  useEffect(() => { if (visible) setDraft(new Date(valueTime)); }, [visible, valueTime]);

  if (!visible) return null;

  // Web: @react-native-community/datetimepicker renders null here, which meant
  // birth date simply could not be set or changed in a web build. The browser's
  // own date/time input is the right substitute — it's the same control the web
  // branches in results.tsx already use.
  if (Platform.OS === 'web') {
    return (
      <Modal transparent visible animationType="fade" onRequestClose={onDismiss}>
        <Pressable style={styles.backdrop} onPress={onDismiss}>
          <Pressable style={styles.webSheet} onPress={() => {}}>
            <input
              type={mode === 'time' ? 'time' : 'date'}
              // Formatted in local time on purpose. `toISOString()` would show
              // the previous day for any user east of UTC before their offset
              // — the same defect as the birth_date one in signup.
              value={mode === 'time' ? toLocalTimeString(draft) : toLocalDateString(draft)}
              min={mode === 'time' ? undefined : minimumDate && toLocalDateString(minimumDate)}
              max={mode === 'time' ? undefined : maximumDate && toLocalDateString(maximumDate)}
              onChange={(e) => {
                const next = parseLocalInputValue(e.target.value, mode, draft);
                if (next) setDraft(next);
              }}
              style={webInputStyle}
            />
            <View style={styles.actions}>
              <Button mode="text" textColor={COLORS.slate} onPress={onDismiss}>
                {t('common.cancel')}
              </Button>
              <Button mode="contained" onPress={() => onConfirm(draft)}>
                {t('common.done')}
              </Button>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  // Android puts up its own modal dialog and fires onChange exactly once, with
  // event.type telling us whether the user confirmed or cancelled.
  if (Platform.OS === 'android') {
    return (
      <DateTimePicker
        value={value}
        mode={mode}
        is24Hour={is24Hour}
        minimumDate={minimumDate}
        maximumDate={maximumDate}
        display="default"
        onChange={(e, d) => {
          if (e.type === 'set' && d) onConfirm(d);
          else onDismiss();
        }}
      />
    );
  }

  // iOS renders *inline*, not as a dialog, and fires onChange on every single
  // wheel movement. Closing on the first onChange therefore tears the picker
  // down the moment the year wheel moves, before month/day can be chosen. So
  // the picker lives in our own modal and only commits on Done.
  return (
    <Modal transparent visible animationType="slide" onRequestClose={onDismiss}>
      <Pressable style={styles.backdrop} onPress={onDismiss}>
        {/* Swallow taps on the sheet itself so they don't dismiss it. */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <DateTimePicker
            value={draft}
            mode={mode}
            is24Hour={is24Hour}
            minimumDate={minimumDate}
            maximumDate={maximumDate}
            display="spinner"
            themeVariant="light"
            onChange={(_, d) => { if (d) setDraft(d); }}
          />
          <View style={styles.actions}>
            <Button mode="text" textColor={COLORS.slate} onPress={onDismiss}>
              {t('common.cancel')}
            </Button>
            <Button mode="contained" onPress={() => onConfirm(draft)}>
              {t('common.done')}
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15, 23, 42, 0.4)' },
  webSheet: {
    backgroundColor: 'white',
    borderTopLeftRadius: RADIUS.lg,
    borderTopRightRadius: RADIUS.lg,
    padding: 20,
    paddingBottom: 28,
  },
  sheet: {
    backgroundColor: 'white',
    borderTopLeftRadius: RADIUS.lg,
    borderTopRightRadius: RADIUS.lg,
    paddingHorizontal: 16,
    paddingBottom: 32,
    paddingTop: 8,
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
});
