/**
 * The decisions the telemetry buffer makes (TELEMETRY.md §3), with none of the
 * I/O.
 *
 * Split out for the reason `dose-queue-policy.ts` was: the module that actually
 * buffers has to import AsyncStorage and the API client, neither of which loads
 * outside a native runtime, and **every rule below is wrong in a way that looks
 * like data rather than like a bug**. A telemetry pipeline does not throw. It
 * quietly reports a number, and a number nobody can distinguish from a real one
 * is worse than no metric at all — the whole reason for measuring "how often a
 * user opens the app" is to act on the answer.
 *
 * Three of these are specifically the traps §3 names:
 *
 * - **iOS does not transition `background → active`.** It goes
 *   `background → inactive → active`, and `active → inactive → active` for a
 *   Control Centre pull that never backgrounded anything. Gating an open on
 *   "the previous state was background" therefore misses every single open.
 * - **Flaps are not opens.** The app switcher and a notification-shade pull
 *   produce a background/active pair seconds apart. Counted, they turn one
 *   morning into a dozen "opens".
 * - **The source has to be recorded or the metric measures the wrong thing.**
 *   This is an alarm-driven app: most opens are the OS launching it from a
 *   reminder tap. Counted together with spontaneous opens, "how often do they
 *   open the app" mostly measures how many medications they are on.
 *
 * And one rule that is deliberately *absent*: there is no session threshold
 * here. Every foreground is recorded with the gap since the last one and what
 * counts as a "session" is decided in Athena, or changing 30 minutes to 15
 * means shipping a build and waiting for people to install it.
 */

/** What `AppState.currentState` can be. Widened, because the OS can add more. */
export type AppStateName = 'active' | 'background' | 'inactive' | (string & {});

/**
 * Why the app came to the foreground. Kept as three separate values rather than
 * a boolean, because they answer different questions: `cold` is a launch from
 * nothing, `foreground` is a return to something already running, and
 * `notification` is the OS acting rather than the user.
 */
export type OpenSource = 'cold' | 'foreground' | 'notification';

export interface TelemetryEvent {
  /** Dot-namespaced, e.g. `app.open`. Becomes the `event` column. */
  name: string;
  /** Device clock at the moment it happened. Clamped at flush, not here. */
  at: number;
  /** Free-form. Lands in the `props` JSON string column, parsed at query time. */
  props: Record<string, unknown>;
}

export const APP_OPEN = 'app.open';

/**
 * How many events to hold when nothing can be sent.
 *
 * Larger than the dose queue's 50 because the failure this survives is
 * different: a dose queue entry is a user action and there are a handful a day,
 * while this fills up on its own. It is still small on purpose — analytics that
 * cost storage or a slow launch have inverted their own value. At roughly 150
 * bytes an event this is well under 100 KB, and the *oldest* go first because a
 * buffer this deep means the device has been offline for weeks and the recent
 * events are the ones still worth having.
 */
export const MAX_BUFFER = 500;

/**
 * An app that was away for less than this did not really leave.
 *
 * §3 asks for flaps under ~60s to be dropped, and **the 60s is how long the app
 * was in the background, not how long since the last open**. The two come apart
 * exactly where it matters: someone reading their medication list for five
 * minutes, glancing at the notification shade, and coming straight back has a
 * five-minute gap since their last open and a two-second absence. Measured on
 * the gap that is a fresh open; measured on the absence it is what it actually
 * was, which is nothing. The app switcher, Control Centre, a share sheet and a
 * permissions dialog are all this shape.
 *
 * The cost of it being slightly too long is undercounting a genuine re-open a
 * minute later — a far better error than a dozen phantom opens for one glance
 * at the shade.
 */
export const FLAP_WINDOW_MS = 60 * 1000;

