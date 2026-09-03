/* Patterns: labelled zigzags.
 *
 * Almost every tool in this family is the same object — a run of clicked
 * pivots, joined up, with a name against each one — so the zigzag is written
 * once and each pattern supplies its labels. What differs between them is the
 * arithmetic printed on the legs, and only the harmonic patterns have any.
 *
 * The ratios are measured in price, not in pixels: a harmonic pattern is a
 * statement about how far price retraced, and that number must not change when
 * the chart is zoomed. Contrast the Gann and fib radial tools, which have no
 * choice but to work in pixels — see the notes in those files.
 */
import { HIT_TOLERANCE, distanceToPolyline } from '../geometry.js';
import { fillPolygonAlpha, haloText, line, polyline } from '../render.js';

/** How solid the triangles inside a harmonic pattern are. */
const WING_ALPHA = 0.08;

/**
 * The retracement of one leg against the one before it, in price.
 *
 * Returns null for a leg of zero length rather than Infinity — a pattern being
 * dragged out passes through that state on every click.
 */
function legRatio(points, i) {
  const previous = Math.abs(points[i].price - points[i - 1].price);
  const current = Math.abs(points[i + 1].price - points[i].price);
  return previous === 0 ? null : current / previous;
}

/** Draws the vertex labels of a pattern, each clear of the pivot it names. */
function drawLabels(ctx, pts, labels, color, chrome) {
  for (let i = 0; i < pts.length && i < labels.length; i++) {
    if (!labels[i]) continue;
    /* Above a peak and below a trough, so a label never lands on the leg it
     * belongs to. Which one a pivot is comes from its neighbours; the ends
     * borrow the answer from their only neighbour. */
    const previous = pts[i - 1] ?? pts[i + 1];
    const above = previous ? pts[i].y <= previous.y : true;
    haloText(ctx, pts[i].x, pts[i].y + (above ? -6 : 6),
      labels[i], color, chrome, 'center', above ? 'bottom' : 'top');
  }
}

/**
 * A labelled zigzag through clicked pivots.
 *
 * `wings` fills the triangles a harmonic pattern is read by, and `ratios` says
 * which legs get their retracement printed on them.
 */
function pattern({ id, name, hint, icon, labels, wings = [], ratios = [] }) {
  return {
    id,
    name,
    hint,
    group: 'patterns',
    icon,
    points: labels.length,
    gesture: 'clicks',
    style: 'line',
    hit: (pts, at) => distanceToPolyline(at.x, at.y, pts) <= HIT_TOLERANCE,
    draw(ctx, { pts, drawing, color, chrome }) {
      if (pts.length < 2) return;

      for (const wing of wings) {
        if (wing.some((i) => i >= pts.length)) continue;
        fillPolygonAlpha(ctx, color, WING_ALPHA, wing.map((i) => pts[i]));
        // The closing side of each triangle, which the zigzag itself does not
        // draw: it is what makes the wing read as a shape rather than a fill.
        const first = pts[wing[0]];
        const last = pts[wing[wing.length - 1]];
        const dash = ctx.getLineDash();
        ctx.setLineDash([3, 3]);
        line(ctx, first.x, first.y, last.x, last.y);
        ctx.setLineDash(dash);
      }

      polyline(ctx, pts);
      drawLabels(ctx, pts, labels, color, chrome);

      for (const i of ratios) {
        if (i + 1 >= pts.length) continue;
        const ratio = legRatio(drawing.points, i);
        if (ratio === null) continue;
        haloText(ctx, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2,
          ratio.toFixed(3), color, chrome, 'center', 'middle');
      }
    },
  };
}

/* ─── Harmonics ─────────────────────────────────────────────────────────── */

export const abcd = pattern({
  id: 'abcd',
  name: 'ABCD pattern',
  hint: 'Four pivots; the retracements are printed on the legs',
  icon: 'abcd',
  labels: ['A', 'B', 'C', 'D'],
  ratios: [1, 2],
});

export const xabcd = pattern({
  id: 'xabcd',
  name: 'XABCD pattern',
  hint: 'Five pivots — Gartley, bat, butterfly and the rest are all this shape',
  icon: 'xabcd',
  labels: ['X', 'A', 'B', 'C', 'D'],
  wings: [[0, 1, 2], [2, 3, 4]],
  ratios: [1, 2, 3],
});

