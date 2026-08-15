/**
 * Tests for the telemetry buffer's rules (TELEMETRY.md §3).
 *
 * Run with `npm test` from `tish-app/`.
 *
 * These assert things no runtime error will ever tell you about. A telemetry
 * pipeline that miscounts does not fail — it produces a plausible number, and
 * the whole point of measuring "how often a user opens the app" is that someone
 * will act on that number. The iOS transition sequence in particular is not
 * reproducible in any test that is not this one: it needs a device, a home
 * button, and someone watching a log.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APP_OPEN,
  EMPTY_TRACKER,
  FLAP_WINDOW_MS,
  MAX_BUFFER,
  MAX_EVENT_AGE_MS,
  MAX_EVENT_BYTES,
  NOTIFICATION_RETAG_MS,
  buffer,
  clampOccurredAt,
  noteNotificationOpen,
  observeAppState,
  prepareBatch,
  recordOpen,
  restoreTracker,
  retagRecentOpen,
  takeBatch,
} from './telemetry-policy.ts';
import type { AppStateName, OpenTracker, TelemetryEvent } from './telemetry-policy.ts';

const NOW = Date.parse('2026-08-14T09:00:00+08:00');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Feeds a sequence of states in and returns the opens it produced. */
function run(
  states: [AppStateName, number][],
  start: OpenTracker = EMPTY_TRACKER
): { tracker: OpenTracker; opens: TelemetryEvent[] } {
  let tracker = start;
  const opens: TelemetryEvent[] = [];
  for (const [state, at] of states) {
    const outcome = observeAppState(tracker, state, at);
    tracker = outcome.tracker;
    if (outcome.event) opens.push(outcome.event);
  }
  return { tracker, opens };
}

function event(over: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return { name: APP_OPEN, at: NOW, props: { source: 'foreground' }, ...over };
}

// ---------------------------------------------------------------------------
// The iOS transition sequence — trap 1
// ---------------------------------------------------------------------------

test('THE REAL iOS SEQUENCE IS COUNTED, inactive and all', () => {
  // Home button, then return. This exact sequence is what makes
  // "previous state was background" wrong: the listener sees `inactive`
  // immediately before `active`, never `background` immediately before it.
  const { opens } = run([
    ['inactive', NOW],
    ['background', NOW + 1000],
    ['inactive', NOW + HOUR],
    ['active', NOW + HOUR + 100],
  ]);

  assert.equal(opens.length, 1);
  assert.equal(opens[0].name, APP_OPEN);
  assert.equal(opens[0].props.source, 'foreground');
});

test('android background -> active, with no inactive at all, is the same one open', () => {
  const { opens } = run([
    ['background', NOW],
    ['active', NOW + HOUR],
  ]);
  assert.equal(opens.length, 1);
});

test('a dialog that never backgrounds the app is not an open', () => {
  // A permissions prompt, an incoming call, the share sheet: active -> inactive
  // -> active with the app still on screen the whole time. Counting these would
  // add an "open" every time the app asked for notification permission.
  const { opens } = run([
    ['inactive', NOW],
    ['active', NOW + 3000],
  ]);
  assert.equal(opens.length, 0);
});

test('an active with nothing before it is not an open', () => {
  // The cold start already arrives in `active`. The launch open is recorded
  // explicitly; this transition must not record a second one.
  const { opens } = run([['active', NOW]]);
  assert.equal(opens.length, 0);
});

// ---------------------------------------------------------------------------
// Flaps — trap 2
// ---------------------------------------------------------------------------

test('a flap through the app switcher is not a second open', () => {
  const { opens } = run([
    ['background', NOW],
    ['active', NOW + HOUR],
    ['background', NOW + HOUR + 2000],
    ['active', NOW + HOUR + 5000],
  ]);
  assert.equal(opens.length, 1);
});

test('THE FLAP RULE MEASURES THE ABSENCE, NOT THE GAP SINCE THE LAST OPEN', () => {
  // The case that separates the two readings of "drop flaps under 60s", and the
  // one that actually happens: someone reads their medication list for five
  // minutes, glances at the notification shade, comes straight back. Measured
  // on the gap since the last open that is a fresh open five minutes on;
  // measured on how long the app was away it is the two seconds it really was.
  const { opens } = run([
    ['background', NOW],
    ['active', NOW + HOUR],              // a genuine open
    ['background', NOW + HOUR + 5 * MINUTE],
    ['active', NOW + HOUR + 5 * MINUTE + 2000],
  ]);

  assert.equal(opens.length, 1, 'the glance at the shade is not an open');
});