/**
 * How long after an `app.open` a notification response may claim it.
 *
 * **This exists because the two listeners race.** A reminder tap fires both the
 * notification response listener and an `AppState` transition to `active`, in
 * no guaranteed order. Whichever lands first records the open; the other must
 * not record a second one, and if the notification landed second the already
 * buffered event still has to be corrected — otherwise the single most common
 * open in this app is filed as `foreground` and trap 2 above bites anyway.
 *
 * Short, because it is a race window and not a heuristic: beyond a few seconds
 * a tap and an open are unrelated events that happen to be near each other.
 */
export const NOTIFICATION_RETAG_MS = 5 * 1000;

/** How many events go in one POST. */
export const MAX_BATCH_EVENTS = 100;

/**
 * How large one POST body may get, before the envelope.
 *
 * Well under API Gateway's limit — the constraint being respected here is that
 * a flush runs on the launch path beside the dose queue, and a phone coming
 * back from a fortnight offline should drain over several small requests
 * rather than one that times out and is then retried from the beginning.
 *
 * Note this is *not* Firehose's 5 KB billing unit. Packing events into
 * newline-delimited 5 KB records is the ingest Lambda's job (§3): it has to
 * parse each event anyway to stamp `user_id` from the JWT claims, so packing
 * here would only be unpacked there.
 */
export const MAX_BATCH_BYTES = 64 * 1024;

/**
 * Beyond this an event is a bug at the call site, not data.
 *
 * Dropped rather than sent, and dropped rather than kept: an oversized event
 * that is retryable-failed forever wedges the buffer behind it, which loses
 * every later event to protect one bad one.
 */
export const MAX_EVENT_BYTES = 4 * 1024;

/**
 * How stale an event may be at flush time and still be worth sending.
 *
 * A month covers any realistic offline stretch. Past that the buffer is from a
 * phone that was in a drawer, and an "open" reported six months late is noise
 * in every retention query it lands in.
 */
export const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What has to be remembered between opens, and it is deliberately tiny —
 * everything here is persisted and read on the launch path.
 */
export interface OpenTracker {
  /**
   * When the app was last backgrounded, or null if it has not been since the
   * last `active`.
   *
   * This is the flag §3 asks for — "has it genuinely been backgrounded" is
   * `!== null` — carrying the timestamp the flap rule needs rather than making
   * that a second field that can disagree with it.
   */
  backgroundedAt: number | null;
  /** Device clock at the last *recorded* open. Null before the first ever. */
  lastOpenAt: number | null;
  /** A notification response waiting to claim the next open. */
  pendingSource: OpenSource | null;
  pendingSourceAt: number | null;
}

export const EMPTY_TRACKER: OpenTracker = {
  backgroundedAt: null,
  lastOpenAt: null,
  pendingSource: null,
  pendingSourceAt: null,
};

/** An open that should be recorded, or `null` for a transition that is not one. */
export interface OpenOutcome {
  tracker: OpenTracker;
  event: TelemetryEvent | null;
}

/**
 * Restores a persisted tracker for a fresh process.
 *
 * **`backgroundedAt` is deliberately dropped and `lastOpenAt` deliberately
 * kept.** An app that was backgrounded and then killed by the OS persisted a
 * `backgroundedAt`; carrying it into the next launch makes the first `active`
 * transition look like a return from background, and the cold open is then
 * immediately followed by a phantom foreground open — on every launch of every
 * app the OS reaps, which is most of them. `lastOpenAt` is the opposite case:
 * it is the only thing that makes "gap since the last open" answerable across a
 * process boundary, which is most of the point.
 */
export function restoreTracker(persisted: unknown): OpenTracker {
  const raw = (persisted ?? {}) as Partial<OpenTracker>;
  const lastOpenAt = Number(raw.lastOpenAt);
  return {
    ...EMPTY_TRACKER,
    lastOpenAt: Number.isFinite(lastOpenAt) && lastOpenAt > 0 ? lastOpenAt : null,
  };
}

