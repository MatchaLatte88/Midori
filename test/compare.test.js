/* Comparing runs.
 *
 * The property worth guarding is the one the old drawing got wrong: the axis
 * is time, so a run with three points and a run with three hundred over the
 * same months line up by *when* each point happened and not by how far along
 * its own list it is. Everything else here follows from that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPARE_METRICS, comparability, compareCurves, curveOf, metricTable, settingsDiff, valuesAt,
} from '../shared/analysis/compare.js';

const DAY = 86_400_000;

/** A stored run, with only what the comparison actually reads. */
function run(over = {}) {
  return {
    id: 'r1',
    strategy: 'silverbullet',
    strategyName: 'Silver Bullet',
    symbol: 'BTCUSDT',
    timeframe: '5m',
    from: 0,
    to: 10 * DAY,
    initialBalance: 10_000,
    resolution: 'intrabar',
    costs: { feeRate: 0.001, spreadPct: 0.0002, slippagePct: 0.0002 },
    params: {},
    trades: [],
    equityCurve: [
      { time: 0, equity: 10_000, balance: 10_000, drawdown: 0 },
      { time: 10 * DAY, equity: 11_000, balance: 11_000, drawdown: 0 },
    ],
    stats: {
      netPnl: 1000, returnPct: 0.1, winRate: 0.5, tradeCount: 10,
      maxDrawdownPct: 0.05, profitFactor: 1.8, expectancy: 100, feesPaid: 40,
    },
    ...over,
  };
}

/* ─── Curves ────────────────────────────────────────────────────────────── */

test('a curve is measured in percent of its own starting balance', () => {
  const points = curveOf(run(), 'equity');
  assert.deepEqual(points, [{ x: 0, value: 0 }, { x: 10 * DAY, value: 10 }]);
});

test('the same result on a bigger account draws the same curve', () => {
  const small = curveOf(run({ initialBalance: 10_000 }), 'equity');
  const large = curveOf(run({
    initialBalance: 100_000,
    equityCurve: [
      { time: 0, equity: 100_000, drawdown: 0 },
      { time: 10 * DAY, equity: 110_000, drawdown: 0 },
    ],
  }), 'equity');

  assert.deepEqual(small, large);
});

test('drawdown is read against the peak the engine measured it from', () => {
  /* The stored point carries the absolute drawdown from the full curve, so the
   * high-water mark is equity + drawdown. Re-deriving the peak from the
   * condensed points would find 10,500 and understate every figure. */
  const points = curveOf(run({
    equityCurve: [
      { time: 0, equity: 10_000, drawdown: 0 },
      { time: DAY, equity: 10_500, drawdown: 1500 },  // peak was 12,000
    ],
  }), 'drawdown');

  assert.equal(points[0].value, 0);
  assert.equal(points[1].value.toFixed(2), (-(1500 / 12_000) * 100).toFixed(2));
});

test('drawdown never reads as a gain', () => {
  const points = curveOf(run(), 'drawdown');
  for (const p of points) assert.ok(p.value <= 0, `${p.value} points upwards`);
});

test('an unknown measure is refused rather than silently drawn as equity', () => {
  assert.throws(() => curveOf(run(), 'sharpe'), /unknown measure/);
});

test('two runs with different point counts still line up by time', () => {
  /* The bug this whole file exists for: a condensed curve has one point per
   * balance change, so a nine-trade run and a four-hundred-trade run over the
   * same months have wildly different lengths. Drawn by list position, the
   * ninth trade of one would sit above the three hundredth of the other. */
  const sparse = run({
    id: 'sparse',
    equityCurve: [
      { time: 0, equity: 10_000, drawdown: 0 },
      { time: 10 * DAY, equity: 11_000, drawdown: 0 },
    ],
  });
  const dense = run({
    id: 'dense',
    equityCurve: Array.from({ length: 11 }, (_, i) => (
      { time: i * DAY, equity: 10_000 + i * 50, drawdown: 0 }
    )),
  });

  const compared = compareCurves([sparse, dense]);

  assert.equal(compared.minX, 0);
  assert.equal(compared.maxX, 10 * DAY, 'the axis spans the calendar, not the longer list');
  // Both runs' last point is at the same x despite 2 points against 11.
  for (const s of compared.series) {
    assert.equal(s.points[s.points.length - 1].x, 10 * DAY);
  }
});

