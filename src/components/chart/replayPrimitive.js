/* What a running replay looks like on the chart.
 *
 * Four things:
 *
 *   the positions  every open one, as the same risk/reward block the position
 *                  tool and tradePrimitive draw. It runs from the bar it was
 *                  opened on to the right edge of the pane, because it has not
 *                  ended — a block that stopped at the playhead would read as
 *                  a trade that closed there. Against that right edge sit the
 *                  three numbers that are still live: what the position is
 *                  worth now, what the stop costs, what the target pays.
 *
 *                  A market order is one of these the moment it is sent: it
 *                  fills at the last price rather than waiting for a bar, so
 *                  there is never an entry on the way to draw.
 *
 *                  With several open, one of them is the one being worked on —
 *                  it is drawn at full strength and carries the handles, the
 *                  close button and the labels on the axis. The others are
 *                  drawn dimmed, with their own result on their own entry
 *                  line, because they are also real money.
 *   resting orders a dashed line at each pending order's price, from the
 *                  playhead rightwards. They are things that have not happened
 *                  yet, so they are drawn only into the future.
 *   closed trades  a faint line from entry to exit, in the colour of the
 *                  result, underneath everything live. The argument against
 *                  drawing them was that the bars they happened on are the
 *                  record already — but reviewing an afternoon means seeing
 *                  where the entries went in against what the market did next,
 *                  and reconstructing that from a list of timestamps is the
 *                  work the chart is supposed to save. Switchable, so the
 *                  argument for a clean chart is still available.
 *   the start      a faint vertical at the bar the session began on, so it
 *                  stays obvious how much of what is on screen was read before
 *                  anything was decided and how much was played through.
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
import {
  CLOSE_INSET, CLOSE_SIZE, closeButtonRect, draggableOrders, orderCancelRect, orderPrice,
} from './replayLevels.js';

/** Strongest at the level, fading to nothing at the entry — see `_position`. */
const ZONE_ALPHA = 0.22;
const EDGE_ALPHA = 0.95;
const ENTRY_ALPHA = 0.8;
const ORDER_ALPHA = 0.8;
const START_ALPHA = 0.35;
/** A position that is open but not the one being worked on. */
const INACTIVE_ALPHA = 0.5;
/** A trade that is over: present, findable, not competing with the candles. */
const TRADE_ALPHA = 0.45;
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
 */
const NUMBER_FONT = '500 12px Inter, system-ui, sans-serif';
/** Tall enough for a 12px line to sit in without touching the edges. */
const TAG_HEIGHT = 20;
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

/* Tracking is sticky on a canvas context, so the face and the tracking that
 * belongs to it are always set together — measureText then sees exactly what
 * fillText will draw. */
