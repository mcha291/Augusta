import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { CRITICAL_ALERTS_ENTITLED } from '../constants/config';
import { SOUND_OPTIONS, channelIdForSound, notificationSoundFile } from '../constants/sounds';
import i18next from '../i18n';
import { computeNextTriggerDate } from './date';
import { confirmedDoseKeys, doseKey } from './doses';
import type { DoseRow } from './doses';
import { belongsToReminder, identifierFor, isSnoozeIdentifier, snoozeIdentifierFor } from './notification-identifiers';

/**
 * 5.3 — how loudly iOS is allowed to interrupt.
 *
 * `timeSensitive` breaks through Focus modes and the scheduled notification
 * summary, and is covered by a **self-service** entitlement
 * (`com.apple.developer.usernotifications.time-sensitive` in app.json). It is
 * what a bedtime dose needs on a phone whose owner uses Sleep Focus, which is
 * most of them.
 *
 * `critical` additionally bypasses the mute switch and Do Not Disturb, and needs
 * Apple's approval (P0.2). Rather than gating 5.3 on that, this reads the
 * permission the OS actually reports: a build that has the entitlement uses
 * `critical`, and every other build quietly uses the strongest level it is
 * allowed. Nothing else in the scheduler changes when the entitlement arrives.
 *
 * Android ignores this field — its equivalent is the alarm-stream channel (4.7e,
 * D-10) — so it is set unconditionally rather than behind a platform check.
 */
let cachedInterruptionLevel: 'timeSensitive' | 'critical' | null = null;

async function resolveInterruptionLevel(): Promise<'timeSensitive' | 'critical'> {
  if (cachedInterruptionLevel) return cachedInterruptionLevel;
  if (Platform.OS !== 'ios' || !CRITICAL_ALERTS_ENTITLED) {
    cachedInterruptionLevel = 'timeSensitive';
    return cachedInterruptionLevel;
  }
  try {
    const permissions = await Notifications.getPermissionsAsync();
    cachedInterruptionLevel = permissions.ios?.allowsCriticalAlerts ? 'critical' : 'timeSensitive';
  } catch {
    // A permission read that fails must not cost the alarm. timeSensitive is
    // the level every build is entitled to, so it is the safe answer.
    cachedInterruptionLevel = 'timeSensitive';
  }
  return cachedInterruptionLevel;
}

/**
 * The authorization options to request. Critical alerts are only ever asked for
 * when the build claims the entitlement: iOS treats a request for an
 * unauthorized option as an error on the whole request, so asking speculatively
 * would risk losing alert, sound and badge along with it.
 */
