import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import {
  FVG_PARAMS, IFVG_PARAMS, ZONE_PALETTE, detectFairValueGaps, detectInvertedFairValueGaps,
} from '../shared/indicators/fvg.js';
import { INDICATORS, computeIndicator } from '../shared/indicators/index.js';

/** Bars from [open, high, low, close] tuples; time is just the index. */
function bars(rows) {
  return rows.map(([open, high, low, close], i) => ({
    time: i, open, high, low, close, volume: 1,
  }));
}

/* A bullish gap: bar 2 never trades down to where bar 0 traded up to.
 * high(0) = 10, low(2) = 12 — nothing changed hands between them. */
const BULL = [
  [9, 10, 9, 10],
  [10, 14, 10, 14],
  [12, 15, 12, 15],
];

/* The mirror image: high(2) = 12 sits below low(0) = 14. */
const BEAR = [
  [15, 15, 14, 14],
  [14, 14, 10, 10],
  [10, 12, 9, 9],
];

test('a bullish gap spans high(i-2) to low(i)', () => {
  const { zones } = detectFairValueGaps(bars(BULL));
  assert.equal(zones.length, 1);
  assert.equal(zones[0].direction, 'bull');
  assert.equal(zones[0].bottom, 10);
  assert.equal(zones[0].top, 12);
  assert.equal(zones[0].size, 2);
});

test('a bearish gap spans high(i) to low(i-2)', () => {
  const { zones } = detectFairValueGaps(bars(BEAR));
  assert.equal(zones.length, 1);
  assert.equal(zones[0].direction, 'bear');
  assert.equal(zones[0].bottom, 12);
  assert.equal(zones[0].top, 14);
});

test('overlapping neighbours leave no gap', () => {
  const { zones } = detectFairValueGaps(bars([
    [10, 12, 9, 11],
    [11, 13, 10, 12],
    [12, 14, 11, 13], // low 11 is inside bar 0's range
  ]));
  assert.deepEqual(zones, []);
});

test('fewer than three bars cannot form a gap', () => {
  assert.deepEqual(detectFairValueGaps(bars(BULL.slice(0, 2))).zones, []);
  assert.deepEqual(detectFairValueGaps([]).zones, []);
});

/* The whole point of keeping the two indices apart: a strategy handed the
 * slice [0..i] must not see a level that only bar i+1 will confirm. */
test('a zone is drawn from bar i-2 but only known at bar i', () => {
  const rows = bars(BULL);
  const [zone] = detectFairValueGaps(rows).zones;
  assert.equal(zone.startIndex, 0);
  assert.equal(zone.index, 2);
  assert.equal(zone.startTime, rows[0].time);
  assert.equal(zone.time, rows[2].time);

  // One bar earlier the gap does not exist yet.
  assert.deepEqual(detectFairValueGaps(rows.slice(0, 2)).zones, []);
});

test('the bar that creates a gap never fills it', () => {
  // Under 'touch' the near edge IS low(i), so bar i would mitigate itself if
  // mitigation were checked on the creating bar.
  const { zones } = detectFairValueGaps(bars(BULL), { mitigation: 'touch', show: 'all' });
  assert.equal(zones.length, 1);
  assert.equal(zones[0].mitigatedIndex, null);
});

test('touch fills at the near edge, ce at the midpoint, full at the far edge', () => {
  // Gap is [10, 12]; the fourth bar dips to exactly 11 — the midpoint.
  const toMid = bars([...BULL, [15, 15, 11, 14]]);
  assert.equal(detectFairValueGaps(toMid, { mitigation: 'touch', show: 'all' }).zones[0].mitigatedIndex, 3);
  assert.equal(detectFairValueGaps(toMid, { mitigation: 'ce', show: 'all' }).zones[0].mitigatedIndex, 3);
  assert.equal(detectFairValueGaps(toMid, { mitigation: 'full', show: 'all' }).zones[0].mitigatedIndex, null);

  // A dip to 12 only reaches the upper edge.
  const toEdge = bars([...BULL, [15, 15, 12, 14]]);
  assert.equal(detectFairValueGaps(toEdge, { mitigation: 'touch', show: 'all' }).zones[0].mitigatedIndex, 3);
  assert.equal(detectFairValueGaps(toEdge, { mitigation: 'ce', show: 'all' }).zones[0].mitigatedIndex, null);
});

