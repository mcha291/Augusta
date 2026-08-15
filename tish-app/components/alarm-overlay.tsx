import { SOUND_MAP } from '@/constants/sounds';
import { useAuth } from '@/context/AuthContext';
import { useResolvedReminder } from '@/hooks/use-resolved-reminder';
import { recordDoseAction } from '@/utils/dose-queue';
import { DEFAULT_SNOOZE_MINUTES } from '@/utils/alarm-settings';
import { dismissPresentedAlarms, scheduleSnoozeAlert } from '@/utils/notification-helper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useAudioPlayer } from 'expo-audio';
import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, StyleSheet, View } from 'react-native';
import { Button, Surface, Text } from 'react-native-paper';

interface AlarmOverlayProps {
  isVisible: boolean;
  /**
   * 4.3 — the alarm identifies its reminder and nothing more. Medication name
   * and dosage are resolved here, when the overlay opens, rather than being
   * carried in the notification payload where they froze at schedule time.
   */
  reminderId?: number | null;
  ownerUserId?: number | null;
  /** Which alarm slot fired, used to pick the right label of several. */
  timeStr?: string | null;
  soundKey: string;
  /** How long the snooze button defers the alarm, in minutes. */
  snoozeMinutes?: number;
  onDismiss: () => void;
}

export default function AlarmOverlay({
  isVisible,
  reminderId,
  ownerUserId,
  timeStr,
  soundKey,
  snoozeMinutes = DEFAULT_SNOOZE_MINUTES,
  onDismiss,
}: AlarmOverlayProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  // The hook owns the player lifecycle (auto-freed on unmount); it re-creates
  // when the source changes, so keying it off the chosen sound is enough.
  const player = useAudioPlayer(SOUND_MAP[soundKey] || SOUND_MAP['default']);

  // The sound comes from the payload rather than from here, deliberately: the OS
  // needs it at schedule time anyway, and it means the alarm is still audible
  // when nothing about the dose can be resolved.
  const reminder = useResolvedReminder(isVisible, reminderId, ownerUserId, timeStr);

  // 4.2 — under D-1 a caregiver's phone carries alarms for other people, so it
  // has to lead with whose dose this is. An unattributed "take 200mg" on the
  // wrong person's phone is a safety problem, not a UX one. Only shown when the
  // dose is *not* the signed-in user's, so the common case stays uncluttered.
  const isForSomeoneElse =
    ownerUserId != null && user?.id != null && Number(ownerUserId) !== Number(user.id);

  /**
   * When this alarm actually appeared on screen (TELEMETRY.md §2).
   *
   * The third of the three timestamps metric 2 needs, and the only one that
   * exists nowhere else: `scheduled_for` says when the dose was due and
   * `confirmed_at` says when the write landed, but "how long after the alarm
   * rang did they press it" is unanswerable without the device saying when it
   * rang. A patient who left the phone in another room scores badly on
   * dose-due-to-pressed and instantly on this one, and the difference between
   * those two readings is the whole reason to collect it.
   *
   * A ref rather than state: nothing renders from it, and re-rendering a
   * ringing alarm to record a metric would be the wrong trade.
   */
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (isVisible) {
      // **Only on the transition to visible.** This effect also re-runs when
      // the sound changes, and re-stamping there would silently shorten every
      // reaction time that happened to span one — a measurement error that
      // looks exactly like a fast patient.
      if (shownAt.current == null) shownAt.current = Date.now();
      player.loop = true;
      player.seekTo(0);
      player.play();
    } else {
      // Armed for the next showing. Safe against the press path, which reads
      // the ref synchronously before `onDismiss` schedules the state update
      // that brings us back here.
      shownAt.current = null;
      player.pause();
    }
  }, [isVisible, soundKey, player]);

  /**
   * 4.7c + 4.4 — confirming and snoozing are both responses under D-9.
   *
   * **The tray, not the scheduling queue, and that distinction is a bug fix.**
   * This used to call `cancelAlarmBurst`, which clears both. By the time a
   * button is pressed, `_layout.tsx` has already cancelled today's remaining
   * burst and chained the slot forward — and because a burst member's
   * identifier is the same string tomorrow as today (§0.6), the identifiers this
   * would have cancelled now hold **tomorrow's alarm**. Confirming a dose
   * therefore deleted the next occurrence, and nothing but the next launch
   * re-sync put it back. `dismissPresentedAlarms` clears what is genuinely
   * still there — the burst members that fired before the patient reached the
   * phone.
   *
   * Dismissal is not awaited on any of it. The screen must close the instant the
   * button is pressed — an alarm that appears to ignore a press is how a patient
   * ends up pressing everything.
   */
  const respondAndDismiss = useCallback((action: 'confirm' | 'snooze') => {
    if (reminderId != null) {
      const owner = ownerUserId ?? undefined;

      dismissPresentedAlarms(Number(reminderId), owner, timeStr)
        .catch((e) => console.warn('[alarm-overlay] could not clear the tray', e));

      // 4.4 — a snooze has to actually snooze. Re-arm locally first: it is the
      // half that works with no network at all, and it is the half the patient
      // is relying on. The POST below can be queued and replayed; a missed
      // re-arm cannot be recovered from anywhere.
      if (action === 'snooze') {
        scheduleSnoozeAlert({
          reminderId: Number(reminderId),
          ownerUserId: owner,
          timeStr,
          soundKey,
          // From the payload, so a second snooze defers the alarm by the same
          // interval as the first rather than reverting to the default.
          minutes: snoozeMinutes,
        }).then((armed) => {
          if (!armed) console.warn('[alarm-overlay] snooze did not re-arm the alarm');
        });
      }

      // 5.1 — record the dose. Under D-6 a snooze is what defers caregiver
      // escalation, so this is not a client-only concern: a snooze that never
      // reaches the server escalates anyway. `recordDoseAction` queues a
      // failed send for the next sync rather than dropping it (4.4).
      //
      // The immediate POST deliberately sends no timestamp — the server resolves
      // *which* dose from the reminder id and the current time, because
      // computing one here means reproducing the server's timezone resolution on
      // the device and 404ing whenever the two disagree by a second. Only a
      // replay names its dose, and it learns the exact value from the server
      // rather than deriving it.
      //
      // Scoped to the owner so a caregiver acting on a dependent's dose is
      // recorded against the dependent — `confirmed_by` on the row is what
      // captures that it was the caregiver who pressed it (D-1).
      recordDoseAction({
        reminderId: Number(reminderId),
        ownerUserId: owner,
        action,
        timeStr,
        // TELEMETRY.md §2 — the press time and the alarm time, both from this
        // device, both telemetry-only. They land in `confirmed_reported_at` and
        // `alarm_shown_at`; `confirmed_at` stays the server's own clock,
        // because 5.4's escalation and 5.7's missed list read it and a
        // safety-critical column must not come from a phone.
        //
        // Stamped here rather than inside `recordDoseAction` so an offline
        // confirm replayed at the next launch reports when the button was
        // pressed instead of when the replay happened — which is the specific
        // error §2 exists to remove, and it biases exactly the patients whose
        // connectivity is worst.
        occurredAt: Date.now(),
        alarmShownAt: shownAt.current,
        // The value the device actually re-armed on, not the reminder's column:
        // the two are the same in the ordinary case, and when they are not it is
        // this one the patient will experience. `snoozed_until` has to point at
        // the moment the alarm really comes back, or 5.4 escalates against a
        // clock that disagrees with the phone in the patient's hand.
        ...(action === 'snooze' ? { minutes: snoozeMinutes } : {}),
      }).catch((e) => console.warn('[alarm-overlay] could not record the dose', e));
    }
    onDismiss();
  }, [reminderId, ownerUserId, timeStr, soundKey, snoozeMinutes, onDismiss]);

  // 4.5 — `startVibration` lived here, defined and never called. It also leaked
  // its interval: the clearInterval was inside the callback and read `isVisible`
  // from the closure it was created in, so it never saw the value change.
  // Deleted rather than repaired; if haptics are wanted on the overlay, add
  // them in the effect above where the player is already keyed on isVisible.

  return (
    <Modal visible={isVisible} animationType="slide" transparent={false}>
      <View style={styles.container}>
        <Surface style={styles.content} elevation={0}>
          <MaterialCommunityIcons name="bell-ring" size={80} color="#EF4444" />

          {/*
            Degrade, never blank. A fresh install, cleared data, or a reminder
            deleted since the alarm was scheduled all leave nothing to resolve —
            and an alarm rendering an empty name and an empty dosage would be a
            worse outcome than the stale text this item set out to fix.
          */}
          <View style={styles.textGroup}>
            <Text variant="labelLarge" style={styles.alertLabel}>{t('alarmOverlay.reminderTitle')}</Text>
            {isForSomeoneElse ? (
              <Text variant="titleMedium" style={styles.attribution}>
                {reminder.ownerName
                  ? t('alarmOverlay.forPerson', { name: reminder.ownerName })
                  : t('alarmOverlay.forDependent')}
              </Text>
            ) : null}
            {reminder.label ? (
              <Text variant="titleMedium" style={styles.slotLabel}>{reminder.label}</Text>
            ) : null}
            <Text variant="displaySmall" style={styles.medName}>
              {reminder.medName || t('alarmOverlay.unknownMedication')}
            </Text>
            {reminder.resolved ? (
              reminder.dosage ? <Text variant="headlineSmall" style={styles.dosage}>{reminder.dosage}</Text> : null
            ) : (
              <Text variant="titleMedium" style={styles.dosage}>{t('alarmOverlay.unresolvedPrompt')}</Text>
            )}
            {reminder.resolved && reminder.refresh === 'failed' ? (
              <Text variant="bodySmall" style={styles.staleNotice}>{t('alarmOverlay.couldNotRefresh')}</Text>
            ) : null}
          </View>

          <View style={styles.actionGroup}>
            <Button
              mode="contained"
              buttonColor="#22C55E"
              onPress={() => respondAndDismiss('confirm')}
              style={styles.btn}
              labelStyle={styles.btnLabel}
              icon="check-bold"
            >
              {t('alarmOverlay.confirmIngestion')}
            </Button>

            <Button
              mode="outlined"
              textColor="white"
              onPress={() => respondAndDismiss('snooze')}
              style={[styles.btn, { borderColor: 'rgba(255,255,255,0.3)' }]}
            >
              {/* Interpolated rather than written into the string: the label
                  said "5m" while nothing snoozed at all, and the one thing worse
                  than a button that does nothing is one that does something
                  other than what it says. */}
              {t('alarmOverlay.snooze', { minutes: snoozeMinutes })}
            </Button>
          </View>

          <Text style={styles.footerText}>{t('alarmOverlay.footer')}</Text>
        </Surface>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1E293B' },
  content: { flex: 1, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center', padding: 40 },
  textGroup: { alignItems: 'center', marginVertical: 40 },
  alertLabel: { color: '#EF4444', fontWeight: '900', letterSpacing: 2, marginBottom: 10 },
  attribution: { color: '#FBBF24', fontWeight: '800', marginBottom: 8, textAlign: 'center' },
  slotLabel: { color: 'rgba(255,255,255,0.75)', marginBottom: 6, textAlign: 'center' },
  medName: { color: 'white', fontWeight: '900', textAlign: 'center' },
  dosage: { color: 'rgba(255,255,255,0.6)', marginTop: 8, textAlign: 'center' },
  staleNotice: { color: 'rgba(255,255,255,0.45)', marginTop: 14, textAlign: 'center' },
  actionGroup: { width: '100%', gap: 15 },
  btn: { paddingVertical: 10, borderRadius: 20 },
  btnLabel: { fontSize: 18, fontWeight: '800' },
  footerText: { position: 'absolute', bottom: 40, color: 'rgba(255,255,255,0.2)', fontSize: 10, letterSpacing: 2 }
});