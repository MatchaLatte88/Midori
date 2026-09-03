/* The two tools that are not shapes at all.
 *
 * A fair value gap is picked rather than drawn — the market already decided
 * where it is, and the click only says which one. A range volume profile draws
 * nothing but a span here; the histogram inside it is a separate primitive
 * *underneath* the candles, because chrome the user placed belongs on top and a
 * distribution belongs behind.
 */
import { HIT_TOLERANCE, distanceToRectEdge, isInsideRect } from '../geometry.js';
import { fillRectAlpha, line } from '../render.js';

/* The midpoint of a gap, dashed finer than any stroke the style bar can hand
 * out so it never reads as one of the two edges. */
const MIDPOINT_DASH = [2, 4];

export const fvg = {
  id: 'fvg',
  name: 'Fair value gap',
  hint: 'Click an imbalance to mark it — the box snaps to the gap',
  group: 'special',
  icon: 'fvg',
  points: 2,
  /* One click, but two stored anchors: the gap supplies its own shape. This is
   * the only tool where the gesture collects fewer points than the drawing
   * keeps, and it cannot be bridged by a build() — the answer depends on the
   * bars, which no pure function of the gesture can see. useDrawings builds
   * those anchors instead; see placeFvg there. */
  gesture: 'pick',
  style: 'line',
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    // A marked gap is a rectangle in every way that matters here.
    return distanceToRectEdge(at.x, at.y, a.x, a.y, b.x, b.y) <= HIT_TOLERANCE
      || isInsideRect(at.x, at.y, a.x, a.y, b.x, b.y);
  },

  /**
   * Painted the way the FVG indicator paints the same zone — body filled, both
   * edges solid because those are the two prices anyone actually trades
   * against, midpoint dashed — so a gap the user pinned and a gap the indicator
   * found read as the same object rather than as a rectangle that happens to
   * sit there. Nothing is written on it: a gap is usually a few pixels tall and
   * there are a lot of them, so a label per box would cover the very candles
   * the zone is there to be read against.
   *
   * The two edges take whatever stroke the drawing was given, so the style bar
   * works on a gap the way it works on a line. The midpoint keeps its own dash:
   * it is a different statement from the edges — where consequent encroachment
   * sits, not where price stopped — and one that has to stay tellable apart
   * from them at every setting.
   */
  draw(ctx, { pts, color }) {
    const [a, b] = pts;
    if (!b) return;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    /* A gap thinner than a pixel is still a gap; without a floor it would
     * silently vanish on a zoomed-out chart. Same floor, and the same reason,
     * as in the indicator's own primitive. */
    const h = Math.max(1, Math.abs(b.y - a.y));

    fillRectAlpha(ctx, color, 0.13, x, y, w, h);

    // Half-pixel offsets keep a 1px line on the pixel, not across two. The
    // dash is the caller's — see the note above.
    line(ctx, x, y + 0.5, x + w, y + 0.5);
    line(ctx, x, y + h - 0.5, x + w, y + h - 0.5);

    // Any thinner and the midpoint has nowhere to sit that is not already a line.
    if (h > 6) {
      ctx.setLineDash(MIDPOINT_DASH);
      line(ctx, x, y + h / 2, x + w, y + h / 2);
    }
  },
};

export const rangeprofile = {
  id: 'rangeprofile',
  name: 'Range volume profile',
  hint: 'Drag across a stretch of chart to profile the volume traded in it',
  group: 'special',
  icon: 'rangeprofile',
  points: 2,
  gesture: 'drag',
  style: 'line',
  /* A range profile is grabbed over its whole span. Its box is drawn to the
   * height of the pane rather than to the anchors, but the anchors are what the
   * pointer tests against — they are where the handles are. */
  hit(pts, at) {
    const [a, b] = pts;
    if (!b) return false;
    return distanceToRectEdge(at.x, at.y, a.x, a.y, b.x, b.y) <= HIT_TOLERANCE
      || isInsideRect(at.x, at.y, a.x, a.y, b.x, b.y);
  },
  draw(ctx, { pts, color, size }) {
    const [a, b] = pts;
    if (!b) return;
    const x = Math.min(a.x, b.x);
    const w = Math.abs(b.x - a.x);
    fillRectAlpha(ctx, color, 0.05, x, 0, w, size.height);
    ctx.setLineDash([4, 3]);
    line(ctx, x, 0, x, size.height);
    line(ctx, x + w, 0, x + w, size.height);
    ctx.setLineDash([]);
  },
};

export default [fvg, rangeprofile];