/* The same five pivots as an XABCD. It is a separate tool because it is a
 * separate claim — the Cypher's ratios are measured against different legs —
 * and having both on the palette is how a chart says which was meant. */
export const cypher = pattern({
  id: 'cypher',
  name: 'Cypher pattern',
  hint: 'Five pivots, read by the Cypher ratios',
  icon: 'cypher',
  labels: ['X', 'A', 'B', 'C', 'D'],
  wings: [[0, 1, 2], [2, 3, 4]],
  ratios: [1, 2, 3],
});

export const threedrives = pattern({
  id: 'threedrives',
  name: 'Three drives',
  hint: 'Seven pivots: three drives and the two corrections between them',
  icon: 'threedrives',
  labels: ['', 'A', '1', 'B', '2', 'C', '3'],
  ratios: [1, 2, 3, 4, 5],
});

/* ─── Classical shapes ──────────────────────────────────────────────────── */

export const headshoulders = pattern({
  id: 'headshoulders',
  name: 'Head and shoulders',
  hint: 'Seven pivots; the neckline is drawn between the two troughs',
  icon: 'headshoulders',
  labels: ['', 'LS', '', 'H', '', 'RS', ''],
});

export const trianglepattern = pattern({
  id: 'trianglepattern',
  name: 'Triangle pattern',
  hint: 'Six pivots converging into the apex',
  icon: 'trianglepattern',
  labels: ['1', '2', '3', '4', '5', '6'],
});

/* The neckline is what the pattern is traded off, so it is drawn rather than
 * left to the eye. Wrapped rather than folded into the generic zigzag: it is
 * the only pattern with a line that is not one of its own legs. */
const zigzagDraw = headshoulders.draw;
headshoulders.draw = function drawHeadShoulders(ctx, env) {
  zigzagDraw.call(this, ctx, env);
  const { pts, color, size } = env;
  if (pts.length < 5) return;
  const dash = ctx.getLineDash();
  ctx.setLineDash([5, 4]);
  const [, , left, , right] = pts;
  // Extended past both troughs: the break of the neckline usually happens
  // beyond the last pivot that defined it.
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  const len = Math.hypot(dx, dy) || 1;
  const reach = size.width;
  line(ctx,
    left.x - (dx / len) * reach, left.y - (dy / len) * reach,
    right.x + (dx / len) * reach, right.y + (dy / len) * reach);
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
};

/* ─── Elliott ───────────────────────────────────────────────────────────── */

/* Each of these is a count, and the count is the whole content of the tool.
 * The first anchor is the wave's origin and carries no label — it is where the
 * count starts from, not part of it. */

export const elliottimpulse = pattern({
  id: 'elliottimpulse',
  name: 'Elliott impulse wave (12345)',
  hint: 'The origin, then the five waves',
  icon: 'elliottimpulse',
  labels: ['', '1', '2', '3', '4', '5'],
});

export const elliottcorrection = pattern({
  id: 'elliottcorrection',
  name: 'Elliott correction wave (ABC)',
  hint: 'The origin, then the three corrective waves',
  icon: 'elliottcorrection',
  labels: ['', 'A', 'B', 'C'],
});

export const elliotttriangle = pattern({
  id: 'elliotttriangle',
  name: 'Elliott triangle wave (ABCDE)',
  hint: 'The origin, then the five legs of the triangle',
  icon: 'elliotttriangle',
  labels: ['', 'A', 'B', 'C', 'D', 'E'],
});

export const elliottdoublecombo = pattern({
  id: 'elliottdoublecombo',
  name: 'Elliott double combo (WXY)',
  hint: 'The origin, then W, X and Y',
  icon: 'elliottdoublecombo',
  labels: ['', 'W', 'X', 'Y'],
});

export const elliotttriplecombo = pattern({
  id: 'elliotttriplecombo',
  name: 'Elliott triple combo (WXYXZ)',
  hint: 'The origin, then W, X, Y, X and Z',
  icon: 'elliotttriplecombo',
  labels: ['', 'W', 'X', 'Y', 'X', 'Z'],
});

/* ─── Cycles ────────────────────────────────────────────────────────────── */

/** How many repeats a cycle tool draws before it stops. */
const CYCLE_REPEATS = 12;

