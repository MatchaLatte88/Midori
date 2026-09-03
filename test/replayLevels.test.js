/* The levels of an open position that can be dragged on the chart.
 *
 * Three properties worth pinning down without a chart to run them on.
 *
 * Which line a pointer has hold of: a stop and a target a few pixels apart must
 * resolve to the one being pointed at rather than to whichever comes first in
 * the array, and a grab outside the block must find nothing at all.
 *
 * What a drag off the entry line becomes: the side of the last price decides,
 * never the side of the entry — a long already well in front has an entry far
 * below the market, and dragging down from it still means "this is where I am
 * wrong".
 *
 * And which drops are refused. A stop on the wrong side of the last price is
 * not a stop — it is a market exit one bar later — and a target on the wrong
 * side is a limit that is already marketable. Both are refused where the drop
 * happens, because a position that closed itself a bar after a drag is the
 * hardest kind of surprise to trace back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOSE_INSET, closeButtonRect, draggableLevels, draggableOrders, fieldForPrice, inRect, levelAt,
  levelRefusal, orderAt, orderRefusal,
} from '../src/components/chart/replayLevels.js';

const EXTENT = { left: 100, right: 500 };
const LEVELS = [{ field: 'stopLoss', y: 200 }, { field: 'takeProfit', y: 120 }];

const long = (extra = {}) => ({ size: 1, entryPrice: 100, ...extra });
const short = (extra = {}) => ({ size: -1, entryPrice: 100, ...extra });

/* ─── What there is to grab ─────────────────────────────────────────────── */

test('the entry line is always there to be taken hold of', () => {
  /* Not to be moved — the position opened where it opened. It is the line a
   * stop or a target is drawn off, which is the only way to put one on a
   * position that has none. */
  assert.deepEqual(draggableLevels(long()), [{ field: 'entry', price: 100 }]);
  assert.deepEqual(draggableLevels(null), []);
});

test('whichever legs exist join the entry', () => {
  assert.deepEqual(draggableLevels(long({ stopLoss: 90 })), [
    { field: 'entry', price: 100 },
    { field: 'stopLoss', price: 90 },
  ]);
  assert.deepEqual(draggableLevels(long({ takeProfit: 120 })), [
    { field: 'entry', price: 100 },
    { field: 'takeProfit', price: 120 },
  ]);
  assert.deepEqual(draggableLevels(long({ stopLoss: 90, takeProfit: 120 })), [
    { field: 'entry', price: 100 },
    { field: 'stopLoss', price: 90 },
    { field: 'takeProfit', price: 120 },
  ]);
});

/* ─── What a drag off the entry becomes ─────────────────────────────────── */

test('below the market protects a long and pays a short', () => {
  assert.equal(fieldForPrice(95, long(), 100), 'stopLoss');
  assert.equal(fieldForPrice(95, short(), 100), 'takeProfit');
});

test('above the market is the other way round', () => {
  assert.equal(fieldForPrice(105, long(), 100), 'takeProfit');
  assert.equal(fieldForPrice(105, short(), 100), 'stopLoss');
});

test('the last price decides it, never the entry', () => {
  /* A long 100 in front has an entry far below the market. Dragging down from
   * that entry still means "this is where I am wrong" — a level between the
   * entry and the market is a stop, not a target, whatever side of the entry
   * it happens to be on. */
  const inProfit = long({ entryPrice: 100 });
  assert.equal(fieldForPrice(150, inProfit, 200), 'stopLoss');
  assert.equal(fieldForPrice(250, inProfit, 200), 'takeProfit');
});

