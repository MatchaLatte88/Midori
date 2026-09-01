/* What a running replay looks like on the chart.
 *
 * Four things, and nothing that has already finished:
 *
 *   the position   the open one, as the same risk/reward block the position
 *                  tool and tradePrimitive draw. It runs from the bar it was
 *                  opened on to the right edge of the pane, because it has not
 *                  ended — a block that stopped at the playhead would read as
 *                  a trade that closed there. Against that right edge sit the
 *                  three numbers that are still live: what the position is
 *                  worth now, what the stop costs, what the target pays.
 *   what is coming a market order that has been sent but has not filled. It is
 *                  drawn from the playhead forwards at the last close, dashed,
 *                  because that is exactly what it is — an intention about the
 *                  next bar. See `_announced`.
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
 * Colour follows the design language rather than the trading cliché. Green and
 * red mean profit and loss here and nothing else — they are the zones. A
 * direction is not a good or a bad thing, so long and short are drawn in the
 * two colours the candles themselves use for up and down, which is also what
 * `_orders` has always done with a resting entry.
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
import { CLOSE_INSET, CLOSE_SIZE, closeButtonRect } from './replayLevels.js';

/** Strongest at the level, fading to nothing at the entry — see `_position`. */
const ZONE_ALPHA = 0.22;
const EDGE_ALPHA = 0.95;
const ENTRY_ALPHA = 0.8;
const ORDER_ALPHA = 0.8;
const START_ALPHA = 0.35;
/** A plate has to stay readable over candles without hiding them. */
const PLATE_ALPHA = 0.82;

/* Type on the chart, and why it is not the mono every other primitive uses.
 *
 * The zone and drawing primitives label analysis — a gap, a level, a session —
 * and mono is right there: it is meta text about the chart, and the design
 * language asks for it. This primitive labels an *account*: what is open, what
 * it is worth, what the stop costs. Those are read at a glance while something
 * is moving, over candles, and Inter is simply easier to read at a glance than
 * a typewriter face. It is also the app's own text face, loaded as one variable
 * file, so every weight is there without a second request.
 *
 * The direction takes the display face the buttons use, at the one weight that
 * is certainly loaded — Canvas does not pull a face that no element on the page
 * has asked for, so a weight nothing else uses would quietly fall back.
 */
const NUMBER_FONT = '500 12px Inter, system-ui, sans-serif';
const CHIP_FONT = '600 12px "Plus Jakarta Sans", Inter, sans-serif';
/** A little air between the letters of LONG and SHORT — it reads as a badge. */
const CHIP_TRACKING = '0.6px';
/** Tall enough for a 12px line to sit in without touching the edges. */
const TAG_HEIGHT = 20;
const CHIP_HEIGHT = 19;
/** How far the label sits above its line — clear of it at the chip's height. */
const LABEL_LIFT = 13;
/** `--radius-sm`, the same corner the Buy and Sell buttons are cut with. */
const CORNER = 8;
/** Half the length of each stroke of the close button's cross. */
const CROSS_ARM = 4;
/** Half the width of the triangle at the entry, and its height. */
const MARKER = 5;

/** A filled box with the app's own corner on it. */
function fillRounded(ctx, x, y, width, height) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, CORNER);
  ctx.fill();
}

/* Setting a face and the tracking that belongs to it, together.
 *
 * Tracking is sticky on a canvas context: set for the chip and left alone, it
 * would space out every number drawn after it. So the two always travel as a
 * pair, and measureText sees exactly what fillText will draw. */
function chipFont(ctx) {
  ctx.font = CHIP_FONT;
  ctx.letterSpacing = CHIP_TRACKING;
}

function numberFont(ctx) {
  ctx.font = NUMBER_FONT;
  ctx.letterSpacing = '0px';
}

/* How wide a chip and a plate come out, measured before either is drawn.
 *
 * Both are laid out against room that runs out — the block ends at the pane,
 * and an announced order has only the bars to the right of the playhead. What
 * does not fit has to be left out or moved, and that cannot be decided after
 * the ink is down. */
function chipWidth(ctx, text) {
  chipFont(ctx);
  return ctx.measureText(text).width + 12;
}

function plateWidth(ctx, text) {
  numberFont(ctx);
  return ctx.measureText(text).width + 10;
}

/* What account money is written in.
 *
 * The app carries no currency per market — a dataset is a symbol and a set of
 * bars — so this is the one place the quote currency is named, and it is named
 * as the stand-in it is. Every pair stored so far quotes in dollars or in a
 * dollar stablecoin; a market that does not would want this read off the
 * symbol instead. */