export function notificationPermissionRequest(): Notifications.NotificationPermissionsRequest {
  return {
    ios: {
      allowAlert: true,
      allowBadge: true,
      allowSound: true,
      ...(CRITICAL_ALERTS_ENTITLED ? { allowCriticalAlerts: true } : {}),
    },
  };
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Android carries the alert sound on the channel rather than the notification,
 * so each selectable sound needs a channel of its own. Creating a channel that
 * already exists is a no-op, so this is safe to call on every launch.
 *
 * **A channel's settings are frozen when it is first created** — sound,
 * importance, vibration and audio attributes cannot be changed by a later app
 * update, only by the user or by using a new channel id. Everything below that
 * matters for audibility therefore has to be right the first time a device sees
 * these ids. Treat any change here as requiring new ids unless you can confirm
 * the current ones have never shipped in a native build.
 */
export async function setupNotificationChannels() {
  if (Platform.OS !== 'android') return;

  for (const option of SOUND_OPTIONS) {
    await Notifications.setNotificationChannelAsync(channelIdForSound(option.value), {
      name: `Medication Alarms (${option.value})`,
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#6366F1',
      // Bundled into res/raw by the expo-notifications plugin block in
      // app.json. Android wants the name without the extension.
      sound: notificationSoundFile(option.value).replace(/\.wav$/, ''),

      // 4.7e — this is Android's answer to the audibility question, and it is
      // what the platform gets instead of the D-9 burst (iOS-only, because the
      // nine-minute Doze rate limit flattens a 30-second burst into one alert)
      // and instead of a full-screen intent (not reachable through
      // expo-notifications — see D-10).
      //
      // `usage: ALARM` is the single highest-value line here: it plays the alert
      // on the **alarm stream** at alarm volume, which the ringer's silent mode
      // does not reach and which is independent of notification volume. A
      // medication reminder on the notification stream is inaudible on a phone
      // that has been silenced for the night — precisely the bedtime dose this
      // is for.
      audioAttributes: {
        usage: Notifications.AndroidAudioUsage.ALARM,
        contentType: Notifications.AndroidAudioContentType.SONIFICATION,
        flags: {
          enforceAudibility: true,
          requestHardwareAudioVideoSynchronization: false,
        },
      },

      // A dependent's medication names are PHI, and on a caregiver's device they
      // would appear on a third party's lock screen (4.2 item 5, 4.3). PRIVATE
      // hides the content behind the lock and shows it once unlocked; the
      // notification body is already non-committal for the same reason.
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,

      // Deliberately *not* set: `bypassDnd`. It is the closest Android has to
      // iOS Critical Alerts, but it needs a user-granted notification-policy
      // exemption and is silently ignored without one — so it needs a UI to ask,
      // and it belongs with P0.2 rather than here.
    });
  }
}

/**
 * How this device should hold a given reminder's alarms.
 *
 * `viewerUserId` is the signed-in user. When it differs from the reminder's
 * owner, this device is a **caregiver's**, holding a copy of someone else's
 * schedule (D-1), and 4.2 item 4 applies: the copy fires at dose time +
 * `escalation_delay_minutes` and only for reminders with escalation switched on.
 *
 * Omitting it keeps the pre-4.2 behaviour — schedule at dose time — which is
 * correct for the patient's own device and is what every call site that has no
 * notion of a viewer wants.
 */
export interface ScheduleOptions {
  viewerUserId?: number;
  /**
   * 4.2 item 4's other half: the owner's materialised doses, so an escalation
   * alarm is not scheduled for a dose that has already been confirmed.
   *
   * Passed in rather than fetched here because the caller — the re-sync — is
   * already making one request per owner and can make this the second. Omitting
   * it schedules every escalation, which is exactly the behaviour that shipped
   * in session 3 and is a strict improvement on the accidental full mirror it
   * replaced; it is not a silent degradation.
   */
  doses?: DoseRow[];
}

/**
 * Schedules the *next* occurrence for every active alarm time on a reminder.
 * Call this whenever a reminder is created/edited/toggled, and also once at
 * app load to keep local notifications in sync with backend state.
 *
 * **4.2 item 4 — the caregiver's copy is an escalation, not a second alarm
 * clock.** Firing it at dose time would ring the caregiver's phone for every
 * dose their dependent takes correctly, which desensitises fast; a desensitised
 * caregiver is worse than no caregiver alarm, and the redundancy D-1 wants is
 * then gone. So the copy is delayed by the reminder's own
 * `escalation_delay_minutes` (D-3, per medication, not a global constant) and is
 * scheduled at all only when `escalation_enabled` is set. That gating is also
 * what keeps a caregiver's device well clear of the iOS 64-notification cap
 * (5.6) — it holds alarms for the escalation-enabled subset, not a full mirror.
 *
 * **And, since 5.1 exists to be read, only for doses that are still
 * unconfirmed.** The remaining third of item 4 was carried as a gap because
 * nothing recorded a confirmation; `options.doses` closes it. Before this, a
 * caregiver was escalated at dose time + delay for *every* occurrence of an
 * escalation-enabled reminder, including the ones their dependent took on time
 * — the desensitisation the item exists to prevent, arriving through the
 * mechanism meant to prevent it.
 */
export async function scheduleMedicationNotifications(reminder: any, options: ScheduleOptions = {}) {
  const ownerUserId = Number.isFinite(Number(reminder.user_id)) ? Number(reminder.user_id) : undefined;
  const viewerUserId = Number.isFinite(Number(options.viewerUserId)) ? Number(options.viewerUserId) : undefined;

  // Both ids have to be known to claim this is someone else's reminder. If the
  // owner is unknown the alarm can't be attributed anyway, and if the viewer is
  // unknown, guessing "caregiver" would delay a patient's own alarm — the one
  // failure direction that must never happen silently.
  const isCaregiverCopy = ownerUserId != null && viewerUserId != null && ownerUserId !== viewerUserId;

  // Preserves 4.4's snooze alarm: this pass rewrites the schedule from the
  // server's reminder row, which says nothing about a snooze, so cancelling one
  // here would delete an alarm the patient just asked for and put nothing back.
  await cancelMedicationNotifications(reminder.id, ownerUserId, true);

  if (reminder.status !== 'active' || !reminder.alarms?.length) return;

  // Escalation off means the caregiver holds nothing for this reminder. The
  // cancel above has already cleared any copy left from when it was on, so
  // switching escalation off actually removes the alarms rather than leaving
  // them scheduled until the reminder is next edited.
  if (isCaregiverCopy && !reminder.escalation_enabled) return;

  const frequencyDays = Math.max(parseInt(reminder.frequency_days) || 1, 1);
  // Mirrors the column default (migration 002) rather than trusting the row to
  // carry one: a reminder object assembled client-side — the form's optimistic
  // schedule, for instance — may not have the field at all, and 0 would collapse
  // the escalation back onto the dose time.
  const escalationOffsetMinutes = isCaregiverCopy
    ? Math.max(parseInt(reminder.escalation_delay_minutes) || 30, 1)
    : 0;

  const burstCount = burstCountFor(reminder, { isCaregiverCopy, ownerUserId });
  const interruptionLevel = await resolveInterruptionLevel();

  // Only a caregiver's copy can point at a dose in the *past*: it fires at dose
  // time + delay, so a device syncing at 08:10 for an 08:00 dose is scheduling
  // an 08:30 escalation for a dose that may already be confirmed. The patient's
  // own alarm is always the next occurrence, which by definition has not
  // happened yet, so there is nothing to check for it.
  const confirmed = isCaregiverCopy ? confirmedDoseKeys(options.doses ?? []) : null;

  for (const timeStr of reminder.alarms) {
    const triggerDate = computeNextTriggerDate(timeStr, frequencyDays, new Date(), true, escalationOffsetMinutes);

    if (confirmed) {
      // Keyed on the *dose* time, not the trigger. The offset was applied above
      // and the dose row knows nothing about the caregiver's delay.
      const doseTime = new Date(triggerDate.getTime() - escalationOffsetMinutes * 60 * 1000);
      if (confirmed.has(doseKey(reminder.id, doseTime))) continue;
    }

    for (let burstIndex = 1; burstIndex <= burstCount; burstIndex++) {
      const identifier = identifierFor(reminder.id, timeStr, ownerUserId, ownerUserId != null ? burstIndex : undefined);
      const burstDate = new Date(triggerDate.getTime() + (burstIndex - 1) * BURST_SPACING_MS);

      await scheduleOneAlert({
        identifier,
        date: burstDate,
        soundKey: reminder.reminder_sound,
        interruptionLevel,
        isCaregiverCopy,
        data: {
          reminderId: reminder.id,
          ownerUserId,
          soundKey: reminder.reminder_sound,
          timeStr,
          frequencyDays,
          escalationOffsetMinutes,
          burstIndex,
          burstCount,
        },
      });
    }
  }
}

/**
 * D-9's burst: how many consecutive alerts one dose schedules.
 *
 * Two platform-shaped exceptions, both settled rather than open:
 *
 * - **Android is always one** (D-10). `setExactAndAllowWhileIdle` — the only API
 *   `expo-notifications` uses — cannot fire more than once per nine minutes per
 *   app while the device is idle, so a 30-second-spaced burst degrades to a
 *   single alert overnight, which is the exact case it was designed for.
 *   Shortening the spacing does not help; the cap is on frequency.
 * - **A caregiver's escalation copy is always one**, and 5.6's notification
 *   budget already assumes this — it multiplies only the owner's own alarms by
 *   `alarm_repeat_count` and counts dependents' escalations singly. Bursting
 *   them too would multiply the pressure on the iOS 64-pending cap by up to six
 *   for every dependent, to make an alert louder for someone who is already the
 *   backstop rather than the person taking the dose.
 */
function burstCountFor(
  reminder: any,
  { isCaregiverCopy, ownerUserId }: { isCaregiverCopy: boolean; ownerUserId?: number }
): number {
  if (Platform.OS !== 'ios' || isCaregiverCopy) return 1;
  if (ownerUserId == null) {
    // Without an owner the identifier cannot carry a burst index unambiguously
    // (see `notification-identifiers`), so this degrades to a single alert.
    // Loudly, because it means a reminder reached the scheduler with no
    // `user_id` and that is a bug in the caller, not a supported shape.
    console.warn('[notifications] no owner on reminder', reminder?.id, '— scheduling a single alert, not a burst');
    return 1;
  }
  return Math.min(Math.max(parseInt(reminder.alarm_repeat_count) || 3, 1), 6);
}

/** 4.7b — spacing between consecutive alerts of one dose's burst. */
const BURST_SPACING_MS = 30 * 1000;

interface AlertSpec {
  identifier: string;
  date: Date;
  soundKey?: string | null;
  interruptionLevel: 'timeSensitive' | 'critical';
  isCaregiverCopy: boolean;
  data: Record<string, any>;
}

/** One scheduled alert. Shared by first-time scheduling and the chain-forward. */
async function scheduleOneAlert({ identifier, date, soundKey, interruptionLevel, isCaregiverCopy, data }: AlertSpec) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: i18next.t(isCaregiverCopy ? 'notifications.doseEscalationTitle' : 'notifications.doseDueTitle'),
      // 4.3 — deliberately non-committal, and it must stay that way. This text
      // is baked into the OS queue at schedule time and cannot be corrected
      // afterwards, so it must not assert a dose: if a caregiver halves the
      // dosage tomorrow, an alarm written today would go on reading out the
      // superseded instruction from a surface nothing can reach. The
      // authoritative numbers live in the overlay, where they are re-resolved
      // on open. This doubles as the lock-screen PHI fix 4.2 asks for — a
      // dependent's medication names should not appear on a caregiver's lock
      // screen.
      //
      // The escalation copy gets its own wording for the same reason it exists:
      // a caregiver whose phone rings thirty minutes after a dose they had no
      // part in needs to know that is what happened, or the alert reads as
      // their own reminder misfiring. It still names nobody — attribution is
      // the overlay's job (item 3), where it is behind the lock screen.
      body: i18next.t(isCaregiverCopy ? 'notifications.doseEscalationBody' : 'notifications.doseDueGenericBody'),
      data,
      priority: Notifications.AndroidNotificationPriority.MAX,
      // 5.3 — iOS only; Android's equivalent is the alarm-stream channel.
      interruptionLevel,
      // iOS plays this bundled file directly. Android ignores the field
      // entirely from API 26 up and takes the sound from the channel, which
      // is what `channelId` on the trigger below selects. Both are needed;
      // setting only one silently loses the user's choice on that platform.
      sound: notificationSoundFile(soundKey),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date,
      channelId: channelIdForSound(soundKey),
    },
    identifier,
  });
}