function numberFont(ctx) {
  ctx.font = NUMBER_FONT;
  ctx.letterSpacing = '0px';
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

/**
 * The same, with its sign in front of it — and nothing in front of a zero.
 *
 * Rounded to the cents `money` prints before the sign is decided, because a
 * stop sitting exactly on break-even lands a fraction of a cent off zero and
 * "−$0.00" written in red is the same wrong answer in miniature.
 */
function signedMoney(value) {
  const cents = Math.round(value * 100) / 100;
  return cents === 0 ? money(0) : `${cents > 0 ? '+' : '−'}${money(cents)}`;
}

/**
 * A position size, rounded to something a person reads rather than audits.
 *
 * formatPrice is wrong for this: it hands eight decimals to anything under 1,
 * because that is what a cheap coin's *price* needs — so a size of 0.05 came
 * out as 0.05000000. Four significant figures keep the size honest, since it
 * falls out of a risk calculation and is almost never round, while dropping the
 * digits that only say the division had a remainder.
 */
function lots(value) {
  return Number(Math.abs(value).toPrecision(4)).toLocaleString('en-GB', {
    maximumFractionDigits: 8,
  });
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
      /* Underneath everything live, because that is what it is: what has
       * already been settled, behind what is still being decided. */
      this._trades(ctx, marks, bars, indexToX, mediaSize, colour);

      const positions = marks.positions ?? (marks.position ? [marks.position] : []);
      /* The active one last, so it is drawn over the others: it is the one the
       * handles belong to, and it should be the one under the pointer. */
      const ordered = [
        ...positions.filter((p) => p.id !== marks.activeId),
        ...positions.filter((p) => p.id === marks.activeId),
      ];
      for (const position of ordered) {
        this._position(
          ctx, marks, bars, position, position.id === marks.activeId,
          indexToX, barSpacing, mediaSize, colour,
        );
      }

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

  /**
   * Finished trades, as the shortest thing that says what happened.
   *
   * A line from where it went in to where it came out, in the colour of the
   * result. Not a block: a block says "this is the plan", and a trade that is
   * over had one outcome, not a range of them. Faint and underneath, because
   * the candles are still the thing being read — the trades are there to be
   * found when reviewing, not to compete with the market for attention.
   */
  /**
   * Finished trades, and the one the history is pointing at.
   *
   * The list under the chart and the lines on it are the same trades, and a
   * row that lit nothing up would leave the reader to match a timestamp
   * against a chart by eye — which is the work this is supposed to save. So a
   * pointed-at trade is drawn at full strength with what it made written on
   * it, and it is drawn *whether or not* finished trades are switched on:
   * asking for one particular trade is a different request from asking for all
   * of them, and the blanket setting should not be able to refuse it.
   */
  _trades(ctx, marks, bars, indexToX, mediaSize, colour) {
    const shown = marks.trades ?? [];
    const all = marks.allTrades ?? shown;
    const lit = new Set([marks.focusedTrade, marks.hoveredTrade].filter((n) => n != null));
    if (shown.length === 0 && lit.size === 0) return;

    const { series } = this._source;
    const profit = colour('pos');
    const loss = colour('neg');

    const one = (trade, n) => {
      const x1 = indexToX(barIndexAt(bars, trade.openedAt));
      const x2 = indexToX(barIndexAt(bars, trade.closedAt));
      if (x2 < 0 || x1 > mediaSize.width) return;

      const y1 = series.priceToCoordinate(trade.entryPrice);
      const y2 = series.priceToCoordinate(trade.exitPrice);
      if (y1 == null || y2 == null) return;

      const on = lit.has(n);
      const alpha = on ? 1 : TRADE_ALPHA;
      const tone = trade.netPnl >= 0 ? profit : loss;

      ctx.lineWidth = on ? 2.5 : 1.5;
      ctx.setLineDash([]);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = tone;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      /* Which way it was taken, at the end it was taken from. A dot at the
       * exit closes the sentence — without it a run of these reads as a
       * zigzag rather than as a series of trades. */
      this._marker(ctx, x1, y1, trade.side === 'long', tone, alpha);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = tone;
      ctx.beginPath();
      ctx.arc(x2, y2, on ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fill();

      if (!on) return;

      /* What it made, at the end it ended at. On a plate, because this lands
       * over candles and a bare number on them is unreadable exactly when it
       * is being looked for. */
      numberFont(ctx);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const text = `${trade.netPnl >= 0 ? '+' : '−'}${money(trade.netPnl)}`;
      const width = ctx.measureText(text).width + 12;
      ctx.globalAlpha = PLATE_ALPHA;
      ctx.fillStyle = tone;
      fillRounded(ctx, x2 + 7, y2 - TAG_HEIGHT / 2, width, TAG_HEIGHT);
      ctx.globalAlpha = 1;
      ctx.fillStyle = colour('chart-bg');
      ctx.fillText(text, x2 + 13, y2);
    };

    if (shown.length > 0) shown.forEach(one);
    else for (const n of lit) if (all[n]) one(all[n], n);
  }

  _position(ctx, marks, bars, position, active, indexToX, barSpacing, mediaSize, colour) {
    if (!position) return;

    const { series, drag } = this._source;
    const entryIndex = barIndexAt(bars, position.openedAt);
    const { left, right } = positionExtent(entryIndex, barSpacing, indexToX, mediaSize.width);
    if (right <= 0 || left >= mediaSize.width) return;

    const yEntry = series.priceToCoordinate(position.entryPrice);
    if (yEntry == null) return;

    /* A level being dragged is drawn where the pointer is, not where the order
     * still rests: nothing moves in the account until the pointer is let go, so
     * this is the only feedback the drag has. Only the active position has
     * handles, so only it can be mid-drag. */
    const stopLoss = active && drag?.field === 'stopLoss' ? drag.price : position.stopLoss;
    const takeProfit = active && drag?.field === 'takeProfit' ? drag.price : position.takeProfit;

    const long = position.size > 0;
    const profit = colour('pos');
    const loss = colour('neg');
    const width = right - left;
    /* One position is being worked on and the others are context. They are all
     * real money, so none of them is hidden — but the one the handles belong
     * to has to be obvious, or a drag would be a guess. */
    const dim = active ? 1 : INACTIVE_ALPHA;

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
        ctx.globalAlpha = ZONE_ALPHA * dim;
        ctx.fillStyle = wash;
        ctx.fillRect(left, top, width, height);
      }

      ctx.globalAlpha = EDGE_ALPHA * dim;
      ctx.strokeStyle = tone;
      // A level under the pointer carries a little more weight, so a drag can
      // be seen to have hold of something.
      ctx.lineWidth = dragging ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    };

    /* What each level comes to if it fills, net of the round trip — the same
     * arithmetic break-even is solved from, so a stop moved there reads as
     * zero rather than as the cost of the trip.
     *
     * Signed, and the sign is the whole point: a stop is only a loss while it
     * is below the entry on a long. Moved past break-even it is money locked
     * in, and drawing that block red with a loss written on it said the
     * opposite of what had just been done to the trade. */
    const stopResult = stopLoss == null || !marks.resultAt
      ? null : marks.resultAt(position, stopLoss, true);
    const targetResult = takeProfit == null || !marks.resultAt
      ? null : marks.resultAt(position, takeProfit, false);

    /* Break-even is protection that costs nothing, so it is not drawn as a
     * loss — only a level that would actually take money is. Decided on the
     * rounded figure, so the block and the tag on it always agree. */
    const stopTone = stopResult != null && Math.round(stopResult * 100) < 0 ? loss : profit;
    const targetTone = targetResult != null && Math.round(targetResult * 100) < 0
      ? loss : profit;

    zone(yStop, stopTone, active && drag?.field === 'stopLoss');
    zone(yTarget, targetTone, active && drag?.field === 'takeProfit');

    ctx.globalAlpha = ENTRY_ALPHA * dim;
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
    if (left > -MARKER) this._marker(ctx, left, yEntry, long, tone, dim);

    const size = Math.abs(position.size);

    /* One R, in money: what this trade risked per unit the first time it had a
     * stop, times the size held. The ruler, not the current stop distance —
     * measuring against where the stop is *now* is what makes R useless the
     * moment a trade is managed, because break-even divides by nothing. Null
     * until the position has ever had a stop, and then every R on the block is
     * simply left off. */
    const unit = position.riskPerUnit > 0 ? position.riskPerUnit * size : null;
    const inR = (value) => {
      if (unit == null || value == null) return '';
      const r = Math.round((value / unit) * 100) / 100;
      return `  ${r === 0 ? '' : r > 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`;
    };

    /* Against the right edge, beside the price scale: the number that is still
     * moving, and the two that decide what it can become. Each tag sits on its
     * own level, which is also the line that level is dragged by — so what says
     * what the stop costs and what you take hold of are one object, the way
     * they are on a broker's ticket.
     *
     * The prices themselves are on the axis (see LevelAxisView), so these say
     * what a level is *worth* rather than repeating what it is: the cash it
     * comes to if it fills, and that same figure in R. Both signed. A stop
     * used to be printed as −1.00R by construction, on the reasoning that R
     * *is* the distance to it — which stops being true the first time the stop
     * is moved, and is exactly wrong after a break-even. */
    const pnl = marks.pnlFor ? marks.pnlFor(position) : marks.unrealized;
    this._pnlTag(ctx, mediaSize, yEntry, position, pnl, unit, colour, active);

    /* Only the position being worked on carries handles: the close button
     * liquidates in one click, and three of them stacked against the same edge
     * would be three chances to hit the wrong one. */
    if (!active) return;

    this._closeButton(ctx, mediaSize, yEntry, this._source.hover === 'close', colour);
    if (yStop != null && stopResult != null) {
      const text = `SL  ${signedMoney(stopResult)}${inR(stopResult)}`;
      this._tag(ctx, mediaSize, yStop, text, stopTone, colour);
    }
    if (yTarget != null && targetResult != null) {
      const text = `TP  ${signedMoney(targetResult)}${inR(targetResult)}`;
      this._tag(ctx, mediaSize, yTarget, text, targetTone, colour);
    }
  }

  /** A filled triangle on a line, pointing the way the trade is facing. */
  _marker(ctx, x, y, up, tone, alpha = 1) {
    ctx.globalAlpha = alpha;
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
   * The position itself: which way, how big, and what it is worth right now.
   *
   * One tag on the entry line carrying all of it, because those three things
   * are only ever read together — and because the alternative was a second
   * label on the block, which covered the candles the position is being judged
   * against.
   *
   * The direction is a letter rather than a word: LONG spelled out beside a
   * P&L is the least surprising thing on the chart, and the triangle at the
   * entry says it in colour anyway. The result is unrealised and marked to the
   * last price, taken from the Broker rather than worked out again here, so
   * the number on the chart and the number in the panel can never disagree.
   *
   * In R beside it wherever the trade has ever had a stop to measure against:
   * 240 says very little on its own, and 240 against a risk of 400 says most
   * of what there is to say. `unit` is one R in money and comes from what the
   * trade risked to begin with — never from where the stop is now, which after
   * a break-even is a denominator of nothing and turns a trade forty cents in
   * front into +23R.
   */
  _pnlTag(ctx, mediaSize, y, position, unrealized, unit, colour, active = true) {
    if (!Number.isFinite(unrealized)) return;

    const up = unrealized >= 0;
    const r = unit > 0 ? unrealized / unit : null;
    const text = `${position.size > 0 ? 'L' : 'S'} ${lots(position.size)}`
      + `   ${up ? '+' : '−'}${money(unrealized)}`
      + (r === null ? '' : `  ${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R`);

    this._tag(
      ctx, mediaSize, y, text, colour(up ? 'pos' : 'neg'), colour,
      // The close button sits outside the active one, on the same line.
      active ? CLOSE_INSET + CLOSE_SIZE + 4 : CLOSE_INSET,
      active ? 1 : INACTIVE_ALPHA,
    );
  }

  /**
   * A filled pill against the right edge, the pane's own colour written on it.
   *
   * `rightInset` is how much room to leave beyond it — the entry line's tag
   * hands over the width of the close button, which sits outside it.
   */
  _tag(ctx, mediaSize, y, text, tone, colour, rightInset = CLOSE_INSET, alpha = 1) {
    ctx.globalAlpha = alpha;
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

  /**
   * The orders that have not happened yet, and the handles on them.
   *
   * A dashed line at each waiting price, from the playhead rightwards — only
   * into the future, because that is the only place they can still act. Which
   * orders get a line is `draggableOrders`, shared with the hit test, so what
   * is painted and what can be grabbed are the same set by construction.
   *
   * Two handles, and both appear only under the pointer. A line carrying a
   * permanent cancel button would put a one-click way of destroying an order on
   * the chart at all times, and the chart is a thing people wave a mouse across
   * while reading. Hovering is the smallest deliberate act that can precede it.
   */
  _orders(ctx, marks, indexToX, barSpacing, mediaSize, colour) {
    if (marks.orders.length === 0) return;

    const { series, drag, hover } = this._source;
    const left = indexToX(marks.index) + barSpacing / 2;
    const positions = marks.positions ?? (marks.position ? [marks.position] : []);

    for (const order of draggableOrders(marks.orders, positions)) {
      /* Where the pointer has it, if it is the one being dragged. Nothing has
       * moved in the account yet — the drop is what asks the Broker to amend
       * the order — so this line is a preview and the tag says the new price
       * because that is the question being answered while dragging. */
      const dragging = drag?.orderId === order.id;
      const price = dragging ? drag.price : orderPrice(order);
      const y = series.priceToCoordinate(price);
      if (y == null) continue;

      const pointed = dragging || hover === `order:${order.id}` || hover === `cancel:${order.id}`;

      /* An exit is read against the position it protects, so it keeps the
       * meaning colours; a resting entry is read as a direction. */
      const tone = order.tag === 'stop-loss' ? colour('neg')
        : order.tag === 'take-profit' ? colour('pos')
          : directionTone(order.side === 'buy', colour);

      ctx.globalAlpha = pointed ? 1 : ORDER_ALPHA;
      ctx.strokeStyle = tone;
      ctx.lineWidth = pointed ? 1.5 : 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(left, y + 0.5);
      ctx.lineTo(mediaSize.width, y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);

      numberFont(ctx);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = tone;
      ctx.fillText(
        `${order.tag ?? `${order.side} ${order.type}`}  ${lots(order.size)} @ ${formatPrice(price)}`,
        left + 5,
        y - 3,
      );

      if (pointed && !dragging) this._cancelButton(ctx, mediaSize, y, order.id, hover, colour);
    }
  }

  /**
   * The × that takes one waiting order back out of the book.
   *
   * Outlined while the line is merely pointed at and filled once the pointer is
   * on the button itself — the same two states, drawn the same way, as the
   * button that closes a position. Two buttons that destroy something and look
   * different from each other would have to be learned twice.
   */
  _cancelButton(ctx, mediaSize, y, id, hover, colour) {
    const rect = orderCancelRect(mediaSize.width, y);
    const tone = colour('neg');
    const arm = CROSS_ARM - 1;

    if (hover === `cancel:${id}`) {
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
    ctx.moveTo(cx - arm, cy - arm);
    ctx.lineTo(cx + arm, cy + arm);
    ctx.moveTo(cx + arm, cy - arm);
    ctx.lineTo(cx - arm, cy + arm);
    ctx.stroke();
    ctx.lineCap = 'butt';
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

/**
 * A level's own label on the price axis.
 *
 * The axis is where a trader already looks to read a price off the chart, and
 * it is the one place a level can be shown without covering a candle. So the
 * three prices that belong to a position go there — entry, stop, target — and
 * come back out of the tags on the block, which then have room to say what the
 * level is *worth* instead of repeating what it is.
 *
 * Each view reads the position on every call rather than being fed a value, so
 * a level under the pointer follows the drag without anything having to push
 * an update: the same repaint that moves the line moves the label.
 */
class LevelAxisView {
  constructor(source, field) {
    this._source = source;
    this._field = field;
  }

  /** The price to show — the dragged one while a drag is in progress. */
  _price() {
    const position = this._source.marks?.position;
    if (!position) return null;
    if (this._field === 'entry') return position.entryPrice;
    const drag = this._source.drag;
    return drag?.field === this._field ? drag.price : position[this._field];
  }

  visible() {
    return this._source.series != null && this._price() != null;
  }

  coordinate() {
    const price = this._price();
    if (price == null || !this._source.series) return -100;
    return this._source.series.priceToCoordinate(price) ?? -100;
  }

  text() {
    const price = this._price();
    return price == null ? '' : formatPrice(price);
  }

  textColor() {
    return paletteReader()('chart-bg');
  }

  /* The same three colours the block itself uses, so a label on the axis and
   * the line it belongs to are obviously one thing. */
  backColor() {
    const colour = paletteReader();
    if (this._field === 'stopLoss') return colour('neg');
    if (this._field === 'takeProfit') return colour('pos');
    return colour('txt');
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
    /* One per level, built once and reused: the library caches on the identity
     * of this array, and each view reads the position for itself. */
    this._axisViews = [
      new LevelAxisView(this, 'entry'),
      new LevelAxisView(this, 'stopLoss'),
      new LevelAxisView(this, 'takeProfit'),
    ];
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

  /* The three prices on the price axis. Same array every time, as above. */
  priceAxisViews() {
    return this._axisViews;
  }

  paneViews() {
    // Same array every time — the library caches on identity.
    return this._paneViews;
  }
}
