import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CommonActions } from '@react-navigation/native';
import { Stack, Tabs, useRouter } from 'expo-router';
import React from 'react';
import { ActivityIndicator, LogBox, Platform, View } from 'react-native';
import { BottomNavigation, useTheme } from 'react-native-paper';
import { AuthProvider, useAuth } from '../../context/AuthContext'; // Ensure this path is correct

// --- 1. Silence React 19 / Native Gesture Warnings ---
LogBox.ignoreLogs([
  'Unknown event handler property', 
  'onResponderTerminate', 
  'Invalid DOM property',
  'transform-origin'
]);

if (Platform.OS === 'web') {
  const silentWarnings = ['Unknown event handler property', 'onResponderTerminate', 'Invalid DOM property', 'transform-origin', 'transformOrigin'];
  const filterConsole = (originalFn: any) => (...args: any[]) => {
    const message = args[0]?.toString() || '';
    if (silentWarnings.some(warning => message.includes(warning))) return;
    originalFn(...args);
  };
  console.error = filterConsole(console.error);
  console.warn = filterConsole(console.warn);
}

// --- 2. The Main Root Layout ---
export default function RootLayout() {
  return (
    <AuthProvider>
      <MainContent />
    </AuthProvider>
  );
}

// --- 3. The Logic Switcher ---
function MainContent() {
  const router = useRouter(); // <--- ADD THIS LINE inside the component
  const { user, isLoading } = useAuth();
  const theme = useTheme();

  // Show a loading spinner while checking the session
  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#6200ee" />
      </View>
    );
  }

  // If NOT logged in, show the Auth Stack
  if (!user) {
    return (
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="signup" />
      </Stack>
    );
  }

  // If logged in, show the Tab System
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={({ navigation, state, descriptors, insets }) => (
        <BottomNavigation.Bar
          navigationState={state}
          safeAreaInsets={insets}
          activeColor={theme.colors.primary}
          style={{ backgroundColor: theme.colors.elevation.level2 }}
          onTabPress={({ route, preventDefault }) => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (state.index !== state.routes.indexOf(route) && !event.defaultPrevented) {
              navigation.dispatch({ ...CommonActions.navigate(route.name, route.params), target: state.key });
            }
          }}
          renderIcon={({ route, focused, color }) => {
            const { options } = descriptors[route.key];
            if (options.tabBarIcon) return options.tabBarIcon({ focused, color, size: 24 });
            return null;
          }}
          getLabelText={({ route }) => {
            const { options } = descriptors[route.key];
            const label = options.tabBarLabel ?? options.title ?? route.name;
            return typeof label === 'string' ? label : route.name;
          }}
        />
      )}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarLabel: 'Home',
          tabBarIcon: ({ focused, color, size }) => (
            <MaterialCommunityIcons name={focused ? 'home' : 'home-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="appointments"
        options={{
          tabBarLabel: 'Appointments',
          tabBarIcon: ({ focused, color, size }) => (
            <MaterialCommunityIcons name={focused ? 'calendar-check' : 'calendar-check-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="medications"
        options={{
          tabBarLabel: 'Medications',
          tabBarIcon: ({ focused, color, size }) => (
            <MaterialCommunityIcons name={focused ? 'pill' : 'pill'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="results"
        options={{
          tabBarLabel: 'Results',
          tabBarIcon: ({ focused, color, size }) => (
            <MaterialCommunityIcons name={focused ? 'flask' : 'flask-outline'} size={size} color={color} />
          ),
        }}
      />
      {/* Hide auth screens from the Tab Bar if they are still in the file list */}
      <Tabs.Screen name="login" options={{ href: null }} />
      <Tabs.Screen name="signup" options={{ href: null }} />
      <Tabs.Screen name="appointment-form" options={{ href: null }} />
      <Tabs.Screen name="results-add" options={{ href: null }} />
      <Tabs.Screen name="medication-library" options={{ href: null }} />
      <Tabs.Screen name="medication-reminder-form" options={{ href: null }} />
    </Tabs>
  );
}