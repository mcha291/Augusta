import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { CRITICAL_ALERTS_ENTITLED } from '../constants/config';
import { SOUND_OPTIONS, channelIdForSound, notificationSoundFile } from '../constants/sounds';
import i18next from '../i18n';
import { planAlarmsForReminder, planChainForward } from './alarm-schedule';
import type { AlarmPlan } from './alarm-schedule';
import { snoozeMinutesFor } from './alarm-settings';
import { confirmedDoseKeys } from './doses';
import type { DoseRow } from './doses';
import type { BudgetPlan } from './notification-budget';
import { belongsToReminder, isSnoozeIdentifier, ownerOfIdentifier, snoozeIdentifierFor } from './notification-identifiers';

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
  /**
   * 5.6 — how many occurrences of each alarm time to schedule. Comes from the
   * budget; omitting it falls back to the last plan this device computed, and
   * to a single occurrence if there has never been one.
   */
  daysAhead?: number;
  /** 5.6 — upper bound on the burst, from the budget. `null` means no reduction. */
  burstCap?: number | null;
  /**
   * 5.6 — the budget could not fit this reminder at all. Its alarms are still
   * *cancelled*, so a reminder that drops out of the plan does not leave a stale
   * set behind; it simply gets nothing new.
   */
  dropped?: boolean;
}

/**
 * The last budget this device computed (5.6).
 *
 * **The horizon is a device-wide policy, and only one caller can see enough to
 * decide it** — the reconciliation pass, which reconciles the signed-in user
 * plus every active dependent. Three other callers schedule a *single* reminder
 * in response to a user action: saving the form, toggling a reminder's status,
 * and regenerating meal-relative alarms from the profile screen. None of them
 * knows what else is on the device, and if each fell back to one occurrence they
 * would silently collapse that reminder's horizon until the next launch — which
 * is precisely the invisible degradation 5.6 exists to remove, arriving through
 * 5.6's own machinery.
 *
 * So the plan is remembered rather than threaded through every call site. It is
 * mildly stale by construction — a reminder that has just been activated was not
 * in the set the plan was costed against — and that is bounded and self-
 * correcting: the next reconciliation recomputes it. `null` until the first
 * reconciliation, which runs at launch, before any of those three can.
 */
let rememberedPlan: Pick<BudgetPlan, 'daysAhead' | 'burstCap'> | null = null;

/** Called by the reconciliation pass once per run, with the plan it just computed. */
export function rememberBudgetPlan(plan: Pick<BudgetPlan, 'daysAhead' | 'burstCap'> | null) {
  rememberedPlan = plan ? { daysAhead: plan.daysAhead, burstCap: plan.burstCap } : null;
}

