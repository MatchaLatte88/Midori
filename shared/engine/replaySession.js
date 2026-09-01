/* Replay — a person stepping through history one bar at a time.
 *
 * The other half of the sentence at the top of broker.js: in a backtest a
 * strategy calls ctx.buy(), in a replay a person clicks Buy, and both end up
 * in the same Broker. That is what makes a result you traded by hand and a
 * result a bot produced directly comparable, which is the only reason either
 * number is worth storing.
 *
 * The one rule that makes it a test and not a game
 * ------------------------------------------------
 * The bar under the playhead is the last *closed* bar. Everything after it is
 * not hidden as a matter of presentation — it does not exist yet as far as
 * this class is concerned. An order placed while the playhead is on bar i is
 * matched against bar i+1, on the step that reveals it, which is exactly the
 * backtest's rule: an order can never fill on the bar that created it.
 *
 * Look-ahead in a replay is a different problem from look-ahead in a backtest,
 * because the person doing it can simply look. Nothing here can prevent that.
 * What it can do is make sure that the *account* never benefits: the fill
 * price comes from the bar after the decision, at the same spread, slippage
 * and commission a strategy would have paid.
 *
 * Fills inside the bar
 * --------------------
 * Same answer as the backtest, for the same reason: a bar that touches both
 * the stop and the target says nothing about which came first, so the minutes
 * inside it are walked in order where they exist. `step()` takes them; where
 * the caller has none the Broker's pessimistic rule applies and every fill
 * records which of the two decided it.
 *
 * Why the bars are handed in rather than fetched
 * ----------------------------------------------
 * So this file has no IPC, no clock and no chart in it, and a session can be
 * driven from a test with twenty bars in an array. The renderer's composable
 * owns the fetching, the play/pause timer and the pixels.
 */

import { Broker, SIDE } from './broker.js';
import { summarize } from './summary.js';

export class ReplaySession {
  /**
   * @param {object} options
   * @param {Array<object>} options.bars    ascending, times in milliseconds
   * @param {number} options.startIndex     the last bar visible at the start
   * @param {number} [options.balance]      starting cash
   * @param {object} [options.costs]        Broker cost overrides
   * @param {number} [options.stepMs]       bar duration; inferred when absent
   */
  constructor({ bars, startIndex, balance = 10_000, costs = {}, stepMs = null }) {
    if (!Array.isArray(bars) || bars.length === 0) {
      throw new Error('ReplaySession: no bars to replay');
    }
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= bars.length) {
      throw new Error(
        `ReplaySession: startIndex ${startIndex} is outside the ${bars.length} bars given`,
      );
    }

    this.bars = bars;
    this.startIndex = startIndex;
    this.index = startIndex;
    this.stepMs = stepMs ?? inferStepMs(bars);
    this.broker = new Broker({ balance, costs });

    this.startedAt = Date.now();
    /** How many stepped bars carried their own minutes, for the honest label. */
    this.intrabarSteps = 0;
    this.steps = 0;

    /* Marked to the bar the session starts on, so equity is a real number
     * before anything has been stepped. No order exists yet, so nothing can
     * fill on it — this only gives the account a price to be worth something
     * at. */
    this.broker.time = bars[startIndex].time;
    this.broker.lastPrice = bars[startIndex].close;

    this.peakEquity = this.broker.equity;
    this.maxDrawdown = 0;
    this.maxDrawdownPct = 0;

