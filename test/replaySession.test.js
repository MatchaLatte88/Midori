/* Replay against the same engine a backtest runs on.
 *
 * The property that decides whether a replay is a test or a game: an order
 * placed while the playhead is on a bar is matched against the *next* one, at
 * the same costs a strategy would have paid. A replay that filled at the close
 * a person had just finished reading would flatter every session, and there
 * would be no point comparing one to a backtest afterwards.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ReplaySession } from '../shared/engine/replaySession.js';
import { resetOrderIds } from '../shared/engine/broker.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);

const FREE = { feeRate: 0, spreadPct: 0, slippagePct: 0 };

/** Hourly bars from a compact [open, high, low, close] list. */
function bars(rows, step = HOUR) {
  return rows.map(([open, high, low, close], i) => ({
    time: T0 + i * step, open, high, low, close, volume: 1,
  }));
}

/** A flat market, so a test measures the mechanics and not the price. */
function flat(count, price = 100) {
  return bars(Array.from({ length: count }, () => [price, price + 1, price - 1, price]));
}

function session(over = {}) {
  return new ReplaySession({
    bars: flat(10), startIndex: 2, balance: 10_000, costs: FREE, ...over,
  });
}

beforeEach(() => resetOrderIds());

/* ─── The playhead ──────────────────────────────────────────────────────── */

test('the session starts on the bar it was told to and no further', () => {
  const s = session();
  assert.equal(s.index, 2);
  assert.equal(s.bar.time, T0 + 2 * HOUR);
  assert.equal(s.progress, 0);
});

test('a start outside the bars is refused rather than clamped', () => {
  assert.throws(() => session({ startIndex: 99 }), /outside the 10 bars/);
  assert.throws(() => session({ startIndex: -1 }), /outside the 10 bars/);
  assert.throws(() => session({ startIndex: 1.5 }), /outside the 10 bars/);
});

test('a session with no bars is refused', () => {
  assert.throws(() => new ReplaySession({ bars: [], startIndex: 0 }), /no bars/);
});

test('stepping past the last loaded bar throws instead of standing still', () => {
  const s = session({ bars: flat(4), startIndex: 2 });
  s.step();
  assert.equal(s.atEnd, true);
  assert.throws(() => s.step(), /no bar after this one/);
});

/* ─── The one rule ──────────────────────────────────────────────────────── */

test('an order placed at the playhead cannot fill on the bar it was placed on', () => {
  const s = session();
  s.broker.placeOrder({ side: 'buy', size: 1, type: 'market' });

  assert.equal(s.broker.fills.length, 0, 'the visible bar is already closed');
  assert.equal(s.broker.isFlat, true);
});