test('a drag that ends on the last price is answered here and refused after', () => {
  // One place decides what a level is, another whether it may be there.
  const field = fieldForPrice(100, long(), 100);
  assert.ok(field === 'stopLoss' || field === 'takeProfit');
  assert.ok(levelRefusal(field, 100, long(), 100));
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

/* ─── The button that closes it ─────────────────────────────────────────── */

test('the close button sits on the entry line against the right edge', () => {
  const rect = closeButtonRect(800, 300);
  assert.equal(rect.x + rect.width + CLOSE_INSET, 800, 'held off the edge by the inset');
  assert.equal(rect.y + rect.height / 2, 300, 'centred on the line');
});

test('a pointer on the button is inside it, one past the corner is not', () => {
  const rect = closeButtonRect(800, 300);
  assert.ok(inRect({ x: rect.x + 1, y: rect.y + 1 }, rect));
  assert.ok(inRect({ x: rect.x + rect.width, y: rect.y + rect.height }, rect), 'the far corner counts');
  assert.ok(!inRect({ x: rect.x - 1, y: 300 }, rect));
  assert.ok(!inRect({ x: rect.x + 1, y: rect.y - 1 }, rect));
});

test('the button moves with the entry line and with the pane', () => {
  /* It is drawn from the same rectangle it is clicked in, so a chart that has
   * been resized or a position that has been re-scaled must move both. */
  assert.notDeepEqual(closeButtonRect(800, 300), closeButtonRect(800, 120));
  assert.notDeepEqual(closeButtonRect(800, 300), closeButtonRect(640, 300));
});

/* ─── Orders that are still waiting ─────────────────────────────────────── */

const order = (over = {}) => ({
  id: 1, side: 'buy', type: 'limit', size: 1, limitPrice: 90, stopPrice: null, tag: null, ...over,
});

test('an open position’s own stop and target get no line of their own', () => {
  const orders = [
    order({ id: 1, tag: 'stop-loss', type: 'stop', stopPrice: 95, positionId: 7 }),
    order({ id: 2, tag: 'take-profit', limitPrice: 110, positionId: 7 }),
    order({ id: 3, tag: null, limitPrice: 90 }),
  ];

  const drawn = draggableOrders(orders, [{ id: 7 }]);

  assert.deepEqual(drawn.map((o) => o.id), [3], 'the block already draws the other two');
});

test('a leg whose position is gone keeps its line, because nothing else shows it', () => {
  const orders = [order({ id: 1, tag: 'stop-loss', type: 'stop', stopPrice: 95, positionId: 7 })];
  assert.equal(draggableOrders(orders, []).length, 1);
});

test('an order with no price to wait at is not drawn', () => {
  assert.equal(draggableOrders([order({ limitPrice: null })], []).length, 0);
});

test('the nearest order line within reach is the one taken hold of', () => {
  const extent = { left: 100, right: 400 };
  const rows = [{ id: 4, y: 200 }, { id: 9, y: 206 }];

  assert.equal(orderAt({ x: 200, y: 205 }, extent, rows), 9);
  assert.equal(orderAt({ x: 200, y: 201 }, extent, rows), 4);
  assert.equal(orderAt({ x: 200, y: 240 }, extent, rows), null, 'too far from either');
  assert.equal(orderAt({ x: 50, y: 200 }, extent, rows), null, 'left of where the line runs');
});

test('a resting entry may not be dragged to where it is already marketable', () => {
  assert.match(
    orderRefusal(order({ type: 'limit', side: 'buy' }), 105, 100),
    /already marketable/,
  );
  assert.equal(orderRefusal(order({ type: 'limit', side: 'buy' }), 95, 100), null);

  assert.match(
    orderRefusal(order({ type: 'stop', side: 'buy' }), 95, 100),
    /already triggered/,
  );
  assert.equal(orderRefusal(order({ type: 'stop', side: 'buy' }), 105, 100), null);
});

test('a resting entry may not be dragged past its own stop or target', () => {
  const buy = order({ type: 'limit', side: 'buy', bracket: { stopLoss: 88, takeProfit: 120 } });

  assert.match(orderRefusal(buy, 87, 100), /far side of its own stop/);
  assert.match(orderRefusal(buy, 125, 130), /past its own target/);
  assert.equal(orderRefusal(buy, 95, 100), null);

  /* A sell limit rests above the market, so 121 clears the marketable check and
   * is refused for the reason being tested rather than for the other one. */
  const sell = order({ type: 'limit', side: 'sell', bracket: { stopLoss: 120, takeProfit: 80 } });
  assert.match(orderRefusal(sell, 121, 100), /far side of its own stop/);
  assert.equal(orderRefusal(sell, 110, 100), null);
});

test('a price that is not one is refused before anything else is asked', () => {
  assert.match(orderRefusal(order(), NaN, 100), /not a price/);
});
