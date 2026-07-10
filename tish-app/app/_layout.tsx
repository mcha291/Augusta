import { Amplify } from 'aws-amplify';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter, useSegments } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, LogBox, Platform, View } from 'react-native';
import { MD3LightTheme, Provider as PaperProvider } from 'react-native-paper';

// Correct imports
import AlarmOverlay from '../components/alarm-overlay';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { initI18n } from '../i18n';
import { rescheduleNextOccurrence, setupNotificationChannels } from '../utils/notification-helper';

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
  const [alarmData, setAlarmData] = useState({
    visible: false, med: '', dose: '', soundKey: 'default'
  });
  const [i18nReady, setI18nReady] = useState(false);

  const notificationListener = React.useRef<Notifications.Subscription | undefined>(undefined);
  const responseListener = React.useRef<Notifications.Subscription | undefined>(undefined);

  useEffect(() => { initI18n().then(() => setI18nReady(true)); }, []);

  useEffect(() => {
    async function initNotifications() {
      if (Platform.OS === 'web') return;

      // Defensive Permission Check for Expo 52
      const permission = await Notifications.requestPermissionsAsync() as any;
      const isGranted = permission.status === 'granted' || permission === 'granted';

      if (isGranted) {
        await setupNotificationChannels();
      }
    }
    initNotifications();
    notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
      const data = notification.request.content.data as any;
      if (data?.medName) {
        setAlarmData({
          visible: true,
          med: data.medName,
          dose: data.dosage || '',
          soundKey: data.soundKey || 'default'
        });
        if (Platform.OS !== 'web') rescheduleNextOccurrence(data);
      }
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data as any;
      if (data?.medName) {
        setAlarmData({
          visible: true,
          med: data.medName,
          dose: data.dosage || '',
          soundKey: data.soundKey || 'default'
        });
        if (Platform.OS !== 'web') rescheduleNextOccurrence(data);
      }
    });

    // Web Debug Tool (Chrome Console)
    if (__DEV__ && Platform.OS === 'web') {
      (window as any).triggerAlarm = (med = "Peanut Serum", dose = "100mg", sound = "spy") => {
        setAlarmData({ visible: true, med, dose, soundKey: sound });
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
  const { user, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === 'login' || segments[0] === 'signup';
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
        medName={alarmData.med}
        dosage={alarmData.dose}
        soundKey={alarmData.soundKey}
        onDismiss={() => setAlarmData((prev: any) => ({ ...prev, visible: false }))}
      />
    </>
  );
}