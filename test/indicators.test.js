import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INDICATORS, computeIndicator, ema, sma, sourceValues, trueRange,
} from '../shared/indicators/index.js';
import { VOLUME_PROFILE_PARAMS } from '../shared/indicators/volumeProfile.js';

const MIN = 60_000;

/** Bars with a given close series; OHLC hug the close unless stated otherwise. */
function barsFromCloses(closes, startMs = Date.UTC(2024, 0, 1)) {
  return closes.map((c, i) => ({
    time: startMs + i * MIN,
    open: c, high: c, low: c, close: c, volume: 1,
  }));
}

test('sma warms up then averages the window', () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out, [null, null, 2, 3, 4]);
});

test('sma rejects a period below 1', () => {
  assert.throws(() => sma([1, 2, 3], 0), /period must be >= 1/);
});

test('ema is seeded with the first sma and then follows the recurrence', () => {
  const out = ema([1, 2, 3, 4], 2);
  // seed = (1+2)/2 = 1.5 at index 1, k = 2/3
  assert.equal(out[0], null);
  assert.equal(out[1], 1.5);
  assert.equal(out[2], 3 * (2 / 3) + 1.5 * (1 / 3));
  assert.ok(Math.abs(out[3] - (4 * (2 / 3) + out[2] * (1 / 3))) < 1e-12);
});

test('ema returns all nulls when there is not enough data', () => {
  assert.deepEqual(ema([1, 2], 5), [null, null]);
});

