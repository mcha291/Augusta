import { Amplify } from 'aws-amplify';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter, useSegments } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, LogBox, Platform, View } from 'react-native';
import { MD3LightTheme, Provider as PaperProvider } from 'react-native-paper';

// Correct imports
import AlarmOverlay from '../components/alarm-overlay';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { useNotificationSync } from '../hooks/use-notification-sync';
import { initI18n } from '../i18n';
import { cancelAlarmBurst, dismissPresentedAlarms, notificationPermissionRequest, rescheduleNextOccurrence, setupNotificationChannels } from '../utils/notification-helper';
import { registerPushToken } from '../utils/push-token';

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
  const [alarmData, setAlarmData] = useState<{
    visible: boolean;
    reminderId: number | null;
    ownerUserId: number | null;
    timeStr: string | null;
    soundKey: string;
  }>({
    visible: false, reminderId: null, ownerUserId: null, timeStr: null, soundKey: 'default'
  });
  const [i18nReady, setI18nReady] = useState(false);

  const notificationListener = React.useRef<Notifications.Subscription | undefined>(undefined);
  const responseListener = React.useRef<Notifications.Subscription | undefined>(undefined);

  useEffect(() => { initI18n().then(() => setI18nReady(true)); }, []);

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
        soundKey: data.soundKey || 'default'
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
      // The order is load-bearing and the reason is unobvious: a burst member's
      // identifier is the same string tomorrow as it is today, so rescheduling
      // first would overwrite today's un-fired alerts with tomorrow's dates —
      // cancelling the burst by accident instead of on purpose, and leaving
      // nothing for the cancel to find. Cancel, then chain forward.
      //
      // **Scoped to the slot that fired.** Without `timeStr` this cancelled
      // every pending alert on the reminder while the chain-forward rewrote only
      // one of them, so on a twice-daily reminder the morning alarm quietly
      // deleted the evening one, every day, until the next launch re-sync
      // repaired it.
      cancelAlarmBurst(Number(data.reminderId), data.ownerUserId, data.timeStr)
        .catch((e) => console.warn('[alarm] could not clear the burst', e))
        .finally(() => { rescheduleNextOccurrence(data); });
    };

    notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
      showAlarm(notification.request.content.data as any);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      showAlarm(response.notification.request.content.data as any);
    });

    // Web Debug Tool (Chrome Console). Takes a real reminder id now, since the
    // overlay resolves its own content — which makes this the way to exercise
    // 4.3's cache, refresh and degrade paths without a device:
    //   triggerAlarm(12)            → resolves reminder 12
    //   triggerAlarm(999999)        → nothing to resolve, generic prompt
    if (__DEV__ && Platform.OS === 'web') {
      (window as any).triggerAlarm = (reminderId = 1, ownerUserId = null, timeStr = null, sound = 'default') => {
        setAlarmData({ visible: true, reminderId, ownerUserId, timeStr, soundKey: sound });
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
  const { user, isLoading, dependents } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const { syncOwners } = useNotificationSync();
  const hasSyncedFor = React.useRef<number | null>(null);
  const syncedOwners = React.useRef<Set<number>>(new Set());
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
      return;
    }
    if (hasSyncedFor.current !== user.id) {
      hasSyncedFor.current = user.id;
      syncedOwners.current = new Set();
    }

    // `dependents` populates a moment after `user` does — `loadDependents` is
    // fired off inside `checkUser` without being awaited — so this effect runs
    // more than once per sign-in by design. Tracking owners individually rather
    // than a single "have we synced" flag is what lets the second run pick up
    // the dependents without redoing the user's own set.
    const owners = [user.id, ...dependents.map((d) => Number(d.id))]
      .filter((id) => Number.isFinite(id) && !syncedOwners.current.has(id));
    if (owners.length === 0) return;

    owners.forEach((id) => syncedOwners.current.add(id));
    // Own id passed explicitly rather than left undefined: it is what lets the
    // reminder cache evict a set that comes back empty, so deleting a last
    // reminder no longer leaves its details cached indefinitely.
    syncOwners(owners, user.id);
  }, [user, isLoading, dependents, syncOwners]);

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
        <Stack.Screen name="managed-users" />
      </Stack>

      <AlarmOverlay
        isVisible={alarmData.visible}
        reminderId={alarmData.reminderId}
        ownerUserId={alarmData.ownerUserId}
        timeStr={alarmData.timeStr}
        soundKey={alarmData.soundKey}
        onDismiss={() => setAlarmData((prev: any) => ({ ...prev, visible: false }))}
      />
    </>
  );
}