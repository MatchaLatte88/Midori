/* What a running replay looks like on the chart.
 *
 * Three things, and nothing that has already finished:
 *
 *   the position   the open one, as the same risk/reward block the position
 *                  tool and tradePrimitive draw. It runs from the bar it was
 *                  opened on to the right edge of the pane, because it has not
 *                  ended — a block that stopped at the playhead would read as
 *                  a trade that closed there. Against that right edge sit the
 *                  three numbers that are still live: what the position is
 *                  worth now, what the stop costs, what the target pays.
 *   resting orders a dashed line at each pending order's price, from the
 *                  playhead rightwards. They are things that have not happened
 *                  yet, so they are drawn only into the future.
 *   the start      a faint vertical at the bar the session began on, so it
 *                  stays obvious how much of what is on screen was read before
 *                  anything was decided and how much was played through.
 *
 * Closed trades are deliberately absent. They are on the chart already, in the
 * only form that cannot mislead: the bars they happened on. Painting a session's
 * whole history over the candles turns the thing being read into a scoreboard.
 *
 * The stop and the target are draggable. The hit testing is in replayLevels.js
 * and the drag itself belongs to ChartPanel, which owns the pointer; all this
 * file is told is that one of the two levels is currently somewhere else, and
 * it draws that level instead of the resting one until the pointer is let go.
 *
 * Placement goes through whole logical indices, and the half-bar offsets are
 * measured in pixels afterwards, for the reason fvgPrimitive.js sets out at
 * length: logicalToCoordinate silently returns 0 for a fractional index.
 */

import { formatPrice } from './drawings/drawingPrimitive.js';

const ZONE_ALPHA = 0.13;
const EDGE_ALPHA = 0.6;
const ENTRY_ALPHA = 0.6;
const ORDER_ALPHA = 0.8;
const START_ALPHA = 0.35;
/** Below this the block is a line and its labels would sit on each other. */
const LABEL_MIN_WIDTH = 90;
const LABEL_FONT = '10px "DM Mono", ui-monospace, monospace';
/** Tall enough for a 10px line to sit in without touching the edges. */
const TAG_HEIGHT = 16;

function paletteReader() {
  const s = getComputedStyle(document.documentElement);
  return (id) => s.getPropertyValue(`--${id}`).trim();
}

/**
 * An amount of account money, unsigned and always to the cent.
 *
 * Not formatPrice: that picks its decimals from the magnitude, because a price
 * can be 100,000 or it can be 0.00001. A P&L is neither — it is the quote
 * currency, where eight decimals read as noise and two read as money. The sign
 * is left to the caller, which has a colour to spend on it as well.
 */