const QUOTE_SYMBOL = '$';

function paletteReader() {
  const s = getComputedStyle(document.documentElement);
  return (id) => s.getPropertyValue(`--${id}`).trim();
}

/**
 * An amount of account money, unsigned, to the cent, with the currency on it.
 *
 * Not formatPrice: that picks its decimals from the magnitude, because a price
 * can be 100,000 or it can be 0.00001. A P&L is neither — it is the quote
 * currency, where eight decimals read as noise and two read as money.
 *
 * The symbol earns its place on a tag that carries both: "SL 94,000.00 250.00"
 * is two numbers of unknown kind, "SL 94,000.00 −$250.00" is a level and what
 * being wrong there costs. The sign is left to the caller, which has a colour
 * to spend on it as well.
 */
function money(value) {
  return `${QUOTE_SYMBOL}${Math.abs(value).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** The colour a direction is drawn in — the candles' own up and down. */
function directionTone(long, colour) {
  return colour(long ? 'candle-up-brd' : 'candle-down-body');
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
 * The market orders that have been sent and have not filled yet.
 *
 * These are what `_announced` draws. A market order has no price of its own —
 * it takes whatever the next bar opens at — so until this existed there was
 * nothing on the chart between pressing Buy and the bar that answered it, and
 * the click looked like it had done nothing at all.
 *
 * Exits are not among them: a reduceOnly market order closes what is already
 * drawn, and announcing it as an arriving position would draw a second one
 * facing the other way. The position it is about is on the chart already.
 */
export function announcedEntries(orders) {
  if (!Array.isArray(orders)) return [];
  return orders.filter((order) => order.type === 'market' && !order.reduceOnly);
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
      // Last, so an order just sent is on top of everything it will change.
      this._announced(ctx, marks, indexToX, barSpacing, mediaSize, colour);
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

    const long = position.size > 0;
    const profit = colour('pos');
    const loss = colour('neg');
    const width = right - left;

    const yStop = stopLoss == null ? null : series.priceToCoordinate(stopLoss);
    const yTarget = takeProfit == null ? null : series.priceToCoordinate(takeProfit);

    /* Each zone runs from the entry line to its own level, so the two meet at
     * the entry and never overlap. The fill is a gradient rather than a flat
     * wash, and it fades out towards the entry: the candles live around the
     * entry and should stay clean there, while the far edge is the level
     * itself, which is the part worth finding at a glance. A position with no
     * protection on it has no zones — which is itself worth seeing. */
    const zone = (y, tone, dragging) => {
      if (y == null) return;
      const top = Math.min(yEntry, y);
      const height = Math.abs(y - yEntry);

      if (height >= 0.5) {
        const wash = ctx.createLinearGradient(0, yEntry, 0, y);
        wash.addColorStop(0, 'transparent');
        wash.addColorStop(1, tone);
        ctx.globalAlpha = ZONE_ALPHA;
        ctx.fillStyle = wash;
        ctx.fillRect(left, top, width, height);
      }

      ctx.globalAlpha = EDGE_ALPHA;
      ctx.strokeStyle = tone;
      // A level under the pointer carries a little more weight, so a drag can
      // be seen to have hold of something.
      ctx.lineWidth = dragging ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    };

    zone(yStop, loss, drag?.field === 'stopLoss');
    zone(yTarget, profit, drag?.field === 'takeProfit');

    ctx.globalAlpha = ENTRY_ALPHA;
    ctx.strokeStyle = colour('txt');
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(left, yEntry + 0.5);
    ctx.lineTo(right, yEntry + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    // The entry itself, where it happened and which way it went.
    const tone = directionTone(long, colour);
    if (left > -MARKER) this._marker(ctx, left, yEntry, long, tone);

    const size = Math.abs(position.size);
    const risk = stopLoss == null ? null : Math.abs(position.entryPrice - stopLoss) * size;
    const reward = takeProfit == null ? null : Math.abs(takeProfit - position.entryPrice) * size;

    /* Against the right edge, beside the price scale: the number that is still
     * moving, and the two that decide what it can become. Each tag sits on its
     * own level, which is also the line that level is dragged by — so what
     * says where the stop is and what you take hold of are one object, the way
     * they are on a broker's ticket. */
    this._pnlTag(ctx, mediaSize, yEntry, marks.unrealized, risk, colour);
    this._closeButton(ctx, mediaSize, yEntry, this._source.hover === 'close', colour);
    if (yStop != null) {
      this._tag(ctx, mediaSize, yStop, `SL ${formatPrice(stopLoss)}  −${money(risk)}`, loss, colour);
    }
    if (yTarget != null) {
      this._tag(
        ctx, mediaSize, yTarget,
        `TP ${formatPrice(takeProfit)}  +${money(reward)}`, profit, colour,
      );
    }

    /* What the position is, on the block itself, just above the entry line.
     * Measured rather than guessed at against a minimum width: the block ends
     * at the pane, so how much room there is depends on how long ago the
     * position was opened, and a threshold that works for "0.05 @ 1.2345"
     * clips "0.05 @ 95,205.21". What does not fit is left out, in order. */
    const y = yEntry - LABEL_LIFT;
    const x = Math.max(left, 0) + 6;
    const label = long ? 'LONG' : 'SHORT';
    const chip = chipWidth(ctx, label);
    if (x + chip > right - 2) return;

    this._chip(ctx, x, y, label, tone, colour);

    const detail = `${formatPrice(size)} @ ${formatPrice(position.entryPrice)}`;
    if (x + chip + 4 + plateWidth(ctx, detail) <= right - 2) {
      this._plate(ctx, x + chip + 4, y, detail, colour);
    }
  }

  /**
   * A market order that has been sent and has not filled.
   *
   * The engine's one rule is that an order fills on the bar *after* the one it
   * was placed on, and nothing here bends it — this is not the position, it is
   * the announcement of one. So it is dashed, it starts at the playhead rather
   * than behind it, and it says which bar it is waiting for. What it cannot do
   * is leave the click with no answer at all, which is what a market order used
   * to do: it has no price of its own, so nothing was drawn until the bar that
   * filled it arrived.
   *
   * The line sits at the last close, which is the honest estimate — the fill is
   * the next bar's open plus costs, and nobody knows it yet.
   */
  _announced(ctx, marks, indexToX, barSpacing, mediaSize, colour) {
    const entries = announcedEntries(marks.orders);
    if (entries.length === 0 || marks.lastPrice == null) return;

    const { series } = this._source;
    const y = series.priceToCoordinate(marks.lastPrice);
    if (y == null) return;

    const left = indexToX(marks.index) + barSpacing / 2;
    if (left > mediaSize.width) return;

    for (const order of entries) {
      const long = order.side === 'buy';
      const tone = directionTone(long, colour);

      ctx.globalAlpha = 1;
      ctx.strokeStyle = tone;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(mediaSize.width, y);
      ctx.stroke();
      ctx.setLineDash([]);

      this._marker(ctx, left, y, long, tone);

      /* Right of the playhead there are only the few bars the chart keeps as
       * an offset, which is rarely room for a label — so it slides left along
       * its own line instead of being clipped off by the pane. */
      const label = long ? 'LONG' : 'SHORT';
      const detail = `${formatPrice(order.size)} · next bar`;
      const chip = chipWidth(ctx, label);
      const total = chip + 4 + plateWidth(ctx, detail);
      const x = Math.max(2, Math.min(left + 6, mediaSize.width - total - 2));

      this._chip(ctx, x, y - LABEL_LIFT, label, tone, colour);
      this._plate(ctx, x + chip + 4, y - LABEL_LIFT, detail, colour);
    }
  }

  /** A filled triangle on a line, pointing the way the trade is facing. */
  _marker(ctx, x, y, up, tone) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = tone;
    ctx.beginPath();
    if (up) {
      ctx.moveTo(x, y - MARKER - 1);
      ctx.lineTo(x + MARKER, y + 1);
      ctx.lineTo(x - MARKER, y + 1);
    } else {
      ctx.moveTo(x, y + MARKER + 1);
      ctx.lineTo(x + MARKER, y - 1);
      ctx.lineTo(x - MARKER, y - 1);
    }
    ctx.closePath();
    ctx.fill();
  }

  /**
   * The direction, as a filled chip.
   *
   * Returns its width, so whatever goes beside it can be placed without
   * measuring the same string twice. The width comes from `chipWidth`, which
   * also sets the face — one padding, one measurement, no chance of the box and
   * the text disagreeing about how wide the thing is.
   */
  _chip(ctx, x, y, text, tone, colour) {
    ctx.globalAlpha = 1;
    const width = chipWidth(ctx, text);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = tone;
    fillRounded(ctx, x, y - CHIP_HEIGHT / 2, width, CHIP_HEIGHT);
    ctx.fillStyle = colour('chart-bg');
    ctx.fillText(text, x + 6, y + 0.5);
    return width;
  }

  /** Text on a plate of the pane's own ground, so candles cannot swallow it. */
  _plate(ctx, x, y, text, colour) {
    const width = plateWidth(ctx, text);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    ctx.globalAlpha = PLATE_ALPHA;
    ctx.fillStyle = colour('chart-bg');
    fillRounded(ctx, x, y - CHIP_HEIGHT / 2, width, CHIP_HEIGHT);

    ctx.globalAlpha = 1;
    ctx.fillStyle = colour('txt');
    ctx.fillText(text, x + 5, y + 0.5);
    return width;
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

    this._tag(
      ctx, mediaSize, y, text, colour(up ? 'pos' : 'neg'), colour,
      // The close button sits outside it, on the same line.
      CLOSE_INSET + CLOSE_SIZE + 4,
    );
  }

  /**
   * A filled pill against the right edge, the pane's own colour written on it.
   *
   * `rightInset` is how much room to leave beyond it — the entry line's tag
   * hands over the width of the close button, which sits outside it.
   */
  _tag(ctx, mediaSize, y, text, tone, colour, rightInset = CLOSE_INSET) {
    ctx.globalAlpha = 1;
    numberFont(ctx);
    ctx.textAlign = 'left';

    const width = ctx.measureText(text).width + 12;
    const x = mediaSize.width - width - rightInset;

    ctx.fillStyle = tone;
    fillRounded(ctx, x, y - TAG_HEIGHT / 2, width, TAG_HEIGHT);

    ctx.fillStyle = colour('chart-bg');
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 6, y);
  }

  /**
   * The button that closes the position, on the entry line at the right edge.
   *
   * Outlined until the pointer is on it, then filled: it liquidates a position
   * in one click, so it should look like something being pressed rather than
   * something being passed over. The geometry comes from replayLevels.js, which
   * is also what the pointer is tested against — one rectangle, two uses.
   */
  _closeButton(ctx, mediaSize, yEntry, hovered, colour) {
    const rect = closeButtonRect(mediaSize.width, yEntry);
    const tone = colour('neg');

    if (hovered) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = tone;
      fillRounded(ctx, rect.x, rect.y, rect.width, rect.height);
      ctx.strokeStyle = colour('chart-bg');
    } else {
      ctx.globalAlpha = PLATE_ALPHA;
      ctx.fillStyle = colour('chart-bg');
      fillRounded(ctx, rect.x, rect.y, rect.width, rect.height);

      ctx.globalAlpha = 1;
      ctx.strokeStyle = tone;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1, CORNER);
      ctx.stroke();
    }

    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - CROSS_ARM, cy - CROSS_ARM);
    ctx.lineTo(cx + CROSS_ARM, cy + CROSS_ARM);
    ctx.moveTo(cx + CROSS_ARM, cy - CROSS_ARM);
    ctx.lineTo(cx - CROSS_ARM, cy + CROSS_ARM);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  /** Pending orders, drawn only into the future they are waiting in. */
  _orders(ctx, marks, indexToX, barSpacing, mediaSize, colour) {
    if (marks.orders.length === 0) return;

    const { series } = this._source;
    const left = indexToX(marks.index) + barSpacing / 2;

    numberFont(ctx);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';

    for (const order of marks.orders) {
      /* An open position's bracket is already on the chart: the block draws
       * both levels, tags them with what they are worth, and is what a drag
       * takes hold of. Drawing the orders behind it as well would put a second
       * line and a second label on exactly the same price. */
      if (marks.position && (order.tag === 'stop-loss' || order.tag === 'take-profit')) continue;

      const price = order.type === 'limit' ? order.limitPrice : order.stopPrice;
      // A market order has no price to draw against — `_announced` has it.
      if (price == null) continue;
      const y = series.priceToCoordinate(price);
      if (y == null) continue;

      /* An exit is read against the position it protects, so it keeps the
       * meaning colours; a resting entry is read as a direction. */
      const tone = order.tag === 'stop-loss' ? colour('neg')
        : order.tag === 'take-profit' ? colour('pos')
          : directionTone(order.side === 'buy', colour);

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
    /** What the pointer is over, so the close button can answer to it. */
    this.hover = null;
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

  setMarks(marks, bars = [], drag = null, hover = null) {
    this.marks = marks;
    this.bars = bars;
    this.drag = drag;
    this.hover = hover;
    this._requestUpdate?.();
  }

  paneViews() {
    // Same array every time — the library caches on identity.
    return this._paneViews;
  }
}
