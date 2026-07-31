/**
 * Notification identifier scheme: `med-{ownerUserId}-{reminderId}-{HHmm}` (4.2).
 *
 * Deliberately dependency-free. It lives apart from `notification-helper` — which
 * imports `expo-notifications` and so cannot be loaded outside a native runtime —
 * so this logic can be exercised by a plain Node script. It is worth that
 * separation because getting it wrong is not a cosmetic failure: an identifier
 * that fails to match leaves the old alarm scheduled alongside the new one and
 * the patient is chimed at twice, and one that matches too eagerly cancels
 * alarms belonging to someone else.
 */

/**
 * Reminder ids are globally unique, so the owner segment is not needed to
 * *identify* an alarm — it is there so a device can tell whose alarms it is
 * holding. Under D-1 a caregiver's phone legitimately carries alarms for several
 * people at once, and reconciling one person's set must not disturb another's.
 *
 * Falls back to the un-namespaced form when the owner is unknown, which is also
 * the shape earlier builds wrote.
 */
export function identifierFor(
  reminderId: number | string,
  timeStr: string,
  ownerUserId?: number,
  burstIndex?: number
): string {
  const slot = String(timeStr).replace(':', '');

  if (ownerUserId == null) {
    // No owner means no burst suffix, and that is a correctness constraint
    // rather than a simplification — see `belongsToReminder` for why a
    // four-segment un-namespaced identifier is ambiguous. 4.7b's caller degrades
    // to a single alert (loudly) rather than emitting one.
    return `med-${reminderId}-${slot}`;
  }

  const base = `med-${ownerUserId}-${reminderId}-${slot}`;
  return burstIndex != null ? `${base}-${burstIndex}` : base;
}

/**
 * 4.4 — the alarm a snooze schedules ten minutes out.
 *
 * A distinct final segment rather than a burst index, and that is load-bearing.
 * Burst identifiers repeat across occurrences (§0.6): `med-7-12-0800-1` is
 * *tomorrow's* first alert by the time the patient presses snooze, because
 * `rescheduleNextOccurrence` has already chained forward. Reusing one would
 * schedule the snooze on top of tomorrow's alarm and quietly delete it.
 *
 * `s` is not a number, so it can never collide with a burst index no matter how
 * high `alarm_repeat_count` goes. It still parses as this reminder, this owner
 * and this slot, which is what lets a reminder edit or the next occurrence's
 * cancel clear a snooze that was never answered.
 *
 * Without an owner this returns the un-namespaced form — the same identifier
 * that build's alarm already uses. That is a deliberate collision: a device with
 * no owner on its payloads has no unambiguous four-segment shape available (see
 * below), and overwriting the reminder's own pending alert with a nearer one is
 * a far better outcome than emitting an identifier the parser would read as a
 * different reminder.
 */
export function snoozeIdentifierFor(
  reminderId: number | string,
  timeStr: string,
  ownerUserId?: number
): string {
  const base = identifierFor(reminderId, timeStr, ownerUserId);
  return ownerUserId == null ? base : `${base}-${SNOOZE_MARKER}`;
}

const SNOOZE_MARKER = 's';

/**
 * Whether an identifier is a snooze alarm rather than part of the schedule.
 *
 * The reconciliation pass (4.1) cancels a reminder's alarms and rewrites them
 * from the server's copy, which is right for the schedule and wrong for a
 * snooze: the snooze is a one-shot ten minutes out that the server's reminder
 * row says nothing about, so rewriting from that row deletes it and puts nothing
 * back. A patient who snoozed and then opened the app within ten minutes would
 * silently lose the alarm they had just asked for.
 *
 * Only recognises the namespaced form, because the un-namespaced fallback in
 * `snoozeIdentifierFor` is indistinguishable from the alarm it replaces — by
 * construction, since a four-segment un-namespaced identifier is ambiguous.
 */
export function isSnoozeIdentifier(identifier: string): boolean {
  const parts = String(identifier).split('-');
  return parts[0] === 'med' && parts.length === 5 && parts[4] === SNOOZE_MARKER;
}

/**
 * The four-character slot an identifier's time segment reduces to.
 *
 * Compared with `slice(0, 4)` on both sides rather than by equality, because
 * `identifierFor` strips only the *first* colon: an alarm time that arrived from
 * Postgres as `08:00:00` builds the segment `0800:00` while the same slot from
 * the form builds `0800`. Normalising here rather than in `identifierFor` is
 * deliberate — changing what gets *written* would orphan every identifier
 * already sitting in a device's notification queue.
 */
function slotOf(timeStr: string | null | undefined): string | null {
  if (timeStr == null) return null;
  return String(timeStr).replace(/:/g, '').slice(0, 4);
}

/**
 * Whether a scheduled notification belongs to this reminder — and, when an owner
 * is given, to this owner's copy of it.
 *
 * Parsed by segment rather than matched by prefix, because prefix matching is
 * ambiguous once the owner segment exists: `med-7-` is a prefix of both
 * "reminder 7, un-namespaced" and "every alarm owned by user 7". Cancelling one
 * reminder must not silently clear a whole person's set.
 *
 * Three segments is the un-namespaced form and matches on the reminder alone,
 * which is what clears alarms written before the owner segment existed. Four or
 * more allows for the burst index 4.7b appends and the snooze marker 4.4 does.
 *
 * **`timeStr` narrows the match to one alarm slot, and omitting it where a slot
 * is known is a live bug rather than a loose filter.** A reminder taken at 08:00
 * and 20:00 holds a pending alert for each; cancelling reminder-wide when the
 * morning alarm fires takes the evening one with it, and the chain-forward only
 * rewrites the slot that fired — so the evening dose silently stops alarming
 * until the app is next opened. Every caller that knows which slot it is acting
 * on must say so. Callers that genuinely mean the whole reminder — deleting it,
 * or reconciling it from scratch — omit it and still get the old behaviour.
 *
 * **Why the burst index is only ever appended to a namespaced identifier.**
 * Segment count alone cannot separate `med-{owner}-{reminder}-{slot}` from
 * `med-{reminder}-{slot}-{n}` — both are four — so the four-segment branch below
 * has to commit to reading position 2 as the reminder id. If an un-namespaced
 * burst identifier ever existed, `med-12-0800-1` would be read as reminder
 * `0800`, and `Number('0800')` is 800: a real reminder with id 800 would match
 * and have its alarms cancelled by an unrelated cancel. `identifierFor` makes
 * that shape unconstructible instead of defending against it here, because the
 * defence would have to guess.
 */
export function belongsToReminder(
  identifier: string,
  reminderId: number,
  ownerUserId?: number,
  timeStr?: string | null
): boolean {
  const parts = String(identifier).split('-');
  if (parts[0] !== 'med') return false;

  const slot = slotOf(timeStr);

  if (parts.length >= 4) {
    return Number(parts[2]) === Number(reminderId)
      && (ownerUserId == null || Number(parts[1]) === Number(ownerUserId))
      && (slot == null || slotOf(parts[3]) === slot);
  }
  if (parts.length === 3) {
    return Number(parts[1]) === Number(reminderId)
      && (slot == null || slotOf(parts[2]) === slot);
  }
  return false;
}
