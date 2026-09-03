/* The Fibonacci family.
 *
 * Every one of these divides something by the same set of ratios; what differs
 * is what gets divided — a price move, a stretch of time, a distance from a
 * point, or an angle. The ratios live in geometry.js and model.js so no tool
 * here carries its own copy of them.
 *
 * Two of them are drawn in mixed units and it matters. A circle on a chart is
 * an ellipse: the horizontal axis is bars and the vertical is price, and there
 * is no ratio between the two. So the "radius" of a fib circle is a pixel
 * distance measured from the anchors as they currently sit, which means these
 * shapes change with the zoom. That is true of every charting package and is a
 * property of the tools, not of this implementation.
 */
import { FIB_LEVELS, HIT_TOLERANCE, distanceToCircle, distanceToRay, fibPrices } from '../geometry.js';
import { FIB_EXTENSION_LEVELS, FIB_SPEED_RATIOS, FIB_TIME_STEPS } from '../model.js';
import {
  fillRectAlpha, formatPrice, haloText, line, ray,
} from '../render.js';

/** Level lines that carry meaning are solid; the rest are dashed. */
function levelDash(level) {
  return level === 0 || level === 1 ? [] : [4, 3];
}

/** The 50 and 61.8 lines are the two anyone actually trades, so they lead. */
function levelWidth(level) {
  return level === 0.618 || level === 0.5 ? 1.5 : 1;
}

/* ─── Retracement ───────────────────────────────────────────────────────── */

export const fib = {
  id: 'fib',
  name: 'Fib retracement',
  hint: 'Drag from the start of a move to its end',
  group: 'fib',
  icon: 'fib',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    // Any of the level lines counts, across the drawn width.
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    if (at.x < left - HIT_TOLERANCE || at.x > right + HIT_TOLERANCE) return false;
    return FIB_LEVELS.some((level) => {
      const y = b.y + (a.y - b.y) * level;
      return Math.abs(at.y - y) <= HIT_TOLERANCE;
    });
  },
  draw(ctx, { pts, drawing, color, chrome }) {
    const [a, b] = pts;
    if (!b) return;
    const [from, to] = drawing.points;
    const levels = fibPrices(from.price, to.price, FIB_LEVELS);
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);

    for (const { level, price } of levels) {
      // Level fractions map linearly between the two anchor pixels.
      const y = b.y + (a.y - b.y) * level;
      ctx.setLineDash(levelDash(level));
      ctx.lineWidth = levelWidth(level);
      line(ctx, left, y, right, y);
      ctx.setLineDash([]);
      haloText(ctx, left + 4, y - 2,
        `${(level * 100).toFixed(1)}%  ${formatPrice(price)}`, color, chrome);
    }

    // Shade the body of the retracement so the zone reads at a glance.
    fillRectAlpha(ctx, color, 0.09, left, Math.min(a.y, b.y), right - left, Math.abs(b.y - a.y));
    ctx.fillStyle = color;
  },
};

/* ─── Trend-based extension ─────────────────────────────────────────────── */

/* Three anchors: the move, its retracement, and the point the projection is
 * measured from. Levels run past 1 because that is the question the tool
 * answers — where the next leg ends, not where this one pulls back to. */
export const fibextension = {
  id: 'fibextension',
  name: 'Trend-based fib extension',
  hint: 'Three points: the move, the pullback, and where the next leg starts',
  group: 'fib',
  icon: 'fibextension',
  points: 3,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 3) return false;
    const [a, b, c] = pts;
    if (at.x < Math.min(a.x, c.x) - HIT_TOLERANCE) return false;
    return FIB_EXTENSION_LEVELS.some((level) => (
      Math.abs(at.y - (c.y + (b.y - a.y) * level)) <= HIT_TOLERANCE
    ));
  },
  draw(ctx, { pts, drawing, color, chrome, size }) {
    if (pts.length < 3) return;
    const [a, b, c] = pts;
    const [pa, pb, pc] = drawing.points;

    // The two legs the projection is built on, drawn thin so they read as
    // scaffolding rather than as levels.
    ctx.setLineDash([2, 3]);
    line(ctx, a.x, a.y, b.x, b.y);
    line(ctx, b.x, b.y, c.x, c.y);

    const left = c.x;
    const right = size.width;
    for (const level of FIB_EXTENSION_LEVELS) {
      const y = c.y + (b.y - a.y) * level;
      const price = pc.price + (pb.price - pa.price) * level;
      ctx.setLineDash(levelDash(level));
      ctx.lineWidth = levelWidth(level);
      line(ctx, left, y, right, y);
      ctx.setLineDash([]);
      haloText(ctx, left + 4, y - 2,
        `${(level * 100).toFixed(1)}%  ${formatPrice(price)}`, color, chrome);
    }
  },
};