/**
 * Called when a scheduled notification actually fires. Re-schedules the same
 * alarm slot for `frequencyDays` days later, so the cadence keeps chaining
 * forward instead of repeating daily.
 *
 * **Reschedules the whole burst, not the one alert that fired** (4.7b). The
 * alternative — each member chaining only itself — would quietly shrink the
 * burst to one the first time a response cancelled the remainder, which is every
 * time the patient is awake. So the burst is rebuilt from `burstCount`.
 *
 * **Must run after `cancelAlarmBurst`, never before, and the reason is not
 * obvious.** A burst member's identifier is stable across occurrences — the same
 * reminder, slot and index tomorrow produce the same string — so tomorrow's
 * alert *n* and today's pending alert *n* are the same identifier. Scheduling
 * onto an existing identifier replaces it. Reschedule first and today's
 * un-fired alerts are silently dragged forward to tomorrow, which cancels the
 * burst rather than the burst being cancelled deliberately; cancel first and the
 * queue is empty when the next occurrence is written. `_layout.tsx` sequences
 * the two, and that ordering is load-bearing.
 *
 * Repeated calls are harmless: same identifiers, same computed date.
 */
export async function rescheduleNextOccurrence(data: any) {
  if (!data?.reminderId || !data?.timeStr || !data?.frequencyDays) return;

  const ownerUserId = Number.isFinite(Number(data.ownerUserId)) ? Number(data.ownerUserId) : undefined;
  // A payload carrying an offset is a caregiver's escalation copy (4.2 item 4),
  // and the next occurrence has to keep both the offset and the wording. A
  // notification written by an earlier build has no such field, which reads as
  // zero and reschedules exactly as it always did.
  const escalationOffsetMinutes = Math.max(parseInt(data.escalationOffsetMinutes) || 0, 0);
  const isCaregiverCopy = escalationOffsetMinutes > 0;
  const triggerDate = computeNextTriggerDate(data.timeStr, data.frequencyDays, new Date(), false, escalationOffsetMinutes);
  const interruptionLevel = await resolveInterruptionLevel();

  // Same clamp as the scheduler. A payload from before 4.7b has no `burstCount`
  // and reads as 1, which is exactly the single alert that build scheduled.
  const burstCount = ownerUserId != null
    ? Math.min(Math.max(parseInt(data.burstCount) || 1, 1), 6)
    : 1;

  for (let burstIndex = 1; burstIndex <= burstCount; burstIndex++) {
    await scheduleOneAlert({
      identifier: identifierFor(data.reminderId, data.timeStr, ownerUserId, ownerUserId != null ? burstIndex : undefined),
      date: new Date(triggerDate.getTime() + (burstIndex - 1) * BURST_SPACING_MS),
      soundKey: data.soundKey,
      interruptionLevel,
      isCaregiverCopy,
      data: { ...data, burstIndex, burstCount },
    });
  }
}

