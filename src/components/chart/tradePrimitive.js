/* One executed trade drawn as a position block.
 *
 * The same shape setupPrimitive and the position drawing tool use, and
 * deliberately so: a setup the indicator found, a trade you planned by hand and
 * a trade the engine actually took should not need three visual vocabularies.
 * Risk zone from entry to stop, reward zone from entry to target, entry line
 * dashed between them.
 *
 * Colour follows meaning, not direction — the stop side takes the loss colour
 * and the target side the profit colour, so a short reads the same way round as
 * a long. The labels are the position tool's too, in the same places and read
 * off the same `positionStats`: TP and SL towards the middle of their own zone,
 * the entry on the reward side, direction and reward-to-risk against the entry
 * line in the risk zone.
 *
 * What separates this from a planned position is the *outcome*. A planned block
 * says what a trade would be worth; this one also says what it was worth — the
 * realised result sits on the direction line, the exit gets a mark in the
 * colour of what happened, and the block stops at the bar that closed it rather
 * than running on.
 *
 * Placement goes through whole logical indices, like every other primitive
 * here, for the reason fvgPrimitive.js sets out at length. Times are not usable
 * directly: with intrabar resolution a fill lands on a minute inside the bar,
 * so timeToCoordinate would return null for it. The caller resolves each fill
 * to the bar that contains it and passes indices.
 */

import { positionStats } from './drawings/geometry.js';
import { formatPrice } from './drawings/drawingPrimitive.js';

const ZONE_ALPHA = 0.14;
const EDGE_ALPHA = 0.65;
const ENTRY_ALPHA = 0.55;
const LABEL_ALPHA = 0.95;
/** Below this the labels are wider than the block and are left off instead. */
const LABEL_MIN_WIDTH = 92;
/** And below this the two zone labels would sit on top of each other. */
const LABEL_MIN_HEIGHT = 15;

function paletteReader() {
  const s = getComputedStyle(document.documentElement);
  return (id) => s.getPropertyValue(`--${id}`).trim();
}

/**
 * The index of the bar that contains a moment in time.
 *
 * Fills cannot be placed by timestamp. With intrabar resolution a fill happens
 * on a minute inside the bar, so its time is not any bar's own time and the
 * chart has nothing to anchor to — the block belongs on the bar that contains
 * it, which is the last one starting at or before the fill.
 *
 * A time before the first bar clamps to it rather than returning -1: the window
 * around a trade can start mid-gap, and a block that vanished because its entry
 * predates the loaded data would be a worse answer than one drawn at the edge.
 *
 * @param {Array<{time:number}>} bars ascending, times in milliseconds
 */
