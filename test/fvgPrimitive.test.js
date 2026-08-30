/* Geometry of the FVG and IFVG boxes.
 *
 * This exists because the bug it guards against is invisible: the chart
 * library's logicalToCoordinate() returns 0 — a perfectly valid coordinate —
 * for a fractional index instead of null, so half-bar offsets asked for in
 * logical space pinned every box to the left edge and nothing threw. The
 * arithmetic lives in one pure function now so it can be checked without a
 * chart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boxExtent } from '../src/components/chart/fvgPrimitive.js';

const BAR = 10;           // pixels per bar
const PANE = 800;         // pane width
// Bar 0 sits at x = 5, bar 1 at 15, and so on.
const indexToX = (index) => 5 + index * BAR;

const view = (boxWidth = 0) => ({
  boxWidth, barSpacing: BAR, indexToX, paneWidth: PANE,
});

/** A zone is drawn from startIndex and confirmed at index — two bars later for
 *  a plain gap, arbitrarily much later for an inverted one. */
const zone = (startIndex, index = startIndex + 2, mitigatedIndex = null) => (
  { startIndex, index, mitigatedIndex }
);

test('an unfilled, uncapped box runs from its bar to the right edge', () => {
  const { left, right } = boxExtent(zone(3), view());
  // Half a bar left of bar 3's centre (35), not at its centre.
  assert.equal(left, 30);
  assert.equal(right, PANE);
});

test('a filled box ends half a bar past the bar that filled it', () => {
  const { left, right } = boxExtent(zone(3, 5, 9), view());
  assert.equal(left, 30);
  assert.equal(right, 100);
});

test('boxWidth counts bars from the bar that confirms the zone', () => {
  // Confirmed at bar 5 (centre 55, right edge 60), plus four bars.
  const { left, right } = boxExtent(zone(3), view(4));
  assert.equal(left, 30);
  assert.equal(right, 100);
});

test('whichever ends the box first wins', () => {
  // Filled at bar 7 (right = 80) with a cap reaching 100.
  assert.equal(boxExtent(zone(3, 5, 7), view(4)).right, 80);
  // Filled at bar 7 (right = 80) with a far looser cap.
  assert.equal(boxExtent(zone(3, 5, 7), view(20)).right, 80);
  // Filled late, capped early.
  assert.equal(boxExtent(zone(3, 5, 40), view(4)).right, 100);
});

test('a capped box far to the left stays far to the left', () => {
  // The regression: bar 2000 is off-screen, and its box must be off-screen
  // with it rather than collapsing onto the left edge of the pane.
  const { left, right } = boxExtent(zone(2000), view(4));
  assert.equal(left, 20000);
  assert.equal(right, 20070);

  const past = boxExtent(zone(-500), view(4));
  assert.ok(past.right < 0, 'a box left of the pane keeps a negative right edge');
});

test('a zero cap means no cap, not a zero-width box', () => {
  assert.equal(boxExtent(zone(3), view(0)).right, PANE);
  assert.equal(boxExtent(zone(3, 5, 9), view(0)).right, 100);
});

/* The case that forced the cap to be measured from the confirming bar: an
 * inverted gap is drawn from a gap that can predate its own break by hundreds
 * of bars. Counting the cap from the left edge ended the box long before the
 * level it marks ever applied — the box sat entirely in the past. */
test('a capped inverted zone still reaches past the bar that confirmed it', () => {
  const gapAt3BrokenAt200 = zone(3, 200);
  const { left, right } = boxExtent(gapAt3BrokenAt200, view(4));

  assert.equal(left, 30, 'drawn from the gap it came from');
  assert.ok(right > indexToX(200), 'the box must cover the bar that broke the gap');
  assert.equal(right, 2050); // bar 200 at 2005, plus half a bar, plus four bars

  // Counting from the left edge would have ended it at x = 70, 1935 pixels
  // short of the level ever applying.
  assert.ok(right > left + 4 * BAR);
});
