import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIB_LEVELS, HIT_TOLERANCE, buildFromGesture, distanceToRay, distanceToRectEdge,
  distanceToSegment, fibPrices, gesturePoints, handleAt, hitTest, isInsideRect,
  measureStats, pointsRequired, positionStats,
} from '../src/components/chart/drawings/geometry.js';
import {
  DRAWING_TYPES, ENTRY, STOP, TARGET, createDrawing, moveAnchor, parseDrawing,
  translateDrawing,
} from '../src/components/chart/drawings/model.js';

const SIZE = { width: 800, height: 400 };

/* ─── Distances ─────────────────────────────────────────────────────────── */

test('distance to a segment is measured to the nearest point on it', () => {
  // Horizontal segment from (0,0) to (10,0).
  assert.equal(distanceToSegment(5, 3, 0, 0, 10, 0), 3, 'straight above the middle');
  assert.equal(distanceToSegment(0, 4, 0, 0, 10, 0), 4, 'above an endpoint');
  assert.equal(distanceToSegment(-3, 0, 0, 0, 10, 0), 3, 'beyond the start, along the line');
  assert.equal(distanceToSegment(14, 0, 0, 0, 10, 0), 4, 'beyond the end');
  assert.equal(distanceToSegment(5, 0, 5, 0, 5, 0), 0, 'a degenerate segment is a point');
});

test('a ray extends past its second point but not behind its first', () => {
  // Ray from (0,0) through (10,0), so pointing along +x.
  assert.equal(distanceToRay(100, 0, 0, 0, 10, 0), 0, 'far along the ray is still on it');
  assert.equal(distanceToRay(100, 5, 0, 0, 10, 0), 5);
  assert.equal(distanceToRay(-10, 0, 0, 0, 10, 0), 10, 'behind the anchor it is off the ray');
  // A segment would have said the same point was 10 away too — but at the far
  // end the two must differ.
  assert.equal(distanceToSegment(100, 0, 0, 0, 10, 0), 90);
});

test('rectangle edge distance ignores the interior', () => {
  // Rect corners (0,0)-(10,10); a point in the middle is 5 from the nearest edge.
  assert.equal(distanceToRectEdge(5, 5, 0, 0, 10, 10), 5);
  assert.equal(distanceToRectEdge(5, 0, 0, 0, 10, 10), 0, 'on the top edge');
  assert.equal(distanceToRectEdge(-2, 5, 0, 0, 10, 10), 2, 'just outside the left edge');
  assert.equal(isInsideRect(5, 5, 0, 0, 10, 10), true);
  assert.equal(isInsideRect(11, 5, 0, 0, 10, 10), false);
  assert.equal(isInsideRect(5, 5, 10, 10, 0, 0), true, 'corner order does not matter');
});

/* ─── Hit testing ───────────────────────────────────────────────────────── */

test('a horizontal line is hit anywhere along the chart width', () => {
  const pts = [{ x: 400, y: 100 }];
  assert.equal(hitTest('horizontal', pts, { x: 5, y: 100 }, SIZE), true, 'far left still counts');
  assert.equal(hitTest('horizontal', pts, { x: 790, y: 103 }, SIZE), true, 'within tolerance');
  assert.equal(hitTest('horizontal', pts, { x: 400, y: 120 }, SIZE), false);
});

test('a vertical line is hit anywhere down the chart height', () => {
  const pts = [{ x: 300, y: 200 }];
  assert.equal(hitTest('vertical', pts, { x: 302, y: 10 }, SIZE), true);
  assert.equal(hitTest('vertical', pts, { x: 320, y: 200 }, SIZE), false);
});

test('a trend line is hit only between its ends, a ray beyond them', () => {
  const pts = [{ x: 100, y: 100 }, { x: 200, y: 100 }];
  assert.equal(hitTest('trendline', pts, { x: 150, y: 102 }, SIZE), true);
  assert.equal(hitTest('trendline', pts, { x: 400, y: 100 }, SIZE), false, 'past the end');
  assert.equal(hitTest('ray', pts, { x: 400, y: 100 }, SIZE), true, 'the ray carries on');
  assert.equal(hitTest('ray', pts, { x: 50, y: 100 }, SIZE), false, 'but not backwards');
});

test('a rectangle is hit on its edge and inside it', () => {
  const pts = [{ x: 100, y: 100 }, { x: 200, y: 200 }];
  assert.equal(hitTest('rectangle', pts, { x: 150, y: 150 }, SIZE), true, 'inside');
  assert.equal(hitTest('rectangle', pts, { x: 100, y: 150 }, SIZE), true, 'on the edge');
  assert.equal(hitTest('rectangle', pts, { x: 250, y: 150 }, SIZE), false, 'outside');
});

