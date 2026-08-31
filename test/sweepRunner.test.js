import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SweepCancelled, runSweep } from '../electron/engine/sweepRunner.js';

/* A year of hourly bars from a fixed start. Whether they produce trades does
 * not matter for what is checked here — the structure of a sweep has to hold
 * on a flat market too, and a market that produces no trades is the case most
 * likely to be handled carelessly. */
const START = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;

function bars(count, shape = (i) => [100, 101, 99, 100]) {
  return Array.from({ length: count }, (_, i) => {
    const [open, high, low, close] = shape(i);
    return { time: START + i * HOUR, open, high, low, close, volume: 1 };
  });
}

const RANGE = { from: START, to: START + 2000 * HOUR };

const sweep = (over = {}) => runSweep({
  strategy: 'silverbullet',
  ranges: { rrr: { from: 1, to: 3, step: 1 } },
  base: { riskValue: 1 },
  bars: bars(2000),
  from: RANGE.from,
  to: RANGE.to,
  minTrades: 0,
  ...over,
});

/* ─── What comes back ───────────────────────────────────────────────────── */

test('every combination is run and reported', () => {
  const result = sweep({ ranges: { rrr: { from: 1, to: 3, step: 0.5 } } });

  assert.equal(result.combinationCount, 5);
  assert.equal(result.results.length, 5);
  assert.deepEqual(result.results.map((r) => r.params.rrr), [1, 1.5, 2, 2.5, 3]);
});

test('fixed parameters ride along on every combination', () => {
  const result = sweep({ base: { riskValue: 2, riskMode: 'fixed' } });
  for (const entry of result.results) {
    assert.equal(entry.params.riskValue, 2);
    assert.equal(entry.params.riskMode, 'fixed');
  }
});

test('only the figures are kept, never the trades', () => {
  /* Thousands of combinations are stored in one file; a trade log per
   * combination would be megabytes of something nothing reads. */
  const result = sweep();
  for (const entry of result.results) {
    assert.equal(entry.stats.trades, undefined);
    assert.equal(entry.stats.equityCurve, undefined);
    assert.equal(typeof entry.stats.tradeCount, 'number');
  }
});

test('a market with no trades sweeps to no trades rather than an error', () => {
  const result = sweep();
  assert.equal(result.results.length, 3);
  for (const entry of result.results) assert.equal(entry.stats.tradeCount, 0);
});

/* ─── The split ─────────────────────────────────────────────────────────── */

test('the two stretches meet and do not overlap', () => {
  /* A bar counted in both would let a combination be chosen partly on a bar it
   * is then checked against — the one thing the split exists to prevent. */
  const result = sweep({ trainFraction: 0.7 });

  assert.ok(result.split, 'no split was made');
  assert.equal(result.split.train.to, result.split.test.from);
  assert.equal(result.split.train.from, RANGE.from);
  assert.equal(result.split.test.to, RANGE.to);
  // Every bar lands on exactly one side.
  assert.equal(result.split.trainBars + result.split.testBars, 2000);
});

test('the training fraction moves the cut', () => {
  const seventy = sweep({ trainFraction: 0.7 });
  const half = sweep({ trainFraction: 0.5 });

  assert.ok(half.split.trainBars < seventy.split.trainBars);
  assert.equal(half.split.trainBars, 1000);
});

test('a fraction of zero runs everything on the whole range', () => {
  const result = sweep({ trainFraction: 0 });
  assert.equal(result.split, null);
  // With nothing held back there is nothing to check the winners against.
  for (const entry of result.best) assert.equal(entry.outOfSample, undefined);
});

test('the shown combinations carry an out-of-sample result', () => {
  const result = sweep({ trainFraction: 0.7, showCount: 2 });
  for (const entry of [...result.best, ...result.worst]) {
    assert.ok(entry.outOfSample, 'a shown combination was never re-checked');
    assert.equal(typeof entry.outOfSample.tradeCount, 'number');
  }
});

test('only the shown combinations are re-checked', () => {
  /* Re-running all of them would double the cost of the sweep to produce
   * numbers nobody looks at. */
  const result = sweep({
    ranges: { rrr: { from: 1, to: 3, step: 0.25 } },   // 9 combinations
    showCount: 2,
  });

  assert.equal(result.results.length, 9);
  const checked = result.results.filter((r) => r.outOfSample);
  assert.equal(checked.length, 0, 'the full list must stay in-sample only');
  assert.ok(result.best.length <= 2);
});

/* ─── Ranking and exclusion ─────────────────────────────────────────────── */

test('combinations below the trade floor are counted, not ranked', () => {
  const result = sweep({ minTrades: 5 });
  // A flat market takes no trades, so every combination falls below any floor.
  assert.equal(result.rankedCount, 0);
  assert.equal(result.excludedCount, result.combinationCount);
  assert.deepEqual(result.best, []);
});

test('the sweep records how it was ranked, so a result can be read later', () => {
  const result = sweep({ metric: 'netPnl', minTrades: 3, trainFraction: 0.6 });
  assert.equal(result.metric, 'netPnl');
  assert.equal(result.minTrades, 3);
  assert.equal(result.trainFraction, 0.6);
  assert.deepEqual(result.ranges, { rrr: { from: 1, to: 3, step: 1 } });
});

/* ─── Stopping ──────────────────────────────────────────────────────────── */

test('a sweep stops when asked, without finishing the rest', () => {
  let seen = 0;
  assert.throws(
    () => sweep({
      ranges: { rrr: { from: 1, to: 5, step: 0.25 } },   // 17 combinations
      onProgress: () => { seen++; },
      shouldStop: () => seen >= 3,
    }),
    SweepCancelled,
  );
  assert.ok(seen < 17, `it ran ${seen} of 17 after being stopped`);
});

test('a stop is not an error to be confused with a failure', () => {
  try {
    sweep({ shouldStop: () => true });
    assert.fail('it should have stopped');
  } catch (err) {
    assert.equal(err.name, 'SweepCancelled');
    assert.ok(err instanceof Error, 'it still has to be catchable as an error');
  }
});

/* ─── Refusing what cannot work ─────────────────────────────────────────── */

test('a bad parameter is caught before anything runs', () => {
  /* A step that produces an invalid value on combination 900 would otherwise
   * waste everything up to it. */
  assert.throws(
    () => sweep({ ranges: { rrr: { from: 0, to: 2, step: 1 } } }),
    /rrr/,
  );
});

test('a sweep with nothing to sweep is refused', () => {
  assert.throws(() => sweep({ ranges: {} }), /no ranges/);
});

test('a sweep with no bars is refused rather than reporting nothing', () => {
  assert.throws(() => sweep({ bars: [] }), /no bars/);
});

test('a range whose training stretch holds no bars is refused', () => {
  // Bars that all fall outside the declared range.
  assert.throws(
    () => sweep({ bars: bars(10), from: START + 5000 * HOUR, to: START + 6000 * HOUR }),
    /no bars/,
  );
});
