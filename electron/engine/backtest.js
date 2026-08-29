/* Backtest loop — drives a strategy over history against the Broker.
 *
 * Order of events per bar, and why it is this order:
 *
 *   1. fills   orders placed on earlier bars are matched against this bar
 *   2. onBar   the strategy sees this bar as closed and may place new orders
 *
 * An order can therefore never fill on the bar that created it. That single
 * rule removes the most common way a backtest lies to itself: acting on a
 * closing price at that same closing price, which nobody can do.
 *
 * The strategy never receives the bar array. It gets `ctx.history(n)` — the
 * last n closed bars — and `ctx.ind(name, back)` for indicator values, both of
 * which stop at the current bar. Look-ahead is not discouraged here, it is
 * unavailable.
 */
import { computeIndicator } from '../../shared/indicators/index.js';
import { Broker, SIDE } from './broker.js';

/**
 * @param {object} params
 * @param {Array} params.bars        strategy-timeframe bars, ascending, closed only
 * @param {Array} [params.baseBars]  1m bars covering the same span, for intrabar fills
 * @param {object} params.strategy   { indicators?, params?, init?, onBar, onFinish? }
 * @param {object} [params.broker]   Broker options (balance, costs)
 */
export function runBacktest({
  bars, baseBars = null, strategy, broker: brokerOptions = {}, stepMs = null,
}) {
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error('runBacktest: no bars to run on');
  }
  if (!strategy || typeof strategy.onBar !== 'function') {
    throw new Error('runBacktest: the strategy must export an onBar(ctx) function');
  }

  const broker = new Broker(brokerOptions);
  const startedAt = Date.now();

  // Indicators are computed once over the whole series. The strategy can only
  // read index <= i, so precomputing costs nothing in correctness and turns an
  // O(n²) recompute into one pass.
  const declared = strategy.indicators ?? {};
  const series = {};
  for (const [name, spec] of Object.entries(declared)) {
    if (!spec || typeof spec.id !== 'string') {
      throw new Error(`Strategy indicator "${name}" needs an { id, params } shape`);
    }
    const result = computeIndicator(spec.id, bars, spec.params ?? {});
    const key = spec.output ?? Object.keys(result)[0];
    if (!(key in result)) {
      throw new Error(`Indicator "${name}" (${spec.id}) has no output "${key}"`);
    }
    series[name] = result[key];
  }

  // Skip the warm-up: bars where a declared indicator is still undefined. A
  // strategy that had to null-check every value would be mostly null-checks.
  let start = 0;
  const names = Object.keys(series);
  if (names.length > 0) {
    while (start < bars.length && names.some((n) => series[n][start] == null)) start++;
  }

  const equityCurve = [];
  let peakEquity = broker.equity;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  let i = 0; // current bar index, closed over by the context
  const step = stepMs ?? inferStepMs(bars);
  const subBarsFor = makeSubBarLookup(bars, baseBars, step);

  const ctx = {
    /* The bar just closed. Prices are read from it — `ctx.bar.close` — because
     * `ctx.close()` is the method that closes a position. One name cannot mean
     * both a price and an action. */
    get bar() { return bars[i]; },
    get index() { return i; },
    get time() { return bars[i].time; },

    /** The last `n` closed bars, oldest first, ending with the current one. */
    history(n = 1) {
      if (!Number.isInteger(n) || n < 1) throw new Error(`history(${n}): n must be a positive integer`);
      return bars.slice(Math.max(0, i - n + 1), i + 1);
    },

    /**
     * An indicator value. `back` counts bars into the past: 0 is this bar,
     * 1 the one before. Returns null before the indicator is defined.
     */
    ind(name, back = 0) {
      const s = series[name];
      if (!s) {
        throw new Error(
          `Unknown indicator "${name}". Declared: ${names.join(', ') || 'none'}`,
        );
      }
      if (!Number.isInteger(back) || back < 0) {
        throw new Error(`ind("${name}", ${back}): back must be a non-negative integer`);
      }
      const at = i - back;
      return at < 0 ? null : s[at];
    },

    get position() { return broker.position; },
    get balance() { return broker.balance; },
    get equity() { return broker.equity; },
    get isFlat() { return broker.isFlat; },
    get pendingOrders() { return broker.pending; },

    params: strategy.params ?? {},

    buy(spec = {}) {
      return broker.submitEntry({ side: SIDE.BUY, ...spec });
    },
    sell(spec = {}) {
      return broker.submitEntry({ side: SIDE.SELL, ...spec });
    },
    order(spec) {
      return broker.placeOrder(spec);
    },
    close(tag) {
      return broker.closePosition(tag);
    },
    cancelAll(tag) {
      return broker.cancelAll(tag);
    },

    /** Free-form store that survives across bars, for strategy state. */
    state: {},
  };

  strategy.init?.(ctx);

  for (i = start; i < bars.length; i++) {
    const bar = bars[i];

    // 1. Resolve what this bar fills, using its minutes where available.
    broker.processBar(bar, subBarsFor(i));

    // 2. Let the strategy react to the now-closed bar.
    strategy.onBar(ctx);

    const equity = broker.equity;
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity - equity;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPct = peakEquity > 0 ? drawdown / peakEquity : 0;
    }

    equityCurve.push({
      time: bar.time,
      equity,
      balance: broker.balance,
      drawdown,
    });
  }

  strategy.onFinish?.(ctx);

  // Anything still open is marked out at the last close, so the numbers
  // describe a finished account rather than a half-open one.
  const openAtEnd = broker.position ? { ...broker.position } : null;

  return {
    trades: broker.trades,
    fills: broker.fills,
    orders: broker.orders,
    equityCurve,
    openPosition: openAtEnd,
    stats: summarize({
      broker, equityCurve, maxDrawdown, maxDrawdownPct, barCount: bars.length - start,
    }),
    warmupBars: start,
    barCount: bars.length,
    resolution: baseBars && baseBars.length > 0 ? 'intrabar' : 'pessimistic',
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Builds a lookup from strategy-bar index to the 1m bars inside it.
 *
 * A bar's span is its own start plus one timeframe — deliberately not "up to
 * the next bar". Where the series has a gap (a halt, a symbol not yet listed),
 * the two differ, and minutes from inside the gap do not belong to the bar
 * before it. Attributing them there would let a fill happen on a bar whose own
 * high and low never saw that price.
 *
 * Both arrays are ascending, so one walking pointer covers the whole series.
 */
function makeSubBarLookup(bars, baseBars, stepMs) {
  if (!baseBars || baseBars.length === 0) return () => null;

  const buckets = new Array(bars.length);
  let b = 0;

  for (let k = 0; k < bars.length; k++) {
    const from = bars[k].time;
    const to = from + stepMs;

    while (b < baseBars.length && baseBars[b].time < from) b++;
    const startIdx = b;
    while (b < baseBars.length && baseBars[b].time < to) b++;
    buckets[k] = b > startIdx ? baseBars.slice(startIdx, b) : null;
  }

  return (k) => buckets[k];
}

/** Bar duration: given explicitly, or the smallest gap actually present. */
function inferStepMs(bars) {
  if (bars.length < 2) return Infinity;
  let smallest = Infinity;
  for (let k = 1; k < bars.length; k++) {
    const d = bars[k].time - bars[k - 1].time;
    if (d > 0 && d < smallest) smallest = d;
  }
  if (!Number.isFinite(smallest)) {
    throw new Error('runBacktest: could not determine the bar duration — timestamps do not advance');
  }
  return smallest;
}

/** Performance figures. Only quantities that can be computed honestly here. */
function summarize({ broker, equityCurve, maxDrawdown, maxDrawdownPct, barCount }) {
  const trades = broker.trades;
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);

  const grossProfit = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));
  const netPnl = broker.equity - broker.initialBalance;
  const fees = broker.fills.reduce((a, f) => a + f.fee, 0);

  return {
    initialBalance: broker.initialBalance,
    finalEquity: broker.equity,
    netPnl,
    returnPct: netPnl / broker.initialBalance,
    maxDrawdown,
    maxDrawdownPct,
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    // An account with no trades has no win rate — 0% would read as "always lost".
    winRate: trades.length > 0 ? wins.length / trades.length : null,
    avgWin: wins.length > 0 ? grossProfit / wins.length : null,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : null,
    // Infinite profit factor is real when nothing lost; null keeps it out of sums.
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0),
    expectancy: trades.length > 0 ? trades.reduce((a, t) => a + t.netPnl, 0) / trades.length : null,
    feesPaid: fees,
    barCount,
    equityPoints: equityCurve.length,
  };
}