test('A RUN OF FLAPS ADDS NOTHING, HOWEVER LONG IT GOES ON', () => {
  // Ten minutes of flicking between apps: twenty round trips, each two seconds
  // away. On the gap reading all but the first would count, so the users who
  // used the app hardest would report the most "opens" — the metric would
  // measure restlessness.
  let tracker = recordOpen(EMPTY_TRACKER, 'cold', NOW).tracker;
  let opens = 0;

  for (let i = 1; i <= 20; i++) {
    const away = NOW + i * 30 * 1000;
    tracker = observeAppState(tracker, 'background', away).tracker;
    const back = observeAppState(tracker, 'active', away + 2000);
    tracker = back.tracker;
    if (back.event) opens++;
  }

  assert.equal(opens, 0, 'none of the flaps is an open');

  // And a genuine one after them still counts, with the gap measured from the
  // cold open rather than from any of the flaps.
  tracker = observeAppState(tracker, 'background', NOW + 2 * HOUR).tracker;
  const later = observeAppState(tracker, 'active', NOW + 3 * HOUR);
  assert.ok(later.event, 'a real return is not suppressed');
  assert.equal(later.event?.props.since_last_open_ms, 3 * HOUR);
});

test('an absence exactly at the flap boundary counts', () => {
  const backgrounded = observeAppState(EMPTY_TRACKER, 'background', NOW).tracker;

  const at = observeAppState(backgrounded, 'active', NOW + FLAP_WINDOW_MS);
  assert.ok(at.event);
  assert.equal(at.event?.props.awayMs, FLAP_WINDOW_MS);

  const inside = observeAppState(backgrounded, 'active', NOW + FLAP_WINDOW_MS - 1);
  assert.equal(inside.event, null);
});

test('a repeated background does not shorten a long absence into a flap', () => {
  // Android delivers `background` more than once without an intervening
  // `active`. Taking the later one would turn eight hours away into a flap and
  // drop the morning open.
  const { opens } = run([
    ['background', NOW],
    ['background', NOW + 8 * HOUR],
    ['active', NOW + 8 * HOUR + 5000],
  ]);
  assert.equal(opens.length, 1);
  assert.equal(opens[0].props.awayMs, 8 * HOUR + 5000);
});

test('a flap does not become the anchor the next gap is measured from', () => {
  let tracker = recordOpen(EMPTY_TRACKER, 'cold', NOW).tracker;

  tracker = observeAppState(tracker, 'background', NOW + 10 * MINUTE).tracker;
  tracker = observeAppState(tracker, 'active', NOW + 10 * MINUTE + 1000).tracker;

  tracker = observeAppState(tracker, 'background', NOW + 20 * MINUTE).tracker;
  const real = observeAppState(tracker, 'active', NOW + 3 * HOUR);

  assert.equal(real.event?.props.since_last_open_ms, 3 * HOUR, 'measured from the cold open');
});

// ---------------------------------------------------------------------------
// Source — trap 3
// ---------------------------------------------------------------------------

test('a notification response arriving first claims the open', () => {
  const noted = noteNotificationOpen(EMPTY_TRACKER, [], NOW);
  const opened = recordOpen(noted.tracker, 'foreground', NOW + 200);

  assert.equal(opened.event?.props.source, 'notification');
});

test('A NOTIFICATION RESPONSE ARRIVING SECOND RETAGS THE OPEN ALREADY BUFFERED', () => {
  // The other half of the race, and the half that silently loses the tag if it
  // is not handled: the AppState listener wins, `foreground` is already in the
  // buffer, and the tap is then suppressed as a flap. Most opens in an
  // alarm-driven app arrive this way, so getting this wrong makes the metric
  // mostly a count of how many reminders someone is on.
  const opened = recordOpen(EMPTY_TRACKER, 'foreground', NOW);
  const events = opened.event ? [opened.event] : [];

  const noted = noteNotificationOpen(opened.tracker, events, NOW + 300);

  assert.equal(noted.events[0].props.source, 'notification');
  assert.equal(noted.tracker.pendingSource, null, 'nothing left pending once it landed');
});

test('a tap long after an open does not retag it', () => {
  const opened = recordOpen(EMPTY_TRACKER, 'foreground', NOW);
  const events = opened.event ? [opened.event] : [];

  const noted = noteNotificationOpen(opened.tracker, events, NOW + NOTIFICATION_RETAG_MS + 1);

  assert.equal(noted.events[0].props.source, 'foreground');
  assert.equal(noted.tracker.pendingSource, 'notification', 'it waits for the next open instead');
});