test('a bearish gap is filled from below', () => {
  // Gap is [12, 14]; the fourth bar rallies to 14.
  const rows = bars([...BEAR, [9, 14, 9, 13]]);
  assert.equal(detectFairValueGaps(rows, { mitigation: 'full', show: 'all' }).zones[0].mitigatedIndex, 3);
  assert.equal(detectFairValueGaps(bars([...BEAR, [9, 13, 9, 13]]), {
    mitigation: 'full', show: 'all',
  }).zones[0].mitigatedIndex, null);
});

test('a filled gap is dropped by default and kept on request', () => {
  const rows = bars([...BULL, [15, 15, 9, 10]]); // crosses the gap entirely
  assert.deepEqual(detectFairValueGaps(rows).zones, []);

  const { zones } = detectFairValueGaps(rows, { show: 'all' });
  assert.equal(zones.length, 1);
  assert.equal(zones[0].mitigatedIndex, 3);
  assert.equal(zones[0].mitigatedTime, rows[3].time);
});

test('minSize measures the gap against its own price level', () => {
  // Gap [10, 12] around a midpoint of 11 — about 18.2%.
  assert.equal(detectFairValueGaps(bars(BULL), { minSize: 18 }).zones.length, 1);
  assert.equal(detectFairValueGaps(bars(BULL), { minSize: 19 }).zones.length, 0);
  // The default threshold keeps everything.
  assert.equal(detectFairValueGaps(bars(BULL), { minSize: 0 }).zones.length, 1);
});

test('an unknown mitigation rule is refused rather than guessed', () => {
  assert.throws(() => detectFairValueGaps(bars(BULL), { mitigation: 'half' }), /unknown mitigation/);
  assert.throws(() => detectFairValueGaps(null), /must be an array/);
});

test('the registry validates fvg params like any other indicator', () => {
  const { zones } = computeIndicator('fvg', bars(BULL));
  assert.equal(zones.length, 1);
  assert.throws(() => computeIndicator('fvg', bars(BULL), { mitigation: 'half' }), /not one of/);
  assert.throws(() => computeIndicator('fvg', bars(BULL), { minSize: -1 }), /below 0/);
});

test('gaps are reported in the order they formed', () => {
  // A steady staircase leaves one gap per bar from the third on.
  const rows = bars([
    ...BULL,
    [15, 19, 15, 19], // low 15 > high(1) = 14
    [17, 20, 17, 20], // low 17 > high(2) = 15
  ]);
  const { zones } = detectFairValueGaps(rows);
  assert.deepEqual(zones.map((z) => z.index), [2, 3, 4]);
  assert.deepEqual(zones.map((z) => z.startIndex), [0, 1, 2]);
});

/* ─── Narrowing what is reported ─────────────────────────────────────────── */

test('lookback keeps only the gaps confirmed in the last N bars', () => {
  // Gaps confirmed at bars 2, 3 and 4 of a five-bar staircase.
  const rows = bars([...BULL, [15, 19, 15, 19], [17, 20, 17, 20]]);
  assert.deepEqual(detectFairValueGaps(rows).zones.map((z) => z.index), [2, 3, 4]);

  // "the last 2 bars" = indices 3 and 4.
  assert.deepEqual(
    detectFairValueGaps(rows, { lookback: 2 }).zones.map((z) => z.index),
    [3, 4],
  );
  assert.deepEqual(detectFairValueGaps(rows, { lookback: 1 }).zones.map((z) => z.index), [4]);
});

test('lookback 0 means no limit rather than nothing', () => {
  const rows = bars([...BULL, [15, 19, 15, 19], [17, 20, 17, 20]]);
  assert.equal(detectFairValueGaps(rows, { lookback: 0 }).zones.length, 3);
  // A window wider than the data is not an error either.
  assert.equal(detectFairValueGaps(rows, { lookback: 9999 }).zones.length, 3);
});