/**
 * Cancels a reminder's pending alarms. Pass `ownerUserId` to cancel only that
 * owner's copy; omit it to cancel every copy of the reminder on this device.
 *
 * `preserveSnoozed` keeps 4.4's snooze alarm out of it. The reconcile-then-
 * reschedule pass sets it, because it rewrites the schedule from the server's
 * reminder row and that row knows nothing about a snooze — clearing one would
 * delete an alarm the patient explicitly asked for and put nothing back in its
 * place. Deleting the reminder does *not* set it: the reminder is gone, so every
 * alarm belonging to it should go with it.
 */
export async function cancelMedicationNotifications(
  reminderId: number,
  ownerUserId?: number,
  preserveSnoozed = false
) {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();

  for (const notification of scheduled) {
    if (preserveSnoozed && isSnoozeIdentifier(notification.identifier)) continue;
    if (belongsToReminder(notification.identifier, reminderId, ownerUserId)) {
      await Notifications.cancelScheduledNotificationAsync(notification.identifier);
    }
  }
}

/**
 * 4.7c — the alarm has been answered, so the rest of the burst must stop.
 *
 * **Two distinct halves over two distinct queues, and missing either leaves the
 * patient being chimed at after they have already acted.** Alerts that have not
 * fired are in the scheduling queue and need `cancelScheduledNotificationAsync`;
 * alerts that already fired are sitting in the notification tray and need
 * `dismissNotificationAsync`. Neither call reaches the other queue.
 *
 * **`timeStr` is not optional in practice, and leaving it out was a live bug.**
 * A twice-daily reminder holds a pending alert for each slot. Cancelling
 * reminder-wide when the 08:00 alarm fires cancels the pending 20:00 alert too,
 * and `rescheduleNextOccurrence` afterwards only rewrites the slot that fired —
 * so the evening dose stopped alarming every single morning, and was repaired
 * only by the next launch re-sync (4.1). Nothing in §0.6's ordering finding
 * caught this because the ordering was right; the *scope* was not.
 *
 * Everything here tolerates identifiers that no longer exist, because a chime
 * can fire in the middle of this running. Each removal is caught individually so
 * one failure cannot abandon the rest — a half-cancelled burst is the failure
 * this exists to prevent.
 *
 * Cold start works unchanged: tapping alert 2 of 5 launches the app, the
 * response listener runs, and both queues are read fresh from the OS rather than
 * from any state the app was holding.
 *
 * **Callers that respond to an alarm already on screen want
 * `dismissPresentedAlarms` instead** — see the note there. This one is for the
 * arrival path, which runs before the chain-forward.
 */
