import DateTimePicker from '@react-native-community/datetimepicker';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Button } from 'react-native-paper';

import { COLORS, RADIUS } from '../constants/theme';

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

  // Web: the library renders null and logs a warning. Nothing to show.
  if (Platform.OS === 'web') return null;

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