test('lookback and show stack rather than override each other', () => {
  const rows = bars([...BULL, [15, 15, 9, 10], [10, 14, 10, 14], [12, 15, 12, 15]]);
  const all = detectFairValueGaps(rows, { show: 'all' }).zones;
  assert.ok(all.some((z) => z.mitigatedIndex !== null), 'fixture needs a filled gap');

  const recent = detectFairValueGaps(rows, { show: 'all', lookback: 2 }).zones;
  assert.ok(recent.length < all.length);
  assert.ok(recent.every((z) => z.index >= rows.length - 2));
});

test('boxWidth is drawing-only and never changes what is detected', () => {
  const rows = bars(BULL);
  const plain = detectFairValueGaps(rows);
  // Validated by the registry, then ignored by the detector.
  assert.deepEqual(detectFairValueGaps(rows, { boxWidth: 4 }), plain);
  assert.deepEqual(computeIndicator('fvg', rows, { boxWidth: 4 }).zones, plain.zones);
  assert.throws(() => computeIndicator('fvg', rows, { boxWidth: 501 }), /above 500/);
  assert.throws(() => computeIndicator('fvg', rows, { lookback: -1 }), /below 0/);
});

/* ─── Inverted fair value gaps ───────────────────────────────────────────── */

/* BULL leaves a bullish gap at [10, 12], confirmed on bar 2. A close below 10
 * says the market did not respect it as support. */
const BREAKS_BULL = [...BULL, [12, 13, 9, 9.5]];

test('a gap price closes through flips direction', () => {
  const rows = bars(BREAKS_BULL);
  const { zones } = detectInvertedFairValueGaps(rows);
  assert.equal(zones.length, 1);

  const [z] = zones;
  assert.equal(z.direction, 'bear', 'a failed bullish gap reads as resistance');
  // The prices are the original gap's; only the reading of them changed.
  assert.equal(z.bottom, 10);
  assert.equal(z.top, 12);
  assert.equal(z.originIndex, 2);
});

test('an inverted zone is drawn from its gap but confirmed at the break', () => {
  const [z] = detectInvertedFairValueGaps(bars(BREAKS_BULL)).zones;
  /* The level sits where the gap was, so that is where it is drawn — a box
   * starting at the break would leave the prices it describes unmarked. What a
   * strategy may act on is still the break, and only the break. */
  assert.equal(z.startIndex, 0, 'drawn from the first bar of the original gap');
  assert.equal(z.startTime, 0);
  assert.equal(z.index, 3, 'confirmed by the bar that broke it');
  assert.equal(z.time, 3);
  assert.ok(z.startIndex < z.index);
});

test('the gap and its inversion are drawn from the same bar', () => {
  const rows = bars(BREAKS_BULL);
  const [gap] = detectFairValueGaps(rows, { show: 'all' }).zones;
  const [inverted] = detectInvertedFairValueGaps(rows, { show: 'all' }).zones;
  assert.equal(inverted.startIndex, gap.startIndex);
  assert.equal(inverted.startTime, gap.startTime);
});

test('a gap that holds is never inverted', () => {
  // Price dips to 10 — the edge — but closes back inside.
  const holds = bars([...BULL, [12, 13, 10, 12]]);
  assert.deepEqual(detectInvertedFairValueGaps(holds).zones, []);
});

test('a wick through a gap only inverts it under the wick rule', () => {
  // Low 9 pierces the gap, close 11 stays inside it.
  const probe = bars([...BULL, [12, 13, 9, 11]]);
  assert.equal(detectInvertedFairValueGaps(probe).zones.length, 0);
  assert.equal(detectInvertedFairValueGaps(probe, { inversion: 'close' }).zones.length, 0);
  assert.equal(detectInvertedFairValueGaps(probe, { inversion: 'wick' }).zones.length, 1);
});

