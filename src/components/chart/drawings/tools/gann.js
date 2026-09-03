/* Gann tools.
 *
 * Gann's geometry assumes price and time are commensurable — that a unit of
 * price can be as long as a unit of time, and a 1x1 line therefore runs at 45
 * degrees. Nothing on a modern chart guarantees that: the axes are scaled
 * independently and the user can change either. So every tool here takes its
 * unit from the drag rather than from the data. The first anchor is the origin
 * and the second defines what one unit is, in both axes at once; everything
 * else is a multiple of that.
 *
 * The consequence is that these shapes move with the zoom, which is exactly how
 * they behave everywhere else, and the alternative — inventing a fixed ratio
 * between dollars and minutes — would be worse because it would be invisible.
 */
import { HIT_TOLERANCE, distanceToRay, distanceToSegment } from '../geometry.js';
import { GANN_ANGLES, GANN_BOX_LEVELS } from '../model.js';
import { haloText, line, ray } from '../render.js';

/* ─── Gann box ──────────────────────────────────────────────────────────── */

/* A grid rather than a fan: the box is divided by the same ratios on both axes,
 * so the crossings mark where a price level and a time level coincide. */
export const gannbox = {
  id: 'gannbox',
  name: 'Gann box',
  hint: 'Drag the box; both axes are divided by the same ratios',
  group: 'gann',
  icon: 'gannbox',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    const inX = at.x >= Math.min(a.x, b.x) - HIT_TOLERANCE
      && at.x <= Math.max(a.x, b.x) + HIT_TOLERANCE;
    const inY = at.y >= Math.min(a.y, b.y) - HIT_TOLERANCE
      && at.y <= Math.max(a.y, b.y) + HIT_TOLERANCE;
    if (!inX || !inY) return false;
    return GANN_BOX_LEVELS.some((level) => (
      Math.abs(at.y - (a.y + (b.y - a.y) * level)) <= HIT_TOLERANCE
      || Math.abs(at.x - (a.x + (b.x - a.x) * level)) <= HIT_TOLERANCE
    ));
  },
  draw(ctx, { pts, color, chrome }) {
    const [a, b] = pts;
    if (!b) return;

    for (const level of GANN_BOX_LEVELS) {
      const y = a.y + (b.y - a.y) * level;
      const x = a.x + (b.x - a.x) * level;
      const edge = level === 0 || level === 1;

      ctx.setLineDash(edge ? [] : [4, 3]);
      ctx.lineWidth = level === 0.5 ? 1.5 : 1;
      line(ctx, a.x, y, b.x, y);
      line(ctx, x, a.y, x, b.y);
      ctx.setLineDash([]);

      if (!edge) {
        haloText(ctx, a.x + 3, y - 2, level.toFixed(3).replace(/0+$/, ''), color, chrome);
      }
    }

    // The two diagonals, which are the box's own 1x1 lines.
    ctx.setLineDash([2, 4]);
    line(ctx, a.x, a.y, b.x, b.y);
    line(ctx, a.x, b.y, b.x, a.y);
    ctx.setLineDash([]);
  },
};

/* ─── Gann fan ──────────────────────────────────────────────────────────── */

/* The drag sets the 1x1; every other angle is that slope multiplied by its
 * ratio. Drawn as rays, because the question a fan answers is where price will
 * be later, not where it was between two clicks. */
function fanTargets(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return GANN_ANGLES.map(({ label, ratio }) => ({
    label,
    ratio,
    to: { x: a.x + dx, y: a.y + dy * ratio },
  }));
}

export const gannfan = {
  id: 'gannfan',
  name: 'Gann fan',
  hint: 'Drag the 1x1 line; the rest of the angles follow from it',
  group: 'gann',
  icon: 'gannfan',
  points: 2,
  gesture: 'drag',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    return fanTargets(a, b).some(({ to }) => (
      distanceToRay(at.x, at.y, a.x, a.y, to.x, to.y) <= HIT_TOLERANCE
    ));
  },
  draw(ctx, { pts, color, size, chrome }) {
    const [a, b] = pts;
    if (!b) return;

    for (const { label, ratio, to } of fanTargets(a, b)) {
      // The 1x1 is the line the rest are measured against, so it leads.
      ctx.lineWidth = ratio === 1 ? 1.5 : 1;
      ctx.setLineDash(ratio === 1 ? [] : [4, 3]);
      ray(ctx, a.x, a.y, to.x, to.y, size);
      ctx.setLineDash([]);
      haloText(ctx, to.x + 4, to.y, label, color, chrome, 'left', 'middle');
    }
  },
};

