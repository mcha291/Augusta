import { Amplify } from 'aws-amplify';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter, useSegments } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, LogBox, Platform, View } from 'react-native';
import { MD3LightTheme, Provider as PaperProvider } from 'react-native-paper';

// Correct imports
import AlarmOverlay from '../components/alarm-overlay';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { useNotificationSync } from '../hooks/use-notification-sync';
import { initI18n } from '../i18n';
import { DEFAULT_SNOOZE_MINUTES, snoozeMinutesFor } from '../utils/alarm-settings';
import { cancelAlarmBurst, dismissPresentedAlarms, notificationPermissionRequest, rescheduleNextOccurrence, setupNotificationChannels } from '../utils/notification-helper';
import { registerPushToken } from '../utils/push-token';
import { noteNotificationOpen, trackAppState, trackLaunch } from '../utils/telemetry';

// --- 1. CONFIGURATION ---
LogBox.ignoreLogs(['Unknown event handler property', 'onResponderTerminate', 'Invalid DOM property', 'transform-origin']);

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: 'ap-east-2_Z97Td3kcS',
      userPoolClientId: '680mhhi0o2tmvvmcubd7gmb26i',
      loginWith: { email: true, phone: true, username: true }
    }
  }
});

// --- 2. THE PROVIDER LEVEL ---
export default function RootLayout() {
  // 4.3 — this holds the *identity* of the dose, not its details. The overlay
  // resolves the medication name and dosage itself when it opens; carrying them
  // here would just be re-introducing the frozen copy the payload used to hold.
  //
  // `snoozeMinutes` is the exception that proves the rule, and it is here rather
  // than resolved for the same reason `soundKey` is: it governs how the alarm
  // *behaves* rather than what it says, so it has to work on an alarm whose dose
  // cannot be resolved at all. Normalised at schedule time (`alarm-settings`),
  // so an alarm written by a pre-008 build carries none and lands on ten.
  const [alarmData, setAlarmData] = useState<{
    visible: boolean;
    reminderId: number | null;
    ownerUserId: number | null;
    timeStr: string | null;
    soundKey: string;
    snoozeMinutes: number;
  }>({
    visible: false, reminderId: null, ownerUserId: null, timeStr: null, soundKey: 'default',
    snoozeMinutes: DEFAULT_SNOOZE_MINUTES
  });
  const [i18nReady, setI18nReady] = useState(false);

  const notificationListener = React.useRef<Notifications.Subscription | undefined>(undefined);
  const responseListener = React.useRef<Notifications.Subscription | undefined>(undefined);

  useEffect(() => { initI18n().then(() => setI18nReady(true)); }, []);

  // TELEMETRY.md §3 — metric 1, how often a user opens the app.
  //
  // **The first `AppState` usage anywhere in this app**, and it sits in the
  // outer component rather than `AuthProtection` on purpose: an open is an open
  // whether or not anyone is signed in. §3 accepts the consequence explicitly —
  // an open before sign-in has no token, buffers, and is attributed to whoever
  // authenticates first, which is the wrong person on a shared device. The
  // alternative is losing every pre-sign-in open, including the whole of a first
  // launch.
  //
  // Nothing here is awaited and nothing renders from it. `utils/telemetry.ts`
  // swallows its own failures, so a broken buffer cannot cost the alarm path
  // anything — which is the only reason this is allowed to run before i18n has
  // even finished loading.
  useEffect(() => {
    // Whether the OS launched us from a reminder tap, which §3 calls the trap
    // that decides whether this metric measures anything at all: this is an
    // alarm-driven app, so a large share of opens are the OS acting rather than
    // the user. Counted together, "how often do they open the app" mostly
    // measures how many medications someone is on.
    //
    // `getLastNotificationResponseAsync` is the only thing that can answer this
    // for a *cold* start — by the time a response listener is attached, the
    // launching tap has already happened. It is known to return a response from
    // an earlier session on some platforms, so a response carrying a usable
    // date has to be recent to count; one carrying no date is trusted, since
    // the alternative is discarding the signal entirely.
    const launchSource = async () => {
      if (Platform.OS === 'web') return 'cold' as const;
      const response = await Notifications.getLastNotificationResponseAsync();
      if (!response) return 'cold' as const;

      const firedAt = Number(response.notification?.date);
      if (Number.isFinite(firedAt) && Date.now() - firedAt > 60 * 1000) return 'cold' as const;
      return 'notification' as const;
    };

    launchSource()
      .then(trackLaunch)
      .catch(() => trackLaunch('cold'));

    // Every transition, `inactive` included — the policy needs the whole
    // sequence to tell a genuine return from the `active → inactive → active`
    // that a permissions dialog or an incoming call produces without the app
    // ever leaving the screen.
    const subscription = AppState.addEventListener('change', trackAppState);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    async function initNotifications() {
      if (Platform.OS === 'web') return;

      // Defensive Permission Check for Expo 52
      //
      // 5.3 — the request now names its iOS options explicitly. Previously it
      // passed nothing, which asks for alert/badge/sound; critical alerts are
      // added only when the build carries the entitlement, because iOS fails the
      // *whole* authorization request if an unentitled option is requested.
      const permission = await Notifications.requestPermissionsAsync(notificationPermissionRequest()) as any;
      const isGranted = permission.status === 'granted' || permission === 'granted';

      if (isGranted) {
        await setupNotificationChannels();
      }
    }

    initNotifications();
    // Both listeners gate on `reminderId` rather than `medName`, which is what
    // they used to gate on (4.3). The old payload carried `reminderId` too, so an
    // alarm still sitting in the OS queue from an earlier build keeps working and
    // simply gets its details resolved instead of read out of the payload — which
    // is the better outcome, not a fallback.
    const showAlarm = (data: any) => {
      if (!data?.reminderId) return;
      setAlarmData({
        visible: true,
        reminderId: Number(data.reminderId),
        ownerUserId: data.ownerUserId != null ? Number(data.ownerUserId) : null,
        timeStr: data.timeStr ?? null,
        soundKey: data.soundKey || 'default',
        snoozeMinutes: snoozeMinutesFor(data.snoozeMinutes)
      });

      if (Platform.OS === 'web') return;

      // 4.4 — a snooze alarm is a one-shot ten minutes out, not an occurrence of
      // the schedule, and it must not be run through the cancel-and-chain below.
      // Cancelling would take the slot's *next* occurrence with it (the
      // identifiers are already tomorrow's by now), and the chain-forward would
      // have nothing to rebuild it from — the payload deliberately carries no
      // `frequencyDays`. Clearing the tray is the whole of the response here.
      if (data.snoozed) {
        dismissPresentedAlarms(Number(data.reminderId), data.ownerUserId, data.timeStr)
          .catch((e) => console.warn('[alarm] could not clear the tray', e));
        return;
      }

      // 4.7c — reaching here *is* a response: either the patient opened the
      // notification, or the app was foregrounded and the overlay is now on
      // screen playing its own looping audio. Either way the rest of the burst
      // is redundant and must stop, or they are chimed at after acting.
      //
      // The order used to be load-bearing and no longer is, for a 5.6 payload:
      // the cancel is scoped to the day that fired and the rewrite only writes
      // days after it, so they touch disjoint identifiers. Before the occurrence
      // segment existed, a burst member's identifier was the same string
      // tomorrow as today and rescheduling first silently dragged today's
      // un-fired alerts forward (§0.6). It is kept in this order for the one
      // case where it still matters — an alarm scheduled by a build from before
      // 5.6, whose payload has no occurrence key and whose cancel is therefore
      // still reminder-and-slot-wide.
      //
      // **Scoped to the slot that fired, and to the day it fired on.** Without
      // `timeStr` this cancelled every pending alert on the reminder, so on a
      // twice-daily reminder the morning alarm quietly deleted the evening one.
      // Without `occurrenceKey` it would now do the same to the rest of the
      // week: 5.6 leaves a pending burst for each day of the horizon, and all of
      // them share this reminder, owner and slot. A payload from before 5.6
      // carries no key and falls back to the old reminder+slot scope, which is
      // what those alarms always meant.
      cancelAlarmBurst(Number(data.reminderId), data.ownerUserId, data.timeStr, data.occurrenceKey)
        .catch((e) => console.warn('[alarm] could not clear the burst', e))
        .finally(() => { rescheduleNextOccurrence(data); });
    };

    notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
      showAlarm(notification.request.content.data as any);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      // TELEMETRY.md §3 — a tap is the OS opening the app, not the user, and
      // this is the warm-start half of that (the cold-start half is answered by
      // `getLastNotificationResponseAsync` above). It records nothing on its
      // own: it either retags the `app.open` the `AppState` listener has already
      // buffered or leaves a claim for the one about to be, because the two
      // listeners fire in no guaranteed order. Safe on a cold start too, where
      // this fires again for the launching response — a claim is not an open.
      noteNotificationOpen();
      showAlarm(response.notification.request.content.data as any);
    });

    // Web Debug Tool (Chrome Console). Takes a real reminder id now, since the
    // overlay resolves its own content — which makes this the way to exercise
    // 4.3's cache, refresh and degrade paths without a device:
    //   triggerAlarm(12)            → resolves reminder 12
    //   triggerAlarm(999999)        → nothing to resolve, generic prompt
    //   triggerAlarm(12, null, null, 'default', 30)
    //                               → snooze button reads "30m"
    if (__DEV__ && Platform.OS === 'web') {
      (window as any).triggerAlarm = (
        reminderId = 1,
        ownerUserId = null,
        timeStr = null,
        sound = 'default',
        snoozeMinutes = DEFAULT_SNOOZE_MINUTES
      ) => {
        setAlarmData({
          visible: true, reminderId, ownerUserId, timeStr, soundKey: sound,
          snoozeMinutes: snoozeMinutesFor(snoozeMinutes),
        });
      };
    }

    return () => {
      if (notificationListener.current) notificationListener.current.remove();
      if (responseListener.current) responseListener.current.remove();
    };
  }, []);

  if (!i18nReady) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F8FAFC' }}>
        <ActivityIndicator size="large" color="#6366F1" />
      </View>
    );
  }

  return (
    <PaperProvider theme={MD3LightTheme}>
      <AuthProvider>
        {/* Pass the alarm state down to the UI wrapper */}
        <AuthProtection alarmData={alarmData} setAlarmData={setAlarmData} />
      </AuthProvider>
    </PaperProvider>
  );
}
function AuthProtection({ alarmData, setAlarmData }: any) {
  const { user, isLoading, dependents, loadDependents } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const { syncFor, syncOwners } = useNotificationSync();
  const hasSyncedFor = React.useRef<number | null>(null);
  const syncedOwners = React.useRef<Set<number>>(new Set());
  // 3.2 — the last owner set this device swept against, so a *shrinking* set is
  // distinguishable from "nothing new to do".
  const knownOwnersSignature = React.useRef<string | null>(null);
  const registeredFor = React.useRef<number | null>(null);

  // 4.1 — reconcile local notifications against backend state at launch.
  //
  // This was previously only done by the medications screen's loadData, so a
  // user who opened the app to Home never repaired a broken alarm chain —
  // which is exactly the situation the re-sync exists for.
  //
  // 4.2 item 2 — the set reconciled is the signed-in user **plus every active
  // dependent**, not just the currently selected scope. A caregiver's device
  // holds several people's alarms at once (D-1), and identifiers are namespaced
  // by owner (item 1), so one person's set can now be rewritten without touching
  // another's. Before this, a dependent's alarms landed on the device only as a
  // side effect of visiting their medications screen and were then never
  // reconciled again — a deleted or rescheduled dose kept ringing indefinitely.
  //
  // Safe to do now, and not before, because item 4 makes those copies fire at
  // dose time + `escalation_delay_minutes` and only for escalation-enabled
  // reminders. Reconciling dependents without that would have made the caregiver
  // an alarm clock for every dose their dependent takes correctly.
  useEffect(() => {
    if (isLoading) return;
    if (!user || user.id === 0) {
      hasSyncedFor.current = null; // signed out; re-sync on the next sign-in
      syncedOwners.current = new Set();
      knownOwnersSignature.current = null;
      return;
    }
    if (hasSyncedFor.current !== user.id) {
      hasSyncedFor.current = user.id;
      syncedOwners.current = new Set();
      knownOwnersSignature.current = null;
    }

    // `dependents` populates a moment after `user` does — `loadDependents` is
    // fired off inside `checkUser` without being awaited — so this effect runs
    // more than once per sign-in by design. Tracking owners individually rather
    // than a single "have we synced" flag is what lets the second run pick up
    // the dependents without redoing the user's own set.
    //
    // **3.2 — `knownOwnerIds` is everyone; `owners` is everyone not already
    // done, and the difference is load-bearing.** The revocation sweep needs the
    // complete set, because on this effect's *second* run `owners` holds the
    // dependents alone — and a sweep told that list was authoritative would
    // cancel the signed-in user's own alarms.
    const knownOwnerIds = [user.id, ...dependents.map((d) => Number(d.id))].filter((id) => Number.isFinite(id));
    const signature = [...knownOwnerIds].sort((a, b) => a - b).join(',');

    const owners = knownOwnerIds.filter((id) => !syncedOwners.current.has(id));

    // **Runs when the set *shrinks* as well as when it grows, which the old
    // "nothing new to sync" guard could not express.** A caregiver whose last
    // dependent has just been revoked arrives here with nothing new to schedule
    // and a queue full of alarms for someone they no longer have access to —
    // exactly the pass that must not be skipped.
    if (owners.length === 0 && knownOwnersSignature.current === signature) return;
    knownOwnersSignature.current = signature;

    // Pruned to the set that still exists, so a relationship that is revoked and
    // later re-granted syncs again rather than being remembered as already done.
    syncedOwners.current = new Set(knownOwnerIds.filter((id) => syncedOwners.current.has(id)));
    owners.forEach((id) => syncedOwners.current.add(id));

    // Own id passed explicitly rather than left undefined: it is what lets the
    // reminder cache evict a set that comes back empty, so deleting a last
    // reminder no longer leaves its details cached indefinitely.
    syncOwners(owners, user.id, { knownOwnerIds });
  }, [user, isLoading, dependents, syncOwners]);

  // 5.9 — the server has news: re-reconcile the schedule it names.
  //
  // **This is the only server-to-device channel in the system**, and what it
  // buys is that a caregiver's edit reaches the patient's phone without waiting
  // for them to open the app. Before it, a reminder edited on one device stayed
  // wrong on every other device until the next launch — which for a patient who
  // does not open the app daily could be days of alarms the server no longer
  // agrees with.
  //
  // **An optimisation, never a guarantee**, and §8 is explicit about that: iOS
  // rate-limits silent pushes and Android defers them under Doze, so one may
  // simply not arrive. The launch re-sync (4.1) stays the backstop and must not
  // be removed on the assumption that this replaces it.
  //
  // A listener of its own rather than a branch inside `showAlarm`, because that
  // lives in the outer component and this needs `syncFor` and the signed-in
  // user. Several subscribers to the same event are fine.
  //
  // The push carries the *owner* whose schedule changed, which is what makes one
  // handler cover both directions: a patient's own edit from another device, and
  // a caregiver's edit to a dependent's reminder — the latter arriving on both
  // the patient's phone and the caregiver's, each re-syncing that same owner in
  // its own role.
  useEffect(() => {
    if (Platform.OS === 'web') return;

    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data as any;
      const kind = data?.kind;
      if (kind !== 'schedule-changed' && kind !== 'access-revoked') return;

      const ownerUserId = Number(data.ownerUserId);
      if (!Number.isFinite(ownerUserId)) return;
      // No signed-in user means no session to fetch with. Dropping it costs
      // nothing: signing in re-syncs everything anyway.
      if (!user || user.id === 0) return;

      // 3.2 — this device has lost access to somebody, and it does not yet know
      // who. Unlike a schedule change there is no owner to re-read: the answer
      // is "re-read the access list itself", so this reloads `/my-dependents`
      // and lets the effect above run its sweep against the new set.
      //
      // **The push is the prompt half and never the reliable one.** §8 is
      // explicit that this channel is an optimisation — iOS rate-limits silent
      // pushes and Android defers them under Doze — so the launch sweep stays
      // the guarantee and this only shortens the window. Everything it triggers
      // is idempotent, which is what makes a duplicate push free.
      if (kind === 'access-revoked') {
        console.info('[push] access changed for viewer', ownerUserId, '— reloading dependents');
        loadDependents().catch((e) =>
          console.warn('[push] could not reload dependents after a revocation', e)
        );
        return;
      }

      console.info('[push] schedule changed for owner', ownerUserId, '— re-syncing');
      syncFor(ownerUserId, user.id).catch((e) =>
        console.warn('[push] could not re-sync after a schedule change', e)
      );
    });

    return () => subscription.remove();
  }, [user, syncFor, loadDependents]);

  // 5.8 — register this device for push (D-5).
  //
  // A separate effect from the reconciliation above, deliberately. That one
  // runs several times per sign-in by design, because `dependents` arrives
  // after `user` does; this needs to run once, and it depends on the signed-in
  // user alone. Sharing the effect would mean sharing that re-run behaviour for
  // no reason.
  //
  // Not awaited and not blocking anything: a device that cannot register still
  // runs its own local alarms, which under D-5 remain the patient's only alarm
  // channel. Push is the caregiver's backstop and the server's one way to reach
  // a device — losing it degrades those, not the reminder itself.
  useEffect(() => {
    if (isLoading) return;
    if (!user || user.id === 0) {
      // Signed out. Clearing the guard is what makes the *next* sign-in
      // re-register, which matters on a shared device: the token has to move to
      // whoever is now using it.
      registeredFor.current = null;
      return;
    }
    if (registeredFor.current === user.id) return;
    registeredFor.current = user.id;
    registerPushToken();
  }, [user, isLoading]);

  useEffect(() => {
    if (isLoading) return;

    // forgot-password is reachable without a session, so it belongs in the
    // auth group — otherwise a signed-out user opening it is bounced straight
    // back to /login, which is where they just came from.
    const inAuthGroup = segments[0] === 'login'
      || segments[0] === 'signup'
      || segments[0] === 'forgot-password';
    const hasIncompleteProfile = user && user.id === 0;

    if (!user && !inAuthGroup) {
      router.replace('/login');
    }
    else if (hasIncompleteProfile && segments[0] !== 'signup') {
      // Cognito-authenticated but no RDS profile yet — send them to finish signup
      router.replace('/signup');
    }
    else if (user && user.id !== 0 && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [user, isLoading, segments[0]]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F8FAFC' }}>
        <ActivityIndicator size="large" color="#6366F1" />
      </View>
    );
  }

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="signup" />
        <Stack.Screen name="forgot-password" />

        {user && user.id !== 0 ? (
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        ) : null}

        <Stack.Screen name="profile" options={{ presentation: 'modal' }} />
        <Stack.Screen name="appointment-form" />
        <Stack.Screen name="medication-reminder-form" />
        <Stack.Screen name="results-form" />
        <Stack.Screen name="medication-library" />
        <Stack.Screen name="news" />
        <Stack.Screen name="news-detail" />
        <Stack.Screen name="managed-users" />
      </Stack>

      <AlarmOverlay
        isVisible={alarmData.visible}
        reminderId={alarmData.reminderId}
        ownerUserId={alarmData.ownerUserId}
        timeStr={alarmData.timeStr}
        soundKey={alarmData.soundKey}
        snoozeMinutes={alarmData.snoozeMinutes}
        onDismiss={() => setAlarmData((prev: any) => ({ ...prev, visible: false }))}
      />
    </>
  );
}