/* ─── Fib channel ───────────────────────────────────────────────────────── */

/* A retracement laid along a sloping baseline instead of across a flat one.
 * Anchors: the baseline, then a point that fixes the 100% line. */
export const fibchannel = {
  id: 'fibchannel',
  name: 'Fib channel',
  hint: 'Two points for the trend, a third for the 100% line',
  group: 'fib',
  icon: 'fibchannel',
  points: 3,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 3) return false;
    const [a, b, c] = pts;
    const offset = { x: c.x - a.x, y: c.y - a.y };
    return FIB_LEVELS.some((level) => {
      const p = { x: a.x + offset.x * level, y: a.y + offset.y * level };
      const q = { x: b.x + offset.x * level, y: b.y + offset.y * level };
      return distanceToRay(at.x, at.y, p.x, p.y, q.x, q.y) <= HIT_TOLERANCE;
    });
  },
  draw(ctx, { pts, color, chrome, size }) {
    if (pts.length < 3) return;
    const [a, b, c] = pts;
    const offset = { x: c.x - a.x, y: c.y - a.y };

    for (const level of FIB_LEVELS) {
      const p = { x: a.x + offset.x * level, y: a.y + offset.y * level };
      const q = { x: b.x + offset.x * level, y: b.y + offset.y * level };
      ctx.setLineDash(levelDash(level));
      ctx.lineWidth = levelWidth(level);
      ray(ctx, p.x, p.y, q.x, q.y, size);
      ctx.setLineDash([]);
      haloText(ctx, p.x + 4, p.y - 2, `${(level * 100).toFixed(1)}%`, color, chrome);
    }
  },
};

/* ─── Time-based ────────────────────────────────────────────────────────── */

/* The interval between the two anchors is one unit; the verticals stand at
 * fib multiples of it. Positions are computed in *pixels* from the two anchors,
 * so the spacing stays a fixed multiple of the drawn interval whatever the bar
 * spacing does. */
function timeTool(id, name, hint, icon, points, steps) {
  return {
    id,
    name,
    hint,
    group: 'fib',
    icon,
    points,
    gesture: points === 2 ? 'drag' : 'clicks',
    style: 'line',
    hit(pts, at) {
      if (pts.length < points) return false;
      const { origin, unit } = timeBasis(pts);
      if (unit === 0) return false;
      return steps.some((n) => Math.abs(at.x - (origin + unit * n)) <= HIT_TOLERANCE);
    },
    draw(ctx, { pts, color, chrome, size }) {
      if (pts.length < points) return;
      const { origin, unit } = timeBasis(pts);
      if (unit === 0) return;

      for (const n of steps) {
        const x = origin + unit * n;
        if (x < -HIT_TOLERANCE || x > size.width + HIT_TOLERANCE) continue;
        ctx.setLineDash(n === 0 || n === 1 ? [] : [4, 3]);
        line(ctx, x, 0, x, size.height);
        ctx.setLineDash([]);
        haloText(ctx, x + 3, size.height - 4, String(n), color, chrome, 'left', 'bottom');
      }
    },
  };
}

/**
 * Where the count starts and how wide one step is.
 *
 * A two-anchor tool counts from the first anchor. A three-anchor one measures
 * the unit from the first two and counts from the third, which is what makes it
 * a projection rather than a grid.
 */
function timeBasis(pts) {
  if (pts.length >= 3) return { origin: pts[2].x, unit: pts[1].x - pts[0].x };
  return { origin: pts[0].x, unit: pts[1].x - pts[0].x };
}

