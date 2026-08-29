/* Drawing geometry — pure maths on screen coordinates.
 *
 * Everything here works in pixels, after time and price have been converted by
 * the chart. That is deliberate: a hit tolerance is a pixel quantity ("within
 * six pixels of the line"), not a price one. Six dollars is a hit on a penny
 * stock and a miss on Bitcoin.
 *
 * No DOM, no chart API — so all of it is testable in plain Node.
 */

/** Pixels within which a click counts as landing on a drawing. */
export const HIT_TOLERANCE = 6;
/** Pixels within which a click grabs a handle rather than the shape. */
export const HANDLE_TOLERANCE = 8;
export const HANDLE_RADIUS = 4;

/** Shortest distance from a point to a finite line segment. */
export function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) return Math.hypot(px - x1, py - y1); // degenerate: a point

  // Projection of the point onto the segment, clamped to its ends.
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Distance to a ray: anchored at (x1,y1), through (x2,y2), extending forever
 * beyond the second point but not behind the first.
 */
export function distanceToRay(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) return Math.hypot(px - x1, py - y1);

  const t = Math.max(0, ((px - x1) * dx + (py - y1) * dy) / lengthSq); // no upper clamp
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Distance to the outline of a rectangle given by two opposite corners. */
export function distanceToRectEdge(px, py, x1, y1, x2, y2) {
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);

  return Math.min(
    distanceToSegment(px, py, left, top, right, top),
    distanceToSegment(px, py, right, top, right, bottom),
    distanceToSegment(px, py, right, bottom, left, bottom),
    distanceToSegment(px, py, left, bottom, left, top),
  );
}

export function isInsideRect(px, py, x1, y1, x2, y2) {
  return px >= Math.min(x1, x2) && px <= Math.max(x1, x2)
    && py >= Math.min(y1, y2) && py <= Math.max(y1, y2);
}

/** The standard retracement levels, as fractions of the move. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/**
 * Fibonacci retracement prices between two anchors.
 *
 * Level 0 sits at the second point and level 1 at the first, which is the
 * convention every charting package uses: you drag from the start of the move
 * to its end, and 0% marks the end you dragged to.
 */
export function fibPrices(priceFrom, priceTo, levels = FIB_LEVELS) {
  const span = priceFrom - priceTo;
  return levels.map((level) => ({ level, price: priceTo + span * level }));
}

/**
 * What a measurement between two points says.
 * `bars` is the number of bars spanned, which the caller derives from the
 * chart's logical scale.
 */
export function measureStats(priceFrom, priceTo, bars) {
  const change = priceTo - priceFrom;
  return {
    change,
    // A zero starting price has no meaningful percentage — say so rather than
    // returning Infinity.
    percent: priceFrom === 0 ? null : (change / Math.abs(priceFrom)) * 100,
    bars,
    direction: change >= 0 ? 'up' : 'down',
  };
}

/**
 * Hit test against a drawing whose points have already been converted to
 * screen coordinates.
 *
 * @param {string} type
 * @param {Array<{x:number,y:number}>} pts
 * @param {{x:number,y:number}} at
 * @param {{width:number,height:number}} size  the chart pane, for full-width shapes
 * @returns {boolean}
 */
export function hitTest(type, pts, at, size) {
  if (pts.length === 0) return false;
  const [a, b] = pts;

  switch (type) {
    case 'horizontal':
      // Spans the full width, so only the vertical distance matters.
      return Math.abs(at.y - a.y) <= HIT_TOLERANCE;

    case 'vertical':
      return Math.abs(at.x - a.x) <= HIT_TOLERANCE;

    case 'trendline':
    case 'measure':
      return b ? distanceToSegment(at.x, at.y, a.x, a.y, b.x, b.y) <= HIT_TOLERANCE : false;

    case 'ray':
      return b ? distanceToRay(at.x, at.y, a.x, a.y, b.x, b.y) <= HIT_TOLERANCE : false;

    case 'rectangle':
      if (!b) return false;
      // The edge is always grabbable; the fill only inside.
      return distanceToRectEdge(at.x, at.y, a.x, a.y, b.x, b.y) <= HIT_TOLERANCE
        || isInsideRect(at.x, at.y, a.x, a.y, b.x, b.y);

    case 'fib': {
      if (!b) return false;
      // Any of the level lines counts, across the drawn width.
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x);
      if (at.x < left - HIT_TOLERANCE || at.x > right + HIT_TOLERANCE) return false;
      return FIB_LEVELS.some((level) => {
        const y = b.y + (a.y - b.y) * level;
        return Math.abs(at.y - y) <= HIT_TOLERANCE;
      });
    }

    case 'position':
    case 'long':
    case 'short': {
      if (pts.length < 3) return false;
      // The whole block is grabbable: it is a zone, and clicking inside one is
      // the obvious way to pick it up.
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return at.x >= Math.min(...xs) - HIT_TOLERANCE
        && at.x <= Math.max(...xs) + HIT_TOLERANCE
        && at.y >= Math.min(...ys) - HIT_TOLERANCE
        && at.y <= Math.max(...ys) + HIT_TOLERANCE;
    }

    default:
      throw new Error(`hitTest: unknown drawing type "${type}"`);
  }
}

