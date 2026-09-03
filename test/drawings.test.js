import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIB_LEVELS, HIT_TOLERANCE, distanceToRay, distanceToRectEdge,
  distanceToSegment, fibPrices, handleAt, isInsideRect,
  measureStats, positionDirection, positionStats, snapAxis, snapToAxis,
} from '../src/components/chart/drawings/geometry.js';
import {
  DEFAULT_LINE_STYLE, DEFAULT_POSITION_STYLE, DEFAULT_TEXT_STYLE, ENTRY, FVG_COLORS,
  LEGACY_POSITION_TYPES, LINE_STYLES, LINE_WIDTHS, MAX_FILL_OPACITY, MAX_TEXT_LENGTH,
  STOP, TARGET, ZONE_COLORS, dashPattern, normalizeOpacity, normalizeWidth,
} from '../src/components/chart/drawings/model.js';
/* The four dispatchers moved out of geometry.js when the tool set outgrew a
 * switch statement: which shape needs how many anchors is per tool, and there
 * are eighty-six of them. geometry.js is the maths they are built out of. */
import {
  DRAWING_TYPES, buildFromGesture, gesturePoints, hitTest, isScreenSpace, isVariable,
  pointsRequired, specFor,
} from '../src/components/chart/drawings/registry.js';
import {
  createDrawing, moveAnchor, parseDrawing, translateDrawing,
} from '../src/components/chart/drawings/factory.js';

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
  const pts = buildFromGesture('position', { time: 0, price: 100 }, { time: 5, price: 90 });

  assert.equal(pts.length, 3);
  assert.deepEqual(pts[ENTRY], { time: 0, price: 100 });
  assert.deepEqual(pts[STOP], { time: 5, price: 90 });
  assert.equal(pts[TARGET].price, 120, `2 × 10 above the entry, got ${pts[TARGET].price}`);
  assert.equal(pts[TARGET].time, 5, 'the target shares the right edge with the stop');
});

test('a short drag mirrors it: stop above, target below', () => {
  // Entry 100, stop dragged up to 110: risk 10, target at 80.
  const pts = buildFromGesture('position', { time: 0, price: 100 }, { time: 5, price: 110 });

  assert.equal(pts[STOP].price, 110);
  assert.equal(pts[TARGET].price, 80, `2 × 10 below the entry, got ${pts[TARGET].price}`);
});

test('tools other than positions store exactly what was dragged', () => {
  const a = { time: 0, price: 10 };
  const b = { time: 5, price: 20 };
  assert.deepEqual(buildFromGesture('trendline', a, b), [a, b]);
  assert.deepEqual(buildFromGesture('horizontal', a, b), [a], 'a one-point tool ignores the end');
  assert.equal(gesturePoints('position'), 2, 'a position is dragged with two points');
  assert.equal(pointsRequired('position'), 3, 'but stored with three');
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
  assert.equal(hitTest('position', pts, { x: 200, y: 150 }, SIZE), true, 'in the reward zone');
  assert.equal(hitTest('position', pts, { x: 200, y: 230 }, SIZE), true, 'in the risk zone');
  assert.equal(hitTest('position', pts, { x: 200, y: 200 }, SIZE), true, 'on the entry line');
  assert.equal(hitTest('position', pts, { x: 400, y: 200 }, SIZE), false, 'right of the block');
  assert.equal(hitTest('position', pts, { x: 200, y: 60 }, SIZE), false, 'above the target');
  assert.equal(hitTest('position', pts, { x: 200, y: 150 }, SIZE), true, 'the same block either way round');
});

test('an unfinished position block is not a hit', () => {
  assert.equal(hitTest('position', [{ x: 0, y: 0 }, { x: 10, y: 10 }], { x: 5, y: 5 }, SIZE), false);
});

