/* What a range is, and what it is not.
 *
 * Most of these are built from synthetic bars whose ATR is known exactly, so
 * the compression limit can be reasoned about rather than guessed at. The
 * timeframe test at the bottom is the one that needs real shape: it checks the
 * property the indicator exists for — that the same settings mean the same
 * thing on a fast chart and a slow one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RANGE_PARAMS, countTouches, detectRanges } from '../shared/indicators/range.js';
import { ZONE_PALETTE } from '../shared/indicators/fvg.js';
import { INDICATORS, computeIndicator } from '../shared/indicators/index.js';

/** Bars from [open, high, low, close] tuples; time is just the index. */
function bars(rows) {
  return rows.map(([open, high, low, close], i) => ({
    time: i, open, high, low, close, volume: 1,
  }));
}

/**
 * A run of bars oscillating between `low` and `high`.
 *
 * Alternating so both edges are visited over and over — the touch count is
 * never what fails in a test that is about something else.
 */
function oscillate(count, low, high, from = 0) {
  const rows = [];
  const mid = (low + high) / 2;
  for (let i = from; i < from + count; i++) {
    rows.push(i % 2 === 0 ? [mid, high, mid, mid] : [mid, mid, low, mid]);
  }
  return rows;
}

/** A move of `step` per bar, wide enough to set an ATR before a range starts. */
function trend(count, start, step) {
  const rows = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    rows.push([price, price + step, price, price + step]);
    price += step;
  }
  return rows;
}

/* Thirty bars climbing by 10 sets ATR(14) to 10, then forty bars oscillating in
 * a 12-wide band. The band is 12 against a limit of 0.6 × 10 × √40 ≈ 38, so it
 * is comfortably a range; bar 70 closes far above it and breaks it. */
const CONSOLIDATION = [
  ...trend(30, 100, 10),
  ...oscillate(40, 394, 406),
  [400, 460, 400, 455],
];

/* ─── The pattern itself ────────────────────────────────────────────────── */

test('a compressed, two-sided stretch is a range', () => {
  const { ranges } = detectRanges(bars(CONSOLIDATION));
  assert.equal(ranges.length, 1);

  const r = ranges[0];
  assert.equal(r.top, 406);
  assert.equal(r.bottom, 394);
  assert.equal(r.middle, 400);
  assert.equal(r.height, 12);
  assert.equal(r.startIndex, 30, 'starts on the first bar of the band');
  assert.equal(r.endIndex, 69, 'ends on the last bar inside it');
  assert.equal(r.length, 40);
});

test('the bar that closes beyond an edge is the breakout', () => {
  const { ranges } = detectRanges(bars(CONSOLIDATION));
  const r = ranges[0];
  assert.equal(r.breakIndex, 70);
  assert.equal(r.breakDirection, 'up');
  assert.equal(r.breakClose, 455);
  assert.equal(r.breakTime, 70);
  assert.equal(r.active, false, 'a range that broke is not still running');
});

test('the mirror: a close below the low breaks it downward', () => {
  const { ranges } = detectRanges(bars([
    ...trend(30, 100, 10),
    ...oscillate(40, 394, 406),
    [400, 400, 340, 345],
  ]));
  assert.equal(ranges[0].breakDirection, 'down');
  assert.equal(ranges[0].breakClose, 345);
});

test('a wick past an edge widens the range instead of ending it', () => {
  /* Same band, but bar 50 spikes to 420 and closes back at 400. That is a raid
   * on the edge, not a breakout: the range survives and its top follows. */
  const rows = [...trend(30, 100, 10), ...oscillate(40, 394, 406)];
  rows[50] = [400, 420, 400, 400];
  const { ranges } = detectRanges(bars([...rows, [400, 460, 400, 455]]));

  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].top, 420, 'the top moved up to the wick');
  assert.equal(ranges[0].breakIndex, 70, 'and the range still ran to the same bar');
});

test('a range still running at the last bar is active', () => {
  const { ranges } = detectRanges(bars([...trend(30, 100, 10), ...oscillate(40, 394, 406)]));
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].breakIndex, null);
  assert.equal(ranges[0].active, true);
});

/* ─── What is refused ───────────────────────────────────────────────────── */

test('a trend is not a range, however smooth', () => {
  const { ranges } = detectRanges(bars(trend(200, 100, 10)));
  assert.deepEqual(ranges, []);
});

test('a stretch too short to qualify is not reported', () => {
  // Fifteen bars of band, against a minimum of twenty.
  const { ranges } = detectRanges(bars([
    ...trend(30, 100, 10), ...oscillate(15, 394, 406), ...trend(30, 400, 10),
  ]));
  assert.deepEqual(ranges, []);
});

