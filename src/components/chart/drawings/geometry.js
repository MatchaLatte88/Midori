/* Drawing geometry — pure maths on screen coordinates.
 *
 * Everything here works in pixels, after time and price have been converted by
 * the chart. That is deliberate: a hit tolerance is a pixel quantity ("within
 * six pixels of the line"), not a price one. Six dollars is a hit on a penny
 * stock and a miss on Bitcoin.
 *
 * No DOM, no chart API — so all of it is testable in plain Node.
 *
 * Nothing here knows what a drawing *is*. Which shape needs how many anchors,
 * how a drag becomes anchors, and what counts as a hit for a given tool all
 * live in registry.js, because those answers are per tool and there are dozens
 * of them. This file holds only the maths those answers are built out of.
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

/**
 * Distance to the infinite line through two points — no clamping at either
 * end, unlike a segment or a ray.
 */
export function distanceToLine(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) return Math.hypot(px - x1, py - y1);

  const t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Shortest distance to a run of connected segments. */
export function distanceToPolyline(px, py, pts) {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(px - pts[0].x, py - pts[0].y);

  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distanceToSegment(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    if (d < best) best = d;
  }
  return best;
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

/**
 * Distance to the outline of an axis-aligned ellipse inscribed in the box
 * given by two opposite corners.
 *
 * The exact distance to an ellipse has no closed form worth writing here, so
 * this uses the standard scaled approximation: measure how far the point is
 * from the centre in units of the radius on each axis, and turn the resulting
 * error back into pixels with the smaller radius. It is exact on a circle and
 * close enough on anything a hand-drawn ellipse will be, which is all a six
 * pixel tolerance needs.
 */
export function distanceToEllipse(px, py, x1, y1, x2, y2) {
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rx = Math.abs(x2 - x1) / 2;
  const ry = Math.abs(y2 - y1) / 2;

  if (rx === 0 || ry === 0) return distanceToSegment(px, py, x1, y1, x2, y2);

  const nx = (px - cx) / rx;
  const ny = (py - cy) / ry;
  const radial = Math.hypot(nx, ny);

  // A point exactly at the centre is as far from the outline as the shorter
  // radius, in every direction at once.
  if (radial === 0) return Math.min(rx, ry);

  return Math.abs(radial - 1) * Math.min(rx, ry);
}

export function isInsideEllipse(px, py, x1, y1, x2, y2) {
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rx = Math.abs(x2 - x1) / 2;
  const ry = Math.abs(y2 - y1) / 2;
  if (rx === 0 || ry === 0) return false;
  return ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;
}

/** Distance to the outline of a circle centred at (cx, cy). */
export function distanceToCircle(px, py, cx, cy, radius) {
  return Math.abs(Math.hypot(px - cx, py - cy) - radius);
}

/** Even-odd containment test for an arbitrary polygon of screen points. */
export function isInsidePolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const { x: xi, y: yi } = pts[i];
    const { x: xj, y: yj } = pts[j];
    const crosses = (yi > py) !== (yj > py)
      && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * Samples a quadratic Bezier into a polyline.
 *
 * Curves are hit-tested and drawn against the same sampling, so a click lands
 * wherever the curve was actually painted rather than on the ideal curve the
 * painted one approximates.
 */
export function sampleQuadratic(p0, c, p1, steps = 24) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({
      x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
    });
  }
  return out;
}

/** Samples a cubic Bezier into a polyline, on the same terms as the quadratic. */
export function sampleCubic(p0, c1, c2, p1, steps = 32) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
      y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
    });
  }
  return out;
}

/**
 * The fourth corner of a parallelogram: the point that stands to `c` as `b`
 * stands to `a`.
 *
 * Every channel tool is this one operation. The stored anchors are a baseline
 * and a single point off it, and the far end of the parallel line has to be
 * derived rather than stored, or dragging the baseline would leave it behind.
 */
export function parallelPoint(a, b, c) {
  return { x: c.x + (b.x - a.x), y: c.y + (b.y - a.y) };
}

/**
 * Least-squares fit through a run of {x, y} points.
 *
 * Returns the slope and intercept of the line, plus the standard deviation of
 * the residuals — the regression channel's width is a multiple of that.
 * Returns null when the points do not define a line: fewer than two of them,
 * or all at the same x.
 */
export function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;

  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    sxx += dx * dx;
    sxy += dx * (p.y - meanY);
  }
  if (sxx === 0) return null; // a vertical run has no slope

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let residualSq = 0;
  for (const p of points) {
    const error = p.y - (slope * p.x + intercept);
    residualSq += error * error;
  }

  return { slope, intercept, deviation: Math.sqrt(residualSq / n) };
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
 * Index of the handle under the pointer, or -1.
 * Handles are the drawing's own anchor points.
 */
export function handleAt(pts, at) {
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(at.x - pts[i].x, at.y - pts[i].y) <= HANDLE_TOLERANCE) return i;
  }
  return -1;
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
 * Which axis a drag should lock to while shift is held.
 *
 * Decided in *pixels*, never in market units, for the same reason the hit
 * tolerance is: a price delta and a time delta are not comparable quantities.
 * Twenty dollars and twenty minutes have no ratio between them, and whichever
 * happened to be the larger number would decide the axis — so the lock would
 * flip when the price scale was zoomed, without the pointer having moved.
 *
 * On screen both deltas are pixels, and the answer is the one the user means:
 * the direction they actually dragged further.
 *
 * A drag of exactly zero locks horizontal. It has no direction yet, and one of
 * the two has to be picked before the pointer commits.
 */
export function snapAxis(dx, dy) {
  return Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
}

/**
 * Locks a market-coordinate point onto one axis through an anchor.
 *
 * Horizontal keeps the anchor's price and lets time run; vertical keeps its
 * time and lets price run. The axis comes from snapAxis and therefore from the
 * pixel deltas, not from these values.
 */
export function snapToAxis(anchor, point, axis) {
  return axis === 'horizontal'
    ? { time: point.time, price: anchor.price }
    : { time: anchor.time, price: point.price };
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