export function barIndexAt(bars, timeMs) {
  if (!Array.isArray(bars) || bars.length === 0) return 0;
  if (timeMs <= bars[0].time) return 0;
  if (timeMs >= bars[bars.length - 1].time) return bars.length - 1;

  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bars[mid].time <= timeMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Horizontal extent of one trade's block, in pixels.
 *
 * Starts half a bar before the entry and ends half a bar after the exit, so the
 * block covers exactly the bars the trade was open for — including both of the
 * bars it happened on.
 */
export function tradeExtent(trade, barSpacing, indexToX) {
  const half = barSpacing / 2;
  const left = indexToX(trade.entryIndex) - half;
  const right = indexToX(trade.exitIndex) + half;
  return { left, right: Math.max(right, left + Math.max(1, barSpacing)) };
}

class TradeRenderer {
  constructor(source) {
    this._source = source;
  }

  draw(target) {
    const { trade, series, chart } = this._source;
    if (!series || !chart || !trade) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const colour = paletteReader();
      const timeScale = chart.timeScale();

      const originX = timeScale.logicalToCoordinate(0);
      const nextX = timeScale.logicalToCoordinate(1);
      if (originX == null || nextX == null) return;
      const barSpacing = nextX - originX;
      if (!(barSpacing > 0)) return;

      const indexToX = (index) => originX + index * barSpacing;
      const { left, right } = tradeExtent(trade, barSpacing, indexToX);
      if (right <= 0 || left >= mediaSize.width) return;

      const yEntry = series.priceToCoordinate(trade.entryPrice);
      if (yEntry == null) return;

      const profit = colour('pos');
      const loss = colour('neg');
      const width = right - left;

      ctx.save();

      /* Each zone runs from the entry line to its own level, so the two meet at
       * the entry and never overlap. A trade with no bracket — nothing stored
       * it, or the strategy sent none — simply has no zones to draw. */
      const zone = (price, tone) => {
        if (price == null) return;
        const y = series.priceToCoordinate(price);
        if (y == null) return;
        const top = Math.min(yEntry, y);
        const height = Math.abs(y - yEntry);
        if (height < 0.5) return;

        ctx.globalAlpha = ZONE_ALPHA;
        ctx.fillStyle = tone;
        ctx.fillRect(left, top, width, height);

        ctx.globalAlpha = EDGE_ALPHA;
        ctx.strokeStyle = tone;
        ctx.lineWidth = 1;
        ctx.beginPath();
        // Half-pixel offset keeps a 1px line on the pixel, not across two.
        ctx.moveTo(left, y + 0.5);
        ctx.lineTo(right, y + 0.5);
        ctx.stroke();
      };

      zone(trade.stop, loss);
      zone(trade.target, profit);

      // The entry: where the trade started, so dashed rather than solid.
      ctx.globalAlpha = ENTRY_ALPHA;
      ctx.strokeStyle = colour('txt');
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(left, yEntry + 0.5);
      ctx.lineTo(right, yEntry + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);

      /* The exit, in the colour of what actually happened — the one mark that
       * separates a trade that was taken from a setup that was merely found. */
      const yExit = series.priceToCoordinate(trade.exitPrice);
      if (yExit != null) {
        const tone = trade.won ? profit : loss;
        ctx.globalAlpha = 1;
        ctx.strokeStyle = tone;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(right - barSpacing, yExit);
        ctx.lineTo(right, yExit);
        ctx.stroke();

        ctx.fillStyle = tone;
        ctx.beginPath();
        ctx.arc(right - barSpacing / 2, yExit, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      this._labels(ctx, trade, {
        left, right, width, yEntry, profit, loss, text: colour('chart-text'),
      });

      ctx.globalAlpha = 1;
      ctx.restore();
    });
  }

  /**
   * The position tool's labels, in the position tool's places.
   *
   * Everything is written inside the block, on the side of each line facing
   * the middle of its own zone, so nothing hangs off an edge to be clipped by
   * the pane or covered by the block's own fills. Below a certain size they
   * are left off rather than drawn on top of each other — an unreadable label
   * is worse than none.
   */
  _labels(ctx, trade, { left, right, width, yEntry, profit, loss, text }) {
    if (width < LABEL_MIN_WIDTH) return;

    const { series } = this._source;
    /* Only meaningful with both legs. positionStats reads a missing one as
     * zero — Math.abs(entry - null) is the entry price — which would put a
     * confident, invented reward-to-risk on every run stored before the broker
     * carried the bracket. */
    const bracketed = trade.stop != null && trade.target != null;
    const stats = bracketed
      ? positionStats(trade.entryPrice, trade.stop, trade.target)
      : null;
    // Which way the target lies decides which side of each line is "inwards".
    const yTarget = trade.target == null ? null : series.priceToCoordinate(trade.target);
    const yStop = trade.stop == null ? null : series.priceToCoordinate(trade.stop);
    const targetAbove = yTarget != null ? yTarget < yEntry : trade.exitPrice > trade.entryPrice;

    ctx.font = '10px "DM Mono", ui-monospace, monospace';
    ctx.globalAlpha = LABEL_ALPHA;

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, 0, width, 1e5);
    ctx.clip();

    const label = (y, side, str, tone) => {
      ctx.fillStyle = tone;
      ctx.textBaseline = side === 'above' ? 'bottom' : 'top';
      ctx.fillText(str, left + 5, side === 'above' ? y - 3 : y + 3);
    };
    const pct = (v) => (v == null ? '—' : `${v.toFixed(2)}%`);

    const roomy = yTarget == null || yStop == null
      || Math.abs(yTarget - yEntry) > LABEL_MIN_HEIGHT;

    if (stats && yTarget != null && roomy) {
      label(yTarget, targetAbove ? 'below' : 'above',
        `TP  ${formatPrice(stats.target)}   +${pct(stats.rewardPercent)}`, profit);
    }
    if (stats && yStop != null && roomy) {
      label(yStop, targetAbove ? 'above' : 'below',
        `SL  ${formatPrice(stats.stop)}   −${pct(stats.riskPercent)}`, loss);
    }

    // The entry sits on the reward side, leaving the risk side free.
    label(yEntry, targetAbove ? 'above' : 'below',
      `Entry  ${formatPrice(trade.entryPrice)}`, text);

    /* Direction, planned reward-to-risk, and what the trade actually made —
     * the last of these is the whole difference between this block and a
     * planned one, so it shares the line rather than hiding elsewhere. */
    const name = trade.side === 'long' ? 'LONG' : 'SHORT';
    // No bracket, no ratio — an em dash says that, a number would not.
    const rr = stats?.rr == null ? '—' : stats.rr.toFixed(2);
    const result = trade.pnl == null
      ? ''
      : `   ${trade.pnl >= 0 ? '+' : '−'}${formatPrice(Math.abs(trade.pnl))}`;

    ctx.fillStyle = trade.pnl == null ? text : (trade.won ? profit : loss);
    ctx.textBaseline = targetAbove ? 'top' : 'bottom';
    ctx.fillText(
      `${name}   R:R ${rr}${result}`,
      left + 5,
      targetAbove ? yEntry + 3 : yEntry - 3,
    );

    ctx.restore();
  }
}

class TradePaneView {
  constructor(source) {
    this._renderer = new TradeRenderer(source);
  }

  zOrder() {
    return 'bottom';
  }

  renderer() {
    return this._renderer;
  }
}

export class TradePrimitive {
  constructor() {
    /** { entryIndex, exitIndex, entryPrice, exitPrice, stop, target, won } */
    this.trade = null;
    this.series = null;
    this.chart = null;
    this._requestUpdate = null;
    this._paneViews = [new TradePaneView(this)];
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

  setTrade(trade) {
    this.trade = trade;
    this._requestUpdate?.();
  }

  paneViews() {
    return this._paneViews;
  }
}