test('a bearish gap inverts upward into support', () => {
  // BEAR leaves a bearish gap at [12, 14]; a close above 14 breaks it.
  const rows = bars([...BEAR, [9, 15, 9, 15]]);
  const [z] = detectInvertedFairValueGaps(rows).zones;
  assert.equal(z.direction, 'bull');
  assert.equal(z.bottom, 12);
  assert.equal(z.top, 14);
});

test('under the wick rules an inverted zone reads against its new direction', () => {
  // The flipped zone is bearish at [10, 12], so price coming back UP fills it.
  const rows = bars([...BREAKS_BULL, [9, 12, 9, 11]]);
  const full = detectInvertedFairValueGaps(rows, { mitigation: 'full', show: 'all' }).zones[0];
  assert.equal(full.mitigatedIndex, 4, 'a high of 12 crosses the whole zone');

  // A rally that only reaches the near edge does not fill it under 'full'.
  const grazes = bars([...BREAKS_BULL, [9, 10, 9, 9.8]]);
  assert.equal(
    detectInvertedFairValueGaps(grazes, { mitigation: 'full', show: 'all' }).zones[0].mitigatedIndex,
    null,
  );
  assert.equal(
    detectInvertedFairValueGaps(grazes, { mitigation: 'touch', show: 'all' }).zones[0].mitigatedIndex,
    4,
  );
});

test('the breaking bar never mitigates the zone it creates', () => {
  // Under 'touch' the near edge of the new bearish zone is 10, and the
  // breaking bar's own high is 13 — it would fill it instantly.
  const { zones } = detectInvertedFairValueGaps(bars(BREAKS_BULL), {
    mitigation: 'touch', show: 'all',
  });
  assert.equal(zones[0].mitigatedIndex, null);
});

test('inverted gaps take the same narrowing filters', () => {
  const rows = bars(BREAKS_BULL);
  assert.equal(detectInvertedFairValueGaps(rows, { lookback: 1 }).zones.length, 1);
  assert.equal(detectInvertedFairValueGaps(rows, { lookback: 1, minSize: 50 }).zones.length, 0);
  assert.throws(
    () => detectInvertedFairValueGaps(rows, { inversion: 'body' }),
    /unknown inversion/,
  );
  assert.throws(() => detectInvertedFairValueGaps(rows, { mitigation: 'half' }), /unknown mitigation/);
});

test('both detectors read the same gap definition', () => {
  // Every zone an inversion produces must come from a gap the FVG detector
  // also found — one definition, or the chart and the engine disagree.
  const rows = bars([...BULL, [12, 13, 9, 9.5], [10, 14, 10, 14], [12, 15, 12, 15]]);
  const gaps = detectFairValueGaps(rows, { show: 'all' }).zones;
  const inverted = detectInvertedFairValueGaps(rows, { show: 'all' }).zones;
  assert.ok(inverted.length > 0);
  for (const z of inverted) {
    const origin = gaps.find((g) => g.index === z.originIndex);
    assert.ok(origin, 'every inversion traces back to a detected gap');
    assert.equal(origin.top, z.top);
    assert.equal(origin.bottom, z.bottom);
    assert.notEqual(origin.direction, z.direction);
  }
});

/* ─── Colour parameters ──────────────────────────────────────────────────── */

test('every palette colour is a token that actually exists', () => {
  // A colour param is a CSS token name. One with no token behind it resolves
  // to an empty string and paints nothing, which reads as a rendering bug.
  const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
  for (const { value } of ZONE_PALETTE) {
    assert.ok(css.includes(`--${value}:`), `--${value} is not defined in tokens.css`);
  }
});

test('every zone indicator defaults to a colour from the palette', () => {
  const allowed = new Set(ZONE_PALETTE.map((c) => c.value));
  for (const [id, spec] of Object.entries(INDICATORS)) {
    if (spec.kind !== 'zones') continue;
    for (const key of ['bullColor', 'bearColor']) {
      const param = spec.params.find((p) => p.key === key);
      assert.ok(param, `${id} must offer ${key}`);
      assert.equal(param.type, 'color');
      assert.ok(allowed.has(param.default), `${id}.${key} defaults outside the palette`);
    }
  }
});

