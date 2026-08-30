/* Silver Bullet setups drawn as a pane primitive.
 *
 * Same plugin route, zOrder and whole-index rule as the other overlays — see
 * fvgPrimitive.js for why half-bar offsets are measured in pixels after the
 * conversion rather than asked for in logical space.
 *
 * What a setup looks like
 * -----------------------
 * A setup is a story with a beginning and an outcome, so it is drawn as two
 * joined parts rather than one box:
 *
 *   the run-up   from the sweep to the entry: a tick at the wick that took the
 *                liquidity, and the gap the reversal left behind. Painted in
 *                the setup's direction colour, because that half is about
 *                which way the market turned.
 *   the block    from the entry onwards: risk zone, reward zone, entry line.
 *                This is the same shape the position drawing tool makes, and
 *                deliberately so — a setup the indicator found and a trade you
 *                planned by hand should not need two visual vocabularies.
 *
 * Colour follows the same rule as that tool: the stop side takes the loss
 * colour and the target side the profit colour, so a short reads the same way
 * round as a long. Direction colour belongs to the run-up, outcome colour to
 * the block, and the two never mix.
 *
 * The block ends where the trade ended — at the bar that hit the stop or the
 * target. A setup still open runs to the right edge, because cutting it off at
 * the last bar would read as "this finished here".
 */

/* Opacity goes through globalAlpha and is never also baked into the colour;
 * doing both multiplies them. Same note as fvgPrimitive.js. */
const GAP_FILL_ALPHA = 0.16;
const ZONE_FILL_ALPHA = 0.13;
const EDGE_ALPHA = 0.6;
const LINE_ALPHA = 0.5;
/** A losing setup keeps its shape at reduced strength — it happened, it is over. */
const SPENT_SCALE = 0.55;
/** Below this width the labels do not fit and are left off rather than clipped. */
const LABEL_MIN_WIDTH = 46;

function paletteReader() {
  const s = getComputedStyle(document.documentElement);
  return (id) => s.getPropertyValue(`--${id}`).trim();
}

/**
 * The horizontal extents of one setup, in pixels.
 *
 * The gap box stops at the entry rather than running under the block: past the
 * entry the gap is no longer a level being waited for, it is a trade. The
 * block then runs from the entry to whichever bar resolved it.
 *
 * @param {object} setup                  from detectSilverBullet
 * @param {number} barSpacing             pixels per bar
 * @param {(index:number)=>number} indexToX   centre of a whole bar index
 * @param {number} paneWidth
 */
export function setupExtent(setup, barSpacing, indexToX, paneWidth) {
  const half = barSpacing / 2;
  const entryX = indexToX(setup.entryIndex) - half;

  return {
    sweepX: indexToX(setup.sweepIndex),
    gapLeft: indexToX(setup.gapStartIndex) - half,
    gapRight: entryX,
    blockLeft: entryX,
    // An unresolved setup runs on; a resolved one stops half a bar past its end.
    blockRight: setup.outcomeIndex == null
      ? paneWidth
      : indexToX(setup.outcomeIndex) + half,
  };
}

class SetupRenderer {
  constructor(source) {
    this._source = source;
  }

