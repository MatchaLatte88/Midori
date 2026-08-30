/* Geometry of the Silver Bullet setup marks.
 *
 * Same reason as test/fvgPrimitive.test.js and test/huntPrimitive.test.js: the
 * chart library returns 0 — a valid coordinate — for a fractional logical
 * index, so a half-bar offset asked for in logical space fails silently. The
 * arithmetic lives in one pure function so it can be checked without a chart.
 *
 * The property that matters here is the join: the gap box has to end exactly
 * where the position block begins, because past the entry the gap is no longer
 * a level being waited for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupExtent } from '../src/components/chart/setupPrimitive.js';

const BAR = 10;                                  // pixels per bar
const PANE = 800;
const indexToX = (index) => 5 + index * BAR;     // bar 0 at x = 5, bar 1 at 15

const setup = (over = {}) => ({
  sweepIndex: 4, gapStartIndex: 6, entryIndex: 9, outcomeIndex: 12, ...over,
});

test('the gap box ends where the block begins', () => {
  const e = setupExtent(setup(), BAR, indexToX, PANE);
  assert.equal(e.gapRight, e.blockLeft, 'a seam would show between them');
});

test('the gap box starts half a bar left of the bars that formed it', () => {
  const e = setupExtent(setup(), BAR, indexToX, PANE);
  // Bar 6's centre is 65.
  assert.equal(e.gapLeft, 60);
});

test('the block runs from the entry to the bar that resolved it', () => {
  const e = setupExtent(setup(), BAR, indexToX, PANE);
  // Half a bar left of bar 9's centre (95), half a bar past bar 12's (125).
  assert.equal(e.blockLeft, 90);
  assert.equal(e.blockRight, 130);
});

test('an unresolved setup runs to the right edge', () => {
  /* Cutting it off at the last bar would read as "this finished here", which
   * is the one thing an open trade has not done. */
  const e = setupExtent(setup({ outcomeIndex: null }), BAR, indexToX, PANE);
  assert.equal(e.blockRight, PANE);
});

test('the sweep tick sits on the bar centre, not its edge', () => {
  const e = setupExtent(setup(), BAR, indexToX, PANE);
  assert.equal(e.sweepX, indexToX(4));
});

test('a trade resolved on its own entry bar still has width', () => {
  // The tightest case the detector produces: entry and outcome on one bar.
  const e = setupExtent(setup({ entryIndex: 9, outcomeIndex: 9 }), BAR, indexToX, PANE);
  assert.equal(e.blockRight - e.blockLeft, BAR, 'exactly one bar wide');
  assert.ok(e.blockRight > e.blockLeft, 'the block must not run backwards');
});

test('every extent shifts with the bars, not with the screen', () => {
  /* Paging older bars in shifts every logical index by the same amount; the
   * marks have to move with them rather than staying where they were drawn. */
  const shifted = (index) => 5 + (index - 100) * BAR;
  const a = setupExtent(setup(), BAR, indexToX, PANE);
  const b = setupExtent(
    setup({ sweepIndex: 104, gapStartIndex: 106, entryIndex: 109, outcomeIndex: 112 }),
    BAR, shifted, PANE,
  );

  for (const key of ['sweepX', 'gapLeft', 'gapRight', 'blockLeft', 'blockRight']) {
    assert.equal(b[key], a[key], `${key} did not follow the shift`);
  }
});

test('a wider zoom scales the marks with the bar spacing', () => {
  const wide = 40;
  const e = setupExtent(setup(), wide, (i) => 5 + i * wide, PANE);

  assert.equal(e.gapRight - e.gapLeft, 3 * wide, 'gap start to entry is three bars');
  assert.equal(e.blockRight - e.blockLeft, 4 * wide, 'entry to outcome is four bars');
});