/**
 * Folds an `AppState` transition into the tracker, emitting an open if that is
 * what it was.
 *
 * `inactive` is ignored outright rather than treated as a background. It is the
 * state iOS passes through in *both* directions — leaving and returning — and
 * it is also what a permissions dialog or an incoming call puts the app in
 * without it ever leaving the screen. Treating it as a background would arm
 * `wasBackgrounded` for a transition that never happened, and the `active` that
 * follows a dismissed dialog would be recorded as an open.
 */
export function observeAppState(
  tracker: OpenTracker,
  next: AppStateName,
  now: number
): OpenOutcome {
  if (next === 'background') {
    // **Not overwritten if one is already set.** Android can deliver
    // `background` more than once without an intervening `active`, and taking
    // the later one would shorten a long absence into a flap.
    if (tracker.backgroundedAt != null) return { tracker, event: null };
    return { tracker: { ...tracker, backgroundedAt: now }, event: null };
  }
  if (next !== 'active') return { tracker, event: null };
  if (tracker.backgroundedAt == null) return { tracker, event: null };

  const away = now - tracker.backgroundedAt;
  const cleared = { ...tracker, backgroundedAt: null };

  // A negative absence is a clock that moved while the app was away, not a
  // flap; `recordOpen` handles what that does to the gap. Anything else shorter
  // than the window never really left the screen.
  if (away >= 0 && away < FLAP_WINDOW_MS) {
    // `lastOpenAt` is deliberately untouched: a flap is not an open, so it must
    // not become the anchor the *next* gap is measured from.
    return { tracker: cleared, event: null };
  }

  return recordOpen(cleared, 'foreground', now, { awayMs: away >= 0 ? away : null });
}

/**
 * Records an open directly — the launch path, which has no transition to
 * observe because the process began in `active`.
 */
export function recordOpen(
  tracker: OpenTracker,
  source: OpenSource,
  now: number,
  extra: Record<string, unknown> = {}
): OpenOutcome {
  const raw = tracker.lastOpenAt == null ? null : now - tracker.lastOpenAt;

  // A clock that has moved backwards — a manual change, a device catching up
  // with NTP after a flat battery — would otherwise report a negative gap, and
  // a negative duration silently poisons any average or percentile computed
  // over it. Null is the honest answer: we do not know how long it had been.
  const gap = raw != null && raw < 0 ? null : raw;

  const claimed = claimPendingSource(tracker, source, now);
  return emit(
    { ...tracker, lastOpenAt: now, pendingSource: null, pendingSourceAt: null },
    claimed,
    now,
    gap,
    extra
  );
}

/**
 * A notification response arrived. Either it claims the open that is about to
 * be recorded, or it retags the one that just was.
 *
 * Returns the buffer unchanged when there is nothing to retag — the caller
 * writes back whichever it gets, so the two orderings need no branch at the
 * call site.
 */
export function noteNotificationOpen(
  tracker: OpenTracker,
  events: TelemetryEvent[],
  now: number
): { tracker: OpenTracker; events: TelemetryEvent[] } {
  const retagged = retagRecentOpen(events, now);
  if (retagged) return { tracker, events: retagged };

  return {
    tracker: { ...tracker, pendingSource: 'notification', pendingSourceAt: now },
    events,
  };
}

/**
 * Rewrites the most recent `app.open` to `notification` if it is recent enough
 * to be the same open. Returns null when there is nothing to claim.
 *
 * Searches from the end and stops at the first `app.open`, rather than
 * rewriting every one inside the window: two opens can legitimately be that
 * close together only when the first was already recorded and the second is
 * this one.
 */
export function retagRecentOpen(
  events: TelemetryEvent[],
  now: number,
  windowMs: number = NOTIFICATION_RETAG_MS
): TelemetryEvent[] | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.name !== APP_OPEN) continue;
    if (now - event.at > windowMs || now < event.at) return null;
    if (event.props?.source === 'notification') return null;

    const next = events.slice();
    next[i] = { ...event, props: { ...event.props, source: 'notification' } };
    return next;
  }
  return null;
}