test('a narrow diagonal drift is refused for want of touches', () => {
  /* Compressed enough — it creeps by 0.4 a bar — but price visits each edge
   * exactly once, at the two ends. Without the touch rule this would pass, and
   * it is the single most common false positive. */
  const rows = [...trend(30, 100, 10)];
  let price = 400;
  for (let i = 0; i < 40; i++) {
    rows.push([price, price + 0.4, price, price + 0.4]);
    price += 0.4;
  }
  const drift = bars(rows);

  assert.deepEqual(detectRanges(drift).ranges, [], 'two touches per side must refuse it');
  assert.equal(detectRanges(drift, { minTouches: 1 }).ranges.length, 1,
    'and one touch per side must not — that setting is no filter at all');
});

test('an ordinary stretch is refused when compression is tightened', () => {
  const data = bars(CONSOLIDATION);
  assert.equal(detectRanges(data, { compression: 0.6 }).ranges.length, 1);
  // The band is 12 wide against 0.02 × 10 × √20 ≈ 0.9 — nothing survives that.
  assert.deepEqual(detectRanges(data, { compression: 0.02 }).ranges, []);
});

test('maxBars cuts a range off before it can cover the chart', () => {
  const long = bars([...trend(30, 100, 10), ...oscillate(200, 394, 406)]);
  assert.equal(detectRanges(long).ranges[0].length, 200);
  assert.equal(detectRanges(long, { maxBars: 50 }).ranges[0].length, 50);
});

/* ─── Look-ahead ────────────────────────────────────────────────────────── */

test('nothing is known before the bar that confirmed it', () => {
  const { ranges } = detectRanges(bars(CONSOLIDATION));
  const r = ranges[0];

  assert.ok(r.index >= r.startIndex + 19, 'confirmation cannot precede the minimum length');
  assert.ok(r.index <= r.endIndex, 'nor follow the range it confirms');
  assert.equal(r.time, r.index, 'time must be the confirming bar, not the first one');
});

test('the confirming edges are the ones that had been printed by then', () => {
  /* Bar 50 lifts the top from 406 to 420, well after confirmation. `top` has to
   * carry the final value and `confirmTop` the one a strategy could have read
   * — quoting the final edge at the confirming bar is exactly the look-ahead
   * this project is built to refuse. */
  const rows = [...trend(30, 100, 10), ...oscillate(40, 394, 406)];
  rows[50] = [400, 420, 400, 400];
  const r = detectRanges(bars([...rows, [400, 460, 400, 455]])).ranges[0];

  assert.equal(r.top, 420);
  assert.equal(r.confirmTop, 406, 'the top on the confirming bar, not the one from bar 50');
  assert.equal(r.confirmBottom, 394);
  assert.ok(r.index < 50, 'and the range was confirmed before that bar existed');
});

test('ranges never overlap and stay in order', () => {
  const { ranges } = detectRanges(bars([
    ...trend(30, 100, 10),
    ...oscillate(30, 394, 406),
    ...trend(30, 400, 10),
    ...oscillate(30, 694, 706),
    ...trend(10, 700, 10),
  ]));
  assert.equal(ranges.length, 2);
  assert.ok(ranges[0].endIndex < ranges[1].startIndex, 'the second starts after the first ended');
});

/* ─── Touches ───────────────────────────────────────────────────────────── */

test('a visit is counted once however long price stays at the edge', () => {
  // Five bars pinned to the top, then one away, then one back: two visits.
  const data = bars([
    [10, 10, 10, 10], [10, 10, 10, 10], [10, 10, 10, 10], [10, 10, 10, 10],
    [5, 5, 0, 5],
    [10, 10, 10, 10],
  ]);
  const visits = countTouches(data, 0, 5, 10, 0, 0.15);
  assert.equal(visits.top, 2, 'four bars at the top and one more later is two visits');
  assert.equal(visits.bottom, 1);
});

test('the edge zone is a share of the height, not a fixed distance', () => {
  // A bar reaching 9 is inside the top 15% of a 0..10 range, and outside 5%.
  const data = bars([[9, 9, 9, 9]]);
  assert.equal(countTouches(data, 0, 0, 10, 0, 0.15).top, 1);
  assert.equal(countTouches(data, 0, 0, 10, 0, 0.05).top, 0);
});

/* ─── Timeframe independence ────────────────────────────────────────────── */