test('a fib is hit on any of its level lines, within its width', () => {
  // Anchors at y=100 (level 1) and y=200 (level 0), so a level sits at
  // y = 200 - 100 × level: 200, 176.4, 161.8, 150, 138.2, 121.4, 100.
  const pts = [{ x: 100, y: 100 }, { x: 300, y: 200 }];
  assert.equal(hitTest('fib', pts, { x: 200, y: 200 }, SIZE), true, 'the 0% line');
  assert.equal(hitTest('fib', pts, { x: 200, y: 100 }, SIZE), true, 'the 100% line');
  assert.equal(hitTest('fib', pts, { x: 200, y: 150 }, SIZE), true, 'the 50% line');
  assert.equal(hitTest('fib', pts, { x: 200, y: 161 }, SIZE), true, 'near the 38.2% line');

  // y=188 is the widest gap in this ladder: 11.6px below 176.4 and 12px above
  // 200, so it clears the tolerance on both sides.
  assert.equal(hitTest('fib', pts, { x: 200, y: 188 }, SIZE), false, 'between two levels');
  assert.equal(hitTest('fib', pts, { x: 500, y: 150 }, SIZE), false, 'outside the drawn width');
});

test('an unfinished two-point shape is never a hit', () => {
  assert.equal(hitTest('trendline', [{ x: 10, y: 10 }], { x: 10, y: 10 }, SIZE), false);
});

test('hitTest rejects an unknown type instead of silently missing', () => {
  assert.throws(() => hitTest('spiral', [{ x: 0, y: 0 }], { x: 0, y: 0 }, SIZE), /unknown drawing type/);
});

test('handles are found by proximity, nearest first in index order', () => {
  const pts = [{ x: 100, y: 100 }, { x: 300, y: 300 }];
  assert.equal(handleAt(pts, { x: 102, y: 101 }), 0);
  assert.equal(handleAt(pts, { x: 300, y: 296 }), 1);
  assert.equal(handleAt(pts, { x: 200, y: 200 }), -1, 'the middle is not a handle');
});

/* ─── Fib and measure ───────────────────────────────────────────────────── */

test('fib level 0 sits at the second anchor and level 1 at the first', () => {
  // Dragged from 100 up to 200: 0% is where the move ended.
  const levels = fibPrices(100, 200);
  const at = (l) => levels.find((x) => x.level === l).price;

  assert.equal(at(0), 200, '0% marks the end of the move');
  assert.equal(at(1), 100, '100% marks its start');
  assert.equal(at(0.5), 150);
  assert.ok(Math.abs(at(0.618) - (200 - 100 * 0.618)) < 1e-9);
  assert.equal(levels.length, FIB_LEVELS.length);
});

test('fib works the same on a downward move', () => {
  const levels = fibPrices(200, 100);
  assert.equal(levels.find((x) => x.level === 0).price, 100);
  assert.equal(levels.find((x) => x.level === 1).price, 200);
  assert.equal(levels.find((x) => x.level === 0.5).price, 150);
});

test('measure reports change, percent and bars', () => {
  const up = measureStats(100, 110, 24);
  assert.equal(up.change, 10);
  assert.equal(up.percent, 10);
  assert.equal(up.bars, 24);
  assert.equal(up.direction, 'up');

  const down = measureStats(100, 90, 5);
  assert.equal(down.change, -10);
  assert.equal(down.percent, -10);
  assert.equal(down.direction, 'down');
});

test('measure from a price of zero reports no percentage rather than Infinity', () => {
  assert.equal(measureStats(0, 50, 3).percent, null);
});

/* ─── Position tools ────────────────────────────────────────────────────── */

test('a long drag places the target at twice the risk above the entry', () => {
  // Dragged from entry 100 down to stop 90: risk 10, so the target starts at 120.
  const pts = buildFromGesture('long', { time: 0, price: 100 }, { time: 5, price: 90 });

  assert.equal(pts.length, 3);
  assert.deepEqual(pts[ENTRY], { time: 0, price: 100 });
  assert.deepEqual(pts[STOP], { time: 5, price: 90 });
  assert.equal(pts[TARGET].price, 120, `2 × 10 above the entry, got ${pts[TARGET].price}`);
  assert.equal(pts[TARGET].time, 5, 'the target shares the right edge with the stop');
});

