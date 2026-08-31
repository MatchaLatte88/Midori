import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RANK_METRICS, bestAndWorst, countCombinations, expandRange, expandSweep, rankResults,
  splitRange,
} from '../shared/analysis/sweep.js';

/* ─── Expanding one range ───────────────────────────────────────────────── */

test('a whole-number range includes both ends', () => {
  assert.deepEqual(expandRange({ from: 4, to: 8, step: 1 }), [4, 5, 6, 7, 8]);
  assert.deepEqual(expandRange({ from: 2, to: 6, step: 2 }), [2, 4, 6]);
});

test('a fractional range lands on exact values, not floating-point dust', () => {
  /* Walked by repeated addition this produces 1.9000000000000001, which then
   * gets stored as a parameter — two sweeps that should be identical are not,
   * and the stored result reads as noise. */
  const values = expandRange({ from: 1.2, to: 3, step: 0.1 });

  assert.equal(values.length, 19);
  assert.equal(values[0], 1.2);
  assert.equal(values[values.length - 1], 3);
  for (const v of values) {
    assert.equal(v, Number(v.toFixed(1)), `${v} carries floating-point dust`);
  }
  // The specific value that goes wrong under naive addition.
  assert.ok(values.includes(1.9), '1.9 came out as something else');
  assert.ok(values.includes(2), '2 came out as something else');
});

test('a step that overshoots the end simply stops', () => {
  assert.deepEqual(expandRange({ from: 4, to: 20, step: 7 }), [4, 11, 18]);
});

test('a range with equal ends is one value, not none', () => {
  // "Sweep this from 5 to 5" plainly means "use 5".
  assert.deepEqual(expandRange({ from: 5, to: 5, step: 1 }), [5]);
});

test('a range that makes no sense is refused rather than guessed at', () => {
  assert.throws(() => expandRange({ from: 10, to: 2, step: 1 }), /before from/);
  assert.throws(() => expandRange({ from: 1, to: 5, step: 0 }), /positive number/);
  assert.throws(() => expandRange({ from: 1, to: 5, step: -1 }), /positive number/);
  assert.throws(() => expandRange({ from: NaN, to: 5, step: 1 }), /must be numbers/);
});

/* ─── Counting before committing ────────────────────────────────────────── */

test('the count is known without building the combinations', () => {
  const ranges = {
    minGapSize: { from: 4, to: 20, step: 1 },   // 17
    rrr: { from: 1.2, to: 3, step: 0.1 },       // 19
  };
  assert.equal(countCombinations(ranges), 17 * 19);
  assert.equal(countCombinations({}), 0);
});

test('the count matches what is actually produced', () => {
  const ranges = {
    a: { from: 1, to: 3, step: 1 },
    b: { from: 0.5, to: 2, step: 0.5 },
  };
  assert.equal(expandSweep(ranges).length, countCombinations(ranges));
});

/* ─── Expanding a sweep ─────────────────────────────────────────────────── */

test('every combination of every range appears exactly once', () => {
  const combos = expandSweep({
    a: { from: 1, to: 2, step: 1 },
    b: { from: 10, to: 30, step: 10 },
  });

  assert.equal(combos.length, 6);
  const seen = combos.map((c) => `${c.a}:${c.b}`).sort();
  assert.deepEqual(seen, ['1:10', '1:20', '1:30', '2:10', '2:20', '2:30']);
});

test('the last parameter varies fastest, so a result list reads as a table', () => {
  const combos = expandSweep({
    a: { from: 1, to: 2, step: 1 },
    b: { from: 10, to: 20, step: 10 },
  });
  assert.deepEqual(combos.map((c) => `${c.a}:${c.b}`), ['1:10', '1:20', '2:10', '2:20']);
});

test('fixed values ride along on every combination', () => {
  const combos = expandSweep(
    { rrr: { from: 1, to: 2, step: 1 } },
    { riskValue: 1, riskMode: 'percent' },
  );

  assert.equal(combos.length, 2);
  for (const c of combos) {
    assert.equal(c.riskValue, 1);
    assert.equal(c.riskMode, 'percent');
  }
  assert.deepEqual(combos.map((c) => c.rrr), [1, 2]);
});

test('a swept parameter overrides the fixed one of the same name', () => {
  const combos = expandSweep({ rrr: { from: 3, to: 3, step: 1 } }, { rrr: 99 });
  assert.equal(combos[0].rrr, 3);
});

test('no ranges is no sweep rather than one empty run', () => {
  assert.deepEqual(expandSweep({}), []);
});

test('a sweep too large to be meant is refused with its own size', () => {
  /* Three settings with twenty values each is eight thousand runs — hours of
   * work nobody guesses from looking at three input fields. */
  const huge = {
    a: { from: 1, to: 100, step: 1 },
    b: { from: 1, to: 100, step: 1 },
    c: { from: 1, to: 100, step: 1 },
  };
  assert.throws(() => expandSweep(huge), /1,000,000 combinations/);
  // The limit is the caller's to set.
  assert.equal(expandSweep({ a: { from: 1, to: 4, step: 1 } }, {}, 4).length, 4);
  assert.throws(() => expandSweep({ a: { from: 1, to: 5, step: 1 } }, {}, 4), /over the limit/);
});

/* ─── Ranking ───────────────────────────────────────────────────────────── */

