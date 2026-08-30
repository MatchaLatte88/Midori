/* Trading sessions drawn as bands across the chart.
 *
 * Same plugin route and the same zOrder as the other zone work: a session is
 * context, so it sits behind the candles. Horizontal placement goes through
 * whole logical indices for the reason spelled out in fvgPrimitive.js —
 * logicalToCoordinate silently returns 0 for a fractional one — so half-bar
 * offsets are done in pixels after the conversion.
 *
 * Two shapes, one band
 * --------------------
 * 'range' draws the box the session actually traded in, which is what a trader
 * marks up: the Asia high and low are levels, the hours themselves are not.
 * 'full' draws the hours alone, floor to ceiling, for reading when something
 * happened rather than where. The label rides at the top of whichever box it is.
 */

const FILL_ALPHA = 0.09;
const EDGE_ALPHA = 0.45;
const LABEL_ALPHA = 0.85;
/** Below this width a band is a sliver; its name would not fit anyway. */
const LABEL_MIN_WIDTH = 34;

function paletteReader() {
  const s = getComputedStyle(document.documentElement);
  return (id) => s.getPropertyValue(`--${id}`).trim();
}

class SessionRenderer {
  constructor(source) {
    this._source = source;
  }

  draw(target) {
    const { groups, series, chart } = this._source;
    if (!series || !chart || groups.length === 0) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const timeScale = chart.timeScale();
      const originX = timeScale.logicalToCoordinate(0);
      const nextX = timeScale.logicalToCoordinate(1);
      if (originX == null || nextX == null) return;
      const barSpacing = nextX - originX;
      if (!(barSpacing > 0)) return;

      const colour = paletteReader();
      const indexToX = (index) => originX + index * barSpacing;

      ctx.save();
      ctx.font = '10px "DM Mono", ui-monospace, monospace';
      ctx.textBaseline = 'top';

      for (const { sessions, options } of groups) {
        for (const session of sessions) {
          const left = indexToX(session.startIndex) - barSpacing / 2;
          const right = indexToX(session.endIndex) + barSpacing / 2;
          if (right <= 0 || left >= mediaSize.width) continue;

          let top = 0;
          let bottom = mediaSize.height;
          if (options.extent === 'range') {
            const high = series.priceToCoordinate(session.high);
            const low = series.priceToCoordinate(session.low);
            if (high == null || low == null) continue;
            top = high;
            bottom = low;
          }

          const width = right - left;
          const height = Math.max(1, bottom - top);
          const c = colour(session.color);

          ctx.globalAlpha = FILL_ALPHA;
          ctx.fillStyle = c;
          ctx.fillRect(left, top, width, height);

          /* Only the vertical edges for a full-height band — a line along the top
           * of the chart marks nothing. A range box gets all four, because its
           * high and low are the levels worth seeing. */
          ctx.globalAlpha = EDGE_ALPHA;
          ctx.strokeStyle = c;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(left + 0.5, top);
          ctx.lineTo(left + 0.5, top + height);
          ctx.moveTo(right - 0.5, top);
          ctx.lineTo(right - 0.5, top + height);
          if (options.extent === 'range') {
            ctx.moveTo(left, top + 0.5);
            ctx.lineTo(right, top + 0.5);
            ctx.moveTo(left, top + height - 0.5);
            ctx.lineTo(right, top + height - 0.5);
          }
          ctx.stroke();

          if (options.labels === 'on' && width >= LABEL_MIN_WIDTH) {
            ctx.globalAlpha = LABEL_ALPHA;
            ctx.fillStyle = c;
            // Clipped to its own band so a name never runs into the next one.
            ctx.save();
            ctx.beginPath();
            ctx.rect(left, top, width, height);
            ctx.clip();
            ctx.fillText(session.name, left + 4, top + 3);
            ctx.restore();
          }
          ctx.globalAlpha = 1;
        }
      }

      ctx.restore();
    });
  }
}

class SessionPaneView {
  constructor(source) {
    this._renderer = new SessionRenderer(source);
  }

  zOrder() {
    return 'bottom';
  }

  renderer() {
    return this._renderer;
  }
}

export class SessionPrimitive {
  constructor() {
    /** [{ sessions, options }] — one entry per session indicator on the chart. */
    this.groups = [];
    this.series = null;
    this.chart = null;
    this._requestUpdate = null;
    this._paneViews = [new SessionPaneView(this)];
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

  setGroups(groups) {
    this.groups = groups;
    this._requestUpdate?.();
  }

  paneViews() {
    return this._paneViews;
  }
}
