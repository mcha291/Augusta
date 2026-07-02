import { Amplify } from 'aws-amplify';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter, useSegments } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, LogBox, Platform, View } from 'react-native';
import { MD3LightTheme, Provider as PaperProvider } from 'react-native-paper';

// Correct imports
import AlarmOverlay from '../components/alarm-overlay';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { setupNotificationChannels } from '../utils/notification-helper';

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

  const notificationListener = React.useRef<Notifications.Subscription | undefined>(undefined);
  const responseListener = React.useRef<Notifications.Subscription | undefined>(undefined);

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

    // Foreground Listener (App is open)
    notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
      const data = notification.request.content.data as any;
      if (data?.medName) {
        setAlarmData({
          visible: true,
          med: data.medName,
          dose: data.dosage || '',
          soundKey: data.soundKey || 'default'
        });
      }
    });

    // Background/Tap Listener (User taps notification)
    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data as any;
      if (data?.medName) {
        setAlarmData({
          visible: true,
          med: data.medName,
          dose: data.dosage || '',
          soundKey: data.soundKey || 'default'
        });
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

  return (
    <PaperProvider theme={MD3LightTheme}>
      <AuthProvider>
        {/* Pass the alarm state down to the UI wrapper */}
        <AuthProtection alarmData={alarmData} setAlarmData={setAlarmData} />
      </AuthProvider>
    </PaperProvider>
  );
}

// --- 3. THE LOGIC & NAVIGATION LEVEL ---
function AuthProtection({ alarmData, setAlarmData }: any) {
  const { user, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === 'login' || segments[0] === 'signup';

    if (!user && !inAuthGroup) {
      router.replace('/login');
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

        {/* 
            Conditional Mapping: The (tabs) folder ONLY exists in the 
            navigation tree if a user is logged in. This prevents 
            index.tsx from running its fetch calls prematurely.
        */}
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

      {/* 
          Global Alarm Component: Lives here so it can appear 
          over ANY screen in the app.
      */}
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