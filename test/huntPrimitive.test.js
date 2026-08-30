/* Geometry of the stop-hunt marks.
 *
 * Same reason as test/fvgPrimitive.test.js: the chart library's
 * logicalToCoordinate() returns 0 — a valid coordinate — for a fractional
 * index, so a half-bar offset asked for in logical space fails silently and
 * pins the mark to the left edge. The arithmetic lives in one pure function so
 * it can be checked without a chart.
 *
 * A hunt has three extents rather than one, and the interesting property is
 * that they meet: the line stops where the raid starts, and the window starts
 * where the raid ends. A gap between any two of them would draw as a seam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { huntExtent } from '../src/components/chart/huntPrimitive.js';

const BAR = 10;                                  // pixels per bar
const indexToX = (index) => 5 + index * BAR;     // bar 0 at x = 5, bar 1 at 15

/** levelIndex is where the level formed, sweepIndex the raid, index the reclaim. */
const hunt = (levelIndex, sweepIndex, index = sweepIndex) => (
  { levelIndex, sweepIndex, index }
);

test('the line runs from the level to the bar that ran it', () => {
  const e = huntExtent(hunt(2, 9), BAR, indexToX);
  // Half a bar left of bar 2's centre (25), not at its centre.
  assert.equal(e.lineLeft, 20);
  // ...and stops half a bar left of bar 9's centre (95), where the raid starts.
  assert.equal(e.lineRight, 90);
});

test('the raid box is exactly the breaching bar', () => {
  const e = huntExtent(hunt(2, 9), BAR, indexToX);
  assert.equal(e.raidLeft, 90);
  assert.equal(e.raidRight, 100);
  assert.equal(e.raidRight - e.raidLeft, BAR, 'one bar wide');
});

test('the three extents meet without a seam', () => {
  const e = huntExtent(hunt(2, 9, 12), BAR, indexToX);
  assert.equal(e.lineRight, e.raidLeft, 'line and raid must touch');
  assert.ok(e.windowRight > e.raidRight, 'a later reclaim needs a window');
});

test('a same-bar reclaim leaves no window to draw', () => {
  // sweepIndex === index: the breaching bar closed back inside on its own.
  const e = huntExtent(hunt(2, 9, 9), BAR, indexToX);
  assert.equal(e.windowRight, e.raidRight, 'the window must be empty, not negative');
});

test('the window stretches to the confirming bar', () => {
  const e = huntExtent(hunt(2, 9, 12), BAR, indexToX);
  // Half a bar past bar 12's centre (125).
  assert.equal(e.windowRight, 130);
  assert.equal(e.windowRight - e.raidRight, 3 * BAR, 'three bars of waiting');
});

test('a level swept on the very next bar still draws a line', () => {
  /* The tightest case the detector can produce: the guard in findSweeps means
   * sweepIndex is always at least levelIndex + 1, so the line is never
   * inverted — but it can be exactly one bar wide. */
  const e = huntExtent(hunt(4, 5), BAR, indexToX);
  assert.equal(e.lineRight - e.lineLeft, BAR);
  assert.ok(e.lineRight > e.lineLeft, 'the line must not run backwards');
});

test('every extent shifts with the bars, not with the screen', () => {
  /* Paging older bars in shifts every logical index by the same amount; the
   * marks have to move with them rather than staying where they were drawn. */
  const shifted = (index) => 5 + (index - 100) * BAR;
  const a = huntExtent(hunt(2, 9, 12), BAR, indexToX);
  const b = huntExtent(hunt(102, 109, 112), BAR, shifted);

  for (const key of ['lineLeft', 'lineRight', 'raidLeft', 'raidRight', 'windowRight']) {
    assert.equal(b[key], a[key], `${key} did not follow the shift`);
  }
});

test('a wider zoom scales the marks with the bar spacing', () => {
  const wide = 40;
  const wideIndexToX = (index) => 5 + index * wide;
  const e = huntExtent(hunt(2, 9, 12), wide, wideIndexToX);

  assert.equal(e.raidRight - e.raidLeft, wide, 'the raid is still one bar');
  assert.equal(e.windowRight - e.raidRight, 3 * wide, 'still three bars of window');
});