test('a colour outside the palette is refused, not painted', () => {
  assert.throws(() => computeIndicator('fvg', bars(BULL), { bullColor: 'hotpink' }), /not one of/);
  assert.throws(() => computeIndicator('ifvg', bars(BULL), { bearColor: '#ff0000' }), /not one of/);
});

test('colours are drawing-only and never change what is detected', () => {
  const rows = bars(BULL);
  const plain = detectFairValueGaps(rows).zones;
  assert.deepEqual(computeIndicator('fvg', rows, { bullColor: 'neg' }).zones, plain);
});

test('the function defaults and the panel defaults are the same rules', () => {
  /* A detector called straight from a strategy and the same detector called
   * through the registry must not disagree. They are declared in two places —
   * the destructuring defaults and the param schema — so they are checked
   * against each other rather than trusted to stay in step. */
  for (const [id, params] of [['fvg', FVG_PARAMS], ['ifvg', IFVG_PARAMS]]) {
    const rows = bars([...BREAKS_BULL, [9, 12, 9, 11], [11, 16, 11, 16], [16, 16, 8, 8.5]]);
    const direct = id === 'fvg'
      ? detectFairValueGaps(rows)
      : detectInvertedFairValueGaps(rows);
    const viaRegistry = computeIndicator(id, rows);
    assert.deepEqual(viaRegistry.zones, direct.zones, `${id} disagrees with its own schema`);

    // And spelled out, so a mismatch names the parameter.
    const schema = Object.fromEntries(params.map((p) => [p.key, p.default]));
    const withSchema = id === 'fvg'
      ? detectFairValueGaps(rows, schema)
      : detectInvertedFairValueGaps(rows, schema);
    assert.deepEqual(withSchema.zones, direct.zones, `${id}: schema defaults differ from code defaults`);
  }
});

test('an inversion survives a retest but not a close back through it', () => {
  // The flipped zone is bearish at [10, 12] from bar 3.
  // Wick clean through the zone (high 12.5 > top), close back inside it.
  const retest = bars([...BREAKS_BULL, [9, 12.5, 9, 10.5]]);
  assert.equal(
    detectInvertedFairValueGaps(retest, { show: 'all' }).zones[0].mitigatedIndex,
    null,
    'a retest into the zone is the reason it is drawn, not its end',
  );

  const throughIt = bars([...BREAKS_BULL, [9, 13, 9, 12.5]]); // closes above the zone
  assert.equal(
    detectInvertedFairValueGaps(throughIt, { show: 'all' }).zones[0].mitigatedIndex,
    4,
  );

  /* The same bar under the old rule: the wick crossed the zone, so 'full'
   * called it filled and dropped it. That one line of difference is what threw
   * away 690 of 718 inversions on a month of BTC 15m. */
  assert.equal(
    detectInvertedFairValueGaps(retest, { mitigation: 'full', show: 'all' }).zones[0].mitigatedIndex,
    4,
  );
});

test('an inversion that was broken again stays in the output', () => {
  /* Reported from the chart twice: a gap on 27 Aug 18:00 inverted overnight
   * and was broken again an hour later, and nothing was ever drawn for it.
   * A broken inversion is not gone, it is over — its box already stops at the
   * break, so dropping it as well deletes it from the only stretch of chart
   * where it applied. Hence show='all' for an inversion. */
  const rows = bars([...BREAKS_BULL, [9, 13, 9, 12.5]]);
  const zones = detectInvertedFairValueGaps(rows).zones;
  assert.equal(zones.length, 1);
  assert.equal(zones[0].mitigatedIndex, 4, 'kept even though it is finished');

  // Asking for open ones only still works, it is just not the default.
  assert.deepEqual(detectInvertedFairValueGaps(rows, { show: 'open' }).zones, []);

  // A plain gap keeps the opposite default: a filled gap is genuinely gone.
  assert.ok(detectFairValueGaps(rows).zones.every((z) => z.mitigatedIndex === null));
});

