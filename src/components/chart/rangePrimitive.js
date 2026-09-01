/* Ranges drawn as a pane primitive.
 *
 * Same plugin route and the same zOrder as the other zone work — a range is
 * context the candles are read against, so it sits behind them — and the same
 * whole-index rule for horizontal placement, for the reason spelled out at
 * length in fvgPrimitive.js: logicalToCoordinate silently returns 0 for a
 * fractional index, so half-bar offsets are measured in pixels afterwards.
 *
 * Four marks
 * ----------
 *   the box     the stretch itself, from the first bar to the last one inside
 *               it. Unlike a gap, a range does not run to the right edge of
 *               the pane: it happened over a definite number of bars and its
 *               width is the readable part of it.
 *   equilibrium the midpoint, dashed. The line premium and discount split on,
 *               and the level a range gets traded back to more than any other.
 *   the tail    for a range still running at the right edge, both edges
 *               continue dashed to the edge of the pane. The box says where it
 *               has been; the tail says the levels are still live.
 *   the break   from the edge that gave way to the close that broke it, over
 *               the breaking bar. The mirror of the raid box in
 *               huntPrimitive.js, and read the same way: the stretch of price
 *               that says which side won.
 *
 * The box keeps one colour whatever happened afterwards. Colouring a range by
 * the way it eventually broke would paint a reading onto bars that did not
 * have it yet, which is the visual form of the look-ahead the detector is
 * careful to avoid.
 */

/* Opacity goes through globalAlpha and is never also baked into the colour —
 * doing both multiplies them. Same trap, same note, as fvgPrimitive.js. */
const FILL_ALPHA = 0.1;
const EDGE_ALPHA = 0.55;
const MIDDLE_ALPHA = 0.3;
const TAIL_ALPHA = 0.4;
const BREAK_FILL_ALPHA = 0.3;
const BREAK_EDGE_ALPHA = 0.9;
/** Below this the box is a line, and a dashed midpoint inside it is noise. */
const MIN_MIDDLE_HEIGHT = 10;

/** Reads palette token ids off the document once per paint. */
function paletteReader() {
  const s = getComputedStyle(document.documentElement);
  return (id) => s.getPropertyValue(`--${id}`).trim();
}

/**
 * The horizontal extents of one range, in pixels.
 *
 * The box spans whole bars: half a bar left of the first one and half a bar
 * right of the last, so its edges sit between candles rather than through
 * them. The break box is exactly the breaking bar, and it begins where the box
 * ends — the two meet without a seam, because the breaking bar is the very
 * next bar after the last one inside.
 *
 * @param {object} range                 from detectRanges
 * @param {number} barSpacing            pixels per bar
 * @param {(index:number)=>number} indexToX  centre of a whole bar index
 */
export function rangeExtent(range, barSpacing, indexToX) {
  const half = barSpacing / 2;
  const hasBreak = range.breakIndex != null;
  return {
    left: indexToX(range.startIndex) - half,
    right: indexToX(range.endIndex) + half,
    breakLeft: hasBreak ? indexToX(range.breakIndex) - half : null,
    breakRight: hasBreak ? indexToX(range.breakIndex) + half : null,
  };
}

class RangeRenderer {
  constructor(source) {
    this._source = source;
  }