function money(value) {
  return Math.abs(value).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Where the open position's block begins and ends, in pixels.
 *
 * It starts half a bar before the bar it was opened on and runs to the right
 * edge of the pane: an open position has no end yet, and drawing one would say
 * it closed at the playhead.
 */
export function positionExtent(entryIndex, barSpacing, indexToX, paneWidth) {
  return { left: indexToX(entryIndex) - barSpacing / 2, right: paneWidth };
}

/**
 * The index of the bar holding a moment, clamped into the loaded window.
 *
 * A fill lands on a minute inside its bar when the minutes decided it, so its
 * timestamp is not any bar's own and has to be resolved to the bar containing
 * it. Same job and same reason as tradePrimitive's barIndexAt; kept separate
 * because this one searches the replay window, which is a different array.
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

class ReplayRenderer {
  constructor(source) {
    this._source = source;
  }

  draw(target) {
    const { marks, bars, series, chart } = this._source;
    if (!series || !chart || !marks) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const colour = paletteReader();
      const timeScale = chart.timeScale();

      const originX = timeScale.logicalToCoordinate(0);
      const nextX = timeScale.logicalToCoordinate(1);
      if (originX == null || nextX == null) return;
      const barSpacing = nextX - originX;
      if (!(barSpacing > 0)) return;

      const indexToX = (index) => originX + index * barSpacing;

      ctx.save();
      this._start(ctx, marks, indexToX, barSpacing, mediaSize, colour);
      this._position(ctx, marks, bars, indexToX, barSpacing, mediaSize, colour);
      this._orders(ctx, marks, indexToX, barSpacing, mediaSize, colour);
      ctx.globalAlpha = 1;
      ctx.restore();
    });
  }

  /** A faint vertical where the session began. */
  _start(ctx, marks, indexToX, barSpacing, mediaSize, colour) {
    const x = indexToX(marks.startIndex) - barSpacing / 2;
    if (x < 0 || x > mediaSize.width) return;

    ctx.globalAlpha = START_ALPHA;
    ctx.strokeStyle = colour('txt');
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, mediaSize.height);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _position(ctx, marks, bars, indexToX, barSpacing, mediaSize, colour) {
    const position = marks.position;
    if (!position) return;

    const { series, drag } = this._source;
    const entryIndex = barIndexAt(bars, position.openedAt);
    const { left, right } = positionExtent(entryIndex, barSpacing, indexToX, mediaSize.width);
    if (right <= 0 || left >= mediaSize.width) return;

    const yEntry = series.priceToCoordinate(position.entryPrice);
    if (yEntry == null) return;

    /* A level being dragged is drawn where the pointer is, not where the order
     * still rests: nothing moves in the account until the pointer is let go, so
     * this is the only feedback the drag has. */
    const stopLoss = drag?.field === 'stopLoss' ? drag.price : position.stopLoss;
    const takeProfit = drag?.field === 'takeProfit' ? drag.price : position.takeProfit;

    const profit = colour('pos');
    const loss = colour('neg');
    const width = right - left;

    const yStop = stopLoss == null ? null : series.priceToCoordinate(stopLoss);
    const yTarget = takeProfit == null ? null : series.priceToCoordinate(takeProfit);

    /* Each zone runs from the entry line to its own level, so the two meet at
     * the entry. A position with no protection on it has no zones — which is
     * itself worth seeing at a glance. */
    const zone = (y, tone) => {
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
      ctx.moveTo(left, y + 0.5);
      ctx.lineTo(right, y + 0.5);
      ctx.stroke();
    };

    zone(yStop, loss);
    zone(yTarget, profit);

    ctx.globalAlpha = ENTRY_ALPHA;
    ctx.strokeStyle = colour('txt');
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(left, yEntry + 0.5);
    ctx.lineTo(right, yEntry + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    const size = Math.abs(position.size);
    const risk = stopLoss == null ? null : Math.abs(position.entryPrice - stopLoss) * size;
    const reward = takeProfit == null ? null : Math.abs(takeProfit - position.entryPrice) * size;

    /* Against the right edge, beside the price scale: the number that is still
     * moving, and the two that decide what it can become. Each tag sits on its
     * own level, which is also the line that level is dragged by — so what
     * says where the stop is and what you take hold of are one object, the way
     * they are on a broker's ticket. */
    this._pnlTag(ctx, mediaSize, yEntry, marks.unrealized, risk, colour);
    if (yStop != null) {
      this._tag(ctx, mediaSize, yStop, `SL ${formatPrice(stopLoss)}  −${money(risk)}`, loss, colour);
    }
    if (yTarget != null) {
      this._tag(
        ctx, mediaSize, yTarget,
        `TP ${formatPrice(takeProfit)}  +${money(reward)}`, profit, colour,
      );
    }

    if (width < LABEL_MIN_WIDTH) return;

    // What the position is, written into the block itself.
    ctx.globalAlpha = 1;
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = colour('txt');
    ctx.fillText(
      `${position.size > 0 ? 'LONG' : 'SHORT'} ${formatPrice(size)}`
      + `  @ ${formatPrice(position.entryPrice)}`,
      left + 5,
      yEntry - 3,
    );
  }

  /**
   * What the position is worth right now.
   *
   * Unrealised, and taken from the Broker rather than worked out again here, so
   * the number on the chart and the number in the panel can never disagree. In
   * R beside it wherever there is a stop to measure against: 240 says very
   * little on its own, and 240 against a risk of 400 says most of what there is
   * to say about the trade.
   */
  _pnlTag(ctx, mediaSize, y, unrealized, risk, colour) {
    if (!Number.isFinite(unrealized)) return;

    const up = unrealized >= 0;
    const r = risk > 0 ? unrealized / risk : null;
    const text = `${up ? '+' : '−'}${money(unrealized)}`
      + (r === null ? '' : `  ${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`);

    this._tag(ctx, mediaSize, y, text, colour(up ? 'pos' : 'neg'), colour);
  }

  /** A filled pill against the right edge, the pane's own colour written on it. */
  _tag(ctx, mediaSize, y, text, tone, colour) {
    ctx.globalAlpha = 1;
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';

    const width = ctx.measureText(text).width + 10;
    const x = mediaSize.width - width - 2;

    ctx.fillStyle = tone;
    ctx.fillRect(x, y - TAG_HEIGHT / 2, width, TAG_HEIGHT);

    ctx.fillStyle = colour('chart-bg');
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 5, y);
  }

  /** Pending orders, drawn only into the future they are waiting in. */
  _orders(ctx, marks, indexToX, barSpacing, mediaSize, colour) {
    if (marks.orders.length === 0) return;

    const { series } = this._source;
    const left = indexToX(marks.index) + barSpacing / 2;

    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';

    for (const order of marks.orders) {
      /* An open position's bracket is already on the chart: the block draws
       * both levels, tags them with what they are worth, and is what a drag
       * takes hold of. Drawing the orders behind it as well would put a second
       * line and a second label on exactly the same price. */
      if (marks.position && (order.tag === 'stop-loss' || order.tag === 'take-profit')) continue;

      const price = order.type === 'limit' ? order.limitPrice : order.stopPrice;
      // A market order has no price to draw: it fills at whatever opens next.
      if (price == null) continue;
      const y = series.priceToCoordinate(price);
      if (y == null) continue;

      /* An exit is read against the position it protects, so it keeps the
       * meaning colours; a resting entry is read as a direction. */
      const tone = order.tag === 'stop-loss' ? colour('neg')
        : order.tag === 'take-profit' ? colour('pos')
          : colour(order.side === 'buy' ? 'candle-up-brd' : 'candle-down-body');

      ctx.globalAlpha = ORDER_ALPHA;
      ctx.strokeStyle = tone;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(left, y + 0.5);
      ctx.lineTo(mediaSize.width, y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = tone;
      ctx.fillText(
        `${order.tag ?? `${order.side} ${order.type}`}  ${formatPrice(order.size)} @ ${formatPrice(price)}`,
        left + 5,
        y - 3,
      );
    }
  }
}

class ReplayPaneView {
  constructor(source) {
    this._renderer = new ReplayRenderer(source);
  }

  /* Above the candles, unlike the zone primitives: these are not context the
   * bars are read against, they are the state of an account that has to stay
   * findable whatever is underneath it. */
  zOrder() {
    return 'top';
  }

  renderer() {
    return this._renderer;
  }
}

export class ReplayPrimitive {
  constructor() {
    /** { index, startIndex, position, orders, lastPrice, unrealized } or null. */
    this.marks = null;
    /** The replay window, ms times — for resolving a fill to its bar. */
    this.bars = [];
    /** { field, price } while a level is being dragged, else null. */
    this.drag = null;
    this.series = null;
    this.chart = null;
    this._requestUpdate = null;
    this._paneViews = [new ReplayPaneView(this)];
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

  setMarks(marks, bars = [], drag = null) {
    this.marks = marks;
    this.bars = bars;
    this.drag = drag;
    this._requestUpdate?.();
  }

  paneViews() {
    // Same array every time — the library caches on identity.
    return this._paneViews;
  }
}
