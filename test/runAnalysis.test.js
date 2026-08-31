import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyseRun, breakdown, equityBaseZero, equityPercent, streaks,
} from '../shared/analysis/runAnalysis.js';

const trade = (netPnl, over = {}) => ({
  side: 'long', netPnl, openedAt: 0, closedAt: 3_600_000, entryTag: 'am', exitTag: 'take-profit', ...over,
});

/* ─── Equity ────────────────────────────────────────────────────────────── */

test('the curve is rebased so it starts at zero', () => {
  const curve = [
    { time: 1, equity: 10_000 },
    { time: 2, equity: 10_500 },
    { time: 3, equity: 9_800 },
  ];
  assert.deepEqual(equityBaseZero(curve, 10_000), [
    { time: 1, value: 0 },
    { time: 2, value: 500 },
    { time: 3, value: -200 },
  ]);
});

test('percent makes two different balances comparable', () => {
  /* The same skill on a bigger account makes more money; only the percentage
   * says whether the second run was actually better. */
  const small = equityPercent([{ time: 1, equity: 11_000 }], 10_000);
  const large = equityPercent([{ time: 1, equity: 110_000 }], 100_000);

  assert.equal(small[0].value, 10);
  assert.equal(large[0].value, 10);
});

test('a balance of zero has no percentage rather than Infinity', () => {
  assert.deepEqual(equityPercent([{ time: 1, equity: 100 }], 0), []);
});

test('an absent curve is empty rather than a crash', () => {
  assert.deepEqual(equityBaseZero(null, 10_000), []);
  assert.deepEqual(equityPercent(undefined, 10_000), []);
});

/* ─── Streaks ───────────────────────────────────────────────────────────── */

test('streaks count the longest run of each kind', () => {
  const s = streaks([
    trade(10), trade(10), trade(-5), trade(-5), trade(-5), trade(20),
  ]);
  assert.equal(s.longestWin, 2);
  assert.equal(s.longestLoss, 3);
  // Positive means the run is currently winning; the sign carries the direction.
  assert.equal(s.current, 1);
});

test('a breakeven trade ends a streak without starting one', () => {
  const s = streaks([trade(10), trade(10), trade(0), trade(10)]);
  assert.equal(s.longestWin, 2, 'the zero must not extend the run');
  assert.equal(s.current, 1);
});

test('no trades means no streaks rather than a wrong zero', () => {
  assert.deepEqual(streaks([]), { longestWin: 0, longestLoss: 0, current: 0 });
  assert.deepEqual(streaks(null), { longestWin: 0, longestLoss: 0, current: 0 });
});

/* ─── Breakdown ─────────────────────────────────────────────────────────── */

test('trades group by whatever field is asked for', () => {
  const rows = breakdown([
    trade(100, { entryTag: 'am' }),
    trade(-40, { entryTag: 'am' }),
    trade(-10, { entryTag: 'pm' }),
  ], 'entryTag');

  assert.equal(rows.length, 2);
  // Sorted by net PnL, best first.
  assert.equal(rows[0].name, 'am');
  assert.equal(rows[0].trades, 2);
  assert.equal(rows[0].netPnl, 60);
  assert.equal(rows[0].winRate, 0.5);
  assert.equal(rows[1].name, 'pm');
});

test('a group with no losers reports no profit factor rather than Infinity', () => {
  /* Matching the engine's summary: a number that cannot be sorted or averaged
   * is worse than an admitted absence. */
  const [row] = breakdown([trade(100), trade(50)], 'entryTag');
  assert.equal(row.profitFactor, null);
  assert.equal(row.winRate, 1);
});

test('a trade with nothing in the field lands in one bucket', () => {
  const rows = breakdown([trade(10, { entryTag: null }), trade(5, { entryTag: undefined })], 'entryTag');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'untagged');
  assert.equal(rows[0].trades, 2);
});

test('breakeven trades count as trades but as neither win nor loss', () => {
  const [row] = breakdown([trade(0), trade(0)], 'entryTag');
  assert.equal(row.trades, 2);
  assert.equal(row.wins, 0);
  assert.equal(row.losses, 0);
  assert.equal(row.winRate, 0);
});

/* ─── The whole run ─────────────────────────────────────────────────────── */

test('analysing a run answers every question the page asks', () => {
  const run = {
    initialBalance: 10_000,
    equityCurve: [{ time: 1, equity: 10_000 }, { time: 2, equity: 10_200 }],
    trades: [
      trade(200, { side: 'long', entryTag: 'am', exitTag: 'take-profit' }),
      trade(-80, { side: 'short', entryTag: 'pm', exitTag: 'stop-loss' }),
    ],
  };
  const a = analyseRun(run);

  assert.equal(a.equity[0].value, 0, 'the curve starts at zero');
  assert.equal(a.equity[1].value, 200);
  assert.equal(a.byDirection.length, 2);
  assert.equal(a.byTag.length, 2);
  assert.equal(a.byExit.length, 2);
  assert.equal(a.streaks.longestWin, 1);
  assert.equal(a.avgHoldMs, 3_600_000);
});

test('an empty run analyses to empty rather than throwing', () => {
  const a = analyseRun({ initialBalance: 10_000, equityCurve: [], trades: [] });
  assert.deepEqual(a.equity, []);
  assert.deepEqual(a.byDirection, []);
  assert.equal(a.avgHoldMs, null, 'no trades means no average, not zero');
});

test('analysing nothing at all does not throw', () => {
  assert.doesNotThrow(() => analyseRun(null));
  assert.doesNotThrow(() => analyseRun({}));
});