const result = (params, stats) => ({ params, stats: { tradeCount: 50, ...stats } });

test('results sort best-first by the chosen metric', () => {
  const results = [
    result({ id: 'a' }, { expectancy: 5, netPnl: 500, profitFactor: 1.2 }),
    result({ id: 'b' }, { expectancy: 20, netPnl: 200, profitFactor: 2.4 }),
    result({ id: 'c' }, { expectancy: 12, netPnl: 900, profitFactor: 1.8 }),
  ];

  assert.deepEqual(
    rankResults(results, 'expectancy').ranked.map((r) => r.params.id), ['b', 'c', 'a'],
  );
  assert.deepEqual(
    rankResults(results, 'netPnl').ranked.map((r) => r.params.id), ['c', 'a', 'b'],
  );
  assert.deepEqual(
    rankResults(results, 'profitFactor').ranked.map((r) => r.params.id), ['b', 'c', 'a'],
  );
});

test('a combination with too few trades is set aside, not ranked badly', () => {
  /* Four trades can top any measure by luck. Reporting that as the best would
   * be the sweep lying about what it found. */
  const results = [
    result({ id: 'lucky' }, { tradeCount: 3, expectancy: 500 }),
    result({ id: 'real' }, { tradeCount: 80, expectancy: 12 }),
  ];
  const { ranked, excluded } = rankResults(results, 'expectancy', 10);

  assert.deepEqual(ranked.map((r) => r.params.id), ['real']);
  assert.deepEqual(excluded.map((r) => r.params.id), ['lucky'], 'it must still be reportable');
});

test('a metric that has no value sorts last rather than first', () => {
  // A profit factor with no losses to divide by is an absence, not a high score.
  const results = [
    result({ id: 'none' }, { profitFactor: null }),
    result({ id: 'real' }, { profitFactor: 1.5 }),
  ];
  assert.deepEqual(
    rankResults(results, 'profitFactor').ranked.map((r) => r.params.id), ['real', 'none'],
  );
});

test('an unknown metric is refused rather than silently unsorted', () => {
  assert.throws(() => rankResults([], 'sharpe'), /unknown metric/);
});

test('ranking nothing is empty rather than a crash', () => {
  assert.deepEqual(rankResults([], 'expectancy'), { ranked: [], excluded: [] });
  assert.deepEqual(rankResults(null, 'expectancy').ranked, []);
});

test('every ranking metric can read a result', () => {
  const stats = { expectancy: 1, netPnl: 2, profitFactor: 3, tradeCount: 50 };
  for (const [id, spec] of Object.entries(RANK_METRICS)) {
    assert.equal(spec.id, id, 'the id and the key disagree');
    assert.ok(spec.label && spec.hint, `${id} has no label or hint`);
    assert.equal(typeof spec.read(stats), 'number', `${id} cannot read a result`);
  }
});

/* ─── Best and worst ────────────────────────────────────────────────────── */

test('both ends come back, worst-first from the bottom', () => {
  const ranked = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    .map((id, i) => result({ id }, { expectancy: 100 - i }));

  const { best, worst, overlapping } = bestAndWorst(ranked, 4);
  assert.deepEqual(best.map((r) => r.params.id), ['a', 'b', 'c', 'd']);
  // Worst-first: the very worst leads, which is what a comparison wants.
  assert.deepEqual(worst.map((r) => r.params.id), ['j', 'i', 'h', 'g']);
  assert.equal(overlapping, false);
});

test('too few results to have two distinct ends says so', () => {
  /* With five results, best-4 and worst-4 share three. Hiding that would
   * misrepresent how little was actually tested. */
  const ranked = ['a', 'b', 'c', 'd', 'e'].map((id) => result({ id }, { expectancy: 1 }));
  assert.equal(bestAndWorst(ranked, 4).overlapping, true);
  assert.equal(bestAndWorst(ranked.concat(ranked), 4).overlapping, false);
});

/* ─── Splitting the range ───────────────────────────────────────────────── */

test('the split leaves the later stretch for testing', () => {
  /* A rule tuned on recent data and checked against older data is checked
   * against a market that came first, which answers nothing. */
  const from = Date.UTC(2025, 0, 1);
  const to = Date.UTC(2026, 0, 1);
  const { train, test: holdout } = splitRange(from, to, 0.7);

  assert.equal(train.from, from);
  assert.equal(holdout.to, to);
  assert.equal(train.to, holdout.from, 'the two stretches must meet');
  assert.ok(train.to > from && train.to < to, 'the cut is inside the range');

  // Roughly seven tenths of the span, allowing for rounding to a millisecond.
  const share = (train.to - train.from) / (to - from);
  assert.ok(Math.abs(share - 0.7) < 1e-6, `train covers ${share}`);
});

test('the fraction moves the cut', () => {
  const from = 0;
  const to = 1000;
  assert.equal(splitRange(from, to, 0.5).train.to, 500);
  assert.equal(splitRange(from, to, 0.9).train.to, 900);
});

test('a split that would leave nothing on one side is refused', () => {
  assert.throws(() => splitRange(0, 1000, 0), /between 0 and 1/);
  assert.throws(() => splitRange(0, 1000, 1), /between 0 and 1/);
  assert.throws(() => splitRange(1000, 0, 0.7), /must end after it starts/);
});