test('a short drag mirrors it: stop above, target below', () => {
  // Entry 100, stop dragged up to 110: risk 10, target at 80.
  const pts = buildFromGesture('short', { time: 0, price: 100 }, { time: 5, price: 110 });

  assert.equal(pts[STOP].price, 110);
  assert.equal(pts[TARGET].price, 80, `2 × 10 below the entry, got ${pts[TARGET].price}`);
});

test('tools other than positions store exactly what was dragged', () => {
  const a = { time: 0, price: 10 };
  const b = { time: 5, price: 20 };
  assert.deepEqual(buildFromGesture('trendline', a, b), [a, b]);
  assert.deepEqual(buildFromGesture('horizontal', a, b), [a], 'a one-point tool ignores the end');
  assert.equal(gesturePoints('long'), 2, 'a position is dragged with two points');
  assert.equal(pointsRequired('long'), 3, 'but stored with three');
});

test('position stats report risk, reward and R:R', () => {
  const s = positionStats(100, 90, 120);
  assert.equal(s.risk, 10);
  assert.equal(s.reward, 20);
  assert.equal(s.rr, 2);
  assert.equal(s.riskPercent, 10);
  assert.equal(s.rewardPercent, 20);
});

test('a short reads the same way round as a long', () => {
  // Stop above and target below must give the same positive distances.
  const long = positionStats(100, 90, 120);
  const short = positionStats(100, 110, 80);
  assert.equal(short.risk, long.risk);
  assert.equal(short.reward, long.reward);
  assert.equal(short.rr, long.rr);
});

test('a stop at the entry reports no R:R rather than infinity', () => {
  const s = positionStats(100, 100, 120);
  assert.equal(s.risk, 0);
  assert.equal(s.rr, null, 'dividing by no risk would invent a number');
});

test('a position block is grabbable anywhere inside it', () => {
  // entry y=200, stop y=250, target y=100, spanning x 100..300.
  const pts = [{ x: 100, y: 200 }, { x: 300, y: 250 }, { x: 300, y: 100 }];
  assert.equal(hitTest('long', pts, { x: 200, y: 150 }, SIZE), true, 'in the reward zone');
  assert.equal(hitTest('long', pts, { x: 200, y: 230 }, SIZE), true, 'in the risk zone');
  assert.equal(hitTest('long', pts, { x: 200, y: 200 }, SIZE), true, 'on the entry line');
  assert.equal(hitTest('long', pts, { x: 400, y: 200 }, SIZE), false, 'right of the block');
  assert.equal(hitTest('long', pts, { x: 200, y: 60 }, SIZE), false, 'above the target');
  assert.equal(hitTest('short', pts, { x: 200, y: 150 }, SIZE), true, 'same test for a short');
});

test('an unfinished position block is not a hit', () => {
  assert.equal(hitTest('long', [{ x: 0, y: 0 }, { x: 10, y: 10 }], { x: 5, y: 5 }, SIZE), false);
});

test('dragging the stop or target moves the shared right edge, not just one', () => {
  // Both sit on the right edge; moving one alone would tear the block in half.
  const d = createDrawing('long', [
    { time: 0, price: 100 },
    { time: 500, price: 90 },
    { time: 500, price: 120 },
  ]);

  const stopMoved = moveAnchor(d, STOP, 800, 85);
  assert.equal(stopMoved.points[STOP].price, 85);
  assert.equal(stopMoved.points[STOP].time, 800);
  assert.equal(stopMoved.points[TARGET].time, 800, 'the target followed the edge');
  assert.equal(stopMoved.points[TARGET].price, 120, 'but kept its own price');
  assert.equal(stopMoved.points[ENTRY].time, 0, 'the left edge is untouched');

  const targetMoved = moveAnchor(d, TARGET, 900, 130);
  assert.equal(targetMoved.points[STOP].time, 900);
  assert.equal(targetMoved.points[STOP].price, 90);
});

test('dragging the entry leaves the right edge alone', () => {
  const d = createDrawing('long', [
    { time: 0, price: 100 },
    { time: 500, price: 90 },
    { time: 500, price: 120 },
  ]);
  const moved = moveAnchor(d, ENTRY, 200, 105);

  assert.deepEqual(moved.points[ENTRY], { time: 200, price: 105 });
  assert.equal(moved.points[STOP].time, 500, 'the right edge stayed');
  assert.equal(moved.points[TARGET].time, 500);
});

test('a position survives create → parse with all three anchors', () => {
  const original = createDrawing('short', [
    { time: 1000, price: 50 },
    { time: 2000, price: 55 },
    { time: 2000, price: 40 },
  ], { color: 'ind-4' });
  const back = parseDrawing(JSON.parse(JSON.stringify(original)));

  assert.equal(back.type, 'short');
  assert.equal(back.points.length, 3);
  assert.deepEqual(back.points, original.points);
});

