/* Channels: two parallel strokes and the band between them.
 *
 * Every tool here is the same idea with a different rule for where the second
 * line goes — parallel to the first, flat, or derived from the bars. The third
 * anchor is always the one that sets the width, and it is stored rather than
 * computed so that dragging the baseline carries the channel with it.
 */
import {
  HIT_TOLERANCE, distanceToSegment, linearRegression, parallelPoint,
} from '../geometry.js';
import { fillPolygonAlpha, formatPrice, haloText, line, ray } from '../render.js';

/** How solid the band between the two lines is painted. */
const BAND_ALPHA = 0.08;

/**
 * Hit test for a channel: either edge, or anywhere in the band between them.
 *
 * The band counts because a channel is a zone — the same reasoning as a
 * rectangle. Its four corners come from the caller, in draw order.
 */
function bandHit(corners, at) {
  const edges = [
    [corners[0], corners[1]],
    [corners[3], corners[2]],
  ];
  for (const [p, q] of edges) {
    if (distanceToSegment(at.x, at.y, p.x, p.y, q.x, q.y) <= HIT_TOLERANCE) return true;
  }
  // Even-odd against the quad, which is convex here, so a simple test is enough.
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const { x: xi, y: yi } = corners[i];
    const { x: xj, y: yj } = corners[j];
    if ((yi > at.y) !== (yj > at.y)
      && at.x < ((xj - xi) * (at.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Paints a channel given its two lines, extending both when asked to. */
function paintChannel(ctx, color, [a, b], [c, d], extend, size) {
  fillPolygonAlpha(ctx, color, BAND_ALPHA, [a, b, d, c]);
  if (extend) {
    ray(ctx, a.x, a.y, b.x, b.y, size);
    ray(ctx, c.x, c.y, d.x, d.y, size);
  } else {
    line(ctx, a.x, a.y, b.x, b.y);
    line(ctx, c.x, c.y, d.x, d.y);
  }
}

/* ─── Parallel channel ──────────────────────────────────────────────────── */

/* Three anchors: the baseline's two ends, then a point the parallel runs
 * through. The fourth corner is derived, never stored — storing it would let a
 * drag of the baseline leave it behind and the two lines stop being parallel,
 * which is the one property the tool is named for. */
export const parallelchannel = {
  id: 'parallelchannel',
  name: 'Parallel channel',
  hint: 'Two clicks for the baseline, a third for the width',
  group: 'channels',
  icon: 'parallelchannel',
  points: 3,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 3) return false;
    const [a, b, c] = pts;
    return bandHit([a, b, parallelPoint(a, b, c), c], at);
  },
  draw(ctx, { pts, color, size }) {
    if (pts.length < 3) return;
    const [a, b, c] = pts;
    paintChannel(ctx, color, [a, b], [c, parallelPoint(a, b, c)], false, size);

    // The median, dashed so it never reads as one of the two edges.
    const dash = ctx.getLineDash();
    ctx.setLineDash([4, 4]);
    const d = parallelPoint(a, b, c);
    line(ctx, (a.x + c.x) / 2, (a.y + c.y) / 2, (b.x + d.x) / 2, (b.y + d.y) / 2);
    ctx.setLineDash(dash);
  },
};

/* ─── Disjoint channel ──────────────────────────────────────────────────── */

/* Four free anchors. The lines are not held parallel, which is the whole
 * difference from the tool above: a channel drawn on real swing points rarely
 * is, and forcing it to be moves one of the four points off the price it was
 * put on. */
export const disjointchannel = {
  id: 'disjointchannel',
  name: 'Disjoint channel',
  hint: 'Four points, two lines that need not stay parallel',
  group: 'channels',
  icon: 'disjointchannel',
  points: 4,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 4) return false;
    return bandHit([pts[0], pts[1], pts[3], pts[2]], at);
  },
  draw(ctx, { pts, color, size }) {
    if (pts.length < 4) return;
    paintChannel(ctx, color, [pts[0], pts[1]], [pts[2], pts[3]], false, size);
  },
};

/* ─── Flat top / bottom ─────────────────────────────────────────────────── */

/* A sloping line and a level one: the shape an ascending or descending triangle
 * makes. The third anchor gives only its price — its time is ignored, because a
 * flat line has no second point to hold it. */