/**
 * Schedules the next `daysAhead` occurrences of every active alarm time on a
 * reminder. Call this whenever a reminder is created/edited/toggled, and also
 * once at app load to keep local notifications in sync with backend state.
 *
 * **5.6 — several days at once, not one.** Before this the app scheduled exactly
 * one occurrence per alarm time and re-armed it when it fired, so a broken chain
 * — a device off overnight, a notification that never delivered, an app killed
 * before its listener ran — stopped the alarm until someone opened the app.
 * Writing the whole horizon degrades gracefully instead: the chain can break and
 * the remaining days still ring. How many days is `notification-budget`'s
 * answer, not a constant, because the iOS 64-pending cap is binding rather than
 * theoretical once D-9's burst and D-1's dependents are counted.
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
  // The layout is decided in `alarm-schedule`, which is dependency-free and
  // therefore testable; everything here is the I/O it cannot do. That split is
  // not tidiness — the identifier arithmetic it holds has produced three
  // separate unpredicted bugs in this codebase (§0.6), every one of them silent.
  const plan = planAlarmsForReminder(reminder, {
    viewerUserId: options.viewerUserId,
    platform: Platform.OS,
    daysAhead: options.daysAhead ?? rememberedPlan?.daysAhead,
    burstCap: options.burstCap ?? rememberedPlan?.burstCap,
    // Only a caregiver's copy can point at a dose in the past, so only it needs
    // the confirmed set; `planAlarmsForReminder` ignores it otherwise.
    confirmedDoses: confirmedDoseKeys(options.doses ?? []),
  });

  if (Platform.OS === 'ios' && !plan.isCaregiverCopy && plan.ownerUserId == null) {
    // Without an owner the identifier can carry neither a burst index nor an
    // occurrence (see `notification-identifiers`), so this degrades to a single
    // alert and a single day. Loudly, because it means a reminder reached the
    // scheduler with no `user_id` and that is a bug in the caller, not a
    // supported shape.
    console.warn('[notifications] no owner on reminder', reminder?.id, '— scheduling one alert for one day');
  }

  // Preserves 4.4's snooze alarm: this pass rewrites the schedule from the
  // server's reminder row, which says nothing about a snooze, so cancelling one
  // here would delete an alarm the patient just asked for and put nothing back.
  //
  // Deliberately ahead of every early return below. An inactive reminder, one
  // whose escalation has just been switched off, or one the budget has dropped
  // must actually lose its alarms rather than keep them until it is next edited.
  await cancelMedicationNotifications(reminder.id, plan.ownerUserId, true);

  if (options.dropped) {
    // 5.6 — single alerts over two days still overran the cap, and this reminder
    // is what the budget gave up (dependents' escalation copies first, furthest
    // dose first). Loud, because a caregiver silently losing a dependent's
    // escalation is the failure this phase exists to remove.
    console.warn('[notifications] budget dropped reminder', reminder?.id, '— holding no alarms for it');
    return;
  }

  await writeAlerts(plan, {
    soundKey: reminder.reminder_sound,
    data: {
      reminderId: reminder.id,
      ownerUserId: plan.ownerUserId,
      soundKey: reminder.reminder_sound,
      frequencyDays: plan.frequencyDays,
      escalationOffsetMinutes: plan.escalationOffsetMinutes,
      // Migration 008, carried the same way `soundKey` is and for the same
      // reason: the overlay reads it when the alarm fires, and that can be days
      // after this ran and with no network. Resolving it from the cached
      // reminder instead would make an alarm that cannot be resolved — a fresh
      // install, cleared data — silently snooze for ten minutes rather than for
      // what this reminder is configured for.
      //
      // Normalised here rather than at the far end so the value written into
      // the OS queue is already the value that will be honoured; a row from a
      // pre-008 server has no such field and lands on the documented default.
      snoozeMinutes: snoozeMinutesFor(reminder.snooze_minutes),
    },
  });
}

/**
 * Writes a planned set of alerts to the OS queue.
 *
 * Shared by first-time scheduling and the chain-forward so that both go through
 * one construction: two copies drifting apart would leave alarms one cannot
 * cancel and cancels that hit the wrong day, which is the exact failure §0.6
 * records against identifier reuse.
 */
