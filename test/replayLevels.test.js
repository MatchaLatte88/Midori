/* The levels of an open position that can be dragged on the chart.
 *
 * Two properties worth pinning down without a chart to run them on. The first
 * is which line a pointer has hold of: a stop and a target a few pixels apart
 * must resolve to the one being pointed at rather than to whichever comes
 * first in the array, and a grab outside the block must find nothing at all.
 *
 * The second is which drops are refused. A stop on the wrong side of the last
 * price is not a stop — it is a market exit one bar later — and a target on the
 * wrong side is a limit that is already marketable. Both are refused where the
 * drop happens, because a position that closed itself a bar after a drag is the
 * hardest kind of surprise to trace back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  draggableLevels, levelAt, levelRefusal,
} from '../src/components/chart/replayLevels.js';

const EXTENT = { left: 100, right: 500 };
const LEVELS = [{ field: 'stopLoss', y: 200 }, { field: 'takeProfit', y: 120 }];

const long = (extra = {}) => ({ size: 1, entryPrice: 100, ...extra });
const short = (extra = {}) => ({ size: -1, entryPrice: 100, ...extra });

/* ─── What there is to grab ─────────────────────────────────────────────── */

test('a position with no protection on it offers nothing to drag', () => {
  // There is no line drawn, so a handle for one would be a handle on nothing.
  assert.deepEqual(draggableLevels(long()), []);
  assert.deepEqual(draggableLevels(null), []);
});

test('only the leg that exists is draggable', () => {
  assert.deepEqual(draggableLevels(long({ stopLoss: 90 })), [{ field: 'stopLoss', price: 90 }]);
  assert.deepEqual(
    draggableLevels(long({ takeProfit: 120 })),
    [{ field: 'takeProfit', price: 120 }],
  );
});

test('both legs come back when both are set', () => {
  assert.deepEqual(draggableLevels(long({ stopLoss: 90, takeProfit: 120 })), [
    { field: 'stopLoss', price: 90 },
    { field: 'takeProfit', price: 120 },
  ]);
});

/* ─── Which one the pointer has ─────────────────────────────────────────── */

test('a pointer on a line grabs it', () => {
  assert.equal(levelAt({ x: 300, y: 200 }, EXTENT, LEVELS), 'stopLoss');
  assert.equal(levelAt({ x: 300, y: 120 }, EXTENT, LEVELS), 'takeProfit');
});

test('a few pixels off still counts, further away does not', () => {
  assert.equal(levelAt({ x: 300, y: 204 }, EXTENT, LEVELS), 'stopLoss');
  assert.equal(levelAt({ x: 300, y: 160 }, EXTENT, LEVELS), null);
});

test('the nearer of two levels wins', () => {
  // Both within tolerance of each other: pointing between them must not be
  // settled by which happens to come first in the array.
  const close = [{ field: 'stopLoss', y: 200 }, { field: 'takeProfit', y: 203 }];
  assert.equal(levelAt({ x: 300, y: 202 }, EXTENT, close), 'takeProfit');
  assert.equal(levelAt({ x: 300, y: 199 }, EXTENT, close), 'stopLoss');
});

test('nothing is grabbed left of where the block starts', () => {
  assert.equal(levelAt({ x: 99, y: 200 }, EXTENT, LEVELS), null);
  assert.equal(levelAt({ x: 100, y: 200 }, EXTENT, LEVELS), 'stopLoss');
});

test('nothing is grabbed past the right edge either', () => {
  assert.equal(levelAt({ x: 501, y: 200 }, EXTENT, LEVELS), null);
});

test('a position with no levels has nothing under the pointer', () => {
  assert.equal(levelAt({ x: 300, y: 200 }, EXTENT, []), null);
});

/* ─── Where a level may be dropped ──────────────────────────────────────── */

test('a long keeps its stop below the last price and its target above', () => {
  assert.equal(levelRefusal('stopLoss', 95, long(), 100), null);
  assert.equal(levelRefusal('takeProfit', 105, long(), 100), null);
});

test('a stop above the last price on a long is refused', () => {
  // It would go into the market and trigger against the next open — the level
  // would have ended the trade rather than protected it.
  const why = levelRefusal('stopLoss', 105, long(), 100);
  assert.match(why, /close this long at market/);
});

test('a target below the last price on a long is refused', () => {
  assert.match(levelRefusal('takeProfit', 95, long(), 100), /close this long at market/);
});

test('a short is the mirror of it', () => {
  assert.equal(levelRefusal('stopLoss', 105, short(), 100), null);
  assert.equal(levelRefusal('takeProfit', 95, short(), 100), null);
  assert.match(levelRefusal('stopLoss', 95, short(), 100), /close this short at market/);
  assert.match(levelRefusal('takeProfit', 105, short(), 100), /close this short at market/);
});

test('a level on the last price itself is refused, not rounded through', () => {
  /* Equal to the last close means the very next bar opens on it. Which side it
   * lands is a coin toss, and a stop that might already be triggered is not a
   * stop anyone chose. */
  assert.ok(levelRefusal('stopLoss', 100, long(), 100));
  assert.ok(levelRefusal('takeProfit', 100, long(), 100));
});

test('nothing to measure against is a refusal rather than a silent pass', () => {
  assert.ok(levelRefusal('stopLoss', 95, null, 100));
  assert.ok(levelRefusal('stopLoss', Number.NaN, long(), 100));
  assert.ok(levelRefusal('stopLoss', 95, long(), null));
});