export const fibtimezone = timeTool(
  'fibtimezone', 'Fib time zones',
  'Drag one interval; the verticals stand at fib multiples of it',
  'fibtimezone', 2, FIB_TIME_STEPS,
);

export const fibtimeextension = timeTool(
  'fibtimeextension', 'Trend-based fib time',
  'Two points for the interval, a third for where the count starts',
  'fibtimeextension', 3, FIB_TIME_STEPS,
);

/* ─── Radial ────────────────────────────────────────────────────────────── */

/* Circles, arcs and the spiral all measure a pixel distance from the first
 * anchor. See the note at the top of this file for why that is the honest unit
 * here and what it costs. */

export const fibcircles = {
  id: 'fibcircles',
  name: 'Fib circles',
  hint: 'Drag from the centre of the move outwards',
  group: 'fib',
  icon: 'fibcircles',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    const radius = Math.hypot(b.x - a.x, b.y - a.y);
    return FIB_SPEED_RATIOS.some((r) => (
      distanceToCircle(at.x, at.y, a.x, a.y, radius * r) <= HIT_TOLERANCE
    ));
  },
  draw(ctx, { pts, color, chrome }) {
    const [a, b] = pts;
    if (!b) return;
    const radius = Math.hypot(b.x - a.x, b.y - a.y);
    for (const r of FIB_SPEED_RATIOS) {
      ctx.setLineDash(r === 1 ? [] : [4, 3]);
      ctx.beginPath();
      ctx.arc(a.x, a.y, radius * r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      haloText(ctx, a.x, a.y - radius * r - 2, r.toFixed(3).replace(/0+$/, ''),
        color, chrome, 'center', 'bottom');
    }
  },
};

/* Only the half of each circle that faces forward in time. A full circle behind
 * the anchor describes bars that have already happened, which is not what an
 * arc tool is asked. */
export const fibspeedarcs = {
  id: 'fibspeedarcs',
  name: 'Fib speed resistance arcs',
  hint: 'Arcs at fib fractions of the move, opening forward in time',
  group: 'fib',
  icon: 'fibspeedarcs',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    if ((at.x - a.x) * Math.sign(b.x - a.x || 1) < 0) return false;
    const radius = Math.hypot(b.x - a.x, b.y - a.y);
    return FIB_SPEED_RATIOS.some((r) => (
      distanceToCircle(at.x, at.y, a.x, a.y, radius * r) <= HIT_TOLERANCE
    ));
  },
  draw(ctx, { pts, color, chrome }) {
    const [a, b] = pts;
    if (!b) return;
    const radius = Math.hypot(b.x - a.x, b.y - a.y);
    const forward = b.x >= a.x;

    line(ctx, a.x, a.y, b.x, b.y);
    for (const r of FIB_SPEED_RATIOS) {
      ctx.setLineDash(r === 1 ? [] : [4, 3]);
      ctx.beginPath();
      ctx.arc(a.x, a.y, radius * r,
        forward ? -Math.PI / 2 : Math.PI / 2,
        forward ? Math.PI / 2 : (3 * Math.PI) / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      haloText(ctx, a.x + (forward ? radius * r : -radius * r), a.y - 3,
        r.toFixed(3).replace(/0+$/, ''), color, chrome, forward ? 'right' : 'left');
    }
  },
};

/* ─── Speed resistance fan and wedge ────────────────────────────────────── */

/* The fan divides the box the drag made: rays from the first corner through the
 * fib divisions of the far edge, in both axes. The wedge is the same divisions
 * kept inside the box rather than run past it. */
function fanRays(a, b) {
  const rays = [];
  for (const r of FIB_SPEED_RATIOS) {
    // Vertical divisions: along the far edge, at fib fractions of the height.
    rays.push({ label: `${r}`, to: { x: b.x, y: a.y + (b.y - a.y) * r } });
    // Horizontal divisions: along the bottom, at fib fractions of the width.
    rays.push({ label: `${r}`, to: { x: a.x + (b.x - a.x) * r, y: b.y } });
  }
  return rays;
}