test('it fills on the bar the next step reveals, at that bar’s open', () => {
  const s = new ReplaySession({
    bars: bars([
      [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
      [107, 108, 106, 107],
    ]),
    startIndex: 2,
    costs: FREE,
  });

  s.broker.placeOrder({ side: 'buy', size: 1, type: 'market' });
  s.step();

  assert.equal(s.broker.fills.length, 1);
  assert.equal(s.broker.fills[0].price, 107, 'the open of the revealed bar, not the read close');
});

test('a manual trade pays the same costs a strategy would', () => {
  const s = new ReplaySession({
    bars: flat(6),
    startIndex: 2,
    balance: 10_000,
    costs: { feeRate: 0.001, spreadPct: 0.0002, slippagePct: 0.0002 },
  });

  s.buy({ size: 1 });
  s.step();

  const fill = s.broker.fills[0];
  // Half the spread plus slippage on a market order, then commission on top.
  assert.ok(fill.price > 100, `paid ${fill.price} for a 100 market`);
  assert.ok(fill.fee > 0, 'commission was charged');
  assert.ok(s.broker.balance < 10_000, 'a round trip cannot start free');
});

/* ─── Fills inside the bar ──────────────────────────────────────────────── */

test('the minutes decide a bar that touches both stop and target', () => {
  /* The bar reaches the target first and the stop afterwards. Given its
   * minutes the session sees that order; without them the Broker's
   * pessimistic rule takes the stop. Same divergence as the backtest, because
   * it is the same code deciding it. */
  const rows = [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [100, 110, 90, 95],
  ];

  const minutes = [
    { time: T0 + 3 * HOUR, open: 100, high: 110, low: 100, close: 110, volume: 1 },
    { time: T0 + 3 * HOUR + MIN, open: 110, high: 110, low: 90, close: 95, volume: 1 },
  ];

  const resolved = new ReplaySession({ bars: bars(rows), startIndex: 2, costs: FREE });
  resolved.buy({ size: 1, stopLoss: 95, takeProfit: 105 });
  resolved.step(minutes);

  const guessed = new ReplaySession({ bars: bars(rows), startIndex: 2, costs: FREE });
  guessed.buy({ size: 1, stopLoss: 95, takeProfit: 105 });
  guessed.step();

  assert.equal(resolved.broker.trades[0].exitTag, 'take-profit');
  assert.equal(guessed.broker.trades[0].exitTag, 'stop-loss');
});

test('the session reports how its fills were actually decided', () => {
  const s = session();
  s.buy({ size: 1 });
  s.step();
  assert.equal(s.resolution, 'pessimistic', 'no minutes were handed in');

  const withMinutes = session();
  withMinutes.buy({ size: 1 });
  withMinutes.step([{ time: T0 + 3 * HOUR, open: 100, high: 101, low: 99, close: 100, volume: 1 }]);
  assert.equal(withMinutes.resolution, 'intrabar');
});

test('one guessed fill is enough to stop a session calling itself resolved', () => {
  const s = session();
  s.buy({ size: 1 });
  s.step();                                       // pessimistic
  s.close();
  s.step([{ time: T0 + 4 * HOUR, open: 100, high: 101, low: 99, close: 100, volume: 1 }]);

  assert.equal(s.broker.fills.length, 2);
  assert.equal(s.resolution, 'pessimistic');
});

/* ─── The account over time ─────────────────────────────────────────────── */

test('the curve starts on the start bar with the untouched balance', () => {
  const s = session();
  assert.deepEqual(s.equityCurve, [
    { time: T0 + 2 * HOUR, equity: 10_000, balance: 10_000, drawdown: 0 },
  ]);
});

test('every step adds one point, whether or not anything traded', () => {
  const s = session();
  s.step();
  s.step();
  assert.equal(s.equityCurve.length, 3);
  assert.equal(s.equityCurve[2].time, T0 + 4 * HOUR);
});

test('drawdown is measured against the high-water mark, not the start', () => {
  const rows = [
    [100, 100, 100, 100], [100, 100, 100, 100],
    [100, 100, 100, 100],   // playhead
    [100, 100, 100, 100],   // entry fills here
    [120, 120, 120, 120],   // +20 unrealised, a new peak
    [110, 110, 110, 110],   // back to +10: a drawdown of 10 from the peak
  ];
  const s = new ReplaySession({ bars: bars(rows), startIndex: 2, costs: FREE });
  s.buy({ size: 1 });
  s.step();
  s.step();
  s.step();

  assert.equal(s.peakEquity, 10_020);
  assert.equal(s.maxDrawdown, 10);
  assert.equal(s.maxDrawdownPct.toFixed(6), (10 / 10_020).toFixed(6));
});

/* ─── Extending the window ──────────────────────────────────────────────── */

test('more bars can be appended and stepping carries on', () => {
  const s = session({ bars: flat(4), startIndex: 2 });
  s.step();
  assert.equal(s.atEnd, true);

  const more = flat(6).slice(4).map((b, i) => ({ ...b, time: T0 + (4 + i) * HOUR }));
  assert.equal(s.extend(more), 2);
  assert.equal(s.atEnd, false);
  s.step();
  assert.equal(s.index, 4);
});

test('appending does not move a trade that already happened', () => {
  const s = session({ bars: flat(5), startIndex: 2 });
  s.buy({ size: 1 });
  s.step();
  const before = { ...s.broker.trades[0] ?? {}, fill: s.broker.fills[0].time };

  s.extend(flat(8).slice(5).map((b, i) => ({ ...b, time: T0 + (5 + i) * HOUR })));

  assert.equal(s.broker.fills[0].time, before.fill, 'the fill kept its bar');
  assert.equal(s.startIndex, 2, 'and the session still starts where it started');
});

test('bars already in the window are ignored rather than duplicated', () => {
  const s = session({ bars: flat(5), startIndex: 2 });
  assert.equal(s.extend(flat(5)), 0);
  assert.equal(s.bars.length, 5);
});

test('an out-of-order extension is refused rather than quietly sorted', () => {
  const s = session({ bars: flat(4), startIndex: 2 });
  const broken = [
    { time: T0 + 9 * HOUR, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { time: T0 + 8 * HOUR, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  ];
  assert.throws(() => s.extend(broken), /not ascending/);
});

test('extending with nothing is not an error', () => {
  const s = session();
  assert.equal(s.extend([]), 0);
  assert.equal(s.extend(null), 0);
});

/* ─── The finished session ──────────────────────────────────────────────── */

test('a session ends in the shape a backtest ends in', () => {
  const s = session();
  s.buy({ size: 1 });
  s.step();
  s.close();
  s.step();

  const result = s.result();
  for (const key of [
    'trades', 'fills', 'orders', 'equityCurve', 'openPosition', 'stats',
    'barCount', 'stepMs', 'costs', 'initialBalance', 'resolution', 'from', 'to',
  ]) {
    assert.ok(key in result, `a stored run needs ${key}`);
  }
  assert.equal(result.stats.tradeCount, 1);
  assert.equal(result.initialBalance, 10_000);
});

test('the bar duration is read off the bars when nobody says', () => {
  assert.equal(session().result().stepMs, HOUR);
  assert.equal(session({ bars: flat(6), startIndex: 1, stepMs: 999 }).result().stepMs, 999);
});

test('the range covers what was replayed, not what was loaded', () => {
  const s = session({ bars: flat(10), startIndex: 2 });
  s.step();
  s.step();

  const result = s.result();
  assert.equal(result.from, T0 + 2 * HOUR, 'from the bar it started on');
  assert.equal(result.to, T0 + 4 * HOUR + HOUR, 'to the end of the last bar stepped onto');
  assert.equal(result.barCount, 2);
});

test('a session where nothing was traded is a real result, not an error', () => {
  const s = session();
  s.step();
  const result = s.result();
  assert.equal(result.stats.tradeCount, 0);
  assert.equal(result.stats.winRate, null, 'no trades means no win rate, not zero percent');
  assert.equal(result.stats.netPnl, 0);
});

test('a position still open at the end is reported rather than hidden', () => {
  const s = session();
  s.buy({ size: 1 });
  s.step();
  assert.ok(s.result().openPosition, 'the account is not flat and says so');
  assert.equal(s.result().openPosition.size, 1);
});
