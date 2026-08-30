/* Stop hunts drawn as a pane primitive.
 *
 * Same plugin route and the same zOrder as the other zone work — a hunt is
 * context the candles are read against, so it sits behind them — and the same
 * whole-index rule for horizontal placement, for the reason spelled out at
 * length in fvgPrimitive.js: logicalToCoordinate silently returns 0 for a
 * fractional index, so half-bar offsets are measured in pixels afterwards.
 *
 * Three moments, three marks
 * --------------------------
 * A hunt is not one event, it is three, and drawing it as a single box would
 * throw away the two that make it readable:
 *
 *   the line     from where the level formed to where it was run. Its length
 *                is how long that liquidity sat there being visible to
 *                everyone — a level swept eighty bars later is a different
 *                thing from one swept on the next candle.
 *   the raid     level to wick extreme, over the breaching bar. This is the
 *                actual stop hunt: the stretch of price that only traded to
 *                fill orders resting behind the level.
 *   the window   from the breaching bar to the confirming one, drawn faint.
 *                Empty when the same bar closed back inside, and that is the
 *                point — its width is the number of bars a trader spent not
 *                yet knowing whether this was a hunt or a break.
 *
 * A failed hunt keeps all three at half strength with a dashed outline, the
 * same vocabulary a mitigated gap uses in fvgPrimitive.js. It happened, it is
 * over, and the marks already stop where it ended.
 */

/* Opacity goes through globalAlpha and is never also baked into the colour —
 * doing both multiplies them. Same trap, same note, as fvgPrimitive.js. */
const RAID_ALPHA = 0.22;
const WINDOW_ALPHA = 0.07;
const EDGE_ALPHA = 0.7;
const LINE_ALPHA = 0.45;
/** A hunt price closed back through keeps a body, at half strength. */
const SPENT_RAID_ALPHA = 0.1;
const SPENT_EDGE_ALPHA = 0.4;
const SPENT_LINE_ALPHA = 0.22;

/** Reads palette token ids off the document once per paint. */
function paletteReader() {
  const s = getComputedStyle(document.documentElement);
  return (id) => s.getPropertyValue(`--${id}`).trim();
}

/**
 * The three x extents of one hunt, in pixels.
 *
 * The line stops where the raid box starts rather than running under it, so a
 * level and the bar that took it stay two marks rather than one smear. The
 * window starts where the raid ends and is empty when the breaching bar
 * confirmed on its own — right is then equal to left and nothing is painted.
 *
 * @param {object} hunt                  from detectStopHunts
 * @param {number} barSpacing            pixels per bar
 * @param {(index:number)=>number} indexToX  centre of a whole bar index
 */
export function huntExtent(hunt, barSpacing, indexToX) {
  const half = barSpacing / 2;
  const raidLeft = indexToX(hunt.sweepIndex) - half;
  return {
    lineLeft: indexToX(hunt.levelIndex) - half,
    lineRight: raidLeft,
    raidLeft,
    raidRight: indexToX(hunt.sweepIndex) + half,
    windowRight: indexToX(hunt.index) + half,
  };
}

class HuntRenderer {
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
        // Resolved per group rather than per hunt: one lookup, not four hundred.
        const bullColour = colour(group.bullColor);
        const bearColour = colour(group.bearColor);

        for (const hunt of group.hunts) {
          const ext = huntExtent(hunt, barSpacing, indexToX);
          // Wholly off one side of the pane — nothing to paint.
          if (ext.windowRight <= 0 || ext.lineLeft >= mediaSize.width) continue;

          const levelY = series.priceToCoordinate(hunt.level);
          const extremeY = series.priceToCoordinate(hunt.extreme);
          if (levelY == null || extremeY == null) continue;

          const top = Math.min(levelY, extremeY);
          /* A raid shallower than a pixel is still a raid; without a floor it
           * would silently vanish on a zoomed-out chart. */
          const height = Math.max(1, Math.abs(levelY - extremeY));

          const failed = hunt.invalidatedIndex != null;
          const c = hunt.direction === 'bull' ? bullColour : bearColour;

          /* The window first, so the raid box paints over its edge rather than
           * under it — they meet at a shared boundary. */
          if (ext.windowRight > ext.raidRight) {
            ctx.globalAlpha = failed ? WINDOW_ALPHA / 2 : WINDOW_ALPHA;
            ctx.fillStyle = c;
            ctx.fillRect(ext.raidRight, top, ext.windowRight - ext.raidRight, height);
          }

          // The level itself: how long the liquidity sat there in plain sight.
          if (ext.lineRight > ext.lineLeft) {
            ctx.globalAlpha = failed ? SPENT_LINE_ALPHA : LINE_ALPHA;
            ctx.strokeStyle = c;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            // Half-pixel offset keeps a 1px line on the pixel, not across two.
            ctx.moveTo(ext.lineLeft, levelY + 0.5);
            ctx.lineTo(ext.lineRight, levelY + 0.5);
            ctx.stroke();
            ctx.setLineDash([]);
          }

          // The raid: the prices that only ever traded to fill stops.
          const raidWidth = Math.max(1, ext.raidRight - ext.raidLeft);
          ctx.globalAlpha = failed ? SPENT_RAID_ALPHA : RAID_ALPHA;
          ctx.fillStyle = c;
          ctx.fillRect(ext.raidLeft, top, raidWidth, height);

          /* The level line is the price anyone actually trades against, so it
           * carries the reading — drawn solid across the raid and the window
           * both, which is the one mark that says where the hunt happened. */
          ctx.globalAlpha = failed ? SPENT_EDGE_ALPHA : EDGE_ALPHA;
          ctx.strokeStyle = c;
          ctx.lineWidth = 1;
          ctx.setLineDash(failed ? [3, 3] : []);
          ctx.beginPath();
          const levelEdgeY = hunt.direction === 'bear' ? top + height : top;
          ctx.moveTo(ext.raidLeft, levelEdgeY - 0.5);
          ctx.lineTo(ext.windowRight, levelEdgeY - 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }

      ctx.restore();
    });
  }
}

class HuntPaneView {
  constructor(source) {
    this._renderer = new HuntRenderer(source);
  }

  zOrder() {
    return 'bottom';
  }

  renderer() {
    return this._renderer;
  }
}

export class HuntPrimitive {
  constructor() {
    /** [{ hunts, bullColor, bearColor }] — one entry per hunt indicator. */
    this.groups = [];
    this.series = null;
    this.chart = null;
    this._requestUpdate = null;
    this._paneViews = [new HuntPaneView(this)];
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
