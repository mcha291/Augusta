import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function setupNotificationChannels() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('medication-alarms', {
      name: 'Medication Alarms',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#6366F1',
      sound: 'alarm.wav',
    });
  }
}

/**
 * Computes the next Date this alarm should fire, given a time-of-day string
 * ("HH:mm") and how many days should pass between occurrences.
 *
 * - `fromDate` defaults to now, and represents the most recent firing (or "now"
 *   for first-time scheduling).
 * - `isFirstSchedule` controls whether we're allowed to use *today* (if the
 *   time hasn't passed yet) or must always jump forward by frequencyDays.
 */
function computeNextTriggerDate(timeStr: string, frequencyDays: number, fromDate: Date = new Date(), isFirstSchedule = false): Date {
  const [hour, minute] = timeStr.split(':').map(Number);
  const next = new Date(fromDate);
  next.setHours(hour, minute, 0, 0);

  if (isFirstSchedule) {
    // If today's slot hasn't passed yet, use today; otherwise start tomorrow.
    if (next.getTime() <= fromDate.getTime()) {
      next.setDate(next.getDate() + Math.max(frequencyDays, 1));
    }
  } else {
    // Chaining off a firing: always jump forward by the full interval.
    next.setDate(next.getDate() + Math.max(frequencyDays, 1));
  }

  return next;
}

/**
 * Schedules the *next* occurrence for every active alarm time on a reminder.
 * Call this whenever a reminder is created/edited/toggled, and also once at
 * app load to keep local notifications in sync with backend state.
 */
export async function scheduleMedicationNotifications(reminder: any) {
  await cancelMedicationNotifications(reminder.id);

  if (reminder.status !== 'active' || !reminder.alarms?.length) return;

  const frequencyDays = Math.max(parseInt(reminder.frequency_days) || 1, 1);

  for (const timeStr of reminder.alarms) {
    const identifier = `med-${reminder.id}-${timeStr.replace(':', '')}`;
    const triggerDate = computeNextTriggerDate(timeStr, frequencyDays, new Date(), true);

    await Notifications.scheduleNotificationAsync({
      content: {
        title: "🚨 MISSION CRITICAL: DOSE DUE",
        body: `Time to take ${reminder.selected_dosage} of ${reminder.med_name}`,
        data: {
          medName: reminder.med_name,
          dosage: reminder.selected_dosage,
          reminderId: reminder.id,
          soundKey: reminder.reminder_sound,
          timeStr,
          frequencyDays,
        },
        priority: Notifications.AndroidNotificationPriority.MAX,
        sound: Platform.OS === 'ios' ? true : 'alarm.wav',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: triggerDate,
      },
      identifier,
    });
  }
}

/**
 * Called when a scheduled notification actually fires. Re-schedules the same
 * alarm slot for `frequencyDays` days later, so the cadence keeps chaining
 * forward instead of repeating daily.
 */
export async function rescheduleNextOccurrence(data: any) {
  if (!data?.reminderId || !data?.timeStr || !data?.frequencyDays) return;

  const identifier = `med-${data.reminderId}-${String(data.timeStr).replace(':', '')}`;
  const triggerDate = computeNextTriggerDate(data.timeStr, data.frequencyDays, new Date(), false);

  await Notifications.scheduleNotificationAsync({
    content: {
      title: "🚨 MISSION CRITICAL: DOSE DUE",
      body: `Time to take ${data.dosage} of ${data.medName}`,
      data,
      priority: Notifications.AndroidNotificationPriority.MAX,
      sound: Platform.OS === 'ios' ? true : 'alarm.wav',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: triggerDate,
    },
    identifier,
  });
}

export async function cancelMedicationNotifications(reminderId: number) {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();

  for (const notification of scheduled) {
    if (notification.identifier.startsWith(`med-${reminderId}-`)) {
      await Notifications.cancelScheduledNotificationAsync(notification.identifier);
    }
  }
}