test('a stale pending tap does not claim a much later open', () => {
  const noted = noteNotificationOpen(EMPTY_TRACKER, [], NOW);
  const opened = recordOpen(noted.tracker, 'foreground', NOW + HOUR);
  assert.equal(opened.event?.props.source, 'foreground');
});

test('cold survives a notification tap, because a launch from one is both', () => {
  const noted = noteNotificationOpen(EMPTY_TRACKER, [], NOW);
  const opened = recordOpen(noted.tracker, 'cold', NOW + 200);
  assert.equal(opened.event?.props.source, 'cold');
});

test('retagging finds the open even with other events after it', () => {
  const events = [
    event({ name: 'other.thing', at: NOW - 1000 }),
    event({ at: NOW }),
    event({ name: 'other.thing', at: NOW + 100 }),
  ];
  const retagged = retagRecentOpen(events, NOW + 500);
  assert.ok(retagged);
  assert.equal(retagged?.[1].props.source, 'notification');
  assert.equal(retagged?.[2].name, 'other.thing');
});

test('retagging leaves an already-tagged open alone', () => {
  const events = [event({ props: { source: 'notification' } })];
  assert.equal(retagRecentOpen(events, NOW + 500), null);
});

test('retagging a buffer with no open at all is a no-op', () => {
  assert.equal(retagRecentOpen([event({ name: 'other.thing' })], NOW), null);
});

// ---------------------------------------------------------------------------
// The gap, which is what a session is computed from later
// ---------------------------------------------------------------------------

test('the gap since the last open is carried, and no session threshold is', () => {
  const first = recordOpen(EMPTY_TRACKER, 'cold', NOW);
  assert.equal(first.event?.props.since_last_open_ms, null, 'the first ever has no gap');

  const second = recordOpen(first.tracker, 'foreground', NOW + 3 * HOUR);
  assert.equal(second.event?.props.since_last_open_ms, 3 * HOUR);
});

test('A CLOCK THAT MOVES BACKWARDS NEVER REPORTS A NEGATIVE GAP', () => {
  // A device that was a year fast and then corrected itself. A negative
  // duration is not a value anything downstream can survive: it silently drags
  // averages and percentiles over "time between opens" toward nonsense, and
  // nothing about it looks like an error. Null is the honest answer — we do not
  // know how long it had been.
  const first = recordOpen(EMPTY_TRACKER, 'cold', NOW + 365 * 24 * HOUR);
  const corrected = recordOpen(first.tracker, 'foreground', NOW);

  assert.ok(corrected.event, 'the open is still recorded');
  assert.equal(corrected.event?.props.since_last_open_ms, null, 'but the gap is not invented');
  assert.equal(corrected.tracker.lastOpenAt, NOW, 'and the clock is re-anchored');

  const after = recordOpen(corrected.tracker, 'foreground', NOW + HOUR);
  assert.equal(after.event?.props.since_last_open_ms, HOUR);
});

test('a clock that moves backwards while the app is away is not read as a flap', () => {
  // A negative absence is not a short one. Suppressing it would drop a genuine
  // open, and the direction of the correction is arbitrary — so it is recorded,
  // with an honest null for how long it was away.
  const backgrounded = observeAppState(EMPTY_TRACKER, 'background', NOW + HOUR).tracker;
  const back = observeAppState(backgrounded, 'active', NOW);

  assert.ok(back.event, 'the open is still recorded');
  assert.equal(back.event?.props.awayMs, null);
});

// ---------------------------------------------------------------------------
// Surviving a process boundary
// ---------------------------------------------------------------------------

test('A PERSISTED backgroundedAt DOES NOT SURVIVE A RELAUNCH', () => {
  // The app was backgrounded and then killed by the OS, so a timestamp is what
  // is on disk. Restoring it would make the first `active` of the next process
  // look like a return from background, landing a phantom open immediately
  // after the cold one — on every launch of every app the OS reaps, which is
  // most of them.
  const persisted: OpenTracker = {
    backgroundedAt: NOW - HOUR,
    lastOpenAt: NOW,
    pendingSource: 'notification',
    pendingSourceAt: NOW,
  };

  const restored = restoreTracker(persisted);
  assert.equal(restored.backgroundedAt, null);
  assert.equal(restored.pendingSource, null);
  assert.equal(restored.lastOpenAt, NOW, 'but the gap survives, which is the point');

  const { opens } = run([['active', NOW + HOUR]], restored);
  assert.equal(opens.length, 0);
});

