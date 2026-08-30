/* Fair value gaps drawn as a lightweight-charts pane primitive.
 *
 * A gap is a rectangle, not a series, so it cannot go through the library's
 * line series the way an SMA does — it is painted onto the chart canvas
 * through the plugin API: paneViews() -> renderer() -> draw().
 *
 * zOrder 'bottom', for the same reason as the volume profile: a zone is
 * context the candles are read against, never something drawn over them.
 *
 * Horizontal placement goes through logical indices rather than timestamps.
 * The zones come out of the very bar array the chart is showing, so their
 * indices *are* the logical coordinates — no lookup, and nothing to go stale
 * when older bars are paged in and every index shifts by the same amount.
 *
 * Only whole indices, though. `logicalToCoordinate` silently returns 0 for a
 * fractional one (it guards with `!isInteger(index)`, and 0 is a valid
 * coordinate, so nothing looks wrong) — asking it for index - 0.5 pins every
 * box to the left edge of the chart. Half-bar offsets are therefore measured
 * in pixels, after the whole index has been converted. `boxExtent` below is
 * the only place that arithmetic lives, and it is covered by tests.
 *
 * Colors are read from the CSS tokens on every draw, so a theme switch needs
 * no bookkeeping here.
 */

/* Opacity goes through globalAlpha and is never also baked into the colour.
 * Doing both multiplies them — the same trap documented at length in
 * drawings/drawingPrimitive.js, where a zone asked for at 0.13 came out at
 * 0.017. Going through globalAlpha alone also works with whatever colour
 * notation a token happens to hold. */
const FILL_ALPHA = 0.13;
const EDGE_ALPHA = 0.5;
/* A zone that has been filled or broken keeps a body, at half strength. It
 * used to get an outline only, which reads fine for the handful of filled gaps
 * on a chart — but a broken inversion is the normal case, not the exception
 * (677 of 718 on a month of BTC 15m), and a chart of hairlines is a chart
 * nobody can read. The box already ends where the zone ended; the dash and the
 * lighter body say which state it is in, they do not have to carry when. */
const SPENT_FILL_ALPHA = 0.06;
const SPENT_EDGE_ALPHA = 0.34;

/** Reads palette token ids off the document once per paint. */
function paletteReader() {
  const s = getComputedStyle(document.documentElement);
  return (id) => s.getPropertyValue(`--${id}`).trim();
}

/**
 * Horizontal extent of one zone's box, in pixels.
 *
 * The box starts half a bar left of the bar the zone is drawn from, and ends at
 * whichever comes first: the bar that filled it, or the width cap. With
 * neither, it runs to the right edge of the pane — cutting an unfilled zone off
 * at the last bar would read as "this ended here".
 *
 * The cap is measured from the box's own left edge — the bars that formed the
 * gap. `3` is three bars wide, whichever indicator asked for it. For an
 * inverted gap that means the box can stop well before the bar that broke the
 * gap, since the two can be hundreds of bars apart; that is deliberate. The
 * box marks the price level, and the level sits where the gap was.
 *
 * @param {object} zone                  from detectFairValueGaps
 * @param {object} view
 * @param {number} view.boxWidth         cap in bars; 0 = no cap
 * @param {number} view.barSpacing       pixels per bar
 * @param {(index:number)=>number} view.indexToX  centre of a whole bar index
 * @param {number} view.paneWidth
 */
export function boxExtent(zone, { boxWidth, barSpacing, indexToX, paneWidth }) {
  const left = indexToX(zone.startIndex) - barSpacing / 2;

  const limits = [];
  if (zone.mitigatedIndex != null) {
    limits.push(indexToX(zone.mitigatedIndex) + barSpacing / 2);
  }
  // Counted from the box's own left edge, so `3` is a box three bars wide.
  if (boxWidth > 0) limits.push(left + boxWidth * barSpacing);

  return { left, right: limits.length ? Math.min(...limits) : paneWidth };
}

class FvgRenderer {
  constructor(source) {
    this._source = source;
  }

  draw(target) {
    const { groups, series, chart } = this._source;
    if (!series || !chart || groups.length === 0) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const color = paletteReader();
      const timeScale = chart.timeScale();

      /* Bar width in pixels, read off two whole indices rather than the
       * barSpacing option, which does not follow a zoom. */
      const originX = timeScale.logicalToCoordinate(0);
      const nextX = timeScale.logicalToCoordinate(1);
      if (originX == null || nextX == null) return;
      const barSpacing = nextX - originX;
      if (!(barSpacing > 0)) return;

      const indexToX = (index) => originX + index * barSpacing;

      ctx.save();

      for (const group of groups) {
        // Resolved per group rather than per zone: one lookup, not four hundred.
        const bullColor = color(group.bullColor);
        const bearColor = color(group.bearColor);

        for (const zone of group.zones) {
          const { left, right } = boxExtent(zone, {
            boxWidth: group.boxWidth,
            barSpacing,
            indexToX,
            paneWidth: mediaSize.width,
          });
          // Wholly off one side of the pane — nothing to paint.
          if (right <= 0 || left >= mediaSize.width) continue;

          const topY = series.priceToCoordinate(zone.top);
          const bottomY = series.priceToCoordinate(zone.bottom);
          if (topY == null || bottomY == null) continue;

          const x = left;
          const w = right - left;
          const y = topY;
          // A gap thinner than a pixel is still a gap; without a floor it
          // would silently vanish on a zoomed-out chart.
          const h = Math.max(1, bottomY - topY);

          const bull = zone.direction === 'bull';
          const mitigated = zone.mitigatedIndex != null;
          const zoneColor = bull ? bullColor : bearColor;

          ctx.globalAlpha = mitigated ? SPENT_FILL_ALPHA : FILL_ALPHA;
          ctx.fillStyle = zoneColor;
          ctx.fillRect(x, y, w, h);

          // The edges are the two prices anyone actually trades against, so
          // they carry the reading.
          ctx.globalAlpha = mitigated ? SPENT_EDGE_ALPHA : EDGE_ALPHA;
          ctx.strokeStyle = zoneColor;
          ctx.lineWidth = 1;
          ctx.setLineDash(mitigated ? [3, 3] : []);
          ctx.beginPath();
          // Half-pixel offsets keep a 1px line on the pixel, not across two.
          ctx.moveTo(x, y + 0.5);
          ctx.lineTo(x + w, y + 0.5);
          ctx.moveTo(x, y + h - 0.5);
          ctx.lineTo(x + w, y + h - 0.5);
          ctx.stroke();

          /* The midpoint is only drawn when it is the rule in force. Showing
           * it always would put a line on the chart that means nothing under
           * the other two mitigation settings. */
          if (group.midline && !mitigated && h > 6) {
            ctx.setLineDash([2, 4]);
            ctx.beginPath();
            ctx.moveTo(x, y + h / 2);
            ctx.lineTo(x + w, y + h / 2);
            ctx.stroke();
          }
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }

      ctx.restore();
    });
  }
}

class FvgPaneView {
  constructor(source) {
    this._renderer = new FvgRenderer(source);
  }

  zOrder() {
    return 'bottom';
  }

  renderer() {
    return this._renderer;
  }
}

export class FvgPrimitive {
  constructor() {
    /** [{ zones, midline, boxWidth, bullColor, bearColor }] — one per indicator. */
    this.groups = [];
    this.series = null;
    this.chart = null;
    this._requestUpdate = null;
    this._paneViews = [new FvgPaneView(this)];
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
