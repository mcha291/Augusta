export const SOUND_MAP: Record<string, any> = {
  'default': require('@/assets/sounds/default.mp3'),
  'emergency': require('@/assets/sounds/emergency.mp3'),
  'calm': require('@/assets/sounds/calm.mp3'),
};

export const SOUND_OPTIONS = [
  { labelKey: 'sounds.standard', value: 'default', icon: 'bell-outline' },
  { labelKey: 'sounds.emergency', value: 'emergency', icon: 'alert-decagram' },
  { labelKey: 'sounds.calm', value: 'calm', icon: 'flower' },
] as const;

export const DEFAULT_SOUND_KEY = 'default';

/**
 * Notification sound filenames, bundled natively by the `expo-notifications`
 * config plugin block in app.json.
 *
 * These are deliberately *not* the SOUND_MAP files above. The app has two
 * unrelated sound paths: SOUND_MAP feeds expo-audio inside AlarmOverlay, which
 * only plays while the app is foregrounded, whereas these are played by the OS
 * on delivery with the app closed. That path has constraints the overlay does
 * not:
 *
 *  - **iOS will not play MP3 as a notification sound.** It accepts PCM in
 *    .wav/.aiff/.caf only, and silently substitutes the default chime for
 *    anything else — so the .mp3s cannot simply be registered here. These are
 *    mono 44.1kHz PCM conversions of the same three sounds.
 *  - **Android copies these into res/raw, where filenames become Java
 *    identifiers.** `default.wav` would generate `R.raw.default` and fail the
 *    build on a reserved word, hence the `alarm_` prefix.
 *  - **iOS caps notification sounds at 30 seconds**, falling back to the
 *    default beyond that. All three run 9–12s.
 */
export const NOTIFICATION_SOUND_FILES: Record<string, string> = {
  'default': 'alarm_default.wav',
  'emergency': 'alarm_emergency.wav',
  'calm': 'alarm_calm.wav',
};

export function notificationSoundFile(soundKey?: string | null): string {
  return NOTIFICATION_SOUND_FILES[soundKey || ''] || NOTIFICATION_SOUND_FILES[DEFAULT_SOUND_KEY];
}

/**
 * Android attaches sound to the *channel*, not the notification — the `sound`
 * field on an individual notification is ignored from API 26 up. So a
 * per-reminder sound choice needs one channel per sound, selected at schedule
 * time.
 *
 * Note these are new channel ids rather than the previous single
 * `medication-alarms`. A channel's sound is fixed when the channel is first
 * created and cannot be changed by a later app update, so any device that
 * already created `medication-alarms` would be stuck with the fallback sound
 * forever. New ids sidestep that.
 */
export function channelIdForSound(soundKey?: string | null): string {
  const key = soundKey && NOTIFICATION_SOUND_FILES[soundKey] ? soundKey : DEFAULT_SOUND_KEY;
  return `medication-alarms-${key}`;
}