/* Geometry of the marks a running replay puts on the chart.
 *
 * Same reason as the other primitive tests: logicalToCoordinate() returns 0 —
 * a valid coordinate — for a fractional index, so a half-bar offset asked for
 * in logical space fails silently and pins the mark to the left edge. The
 * arithmetic lives in pure functions so it can be checked without a chart.
 *
 * The property specific to this one is that an open position has no right-hand
 * end. A block that stopped at the playhead would read as a trade that closed
 * there, which is the opposite of what it means.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { barIndexAt, positionExtent } from '../src/components/chart/replayPrimitive.js';

const BAR = 10;                                  // pixels per bar
const PANE = 500;
const indexToX = (index) => 5 + index * BAR;     // bar 0 at x = 5, bar 1 at 15

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1);
const bars = (count) => Array.from({ length: count }, (_, i) => ({ time: T0 + i * MIN }));

/* ─── The open position ─────────────────────────────────────────────────── */

test('the block starts half a bar before the bar it was opened on', () => {
  const e = positionExtent(4, BAR, indexToX, PANE);
  assert.equal(e.left, 40, 'half a bar left of bar 4’s centre at 45');
});

test('an open position runs to the edge of the pane, not to the playhead', () => {
  /* It has not ended. Drawing an end would say it closed there, and the one
   * thing a live position is not is finished. */
  const e = positionExtent(4, BAR, indexToX, PANE);
  assert.equal(e.right, PANE);
});

test('a position opened off the left of the pane still has width', () => {
  const e = positionExtent(-30, BAR, indexToX, PANE);
  assert.ok(e.left < 0, 'its start is off-screen, which is fine');
  assert.equal(e.right, PANE);
  assert.ok(e.right > e.left, 'the block must not run backwards');
});

test('the block follows the bars when older ones are paged in', () => {
  const shifted = (index) => 5 + (index - 100) * BAR;
  assert.deepEqual(
    positionExtent(104, BAR, shifted, PANE),
    positionExtent(4, BAR, indexToX, PANE),
  );
});

test('a wider zoom moves the start but never the pane edge', () => {
  const wide = 40;
  const wideIndexToX = (index) => 5 + index * wide;
  const e = positionExtent(4, wide, wideIndexToX, PANE);

  assert.equal(e.left, 5 + 4 * wide - wide / 2);
  assert.equal(e.right, PANE, 'the right end is the pane, whatever the zoom');
});

/* ─── Resolving a fill to its bar ───────────────────────────────────────── */

test('a fill on a bar’s own time lands on that bar', () => {
  assert.equal(barIndexAt(bars(10), T0 + 4 * MIN), 4);
});

test('a fill inside a bar lands on the bar containing it', () => {
  /* With minute resolution a fill happens partway through its bar, so its
   * timestamp is not any bar's own — the mark belongs on the last bar that
   * started at or before it. */
  const hourly = [
    { time: T0 }, { time: T0 + 3_600_000 }, { time: T0 + 7_200_000 },
  ];
  assert.equal(barIndexAt(hourly, T0 + 3_600_000 + 42 * MIN), 1);
});

test('a fill before the loaded window clamps to the first bar', () => {
  // A block that vanished because its entry predates the window would be a
  // worse answer than one drawn at the edge.
  assert.equal(barIndexAt(bars(10), T0 - 5 * MIN), 0);
});

test('a fill after the loaded window clamps to the last bar', () => {
  assert.equal(barIndexAt(bars(10), T0 + 500 * MIN), 9);
});

test('no bars is index zero rather than minus one', () => {
  assert.equal(barIndexAt([], T0), 0);
  assert.equal(barIndexAt(null, T0), 0);
});

test('every bar of a window resolves to itself', () => {
  const window = bars(64);
  for (let i = 0; i < window.length; i++) {
    assert.equal(barIndexAt(window, window[i].time), i, `bar ${i} moved`);
  }
});