  draw(target) {
    const { groups, series, chart } = this._source;
    if (!series || !chart || groups.length === 0) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const colour = paletteReader();
      const timeScale = chart.timeScale();

      const originX = timeScale.logicalToCoordinate(0);
      const nextX = timeScale.logicalToCoordinate(1);
      if (originX == null || nextX == null) return;
      const barSpacing = nextX - originX;
      if (!(barSpacing > 0)) return;

      const indexToX = (index) => originX + index * barSpacing;
      // Meaning, not direction — the position tool's rule.
      const profit = colour('pos');
      const loss = colour('neg');

      ctx.save();
      ctx.font = '10px "DM Mono", ui-monospace, monospace';

      for (const group of groups) {
        const bullColour = colour(group.bullColor);
        const bearColour = colour(group.bearColor);

        for (const setup of group.setups) {
          const ext = setupExtent(setup, barSpacing, indexToX, mediaSize.width);
          if (ext.blockRight <= 0 || ext.gapLeft >= mediaSize.width) continue;

          const y = {
            entry: series.priceToCoordinate(setup.entryPrice),
            stop: series.priceToCoordinate(setup.stop),
            target: series.priceToCoordinate(setup.target),
            gapTop: series.priceToCoordinate(setup.gapTop),
            gapBottom: series.priceToCoordinate(setup.gapBottom),
            sweep: series.priceToCoordinate(setup.sweepExtreme),
          };
          if (Object.values(y).some((v) => v == null)) continue;

          const lost = setup.outcome === 'stop';
          const dim = lost ? SPENT_SCALE : 1;
          const dirColour = setup.direction === 'bull' ? bullColour : bearColour;

          this._runUp(ctx, ext, y, dirColour, dim, barSpacing);
          this._block(ctx, ext, y, { profit, loss, dim, setup });
        }
      }

      ctx.restore();
    });
  }

  /** The sweep tick and the gap the reversal left behind. */
  _runUp(ctx, ext, y, colour, dim, barSpacing) {
    // The gap, from the bars that formed it up to the entry.
    const top = Math.min(y.gapTop, y.gapBottom);
    const height = Math.max(1, Math.abs(y.gapBottom - y.gapTop));
    const width = ext.gapRight - ext.gapLeft;

    if (width > 0) {
      ctx.globalAlpha = GAP_FILL_ALPHA * dim;
      ctx.fillStyle = colour;
      ctx.fillRect(ext.gapLeft, top, width, height);

      ctx.globalAlpha = EDGE_ALPHA * dim;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.beginPath();
      // Half-pixel offsets keep a 1px line on the pixel, not across two.
      ctx.moveTo(ext.gapLeft, top + 0.5);
      ctx.lineTo(ext.gapLeft + width, top + 0.5);
      ctx.moveTo(ext.gapLeft, top + height - 0.5);
      ctx.lineTo(ext.gapLeft + width, top + height - 0.5);
      ctx.stroke();
    }

    /* A tick at the wick that took the liquidity — where the whole setup
     * started, and the price the stop is measured from. */
    ctx.globalAlpha = EDGE_ALPHA * dim;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ext.sweepX - barSpacing / 2, y.sweep);
    ctx.lineTo(ext.sweepX + barSpacing / 2, y.sweep);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
  }

  /** Risk zone, reward zone and entry line — the position tool's shape. */
  _block(ctx, ext, y, { profit, loss, dim, setup }) {
    const x = ext.blockLeft;
    const width = ext.blockRight - x;
    if (!(width > 0)) return;

    /* Each zone spans from the entry line to its own level, so they meet at
     * the entry and never overlap. */
    const zone = (yTo, colour) => {
      const top = Math.min(y.entry, yTo);
      const height = Math.abs(yTo - y.entry);
      if (height < 0.5) return;
      ctx.globalAlpha = ZONE_FILL_ALPHA * dim;
      ctx.fillStyle = colour;
      ctx.fillRect(x, top, width, height);
    };

    zone(y.stop, loss);
    zone(y.target, profit);

    ctx.globalAlpha = EDGE_ALPHA * dim;
    ctx.lineWidth = 1;
    for (const [level, colour] of [[y.stop, loss], [y.target, profit]]) {
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.moveTo(x, level + 0.5);
      ctx.lineTo(x + width, level + 0.5);
      ctx.stroke();
    }

    // The entry is where the trade started, so it is dashed rather than solid.
    ctx.globalAlpha = LINE_ALPHA * dim;
    ctx.strokeStyle = setup.direction === 'bull' ? profit : loss;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, y.entry + 0.5);
    ctx.lineTo(x + width, y.entry + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    /* The label rides inside the block on the target side, so it can never be
     * clipped by the pane or covered by the block's own fills. */
    if (width >= LABEL_MIN_WIDTH) {
      const up = y.target < y.entry;
      ctx.globalAlpha = 0.9 * dim;
      ctx.fillStyle = setup.outcome === 'target' ? profit : setup.outcome === 'stop' ? loss : profit;
      ctx.textBaseline = up ? 'top' : 'bottom';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, Math.min(y.target, y.stop), width, Math.abs(y.stop - y.target));
      ctx.clip();
      ctx.fillText(
        `${setup.windowLabel} ${setup.rrr}R`,
        x + 4,
        up ? y.target + 3 : y.target - 3,
      );
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}

class SetupPaneView {
  constructor(source) {
    this._renderer = new SetupRenderer(source);
  }

  zOrder() {
    return 'bottom';
  }

  renderer() {
    return this._renderer;
  }
}

export class SetupPrimitive {
  constructor() {
    /** [{ setups, bullColor, bearColor }] — one entry per setup indicator. */
    this.groups = [];
    this.series = null;
    this.chart = null;
    this._requestUpdate = null;
    this._paneViews = [new SetupPaneView(this)];
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