    this.equityCurve = [{
      time: bars[startIndex].time,
      equity: this.broker.equity,
      balance: this.broker.balance,
      drawdown: 0,
    }];
  }

  /** The last closed bar — what the chart is allowed to show. */
  get bar() {
    return this.bars[this.index];
  }

  /** Nothing further has been loaded; stepping would run past the data. */
  get atEnd() {
    return this.index >= this.bars.length - 1;
  }

  /** Bars stepped through so far. */
  get progress() {
    return this.index - this.startIndex;
  }

  /**
   * Reveals the next bar and settles everything it makes fillable.
   *
   * The order matches the backtest loop exactly: fills first, then the person
   * gets to look. Whatever they do next is an order for the bar after this
   * one.
   *
   * @param {Array<object>} [subBars]  the minutes inside the revealed bar
   * @returns {object} the bar now under the playhead
   */
  step(subBars = null) {
    if (this.atEnd) {
      throw new Error('ReplaySession: there is no bar after this one — load more first');
    }

    this.index += 1;
    const bar = this.bars[this.index];
    this.broker.processBar(bar, subBars);

    this.steps += 1;
    if (subBars && subBars.length > 0) this.intrabarSteps += 1;

    const equity = this.broker.equity;
    if (equity > this.peakEquity) this.peakEquity = equity;
    const drawdown = this.peakEquity - equity;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
      this.maxDrawdownPct = this.peakEquity > 0 ? drawdown / this.peakEquity : 0;
    }

    this.equityCurve.push({
      time: bar.time,
      equity,
      balance: this.broker.balance,
      drawdown,
    });

    return bar;
  }

  /* ─── Placing orders ──────────────────────────────────────────────────
   *
   * The same five names the backtest hands a strategy under `ctx`, doing the
   * same thing through the same Broker. A person clicking Buy and a strategy
   * calling ctx.buy() are then not merely comparable afterwards — they are the
   * same call, and there is no second path for one of them to be wrong on.
   */

  /** Market entry, with optional stop and target attached. */
  buy(spec = {}) {
    return this.broker.submitEntry({ side: SIDE.BUY, ...spec });
  }

  sell(spec = {}) {
    return this.broker.submitEntry({ side: SIDE.SELL, ...spec });
  }

  /** A bare order — limit or stop entries, and anything without a bracket. */
  order(spec) {
    return this.broker.placeOrder(spec);
  }

  /** Closes the whole position at market on the next bar. */
  close(tag) {
    return this.broker.closePosition(tag);
  }

  cancelAll(tag) {
    return this.broker.cancelAll(tag);
  }

  /**
   * Adds bars to the end of the window, so a session can keep going past what
   * was loaded when it started.
   *
   * Only ever appended, never prepended: every index this session has recorded
   * — the playhead, the start — counts from the front of the array, and
   * putting a bar in front of them would silently move all of them onto
   * different bars. The prefix is checked rather than trusted, because a
   * mismatch here would misplace every trade the session has already taken.
   */
  extend(bars) {
    if (!Array.isArray(bars) || bars.length === 0) return 0;

    const last = this.bars[this.bars.length - 1].time;
    const added = bars.filter((b) => b.time > last);
    if (added.length === 0) return 0;

    for (let i = 1; i < added.length; i++) {
      if (added[i].time <= added[i - 1].time) {
        throw new Error('ReplaySession.extend: the added bars are not ascending');
      }
    }

    this.bars = [...this.bars, ...added];
    return added.length;
  }

  /**
   * How the fills that happened were decided.
   *
   * Read off the fills themselves rather than off what was offered, because
   * that is the honest answer: a session where nothing ever traded through an
   * ambiguous bar was not helped by the minutes it was given. With no fills at
   * all it falls back to whether the minutes were there to be used.
   */
  get resolution() {
    const fills = this.broker.fills;
    if (fills.length > 0) {
      return fills.every((f) => f.resolution === 'intrabar') ? 'intrabar' : 'pessimistic';
    }
    return this.steps > 0 && this.intrabarSteps === this.steps ? 'intrabar' : 'pessimistic';
  }

  /**
   * The session as a finished run, in the shape runBacktest returns.
   *
   * Same shape on purpose: it goes into the same store, is read by the same
   * results page and lands in the same comparison. A replay that reported its
   * own dialect of the same numbers could not be put next to a backtest, which
   * is the entire point of having done it.
   */
  result() {
    return {
      trades: this.broker.trades,
      fills: this.broker.fills,
      orders: this.broker.orders,
      equityCurve: this.equityCurve,
      openPosition: this.broker.position ? { ...this.broker.position } : null,
      stats: summarize({
        broker: this.broker,
        equityCurve: this.equityCurve,
        maxDrawdown: this.maxDrawdown,
        maxDrawdownPct: this.maxDrawdownPct,
        barCount: this.progress,
      }),
      /* A replay warms nothing up: the person had the whole chart to the left
       * of the playhead before they pressed anything. */
      warmupBars: 0,
      barCount: this.progress,
      stepMs: Number.isFinite(this.stepMs) ? this.stepMs : null,
      costs: { ...this.broker.costs },
      initialBalance: this.broker.initialBalance,
      resolution: this.resolution,
      elapsedMs: Date.now() - this.startedAt,
      /* Where on the chart it happened, so a stored replay carries the same
       * range a backtest does and the two line up in a comparison. */
      from: this.bars[this.startIndex].time,
      to: this.bar.time + (Number.isFinite(this.stepMs) ? this.stepMs : 0),
    };
  }
}

/** Bar duration: the smallest gap actually present, as the backtest infers it. */
function inferStepMs(bars) {
  if (bars.length < 2) return Infinity;
  let smallest = Infinity;
  for (let k = 1; k < bars.length; k++) {
    const d = bars[k].time - bars[k - 1].time;
    if (d > 0 && d < smallest) smallest = d;
  }
  if (!Number.isFinite(smallest)) {
    throw new Error('ReplaySession: could not determine the bar duration — timestamps do not advance');
  }
  return smallest;
}