test('minSize reads as points when asked to', () => {
  // The gap is [10, 12]: two points tall, about 18.2% of the price it sits at.
  const rows = bars(BULL);
  const n = (params) => detectFairValueGaps(rows, params).zones.length;

  assert.equal(n({ minSize: 2, minSizeUnit: 'points' }), 1);
  assert.equal(n({ minSize: 2.5, minSizeUnit: 'points' }), 0);
  // The same number means something entirely different in the other unit.
  assert.equal(n({ minSize: 2, minSizeUnit: 'percent' }), 1);
  assert.equal(n({ minSize: 19, minSizeUnit: 'percent' }), 0);
  assert.equal(n({ minSize: 19, minSizeUnit: 'points' }), 0);

  // Zero is off in either unit.
  assert.equal(n({ minSize: 0, minSizeUnit: 'points' }), 1);
});

test('inverted gaps take the points filter too', () => {
  const rows = bars(BREAKS_BULL);
  const n = (params) => detectInvertedFairValueGaps(rows, params).zones.length;
  assert.equal(n({ minSize: 2, minSizeUnit: 'points' }), 1);
  assert.equal(n({ minSize: 2.5, minSizeUnit: 'points' }), 0);
});

test('an unknown size unit is refused rather than guessed', () => {
  assert.throws(
    () => detectFairValueGaps(bars(BULL), { minSizeUnit: 'pips' }),
    /unknown minSizeUnit/,
  );
  assert.throws(
    () => detectInvertedFairValueGaps(bars(BULL), { minSizeUnit: 'ticks' }),
    /unknown minSizeUnit/,
  );
  assert.throws(() => computeIndicator('fvg', bars(BULL), { minSizeUnit: 'pips' }), /not one of/);
});

/* ─── Stacked gaps ──────────────────────────────────────────────────────── */

/* Two bullish gaps left by one impulse: 100..109.5 confirmed on bar 2, and
 * 110..116 confirmed on bar 3. Half a point of traded price between them, and
 * their bar spans overlap — the case the setting exists for. */
const STACK = [
  [99, 100, 98, 99],
  [99, 110, 99, 109],
  [110, 115, 109.5, 114],
  [116, 118, 116, 117],
];

/* The same two price levels, but with two bars in between that left no gap of
 * their own: 100..109.5 confirmed on bar 2, 110..116 not until bar 6. */
const BROKEN_CHAIN = [
  [99, 100, 98, 99],
  [99, 110, 99, 109],
  [110, 115, 109.5, 114],
  [110, 111, 109.8, 110],
  [110, 110, 109.9, 110],
  [111, 120, 110, 119],
  [117, 125, 116, 124],
];

/* A bullish gap and a bearish one that overlap outright — nothing between them
 * at all, and still two different readings of the market. */
const OPPOSED = [
  [99, 100, 98, 99],
  [99, 110, 99, 109],
  [110, 115, 109.5, 114],
  [110, 112, 105, 106],
  [105, 109.4, 100, 101],
];

const zonesOf = (rows, params) => detectFairValueGaps(bars(rows), { show: 'all', ...params }).zones;

test('gaps stacked with a thin strip between them become one zone', () => {
  const apart = zonesOf(STACK, { mergeWick: 0 });
  assert.equal(apart.length, 2, 'off by default');
  assert.deepEqual(apart.map((z) => [z.bottom, z.top]), [[100, 109.5], [110, 116]]);

  const [merged, ...rest] = zonesOf(STACK, { mergeWick: 1, minSizeUnit: 'points' });
  assert.equal(rest.length, 0, 'the run is one zone');
  assert.equal(merged.direction, 'bull');
  assert.equal(merged.bottom, 100, 'spans the outer edges of the whole run');
  assert.equal(merged.top, 116);
  assert.equal(merged.size, 16);
});

test('a strip wider than the setting still separates two gaps', () => {
  // The strip is half a point, so it is inside 1 and outside 0.4.
  assert.equal(zonesOf(STACK, { mergeWick: 0.4, minSizeUnit: 'points' }).length, 2);
  // And 0.456% of the price it sits at, so the same two thresholds in percent.
  assert.equal(zonesOf(STACK, { mergeWick: 0.5 }).length, 1);
  assert.equal(zonesOf(STACK, { mergeWick: 0.4 }).length, 2);
});