  draw(target) {
    const { groups, series, chart } = this._source;
    if (!series || !chart || groups.length === 0) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const colour = paletteReader();
      const timeScale = chart.timeScale();

      /* Bar width read off two whole indices rather than the barSpacing
       * option, which does not follow a zoom. */
      const originX = timeScale.logicalToCoordinate(0);
      const nextX = timeScale.logicalToCoordinate(1);
      if (originX == null || nextX == null) return;
      const barSpacing = nextX - originX;
      if (!(barSpacing > 0)) return;

      const indexToX = (index) => originX + index * barSpacing;

      ctx.save();

      for (const group of groups) {
        // Resolved per group rather than per range: one lookup, not four hundred.
        const boxColour = colour(group.color);
        const bullColour = colour(group.bullColor);
        const bearColour = colour(group.bearColor);

        for (const range of group.ranges) {
          const ext = rangeExtent(range, barSpacing, indexToX);
          const rightMost = ext.breakRight ?? (range.active ? mediaSize.width : ext.right);
          // Wholly off one side of the pane — nothing to paint.
          if (rightMost <= 0 || ext.left >= mediaSize.width) continue;

          const topY = series.priceToCoordinate(range.top);
          const bottomY = series.priceToCoordinate(range.bottom);
          if (topY == null || bottomY == null) continue;

          const x = ext.left;
          const w = Math.max(1, ext.right - ext.left);
          /* A range flatter than a pixel is still a range; without a floor it
           * would silently vanish on a zoomed-out chart. */
          const h = Math.max(1, bottomY - topY);

          ctx.globalAlpha = FILL_ALPHA;
          ctx.fillStyle = boxColour;
          ctx.fillRect(x, topY, w, h);

          /* The tail first, so the box edges paint over where the two meet
           * rather than under. Only a range that is still running has one. */
          if (range.active && mediaSize.width > ext.right) {
            ctx.globalAlpha = TAIL_ALPHA;
            ctx.strokeStyle = boxColour;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            // Half-pixel offsets keep a 1px line on the pixel, not across two.
            ctx.moveTo(ext.right, topY + 0.5);
            ctx.lineTo(mediaSize.width, topY + 0.5);
            ctx.moveTo(ext.right, topY + h - 0.5);
            ctx.lineTo(mediaSize.width, topY + h - 0.5);
            ctx.stroke();
            ctx.setLineDash([]);
          }

          // Equilibrium — the level a range is traded back to.
          if (h >= MIN_MIDDLE_HEIGHT) {
            const middleY = series.priceToCoordinate(range.middle);
            if (middleY != null) {
              ctx.globalAlpha = MIDDLE_ALPHA;
              ctx.strokeStyle = boxColour;
              ctx.lineWidth = 1;
              ctx.setLineDash([2, 4]);
              ctx.beginPath();
              ctx.moveTo(x, middleY + 0.5);
              ctx.lineTo(range.active ? mediaSize.width : ext.right, middleY + 0.5);
              ctx.stroke();
              ctx.setLineDash([]);
            }
          }

          // The edges are the two prices anyone trades against, so they carry
          // the reading.
          ctx.globalAlpha = EDGE_ALPHA;
          ctx.strokeStyle = boxColour;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, topY + 0.5);
          ctx.lineTo(x + w, topY + 0.5);
          ctx.moveTo(x, topY + h - 0.5);
          ctx.lineTo(x + w, topY + h - 0.5);
          ctx.stroke();

          if (range.breakIndex == null) { ctx.globalAlpha = 1; continue; }

          /* The break: from the edge that gave way to the close that broke it.
           * Its height is how decisively the bar left, which is the one thing
           * about a breakout that is visible before anything else happens. */
          const up = range.breakDirection === 'up';
          const edgeY = up ? topY : topY + h;
          const closeY = series.priceToCoordinate(range.breakClose);
          if (closeY == null) { ctx.globalAlpha = 1; continue; }

          const breakColour = up ? bullColour : bearColour;
          const bx = ext.breakLeft;
          const bw = Math.max(1, ext.breakRight - ext.breakLeft);
          const by = Math.min(edgeY, closeY);
          const bh = Math.max(1, Math.abs(closeY - edgeY));

          ctx.globalAlpha = BREAK_FILL_ALPHA;
          ctx.fillStyle = breakColour;
          ctx.fillRect(bx, by, bw, bh);

          // The close is the price that settled it, so it gets the solid line.
          ctx.globalAlpha = BREAK_EDGE_ALPHA;
          ctx.strokeStyle = breakColour;
          ctx.lineWidth = 1;
          ctx.beginPath();
          const settledY = up ? by + 0.5 : by + bh - 0.5;
          ctx.moveTo(bx, settledY);
          ctx.lineTo(bx + bw, settledY);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      ctx.restore();
    });
  }
}

class RangePaneView {
  constructor(source) {
    this._renderer = new RangeRenderer(source);
  }

  zOrder() {
    return 'bottom';
  }

  renderer() {
    return this._renderer;
  }
}

export class RangePrimitive {
  constructor() {
    /** [{ ranges, color, bullColor, bearColor }] — one entry per range indicator. */
    this.groups = [];
    this.series = null;
    this.chart = null;
    this._requestUpdate = null;
    this._paneViews = [new RangePaneView(this)];
  }

  attached({ chart, series, requestUpdate }) {
    this.chart = chart;
    this.series = series;
    this._requestUpdate = requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this._requestUpdate = null;
  }

  /** Replaces every group and asks the chart to repaint. */
  setGroups(groups) {
    this.groups = groups;
    this._requestUpdate?.();
  }

  paneViews() {
    // Same array every time — the library caches on identity.
    return this._paneViews;
  }
}