async function writeAlerts(
  plan: AlarmPlan,
  { soundKey, data }: { soundKey?: string | null; data: Record<string, any> }
) {
  if (plan.alerts.length === 0) return;

  const interruptionLevel = await resolveInterruptionLevel();

  for (const alert of plan.alerts) {
    await scheduleOneAlert({
      identifier: alert.identifier,
      date: alert.date,
      soundKey,
      interruptionLevel,
      isCaregiverCopy: plan.isCaregiverCopy,
      data: {
        ...data,
        timeStr: alert.timeStr,
        burstIndex: alert.burstIndex,
        burstCount: alert.burstCount,
        occurrenceKey: alert.occurrenceKey,
        horizonDays: plan.horizonDays,
      },
    });
  }
}

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
 * Called when a scheduled notification actually fires. Rewrites this slot's
 * forward horizon, so the look-ahead stays as deep as the budget asked for
 * instead of eroding by a day every time an alarm goes off.
 *
 * **5.6 changed what this is for, and it is worth being precise about.** Before
 * the horizon existed, exactly one occurrence was ever scheduled, so this was
 * the *only* thing keeping a reminder alive — the chain-forward. Now the sync
 * writes `horizonDays` occurrences at once and this becomes a top-up: it
 * re-establishes the same depth measured from the next occurrence, which is the
 * same convention the sync uses. §0.3 asked for a decision between "no-op" and
 * "top-up"; a no-op would let the horizon shrink by a day per dose until the app
 * was next opened, which is the failure 5.6 exists to remove.
 *
 * **Rewriting the whole horizon rather than appending one day is deliberate.**
 * Appending is cheaper and wrong in the case that matters: if the app has not
 * run for several days, the occurrences that fired in the meantime are gone and
 * appending a single far-end day leaves the gap in the middle. Rewriting is
 * idempotent — the identifiers are date-keyed, so an occurrence that is already
 * scheduled is replaced by an identical alert — so it repairs the gap instead.
 *
 * **Reschedules the whole burst, not the one alert that fired** (4.7b). The
 * alternative — each member chaining only itself — would quietly shrink the
 * burst to one the first time a response cancelled the remainder, which is every
 * time the patient is awake. So the burst is rebuilt from `burstCount`.
 *
 * **The cancel-then-reschedule ordering has stopped being load-bearing, and it
 * is worth saying so rather than leaving a stale invariant in place.** §0.6
 * records that rescheduling first used to drag today's un-fired alerts into
 * tomorrow, because a burst member's identifier was the same string on both
 * days. It cannot now: this rewrite only ever writes occurrences from tomorrow
 * on, and the cancel is scoped to the day that fired, so the two touch disjoint
 * identifiers. `_layout.tsx` still sequences them, for one narrow reason — a
 * payload from **before** 5.6 carries no occurrence key, so its cancel is still
 * reminder-and-slot-wide and would eat a horizon written first. Reversing the
 * order gains nothing, so the sequencing stays.
 *
 * A payload from before 5.6 also carries no `horizonDays` and reads as 1 —
 * exactly the single next occurrence that build chained forward. Such an alarm
 * therefore collapses its slot's horizon to one day until the next
 * reconciliation, which is imminent by construction: the app is running, because
 * the listener that called this only fires when it is.
 */
