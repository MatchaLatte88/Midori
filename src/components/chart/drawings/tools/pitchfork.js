/* Andrews' pitchfork and its variants.
 *
 * All five take the same three anchors — a pivot and the swing that followed it
 * — and differ only in where the handle starts and what is drawn from it. So
 * the geometry is written once and each variant supplies an origin.
 *
 * The variants follow the published definitions, which differ from each other
 * only in how the origin is shifted:
 *
 *   Standard   handle runs from A to M, the midpoint of B and C.
 *   Schiff     the origin is lifted halfway from A towards M in price only,
 *              keeping A's time — the handle flattens, the tines do not move.
 *   Modified   the origin is the midpoint of A and M in both axes.
 *   Inside     the handle runs between the two midpoints, A-B to B-C.
 *
 * Pitchfan is not a fork at all: it is a set of rays from A through fib
 * fractions of the B-C leg, and shares this file because it shares the anchors.
 */
import { HIT_TOLERANCE, distanceToRay, parallelPoint } from '../geometry.js';
import { FIB_SPEED_RATIOS } from '../model.js';
import { fillPolygonAlpha, haloText, line, ray } from '../render.js';

const BAND_ALPHA = 0.06;

/** Midpoint of two screen points. */
function mid(p, q) {
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
}

/**
 * The three lines of a fork: the median from the origin through M, and the two
 * tines through B and C running parallel to it.
 *
 * Each is returned as an anchored pair, since every one of them is drawn as a
 * ray rather than a segment.
 */
function forkLines(origin, b, c) {
  const m = mid(b, c);
  return {
    median: [origin, m],
    upper: [b, parallelPoint(origin, m, b)],
    lower: [c, parallelPoint(origin, m, c)],
  };
}

function paintFork(ctx, color, size, lines) {
  const { median, upper, lower } = lines;

  /* The band is filled out to a finite distance rather than to the rays' full
   * reach: a polygon twelve pane-widths across is filled pixel by pixel by the
   * canvas even though all but a sliver is clipped, and on a fork that sits
   * near the edge that cost showed up as dropped frames while panning. */
  const span = size.width + size.height;
  const stretch = ([p, q]) => {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * span, y: p.y + (dy / len) * span };
  };

  fillPolygonAlpha(ctx, color, BAND_ALPHA,
    [upper[0], stretch(upper), stretch(lower), lower[0]]);

  ray(ctx, upper[0].x, upper[0].y, upper[1].x, upper[1].y, size);
  ray(ctx, lower[0].x, lower[0].y, lower[1].x, lower[1].y, size);

  // The median is dashed: it is the line price is measured against, not one of
  // the two it travels between.
  const dash = ctx.getLineDash();
  ctx.setLineDash([5, 4]);
  ray(ctx, median[0].x, median[0].y, median[1].x, median[1].y, size);
  ctx.setLineDash(dash);

  // The handle — the segment from the origin to the swing it was built on.
  line(ctx, median[0].x, median[0].y, median[1].x, median[1].y);
}

function forkHit(originOf) {
  return (pts, at) => {
    if (pts.length < 3) return false;
    const [a, b, c] = pts;
    const { median, upper, lower } = forkLines(originOf(a, b, c), b, c);
    return [median, upper, lower].some(([p, q]) => (
      distanceToRay(at.x, at.y, p.x, p.y, q.x, q.y) <= HIT_TOLERANCE
    ));
  };
}

function fork(id, name, hint, icon, originOf) {
  return {
    id,
    name,
    hint,
    group: 'pitchfork',
    icon,
    points: 3,
    gesture: 'clicks',
    style: 'line',
    hit: forkHit(originOf),
    draw(ctx, { pts, color, size }) {
      if (pts.length < 3) return;
      const [a, b, c] = pts;
      paintFork(ctx, color, size, forkLines(originOf(a, b, c), b, c));
    },
  };
}

export const pitchfork = fork(
  'pitchfork', 'Pitchfork',
  "Three points: the pivot and the swing after it. Andrews' original",
  'pitchfork',
  (a) => a,
);

export const schiff = fork(
  'schiff', 'Schiff pitchfork',
  'The handle lifted halfway towards the swing, in price only',
  'schiff',
  (a, b, c) => ({ x: a.x, y: (a.y + mid(b, c).y) / 2 }),
);

export const modschiff = fork(
  'modschiff', 'Modified Schiff pitchfork',
  'The handle started from the midpoint of the pivot and the swing',
  'modschiff',
  (a, b, c) => mid(a, mid(b, c)),
);

export const insidepitchfork = fork(
  'insidepitchfork', 'Inside pitchfork',
  'The handle drawn between the two midpoints rather than from the pivot',
  'insidepitchfork',
  (a, b) => mid(a, b),
);

/* ─── Pitchfan ──────────────────────────────────────────────────────────── */

export const pitchfan = {
  id: 'pitchfan',
  name: 'Pitchfan',
  hint: 'Rays from the pivot through the fib divisions of the swing',
  group: 'pitchfork',
  icon: 'pitchfan',
  points: 3,
  gesture: 'clicks',
  style: 'line',
  hit(pts, at) {
    if (pts.length < 3) return false;
    const [a, b, c] = pts;
    return FIB_SPEED_RATIOS.some((r) => {
      const through = { x: b.x + (c.x - b.x) * r, y: b.y + (c.y - b.y) * r };
      return distanceToRay(at.x, at.y, a.x, a.y, through.x, through.y) <= HIT_TOLERANCE;
    });
  },
  draw(ctx, { pts, color, size, chrome }) {
    if (pts.length < 3) return;
    const [a, b, c] = pts;

    // The leg the fan is divided along, so the divisions have something visible
    // to belong to.
    const dash = ctx.getLineDash();
    ctx.setLineDash([2, 3]);
    line(ctx, b.x, b.y, c.x, c.y);
    ctx.setLineDash(dash);

    for (const r of FIB_SPEED_RATIOS) {
      const through = { x: b.x + (c.x - b.x) * r, y: b.y + (c.y - b.y) * r };
      ray(ctx, a.x, a.y, through.x, through.y, size);
      haloText(ctx, through.x + 4, through.y, r.toFixed(3).replace(/0+$/, ''),
        color, chrome, 'left', 'middle');
    }
  },
};

export default [pitchfork, schiff, modschiff, insidepitchfork, pitchfan];