export const cyclic = {
  id: 'cyclic',
  name: 'Cyclic lines',
  hint: 'Drag one cycle; the verticals repeat at that spacing',
  group: 'patterns',
  icon: 'cyclic',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    const step = b.x - a.x;
    if (step === 0) return false;
    // Which repeat the pointer is nearest, then how far off that line it is.
    const n = Math.round((at.x - a.x) / step);
    if (Math.abs(n) > CYCLE_REPEATS) return false;
    return Math.abs(at.x - (a.x + step * n)) <= HIT_TOLERANCE;
  },
  draw(ctx, { pts, size }) {
    const [a, b] = pts;
    if (!b) return;
    const step = b.x - a.x;
    if (step === 0) return;

    for (let n = -CYCLE_REPEATS; n <= CYCLE_REPEATS; n++) {
      const x = a.x + step * n;
      if (x < 0 || x > size.width) continue;
      ctx.setLineDash(n === 0 || n === 1 ? [] : [4, 4]);
      line(ctx, x, 0, x, size.height);
    }
    ctx.setLineDash([]);
  },
};

export const timecycles = {
  id: 'timecycles',
  name: 'Time cycles',
  hint: 'Drag one cycle; the arcs repeat at that spacing',
  group: 'patterns',
  icon: 'timecycles',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    const step = Math.abs(b.x - a.x);
    if (step === 0) return false;
    const radius = step / 2;
    // Every arc has its centre on the baseline; the nearest one decides.
    const n = Math.round((at.x - a.x) / step);
    if (Math.abs(n) > CYCLE_REPEATS) return false;
    const cx = a.x + step * n + Math.sign(b.x - a.x || 1) * radius;
    return Math.abs(Math.hypot(at.x - cx, at.y - a.y) - radius) <= HIT_TOLERANCE
      && at.y <= a.y + HIT_TOLERANCE;
  },
  draw(ctx, { pts, size }) {
    const [a, b] = pts;
    if (!b) return;
    const step = b.x - a.x;
    if (step === 0) return;
    const radius = Math.abs(step) / 2;

    line(ctx, 0, a.y, size.width, a.y);
    for (let n = -CYCLE_REPEATS; n <= CYCLE_REPEATS; n++) {
      const cx = a.x + step * n + step / 2;
      if (cx + radius < 0 || cx - radius > size.width) continue;
      ctx.beginPath();
      // Upper half only: the arc is a span of time, and the half below the
      // baseline would be the same span drawn twice.
      ctx.arc(cx, a.y, radius, Math.PI, 0);
      ctx.stroke();
    }
  },
};

/** How many samples a drawn sine gets per cycle. */
const SINE_STEPS = 96;

export const sineline = {
  id: 'sineline',
  name: 'Sine line',
  hint: 'Drag one half-cycle; the wave continues at that period',
  group: 'patterns',
  icon: 'sineline',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    return distanceToPolyline(at.x, at.y, sinePoints(a, b, 0, 4)) <= HIT_TOLERANCE;
  },
  draw(ctx, { pts, size }) {
    const [a, b] = pts;
    if (!b) return;
    const period = Math.abs(b.x - a.x) * 2;
    if (period < 2) return;
    // Enough cycles to cross the pane from the anchor, in both directions.
    const cycles = Math.ceil(size.width / period) + 1;
    polyline(ctx, sinePoints(a, b, -cycles, cycles));
  },
};

/**
 * The sine through two anchors.
 *
 * The drag is one half-cycle: the first anchor sits on the midline at a zero
 * crossing and the second at the following peak. So the amplitude is the
 * vertical distance between them and the period is twice the horizontal one,
 * which is the reading that makes a single drag define the whole wave.
 */
function sinePoints(a, b, fromCycle, toCycle) {
  const period = Math.abs(b.x - a.x) * 2;
  const amplitude = b.y - a.y;
  const direction = Math.sign(b.x - a.x || 1);
  const out = [];
  if (period === 0) return out;

  const total = (toCycle - fromCycle) * SINE_STEPS;
  for (let i = 0; i <= total; i++) {
    const cycle = fromCycle + (i / SINE_STEPS);
    const x = a.x + direction * cycle * period;
    out.push({ x, y: a.y + amplitude * Math.sin(cycle * Math.PI * 2) });
  }
  return out;
}

export default [
  xabcd, cypher, abcd, headshoulders, trianglepattern, threedrives,
  elliottimpulse, elliottcorrection, elliotttriangle,
  elliottdoublecombo, elliotttriplecombo,
  cyclic, timecycles, sineline,
];
