/* The line family: everything that is a straight stroke between anchors.
 *
 * The four that existed before the registry — trend line, ray, horizontal,
 * vertical — are here unchanged in behaviour; the rest are the variants a
 * terminal offers alongside them. They differ in exactly two ways: how far past
 * the anchors the stroke runs, and what is written on it. That is why they are
 * one file rather than nine.
 *
 * A spec is the whole definition of a tool. See registry.js for the shape.
 */
import {
  HIT_TOLERANCE, distanceToLine, distanceToRay, distanceToSegment, measureStats,
} from '../geometry.js';
import {
  arrowHead, chip, chipLines, extendedLine, formatPercent, formatPrice, haloText, line, ray,
} from '../render.js';

/* ─── Shared pieces ─────────────────────────────────────────────────────── */

/** Hit test for a stroke between two anchors, given the reach rule. */
function strokeHit(kind) {
  return (pts, at) => {
    const [a, b] = pts;
    if (!b) return false;
    const distance = kind === 'segment' ? distanceToSegment(at.x, at.y, a.x, a.y, b.x, b.y)
      : kind === 'ray' ? distanceToRay(at.x, at.y, a.x, a.y, b.x, b.y)
        : distanceToLine(at.x, at.y, a.x, a.y, b.x, b.y);
    return distance <= HIT_TOLERANCE;
  };
}

/**
 * What a two-anchor stroke spans, in the terms a trader reads it in.
 *
 * Shared by the info line, the trend angle and the measure tool, so the three
 * never disagree about what the same two points are worth.
 */
export function spanStats(drawing, env) {
  const [from, to] = drawing.points;
  const bars = env.barsBetween(from.time, to.time);
  return measureStats(from.price, to.price, bars);
}

/* ─── Specs ─────────────────────────────────────────────────────────────── */

export const trendline = {
  id: 'trendline',
  name: 'Trend line',
  hint: 'Two points, drawn between them. Hold shift to lock it level or upright',
  group: 'lines',
  icon: 'trendline',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit: strokeHit('segment'),
  draw(ctx, { pts }) {
    const [a, b] = pts;
    if (b) line(ctx, a.x, a.y, b.x, b.y);
  },
};

export const ray_ = {
  id: 'ray',
  name: 'Ray',
  hint: 'Two points, extended forward. Hold shift to lock it level or upright',
  group: 'lines',
  icon: 'ray',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit: strokeHit('ray'),
  draw(ctx, { pts, size }) {
    const [a, b] = pts;
    if (b) ray(ctx, a.x, a.y, b.x, b.y, size);
  },
};

export const extended = {
  id: 'extended',
  name: 'Extended line',
  hint: 'Two points, extended past both of them',
  group: 'lines',
  icon: 'extended',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit: strokeHit('line'),
  draw(ctx, { pts, size }) {
    const [a, b] = pts;
    if (b) extendedLine(ctx, a.x, a.y, b.x, b.y, size);
  },
};

/* A trend line that keeps its numbers. The measure tool answers the same
 * question, but a measurement is a glance and this is an annotation — it stays
 * on the chart, so it is a drawing rather than a gesture. */
export const infoline = {
  id: 'infoline',
  name: 'Info line',
  hint: 'A trend line that keeps its price, percent and bar count on the chart',
  group: 'lines',
  icon: 'infoline',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit: strokeHit('segment'),
  draw(ctx, env) {
    const { pts, color, chrome, drawing } = env;
    const [a, b] = pts;
    if (!b) return;
    line(ctx, a.x, a.y, b.x, b.y);

    const stats = spanStats(drawing, env);
    chipLines(ctx, (a.x + b.x) / 2, Math.min(a.y, b.y) - 48, [
      `${stats.change >= 0 ? '+' : ''}${formatPrice(stats.change)}`,
      formatPercent(stats.percent),
      `${stats.bars} bar${stats.bars === 1 ? '' : 's'}`,
    ], color, chrome);
  },
};

/* The angle is read off the *pixels*, not off price and time — the same reason
 * the axis snap is. There is no ratio between a dollar and a minute, so an
 * angle in market units would be a number with no meaning; the one on screen is
 * the one being looked at. It therefore changes with the zoom, which is a
 * property of every charting package's trend angle and not a bug in this one. */
export const trendangle = {
  id: 'trendangle',
  name: 'Trend angle',
  hint: 'A trend line reporting its angle on screen',
  group: 'lines',
  icon: 'trendangle',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit: strokeHit('segment'),
  draw(ctx, { pts, color, chrome }) {
    const [a, b] = pts;
    if (!b) return;
    line(ctx, a.x, a.y, b.x, b.y);

    // The horizontal the angle is measured against, and the arc between them.
    const dash = ctx.getLineDash();
    ctx.setLineDash([3, 3]);
    const reach = Math.min(60, Math.abs(b.x - a.x) || 60) * Math.sign(b.x - a.x || 1);
    line(ctx, a.x, a.y, a.x + reach, a.y);

    const angle = Math.atan2(a.y - b.y, b.x - a.x); // y grows downwards on a canvas
    ctx.beginPath();
    ctx.arc(a.x, a.y, 26, angle > 0 ? -angle : 0, angle > 0 ? 0 : -angle);
    ctx.stroke();
    ctx.setLineDash(dash);

    const degrees = (angle * 180) / Math.PI;
    haloText(ctx, a.x + 30, a.y - Math.sign(angle) * 10,
      `${degrees.toFixed(1)}°`, color, chrome, 'left', 'middle');
  },
};

