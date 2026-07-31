const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Declares Android's exact-alarm permissions (5.2, decided by the P0.3 spike).
 *
 * **Why a plugin rather than `android.permissions` in app.json.** That array is
 * the normal way to add a permission, and it is what `RECORD_AUDIO` uses — but
 * `setAndroidPermissions` in `@expo/config-plugins` writes exactly
 * `{ 'android:name': ... }` and nothing else, so it cannot express
 * `android:maxSdkVersion`. That attribute is the whole point of the pair below.
 *
 * **Why two permissions.**
 *
 * `expo-notifications` already asks for an exact alarm — `ExpoSchedulingDelegate`
 * calls `setExactAndAllowWhileIdle` when `canScheduleExactAlarms()` is true and
 * falls back to the inexact `setAndAllowWhileIdle` when it is not. It just never
 * declares the permission; its CHANGELOG says the app must. So this file is the
 * entire difference between exact and inexact medication alarms on Android 12+.
 *
 * - `USE_EXACT_ALARM` (API 33+) is granted at install and cannot be revoked.
 *   Chosen over `SCHEDULE_EXACT_ALARM` for a specific reason: Android 14 stopped
 *   pre-granting `SCHEDULE_EXACT_ALARM` to apps targeting 33+, and
 *   `expo-notifications` exposes **no** JS API for `canScheduleExactAlarms()` or
 *   for the `ACTION_REQUEST_SCHEDULE_EXACT_ALARM` settings screen. The app
 *   therefore could not detect the denied state, and could not ask the user to
 *   fix it — alarms would silently degrade to inexact with nothing in the UI to
 *   say so. `USE_EXACT_ALARM` has no denied state to detect.
 * - `SCHEDULE_EXACT_ALARM` with `maxSdkVersion="32"` covers Android 12 (API
 *   31–32), which predates `USE_EXACT_ALARM` and where the old permission is
 *   still pre-granted. `minSdkVersion` is 24, so those devices are in range.
 *
 * **Owner action before Android ships:** `USE_EXACT_ALARM` is Play-restricted to
 * apps whose core function is alarms, timers, or calendar event notifications.
 * Declaring it subjects the listing to review. See P0.3 decision 5 in PLAN.md for
 * the fallback if it is refused.
 *
 * Note this does *not* lift the nine-minute Doze rate limit on those two
 * AlarmManager calls, which is a separate restriction and the reason D-9's alarm
 * burst is iOS-only.
 */
const PERMISSIONS = [
  { name: 'android.permission.USE_EXACT_ALARM' },
  { name: 'android.permission.SCHEDULE_EXACT_ALARM', maxSdkVersion: '32' },
];

module.exports = function withExactAlarms(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    if (!Array.isArray(manifest['uses-permission'])) manifest['uses-permission'] = [];

    for (const permission of PERMISSIONS) {
      // Idempotent: prebuild can run repeatedly against an existing manifest, and
      // a duplicated uses-permission is a merge warning at best.
      const existing = manifest['uses-permission'].find(
        (entry) => entry?.$?.['android:name'] === permission.name
      );
      const attributes = { 'android:name': permission.name };
      if (permission.maxSdkVersion) attributes['android:maxSdkVersion'] = permission.maxSdkVersion;

      if (existing) existing.$ = { ...existing.$, ...attributes };
      else manifest['uses-permission'].push({ $: attributes });
    }

    return config;
  });
};