/**
 * Index of the handle under the pointer, or -1.
 * Handles are the drawing's own anchor points.
 */
export function handleAt(pts, at) {
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(at.x - pts[i].x, at.y - pts[i].y) <= HANDLE_TOLERANCE) return i;
  }
  return -1;
}

/** How many anchor points a type needs before it is finished. */
export function pointsRequired(type) {
  switch (type) {
    case 'horizontal':
    case 'vertical':
      return 1;
    case 'trendline':
    case 'ray':
    case 'rectangle':
    case 'fib':
    case 'measure':
      return 2;
    case 'position':
    // 'long' and 'short' are the pre-0.1.1 names for the same shape; kept so
    // drawings saved under them still load.
    case 'long':
    case 'short':
      // entry, stop and target — three prices, two of which share a time.
      return 3;
    default:
      throw new Error(`pointsRequired: unknown drawing type "${type}"`);
  }
}

/**
 * Which way a position block points, derived from where the target sits
 * relative to the entry.
 *
 * There is deliberately no stored direction. The anchors are draggable, so a
 * block drawn as a long becomes a short the moment its target is pulled below
 * the entry — a stored flag would keep claiming otherwise. Reading it off the
 * geometry means the label can never contradict the picture.
 *
 * Falls back to the stop when the target sits exactly on the entry, and returns
 * null only when all three prices coincide.
 */
export function positionDirection(entry, stop, target) {
  if (target > entry) return 'long';
  if (target < entry) return 'short';
  if (stop < entry) return 'long';
  if (stop > entry) return 'short';
  return null;
}

/** Reward-to-risk a fresh position tool starts with. */
export const DEFAULT_RR = 2;

/**
 * Turns the two points of a drag into a drawing's stored anchors.
 *
 * Most tools store exactly what was dragged. A position tool does not: the drag
 * gives entry and stop, and the target is placed at DEFAULT_RR times the risk on
 * the other side of the entry — the way a trader sizes a trade in the first
 * place. All three stay adjustable afterwards.
 *
 * Dragging down from the entry therefore produces a long and dragging up a
 * short, without the tool needing to be told which was meant.
 */
export function buildFromGesture(type, start, end) {
  if (pointsRequired(type) !== 3) {
    return pointsRequired(type) === 1 ? [start] : [start, end];
  }

  const risk = start.price - end.price; // signed: the drag decides the direction
  return [
    { time: start.time, price: start.price },              // entry
    { time: end.time, price: end.price },                  // stop
    { time: end.time, price: start.price + risk * DEFAULT_RR }, // target
  ];
}

/** How many points the drag itself collects, before buildFromGesture. */
export function gesturePoints(type) {
  return pointsRequired(type) === 3 ? 2 : pointsRequired(type);
}

/**
 * What a position tool is worth: distances, percentages and reward-to-risk.
 *
 * Risk and reward are absolute distances, so the numbers read the same whether
 * the stop sits above or below the entry. Which side is which is a matter of
 * where the anchors are, not of the arithmetic.
 */
export function positionStats(entry, stop, target) {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  return {
    entry,
    stop,
    target,
    risk,
    reward,
    riskPercent: entry === 0 ? null : (risk / Math.abs(entry)) * 100,
    rewardPercent: entry === 0 ? null : (reward / Math.abs(entry)) * 100,
    // A stop at the entry has no risk to divide by — say so rather than
    // reporting an infinite reward-to-risk.
    rr: risk === 0 ? null : reward / risk,
  };
}
