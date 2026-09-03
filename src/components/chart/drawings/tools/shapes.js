/* Shapes: the tools that enclose an area or trace a free path.
 *
 * None of them mean anything on their own — a circle is not a level and a brush
 * stroke is not a signal. They are for marking up a chart the way you would
 * mark up a printout, which is why they are the one family with no numbers on
 * them.
 */
import {
  HIT_TOLERANCE, distanceToCircle, distanceToEllipse, distanceToPolyline,
  distanceToRectEdge, isInsideEllipse, isInsidePolygon, isInsideRect,
  sampleCubic, sampleQuadratic,
} from '../geometry.js';
import {
  arrowHead, fillPathAlpha, fillPolygonAlpha, fillRectAlpha, line, polygon, polyline,
} from '../render.js';

/** How solid an enclosed shape's interior is. Matches the rectangle's original. */
const FILL_ALPHA = 0.12;

/* ─── Rectangle ─────────────────────────────────────────────────────────── */

export const rectangle = {
  id: 'rectangle',
  name: 'Rectangle',
  hint: 'A zone in price and time. Hold shift to keep one side fixed',
  group: 'shapes',
  icon: 'rectangle',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    // The edge is always grabbable; the fill only inside.
    return distanceToRectEdge(at.x, at.y, a.x, a.y, b.x, b.y) <= HIT_TOLERANCE
      || isInsideRect(at.x, at.y, a.x, a.y, b.x, b.y);
  },
  draw(ctx, { pts, color }) {
    const [a, b] = pts;
    if (!b) return;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    fillRectAlpha(ctx, color, FILL_ALPHA, x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  },
};

/* ─── Rotated rectangle ─────────────────────────────────────────────────── */

/**
 * The four corners of a rotated rectangle.
 *
 * The first two anchors are one whole edge; the third only supplies a width,
 * taken as its distance from that edge along the perpendicular. Anything the
 * third anchor says about the direction *along* the edge is discarded, which is
 * what keeps the corners square however it is dragged.
 */
function rotatedCorners(a, b, c) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [a, b, c, c];

  // Unit normal to the edge, and how far the third point lies along it.
  const nx = -dy / len;
  const ny = dx / len;
  const offset = (c.x - b.x) * nx + (c.y - b.y) * ny;

  return [
    a,
    b,
    { x: b.x + nx * offset, y: b.y + ny * offset },
    { x: a.x + nx * offset, y: a.y + ny * offset },
  ];
}

export const rotatedrect = {
  id: 'rotatedrect',
  name: 'Rotated rectangle',
  hint: 'Two points for one edge, a third for the width — it stays square',
  group: 'shapes',
  icon: 'rotatedrect',
  points: 3,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 3) return false;
    const corners = rotatedCorners(...pts);
    return isInsidePolygon(at.x, at.y, corners)
      || distanceToPolyline(at.x, at.y, [...corners, corners[0]]) <= HIT_TOLERANCE;
  },
  draw(ctx, { pts, color }) {
    if (pts.length < 3) return;
    const corners = rotatedCorners(...pts);
    fillPolygonAlpha(ctx, color, FILL_ALPHA, corners);
    polygon(ctx, corners);
  },
};

/* ─── Circle and ellipse ────────────────────────────────────────────────── */

export const circle = {
  id: 'circle',
  name: 'Circle',
  hint: 'Drag from the centre outwards',
  group: 'shapes',
  icon: 'circle',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    const radius = Math.hypot(b.x - a.x, b.y - a.y);
    return distanceToCircle(at.x, at.y, a.x, a.y, radius) <= HIT_TOLERANCE
      || Math.hypot(at.x - a.x, at.y - a.y) <= radius;
  },
  draw(ctx, { pts, color }) {
    const [a, b] = pts;
    if (!b) return;
    const radius = Math.hypot(b.x - a.x, b.y - a.y);
    ctx.beginPath();
    ctx.arc(a.x, a.y, radius, 0, Math.PI * 2);
    fillPathAlpha(ctx, color, FILL_ALPHA);
    ctx.strokeStyle = color;
    ctx.stroke();
  },
};

export const ellipse = {
  id: 'ellipse',
  name: 'Ellipse',
  hint: 'Drag out the box it fits inside',
  group: 'shapes',
  icon: 'ellipse',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    return distanceToEllipse(at.x, at.y, a.x, a.y, b.x, b.y) <= HIT_TOLERANCE
      || isInsideEllipse(at.x, at.y, a.x, a.y, b.x, b.y);
  },
  draw(ctx, { pts, color }) {
    const [a, b] = pts;
    if (!b) return;
    ctx.beginPath();
    ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2,
      Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    fillPathAlpha(ctx, color, FILL_ALPHA);
    ctx.strokeStyle = color;
    ctx.stroke();
  },
};

export const triangle = {
  id: 'triangle',
  name: 'Triangle',
  hint: 'Three corners',
  group: 'shapes',
  icon: 'triangle',
  points: 3,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 3) return false;
    return isInsidePolygon(at.x, at.y, pts)
      || distanceToPolyline(at.x, at.y, [...pts, pts[0]]) <= HIT_TOLERANCE;
  },
  draw(ctx, { pts, color }) {
    if (pts.length < 3) return;
    fillPolygonAlpha(ctx, color, FILL_ALPHA, pts);
    polygon(ctx, pts);
  },
};

/* ─── Open paths ────────────────────────────────────────────────────────── */

/* Polyline and path take clicks until the shape is finished — double-click,
 * Enter or Escape — so they are the two tools with no fixed anchor count. The
 * only difference between them is the arrowhead, which is why they share
 * everything else. */