test('aligning starts puts runs from different years on top of each other', () => {
  const first = run({ id: 'a' });
  const later = run({
    id: 'b',
    equityCurve: [
      { time: 400 * DAY, equity: 10_000, drawdown: 0 },
      { time: 410 * DAY, equity: 10_500, drawdown: 0 },
    ],
  });

  const calendar = compareCurves([first, later], { mode: 'calendar' });
  assert.equal(calendar.maxX, 410 * DAY, 'a calendar axis spans both, gap and all');

  const aligned = compareCurves([first, later], { mode: 'aligned' });
  assert.equal(aligned.maxX, 10 * DAY, 'aligned, both are ten days long');
  for (const s of aligned.series) assert.equal(s.points[0].x, 0);
});

test('zero stays inside the value range whatever the runs did', () => {
  const losing = run({
    equityCurve: [
      { time: 0, equity: 10_000, drawdown: 0 },
      { time: DAY, equity: 9_000, drawdown: 1000 },
    ],
  });
  const compared = compareCurves([losing]);
  assert.ok(compared.maxY >= 0, 'breakeven must stay visible above a losing run');
  assert.ok(compared.minY <= -10);
});

test('a flat run gets a band rather than a division by zero', () => {
  const flat = run({
    equityCurve: [{ time: 0, equity: 10_000, drawdown: 0 }, { time: DAY, equity: 10_000, drawdown: 0 }],
  });
  const compared = compareCurves([flat]);
  assert.ok(compared.maxY > compared.minY);
  assert.ok(compared.maxX > compared.minX);
});

test('nothing to compare is an empty frame, not a crash', () => {
  const compared = compareCurves([]);
  assert.deepEqual(compared.series, []);
  assert.ok(compared.maxX > compared.minX);
});

test('an unknown axis mode is refused', () => {
  assert.throws(() => compareCurves([run()], { mode: 'logarithmic' }), /unknown mode/);
});

/* ─── Readout ───────────────────────────────────────────────────────────── */

test('a readout carries the last value forward instead of interpolating', () => {
  /* Between two trades the account sat at the last balance. A line drawn
   * between the points is a drawing convenience; the number under the pointer
   * has to be what the account actually held. */
  const compared = compareCurves([run({
    equityCurve: [
      { time: 0, equity: 10_000, drawdown: 0 },
      { time: 10 * DAY, equity: 11_000, drawdown: 0 },
    ],
  })]);

  assert.equal(valuesAt(compared, 5 * DAY)[0].value, 0);
  assert.equal(valuesAt(compared, 10 * DAY)[0].value, 10);
});

test('a run that had not started yet has no value rather than zero', () => {
  const later = run({
    equityCurve: [
      { time: 5 * DAY, equity: 10_000, drawdown: 0 },
      { time: 9 * DAY, equity: 10_400, drawdown: 0 },
    ],
  });
  assert.equal(valuesAt(compareCurves([later]), DAY)[0].value, null);
});

/* ─── Comparability ─────────────────────────────────────────────────────── */

test('one run alone has nothing to disagree with', () => {
  assert.deepEqual(comparability([run()]), []);
});

test('identical setups produce no warnings', () => {
  assert.deepEqual(comparability([run({ id: 'a' }), run({ id: 'b' })]), []);
});

test('a different market is reported, not refused', () => {
  const notes = comparability([run({ id: 'a' }), run({ id: 'b', symbol: 'ETHUSDT' })]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].key, 'symbol');
  assert.match(notes[0].message, /ETHUSDT/);
});

test('runs over separate periods are flagged for the calendar axis', () => {
  const notes = comparability([
    run({ id: 'a', from: 0, to: 10 * DAY }),
    run({ id: 'b', from: 100 * DAY, to: 110 * DAY }),
  ]);
  assert.ok(notes.some((n) => n.key === 'period'));
});

test('overlapping periods are not flagged', () => {
  const notes = comparability([
    run({ id: 'a', from: 0, to: 10 * DAY }),
    run({ id: 'b', from: 5 * DAY, to: 15 * DAY }),
  ]);
  assert.ok(!notes.some((n) => n.key === 'period'));
});

test('different fills are flagged, because they decide the close calls', () => {
  const notes = comparability([
    run({ id: 'a', resolution: 'intrabar' }),
    run({ id: 'b', resolution: 'pessimistic' }),
  ]);
  assert.ok(notes.some((n) => n.key === 'resolution'));
});

test('different costs are flagged', () => {
  const notes = comparability([
    run({ id: 'a' }),
    run({ id: 'b', costs: { feeRate: 0.0004, spreadPct: 0.0002, slippagePct: 0.0002 } }),
  ]);
  assert.ok(notes.some((n) => n.key === 'costs'));
});

/* ─── Settings ──────────────────────────────────────────────────────────── */

const CATALOG = [{
  id: 'silverbullet',
  params: [
    { key: 'riskValue', label: 'Risk', type: 'number' },
    { key: 'rrr', label: 'Reward : risk', type: 'number' },
    {
      key: 'riskMode',
      label: 'Risk per trade',
      type: 'select',
      options: [{ value: 'percent', label: 'Percent of equity' }],
    },
  ],
}];