export const flatchannel = {
  id: 'flatchannel',
  name: 'Flat top/bottom',
  hint: 'A sloping line and a flat one — the shape a triangle breaks out of',
  group: 'channels',
  icon: 'flatchannel',
  points: 3,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 3) return false;
    const [a, b, c] = pts;
    return bandHit([a, b, { x: b.x, y: c.y }, { x: a.x, y: c.y }], at);
  },
  draw(ctx, { pts, color, size, drawing, chrome }) {
    if (pts.length < 3) return;
    const [a, b, c] = pts;
    const flatLeft = { x: a.x, y: c.y };
    const flatRight = { x: b.x, y: c.y };
    paintChannel(ctx, color, [a, b], [flatLeft, flatRight], false, size);
    haloText(ctx, Math.max(a.x, b.x) + 4, c.y,
      formatPrice(drawing.points[2].price), color, chrome, 'left', 'middle');
  },
};

/* ─── Regression trend ──────────────────────────────────────────────────── */

/* Standard deviations the outer pair of lines sits at. Two, because that is
 * the band a mean-reversion trade is set up against; the one-deviation pair is
 * drawn finer inside it for context. */
const REGRESSION_DEVIATIONS = 2;

/**
 * The regression through the closes between two anchors.
 *
 * Fitted in market coordinates rather than pixels — a fit done on screen would
 * change every time the chart was zoomed, and the channel would stop describing
 * the bars and start describing the viewport. x is the bar index, so the slope
 * is price per bar.
 *
 * Returns null when the span holds too few bars to fit anything.
 */
function fitRegression(drawing, env) {
  const bars = env.bars();
  if (!Array.isArray(bars) || bars.length < 2) return null;

  // Bars carry seconds; drawings carry milliseconds.
  const from = Math.min(drawing.points[0].time, drawing.points[1].time) / 1000;
  const to = Math.max(drawing.points[0].time, drawing.points[1].time) / 1000;

  const sample = [];
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].time < from || bars[i].time > to) continue;
    sample.push({ x: i, y: bars[i].close, time: bars[i].time });
  }
  if (sample.length < 3) return null;

  const fit = linearRegression(sample);
  if (!fit) return null;

  const first = sample[0];
  const last = sample[sample.length - 1];
  return {
    fit,
    startTime: first.time * 1000,
    endTime: last.time * 1000,
    startPrice: fit.slope * first.x + fit.intercept,
    endPrice: fit.slope * last.x + fit.intercept,
  };
}

export const regression = {
  id: 'regression',
  name: 'Regression trend',
  hint: 'Drag over a stretch of chart — the channel is fitted to the closes in it',
  group: 'channels',
  icon: 'regression',
  points: 2,
  gesture: 'drag',
  style: 'line',
  /* Tested against the anchors rather than the fitted lines. The anchors are
   * where the handles are and where the user thinks the tool is; the fitted
   * band moves under them as bars load, and a hit box that moved on its own
   * would be unpickable. */
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    return at.x >= Math.min(a.x, b.x) - HIT_TOLERANCE
      && at.x <= Math.max(a.x, b.x) + HIT_TOLERANCE
      && at.y >= Math.min(a.y, b.y) - HIT_TOLERANCE
      && at.y <= Math.max(a.y, b.y) + HIT_TOLERANCE;
  },
  draw(ctx, env) {
    const { color, drawing, project, chrome, size, pts } = env;
    const model = fitRegression(drawing, env);
    if (!model) {
      // Say so rather than drawing nothing: an empty span looks like a broken
      // tool, and the anchors alone do not explain themselves.
      const [a, b] = pts;
      if (b) haloText(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2,
        'not enough bars', color, chrome, 'center', 'middle');
      return;
    }

    const at = (offset) => [
      project({ time: model.startTime, price: model.startPrice + offset }),
      project({ time: model.endTime, price: model.endPrice + offset }),
    ];

    const spread = model.fit.deviation * REGRESSION_DEVIATIONS;
    const [midA, midB] = at(0);
    const [upA, upB] = at(spread);
    const [downA, downB] = at(-spread);
    if (!midA || !midB || !upA || !upB || !downA || !downB) return;

    paintChannel(ctx, color, [upA, upB], [downA, downB], false, size);

    const dash = ctx.getLineDash();
    ctx.setLineDash([4, 4]);
    line(ctx, midA.x, midA.y, midB.x, midB.y);

    // The inner pair, at one deviation.
    ctx.setLineDash([2, 4]);
    const [inUpA, inUpB] = at(model.fit.deviation);
    const [inDownA, inDownB] = at(-model.fit.deviation);
    if (inUpA && inUpB) line(ctx, inUpA.x, inUpA.y, inUpB.x, inUpB.y);
    if (inDownA && inDownB) line(ctx, inDownA.x, inDownA.y, inDownB.x, inDownB.y);
    ctx.setLineDash(dash);

    haloText(ctx, midB.x + 4, midB.y, `${REGRESSION_DEVIATIONS}σ ${formatPrice(spread)}`,
      color, chrome, 'left', 'middle');
  },
};

export default [parallelchannel, disjointchannel, flatchannel, regression];