export async function cancelAlarmBurst(reminderId: number, ownerUserId?: number, timeStr?: string | null) {
  if (Platform.OS === 'web' || !Number.isFinite(Number(reminderId))) return;

  const id = Number(reminderId);
  const owner = Number.isFinite(Number(ownerUserId)) ? Number(ownerUserId) : undefined;

  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    for (const notification of scheduled) {
      if (!belongsToReminder(notification.identifier, id, owner, timeStr)) continue;
      try {
        await Notifications.cancelScheduledNotificationAsync(notification.identifier);
      } catch (e) {
        console.warn('[notifications] could not cancel', notification.identifier, e);
      }
    }
  } catch (e) {
    console.warn('[notifications] could not read the scheduled queue', e);
  }

  await dismissPresentedAlarms(id, owner, timeStr);
}

/**
 * The tray half of 4.7c on its own: clear alerts that have already fired,
 * without touching anything still scheduled.
 *
 * **This is what a response from the overlay must use, and the reason is a
 * consequence of §0.6's identifier-reuse finding rather than a preference.** By
 * the time the patient presses a button, `_layout.tsx` has already cancelled
 * today's remaining burst and chained the slot forward — so the identifiers that
 * *used* to be the rest of today's burst now hold **tomorrow's** alarm. A
 * scheduled-queue cancel at that point deletes the next occurrence, and only the
 * next launch re-sync puts it back. There is also nothing left for it to find:
 * the alerts it was written to stop were replaced, not left pending.
 *
 * What is genuinely still there is the tray — every burst member that fired
 * before the patient reached the phone — and that is what this clears.
 */
