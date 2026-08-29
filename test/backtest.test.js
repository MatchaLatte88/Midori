import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runBacktest } from '../electron/engine/backtest.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);

const NO_COSTS = { costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } };

/** Bars from a list of closes; the range hugs the close unless widened. */
function series(closes, step = HOUR, spread = 0) {
  return closes.map((c, i) => ({
    time: T0 + i * step,
    open: c,
    high: c + spread,
    low: c - spread,
    close: c,
    volume: 1,
  }));
}

test('the strategy cannot see past the current bar', () => {
  const bars = series([1, 2, 3, 4, 5]);
  const seen = [];

  runBacktest({
    bars,
    broker: NO_COSTS,
    strategy: {
      onBar(ctx) {
        const h = ctx.history(10);
        seen.push({ index: ctx.index, last: h.at(-1).close, length: h.length });
        assert.equal(h.at(-1).time, ctx.bar.time, 'history ends at the current bar');
      },
    },
  });

  assert.deepEqual(seen.map((s) => s.last), [1, 2, 3, 4, 5]);
  assert.deepEqual(seen.map((s) => s.length), [1, 2, 3, 4, 5], 'history grows, never overshoots');
});

test('indicator lookback reaches into the past, never the future', () => {
  const bars = series([10, 20, 30, 40, 50]);
  const rows = [];

  runBacktest({
    bars,
    broker: NO_COSTS,
    strategy: {
      indicators: { ma: { id: 'sma', params: { period: 2 } } },
      onBar(ctx) {
        rows.push({ index: ctx.index, now: ctx.ind('ma'), prev: ctx.ind('ma', 1) });
      },
    },
  });

  // SMA(2) over 10,20,30,40,50 → null,15,25,35,45; warm-up skips index 0.
  assert.equal(rows[0].index, 1);
  assert.equal(rows[0].now, 15);
  assert.equal(rows[0].prev, null, 'before the indicator existed there is nothing to read');
  assert.equal(rows[1].now, 25);
  assert.equal(rows[1].prev, 15);
});

test('warm-up bars are skipped and reported', () => {
  const bars = series([1, 2, 3, 4, 5, 6, 7, 8]);
  let calls = 0;

  const result = runBacktest({
    bars,
    broker: NO_COSTS,
    strategy: {
      indicators: { ma: { id: 'sma', params: { period: 5 } } },
      onBar() { calls++; },
    },
  });

  assert.equal(result.warmupBars, 4, 'the first four have no SMA(5)');
  assert.equal(calls, 4, 'and onBar ran on the remaining four');
});

test('an unknown indicator name fails loudly rather than returning undefined', () => {
  const bars = series([1, 2, 3]);
  assert.throws(() => runBacktest({
    bars,
    broker: NO_COSTS,
    strategy: { onBar(ctx) { ctx.ind('nope'); } },
  }), /Unknown indicator "nope"/);
});

test('a trade entered on a signal fills on the following bar', () => {
  const bars = series([100, 100, 100, 100]);

  const result = runBacktest({
    bars,
    broker: NO_COSTS,
    strategy: {
      onBar(ctx) {
        if (ctx.index === 1 && ctx.isFlat) ctx.buy({ size: 1 });
      },
    },
  });

  assert.equal(result.fills.length, 1);
  assert.equal(result.fills[0].time, bars[2].time, 'filled on bar 2, not bar 1');
});