test('the same settings find the same range whatever the bars measure', () => {
  /* The whole point of the indicator. Two markets with identical shape but
   * volatility an order of magnitude apart — a fast chart and a slow one — must
   * produce the same range under the same settings, which a threshold measured
   * in price or percent could not do.
   */
  const shape = (scale) => bars([
    ...trend(30, 100, 10 * scale),
    ...oscillate(40, 400 - 6 * scale, 400 + 6 * scale, 0),
    [400, 400 + 60 * scale, 400, 400 + 55 * scale],
  ]);

  const fast = detectRanges(shape(1)).ranges;
  const slow = detectRanges(shape(10)).ranges;

  assert.equal(fast.length, 1);
  assert.equal(slow.length, 1);
  for (const key of ['startIndex', 'index', 'endIndex', 'length', 'breakIndex', 'breakDirection']) {
    assert.equal(slow[0][key], fast[0][key], `${key} must not depend on the scale`);
  }
  // The heights differ by exactly the scale; the compression reading does not.
  assert.equal(slow[0].height, fast[0].height * 10);
  assert.ok(Math.abs(slow[0].compression - fast[0].compression) < 1e-9);
});

test('a range needs more room the longer it runs, not the same room', () => {
  /* √length, not length: doubling the bars raises the limit by about 1.41, so a
   * band that is fine over 20 bars can still be too wide over 80. Without the
   * square root a range could hold a constant width forever and quietly become
   * a trend channel. */
  const wide = bars([...trend(30, 100, 10), ...oscillate(80, 375, 425)]);
  const found = detectRanges(wide).ranges;

  // 50 wide against 0.6 × 10 × √20 ≈ 27 at twenty bars, and ≈ 54 at eighty.
  assert.equal(found.length, 1);
  assert.ok(found[0].length > 60, 'it only qualifies once it has run long enough');
  assert.ok(found[0].startIndex > 30, 'so it cannot start at the first bar of the band');
});

/* ─── Schema and registry ───────────────────────────────────────────────── */

test('the declared defaults are the ones the detector actually uses', () => {
  /* Two lists that have to agree: the schema the panel builds fields from, and
   * the destructuring defaults in detectRanges. A drift between them would show
   * as a chart that changes the moment a field is touched. */
  const declared = Object.fromEntries(RANGE_PARAMS.map((p) => [p.key, p.default]));
  const data = bars(CONSOLIDATION);

  assert.deepEqual(
    detectRanges(data, declared).ranges,
    detectRanges(data).ranges,
    'passing every declared default must change nothing',
  );
});

test('every colour parameter offers the shared zone palette', () => {
  for (const key of ['color', 'bullColor', 'bearColor']) {
    const p = RANGE_PARAMS.find((x) => x.key === key);
    assert.equal(p.type, 'color');
    assert.deepEqual(p.options, ZONE_PALETTE);
  }
});

test('the registry runs it and refuses a parameter out of range', () => {
  const spec = INDICATORS.ranges;
  assert.equal(spec.kind, 'ranges');

  const { ranges } = computeIndicator('ranges', bars(CONSOLIDATION));
  assert.equal(ranges.length, 1);

  assert.throws(
    () => computeIndicator('ranges', bars(CONSOLIDATION), { minTouches: 99 }),
    /minTouches/,
  );
});

test('bad arguments are refused rather than quietly corrected', () => {
  const data = bars(CONSOLIDATION);
  assert.throws(() => detectRanges(data, { minBars: 1 }), /minBars/);
  assert.throws(() => detectRanges(data, { maxBars: 5, minBars: 20 }), /maxBars/);
  assert.throws(() => detectRanges(data, { compression: 0 }), /compression/);
  assert.throws(() => detectRanges(data, { touchZone: 0 }), /touchZone/);
  assert.throws(() => detectRanges(data, { touchZone: 60 }), /touchZone/);
  assert.throws(() => detectRanges('nope'), /bars must be an array/);
});

test('no bars is an empty result, not a crash', () => {
  assert.deepEqual(detectRanges([]).ranges, []);
  assert.deepEqual(detectRanges([{ time: 0, open: 1, high: 1, low: 1, close: 1 }]).ranges, []);
});

test('lookback keeps only what was confirmed recently', () => {
  const data = bars([
    ...trend(30, 100, 10),
    ...oscillate(30, 394, 406),
    ...trend(30, 400, 10),
    ...oscillate(30, 694, 706),
    ...trend(10, 700, 10),
  ]);
  assert.equal(detectRanges(data).ranges.length, 2);
  // The first range confirms around bar 50; 60 bars back from 130 excludes it.
  assert.equal(detectRanges(data, { lookback: 60 }).ranges.length, 1);
});
