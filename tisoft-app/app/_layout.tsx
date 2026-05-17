
import { Stack, useRouter, useSegments } from 'expo-router';
import React, { useEffect } from 'react';
import { ActivityIndicator, LogBox, View } from 'react-native';
import { MD3LightTheme, PaperProvider } from 'react-native-paper';
import { AuthProvider, useAuth } from '../context/AuthContext';

// Silence React 19 warnings
LogBox.ignoreLogs(['Unknown event handler property', 'onResponderTerminate', 'Invalid DOM property']);

export default function RootLayout() {
  return (
    <PaperProvider theme={MD3LightTheme}>
      <AuthProvider>
        <AuthProtection />
      </AuthProvider>
    </PaperProvider>
  );
}

function AuthProtection() {
  const { user, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    // Check if the user is in the (auth) group or (tabs) group
    const inAuthGroup = segments[0] === 'login' || segments[0] === 'signup';

    if (!user && !inAuthGroup) {
      // Redirect to login if not logged in
      router.replace('/login');
    } else if (user && inAuthGroup) {
      // Redirect to home if logged in but on login/signup page
      router.replace('/');
    }
  }, [user, isLoading, segments]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="signup" />
      <Stack.Screen name="(tabs)" /> 
      <Stack.Screen name="profile" options={{ presentation: 'modal' }} /> {/* Add this */}
      <Stack.Screen name="appointment-form" />
      <Stack.Screen name="medication-library" />
      <Stack.Screen name="medication-reminder-form" />
      <Stack.Screen name="results-form" />
    </Stack>
  );
}