test('dragging the stop or target moves the shared right edge, not just one', () => {
  // Both sit on the right edge; moving one alone would tear the block in half.
  const d = createDrawing('position', [
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
  const d = createDrawing('position', [
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
  const original = createDrawing('position', [
    { time: 1000, price: 50 },
    { time: 2000, price: 55 },
    { time: 2000, price: 40 },
  ], { color: 'ind-4' });
  const back = parseDrawing(JSON.parse(JSON.stringify(original)));

  assert.equal(back.type, 'position');
  assert.equal(back.points.length, 3);
  assert.deepEqual(back.points, original.points);
});

test('a position with the wrong number of anchors is refused', () => {
  assert.throws(() => createDrawing('position', [
    { time: 0, price: 1 }, { time: 1, price: 2 },
  ]), /needs exactly 3/);
  assert.equal(parseDrawing({
    type: 'position', points: [{ time: 0, price: 1 }, { time: 1, price: 2 }],
  }), null);
});

/* ─── Direction follows the anchors ─────────────────────────────────────── */

test('direction comes from where the target sits, not from a stored flag', () => {
  // Target above the entry is a long, below it a short — whichever way the
  // block was originally drawn.
  assert.equal(positionDirection(100, 90, 120), 'long');
  assert.equal(positionDirection(100, 110, 80), 'short');
});

test('dragging the target across the entry flips the direction', () => {
  // This is the whole point of merging the two tools: the same block reads as
  // a long or a short depending only on where its anchors are.
  const long = createDrawing('position', [
    { time: 0, price: 100 }, { time: 5, price: 90 }, { time: 5, price: 120 },
  ]);
  assert.equal(positionDirection(
    long.points[ENTRY].price, long.points[STOP].price, long.points[TARGET].price,
  ), 'long');

  const flipped = moveAnchor(long, TARGET, 5, 80);
  assert.equal(positionDirection(
    flipped.points[ENTRY].price, flipped.points[STOP].price, flipped.points[TARGET].price,
  ), 'short', 'the label has to follow the picture');
});

test('a target level with the entry falls back to the stop', () => {
  assert.equal(positionDirection(100, 90, 100), 'long', 'stop below means long');
  assert.equal(positionDirection(100, 110, 100), 'short', 'stop above means short');
});

test('a block with all three prices equal has no direction', () => {
  assert.equal(positionDirection(100, 100, 100), null);
});

/* ─── Migration from the separate long/short tools ──────────────────────── */

test('a long or short saved before the merge loads as a position', () => {
  for (const legacy of LEGACY_POSITION_TYPES) {
    const back = parseDrawing({
      id: `old-${legacy}`,
      type: legacy,
      points: [{ time: 0, price: 100 }, { time: 5, price: 90 }, { time: 5, price: 120 }],
      color: 'ind-2',
    });
    assert.ok(back, `${legacy} must still load`);
    assert.equal(back.type, 'position', `${legacy} becomes a position`);
    assert.equal(back.id, `old-${legacy}`, 'and keeps its identity');
    assert.equal(back.points.length, 3);
    assert.equal(back.profitColor, DEFAULT_POSITION_STYLE.profitColor,
      'styling defaults are filled in');
  }
});

test('a migrated short keeps reading as a short', () => {
  // Entry 100, stop 110, target 80 — drawn with the old short tool. After
  // migration its direction has to come out the same way.
  const back = parseDrawing({
    type: 'short',
    points: [{ time: 0, price: 100 }, { time: 5, price: 110 }, { time: 5, price: 80 }],
  });
  assert.equal(positionDirection(
    back.points[ENTRY].price, back.points[STOP].price, back.points[TARGET].price,
  ), 'short');
});

test('the legacy names cannot be drawn any more, only loaded', () => {
  for (const legacy of LEGACY_POSITION_TYPES) {
    assert.equal(DRAWING_TYPES.includes(legacy), false, `${legacy} is not an offered tool`);
    assert.throws(() => createDrawing(legacy, [
      { time: 0, price: 100 }, { time: 5, price: 90 }, { time: 5, price: 120 },
    ]), /unknown type/);
  }
  assert.ok(DRAWING_TYPES.includes('position'));
});

/* ─── Position styling ──────────────────────────────────────────────────── */

test('a position block carries its own zone colours and opacity', () => {
  const d = createDrawing('position', [
    { time: 0, price: 100 }, { time: 5, price: 90 }, { time: 5, price: 120 },
  ]);
  assert.equal(d.profitColor, DEFAULT_POSITION_STYLE.profitColor);
  assert.equal(d.lossColor, DEFAULT_POSITION_STYLE.lossColor);
  assert.equal(d.fillOpacity, DEFAULT_POSITION_STYLE.fillOpacity);

  const styled = createDrawing('position', [
    { time: 0, price: 100 }, { time: 5, price: 110 }, { time: 5, price: 80 },
  ], { profitColor: 'ind-2', lossColor: 'ind-4', fillOpacity: 0.35 });
  assert.equal(styled.profitColor, 'ind-2');
  assert.equal(styled.lossColor, 'ind-4');
  assert.equal(styled.fillOpacity, 0.35);
});

test('other drawing types do not carry dead styling fields', () => {
  const line = createDrawing('trendline', [
    { time: 0, price: 1 }, { time: 1, price: 2 },
  ]);
  assert.equal('profitColor' in line, false);
  assert.equal('fillOpacity' in line, false);
});

test('opacity is clamped into a usable range', () => {
  assert.equal(normalizeOpacity(0.25), 0.25);
  assert.equal(normalizeOpacity(0), 0, 'fully transparent is a legitimate choice');
  assert.equal(normalizeOpacity(-1), 0);
  assert.equal(normalizeOpacity(5), MAX_FILL_OPACITY, 'an opaque zone would hide the candles');
  // Anything unusable falls back rather than producing an invisible or solid block.
  assert.equal(normalizeOpacity(NaN), DEFAULT_POSITION_STYLE.fillOpacity);
  assert.equal(normalizeOpacity(undefined), DEFAULT_POSITION_STYLE.fillOpacity);
  assert.equal(normalizeOpacity('0.3'), DEFAULT_POSITION_STYLE.fillOpacity, 'a string is not a number');
});

test('styling survives storage, and a block saved before it existed still loads', () => {
  const original = createDrawing('position', [
    { time: 0, price: 100 }, { time: 5, price: 90 }, { time: 5, price: 120 },
  ], { profitColor: 'accent', lossColor: 'ind-3', fillOpacity: 0.4 });
  const back = parseDrawing(JSON.parse(JSON.stringify(original)));
  assert.equal(back.profitColor, 'accent');
  assert.equal(back.lossColor, 'ind-3');
  assert.equal(back.fillOpacity, 0.4);

  // A block written before these fields existed.
  const old = parseDrawing({
    type: 'position',
    points: [{ time: 0, price: 100 }, { time: 5, price: 90 }, { time: 5, price: 120 }],
  });
  assert.equal(old.profitColor, DEFAULT_POSITION_STYLE.profitColor);
  assert.equal(old.fillOpacity, DEFAULT_POSITION_STYLE.fillOpacity);

  // And one written with nonsense in those fields.
  const broken = parseDrawing({
    type: 'position',
    points: [{ time: 0, price: 100 }, { time: 5, price: 90 }, { time: 5, price: 120 }],
    profitColor: 42,
    fillOpacity: 'very',
  });
  assert.equal(broken.profitColor, DEFAULT_POSITION_STYLE.profitColor);
  assert.equal(broken.fillOpacity, DEFAULT_POSITION_STYLE.fillOpacity);
});

test('every offered zone colour is a token name, not a raw colour', () => {
  // The renderer resolves these through CSS custom properties, so a literal
  // hex here would silently fall back to the accent.
  for (const c of ZONE_COLORS) {
    assert.match(c.id, /^[a-z0-9-]+$/, `${c.id} must be a token name`);
    assert.ok(c.label, `${c.id} needs a label`);
  }
  assert.ok(ZONE_COLORS.some((c) => c.id === DEFAULT_POSITION_STYLE.profitColor));
  assert.ok(ZONE_COLORS.some((c) => c.id === DEFAULT_POSITION_STYLE.lossColor));
});

/* ─── Model ─────────────────────────────────────────────────────────────── */

test('every drawing type declares how many points it needs', () => {
  for (const type of DRAWING_TYPES) {
    const stored = pointsRequired(type);
    const collected = gesturePoints(type);
    assert.ok(Number.isInteger(stored) && stored >= 0, `${type} stores ${stored} points`);
    assert.ok(Number.isInteger(collected) && collected >= 1,
      `${type} is placed with ${collected} points`);

    /* A gesture that collects one or two points has to hand build() exactly
     * what the type stores, or nothing can be made from it. The multi-click and
     * open-ended tools collect their anchors one at a time and never go through
     * build(), so there is nothing to check there. */
    const spec = specFor(type);
    if (spec.gesture === 'click' || spec.gesture === 'drag') {
      assert.equal(
        buildFromGesture(type, { time: 0, price: 10 }, { time: 1, price: 5 }).length,
        stored,
        `${type}: the gesture must yield ${stored} anchors`,
      );
    }
  }
  assert.throws(() => pointsRequired('unicorn'), /unknown drawing type/);
});

test('a pane-anchored tool stores no market coordinates at all', () => {
  // An anchored note is a caption on the chart, not on a bar: its anchor is a
  // fraction of the pane, so it has no time and no price to store.
  assert.equal(pointsRequired('anchoredtext'), 0);
  assert.equal(isScreenSpace('anchoredtext'), true);
  assert.equal(isScreenSpace('text'), false, 'plain text is pinned to a bar');

  const note = createDrawing('anchoredtext', [], { screen: { x: 0.25, y: 0.5 }, text: 'hi' });
  assert.deepEqual(note.screen, { x: 0.25, y: 0.5 });
  assert.deepEqual(note.points, []);
  assert.throws(() => createDrawing('anchoredtext', [], {}), /screen anchor/);
  assert.throws(
    () => createDrawing('anchoredtext', [{ time: 1, price: 1 }], { screen: { x: 0, y: 0 } }),
    /takes no points/,
  );
});

test('a variable-length tool accepts any count at or above its minimum', () => {
  assert.equal(isVariable('polyline'), true);
  assert.equal(isVariable('trendline'), false);

  const at = (n) => ({ time: n, price: n });
  const three = createDrawing('polyline', [at(1), at(2), at(3)]);
  assert.equal(three.points.length, 3);
  const many = createDrawing('brush', [at(1), at(2), at(3), at(4), at(5)]);
  assert.equal(many.points.length, 5);

  assert.throws(() => createDrawing('polyline', [at(1)]), /at least 2/);
  // And the same rule on the way back in, so a truncated file loses the one
  // drawing rather than drawing a line to nowhere.
  assert.equal(parseDrawing({ type: 'polyline', points: [{ time: 1, price: 1 }] }), null);
  assert.equal(parseDrawing({ ...three, id: 'x' })?.points.length, 3);
});

test('locked is stored, and defaults to unlocked on a file that never had it', () => {
  const level = createDrawing('horizontal', [{ time: 1, price: 10 }]);
  assert.equal(level.locked, false, 'nothing is born locked');

  const locked = parseDrawing({ ...level, locked: true });
  assert.equal(locked.locked, true);
  // Anything but an explicit true is unlocked: a drawing nobody locked must
  // never come back stuck.
  assert.equal(parseDrawing({ ...level, locked: 'yes' }).locked, false);
  const { locked: _absent, ...withoutField } = level;
  assert.equal(parseDrawing(withoutField).locked, false);
});

test('an annotation carries its words and its setting, and nothing else does', () => {
  const note = createDrawing('text', [{ time: 1, price: 10 }],
    { text: 'support here', fontSize: 'lg', bold: true });
  assert.equal(note.text, 'support here');
  assert.equal(note.fontSize, 'lg');
  assert.equal(note.bold, true);
  assert.equal(note.italic, false);

  const line = createDrawing('trendline', [{ time: 1, price: 1 }, { time: 2, price: 2 }]);
  assert.equal('text' in line, false, 'a trend line has nothing to say');
  assert.equal('fontSize' in line, false);

  // An unknown size falls back rather than costing the annotation.
  assert.equal(createDrawing('text', [{ time: 1, price: 1 }], { fontSize: 'huge' }).fontSize,
    DEFAULT_TEXT_STYLE.fontSize);

  const loaded = parseDrawing({ ...note, text: 'a\r\nb' });
  assert.equal(loaded.text, 'a\nb', 'carriage returns are dropped');
  assert.equal(parseDrawing({ ...note, text: 'x'.repeat(MAX_TEXT_LENGTH + 50) }).text.length,
    MAX_TEXT_LENGTH);
  // An empty annotation is not corrupt — it is one whose editor was dismissed.
  assert.equal(parseDrawing({ ...note, text: undefined })?.text, '');
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

/* ─── Axis snapping ─────────────────────────────────────────────────────── */

test('the snap axis follows the longer pixel delta', () => {
  assert.equal(snapAxis(40, 10), 'horizontal');
  assert.equal(snapAxis(10, 40), 'vertical');
  // Direction does not matter, only distance.
  assert.equal(snapAxis(-40, 10), 'horizontal');
  assert.equal(snapAxis(10, -40), 'vertical');
  assert.equal(snapAxis(-5, -40), 'vertical');
});

test('a drag with no direction yet locks horizontal', () => {
  /* One of the two has to be picked before the pointer has committed, and a
   * line is the more useful guess than a zero-length vertical. */
  assert.equal(snapAxis(0, 0), 'horizontal');
  // A tie goes the same way.
  assert.equal(snapAxis(20, 20), 'horizontal');
});

test('snapping horizontal keeps the anchor price and lets time run', () => {
  const anchor = { time: 1000, price: 50 };
  const point = { time: 5000, price: 80 };

  const snapped = snapToAxis(anchor, point, 'horizontal');
  assert.equal(snapped.price, 50, 'price is pinned to the anchor');
  assert.equal(snapped.time, 5000, 'time still follows the pointer');
});

test('snapping vertical keeps the anchor time and lets price run', () => {
  const anchor = { time: 1000, price: 50 };
  const point = { time: 5000, price: 80 };

  const snapped = snapToAxis(anchor, point, 'vertical');
  assert.equal(snapped.time, 1000);
  assert.equal(snapped.price, 80);
});

test('a snapped trend line has zero extent on the locked axis', () => {
  /* What the feature is actually for: the two anchors end up level, so the
   * line the renderer draws is exactly horizontal. */
  const start = { time: 1000, price: 50 };
  const end = snapToAxis(start, { time: 9000, price: 80 }, 'horizontal');
  const [a, b] = buildFromGesture('trendline', start, end);

  assert.equal(a.price, b.price, 'the line is level');
  assert.notEqual(a.time, b.time, 'and still has length');
});

test('snapping never invents coordinates of its own', () => {
  // Every value out is one of the two values in — nothing is averaged.
  const anchor = { time: 111, price: 22 };
  const point = { time: 999, price: 88 };

  for (const axis of ['horizontal', 'vertical']) {
    const snapped = snapToAxis(anchor, point, axis);
    assert.ok([anchor.time, point.time].includes(snapped.time));
    assert.ok([anchor.price, point.price].includes(snapped.price));
  }
});

/* ─── Stroke styling ────────────────────────────────────────────────────── */

test('a drawing carries the width and dash it was created with', () => {
  const d = createDrawing('trendline', [{ time: 1, price: 1 }, { time: 2, price: 2 }], {
    color: 'ind-2', width: 3, lineStyle: 'dashed',
  });
  assert.equal(d.color, 'ind-2');
  assert.equal(d.width, 3);
  assert.equal(d.lineStyle, 'dashed');
});

test('a drawing made without stroke options gets the defaults', () => {
  const d = createDrawing('ray', [{ time: 1, price: 1 }, { time: 2, price: 2 }]);
  assert.equal(d.width, DEFAULT_LINE_STYLE.width);
  assert.equal(d.lineStyle, DEFAULT_LINE_STYLE.lineStyle);
});

test('an unusable width falls back rather than reaching the canvas', () => {
  /* A width of 0 draws nothing and a negative one throws in some engines, so
   * neither may survive a round trip from disk. */
  for (const bad of [0, -2, 99, NaN, Infinity, null, undefined, 'thick']) {
    assert.equal(normalizeWidth(bad), DEFAULT_LINE_STYLE.width, `width ${bad}`);
  }
  /* A width the bar does not offer still came from somewhere — an older scale,
   * a hand-edited file — so it lands on the nearest one rather than falling back
   * to a hairline. A tie goes to the thinner of the two. */
  assert.equal(normalizeWidth(1.4), 1.5);
  assert.equal(normalizeWidth(2.6), 3);
  assert.equal(normalizeWidth(2.5), 2, 'exactly between 2 and 3');
  // The scale used to run to 4, and a chart full of drawings predates it.
  assert.equal(normalizeWidth(4), 3, 'the old thickest becomes the new thickest');
  // Everything the bar offers survives untouched.
  for (const w of LINE_WIDTHS) assert.equal(normalizeWidth(w), w);
});

test('an unknown dash draws solid rather than not at all', () => {
  assert.deepEqual(dashPattern('solid'), []);
  assert.deepEqual(dashPattern('nonsense'), []);
  assert.deepEqual(dashPattern(undefined), []);
  // The real patterns are non-empty, or they would not be dashes.
  for (const style of LINE_STYLES.filter((x) => x.id !== 'solid')) {
    assert.ok(dashPattern(style.id).length > 0, `${style.id} has no pattern`);
  }
});

test('stroke settings survive create → parse', () => {
  const made = createDrawing('rectangle', [{ time: 1, price: 1 }, { time: 9, price: 9 }], {
    color: 'ind-3', width: 1.5, lineStyle: 'dotted',
  });
  const back = parseDrawing(JSON.parse(JSON.stringify(made)));

  assert.equal(back.width, 1.5, 'a half-pixel width survives the round trip');
  assert.equal(back.lineStyle, 'dotted');
  assert.equal(back.color, 'ind-3');
});

test('a drawing saved before these fields existed still loads', () => {
  /* The whole point of the fallbacks: an old file has no lineStyle and may
   * have no width, and neither may cost the drawing. */
  const old = { type: 'trendline', points: [{ time: 1, price: 1 }, { time: 2, price: 2 }] };
  const parsed = parseDrawing(old);

  assert.ok(parsed, 'an old drawing must still load');
  assert.equal(parsed.width, DEFAULT_LINE_STYLE.width);
  assert.equal(parsed.lineStyle, DEFAULT_LINE_STYLE.lineStyle);
});

test('a corrupt stroke setting costs the setting, not the drawing', () => {
  const parsed = parseDrawing({
    type: 'ray',
    points: [{ time: 1, price: 1 }, { time: 2, price: 2 }],
    width: 'very',
    lineStyle: 'zigzag',
  });

  assert.ok(parsed);
  assert.equal(parsed.width, DEFAULT_LINE_STYLE.width);
  assert.equal(parsed.lineStyle, DEFAULT_LINE_STYLE.lineStyle);
});

test('every width and style the bar offers is one the model accepts', () => {
  // The bar builds its buttons from these lists, so a mismatch would ship a
  // control that silently does nothing.
  for (const w of LINE_WIDTHS) {
    const d = createDrawing('trendline', [{ time: 1, price: 1 }, { time: 2, price: 2 }], { width: w });
    assert.equal(d.width, w);
  }
  for (const style of LINE_STYLES) {
    const d = createDrawing('trendline', [{ time: 1, price: 1 }, { time: 2, price: 2 }], {
      lineStyle: style.id,
    });
    assert.equal(d.lineStyle, style.id);
  }
});

/* ─── Fair value gap tool ───────────────────────────────────────────────── */

test('a gap is picked with one click but stored as a box', () => {
  // The only type where the gesture collects fewer points than the drawing
  // keeps: the bars supply the second anchor, not the pointer.
  assert.equal(gesturePoints('fvg'), 1);
  assert.equal(pointsRequired('fvg'), 2);
});

test('a gap box is grabbed anywhere over its area', () => {
  const pts = [{ x: 100, y: 100 }, { x: 300, y: 130 }];
  assert.equal(hitTest('fvg', pts, { x: 200, y: 115 }, SIZE), true, 'inside');
  assert.equal(hitTest('fvg', pts, { x: 100, y: 103 }, SIZE), true, 'on an edge');
  assert.equal(hitTest('fvg', pts, { x: 200, y: 160 }, SIZE), false, 'below it');
  assert.equal(hitTest('fvg', pts, { x: 400, y: 115 }, SIZE), false, 'past its right edge');
});

test('a gap carries the one fact its anchors cannot supply', () => {
  const bull = createDrawing('fvg', [
    { time: 1, price: 110 }, { time: 5, price: 100 },
  ], { direction: 'bull', color: FVG_COLORS.bull });

  assert.equal(bull.direction, 'bull');
  assert.equal(bull.color, 'candle-up-brd', 'coloured by direction, not by the toolbar');

  // A box knows two prices; which way the imbalance ran is not among them, so
  // it cannot be guessed at creation time either.
  assert.throws(() => createDrawing('fvg', [
    { time: 1, price: 110 }, { time: 5, price: 100 },
  ]), /needs a direction/);
  assert.throws(() => createDrawing('fvg', [
    { time: 1, price: 110 }, { time: 5, price: 100 },
  ], { direction: 'sideways' }), /needs a direction/);
});

test('only a gap carries a direction', () => {
  const rect = createDrawing('rectangle', [
    { time: 1, price: 110 }, { time: 5, price: 100 },
  ]);
  assert.equal('direction' in rect, false);
});

test('a stored gap survives create → parse, and a directionless one is dropped', () => {
  const made = createDrawing('fvg', [
    { time: 1, price: 110 }, { time: 5, price: 100 },
  ], { direction: 'bear', color: FVG_COLORS.bear });
  const back = parseDrawing(JSON.parse(JSON.stringify(made)));
  assert.deepEqual(back, made);

  // Content, not decoration: a gap that cannot say which way it ran is lost
  // rather than quietly turned into a bullish one.
  assert.equal(parseDrawing({
    type: 'fvg', points: [{ time: 1, price: 110 }, { time: 5, price: 100 }],
  }), null);
  assert.equal(parseDrawing({
    type: 'fvg',
    points: [{ time: 1, price: 110 }, { time: 5, price: 100 }],
    direction: 'up',
  }), null);
});

test('the gap colours are token names, not raw colours', () => {
  for (const [direction, token] of Object.entries(FVG_COLORS)) {
    assert.match(token, /^[a-z0-9-]+$/, `${direction} must name a CSS token`);
  }
});
