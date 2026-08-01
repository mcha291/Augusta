/**
 * A local copy of the display values an alarm needs (4.3).
 *
 * **Why this has to exist before the payload can be slimmed.** The notification
 * payload used to carry `medName` and `dosage`, baked in at schedule time — so
 * an alarm written a week ago displayed whatever the dose was a week ago. But
 * `medications.tsx` holds reminders in `useState` only, and when an alarm
 * cold-starts the app there is no such state: "resolve from local data" would
 * have had nothing to resolve against, and the overlay would have rendered
 * blank. Blank is worse than stale.
 *
 * So the reconciliation pass (4.1) writes the reminder set here, and the overlay
 * reads it keyed by `reminderId` (+ `ownerUserId`, per 4.2).
 *
 * What this buys, stated precisely, because the obvious version is wrong: it
 * does **not** make an offline device current. It collapses *two* copies of the
 * dosage on the device into *one*. Before, the value lived both in the OS
 * notification queue — written days ago, unreachable, never updated in place —
 * and in the app's own state, and the two could disagree, with the unreachable
 * one being the copy that rang. Now there is a single copy the app controls, so
 * the alarm can no longer contradict the medications screen.
 *
 * Everything here degrades to `null`/`{}` rather than throwing. A storage read
 * that fails must cost a generic alarm, never a missed one.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * One key per owner, holding a `{ [reminderId]: CachedReminder }` map. Per-owner
 * rather than one big blob so a caregiver's device can rewrite one person's set
 * without touching another's — the same reason 4.2 namespaces the notification
 * identifiers.
 */
const KEY_PREFIX = 'reminder-cache.v1.';

function keyFor(ownerUserId: number): string {
  return `${KEY_PREFIX}${ownerUserId}`;
}

export interface CachedReminder {
  id: number;
  ownerUserId: number;
  medName: string | null;
  dosage: string | null;
  soundKey: string | null;
  /** Positionally aligned, straight off the reminder row. */
  alarms: string[];
  alarmLabels: string[];
  /** When this copy was taken, for the overlay's "couldn't refresh" notice. */
  cachedAt: number;
}

type OwnerMap = Record<string, CachedReminder>;

function parseMap(raw: string | null): OwnerMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as OwnerMap) : {};
  } catch {
    return {};
  }
}

async function readMapAt(key: string): Promise<OwnerMap> {
  try {
    return parseMap(await AsyncStorage.getItem(key));
  } catch {
    return {};
  }
}

function toCached(reminder: any, ownerUserId: number, cachedAt: number): CachedReminder {
  return {
    id: Number(reminder.id),
    ownerUserId,
    medName: reminder.med_name ?? null,
    dosage: reminder.selected_dosage ?? null,
    soundKey: reminder.reminder_sound ?? null,
    alarms: Array.isArray(reminder.alarms) ? reminder.alarms.map((a: any) => String(a)) : [],
    alarmLabels: Array.isArray(reminder.alarm_labels)
      ? reminder.alarm_labels.map((l: any) => (l == null ? '' : String(l)))
      : [],
    cachedAt,
  };
}

/**
 * Replaces the cached set for every owner represented in `reminders`.
 *
 * Whole-map replacement rather than a merge, deliberately: it is what evicts
 * reminders that have been deleted server-side. `alsoOwners` lets a caller name
 * an owner whose list came back *empty* — otherwise there'd be no way to tell
 * "this person has no reminders" from "we didn't ask about this person", and a
 * deleted last reminder would linger in the cache forever.
 */
export async function cacheReminders(reminders: any[], alsoOwners: Iterable<number> = []): Promise<void> {
  const cachedAt = Date.now();
  const byOwner = new Map<number, OwnerMap>();

  for (const owner of alsoOwners) {
    if (Number.isFinite(owner)) byOwner.set(Number(owner), {});
  }

  for (const reminder of Array.isArray(reminders) ? reminders : []) {
    const owner = Number(reminder?.user_id);
    const id = Number(reminder?.id);
    if (!Number.isFinite(owner) || !Number.isFinite(id)) continue;
    if (!byOwner.has(owner)) byOwner.set(owner, {});
    byOwner.get(owner)![String(id)] = toCached(reminder, owner, cachedAt);
  }

  await Promise.all(
    Array.from(byOwner, ([owner, map]) =>
      AsyncStorage.setItem(keyFor(owner), JSON.stringify(map)).catch((e) => {
        console.warn('[reminder-store] could not cache reminders for owner', owner, e);
      })
    )
  );
}

/**
 * 3.2 — drop everything cached about an owner this device no longer has access
 * to.
 *
 * **Cancelling the alarms is not enough on its own.** The payload was slimmed by
 * 4.3 to `{reminderId, ownerUserId, timeStr, …}`, so an alarm's medication name
 * and dosage come from *here* — which means a revoked caregiver's device is
 * holding the dependent's prescription in plain storage after it has stopped
 * being allowed to. The alarms are the visible half; this is the half that would
 * still be sitting on disk afterwards.
 *
 * Best-effort per owner, like everything else in this module: a storage failure
 * must not take down the sync pass that called it, and the next launch tries
 * again.
 */