export async function rescheduleNextOccurrence(data: any) {
  const plan = planChainForward(data);
  await writeAlerts(plan, { soundKey: data?.soundKey, data });
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
 * **`occurrenceKey` is the 5.6 counterpart of `timeStr`, and leaving it out
 * would be the same bug one dimension over.** Once the horizon is several days
 * deep, this slot holds a pending burst for each of the next `daysAhead` days. A
 * cancel scoped only to the reminder and slot would take all of them, and the
 * top-up afterwards rewrites the horizon from the *next* occurrence — so the
 * alarm the patient just answered would silently cost them nothing today and
 * everything for the rest of the week is rebuilt anyway. Passing the key from
 * the firing alert's own payload keeps the cancel inside the day that fired.
 * Callers with no key (a payload from before 5.6) get the old reminder+slot
 * behaviour, which is what those alarms always meant.
 *
 * **Callers that respond to an alarm already on screen want
 * `dismissPresentedAlarms` instead** — see the note there. This one is for the
 * arrival path, which runs before the chain-forward.
 */
export async function cancelAlarmBurst(
  reminderId: number,
  ownerUserId?: number,
  timeStr?: string | null,
  occurrenceKey?: string | null
) {
  if (Platform.OS === 'web' || !Number.isFinite(Number(reminderId))) return;

  const id = Number(reminderId);
  const owner = Number.isFinite(Number(ownerUserId)) ? Number(ownerUserId) : undefined;

  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    for (const notification of scheduled) {
      if (!belongsToReminder(notification.identifier, id, owner, timeStr, occurrenceKey)) continue;
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
 * 3.2 — drop every alarm belonging to an owner this device no longer holds a
 * relationship with.
 *
 * **The durable half of revocation on the device side, and the one that does not
 * depend on a push arriving.** Under 4.2 item 2 a caregiver's phone carries an
 * escalation copy of every escalation-enabled reminder their dependent has, and
 * since 5.6 it carries up to a week of them. When the relationship ends, the
 * dependent simply disappears from `/my-dependents` — so the reconciliation pass
 * stops *writing* their alarms and, before this, had no mechanism at all to
 * remove the ones already written. They would go on firing for the length of the
 * horizon, resolving the patient's medication name out of the local cache, on a
 * device that has just been told it may not have it.
 *
 * **Framed as "everyone except these" rather than "this owner", deliberately.**
 * The caller knows who it still has access to; it does not, and cannot, know who
 * it used to. A revocation that happened while the app was closed leaves no
 * client-side record of the person it removed — the only surviving evidence is
 * the identifiers in the OS queue.
 *
 * Alarms with no owner segment are left alone. See `ownerOfIdentifier`: those
 * predate 4.2, cancelling them would take the device's own alarms with them, and
 * the ordinary per-reminder reconcile clears them anyway.
 *
 * Returns the owners it actually found and cancelled, so the caller can evict
 * their cached reminders too — the alarms are the visible half of what a revoked
 * caregiver's phone is holding, and 4.3's cache is the other.
 */
export async function cancelAlarmsForOtherOwners(allowedOwnerIds: Iterable<number>): Promise<number[]> {
  if (Platform.OS === 'web') return [];

  const allowed = new Set<number>();
  for (const id of allowedOwnerIds) {
    if (Number.isInteger(Number(id))) allowed.add(Number(id));
  }
  // An empty allow-list means the caller could not establish who it has access
  // to — a failed `/my-dependents`, or a signed-out state. Sweeping on that
  // would cancel *every* alarm on the device, so it is refused. The revocation
  // is repaired on the next pass that has a real answer.
  if (allowed.size === 0) return [];

  const removed = new Set<number>();
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    for (const notification of scheduled) {
      const owner = ownerOfIdentifier(notification.identifier);
      if (owner == null || allowed.has(owner)) continue;
      try {
        await Notifications.cancelScheduledNotificationAsync(notification.identifier);
        removed.add(owner);
      } catch (e) {
        console.warn('[notifications] could not cancel a revoked owner alarm', notification.identifier, e);
      }
    }
  } catch (e) {
    console.warn('[notifications] could not read the scheduled queue', e);
    return [];
  }

  // The tray as well, for the same reason 4.7c has two halves: an escalation
  // that fired an hour ago is still sitting there naming the patient's
  // medication, and no scheduled-queue cancel reaches it.
  if (removed.size > 0) {
    try {
      const presented = await Notifications.getPresentedNotificationsAsync();
      for (const notification of presented) {
        const owner = ownerOfIdentifier(notification.request.identifier);
        if (owner == null || allowed.has(owner)) continue;
        await Notifications.dismissNotificationAsync(notification.request.identifier).catch(() => {});
      }
    } catch (e) {
      console.warn('[notifications] could not clear the tray for a revoked owner', e);
    }
    console.info('[notifications] dropped alarms for', removed.size, 'owner(s) no longer accessible');
  }

  return [...removed];
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
 *
 * **Deliberately not occurrence-scoped, unlike the scheduled-queue cancel.** The
 * tray only ever holds alerts that have already fired, so there is no future to
 * protect; and a slot whose alarm is being answered may well have yesterday's
 * unanswered copy sitting there too, which should go with it.
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

export interface SnoozeRequest {
  reminderId: number;
  ownerUserId?: number;
  timeStr?: string | null;
  soundKey?: string | null;
  /** The reminder's `snooze_minutes`. Falls back to 10 when absent. */
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
  minutes,
}: SnoozeRequest): Promise<boolean> {
  if (Platform.OS === 'web' || !Number.isFinite(Number(reminderId)) || !timeStr) return false;

  const owner = Number.isFinite(Number(ownerUserId)) ? Number(ownerUserId) : undefined;
  const delay = snoozeMinutesFor(minutes);

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
        // Carried so a second press of snooze defers the alarm by the same
        // interval as the first. Without it the re-armed alert would silently
        // revert to the default, which is the more confusing failure precisely
        // because the patient chose to be reminded again.
        snoozeMinutes: delay,
        // No `frequencyDays`, deliberately: `rescheduleNextOccurrence` bails
        // without one, and it must. This alert is `delay` minutes from now, not
        // an occurrence of the schedule — chaining off it would move the whole
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