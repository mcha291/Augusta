import { Platform, StyleSheet } from 'react-native';
import { COLORS, RADIUS, SHADOWS, SPACING } from '../constants/theme';

export const GlobalStyles = StyleSheet.create({
  // Root Screen Container
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  
  // Standard Header (Greeting area)
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 60 : 40,
    paddingHorizontal: SPACING.xl,
    paddingBottom: SPACING.lg,
  },

  // Scroll Content Wrapper
  scrollContent: {
    paddingHorizontal: SPACING.xl,
    paddingBottom: 40,
  },

  // The "Pro" Card
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.xl,
    marginBottom: SPACING.lg,
    ...SHADOWS.soft,
  },

  // Section Headers (e.g., "Upcoming Schedule")
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: SPACING.xxl,
    marginBottom: SPACING.md,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.ink,
  },

  // List Items (For Appointments, Meds, Results)
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    padding: SPACING.md,
    borderRadius: RADIUS.lg,
    marginBottom: SPACING.sm,
    ...SHADOWS.soft,
  },

  // Small Data Labels (The "OBJECTIVE", "STATUS" mini-headers)
  labelMini: {
    fontSize: 10,
    fontWeight: '700',
    color: COLORS.slate,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 4,
  },

  // Centered Loading / Empty States
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  }
});