function openPath(id, name, hint, icon, arrow) {
  return {
    id,
    name,
    hint,
    group: 'shapes',
    icon,
    points: 'variable',
    minPoints: 2,
    gesture: 'poly',
    style: 'line',
    hit: (pts, at) => distanceToPolyline(at.x, at.y, pts) <= HIT_TOLERANCE,
    draw(ctx, { pts, color, drawing }) {
      polyline(ctx, pts);
      if (arrow && pts.length >= 2) {
        const last = pts[pts.length - 1];
        const previous = pts[pts.length - 2];
        arrowHead(ctx, previous.x, previous.y, last.x, last.y, color,
          1 + (drawing.width - 1) * 0.25);
      }
    },
  };
}

export const polylineTool = openPath(
  'polyline', 'Polyline',
  'Click each corner; double-click or press Enter to finish',
  'polyline', false,
);

export const path = openPath(
  'path', 'Path',
  'A polyline that ends in an arrow. Double-click or press Enter to finish',
  'path', true,
);

/* ─── Freehand ──────────────────────────────────────────────────────────── */

/* Freehand strokes store every sampled point, so they are the one thing on the
 * chart whose size depends on how the mouse was moved. The sampler in
 * useDrawings drops points closer together than a few pixels for exactly that
 * reason — see FREEHAND_SPACING there. */
function freehand(id, name, hint, icon, alpha, widthScale) {
  return {
    id,
    name,
    hint,
    group: 'shapes',
    icon,
    points: 'variable',
    minPoints: 2,
    gesture: 'free',
    style: 'line',
    hit: (pts, at) => distanceToPolyline(at.x, at.y, pts) <= HIT_TOLERANCE * widthScale,
    draw(ctx, { pts, drawing }) {
      const previousAlpha = ctx.globalAlpha;
      const previousWidth = ctx.lineWidth;
      const previousCap = ctx.lineCap;
      ctx.globalAlpha = previousAlpha * alpha;
      ctx.lineWidth = drawing.width * widthScale;
      // A highlighter is a flat nib, not a pen: square ends stop a slow stroke
      // from beading into a row of dots where the samples bunch up.
      if (widthScale > 1) ctx.lineCap = 'square';
      polyline(ctx, pts);
      ctx.globalAlpha = previousAlpha;
      ctx.lineWidth = previousWidth;
      ctx.lineCap = previousCap;
    },
  };
}

export const brush = freehand('brush', 'Brush', 'Draw freehand', 'brush', 1, 1);
export const highlighter = freehand(
  'highlighter', 'Highlighter',
  'A broad translucent stroke, for marking rather than drawing',
  'highlighter', 0.3, 7,
);

/* ─── Curves ────────────────────────────────────────────────────────────── */

/* Anchor order is start, end, then the control point, for all three. Putting
 * the control last means the first two handles are the ones a user reaches for
 * — the ends of the thing — and the shaping handle is the one they have to go
 * looking for, which is the right way round. */

export const curve = {
  id: 'curve',
  name: 'Curve',
  hint: 'Two ends and a point to bend it through',
  group: 'shapes',
  icon: 'curve',
  points: 3,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 3) return false;
    return distanceToPolyline(at.x, at.y, sampleQuadratic(pts[0], pts[2], pts[1])) <= HIT_TOLERANCE;
  },
  draw(ctx, { pts }) {
    if (pts.length < 3) return;
    polyline(ctx, sampleQuadratic(pts[0], pts[2], pts[1]));
  },
};

/* An arc is a curve with its interior filled — the same maths, closed back to
 * the chord. Two tools rather than a fill toggle because that is how they are
 * reached for: one is a line, the other is a region. */
export const arc = {
  id: 'arc',
  name: 'Arc',
  hint: 'A curve closed back to its chord',
  group: 'shapes',
  icon: 'arc',
  points: 3,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 3) return false;
    const curvePts = sampleQuadratic(pts[0], pts[2], pts[1]);
    return isInsidePolygon(at.x, at.y, curvePts)
      || distanceToPolyline(at.x, at.y, curvePts) <= HIT_TOLERANCE;
  },
  draw(ctx, { pts, color }) {
    if (pts.length < 3) return;
    const curvePts = sampleQuadratic(pts[0], pts[2], pts[1]);
    fillPolygonAlpha(ctx, color, FILL_ALPHA, curvePts);
    polyline(ctx, curvePts);
    // The chord, dashed, so the shape reads as closed without pretending the
    // straight side is part of the curve.
    const dash = ctx.getLineDash();
    ctx.setLineDash([3, 3]);
    line(ctx, pts[0].x, pts[0].y, pts[1].x, pts[1].y);
    ctx.setLineDash(dash);
  },
};

export const doublecurve = {
  id: 'doublecurve',
  name: 'Double curve',
  hint: 'Two ends and two control points — an S rather than a bow',
  group: 'shapes',
  icon: 'doublecurve',
  points: 4,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 4) return false;
    return distanceToPolyline(at.x, at.y,
      sampleCubic(pts[0], pts[2], pts[3], pts[1])) <= HIT_TOLERANCE;
  },
  draw(ctx, { pts }) {
    if (pts.length < 4) return;
    polyline(ctx, sampleCubic(pts[0], pts[2], pts[3], pts[1]));
  },
};

export default [
  rectangle, rotatedrect, circle, ellipse, triangle,
  polylineTool, path, brush, highlighter,
  curve, arc, doublecurve,
];