export async function dismissPresentedAlarms(reminderId: number, ownerUserId?: number, timeStr?: string | null) {
  if (Platform.OS === 'web' || !Number.isFinite(Number(reminderId))) return;

  const id = Number(reminderId);
  const owner = Number.isFinite(Number(ownerUserId)) ? Number(ownerUserId) : undefined;

  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const notification of presented) {
      const identifier = notification.request?.identifier;
      if (!identifier || !belongsToReminder(identifier, id, owner, timeStr)) continue;
      try {
        await Notifications.dismissNotificationAsync(identifier);
      } catch (e) {
        console.warn('[notifications] could not dismiss', identifier, e);
      }
    }
  } catch (e) {
    console.warn('[notifications] could not read the presented queue', e);
  }
}

/** 4.4 — how long the snooze button defers the alarm. Mirrors the server's default. */
export const SNOOZE_MINUTES = 10;

export interface SnoozeRequest {
  reminderId: number;
  ownerUserId?: number;
  timeStr?: string | null;
  soundKey?: string | null;
  minutes?: number;
}

/**
 * 4.4 — re-arms the alarm `minutes` from now.
 *
 * **A single alert, not a burst, and that is the item's wording rather than an
 * oversight.** The burst (D-9) exists to wake someone who is asleep; a snooze is
 * pressed by someone demonstrably awake, which is the same premise D-6 rests on.
 * It is also the honest option here: the overlay knows the reminder's id, slot
 * and sound because the payload carries them, and it does *not* know
 * `alarm_repeat_count` — inventing one would put an unbudgeted multiple of
 * alerts into a queue 5.6 is already trying to fit under 64.
 *
 * The identifier is deliberately outside the burst series (`snoozeIdentifierFor`)
 * so this cannot land on top of tomorrow's alarm, and inside the reminder+slot
 * namespace so a reminder edit, a delete, or the next occurrence firing all
 * still clear an unanswered snooze.
 *
 * Falls back to the default sound rather than silence if the payload carried no
 * sound key: a snooze that re-arms inaudibly is worse than one that re-arms with
 * the wrong tone.
 */
export async function scheduleSnoozeAlert({
  reminderId,
  ownerUserId,
  timeStr,
  soundKey,
  minutes = SNOOZE_MINUTES,
}: SnoozeRequest): Promise<boolean> {
  if (Platform.OS === 'web' || !Number.isFinite(Number(reminderId)) || !timeStr) return false;

  const owner = Number.isFinite(Number(ownerUserId)) ? Number(ownerUserId) : undefined;
  const delay = Math.min(Math.max(Math.trunc(Number(minutes)) || SNOOZE_MINUTES, 1), 120);

  try {
    await scheduleOneAlert({
      identifier: snoozeIdentifierFor(reminderId, timeStr, owner),
      date: new Date(Date.now() + delay * 60 * 1000),
      soundKey,
      interruptionLevel: await resolveInterruptionLevel(),
      // Always the patient-facing wording. A caregiver snoozing a dependent's
      // escalation is still being told about that dependent's dose, and the
      // escalation copy's title is what the overlay already attributed.
      isCaregiverCopy: false,
      data: {
        reminderId: Number(reminderId),
        ownerUserId: owner,
        soundKey,
        timeStr,
        // No `frequencyDays`, deliberately: `rescheduleNextOccurrence` bails
        // without one, and it must. This alert is ten minutes from now, not an
        // occurrence of the schedule — chaining off it would move the whole
        // reminder onto snooze time.
        snoozed: true,
      },
    });
    return true;
  } catch (e) {
    console.warn('[notifications] could not schedule the snooze alarm', e);
    return false;
  }
}