test('sub-bars from inside a gap are not attributed to the bar before it', () => {
  // Two hourly bars an hour apart, then a jump: bar 1 sits at T0+2h.
  const bars = [
    { time: T0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { time: T0 + 2 * HOUR, open: 100, high: 100, low: 100, close: 100, volume: 1 },
  ];
  // A minute inside the gap trades at 80 — it belongs to neither bar.
  const baseBars = [
    { time: T0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { time: T0 + HOUR, open: 80, high: 80, low: 80, close: 80, volume: 1 },
    { time: T0 + 2 * HOUR, open: 100, high: 100, low: 100, close: 100, volume: 1 },
  ];

  const result = runBacktest({
    bars,
    baseBars,
    stepMs: HOUR,
    broker: NO_COSTS,
    strategy: {
      init(ctx) { ctx.order({ side: 'buy', size: 1, type: 'limit', limitPrice: 85 }); },
      onBar() {},
    },
  });

  assert.equal(result.fills.length, 0,
    'a price that only existed inside the gap must not fill an order');
});

test('an intrabar-resolved run reports how fills were decided', () => {
  const bars = series([100, 100], HOUR, 5);
  const baseBars = series([100, 100, 100, 100], MIN, 5);

  const withMinutes = runBacktest({
    bars, baseBars, stepMs: HOUR, broker: NO_COSTS, strategy: { onBar() {} },
  });
  assert.equal(withMinutes.resolution, 'intrabar');

  const without = runBacktest({ bars, stepMs: HOUR, broker: NO_COSTS, strategy: { onBar() {} } });
  assert.equal(without.resolution, 'pessimistic');
});

test('the equity curve has one point per traded bar and tracks drawdown', () => {
  const bars = series([100, 100, 120, 90, 110]);

  const result = runBacktest({
    bars,
    broker: { balance: 1000, ...NO_COSTS },
    strategy: {
      onBar(ctx) {
        if (ctx.index === 0) ctx.buy({ size: 1 });
      },
    },
  });

  assert.equal(result.equityCurve.length, bars.length);
  // Filled at bar 1 open (100). Equity then follows the close: 100,120,90,110.
  assert.equal(result.equityCurve[1].equity, 1000);
  assert.equal(result.equityCurve[2].equity, 1020);
  assert.equal(result.equityCurve[3].equity, 990);
  assert.ok(Math.abs(result.stats.maxDrawdown - 30) < 1e-9, 'peak 1020 down to 990');
});

test('statistics on an account that never traded say so instead of showing zeros', () => {
  const result = runBacktest({
    bars: series([1, 2, 3]),
    broker: NO_COSTS,
    strategy: { onBar() {} },
  });

  assert.equal(result.stats.tradeCount, 0);
  assert.equal(result.stats.winRate, null, 'no trades means no win rate, not 0%');
  assert.equal(result.stats.expectancy, null);
  assert.equal(result.stats.avgWin, null);
  assert.equal(result.stats.netPnl, 0);
});

test('win rate, profit factor and expectancy add up over a known set of trades', () => {
  // Three round trips: +20, -10, +10 on one unit each.
  const closes = [100, 100, 120, 120, 110, 110, 120, 120];
  const bars = series(closes);

  const result = runBacktest({
    bars,
    broker: { balance: 1000, ...NO_COSTS },
    strategy: {
      onBar(ctx) {
        const i = ctx.index;
        if (i === 0 || i === 2 || i === 4) ctx.buy({ size: 1 });
        if (i === 1 || i === 3 || i === 5) ctx.close();
      },
    },
  });

  const { stats } = result;
  assert.equal(stats.tradeCount, 3);
  assert.equal(stats.winCount, 2);
  assert.equal(stats.lossCount, 1);
  assert.ok(Math.abs(stats.winRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(stats.profitFactor - 30 / 10) < 1e-9, 'gross profit 30 over gross loss 10');
  assert.ok(Math.abs(stats.expectancy - 20 / 3) < 1e-9);
  assert.ok(Math.abs(stats.netPnl - 20) < 1e-9);
});

test('profit factor is null rather than Infinity when nothing lost', () => {
  const bars = series([100, 100, 120, 120]);
  const result = runBacktest({
    bars,
    broker: { balance: 1000, ...NO_COSTS },
    strategy: {
      onBar(ctx) {
        if (ctx.index === 0) ctx.buy({ size: 1 });
        if (ctx.index === 1) ctx.close();
      },
    },
  });
  assert.equal(result.stats.lossCount, 0);
  assert.equal(result.stats.profitFactor, null, 'a number here would be a made-up one');
});

test('strategy state survives across bars and init runs first', () => {
  const order = [];
  runBacktest({
    bars: series([1, 2, 3]),
    broker: NO_COSTS,
    strategy: {
      init(ctx) { order.push('init'); ctx.state.count = 0; },
      onBar(ctx) { ctx.state.count++; order.push(`bar${ctx.index}`); },
      onFinish(ctx) { order.push(`finish:${ctx.state.count}`); },
    },
  });
  assert.deepEqual(order, ['init', 'bar0', 'bar1', 'bar2', 'finish:3']);
});

test('a position left open at the end is reported, not silently dropped', () => {
  const result = runBacktest({
    bars: series([100, 100, 130]),
    broker: { balance: 1000, ...NO_COSTS },
    strategy: {
      onBar(ctx) { if (ctx.index === 0) ctx.buy({ size: 1 }); },
    },
  });

  assert.equal(result.trades.length, 0, 'it never closed, so it is not a trade');
  assert.ok(result.openPosition, 'but it is still reported');
  assert.equal(result.openPosition.size, 1);
  assert.ok(Math.abs(result.stats.finalEquity - 1030) < 1e-9, 'and marked to the last close');
});

test('ctx.close is the action; prices come from ctx.bar', () => {
  // These two collided once: a `close` price getter and a `close()` method on
  // the same object, where the method silently won and every price read
  // returned a function.
  const bars = series([100, 100, 130]);
  let checked = false;

  const result = runBacktest({
    bars,
    broker: { balance: 1000, ...NO_COSTS },
    strategy: {
      onBar(ctx) {
        assert.equal(typeof ctx.close, 'function', 'ctx.close closes the position');
        assert.equal(typeof ctx.bar.close, 'number', 'the price lives on ctx.bar');
        assert.equal(ctx.bar.close, bars[ctx.index].close);
        checked = true;
        if (ctx.index === 0) ctx.buy({ size: 1 });
        if (ctx.index === 1) ctx.close();
      },
    },
  });

  assert.ok(checked);
  assert.equal(result.trades.length, 1, 'and closing actually worked');
});

test('a protective level that is not a number is rejected by name', () => {
  const bars = series([100, 100, 100]);
  assert.throws(() => runBacktest({
    bars,
    broker: NO_COSTS,
    strategy: {
      onBar(ctx) { if (ctx.index === 0) ctx.buy({ size: 1, stopLoss: NaN }); },
    },
  }), /stopLoss must be a finite number/);

  assert.throws(() => runBacktest({
    bars,
    broker: NO_COSTS,
    strategy: {
      onBar(ctx) { if (ctx.index === 0) ctx.buy({ size: 1, takeProfit: undefined + 1 }); },
    },
  }), /takeProfit must be a finite number/);
});

test('bad inputs are rejected', () => {
  assert.throws(() => runBacktest({ bars: [], strategy: { onBar() {} } }), /no bars/);
  assert.throws(() => runBacktest({ bars: series([1, 2]), strategy: {} }), /onBar\(ctx\)/);
  assert.throws(() => runBacktest({
    bars: series([1, 2]),
    strategy: { indicators: { x: {} }, onBar() {} },
  }), /needs an \{ id, params \} shape/);
  assert.throws(() => runBacktest({
    bars: series([1, 2, 3]),
    strategy: { onBar(ctx) { ctx.history(0); } },
  }), /n must be a positive integer/);
});