test('a position with the wrong number of anchors is refused', () => {
  assert.throws(() => createDrawing('long', [
    { time: 0, price: 1 }, { time: 1, price: 2 },
  ]), /needs exactly 3/);
  assert.equal(parseDrawing({
    type: 'long', points: [{ time: 0, price: 1 }, { time: 1, price: 2 }],
  }), null);
});

/* ─── Model ─────────────────────────────────────────────────────────────── */

test('every drawing type declares how many points it needs', () => {
  for (const type of DRAWING_TYPES) {
    const stored = pointsRequired(type);
    const dragged = gesturePoints(type);
    assert.ok(stored >= 1 && stored <= 3, `${type} stores ${stored} points`);
    assert.ok(dragged === 1 || dragged === 2, `${type} is dragged with ${dragged} points`);
    // A drag must produce exactly what the type stores, or nothing can be built.
    assert.equal(
      buildFromGesture(type, { time: 0, price: 10 }, { time: 1, price: 5 }).length,
      stored,
      `${type}: the drag must yield ${stored} anchors`,
    );
  }
  assert.throws(() => pointsRequired('spiral'), /unknown drawing type/);
});

test('createDrawing validates its type and its points', () => {
  const ok = createDrawing('trendline', [
    { time: 1, price: 10 }, { time: 2, price: 20 },
  ]);
  assert.equal(ok.type, 'trendline');
  assert.equal(ok.points.length, 2);
  assert.equal(ok.color, 'ind-1', 'a default colour is applied');
  assert.ok(ok.id);

  assert.throws(() => createDrawing('spiral', []), /unknown type/);
  assert.throws(() => createDrawing('trendline', [{ time: 1, price: 1 }]), /needs exactly 2/);
  assert.throws(() => createDrawing('horizontal', [{ time: 1 }]), /finite time and price/);
  assert.throws(() => createDrawing('horizontal', [{ time: NaN, price: 1 }]), /finite time and price/);
});

test('ids are unique even for drawings made in the same millisecond', () => {
  const a = createDrawing('horizontal', [{ time: 1, price: 1 }]);
  const b = createDrawing('horizontal', [{ time: 1, price: 1 }]);
  assert.notEqual(a.id, b.id);
});

test('parseDrawing rejects a malformed entry without throwing', () => {
  // One bad drawing in a file must cost only itself.
  assert.equal(parseDrawing(null), null);
  assert.equal(parseDrawing({ type: 'spiral', points: [] }), null);
  assert.equal(parseDrawing({ type: 'trendline', points: [{ time: 1, price: 1 }] }), null,
    'wrong point count');
  assert.equal(parseDrawing({ type: 'horizontal', points: [{ time: 'x', price: 1 }] }), null);
  assert.equal(parseDrawing({ type: 'horizontal' }), null, 'no points at all');

  const good = parseDrawing({
    id: 'keep-me', type: 'horizontal', points: [{ time: 5, price: 50 }], color: 'ind-3',
  });
  assert.equal(good.id, 'keep-me', 'an existing id survives a round trip');
  assert.equal(good.color, 'ind-3');
});

test('a stored drawing survives create → parse unchanged', () => {
  const original = createDrawing('rectangle', [
    { time: 1000, price: 50 }, { time: 2000, price: 60 },
  ], { color: 'ind-2' });
  const roundTripped = parseDrawing(JSON.parse(JSON.stringify(original)));

  assert.deepEqual(roundTripped.points, original.points);
  assert.equal(roundTripped.id, original.id);
  assert.equal(roundTripped.color, 'ind-2');
});

test('translating moves every anchor by the same delta', () => {
  const d = createDrawing('trendline', [
    { time: 1000, price: 10 }, { time: 2000, price: 20 },
  ]);
  const moved = translateDrawing(d, 500, -3);

  assert.deepEqual(moved.points, [
    { time: 1500, price: 7 },
    { time: 2500, price: 17 },
  ]);
  assert.deepEqual(d.points[0], { time: 1000, price: 10 }, 'the original is untouched');
});

test('moving one anchor leaves the other alone', () => {
  const d = createDrawing('trendline', [
    { time: 1000, price: 10 }, { time: 2000, price: 20 },
  ]);
  const edited = moveAnchor(d, 1, 3000, 30);

  assert.deepEqual(edited.points[0], { time: 1000, price: 10 });
  assert.deepEqual(edited.points[1], { time: 3000, price: 30 });
  assert.throws(() => moveAnchor(d, 5, 0, 0), /out of range/);
});