export async function forgetOwners(ownerUserIds: Iterable<number>): Promise<number> {
  const keys: string[] = [];
  for (const owner of ownerUserIds) {
    if (Number.isFinite(Number(owner))) keys.push(keyFor(Number(owner)));
  }
  if (keys.length === 0) return 0;

  try {
    await AsyncStorage.multiRemove(keys);
    // The names go too. `cacheOwnerNames` deliberately *merges* rather than
    // replaces, on the reasoning that a name dropping out of `/my-dependents`
    // is still the right label for alarms already on the device — which is
    // exactly right for every other way an owner can leave that list, and
    // exactly wrong for this one, because there are no alarms left to label.
    await forgetOwnerNames(ownerUserIds);
    return keys.length;
  } catch (e) {
    console.warn('[reminder-store] could not evict cached reminders for', keys.length, 'owner(s)', e);
    return 0;
  }
}

async function forgetOwnerNames(ownerUserIds: Iterable<number>): Promise<void> {
  try {
    const names = (await readMapAt(OWNER_NAMES_KEY)) as unknown as Record<string, string>;
    let changed = false;
    for (const owner of ownerUserIds) {
      const key = String(Number(owner));
      // `delete` returns true for a key that was never there, so it cannot be
      // the test — that would rewrite the whole map on every sync pass.
      if (!(key in names)) continue;
      delete names[key];
      changed = true;
    }
    if (changed) await AsyncStorage.setItem(OWNER_NAMES_KEY, JSON.stringify(names));
  } catch (e) {
    console.warn('[reminder-store] could not evict owner names', e);
  }
}

/**
 * Looks up one reminder. `ownerUserId` comes from the notification payload; when
 * it is absent — a notification scheduled by a build from before it was carried,
 * still sitting in the queue — fall back to scanning the owner maps. Slower, but
 * an alarm firing with a generic prompt when the data is right there on disk
 * would be a self-inflicted degrade.
 */
export async function readCachedReminder(
  reminderId: number,
  ownerUserId?: number | null
): Promise<CachedReminder | null> {
  if (!Number.isFinite(reminderId)) return null;

  if (ownerUserId != null && Number.isFinite(ownerUserId)) {
    const map = await readMapAt(keyFor(Number(ownerUserId)));
    return map[String(reminderId)] ?? null;
  }

  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(KEY_PREFIX));
    for (const key of keys) {
      const hit = (await readMapAt(key))[String(reminderId)];
      if (hit) return hit;
    }
  } catch (e) {
    console.warn('[reminder-store] could not scan cached reminders', e);
  }
  return null;
}

/**
 * Owner display names, so an alarm on a caregiver's device can say *whose* dose
 * it is (4.2). Written by `AuthContext.loadDependents`, which already has the
 * names, rather than fetched on the alarm path — an unattributed "take 200mg" on
 * the wrong person's phone is a safety problem, and it must not depend on a
 * network call that can fail.
 *
 * Separate key prefix from the reminder maps above so the owner-scan in
 * `readCachedReminder` doesn't try to parse this as one.
 */
const OWNER_NAMES_KEY = 'reminder-owners.v1';

export async function cacheOwnerNames(
  users: { id?: number; full_name?: string | null; username?: string | null }[]
): Promise<void> {
  const names: Record<string, string> = {};
  for (const user of Array.isArray(users) ? users : []) {
    const id = Number(user?.id);
    const name = user?.full_name || user?.username;
    if (Number.isFinite(id) && name) names[String(id)] = String(name);
  }
  if (Object.keys(names).length === 0) return;

  try {
    // Merged rather than replaced: `/my-dependents` is the only writer today,
    // but a name that drops out of that list is still the right label for alarms
    // already on the device.
    const existing = parseMap(await AsyncStorage.getItem(OWNER_NAMES_KEY)) as unknown as Record<string, string>;
    await AsyncStorage.setItem(OWNER_NAMES_KEY, JSON.stringify({ ...existing, ...names }));
  } catch (e) {
    console.warn('[reminder-store] could not cache owner names', e);
  }
}

export async function readOwnerName(ownerUserId?: number | null): Promise<string | null> {
  if (ownerUserId == null || !Number.isFinite(ownerUserId)) return null;
  try {
    const raw = await AsyncStorage.getItem(OWNER_NAMES_KEY);
    if (!raw) return null;
    const names = JSON.parse(raw);
    const name = names?.[String(Number(ownerUserId))];
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

/**
 * The label for one alarm slot, matched on time-of-day.
 *
 * `alarms` and `alarm_labels` are positionally aligned (see `utils/meal-alarms`),
 * and labels are stored already-localised, so this is a lookup rather than a
 * translation. Compares on `HH:mm` because a time can arrive as `08:00` or
 * `08:00:00` depending on whether it came from the form or from Postgres.
 */
export function labelForTime(reminder: Pick<CachedReminder, 'alarms' | 'alarmLabels'>, timeStr?: string | null): string | null {
  if (!timeStr) return null;
  const target = String(timeStr).slice(0, 5);
  const index = reminder.alarms.findIndex((a) => a.slice(0, 5) === target);
  if (index < 0) return null;
  return reminder.alarmLabels[index] || null;
}
