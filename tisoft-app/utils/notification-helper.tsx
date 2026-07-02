import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * 1. Global Configuration
 * Tells the app how to handle a notification if the app is already open.
 * FIX: Added 'shouldShowBanner' and 'shouldShowList' to satisfy TypeScript.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true, // Required by newer versions
    shouldShowList: true,   // Required by newer versions
  }),
});

/**
 * 2. Setup Notification Channels (Mandatory for Android)
 * This creates the "High Priority" channel that allows the alarm sound to trigger.
 */
export async function setupNotificationChannels() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('medication-alarms', {
      name: 'Medication Alarms',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#6366F1',
      // Ensure this file exists in assets/sounds/alarm.wav
      sound: 'alarm.wav',
    });
  }
}

/**
 * 3. Schedule Notifications for a specific Medication
 */
export async function scheduleMedicationNotifications(reminder: any) {
  // Cancel existing ones first to avoid duplicates
  await cancelMedicationNotifications(reminder.id);

  if (reminder.status !== 'active' || !reminder.alarms) return;

  for (const timeStr of reminder.alarms) {
    const [hour, minute] = timeStr.split(':').map(Number);
    const identifier = `med-${reminder.id}-${timeStr.replace(':', '')}`;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: "🚨 MISSION CRITICAL: DOSE DUE",
        body: `Time to take ${reminder.selected_dosage} of ${reminder.med_name}`,
        data: {
          medName: reminder.med_name,
          dosage: reminder.selected_dosage,
          reminderId: reminder.id,
          soundKey: reminder.reminder_sound // Pass the sound key here!
        },
        priority: Notifications.AndroidNotificationPriority.MAX,
        // On iOS, true uses system default. On Android, it looks in res/raw/
        sound: Platform.OS === 'ios' ? true : 'alarm.wav',
      },
      // --- FIX APPLIED HERE ---
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.CALENDAR, // Add this line
        hour,
        minute,
        repeats: true,
      },
      identifier,
    });
  }
}

/**
 * 4. Cancel Notifications
 */
export async function cancelMedicationNotifications(reminderId: number) {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();

  for (const notification of scheduled) {
    if (notification.identifier.startsWith(`med-${reminderId}-`)) {
      await Notifications.cancelScheduledNotificationAsync(notification.identifier);
    }
  }
}