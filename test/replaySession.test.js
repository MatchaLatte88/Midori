/* Replay against the same engine a backtest runs on.
 *
 * Two properties decide whether a replay is a test or a game, and they are not
 * the same property:
 *
 *   - a bar that has not been revealed does not exist, so nothing can be
 *     decided by a price nobody has seen. A resting order waits for the bars
 *     that answer it, exactly as it does in a backtest.
 *   - a market order fills at the last price on the screen, the moment it is
 *     sent, at the same spread, slippage and commission a strategy would have
 *     paid. That is what a market order does, and the costs are what keep the
 *     result comparable to a backtest.
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

/* ─── What a resting order may be answered by ───────────────────────────── */

test('a resting order cannot be filled by the bar already on the screen', () => {
  const s = session();
  /* The bar under the playhead traded down to 99, so this level is inside it —
   * and it still may not fill: that bar closed before the order existed. */
  s.order({ side: 'buy', size: 1, type: 'limit', limitPrice: 99 });

  assert.equal(s.broker.fills.length, 0, 'the visible bar is already closed');
  assert.equal(s.broker.isFlat, true);
});

test('it is answered by the bar the next step reveals, at that bar’s open', () => {
  const s = new ReplaySession({
    bars: bars([
      [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
      [107, 108, 106, 107],
    ]),
    startIndex: 2,
    costs: FREE,
  });

  s.order({ side: 'buy', size: 1, type: 'stop', stopPrice: 105 });
  s.step();

  assert.equal(s.broker.fills.length, 1);
  assert.equal(s.broker.fills[0].price, 107, 'the open it gapped through, not the level');
});

/* ─── At market means now ───────────────────────────────────────────────── */

test('a market order fills the moment it is sent, at the last price', () => {
  const s = session();
  const order = s.buy({ size: 1 });

  assert.equal(order.status, 'filled');
  assert.equal(s.broker.fills[0].price, 100, 'the close under the playhead');
  assert.equal(s.broker.fills[0].resolution, 'immediate');
  assert.equal(s.broker.position.size, 1);
  assert.equal(s.index, 2, 'and no bar was revealed to do it');
});

test('a manual trade pays the same costs a strategy would', () => {
  const s = new ReplaySession({
    bars: flat(6),
    startIndex: 2,
    balance: 10_000,
    costs: { feeRate: 0.001, spreadPct: 0.0002, slippagePct: 0.0002 },
  });

  s.buy({ size: 1 });

  const fill = s.broker.fills[0];
  // Half the spread plus slippage on a market order, then commission on top.
  assert.ok(fill.price > 100, `paid ${fill.price} for a 100 market`);
  assert.ok(fill.fee > 0, 'commission was charged');
  assert.ok(s.broker.balance < 10_000, 'a round trip cannot start free');
});

test('the stop an entry carries is a resting order, not part of the fill', () => {
  const s = session();
  s.buy({ size: 1, stopLoss: 99.5 });

  assert.equal(s.broker.position.size, 1);
  assert.equal(s.broker.fills.length, 1, 'the entry, and nothing else');
  assert.equal(s.broker.pending.length, 1, 'the stop is waiting for a bar to answer it');
});

test('the position is open now, so a level put on it now still catches the next bar', () => {
  /* What dragging a stop off the position line comes to, one step after the
   * entry that used to be impossible until the bar had turned. */
  const s = new ReplaySession({
    bars: bars([
      [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
      [100, 101, 94, 95],
    ]),
    startIndex: 2,
    costs: FREE,
  });
  s.buy({ size: 1 });
  s.order({
    side: 'sell', size: 1, type: 'stop', stopPrice: 95, reduceOnly: true, tag: 'stop-loss',
  });

  assert.equal(s.broker.pending.length, 1);
  s.step();

  assert.equal(s.broker.isFlat, true);
  assert.equal(s.broker.trades[0].exitTag, 'stop-loss');
});

test('a bare market order goes through too; a resting one waits', () => {
  const s = session();
  const now = s.order({ side: 'buy', size: 1, type: 'market' });
  const later = s.order({ side: 'sell', size: 1, type: 'limit', limitPrice: 120 });

  assert.equal(now.status, 'filled');
  assert.equal(later.status, 'pending');
});

test('closing at market is out of the position at once', () => {
  const s = session();
  s.buy({ size: 1 });
  s.close();

  assert.equal(s.broker.isFlat, true);
  assert.equal(s.broker.trades.length, 1);
  assert.equal(s.index, 2, 'without a bar having been revealed');
});

test('closing when there is nothing open is nothing, not an error', () => {
  assert.equal(session().close(), null);
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

test('a fill taken at market is not counted among the guesses', () => {
  /* The entry's price was on the screen, so it was never in doubt; only the
   * exit was decided by a bar, and that bar handed its minutes over. Calling
   * the session pessimistic here would blame the entry for a doubt it never
   * had. */
  const rows = [
    [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100],
    [100, 101, 90, 95],
  ];
  const minutes = [{ time: T0 + 3 * HOUR, open: 100, high: 101, low: 90, close: 95, volume: 1 }];

  const s = new ReplaySession({ bars: bars(rows), startIndex: 2, costs: FREE });
  s.buy({ size: 1, stopLoss: 95 });
  s.step(minutes);

  assert.equal(s.broker.trades[0].exitTag, 'stop-loss');
  assert.deepEqual(s.broker.fills.map((f) => f.resolution), ['immediate', 'intrabar']);
  assert.equal(s.resolution, 'intrabar');
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

/* ─── Changing timeframe under a running session ────────────────────────── *
 *
 * Reading the higher timeframe and trading the lower one is the method, not a
 * preference. What the old lock protected — no bar played twice, no trade
 * moved onto a different bar — is kept by the clock instead.
 */

/** Minute bars covering the same stretch `bars()` lays out in hours. */
function minutes(hours) {
  const out = [];
  for (const bar of hours) {
    for (let m = 0; m < 60; m++) {
      out.push({
        time: bar.time + m * MIN,
        open: bar.open,
        high: m === 30 ? bar.high : bar.open,
        low: m === 30 ? bar.low : bar.open,
        close: m === 59 ? bar.close : bar.open,
        volume: 1,
      });
    }
  }
  return out;
}

test('switching to a faster timeframe keeps the playhead at the same instant', () => {
  const hours = flat(6);
  const s = new ReplaySession({ bars: hours, startIndex: 2, costs: FREE });
  s.step();

  const clock = s.clock;
  s.rebase({ bars: minutes(hours), stepMs: MIN });

  assert.equal(s.clock, clock, 'the same instant, drawn differently');
  assert.equal(s.bar.time + MIN, clock, 'and the playhead is the bar that ends there');
  assert.equal(s.stepMs, MIN);
});

test('switching back and forth lands where it started', () => {
  const hours = flat(6);
  const s = new ReplaySession({ bars: hours, startIndex: 2, costs: FREE });
  s.step();
  const before = { clock: s.clock, time: s.bar.time };

  s.rebase({ bars: minutes(hours), stepMs: MIN });
  s.rebase({ bars: hours, stepMs: HOUR });

  assert.equal(s.clock, before.clock);
  assert.equal(s.bar.time, before.time);
});

test('a slower timeframe shows the bar in progress rather than the whole of it', () => {
  const hours = flat(6);
  const mins = minutes(hours);
  const s = new ReplaySession({ bars: mins, startIndex: 130, costs: FREE, stepMs: MIN });

  // The playhead is 11 minutes into the third hour.
  const clock = s.clock;
  const running = hours[2];
  const forming = {
    time: running.time, open: running.open, high: 100.5, low: 99.5, close: 100.2, volume: 1,
  };
  s.rebase({ bars: hours, stepMs: HOUR, forming });

  assert.equal(s.clock, clock, 'the clock does not move');
  assert.equal(s.bar.time, running.time);
  assert.equal(s.bar.close, 100.2, 'as far as it has got, not as far as it will get');
  assert.equal(s.atEnd, false);
});

test('the next step finishes the bar in progress instead of skipping it', () => {
  const hours = flat(6);
  const mins = minutes(hours);
  const s = new ReplaySession({ bars: mins, startIndex: 130, costs: FREE, stepMs: MIN });
  const running = hours[2];

  s.rebase({
    bars: hours,
    stepMs: HOUR,
    forming: { ...running, close: 100.2 },
  });
  const bar = s.step(mins.filter((m) => m.time >= running.time && m.time < running.time + HOUR));

  assert.equal(bar.time, running.time, 'the same bar, now complete');
  assert.equal(bar.close, running.close);
  assert.equal(s.clock, running.time + HOUR);
  assert.equal(s.bars[s.index].close, running.close, 'and the window carries the full bar');
});

test('the minutes already played are not run through again', () => {
  const hours = bars([
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [100, 108, 92, 100],
    [100, 100, 100, 100],
  ]);
  const mins = [];
  for (const bar of hours) {
    for (let m = 0; m < 60; m++) {
      // The low of hour 2 happens in its first half, the high in its second.
      const low = bar.time === hours[2].time && m === 10;
      const high = bar.time === hours[2].time && m === 40;
      mins.push({
        time: bar.time + m * MIN,
        open: 100,
        high: high ? 108 : 100,
        low: low ? 92 : 100,
        close: 100,
        volume: 1,
      });
    }
  }

  // Played through the first half of hour 2 on minutes, past the low.
  const s = new ReplaySession({ bars: mins, startIndex: 149, costs: FREE, stepMs: MIN });

  // A stop that would have been hit by the low, placed after it happened.
  s.order({ side: 'sell', size: 1, type: 'stop', stopPrice: 95 });

  s.rebase({
    bars: hours,
    stepMs: HOUR,
    forming: { ...hours[2], high: 100, low: 100, close: 100 },
  });
  s.step(mins.filter((m) => m.time >= hours[2].time && m.time < hours[2].time + HOUR));

  assert.equal(s.broker.fills.length, 0, 'the low it would have filled at is in the past');
});

test('a trade taken before the switch stays where it happened', () => {
  const hours = flat(6);
  const s = new ReplaySession({ bars: hours, startIndex: 2, costs: FREE });
  s.buy({ size: 1 });
  const openedAt = s.broker.position.openedAt;
  const equity = s.broker.equity;

  s.rebase({ bars: minutes(hours), stepMs: MIN });

  assert.equal(s.broker.position.openedAt, openedAt);
  assert.equal(s.broker.equity, equity, 'the account is not re-marked by a redraw');
  assert.equal(s.startIndex, 120, 'the start is the same moment on the new bars');
});

test('a window that does not reach the playhead is refused', () => {
  const hours = flat(6);
  const s = new ReplaySession({ bars: hours, startIndex: 4, costs: FREE });
  assert.throws(
    () => s.rebase({ bars: hours.slice(5), stepMs: HOUR }),
    /does not reach the playhead/,
  );
});

/* ─── Managing what is open ─────────────────────────────────────────────── */

test('part of a position can be taken off, and the rest stays', () => {
  const s = session();
  s.buy({ size: 4 });
  s.closePart(3);

  assert.equal(s.broker.position.size, 1);
  assert.equal(s.broker.trades.length, 1);
  assert.equal(s.broker.trades[0].size, 3);
});

test('two entries stand as two positions, and flatten closes both', () => {
  const s = session();
  s.buy({ size: 1 });
  s.sell({ size: 2 });

  assert.equal(s.broker.positions.length, 2, 'a replay hedges — a second entry is a second idea');

  s.flatten();
  assert.equal(s.broker.isFlat, true);
  assert.equal(s.broker.trades.length, 2);
});

test('protect, break-even and a trail reach the position they name', () => {
  /* Rising, because break-even is refused on a trade that is not in front of
   * the market yet — the level would be a stop above it. */
  const s = session({ bars: bars([[100, 101, 99, 100], [100, 106, 100, 105]]), startIndex: 0 });
  s.buy({ size: 1 });
  const first = s.broker.position.id;
  s.buy({ size: 1 });
  const second = s.broker.positions[1].id;

  s.step();
  s.protect({ stopLoss: 95 }, first);
  s.setTrailing(2, {}, second);
  s.breakEven(first);

  assert.ok(s.broker.positionById(first).stopLoss >= 100, 'moved up to break-even');
  assert.equal(s.broker.positionById(second).stopLoss, null, 'not yet — nothing has moved');
  assert.ok(s.broker.positionById(second).trailing);
  assert.throws(() => s.protect({ stopLoss: 1 }, 9999), /no such position/);
});

/* ─── Putting a session down and picking it up ──────────────────────────── */

test('a restored session carries on where it stopped', () => {
  const rows = flat(12);
  const s = new ReplaySession({ bars: rows, startIndex: 2, costs: FREE });
  s.step();
  s.buy({ size: 1, stopLoss: 95 });
  s.step();

  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  const back = ReplaySession.restore(snap, { bars: rows });

  assert.equal(back.clock, s.clock);
  assert.equal(back.index, s.index);
  assert.equal(back.startIndex, s.startIndex);
  assert.equal(back.broker.equity, s.broker.equity);
  assert.equal(back.broker.position.size, 1);
  assert.equal(back.broker.pending.length, 1, 'the resting stop is still in the market');
  assert.equal(back.steps, s.steps);

  back.step();
  assert.equal(back.index, s.index + 1, 'and it moves on from there');
});

test('a restored pending order is the same object the book holds', () => {
  const rows = flat(12);
  const s = new ReplaySession({ bars: rows, startIndex: 2, costs: FREE });
  s.order({ side: 'buy', size: 1, type: 'limit', limitPrice: 90 });

  const back = ReplaySession.restore(JSON.parse(JSON.stringify(s.snapshot())), { bars: rows });
  const [pending] = back.broker.pending;
  back.broker.cancelOrder(pending.id);

  assert.equal(back.broker.pending.length, 0);
  assert.equal(back.broker.orders.find((o) => o.id === pending.id).status, 'cancelled');
});

test('a restored account does not hand out an id that is already in the book', () => {
  const rows = flat(12);
  const s = new ReplaySession({ bars: rows, startIndex: 2, costs: FREE });
  s.order({ side: 'buy', size: 1, type: 'limit', limitPrice: 90 });
  s.order({ side: 'buy', size: 1, type: 'limit', limitPrice: 89 });

  const back = ReplaySession.restore(JSON.parse(JSON.stringify(s.snapshot())), { bars: rows });
  const fresh = back.order({ side: 'buy', size: 1, type: 'limit', limitPrice: 88 });

  assert.equal(back.broker.orders.filter((o) => o.id === fresh.id).length, 1);
});

test('a snapshot that is not one is refused', () => {
  assert.throws(
    () => ReplaySession.restore({ version: 99 }, { bars: flat(4) }),
    /not a session snapshot/,
  );
});

test('the range a restored session reports is the one it actually replayed', () => {
  const rows = flat(12);
  const s = new ReplaySession({ bars: rows, startIndex: 2, costs: FREE });
  s.step();
  s.buy({ size: 1 });
  s.step();
  s.close();

  const back = ReplaySession.restore(JSON.parse(JSON.stringify(s.snapshot())), { bars: rows });
  assert.equal(back.result().from, s.result().from);
  assert.equal(back.result().to, s.result().to);
});

test('a bar in progress with no complete bar behind it becomes the last bar', () => {
  const hours = flat(6);
  const mins = minutes(hours);
  const s = new ReplaySession({ bars: mins, startIndex: 130, costs: FREE, stepMs: MIN });
  const clock = s.clock;

  /* The stored data ends inside hour 2, so the window has hours 0 and 1 only.
   * What was aggregated is then the whole of what exists, not a preview. */
  const running = hours[2];
  s.rebase({
    bars: hours.slice(0, 2),
    stepMs: HOUR,
    forming: { ...running, close: 100.2 },
  });

  assert.equal(s.clock, clock);
  assert.equal(s.bar.time, running.time);
  assert.equal(s.bar.close, 100.2);
  assert.equal(s.atEnd, true, 'and the session is at the edge of the data');
});

test('a bar in progress that does not line up with the window is refused', () => {
  const hours = flat(6);
  const mins = minutes(hours);
  const s = new ReplaySession({ bars: mins, startIndex: 130, costs: FREE, stepMs: MIN });

  assert.throws(
    () => s.rebase({ bars: hours, stepMs: HOUR, forming: { ...hours[4], close: 100 } }),
    /does not line up/,
  );
});

/* ─── Turning a position round ─────────────────────────────────────────── */

test('reverse closes what is open and opens the same size the other way', () => {
  const s = session();
  s.buy({ size: 2, tag: 'first' });
  const before = s.broker.positions[0].id;

  const order = s.reverse();

  assert.equal(s.broker.positions.length, 1, 'one position, not two');
  const now = s.broker.positions[0];
  assert.notEqual(now.id, before, 'and it is a new one, not the old one turned inside out');
  assert.equal(now.size, -2, 'same size, other way round');
  assert.equal(order.side, 'sell');

  assert.equal(s.broker.trades.length, 1, 'the long is a closed trade with its own result');
  assert.equal(s.broker.trades[0].side, 'long');
});

test('a reversal does not carry the old protection over', () => {
  const s = session();
  s.buy({ size: 1, stopLoss: 95, takeProfit: 110 });
  assert.equal(s.broker.pending.length, 2);

  s.reverse();

  assert.equal(s.broker.positions[0].stopLoss, null, 'a long’s stop is where a short is right');
  assert.equal(s.broker.positions[0].takeProfit, null);
  assert.equal(s.broker.pending.length, 0, 'and neither leg is left in the book');
});

test('both sides of a reversal fill at the same price', () => {
  const s = session();
  s.buy({ size: 1 });
  const entry = s.broker.positions[0].entryPrice;

  s.reverse();

  assert.equal(s.broker.trades[0].exitPrice, entry, 'out at the price it went in at');
  assert.equal(s.broker.positions[0].entryPrice, entry, 'and back in at the same one');
});

test('reverse names the position it turns round, where several are open', () => {
  const s = session();
  s.buy({ size: 1 });
  const first = s.broker.positions[0].id;
  s.sell({ size: 3 });
  const second = s.broker.positions[1].id;

  s.reverse(first);

  const ids = s.broker.positions.map((p) => p.id);
  assert.equal(ids.includes(second), true, 'the other one is untouched');
  assert.equal(s.broker.positionById(second).size, -3);
  assert.equal(s.broker.positions.length, 2);
  assert.equal(s.broker.positions.find((p) => p.id !== second).size, -1, 'the named one turned');
});

test('reverse refuses when there is nothing open', () => {
  const s = session();
  assert.throws(() => s.reverse(), /no such position/);
});
