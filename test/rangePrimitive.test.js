/* Geometry of the range marks.
 *
 * Same reason as test/fvgPrimitive.test.js and test/huntPrimitive.test.js: the
 * chart library's logicalToCoordinate() returns 0 — a valid coordinate — for a
 * fractional index, so a half-bar offset asked for in logical space fails
 * silently and pins the mark to the left edge. The arithmetic lives in one pure
 * function so it can be checked without a chart.
 *
 * The property that matters here is that the box and the break box meet: the
 * breaking bar is by construction the bar right after the last one inside, so
 * a gap between the two would draw as a seam that is not in the data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rangeExtent } from '../src/components/chart/rangePrimitive.js';

const BAR = 10;                                  // pixels per bar
const indexToX = (index) => 5 + index * BAR;     // bar 0 at x = 5, bar 1 at 15

const range = (startIndex, endIndex, breakIndex = null) => (
  { startIndex, endIndex, breakIndex }
);

test('the box spans whole bars, half a bar past each end', () => {
  const e = rangeExtent(range(2, 9), BAR, indexToX);
  // Half a bar left of bar 2's centre (25) and right of bar 9's centre (95).
  assert.equal(e.left, 20);
  assert.equal(e.right, 100);
  assert.equal(e.right - e.left, 8 * BAR, 'eight bars from 2 to 9 inclusive');
});

test('the break box is exactly the breaking bar', () => {
  const e = rangeExtent(range(2, 9, 10), BAR, indexToX);
  assert.equal(e.breakLeft, 100);
  assert.equal(e.breakRight, 110);
  assert.equal(e.breakRight - e.breakLeft, BAR, 'one bar wide');
});

test('the box and the break box meet without a seam', () => {
  const e = rangeExtent(range(2, 9, 10), BAR, indexToX);
  assert.equal(e.breakLeft, e.right, 'the break begins where the range ends');
});

test('a range with no breakout has no break extent to draw', () => {
  const e = rangeExtent(range(2, 9), BAR, indexToX);
  assert.equal(e.breakLeft, null);
  assert.equal(e.breakRight, null);
});

test('a range of the shortest possible length still has width', () => {
  const e = rangeExtent(range(4, 4), BAR, indexToX);
  assert.equal(e.right - e.left, BAR, 'one bar, not zero');
  assert.ok(e.right > e.left, 'the box must not run backwards');
});

test('every extent shifts with the bars, not with the screen', () => {
  /* Paging older bars in shifts every logical index by the same amount; the
   * marks have to move with them rather than staying where they were drawn. */
  const shifted = (index) => 5 + (index - 100) * BAR;
  const a = rangeExtent(range(2, 9, 10), BAR, indexToX);
  const b = rangeExtent(range(102, 109, 110), BAR, shifted);

  for (const key of ['left', 'right', 'breakLeft', 'breakRight']) {
    assert.equal(b[key], a[key], `${key} did not follow the shift`);
  }
});

test('a wider zoom scales the marks with the bar spacing', () => {
  const wide = 40;
  const wideIndexToX = (index) => 5 + index * wide;
  const e = rangeExtent(range(2, 9, 10), wide, wideIndexToX);

  assert.equal(e.right - e.left, 8 * wide, 'still eight bars');
  assert.equal(e.breakRight - e.breakLeft, wide, 'the break is still one bar');
  assert.equal(e.breakLeft, e.right, 'and they still meet');
});