/* ─── Gann square ───────────────────────────────────────────────────────── */

/**
 * The square's own box.
 *
 * `fixed` forces it square in pixels, which is what the "fixed" variant means:
 * the shape stays a square on screen however the drag was made, and the second
 * anchor only decides its size and which way it faces. The unfixed variant
 * takes the drag as given, so it is a rectangle whenever the drag was.
 */
function squareBox(a, b, fixed) {
  if (!fixed) return { x2: b.x, y2: b.y };
  const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  return {
    x2: a.x + Math.sign(b.x - a.x || 1) * side,
    y2: a.y + Math.sign(b.y - a.y || 1) * side,
  };
}

function gannSquare(id, name, hint, icon, fixed) {
  return {
    id,
    name,
    hint,
    group: 'gann',
    icon,
    points: 2,
    gesture: 'drag',
    style: 'line',
    hit(pts, at) {
      const [a, b] = pts;
      if (!b) return false;
      const { x2, y2 } = squareBox(a, b, fixed);
      const inside = at.x >= Math.min(a.x, x2) - HIT_TOLERANCE
        && at.x <= Math.max(a.x, x2) + HIT_TOLERANCE
        && at.y >= Math.min(a.y, y2) - HIT_TOLERANCE
        && at.y <= Math.max(a.y, y2) + HIT_TOLERANCE;
      if (!inside) return false;
      // Inside the frame, the diagonals and the mid-lines are what is grabbable.
      return distanceToSegment(at.x, at.y, a.x, a.y, x2, y2) <= HIT_TOLERANCE
        || distanceToSegment(at.x, at.y, a.x, y2, x2, a.y) <= HIT_TOLERANCE
        || Math.abs(at.x - (a.x + x2) / 2) <= HIT_TOLERANCE
        || Math.abs(at.y - (a.y + y2) / 2) <= HIT_TOLERANCE
        || Math.abs(at.x - a.x) <= HIT_TOLERANCE || Math.abs(at.x - x2) <= HIT_TOLERANCE
        || Math.abs(at.y - a.y) <= HIT_TOLERANCE || Math.abs(at.y - y2) <= HIT_TOLERANCE;
    },
    draw(ctx, { pts, color, chrome }) {
      const [a, b] = pts;
      if (!b) return;
      const { x2, y2 } = squareBox(a, b, fixed);
      const left = Math.min(a.x, x2);
      const top = Math.min(a.y, y2);
      const w = Math.abs(x2 - a.x);
      const h = Math.abs(y2 - a.y);
      const cx = left + w / 2;
      const cy = top + h / 2;

      ctx.strokeRect(left, top, w, h);

      // The cross and the two diagonals — the square's own 1x1s.
      ctx.setLineDash([4, 3]);
      line(ctx, left, cy, left + w, cy);
      line(ctx, cx, top, cx, top + h);
      line(ctx, left, top, left + w, top + h);
      line(ctx, left, top + h, left + w, top);
      ctx.setLineDash([]);

      /* The quarter arcs, which are what makes this a square rather than a box:
       * they carry the price rotation from one axis onto the other. */
      ctx.setLineDash([2, 4]);
      for (const r of [0.5, 1]) {
        ctx.beginPath();
        ctx.ellipse(left, top + h, w * r, h * r, 0, -Math.PI / 2, 0);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(left, top, w * r, h * r, 0, 0, Math.PI / 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      haloText(ctx, cx, top - 3, fixed ? 'Gann square (fixed)' : 'Gann square',
        color, chrome, 'center', 'bottom');
    },
  };
}

export const gannsquare = gannSquare(
  'gannsquare', 'Gann square',
  'Drag the box; it keeps the proportions of the drag', 'gannsquare', false,
);

export const gannsquarefixed = gannSquare(
  'gannsquarefixed', 'Gann square fixed',
  'Drag it out; it stays square on screen', 'gannsquarefixed', true,
);

export default [gannbox, gannfan, gannsquare, gannsquarefixed];
