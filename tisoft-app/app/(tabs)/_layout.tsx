import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CommonActions } from '@react-navigation/native';
import { Tabs } from 'expo-router';
import { BottomNavigation, useTheme } from 'react-native-paper';

export default function TabLayout() {
  const theme = useTheme();

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
            // Force return as string to prevent Symbol errors
            return typeof label === 'string' ? label : route.name;
          }}
        />
      )}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarLabel: 'Home',
          tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="home" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="appointments"
        options={{
          tabBarLabel: 'Appointments',
          tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="calendar-check" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="medications"
        options={{
          tabBarLabel: 'Medications',
          tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="pill" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="results"
        options={{
          tabBarLabel: 'Results',
          tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="flask" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}