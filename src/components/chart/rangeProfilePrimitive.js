/* Range volume profiles — one histogram per drawn span.
 *
 * The panel's volume profile answers "where has this symbol traded", pinned to
 * the right edge of the chart. This one answers "where did it trade *there*",
 * over a stretch the user drew. Same computation in the main process, same 1m
 * bars underneath; only the window and the placement differ.
 *
 * Drawn at zOrder 'bottom' like the panel profile, for the same reason: a
 * profile is context the candles are read against. That is also why it is a
 * separate primitive from drawings/drawingPrimitive.js, which sits on top —
 * a level someone placed by hand belongs above the candles, a distribution
 * belongs behind them.
 *
 * Vertical extent comes from the data, not from the drag
 * -----------------------------------------------------
 * The two anchors fix a time span. The box is then drawn to the price range the
 * bars in that span actually covered. Honouring the drag's height instead would
 * silently drop every trade above or below it, and a profile missing volume
 * puts its point of control in the wrong place — the one number the whole tool
 * exists to produce. The anchors still carry prices, because that is what a
 * drawing is, and the handles need somewhere to sit.
 */

const MIN_BAR_HEIGHT = 1;
/** Share of the span's width the busiest level may take. */
const WIDTH_FRACTION = 0.9;

function tokens() {
  const s = getComputedStyle(document.documentElement);
  const v = (name) => s.getPropertyValue(name).trim();
  return {
    bar: v('--vp-bar'),
    barVa: v('--vp-bar-va'),
    poc: v('--vp-poc'),
  };
}

class RangeProfileRenderer {
  constructor(source) {
    this._source = source;
  }

  draw(target) {
    const { entries, series, project } = this._source;
    if (!series || !project || entries.length === 0) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const c = tokens();
      ctx.save();

      for (const { drawing, profile } of entries) {
        if (!profile || profile.totalVolume <= 0) continue;

        const [a, b] = drawing.points.map(project);
        if (!a || !b) continue;

        const left = Math.min(a.x, b.x);
        const right = Math.max(a.x, b.x);
        if (right <= 0 || left >= mediaSize.width || right - left < 2) continue;

        this._drawOne(ctx, c, profile, left, right);
      }

      ctx.restore();
    });
  }

  _drawOne(ctx, c, profile, left, right) {
    const series = this._source.series;
    const { volumes, bins, binHeight, priceMin, maxBinVolume, poc, valueArea } = profile;
    if (maxBinVolume <= 0) return;

    const topY = series.priceToCoordinate(priceMin + bins * binHeight);
    const bottomY = series.priceToCoordinate(priceMin);
    if (topY == null || bottomY == null) return;

    const pixelsPerBin = (bottomY - topY) / bins;
    const gap = pixelsPerBin > 3 ? 1 : 0;
    const maxWidth = (right - left) * WIDTH_FRACTION;

    // Bars grow rightwards from the start of the span: the eye reads the span
    // left to right, and so should the distribution inside it.
    for (let i = 0; i < bins; i++) {
      const volume = volumes[i];
      if (volume <= 0) continue;

      const y = bottomY - (i + 1) * pixelsPerBin;
      const h = Math.max(MIN_BAR_HEIGHT, pixelsPerBin - gap);
      const w = (volume / maxBinVolume) * maxWidth;

      const inValueArea = valueArea && i >= valueArea.lowIndex && i <= valueArea.highIndex;
      ctx.fillStyle = inValueArea ? c.barVa : c.bar;
      ctx.fillRect(left, y, w, h);
    }

    if (poc) {
      const y = bottomY - (poc.index + 0.5) * pixelsPerBin;
      ctx.fillStyle = c.poc;
      ctx.fillRect(left, y - Math.max(0.5, pixelsPerBin / 2), maxWidth, Math.max(1, pixelsPerBin));
    }
  }
}

class RangeProfilePaneView {
  constructor(source) {
    this._renderer = new RangeProfileRenderer(source);
  }

  zOrder() {
    return 'bottom';
  }

  renderer() {
    return this._renderer;
  }
}

export class RangeProfilePrimitive {
  constructor() {
    /** [{ drawing, profile }] — one per drawn span that has a result yet. */
    this.entries = [];
    this.series = null;
    /** Set by the chart: market coordinates -> pixels, same one the drawings use. */
    this.project = null;
    this._requestUpdate = null;
    this._paneViews = [new RangeProfilePaneView(this)];
  }

  attached({ series, requestUpdate }) {
    this.series = series;
    this._requestUpdate = requestUpdate;
  }

  detached() {
    this.series = null;
    this._requestUpdate = null;
  }

  setEntries(entries) {
    this.entries = entries;
    this._requestUpdate?.();
  }

  /** Repaints without changing the data — used when the theme flips. */
  repaint() {
    this._requestUpdate?.();
  }

  paneViews() {
    return this._paneViews;
  }
}

/**
 * The time window a range profile covers, ordered, in milliseconds.
 *
 * Drawing anchors are already in milliseconds — `useDrawings` converts on the
 * way out of the chart, which stores seconds — so this only has to put the two
 * in order. A span dragged right to left means the same window as one dragged
 * left to right, and the data process refuses a range that ends before it
 * starts.
 *
 * @param {{points: Array<{time:number}>}} drawing
 */
export function profileWindow(drawing) {
  const [a, b] = drawing.points;
  return {
    from: Math.min(a.time, b.time),
    to: Math.max(a.time, b.time),
  };
}

/**
 * Identity of a request, so a profile is only recomputed when its span or the
 * settings behind it actually moved. Selecting a box, or dragging a different
 * one, must not refetch this one.
 */
export function windowKey(drawing, options = {}) {
  const { from, to } = profileWindow(drawing);
  const { bins, valueArea, distribution } = options;
  return `${drawing.id}:${from}:${to}:${bins}:${valueArea}:${distribution}`;
}