test('a merged zone starts at the first gap and is confirmed at the last', () => {
  const [merged] = zonesOf(STACK, { mergeWick: 1, minSizeUnit: 'points' });
  assert.equal(merged.startIndex, 0, 'drawn from where the run begins');
  assert.equal(merged.startTime, 0);
  /* Confirmation cannot be inherited from the first gap: before bar 3 nothing
   * could know the run reached 116, and a strategy given index 2 would trade a
   * zone that had not finished forming. */
  assert.equal(merged.index, 3);
  assert.equal(merged.time, 3);
});

test('a run breaks where a bar leaves no gap, however close the prices are', () => {
  /* Same half-point strip as STACK, and this time it must not merge: the two
   * gaps come from different moves, with bars in between that traded. Joining
   * by price alone is what turns a month of chart into one box. */
  const zones = zonesOf(BROKEN_CHAIN, { mergeWick: 5, minSizeUnit: 'points' });
  assert.equal(zones.length, 2);
  assert.deepEqual(zones.map((z) => [z.bottom, z.top]), [[100, 109.5], [110, 116]]);
});

test('gaps of opposite direction never merge, overlap or not', () => {
  const zones = zonesOf(OPPOSED, { mergeWick: 100, minSizeUnit: 'points' });
  assert.equal(zones.length, 2);
  assert.deepEqual(zones.map((z) => z.direction), ['bull', 'bear']);
});

test('mitigation is judged on the merged zone, not on the gaps it came from', () => {
  /* Price comes back to 110, which crosses the upper gap end to end but is
   * nowhere near the bottom of the run. A zone that is one thing has to be
   * filled as one thing. */
  const rows = [...STACK, [117, 118, 110, 112]];
  const [merged] = zonesOf(rows, { mergeWick: 1, minSizeUnit: 'points' });
  assert.equal(merged.mitigatedIndex, null, 'the run is not filled by a dip into its top');

  const [lower, upper] = zonesOf(rows, { mergeWick: 0 });
  assert.equal(upper.mitigatedIndex, 4, 'the upper gap alone would have been');
  assert.equal(lower.mitigatedIndex, null);
});

test('the size filter runs after the merge, not before it', () => {
  // 9.5 and 6 points on their own, 16 together. A run that adds up to a
  // tradable zone must not be discarded one sliver at a time.
  assert.equal(zonesOf(STACK, { minSize: 12, minSizeUnit: 'points' }).length, 0);
  assert.equal(
    zonesOf(STACK, { minSize: 12, minSizeUnit: 'points', mergeWick: 1 }).length, 1,
  );
});

test('an inverted gap merges the gaps it is built from', () => {
  // A close at 105 is past the upper gap's floor of 110, but nowhere near the
  // run's own floor of 100.
  const rows = [...STACK, [116, 117, 104, 105]];
  assert.equal(
    detectInvertedFairValueGaps(bars(rows)).zones.length, 1,
    'the upper gap alone inverts',
  );
  assert.equal(
    detectInvertedFairValueGaps(bars(rows), { mergeWick: 1, minSizeUnit: 'points' }).zones.length,
    0,
    'the run is not broken until price closes past its outer edge',
  );
});

test('the merge setting reaches both indicators through the schema', () => {
  // computeIndicator validates against the schema, so a parameter missing from
  // it would throw here rather than being silently ignored.
  for (const id of ['fvg', 'ifvg']) {
    const loose = computeIndicator(id, bars(STACK), { mergeWick: 0 });
    const tight = computeIndicator(id, bars(STACK), { mergeWick: 5 });
    assert.ok(loose.zones.length >= tight.zones.length, `${id} takes mergeWick`);
  }
  assert.equal(FVG_PARAMS.find((p) => p.key === 'mergeWick').default, 0);
  assert.equal(IFVG_PARAMS.find((p) => p.key === 'mergeWick').default, 0);
});
