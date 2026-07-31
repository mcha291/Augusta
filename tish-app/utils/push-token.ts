/**
 * 5.8 — telling the server how to reach this device (D-5).
 *
 * **This is groundwork for two features, not one, and reading it as "caregiver
 * escalation plumbing" will lead the next change astray.** D-5 puts push on the
 * critical path for *every* user: 5.9's silent schedule-change push targets
 * patients, and it is the only server-to-device channel the system has. So the
 * record is simply "a device belonging to whoever is signed in" — no caregiver
 * special-casing anywhere, on either side of the wire.
 *
 * Expo's push service fans out to APNs and FCM, so there is no SNS platform
 * application and no certificate management here. What it costs instead is a
 * `projectId` that must be present at runtime, and a token that changes on
 * reinstall — which is why registration runs on every sign-in rather than once.
 *
 * **Nothing here is allowed to cost the launch or the alarm path.** Every
 * failure is warned and swallowed: a device that cannot register still runs its
 * own local alarms, which are the patient's actual reminder channel (D-5
 * declines push as a patient alarm deliberately). Losing push degrades the
 * caregiver's backstop; throwing here would degrade the primary.
 */

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { apiRequest } from './api';

/** The last token this process successfully registered, to skip redundant POSTs. */
let lastRegistered: string | null = null;

function projectId(): string | undefined {
  // `easConfig` is populated in a built app; `expoConfig.extra` is what a dev
  // client and `expo start` see. Reading both rather than picking one is the
  // difference between push working in TestFlight and only in development.
  const fromEas = (Constants as any)?.easConfig?.projectId;
  const fromExtra = Constants?.expoConfig?.extra?.eas?.projectId;
  return fromEas || fromExtra;
}

function platformTag(): 'ios' | 'android' | 'web' | undefined {
  if (Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web') return Platform.OS;
  return undefined;
}

/**
 * Registers this device against the signed-in user. Safe to call on every
 * sign-in; the server upserts on the token.
 *
 * Returns the token on success and null otherwise, for a caller that wants to
 * log it. No caller is expected to branch on it.
 */
export async function registerPushToken(): Promise<string | null> {
  // Expo push tokens exist on web via VAPID, but nothing in this app is set up
  // to use one and the web build is a development surface rather than a
  // shipping target. Skipping keeps the web console clean for 4.3's overlay
  // debugging, which is what that build is actually for.
  if (Platform.OS === 'web') return null;

  try {
    // **Never requests permission here.** `_layout.tsx` already asks once, at
    // launch, and naming its iOS options carefully (5.3) — asking a second time
    // from a different call site would either be a no-op or, worse, a second
    // prompt the user has already answered.
    // Cast for the same reason `_layout.tsx` does on the request side: this
    // SDK's `NotificationPermissionsStatus` does not surface `PermissionResponse`'s
    // fields through to tsc, and the runtime shape has varied across versions.
    // Both forms are checked rather than picking one.
    const permission = await Notifications.getPermissionsAsync() as any;
    const granted = permission?.granted === true
      || permission?.status === 'granted'
      || permission === 'granted';
    if (!granted) {
      // Not an error. A user who declined notifications has no push channel,
      // and that is their decision; the caregiver escalation falls back to
      // 5.5's SMS rung under D-8's channel-substitution rule.
      return null;
    }

    const id = projectId();
    if (!id) {
      // Loud, because this is a build configuration problem rather than a
      // runtime condition: `getExpoPushTokenAsync` cannot work without it, and
      // the symptom otherwise is push silently never arriving.
      console.warn('[push-token] no EAS projectId in the runtime config — cannot register');
      return null;
    }

    // Throws on a simulator, which is normal and not worth a warning louder
    // than the catch below.
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    if (!token) return null;

    if (token === lastRegistered) return token;

    const res = await apiRequest('/push-tokens', {
      method: 'POST',
      body: { token, platform: platformTag() },
    });

    if (!res.ok) {
      // Deliberately *not* queued for retry the way a dose action is (4.4).
      // A dose action is a one-off event that is lost if it never lands; a
      // token registration runs again on the next sign-in and on every launch
      // after it, so the retry already exists and is free.
      console.warn('[push-token] registration failed:', res.status);
      return null;
    }

    lastRegistered = token;
    return token;
  } catch (e) {
    console.warn('[push-token] could not register this device', e);
    return null;
  }
}

/**
 * Removes this device's token on sign-out.
 *
 * **Not optional, and the reason is a disclosure rather than tidiness.** The
 * token outlives the session: without this, a phone that has been signed out
 * keeps receiving the previous user's escalations — under D-1 that is a
 * dependent's unconfirmed-dose alerts arriving on a device somebody else may now
 * be holding. The server also reassigns a token when it reappears under a new
 * account, so this closes the window between the two rather than being the only
 * defence.
 *
 * Best-effort by design: sign-out must complete whether or not this succeeds.
 * A failure here leaves a stale row that the next registration reassigns.
 */
export async function unregisterPushToken(): Promise<void> {
  if (Platform.OS === 'web') return;

  const token = lastRegistered;
  // Cleared first, so a sign-out that fails to reach the server still forces the
  // next sign-in to re-register rather than skipping on the cached value.
  lastRegistered = null;
  if (!token) return;

  try {
    await apiRequest('/push-tokens', { method: 'DELETE', body: { token } });
  } catch (e) {
    console.warn('[push-token] could not unregister this device', e);
  }
}