export const fibspeedfan = {
  id: 'fibspeedfan',
  name: 'Fib speed resistance fan',
  hint: 'Drag the box of the move; the fan divides both of its axes',
  group: 'fib',
  icon: 'fibspeedfan',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    return fanRays(a, b).some(({ to }) => (
      distanceToRay(at.x, at.y, a.x, a.y, to.x, to.y) <= HIT_TOLERANCE
    ));
  },
  draw(ctx, { pts, color, size, chrome }) {
    const [a, b] = pts;
    if (!b) return;

    ctx.setLineDash([2, 3]);
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y),
      Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.setLineDash([]);

    for (const { label, to } of fanRays(a, b)) {
      ray(ctx, a.x, a.y, to.x, to.y, size);
      haloText(ctx, to.x, to.y, label, color, chrome, 'center', 'middle');
    }
  },
};

export const fibwedge = {
  id: 'fibwedge',
  name: 'Fib wedge',
  hint: 'Arcs and rays inside the wedge the drag opens',
  group: 'fib',
  icon: 'fibwedge',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    const radius = Math.hypot(b.x - a.x, b.y - a.y);
    const reach = Math.hypot(at.x - a.x, at.y - a.y);
    if (reach > radius + HIT_TOLERANCE) return false;
    return FIB_SPEED_RATIOS.some((r) => (
      distanceToCircle(at.x, at.y, a.x, a.y, radius * r) <= HIT_TOLERANCE
    ));
  },
  draw(ctx, { pts, color, chrome }) {
    const [a, b] = pts;
    if (!b) return;
    const radius = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    // The wedge opens symmetrically about the drag, a quarter turn wide.
    const half = Math.PI / 8;

    for (const r of FIB_SPEED_RATIOS) {
      ctx.setLineDash(r === 1 ? [] : [4, 3]);
      ctx.beginPath();
      ctx.arc(a.x, a.y, radius * r, angle - half, angle + half);
      ctx.stroke();
      ctx.setLineDash([]);

      // The ray that divides the wedge at this ratio.
      const spoke = angle - half + 2 * half * r;
      line(ctx, a.x, a.y, a.x + Math.cos(spoke) * radius, a.y + Math.sin(spoke) * radius);
      haloText(ctx, a.x + Math.cos(angle) * radius * r, a.y + Math.sin(angle) * radius * r,
        r.toFixed(3).replace(/0+$/, ''), color, chrome, 'center', 'middle');
    }
  },
};

/* ─── Spiral ────────────────────────────────────────────────────────────── */

/** Turns the spiral makes before it is cut off. Four is where it stops reading. */
const SPIRAL_TURNS = 4;
/** Golden ratio: the growth per turn. */
const PHI = 1.618033988749895;

export const fibspiral = {
  id: 'fibspiral',
  name: 'Fib spiral',
  hint: 'Drag from the centre; the spiral grows by the golden ratio each turn',
  group: 'fib',
  icon: 'fibspiral',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    const radius = Math.hypot(b.x - a.x, b.y - a.y);
    const reach = Math.hypot(at.x - a.x, at.y - a.y);
    // Anywhere inside the outermost turn counts: a spiral is a thin line that
    // nobody can be asked to click exactly, and there is nothing else there.
    return reach <= radius * PHI ** SPIRAL_TURNS + HIT_TOLERANCE;
  },
  draw(ctx, { pts }) {
    const [a, b] = pts;
    if (!b) return;
    const radius = Math.hypot(b.x - a.x, b.y - a.y);
    if (radius === 0) return;
    const start = Math.atan2(b.y - a.y, b.x - a.x);

    ctx.beginPath();
    const steps = SPIRAL_TURNS * 64;
    for (let i = 0; i <= steps; i++) {
      const turns = (i / steps) * SPIRAL_TURNS;
      const angle = start + turns * Math.PI * 2;
      const r = radius * PHI ** turns;
      const x = a.x + Math.cos(angle) * r;
      const y = a.y + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },
};

export default [
  fib, fibextension, fibchannel, fibtimezone, fibtimeextension,
  fibcircles, fibspeedarcs, fibspeedfan, fibwedge, fibspiral,
];