test('the settings diff marks only what actually differs', () => {
  const rows = settingsDiff([
    run({ id: 'a', params: { riskValue: 1, rrr: 2 } }),
    run({ id: 'b', params: { riskValue: 1, rrr: 3 } }),
  ], CATALOG);

  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(byKey.riskValue.differs, false);
  assert.equal(byKey.rrr.differs, true);
  assert.deepEqual(byKey.rrr.cells.map((c) => c.text), ['2', '3']);
});

test('a setting reads through its schema, not as its wire value', () => {
  const rows = settingsDiff([run({ params: { riskMode: 'percent' } })], CATALOG);
  assert.equal(rows.find((r) => r.key === 'riskMode').cells[0].text, 'Percent of equity');
});

test('rows follow the schema order the form uses', () => {
  const rows = settingsDiff([run({ params: { rrr: 2, riskValue: 1 } })], CATALOG);
  assert.deepEqual(rows.map((r) => r.key), ['riskValue', 'rrr', 'riskMode']);
});

test('a parameter only one run has counts as a difference', () => {
  const rows = settingsDiff([
    run({ id: 'a', params: { riskValue: 1 } }),
    run({ id: 'b', params: { riskValue: 1, minGapSize: 8 } }),
  ], CATALOG);

  const row = rows.find((r) => r.key === 'minGapSize');
  assert.equal(row.differs, true);
  assert.equal(row.cells[0].missing, true);
  assert.equal(row.cells[1].text, '8');
});

test('a run whose strategy is gone still shows its settings under raw keys', () => {
  const rows = settingsDiff([run({ strategy: 'retired', params: { oldKnob: 4 } })], CATALOG);
  assert.deepEqual(rows.map((r) => r.key), ['oldKnob']);
  assert.equal(rows[0].label, 'oldKnob');
});

/* ─── Figures ───────────────────────────────────────────────────────────── */

test('every figure knows which direction is better', () => {
  for (const m of COMPARE_METRICS) {
    assert.ok(['high', 'low', 'none'].includes(m.better), `${m.key}: ${m.better}`);
  }
});

test('the best cell of a row is the best one, not the biggest', () => {
  const rows = metricTable([
    run({ id: 'a', stats: { ...run().stats, maxDrawdownPct: 0.2, feesPaid: 500 } }),
    run({ id: 'b', stats: { ...run().stats, maxDrawdownPct: 0.05, feesPaid: 40 } }),
  ]);

  const dd = rows.find((r) => r.key === 'maxDrawdownPct');
  assert.deepEqual(dd.cells.map((c) => c.best), [false, true], 'the shallower drawdown wins');
  const fees = rows.find((r) => r.key === 'feesPaid');
  assert.deepEqual(fees.cells.map((c) => c.best), [false, true], 'the cheaper run wins');
});

test('a figure with no better direction crowns nobody', () => {
  const rows = metricTable([
    run({ id: 'a', stats: { ...run().stats, tradeCount: 5 } }),
    run({ id: 'b', stats: { ...run().stats, tradeCount: 500 } }),
  ]);
  const trades = rows.find((r) => r.key === 'tradeCount');
  assert.deepEqual(trades.cells.map((c) => c.best), [false, false]);
});

test('an absent figure never wins its row', () => {
  const rows = metricTable([
    run({ id: 'a', stats: { ...run().stats, winRate: null } }),
    run({ id: 'b', stats: { ...run().stats, winRate: 0.4 } }),
  ]);
  const win = rows.find((r) => r.key === 'winRate');
  assert.deepEqual(win.cells.map((c) => c.best), [false, true]);
});

test('a tie marks both cells, because the setting decided nothing', () => {
  const rows = metricTable([run({ id: 'a' }), run({ id: 'b' })]);
  const ret = rows.find((r) => r.key === 'returnPct');
  assert.deepEqual(ret.cells.map((c) => c.best), [true, true]);
});

test('return over drawdown is absent rather than infinite without a drawdown', () => {
  const rows = metricTable([run({ stats: { ...run().stats, maxDrawdownPct: 0 } })]);
  assert.equal(rows.find((r) => r.key === 'returnOverDd').cells[0].value, null);
});

test('a single run still produces a full table', () => {
  const rows = metricTable([run()]);
  assert.equal(rows.length, COMPARE_METRICS.length);
  for (const row of rows) assert.equal(row.cells.length, 1);
});

test('nothing to tabulate is an empty table', () => {
  assert.deepEqual(metricTable([]), []);
});
