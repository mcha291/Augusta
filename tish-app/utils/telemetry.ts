/**
 * TELEMETRY.md §3 — the product-analytics half, and the part that touches
 * storage and the network.
 *
 * The rules live in `telemetry-policy.ts`, which has no imports and is unit
 * tested. This file is deliberately thin: a buffer, a batched POST, and the
 * serialisation that keeps the two from racing.
 *
 * **Two contracts hold everywhere below, and nothing here is worth breaking
 * either for.** Product analytics is the least important thing this app does —
 * it sits in the same process as an alarm that tells someone to take their
 * medication.
 *
 * 1. **Never throws.** Every entry point swallows its own failures. A telemetry
 *    write that rejects would surface as an unhandled rejection on the launch
 *    path, and callers are not written to catch one.
 * 2. **Never awaited by the UI.** Callers fire and forget. Nothing on screen
 *    waits for a buffer write or a POST.
 *
 * There is no SDK and there will not be one: §3 rejects device→Firehose
 * directly (it needs a Cognito *Identity* Pool this project does not have, and
 * it would let any device write arbitrary records to the stream), so the
 * transport is ours and it is this.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { apiRequest } from './api';
import { TELEMETRY_ENDPOINT } from '../constants/config';
import { isRetryableStatus } from './dose-queue-policy';
import {
  EMPTY_TRACKER,
  buffer as bufferInto,
  noteNotificationOpen as noteNotification,
  observeAppState,
  prepareBatch,
  recordOpen,
  restoreTracker,
  takeBatch,
} from './telemetry-policy';
import type { AppStateName, OpenSource, OpenTracker, TelemetryEvent } from './telemetry-policy';

const BUFFER_KEY = 'telemetry.v1';
const TRACKER_KEY = 'telemetry-tracker.v1';

/**
 * Everything that reads-modifies-writes storage runs through here, in order.
 *
 * **Not defensive — the race is the normal case.** The launch flush and the
 * `AppState` listener overlap routinely: a notification tap foregrounds the app
 * and re-syncs it at the same moment. Two interleaved read/write pairs on the
 * buffer lose whichever event was appended first, and on the tracker they lose
 * the `backgroundedAt` that decides whether the *next* return is an open at all.
 *
 * Chained on both settlements so one failure cannot wedge the queue.
 */
let chain: Promise<unknown> = Promise.resolve();

function serialise<T>(work: () => Promise<T>): Promise<T | undefined> {
  const next = chain.then(work, work).catch((e) => {
    console.warn('[telemetry] dropped a step', e);
    return undefined;
  });
  chain = next;
  return next;
}

async function readBuffer(): Promise<TelemetryEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(BUFFER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TelemetryEvent[]) : [];
  } catch {
    // A corrupt buffer costs analytics and nothing else. Starting over is the
    // right answer; there is no version of this worth an error path.
    return [];
  }
}

async function writeBuffer(events: TelemetryEvent[]): Promise<void> {
  try {
    await AsyncStorage.setItem(BUFFER_KEY, JSON.stringify(events));
  } catch (e) {
    console.warn('[telemetry] could not persist the buffer', e);
  }
}

async function readTracker(): Promise<OpenTracker> {
  try {
    const raw = await AsyncStorage.getItem(TRACKER_KEY);
    return restoreTracker(raw ? JSON.parse(raw) : null);
  } catch {
    return EMPTY_TRACKER;
  }
}

async function writeTracker(tracker: OpenTracker): Promise<void> {
  try {
    await AsyncStorage.setItem(TRACKER_KEY, JSON.stringify(tracker));
  } catch (e) {
    console.warn('[telemetry] could not persist the open tracker', e);
  }
}

/**
 * The generic recorder. `app.open` is the only caller today; §1's routing rule
 * says what else may join it — product analytics, never a care fact.
 *
 * A care fact (a dose was confirmed, how long after the alarm) belongs on the
 * Postgres row it describes, not here. This buffer is lossy by design: it is
 * capped, it drops its oldest under pressure, and it is thrown away wholesale
 * if it will not parse.
 */
export function record(name: string, props: Record<string, unknown> = {}): void {
  void serialise(async () => {
    const events = await readBuffer();
    await writeBuffer(bufferInto(events, { name, at: Date.now(), props }));
  });
}

/**
 * The launch open. Called once per process from `app/_layout.tsx`.
 *
 * The `AppState` listener cannot produce this one: the process begins in
 * `active` with nothing before it, so there is no transition to observe.
 *
 * `source` is `'notification'` when the OS launched the app from a reminder tap
 * and `'cold'` otherwise — the caller decides, because only it can ask
 * `getLastNotificationResponseAsync()`. Either way the event carries
 * `cold: true`, so "was this a launch or a return" stays answerable in Athena
 * without the two facts having to fight over one column.
 */
