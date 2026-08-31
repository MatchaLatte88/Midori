import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RISK_PARAMS, STRATEGIES, buildStrategy, positionSize, resolveStrategyParams,
  strategyCatalog,
} from '../shared/strategies/index.js';
import { runBacktest } from '../electron/engine/backtest.js';

/* ─── Sizing ────────────────────────────────────────────────────────────── */

test('size is derived so the stop costs exactly the intended risk', () => {
  // 1% of 10,000 is 100; a stop 5 away buys 20 units.
  assert.equal(positionSize(10_000, 100, 95, 'percent', 1, 100), 20);
  // A wider stop buys a smaller position rather than a bigger loss.
  assert.equal(positionSize(10_000, 100, 90, 'percent', 1, 100), 10);
  // Direction does not matter; the distance does.
  assert.equal(positionSize(10_000, 100, 105, 'percent', 1, 100), 20);
});

test('fixed risk ignores the account size', () => {
  assert.equal(positionSize(10_000, 100, 95, 'fixed', 100, 100), 20);
  assert.equal(positionSize(50_000, 100, 95, 'fixed', 100, 100), 20);
  // Percent does not: the stake grows with the account.
  assert.equal(positionSize(20_000, 100, 95, 'percent', 1, 100), 40);
});

test('a stop at the entry has no size rather than an infinite one', () => {
  assert.equal(positionSize(10_000, 100, 100, 'percent', 1), null);
});

test('an account with nothing left cannot open a position', () => {
  assert.equal(positionSize(0, 100, 95, 'percent', 1), null);
  assert.equal(positionSize(-500, 100, 95, 'percent', 1), null);
  // Nor can a risk of nothing.
  assert.equal(positionSize(10_000, 100, 95, 'fixed', 0), null);
});

test('leverage caps the notional a position may carry', () => {
  /* Risking 1% of 10,000 behind a stop 0.5 away computes 200 units — 20,000 of
   * notional at a price of 100, which is twice the account. At 1x it is capped
   * to 100 units, and the realised risk falls below the 1% that was asked for. */
  assert.equal(positionSize(10_000, 100, 99.5, 'percent', 1, 1), 100);
  assert.equal(positionSize(10_000, 100, 99.5, 'percent', 1, 2), 200);
  // Below the ceiling the cap does nothing at all.
  assert.equal(positionSize(10_000, 100, 90, 'percent', 1, 1), 10);
});

test('the leverage cap defaults to spot', () => {
  // No fourth argument must not mean "unlimited" — that is how a backtest ends
  // up describing an account nobody could hold.
  assert.equal(positionSize(10_000, 100, 99.5, 'percent', 1), 100);
});

/* ─── The registry ──────────────────────────────────────────────────────── */

test('every strategy carries the shared risk settings', () => {
  /* Two runs that named their risk differently would not be comparable, and
   * comparing runs is the reason they are stored at all. */
  for (const [id, spec] of Object.entries(STRATEGIES)) {
    const keys = spec.params.map((p) => p.key);
    for (const shared of RISK_PARAMS) {
      assert.ok(keys.includes(shared.key), `${id} is missing ${shared.key}`);
    }
  }
});

test('every strategy parameter explains itself', () => {
  // The panel builds its fields from this, so a new setting cannot arrive
  // without its label and its explanation.
  for (const [id, spec] of Object.entries(STRATEGIES)) {
    assert.ok(spec.name, `${id} has no name`);
    assert.ok(spec.description, `${id} has no description`);
    for (const p of spec.params) {
      assert.ok(p.label, `${id}.${p.key} has no label`);
      assert.ok(p.hint, `${id}.${p.key} has no hint`);
      assert.ok(p.type, `${id}.${p.key} has no type`);
    }
  }
});

test('parameters resolve to their defaults and validate what is given', () => {
  const p = resolveStrategyParams('silverbullet', {});
  assert.equal(p.riskMode, 'percent');
  assert.equal(p.riskValue, 1);
  assert.equal(p.rrr, 2);
  assert.equal(p.maxLeverage, 1);

  assert.equal(resolveStrategyParams('silverbullet', { rrr: 3 }).rrr, 3);
  assert.throws(() => resolveStrategyParams('silverbullet', { rrr: 0 }), /below/);
  assert.throws(() => resolveStrategyParams('silverbullet', { riskMode: 'kelly' }), /not one of/);
  assert.throws(() => resolveStrategyParams('silverbullet', { rrr: 'lots' }), /not a number/);
  assert.throws(() => resolveStrategyParams('silverbullet', { windows: 'am' }), /expected a list/);
  assert.throws(() => resolveStrategyParams('nope', {}), /Unknown strategy/);
});

test('the catalog carries no functions across the bridge', () => {
  /* It is sent to the renderer over IPC, where anything unserialisable throws
   * rather than arriving as undefined. */
  for (const entry of strategyCatalog()) {
    assert.equal(entry.build, undefined, `${entry.id} still carries build()`);
    assert.doesNotThrow(() => structuredClone(entry), `${entry.id} is not cloneable`);
  }
});

test('resolved parameters survive the trip to the main process', () => {
  /* Everything sent over IPC goes through the structured clone algorithm,
   * which refuses a Proxy — and a Vue ref makes its object deeply reactive, so
   * the params object and every array inside it are Proxies. The panel sends a
   * JSON copy for exactly this reason; this holds the other half of the deal,
   * that the resolved shape is plain data a JSON copy cannot damage. */
  const resolved = resolveStrategyParams('silverbullet', { windows: ['am', 'pm'] });

  assert.doesNotThrow(() => structuredClone(resolved));
  assert.deepEqual(JSON.parse(JSON.stringify(resolved)), resolved,
    'a parameter would not survive being sent');
});

