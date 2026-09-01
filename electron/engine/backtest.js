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
 *
 * Series and events
 * -----------------
 * Most indicators are one value per bar and are declared under `indicators`.
 * A few describe discrete things instead — a gap, a sweep, a whole setup — and
 * produce a handful of objects across the entire series rather than a value at
 * every bar. Those are declared under `events` and reach the strategy through
 * `ctx.events(name)`, which returns what became knowable on *this* bar and
 * nothing else.
 *
 * The bucketing is by each object's `index`, never its `startIndex`. That
 * distinction is the whole reason the two exist: `startIndex` is where a thing
 * is drawn, `index` is the bar from which it could have been acted on. Reading
 * the drawing index here would hand a strategy a setup before the market had
 * finished making it, which is exactly the lie the split was invented to stop.
 *
 * Events take no part in the warm-up skip. A series is undefined until its
 * window fills, which is a real reason to wait; a bar with no events is not
 * warming up, it is simply a bar where nothing happened.
 *
 * Reusing indicator results across runs
 * ------------------------------------
 * `indicatorCache` lets a caller running many backtests over the *same bars*
 * compute each distinct indicator once. A parameter sweep is the reason it
 * exists: varying the reward-to-risk changes what the strategy does with a
 * setup but not which setups exist, so a sweep of nineteen reward levels
 * recomputes the same detection nineteen times without it. Measured on a year
 * of BTC 5m, detection is 1,975ms of a 1,967ms run — practically all of it —
 * and a 1,615-combination sweep drops from 53 minutes to under 3.
 *
 * The cache is keyed by indicator id and parameters, and NOT by the bars. That
 * makes it the caller's job to use one cache per bar array and never share a
 * cache between two different stretches of history — do that and a run
 * silently reports another period's trades. The sweep runner builds a fresh
 * one per stretch for exactly this reason.
 */
import { computeIndicator } from '../../shared/indicators/index.js';
import { Broker, SIDE } from '../../shared/engine/broker.js';
import { summarize } from '../../shared/engine/summary.js';

/* One frozen array for every barless answer, rather than a fresh [] per call.
 * A strategy that asks on every bar would otherwise allocate one per bar, and
 * freezing it means a strategy that pushes into the result corrupts its own
 * call rather than the next bar's. */
const EMPTY = Object.freeze([]);

/**
 * @param {object} params
 * @param {Array} params.bars        strategy-timeframe bars, ascending, closed only
 * @param {Array} [params.baseBars]  1m bars covering the same span, for intrabar fills
 * @param {object} params.strategy   { indicators?, events?, params?, init?, onBar, onFinish? }
 * @param {object} [params.broker]   Broker options (balance, costs)
 * @param {Map} [params.indicatorCache]  reuse across runs over the SAME bars
 */
export function runBacktest({
  bars, baseBars = null, strategy, broker: brokerOptions = {}, stepMs = null,
  indicatorCache = null,
}) {
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error('runBacktest: no bars to run on');
  }
  if (!strategy || typeof strategy.onBar !== 'function') {
    throw new Error('runBacktest: the strategy must export an onBar(ctx) function');
  }

  const broker = new Broker(brokerOptions);
  const startedAt = Date.now();

  /* One computation per distinct (indicator, params) pair. Without a cache
   * this is just computeIndicator; with one it is the same call, remembered.
   * The key is the resolved id and parameters — see the header for why the
   * bars are deliberately not part of it. */
  const compute = (spec) => {
    if (!indicatorCache) return computeIndicator(spec.id, bars, spec.params ?? {});
    const key = `${spec.id}:${stableKey(spec.params ?? {})}`;
    let hit = indicatorCache.get(key);
    if (!hit) {
      hit = computeIndicator(spec.id, bars, spec.params ?? {});
      indicatorCache.set(key, hit);
    }
    return hit;
  };

  // Indicators are computed once over the whole series. The strategy can only
  // read index <= i, so precomputing costs nothing in correctness and turns an
  // O(n²) recompute into one pass.
  const declared = strategy.indicators ?? {};
  const series = {};
  for (const [name, spec] of Object.entries(declared)) {
    if (!spec || typeof spec.id !== 'string') {
      throw new Error(`Strategy indicator "${name}" needs an { id, params } shape`);
    }
    const result = compute(spec);
    const key = spec.output ?? Object.keys(result)[0];
    if (!(key in result)) {
      throw new Error(`Indicator "${name}" (${spec.id}) has no output "${key}"`);
    }
    series[name] = result[key];
  }

  /* Event indicators, bucketed by the bar that confirmed each object. Same
   * precompute-once argument as the series above: the strategy can only reach
   * bucket i while it is on bar i, so computing the whole thing up front costs
   * nothing in correctness. */
  const declaredEvents = strategy.events ?? {};
  const buckets = {};
  for (const [name, spec] of Object.entries(declaredEvents)) {
    if (!spec || typeof spec.id !== 'string') {
      throw new Error(`Strategy event "${name}" needs an { id, params } shape`);
    }
    const result = compute(spec);
    const key = spec.output ?? Object.keys(result)[0];
    if (!(key in result)) {
      throw new Error(`Event "${name}" (${spec.id}) has no output "${key}"`);
    }
    const items = result[key];
    if (!Array.isArray(items)) {
      throw new Error(`Event "${name}" (${spec.id}) must produce an array, got ${typeof items}`);
    }

    const byBar = new Array(bars.length);
    for (const item of items) {
      const at = item?.index;
      if (!Number.isInteger(at)) {
        throw new Error(`Event "${name}" (${spec.id}) produced an item with no integer index`);
      }
      // Outside the run entirely - nothing on this pass can act on it.
      if (at < 0 || at >= bars.length) continue;
      (byBar[at] ??= []).push(item);
    }
    buckets[name] = byBar;
  }
  const eventNames = Object.keys(buckets);

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

    /**
     * The events of `name` that this bar confirmed, oldest first, or an empty
     * array. Never anything from a later bar: the bucket is keyed by the index
     * at which each item became knowable.
     */
    events(name) {
      const byBar = buckets[name];
      if (!byBar) {
        throw new Error(
          `Unknown event "${name}". Declared: ${eventNames.join(', ') || 'none'}`,
        );
      }
      return byBar[i] ?? EMPTY;
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
    /* How long one bar is. Reported because a stored run is read back long
     * after the fact by things that only have the trades — a trade review has
     * to know how much chart a trade is worth without re-deriving it. */
    stepMs: Number.isFinite(step) ? step : null,
    /* The costs the run was actually charged, not the overrides it was handed.
     * A caller that passes nothing gets the Broker's defaults, and a run that
     * stored `{}` would claim to have been free — worse, it would look
     * comparable to a run made after someone changed those defaults. */
    costs: { ...broker.costs },
    initialBalance: broker.initialBalance,
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

/**
 * A cache key that does not depend on the order the parameters were written in.
 *
 * `JSON.stringify` preserves insertion order, so `{a:1,b:2}` and `{b:2,a:1}`
 * would be two entries for one computation — and a sweep, which builds its
 * parameter objects programmatically, produces exactly that kind of variation.
 */
function stableKey(params) {
  const keys = Object.keys(params).sort();
  return JSON.stringify(keys.map((k) => [k, params[k]]));
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