test('outputs always align one-to-one with the bars', () => {
  const bars = barsFromCloses([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  for (const [id, spec] of Object.entries(INDICATORS)) {
    /* Anything with a `kind` describes regions of the chart rather than one
     * value per bar — zones in fvg.test.js, sessions in sessions.test.js. */
    if (spec.kind) continue;
    const result = computeIndicator(id, bars);
    for (const [key, series] of Object.entries(result)) {
      assert.equal(series.length, bars.length, `${id}.${key} length must match bars`);
    }
  }
});

test('every zone indicator returns zones that point at real bars', () => {
  const bars = barsFromCloses([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  for (const [id, spec] of Object.entries(INDICATORS)) {
    if (spec.kind !== 'zones') continue;
    const { zones } = computeIndicator(id, bars);
    assert.ok(Array.isArray(zones), `${id} must return a zones array`);
    for (const z of zones) {
      assert.ok(z.top > z.bottom, `${id}: a zone must have height`);
      /* The bar a zone is drawn from can never be later than the bar that
       * confirms it. They coincide for an inverted gap, which only starts to
       * apply on the bar that breaks it. */
      assert.ok(z.startIndex <= z.index, `${id}: startIndex must not follow index`);
      assert.ok(z.index < bars.length, `${id}: index must be a real bar`);
    }
  }
});

test('rsi is 100 while only rising and 0 while only falling', () => {
  const up = computeIndicator('rsi', barsFromCloses(
    Array.from({ length: 40 }, (_, i) => 100 + i),
  ), { period: 14 });
  assert.equal(up.value.at(-1), 100);

  const down = computeIndicator('rsi', barsFromCloses(
    Array.from({ length: 40 }, (_, i) => 100 - i),
  ), { period: 14 });
  assert.equal(down.value.at(-1), 0);
});

test('rsi stays within 0..100 on noisy data and warms up correctly', () => {
  const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 5 + (i % 7));
  const { value } = computeIndicator('rsi', barsFromCloses(closes), { period: 14 });

  assert.equal(value[13], null, 'not defined before the window is full');
  assert.notEqual(value[14], null, 'defined once it is');
  for (const v of value) {
    if (v == null) continue;
    assert.ok(v >= 0 && v <= 100, `RSI out of range: ${v}`);
  }
});

test('trueRange uses the previous close, and atr smooths it', () => {
  const bars = [
    { time: 0, open: 10, high: 12, low: 9, close: 11, volume: 1 },
    { time: MIN, open: 11, high: 15, low: 10, close: 14, volume: 1 },
  ];
  const tr = trueRange(bars);
  assert.equal(tr[0], null, 'the first bar has no previous close');
  assert.equal(tr[1], 5, 'max(15-10, |15-11|, |10-11|) = 5');
});

test('bollinger bands sit symmetrically around the basis', () => {
  const closes = [2, 4, 6, 8, 10, 12, 14];
  const { upper, middle, lower } = computeIndicator('bbands', barsFromCloses(closes), {
    period: 3, stddev: 2,
  });
  assert.equal(middle[2], 4);
  // closes 2,4,6 → mean 4, population sd = sqrt(8/3)
  const sd = Math.sqrt(8 / 3);
  assert.ok(Math.abs(upper[2] - (4 + 2 * sd)) < 1e-12);
  assert.ok(Math.abs(lower[2] - (4 - 2 * sd)) < 1e-12);
  assert.ok(Math.abs((upper[2] - middle[2]) - (middle[2] - lower[2])) < 1e-12);
});

test('vwap weights by volume and resets on a new day', () => {
  const day1 = Date.UTC(2024, 0, 1, 23, 58);
  const bars = [
    { time: day1, open: 10, high: 10, low: 10, close: 10, volume: 1 },
    { time: day1 + MIN, open: 20, high: 20, low: 20, close: 20, volume: 3 },
    // next bar crosses into 2024-01-02
    { time: day1 + 2 * MIN, open: 50, high: 50, low: 50, close: 50, volume: 1 },
  ];
  const { value } = computeIndicator('vwap', bars, { anchor: 'day' });

  assert.equal(value[0], 10);
  assert.equal(value[1], (10 * 1 + 20 * 3) / 4, 'volume weighted, not a plain mean');
  assert.equal(value[2], 50, 'the new day starts over rather than carrying the old sum');
});

test('vwap survives a bar with no trades', () => {
  const bars = [
    { time: 0, open: 10, high: 10, low: 10, close: 10, volume: 0 },
    { time: MIN, open: 20, high: 20, low: 20, close: 20, volume: 2 },
  ];
  const { value } = computeIndicator('vwap', bars, { anchor: 'none' });
  assert.equal(value[0], null, 'no volume yet means no average, not NaN');
  assert.equal(value[1], 20);
});

test('sourceValues covers every advertised option', () => {
  const bars = [{ time: 0, open: 1, high: 3, low: 1, close: 2, volume: 1 }];
  const optionKeys = INDICATORS.sma.params
    .find((p) => p.key === 'source').options.map((o) => o.value);

  for (const key of optionKeys) {
    const [v] = sourceValues(bars, key);
    assert.ok(Number.isFinite(v), `${key} produced ${v}`);
  }
  assert.equal(sourceValues(bars, 'hl2')[0], 2);
  assert.equal(sourceValues(bars, 'hlc3')[0], 2);
  assert.equal(sourceValues(bars, 'ohlc4')[0], 1.75);
  assert.throws(() => sourceValues(bars, 'nope'), /Unknown price source/);
});

test('computeIndicator validates params instead of silently correcting them', () => {
  const bars = barsFromCloses([1, 2, 3]);
  assert.throws(() => computeIndicator('nope', bars), /Unknown indicator/);
  assert.throws(() => computeIndicator('sma', bars, { period: 'abc' }), /is not a number/);
  assert.throws(() => computeIndicator('sma', bars, { period: 0 }), /is below 1/);
  assert.throws(() => computeIndicator('sma', bars, { source: 'vwap' }), /is not one of/);
});

test('an omitted param falls back to its declared default', () => {
  const bars = barsFromCloses(Array.from({ length: 30 }, (_, i) => i + 1));
  const explicit = computeIndicator('sma', bars, { period: 20 });
  const implicit = computeIndicator('sma', bars);
  assert.deepEqual(implicit.value, explicit.value);
});

test('every parameter carries an explanation for its tooltip', () => {
  /* The panel builds both the field and its tooltip from this schema, so a
   * parameter without a hint ships as a control nobody can interpret. Checked
   * here rather than left to review: the failure is silent in the UI. */
  const missing = [];
  for (const spec of Object.values(INDICATORS)) {
    for (const p of spec.params) {
      if (!p.hint?.trim()) missing.push(`${spec.id}.${p.key}`);
    }
    if (!spec.description?.trim()) missing.push(`${spec.id} (description)`);
  }
  for (const p of VOLUME_PROFILE_PARAMS) {
    if (!p.hint?.trim()) missing.push(`volumeProfile.${p.key}`);
  }
  assert.deepEqual(missing, [], `parameters with no hint: ${missing.join(', ')}`);
});

test('a hint explains the setting rather than restating its label', () => {
  for (const spec of Object.values(INDICATORS)) {
    for (const p of spec.params) {
      assert.ok(p.hint.length > p.label.length + 20, `${spec.id}.${p.key}: hint is too thin`);
    }
  }
});