export const horizontal = {
  id: 'horizontal',
  name: 'Horizontal line',
  hint: 'A price level across the chart',
  group: 'lines',
  icon: 'horizontal',
  points: 1,
  gesture: 'click',
  style: 'line',
  // Spans the full width, so only the vertical distance matters.
  hit: (pts, at) => Math.abs(at.y - pts[0].y) <= HIT_TOLERANCE,
  draw(ctx, { pts, size, drawing, color, chrome }) {
    line(ctx, 0, pts[0].y, size.width, pts[0].y);
    chip(ctx, size.width - 2, pts[0].y, formatPrice(drawing.points[0].price), color, chrome, 'right');
  },
};

/* A level that only applies from where it was placed onwards — the ordinary way
 * to mark a level that was created by a specific bar rather than one that has
 * always been there. */
export const horizontalray = {
  id: 'horizontalray',
  name: 'Horizontal ray',
  hint: 'A price level running forward from where it is placed',
  group: 'lines',
  icon: 'horizontalray',
  points: 1,
  gesture: 'click',
  style: 'line',
  hit: (pts, at) => Math.abs(at.y - pts[0].y) <= HIT_TOLERANCE && at.x >= pts[0].x - HIT_TOLERANCE,
  draw(ctx, { pts, size, drawing, color, chrome }) {
    line(ctx, pts[0].x, pts[0].y, size.width, pts[0].y);
    chip(ctx, size.width - 2, pts[0].y, formatPrice(drawing.points[0].price), color, chrome, 'right');
  },
};

export const vertical = {
  id: 'vertical',
  name: 'Vertical line',
  hint: 'A moment in time',
  group: 'lines',
  icon: 'vertical',
  points: 1,
  gesture: 'click',
  style: 'line',
  hit: (pts, at) => Math.abs(at.x - pts[0].x) <= HIT_TOLERANCE,
  draw(ctx, { pts, size }) {
    line(ctx, pts[0].x, 0, pts[0].x, size.height);
  },
};

export const crossline = {
  id: 'crossline',
  name: 'Cross line',
  hint: 'A price and a moment at once',
  group: 'lines',
  icon: 'crossline',
  points: 1,
  gesture: 'click',
  style: 'line',
  hit: (pts, at) => Math.abs(at.x - pts[0].x) <= HIT_TOLERANCE
    || Math.abs(at.y - pts[0].y) <= HIT_TOLERANCE,
  draw(ctx, { pts, size, drawing, color, chrome }) {
    line(ctx, 0, pts[0].y, size.width, pts[0].y);
    line(ctx, pts[0].x, 0, pts[0].x, size.height);
    chip(ctx, size.width - 2, pts[0].y, formatPrice(drawing.points[0].price), color, chrome, 'right');
  },
};

export const arrow = {
  id: 'arrow',
  name: 'Arrow',
  hint: 'A line pointing at something',
  group: 'lines',
  icon: 'arrow',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit: strokeHit('segment'),
  draw(ctx, { pts, color, drawing }) {
    const [a, b] = pts;
    if (!b) return;
    line(ctx, a.x, a.y, b.x, b.y);
    // The head grows a little with the stroke, or a 3px line arrives at a
    // pinhead — but not proportionally; see arrowHead.
    arrowHead(ctx, a.x, a.y, b.x, b.y, color, 1 + (drawing.width - 1) * 0.25);
  },
};

/* The four markers. One spec each rather than one with a stored direction: the
 * direction is the tool, it is never edited afterwards, and four buttons that
 * each place the arrow they show is less to explain than one button plus a
 * setting. */
function marker(id, name, dx, dy, icon) {
  return {
    id,
    name,
    hint: 'A marker pointing at one bar',
    group: 'lines',
    icon,
    points: 1,
    gesture: 'click',
    style: 'line',
    /* The whole marker is grabbable, not just the shaft — it is 24 pixels of
     * chrome and asking for a click on its centre line would be unusable. */
    hit: (pts, at) => Math.hypot(at.x - pts[0].x, at.y - pts[0].y) <= MARKER_LENGTH,
    draw(ctx, { pts, color }) {
      const { x, y } = pts[0];
      // Drawn *towards* the anchor, so the tip lands on the price that was
      // clicked and the tail hangs off behind it.
      const tailX = x - dx * MARKER_LENGTH;
      const tailY = y - dy * MARKER_LENGTH;
      line(ctx, tailX, tailY, x, y);
      arrowHead(ctx, tailX, tailY, x, y, color, 1.3);
    },
  };
}

/** How far a marker's tail reaches back from the bar it points at, in pixels. */
const MARKER_LENGTH = 26;

export const arrowup = marker('arrowup', 'Arrow up', 0, -1, 'arrowup');
export const arrowdown = marker('arrowdown', 'Arrow down', 0, 1, 'arrowdown');
export const arrowleft = marker('arrowleft', 'Arrow left', -1, 0, 'arrowleft');
export const arrowright = marker('arrowright', 'Arrow right', 1, 0, 'arrowright');

export default [
  trendline, ray_, extended, infoline, trendangle,
  horizontal, horizontalray, vertical, crossline,
  arrow, arrowup, arrowdown, arrowleft, arrowright,
];