export function trackLaunch(source: OpenSource = 'cold'): void {
  void serialise(async () => {
    const tracker = await readTracker();
    const { tracker: next, event } = recordOpen(tracker, source, Date.now(), { cold: true });
    await writeTracker(next);
    if (event) await writeBuffer(bufferInto(await readBuffer(), event));
  });
}

/**
 * One `AppState` transition. Every one of them, including `inactive` — the
 * policy needs to see the whole sequence to tell a real return from the
 * `active → inactive → active` a permissions dialog produces.
 */
export function trackAppState(next: AppStateName): void {
  void serialise(async () => {
    const tracker = await readTracker();
    const outcome = observeAppState(tracker, next, Date.now());
    await writeTracker(outcome.tracker);
    if (outcome.event) await writeBuffer(bufferInto(await readBuffer(), outcome.event));
  });
}

/**
 * A notification response arrived, so the open it caused is the OS acting and
 * not the user (§3 trap 2).
 *
 * Handles both orderings of a race the listeners give no guarantee about: it
 * retags an `app.open` already buffered, or leaves a claim for the one about to
 * be. Serialised with everything else, which is what makes "already buffered"
 * a question with an answer.
 */
export function noteNotificationOpen(): void {
  void serialise(async () => {
    const tracker = await readTracker();
    const events = await readBuffer();
    const result = noteNotification(tracker, events, Date.now());
    await writeTracker(result.tracker);
    if (result.events !== events) await writeBuffer(result.events);
  });
}

/**
 * Drains the buffer to the ingest endpoint.
 *
 * Runs beside `flushDoseQueue()` in the notification re-sync, which already
 * happens at launch and on medications-screen focus — so this needs no timer of
 * its own and adds no wakeups.
 *
 * **A signed-out open buffers rather than being dropped.** §3 accepts the
 * consequence explicitly: an open before sign-in has no token and is attributed
 * to whoever authenticates first, which is the wrong person on a shared device.
 * The alternative is losing every pre-sign-in open, and 401 being retryable is
 * what makes the buffering happen.
 */
export async function flushTelemetry(): Promise<void> {
  await serialise(async () => {
    const events = await readBuffer();
    if (events.length === 0) return;

    // §7 step 4 — until the ingest endpoint exists there is nothing to flush
    // to, and §7 step 1 is explicit that the client half buffers locally until
    // then. Pruning here rather than returning early is what stops a build that
    // ships before the pipeline from carrying months of stale opens: without
    // it, `prepareBatch`'s age cap is never reached, because it only runs on
    // the batch about to be sent.
    if (!TELEMETRY_ENDPOINT) {
      const kept = prepareBatch(events, Date.now());
      if (kept.length !== events.length) await writeBuffer(kept);
      return;
    }

    let remaining = events;

    // Bounded by the buffer draining or by one batch failing — never a
    // `while (true)` over the network. A batch that cannot be sent stops the
    // pass; the next sync tries again with the same oldest-first slice.
    while (remaining.length > 0) {
      const sentAt = Date.now();
      const { batch, rest } = takeBatch(remaining);
      const payload = prepareBatch(batch, sentAt);

      // Everything in this slice was stale or malformed. Dropping it is the
      // whole outcome, and the loop has to keep going or those events block the
      // ones behind them forever.
      if (payload.length === 0) {
        remaining = rest;
        await writeBuffer(rest);
        continue;
      }

      const keep = await send(payload, sentAt);
      if (keep) break;

      remaining = rest;
      // Written per batch rather than once at the end: a flush that is
      // interrupted — the OS suspending the app mid-drain is the ordinary case
      // — must not re-send everything it already delivered.
      await writeBuffer(rest);
    }
  });
}

/** True if the batch should stay buffered for the next sync. */
async function send(payload: TelemetryEvent[], sentAt: number): Promise<boolean> {
  try {
    const res = await apiRequest(TELEMETRY_ENDPOINT as string, {
      method: 'POST',
      // `sent_at` travels with the batch so the ingest Lambda can correct the
      // whole thing against its own clock: the device's absolute time may be
      // wrong, but the offset between an event and the flush that carried it is
      // measured on one clock and is therefore sound.
      body: { sent_at: sentAt, events: payload },
    });

    if (res.ok) return false;

    if (!isRetryableStatus(res.status)) {
      // Terminal. A 400 will be a 400 again, and a 403 means this pipeline is
      // not accepting from this caller — neither is worth carrying, and
      // analytics is the one thing here that is genuinely disposable.
      console.warn('[telemetry] dropped', payload.length, 'events after', res.status);
      return false;
    }

    // 401 lands here, and it is the one that matters: it is the pre-sign-in
    // open, and the next sync carries a session.
    return true;
  } catch (e) {
    console.warn('[telemetry] flush failed, keeping the batch', e);
    return true;
  }
}