test('restoring junk gives a usable tracker', () => {
  for (const junk of [null, undefined, 'nope', 42, {}, { lastOpenAt: 'x' }, { lastOpenAt: 0 }]) {
    const restored = restoreTracker(junk);
    assert.equal(restored.lastOpenAt, null, JSON.stringify(junk));
    assert.equal(restored.backgroundedAt, null);
  }
});

// ---------------------------------------------------------------------------
// The buffer
// ---------------------------------------------------------------------------

test('the buffer caps by dropping the oldest', () => {
  let events: TelemetryEvent[] = [];
  for (let i = 0; i < MAX_BUFFER + 25; i++) {
    events = buffer(events, event({ at: NOW + i }));
  }

  assert.equal(events.length, MAX_BUFFER);
  assert.equal(events[0].at, NOW + 25, 'the oldest went');
  assert.equal(events[events.length - 1].at, NOW + MAX_BUFFER + 24);
});

test('a batch is bounded by count and by bytes, oldest first', () => {
  const events = Array.from({ length: 250 }, (_, i) => event({ at: NOW + i }));
  const { batch, rest } = takeBatch(events);

  assert.equal(batch.length, 100);
  assert.equal(batch[0].at, NOW, 'oldest first, so a partial drain makes progress in order');
  assert.equal(rest.length, 150);
});

test('a byte cap smaller than one event still yields one event', () => {
  // Otherwise the flush loop makes no progress and the buffer never drains.
  const { batch, rest } = takeBatch([event(), event()], 100, 1);
  assert.equal(batch.length, 1);
  assert.equal(rest.length, 1);
});

test('an empty buffer yields an empty batch', () => {
  const { batch, rest } = takeBatch([]);
  assert.equal(batch.length, 0);
  assert.equal(rest.length, 0);
});

// ---------------------------------------------------------------------------
// What reaches the wire
// ---------------------------------------------------------------------------

test('A DEVICE CLOCK NEVER DATES AN EVENT AFTER THE FLUSH THAT CARRIES IT', () => {
  // A phone set a year fast would otherwise write every open into next year's
  // Firehose partitions, where no query looks and nothing reports a problem.
  const prepared = prepareBatch([event({ at: NOW + 365 * 24 * HOUR })], NOW);
  assert.equal(prepared[0].at, NOW);
  assert.equal(clampOccurredAt(NOW + 1, NOW), NOW);
  assert.equal(clampOccurredAt(NOW - 1, NOW), NOW - 1, 'the past is left alone');
});

test('an event older than the age cap is dropped', () => {
  const prepared = prepareBatch([
    event({ at: NOW - MAX_EVENT_AGE_MS - 1 }),
    event({ at: NOW - MAX_EVENT_AGE_MS + 1 }),
  ], NOW);
  assert.equal(prepared.length, 1);
});

test('AN OVERSIZED EVENT IS DROPPED RATHER THAN WEDGING THE BUFFER BEHIND IT', () => {
  // Sending it fails, and a retryable failure retries the same batch forever —
  // so one bad call site would cost every event queued after it.
  const huge = event({ props: { source: 'foreground', junk: 'x'.repeat(MAX_EVENT_BYTES) } });
  const prepared = prepareBatch([huge, event()], NOW);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].props.junk, undefined);
});

test('an unserialisable event is dropped rather than throwing in the transport', () => {
  const circular: any = { name: APP_OPEN, at: NOW, props: {} };
  circular.props.self = circular;

  assert.doesNotThrow(() => prepareBatch([circular, event()], NOW));
  assert.equal(prepareBatch([circular, event()], NOW).length, 1);
});

test('a malformed event is dropped rather than sent', () => {
  const junk = [
    null,
    undefined,
    { at: NOW, props: {} },
    { name: APP_OPEN, at: NaN, props: {} },
    { name: 7, at: NOW, props: {} },
  ] as unknown as TelemetryEvent[];

  assert.equal(prepareBatch(junk, NOW).length, 0);
  assert.equal(prepareBatch([...junk, event()], NOW).length, 1);
});

test('preparing does not mutate the buffer it was given', () => {
  const original = event({ at: NOW + HOUR });
  const events = [original];
  prepareBatch(events, NOW);
  assert.equal(events[0].at, NOW + HOUR, 'a failed POST must re-send what was buffered');
  assert.equal(original.at, NOW + HOUR);
});