/**
 * A notification response that arrived just before the open it caused.
 *
 * **A `cold` source is never overwritten**, because the launch path has already
 * asked `getLastNotificationResponseAsync()` whether the OS launched the app
 * from a tap and passed the answer in. A response listener firing a moment
 * later is that same tap arriving twice, not new information, and letting it
 * win would relabel a launch the launch path already classified.
 */
function claimPendingSource(tracker: OpenTracker, source: OpenSource, now: number): OpenSource {
  if (source === 'cold') return source;
  if (tracker.pendingSource == null || tracker.pendingSourceAt == null) return source;
  if (now - tracker.pendingSourceAt > NOTIFICATION_RETAG_MS) return source;
  return tracker.pendingSource;
}

function emit(
  tracker: OpenTracker,
  source: OpenSource,
  now: number,
  sinceLastOpenMs: number | null,
  extra: Record<string, unknown> = {}
): OpenOutcome {
  return {
    tracker,
    event: {
      name: APP_OPEN,
      at: now,
      // `since_last_open_ms` rather than a session id or a boolean: the
      // threshold lives in the query, not here.
      props: { source, since_last_open_ms: sinceLastOpenMs, ...extra },
    },
  };
}

/** Appends, dropping the oldest once the cap is reached. */
export function buffer(events: TelemetryEvent[], event: TelemetryEvent): TelemetryEvent[] {
  return [...events, event].slice(-MAX_BUFFER);
}

/**
 * The next POST's worth, and what is left behind.
 *
 * Oldest first, so a partial drain makes progress in order and a failure
 * re-sends the same batch rather than a different slice of the buffer.
 */
export function takeBatch(
  events: TelemetryEvent[],
  maxEvents: number = MAX_BATCH_EVENTS,
  maxBytes: number = MAX_BATCH_BYTES
): { batch: TelemetryEvent[]; rest: TelemetryEvent[] } {
  const batch: TelemetryEvent[] = [];
  let bytes = 0;

  for (const event of events) {
    if (batch.length >= maxEvents) break;
    const size = sizeOf(event);
    if (bytes + size > maxBytes && batch.length > 0) break;
    batch.push(event);
    bytes += size;
  }

  return { batch, rest: events.slice(batch.length) };
}

/**
 * What actually goes on the wire: stale events dropped, oversized events
 * dropped, and every timestamp clamped into a range the server can believe.
 *
 * **The clamp is the reason a device clock never gets to define a number.** It
 * cannot be authoritative — a phone set a year fast would otherwise put every
 * one of its opens into next year's partitions, where nothing queries them and
 * nothing notices. `sentAt` is the same device's clock at flush, so the ceiling
 * is "no event happened after the moment we sent it", which holds regardless of
 * how wrong the clock is in absolute terms. The batch carries `sentAt` too, so
 * the ingest Lambda can correct the whole batch against its own clock; that
 * correction is a server-side concern and is not attempted here.
 */
export function prepareBatch(
  events: TelemetryEvent[],
  sentAt: number
): TelemetryEvent[] {
  const out: TelemetryEvent[] = [];

  for (const event of events) {
    if (!event || typeof event.name !== 'string' || !Number.isFinite(event.at)) continue;
    if (sizeOf(event) > MAX_EVENT_BYTES) continue;
    if (sentAt - event.at > MAX_EVENT_AGE_MS) continue;
    out.push({ ...event, at: clampOccurredAt(event.at, sentAt) });
  }

  return out;
}

/** No event happened after the flush that carries it. */
export function clampOccurredAt(at: number, sentAt: number): number {
  return at > sentAt ? sentAt : at;
}

function sizeOf(event: TelemetryEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    // A circular or unserialisable `props`. Reported as over the cap so
    // `prepareBatch` drops it rather than letting it throw in the transport.
    return MAX_EVENT_BYTES + 1;
  }
}