test('a built strategy has what the engine requires', () => {
  const s = buildStrategy('silverbullet', {});
  assert.equal(typeof s.onBar, 'function');
  assert.ok(s.events?.setups, 'Silver Bullet reads its setups as events');
  assert.equal(s.events.setups.id, 'silverbullet', 'it uses the chart indicator, not a copy');
});

test('strategy parameters reach the detector it declares', () => {
  const s = buildStrategy('silverbullet', { minGapSize: 42, strength: 7 });
  assert.equal(s.events.setups.params.minGapSize, 42);
  assert.equal(s.events.setups.params.strength, 7);
  /* rrr belongs to the strategy, not the detector — the shared one governs the
   * target, so the detector's copy must not be overridden from here. */
  assert.equal(s.events.setups.params.rrr, undefined);
});

/* ─── Against the engine ────────────────────────────────────────────────── */

/** 5m bars from 09:15 New York, so bar 9 lands in the NY AM window. */
const START = Date.UTC(2026, 6, 1, 13, 15);
const bars = (rows) => rows.map(([open, high, low, close], i) => ({
  time: START + i * 300_000, open, high, low, close, volume: 1,
}));

/* The same complete long chain used in test/silverBullet.test.js, with room
 * after it for the trade to resolve. */
const CHAIN = [
  [100, 101, 98, 100],
  [100, 101, 97, 99],
  [99, 100, 95, 97],
  [97, 99, 96, 98],
  [98, 100, 97, 99],
  [99, 99, 94, 98],
  [98, 103, 98, 102],
  [102, 108, 101, 107],
  [107, 112, 105, 110],
  [110, 111, 104, 106],
  [106, 130, 105, 128],
  [128, 132, 126, 130],
];

test('a setup becomes a real order against the engine', () => {
  const result = runBacktest({
    bars: bars(CHAIN),
    strategy: buildStrategy('silverbullet', { maxLeverage: 10 }),
    broker: { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } },
  });

  assert.equal(result.orders.length > 0, true, 'the strategy placed nothing');
  const entry = result.orders.find((o) => o.type === 'market');
  assert.ok(entry, 'no market entry was sent');
  assert.equal(entry.side, 'buy', 'a swept low is a long');
});

test('the fill lands on the bar after the signal, never on it', () => {
  /* The engine rule that makes the whole thing honest: an order cannot fill on
   * the bar that created it. The detector says the entry was on bar 9; the
   * strategy can only be filled from bar 10 onwards. */
  const result = runBacktest({
    bars: bars(CHAIN),
    strategy: buildStrategy('silverbullet', { maxLeverage: 10 }),
    broker: { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } },
  });

  const fill = result.fills.find((f) => f.tag !== 'stop-loss' && f.tag !== 'take-profit');
  assert.ok(fill, 'nothing was filled');
  assert.ok(fill.time > bars(CHAIN)[9].time, 'filled on the signal bar itself');
});

test('a run reports the costs it was actually charged', () => {
  /* Reported by the engine rather than echoed from the request: a caller that
   * passes nothing still gets the Broker's defaults, and a run that stored the
   * empty override would claim to have been free. */
  const result = runBacktest({
    bars: bars(CHAIN),
    strategy: buildStrategy('silverbullet', {}),
    broker: { balance: 10_000 },
  });

  assert.ok(result.costs.feeRate > 0, 'the defaults were not reported');
  assert.equal(result.initialBalance, 10_000);

  // An override is reported as the value that was actually used.
  const cheaper = runBacktest({
    bars: bars(CHAIN),
    strategy: buildStrategy('silverbullet', {}),
    broker: { balance: 10_000, costs: { feeRate: 0 } },
  });
  assert.equal(cheaper.costs.feeRate, 0);
  assert.equal(cheaper.costs.spreadPct, result.costs.spreadPct, 'untouched costs keep their default');
});

test('no window means no trades, whatever the chart shows', () => {
  const result = runBacktest({
    bars: bars(CHAIN),
    strategy: buildStrategy('silverbullet', { windows: ['london'] }),
    broker: { balance: 10_000 },
  });
  assert.equal(result.trades.length, 0);
  assert.equal(result.orders.length, 0);
});

test('a run over bars with no setups is empty rather than an error', () => {
  const flat = bars(Array.from({ length: 40 }, () => [100, 100.5, 99.5, 100]));
  const result = runBacktest({
    bars: flat,
    strategy: buildStrategy('silverbullet', {}),
    broker: { balance: 10_000 },
  });

  assert.equal(result.trades.length, 0);
  assert.equal(result.stats.tradeCount, 0);
  // No trades means no win rate; 0% would read as "always lost".
  assert.equal(result.stats.winRate, null);
  assert.equal(result.stats.netPnl, 0);
});

test('the risk setting changes the size and nothing else', () => {
  const run = (params) => runBacktest({
    bars: bars(CHAIN),
    strategy: buildStrategy('silverbullet', { maxLeverage: 100, ...params }),
    broker: { balance: 10_000, costs: { feeRate: 0, spreadPct: 0, slippagePct: 0 } },
  });

  const small = run({ riskValue: 1 });
  const large = run({ riskValue: 2 });

  assert.equal(small.trades.length, large.trades.length, 'the trades taken must not change');
  if (small.trades.length > 0) {
    assert.ok(large.trades[0].size > small.trades[0].size, 'twice the risk is a larger position');
    // Same prices, so the same trade at twice the size loses or wins twice as much.
    assert.equal(large.trades[0].entryPrice, small.trades[0].entryPrice);
  }
});
