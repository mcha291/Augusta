import { MaterialCommunityIcons } from '@expo/vector-icons';
import { CommonActions } from '@react-navigation/native';
import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { BottomNavigation, useTheme } from 'react-native-paper';

export default function TabLayout() {
  const theme = useTheme();
  const { t } = useTranslation();

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
          // E2E selectors. Keyed on `route.name`, not the label, because the
          // labels are translated — a flow matching on "Medications" would
          // pass in English and fail the moment the device locale is zh-Hant.
          // Route names are what the filesystem router already guarantees.
          getTestID={({ route }) => `tab-${route.name}`}
        />
      )}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarLabel: t('tabs.home'),
          tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="home" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="appointments"
        options={{
          tabBarLabel: t('tabs.appointments'),
          tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="calendar-check" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="medications"
        options={{
          tabBarLabel: t('tabs.medications'),
          tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="pill" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="results"
        options={{
          tabBarLabel: t('tabs.results'),
          tabBarIcon: ({ color, size }) => <MaterialCommunityIcons name="flask" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}