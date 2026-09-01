import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zoneAnchors, zoneAt } from '../src/components/chart/drawings/fvgSnap.js';

/* One bullish gap and nothing else: bar 2 opens above bar 0's high, leaving the
 * stretch 100..110 untraded. Confirmed at index 2, drawn from index 0. Nothing
 * afterwards comes back down to 100, so it stays open. */
const OPEN = [
  { time: 0, open: 95, high: 100, low: 90, close: 98 },
  { time: 60, open: 98, high: 130, low: 95, close: 128 },
  { time: 120, open: 128, high: 135, low: 110, close: 132 },
  { time: 180, open: 132, high: 138, low: 125, close: 136 },
  { time: 240, open: 136, high: 140, low: 130, close: 138 },
];

/** The same gap, filled on the last bar. */
const FILLED = [
  ...OPEN,
  { time: 300, open: 138, high: 139, low: 95, close: 100 },
];

test('a click inside a gap finds it', () => {
  const zone = zoneAt(OPEN, { time: 120, price: 105 });
  assert.ok(zone, 'the gap is there to be found');
  assert.equal(zone.direction, 'bull');
  assert.equal(zone.bottom, 100);
  assert.equal(zone.top, 110);
  assert.equal(zone.startIndex, 0, 'drawn from the bar the gap starts on');
  assert.equal(zone.index, 2, 'confirmed by the bar that completed it');
});

test('a click outside the two prices finds nothing', () => {
  assert.equal(zoneAt(OPEN, { time: 120, price: 120 }), null, 'above the gap');
  assert.equal(zoneAt(OPEN, { time: 120, price: 95 }), null, 'below it');
});

test('a click before the gap starts finds nothing', () => {
  // The box begins at bar 0; anything left of that is chart the gap never
  // covered, however right the price is.
  assert.equal(zoneAt(OPEN, { time: -60, price: 105 }), null);
  assert.ok(zoneAt(OPEN, { time: 0, price: 105 }), 'the first bar itself counts');
});

test('an open gap has no right edge, a filled one ends where it was filled', () => {
  assert.ok(zoneAt(OPEN, { time: 9_999, price: 105 }), 'still open, still clickable');

  const filled = zoneAt(FILLED, { time: 300, price: 105 });
  assert.ok(filled, 'the bar that filled it is still part of the box');
  assert.equal(filled.mitigatedIndex, 5);
  assert.equal(zoneAt(FILLED, { time: 360, price: 105 }), null, 'past the fill');
});

test('the tolerance makes a gap a few pixels tall clickable', () => {
  // Two points either side of the gap: one is reachable with slack, one is not.
  assert.equal(zoneAt(OPEN, { time: 120, price: 112 }), null, 'without slack');
  assert.ok(zoneAt(OPEN, { time: 120, price: 112 }, 3), 'with three of slack');
  assert.equal(zoneAt(OPEN, { time: 120, price: 112 }, 1), null, 'but not with one');
});

test('where boxes overlap, the smallest one wins', () => {
  /* A big gap (100..130) with a small one (112..115) inside it, both open. The
   * big one stays reachable everywhere the small one is not; picked the other
   * way round, the small one could never be clicked at all. */
  const nested = [
    { time: 0, open: 95, high: 100, low: 90, close: 98 },
    { time: 60, open: 98, high: 140, low: 95, close: 138 },
    { time: 120, open: 138, high: 145, low: 130, close: 140 },
    { time: 180, open: 111, high: 112, low: 108, close: 110 },
    { time: 240, open: 110, high: 118, low: 110, close: 117 },
    { time: 300, open: 117, high: 125, low: 115, close: 124 },
  ];

  const small = zoneAt(nested, { time: 300, price: 113.5 });
  assert.equal(small.bottom, 112);
  assert.equal(small.top, 115);

  const big = zoneAt(nested, { time: 300, price: 105 });
  assert.equal(big.bottom, 100, 'below the small one, only the big one covers it');
  assert.equal(big.top, 130);
});

test('too few bars to hold a gap is not an error', () => {
  assert.equal(zoneAt([], { time: 0, price: 1 }), null);
  assert.equal(zoneAt(OPEN.slice(0, 2), { time: 60, price: 105 }), null);
  assert.equal(zoneAt(null, { time: 0, price: 1 }), null);
});

test('anchors run from the top-left of the gap to its bottom-right', () => {
  const [top, bottom] = zoneAnchors(zoneAt(OPEN, { time: 120, price: 105 }), OPEN);
  assert.deepEqual(top, { time: 0, price: 110 }, 'starts on the gap bar, at the top price');
  assert.deepEqual(bottom, { time: 240, price: 100 },
    'an open gap is frozen at the last bar loaded');

  const [, end] = zoneAnchors(zoneAt(FILLED, { time: 120, price: 105 }), FILLED);
  assert.equal(end.time, 300, 'a filled gap stops on the bar that filled it');
});

/* Two bullish gaps from one impulse — 100..109.5 and 110..116 — with half a
 * point of traded price between them. */
const STACKED = [
  { time: 0, open: 99, high: 100, low: 98, close: 99 },
  { time: 60, open: 99, high: 110, low: 99, close: 109 },
  { time: 120, open: 110, high: 115, low: 109.5, close: 114 },
  { time: 180, open: 116, high: 118, low: 116, close: 117 },
];

test('the tool marks a single gap or the whole run, as it is set', () => {
  const alone = zoneAt(STACKED, { time: 120, price: 105 });
  assert.equal(alone.bottom, 100);
  assert.equal(alone.top, 109.5, 'off by default: the gap the click landed in');

  const run = zoneAt(STACKED, { time: 120, price: 105 }, 0, {
    mergeWick: 1, mergeUnit: 'points',
  });
  assert.equal(run.bottom, 100);
  assert.equal(run.top, 116, 'the run the gap belongs to');

  // A click in the upper gap picks up the same run rather than the sliver.
  const fromAbove = zoneAt(STACKED, { time: 180, price: 112 }, 0, {
    mergeWick: 1, mergeUnit: 'points',
  });
  assert.equal(fromAbove.top, 116);
  assert.equal(fromAbove.bottom, 100);
});

test('a merged run is anchored across every gap in it', () => {
  const run = zoneAt(STACKED, { time: 120, price: 105 }, 0, {
    mergeWick: 1, mergeUnit: 'points',
  });
  const [top, bottom] = zoneAnchors(run, STACKED);
  assert.deepEqual(top, { time: 0, price: 116 }, 'from the first gap bar, at the run top');
  assert.deepEqual(bottom, { time: 180, price: 100 });
});
