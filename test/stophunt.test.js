import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import {
  STOPHUNT_PARAMS, detectStopHunts, equalLevels, findSwings, sessionLevels,
} from '../shared/indicators/stophunt.js';
import { ZONE_PALETTE } from '../shared/indicators/fvg.js';
import { INDICATORS, computeIndicator } from '../shared/indicators/index.js';

/** Bars from [open, high, low, close] tuples; time is just the index. */
function bars(rows) {
  return rows.map(([open, high, low, close], i) => ({
    time: i, open, high, low, close, volume: 1,
  }));
}

/* A swing high of 15 at index 2 — two lower bars on each side, so it is a
 * fractal at strength 2 and known from index 4. Bar 5 wicks to 16 and closes
 * at 13.5, back under it. */
const HUNT_HIGH = [
  [10, 11, 9, 10],
  [10, 12, 10, 11],
  [11, 15, 11, 14],
  [14, 14, 13, 13],
  [13, 14, 12, 13],
  [13, 16, 13, 13.5],
];

/* The same six bars, except the last one closes at 15.8 and stays there. Same
 * wick, same level, and not a hunt — this is the break. */
const BREAK_HIGH = [
  ...HUNT_HIGH.slice(0, 5),
  [13, 16, 13, 15.8],
];

/* The mirror: a swing low of 9 at index 2, run to 8 and reclaimed. */
const HUNT_LOW = [
  [14, 15, 13, 14],
  [14, 14, 12, 13],
  [13, 13, 9, 10],
  [10, 11, 10, 11],
  [11, 12, 10, 11],
  [11, 12, 8, 11.5],
];

/* ─── The pattern itself ────────────────────────────────────────────────── */

test('a wick through a swing high and a close back under is a hunt', () => {
  const { hunts } = detectStopHunts(bars(HUNT_HIGH), { confirmBars: 1 });
  assert.equal(hunts.length, 1);

  const h = hunts[0];
  // Named for what the level does to price now, not for where the wick went.
  assert.equal(h.direction, 'bear');
  assert.equal(h.side, 'high');
  assert.equal(h.source, 'swing');
  assert.equal(h.level, 15);
  assert.equal(h.extreme, 16);
  assert.equal(h.depth, 1);
});

test('a wick through a swing low and a close back over is the mirror', () => {
  const { hunts } = detectStopHunts(bars(HUNT_LOW), { confirmBars: 1 });
  assert.equal(hunts.length, 1);
  assert.equal(hunts[0].direction, 'bull');
  assert.equal(hunts[0].side, 'low');
  assert.equal(hunts[0].level, 9);
  assert.equal(hunts[0].extreme, 8);
});

test('the same wick without the reclaim is a break, not a hunt', () => {
  assert.deepEqual(detectStopHunts(bars(BREAK_HIGH), { confirmBars: 1 }).hunts, []);
});

test('a level nothing reached is not a hunt', () => {
  // Bar 5 rises but never trades above 15.
  const rows = bars([...HUNT_HIGH.slice(0, 5), [13, 14.9, 13, 14.5]]);
  assert.deepEqual(detectStopHunts(rows, { confirmBars: 1 }).hunts, []);
});

test('touching the level exactly is not trading through it', () => {
  // high === level. The stops sit beyond it, and nothing went beyond.
  const rows = bars([...HUNT_HIGH.slice(0, 5), [13, 15, 13, 13.5]]);
  assert.deepEqual(detectStopHunts(rows, { confirmBars: 1 }).hunts, []);
});

/* ─── Look-ahead ────────────────────────────────────────────────────────── */

test('a swing is only known once its right-hand bars have closed', () => {
  const swings = findSwings(bars(HUNT_HIGH), 2);
  assert.equal(swings.length, 1);
  // Drawn from the bar it sits on...
  assert.equal(swings[0].formedIndex, 2);
  // ...but not knowable until strength bars later, which is the whole point.
  assert.equal(swings[0].knownIndex, 4);
});

test('a level cannot be swept before it is known', () => {
  /* The high at index 2 is 15. Index 3 trades to 15.5 — through the level, and
   * back under it — but at index 3 no one could know index 2 was a swing yet:
   * bar 4 has not closed. Strength 2 means the level is knowable at index 4. */
  const rows = bars([
    [10, 11, 9, 10],
    [10, 12, 10, 11],
    [11, 15, 11, 14],
    [14, 15.5, 13, 13.5],
    [13, 14, 12, 13],
    [13, 14, 12, 13],
  ]);
  assert.deepEqual(detectStopHunts(rows, { strength: 2, confirmBars: 1 }).hunts, []);
});

test('the confirming index is never earlier than the sweep', () => {
  const rows = bars(HUNT_HIGH);
  for (const confirmBars of [1, 2, 5, 20]) {
    for (const h of detectStopHunts(rows, { confirmBars }).hunts) {
      assert.ok(h.index >= h.sweepIndex, 'confirmed before the sweep');
      assert.ok(h.sweepIndex > h.levelIndex, 'swept by the bar that formed it');
    }
  }
});

test('a bar cannot sweep the level it formed', () => {
  /* Index 2 is both the swing high and, at strength 1, knowable at index 3.
   * Its own high is the level; without the guard it breaches on sight. */
  const rows = bars([
    [10, 11, 9, 10],
    [11, 15, 11, 14],
    [14, 14, 13, 13],
    [13, 14, 12, 13],
  ]);
  for (const h of detectStopHunts(rows, { strength: 1 }).hunts) {
    assert.notEqual(h.sweepIndex, h.levelIndex);
  }
});

/* ─── The confirmation window ───────────────────────────────────────────── */

/* Bar 5 breaches and closes above; bar 6 still closes above; bar 7 closes back
 * under. So the reclaim lands three bars into a window that starts at 5. */
const SLOW_RECLAIM = [
  ...HUNT_HIGH.slice(0, 5),
  [13, 16, 13, 15.8],
  [15.8, 16, 15.4, 15.5],
  [15.5, 15.6, 13.5, 14],
];

test('confirmBars counts from the breaching bar inclusive', () => {
  const rows = bars(SLOW_RECLAIM);
  const n = (confirmBars) => detectStopHunts(rows, { confirmBars }).hunts;

  // The window is bars 5, 6, 7 — so it takes 3 to reach the reclaim.
  assert.deepEqual(n(1), []);
  assert.deepEqual(n(2), []);
  assert.equal(n(3).length, 1);
  assert.equal(n(4).length, 1);
});

test('a slow reclaim is confirmed on the bar that reclaimed, not the sweep', () => {
  const [h] = detectStopHunts(bars(SLOW_RECLAIM), { confirmBars: 3 }).hunts;
  assert.equal(h.sweepIndex, 5);
  assert.equal(h.index, 7);
  // The wick extreme belongs to the breaching bar, not the confirming one.
  assert.equal(h.extreme, 16);
});

test('a one-bar hunt is a hunt under every window setting', () => {
  const rows = bars(HUNT_HIGH);
  for (const confirmBars of [1, 2, 10]) {
    const { hunts } = detectStopHunts(rows, { confirmBars });
    assert.equal(hunts.length, 1, `confirmBars ${confirmBars}`);
    assert.equal(hunts[0].sweepIndex, hunts[0].index, 'should confirm on its own bar');
  }
});

test('a level is spent once it has been run, whatever happened next', () => {
  /* Bar 5 hunts the level at 15. Bar 7 runs the same price again — but the
   * stops behind it filled two bars ago, so there is nothing left to hunt. */
  const rows = bars([
    ...HUNT_HIGH,
    [13.5, 14, 13, 13.5],
    [13.5, 16, 13.4, 13.8],
  ]);
  const { hunts } = detectStopHunts(rows, { confirmBars: 1 });
  assert.equal(hunts.filter((h) => h.level === 15).length, 1);
});

/* ─── Minimum penetration ───────────────────────────────────────────────── */

test('minWick ignores a level that was only grazed', () => {
  // 15.01 is 0.067% past the level; 16 is 6.7% past it.
  const grazed = bars([...HUNT_HIGH.slice(0, 5), [13, 15.01, 13, 13.5]]);
  const n = (rows, minWick) => detectStopHunts(rows, { confirmBars: 1, minWick }).hunts.length;

  assert.equal(n(grazed, 0), 1);
  assert.equal(n(grazed, 0.05), 1);
  assert.equal(n(grazed, 0.5), 0);
  // The deep one clears every threshold the shallow one fails.
  assert.equal(n(bars(HUNT_HIGH), 0.5), 1);
});

/* ─── Equal highs and lows ──────────────────────────────────────────────── */

/* Two swing highs, at 15 and 15.005 — 0.03% apart, so the same level within
 * the default tolerance. Bar 9 runs both. */
const EQUAL_HIGHS = [
  [10, 11, 9, 10],
  [10, 12, 10, 11],
  [11, 15, 11, 14],
  [14, 14, 13, 13],
  [13, 14, 12, 13],
  [13, 14.5, 12.5, 14],
  [14, 15.005, 13.8, 14.2],
  [14.2, 14.4, 13, 13.2],
  [13.2, 14, 12.8, 13.5],
  [13.5, 16, 13.4, 14],
];

test('two swings at the same price are one level, at the extreme', () => {
  const levels = equalLevels(findSwings(bars(EQUAL_HIGHS), 2), 0.05);
  assert.equal(levels.length, 1);

  const lv = levels[0];
  assert.equal(lv.side, 'high');
  // The extreme, not the average: stops sit beyond the furthest of them.
  assert.equal(lv.price, 15.005);
  assert.equal(lv.count, 2);
  // Drawn from the first, knowable with the second — one high is not an equal high.
  assert.equal(lv.formedIndex, 2);
  assert.equal(lv.knownIndex, 8);
});

test('the tolerance decides what counts as the same price', () => {
  const swings = findSwings(bars(EQUAL_HIGHS), 2);
  // 0.03% apart: inside a 0.05% tolerance, outside a 0.01% one.
  assert.equal(equalLevels(swings, 0.05).length, 1);
  assert.equal(equalLevels(swings, 0.01).length, 0);
  // Zero demands an exact match rather than turning the filter off.
  assert.equal(equalLevels(swings, 0).length, 0);
});

test('a cluster reports how many swings stacked up in it', () => {
  const { hunts } = detectStopHunts(bars(EQUAL_HIGHS), { sources: ['equal'] });
  assert.equal(hunts.length, 1);
  assert.equal(hunts[0].source, 'equal');
  assert.equal(hunts[0].count, 2);
  assert.equal(hunts[0].level, 15.005);
});

test('the cluster and the swings inside it are not reported twice', () => {
  /* Bar 9 runs the cluster. Every swing in it sits at the same price and is
   * taken by the same bar, so that is one event, reported once — as the
   * stronger source. */
  const { hunts } = detectStopHunts(bars(EQUAL_HIGHS), { sources: ['swing', 'equal'] });
  const atSweep9 = hunts.filter((h) => h.sweepIndex === 9);
  assert.equal(atSweep9.length, 1);
  assert.equal(atSweep9[0].source, 'equal');
});

/* ─── Session levels ────────────────────────────────────────────────────── */

/** Hourly bars from a fixed UTC start, so session windows land predictably. */
function hourlyBars(rows, startMs) {
  return rows.map(([open, high, low, close], i) => ({
    time: startMs + i * 3_600_000, open, high, low, close, volume: 1,
  }));
}

test('session levels come from closed sessions only', () => {
  /* 24 hours from midnight UTC on a Wednesday, so Asia, London and New York
   * all appear. Times must be milliseconds — see the note in sessions.js. */
  const start = Date.UTC(2025, 0, 8, 0, 0);
  const rows = hourlyBars(
    Array.from({ length: 40 }, (_, i) => [100 + i, 101 + i, 99 + i, 100 + i]),
    start,
  );
  const levels = sessionLevels(rows, 'futures', []);

  assert.ok(levels.length > 0, 'no session levels at all');
  for (const lv of levels) {
    assert.ok(['high', 'low'].includes(lv.side));
    assert.equal(lv.source, 'session');
    assert.ok(lv.sessionName, 'a session level should say which session');
    // Knowable only after the session closed, never during it.
    assert.ok(lv.knownIndex > lv.formedIndex);
    // The session still running at the right edge is not a level yet.
    assert.ok(lv.knownIndex <= rows.length - 1);
  }
});

test('a session still open at the right edge gives no level', () => {
  const start = Date.UTC(2025, 0, 8, 0, 0);
  // Four bars, all inside the Asia window — the session never closes in view.
  const rows = hourlyBars([
    [100, 101, 99, 100], [100, 102, 99, 101], [101, 103, 100, 102], [102, 104, 101, 103],
  ], start);
  assert.deepEqual(sessionLevels(rows, 'futures', []), []);
});

/* ─── Invalidation, show and lookback ───────────────────────────────────── */

/* The hunt at bar 5 works, then bar 7 closes back above the level: the reclaim
 * did not hold and the level broke after all. */
const FAILED_HUNT = [
  ...HUNT_HIGH,
  [13.5, 14, 13, 13.5],
  [13.5, 17, 13.4, 16.5],
];

test('a hunt price closed back through is marked, not deleted', () => {
  // Index 7 is two bars past the confirmation, well inside the default window.
  const { hunts } = detectStopHunts(bars(FAILED_HUNT), { confirmBars: 1 });
  assert.equal(hunts.length, 1);
  assert.equal(hunts[0].invalidatedIndex, 7);
  assert.equal(hunts[0].sweepIndex, 5, 'the hunt still happened where it happened');
});

test('a hunt is only on trial for holdBars after it confirmed', () => {
  /* The hunt confirms at index 5. Price closes back above the level at index
   * 7 — two bars later, which is inside a window of 2 and outside a window
   * of 1. Beyond the window the same close means nothing. */
  const rows = bars(FAILED_HUNT);
  const invalidated = (holdBars) => detectStopHunts(rows, { confirmBars: 1, holdBars })
    .hunts[0].invalidatedIndex;

  assert.equal(invalidated(2), 7);
  assert.equal(invalidated(10), 7);
  assert.equal(invalidated(1), null, 'failed after its window had closed');
  // Zero is the unbounded reading, kept for anyone who wants it.
  assert.equal(invalidated(0), 7);
});

test('a hunt that survived its window cannot fail later', () => {
  /* The same failure, pushed out to index 12 — eight bars past a window of 3.
   * By then the level is not on trial any more. */
  const rows = bars([
    ...HUNT_HIGH,
    ...Array.from({ length: 6 }, () => [13.5, 14, 13, 13.5]),
    [13.5, 17, 13.4, 16.5],
  ]);
  assert.equal(detectStopHunts(rows, { confirmBars: 1, holdBars: 3 }).hunts[0].invalidatedIndex, null);
  assert.equal(detectStopHunts(rows, { confirmBars: 1, holdBars: 0 }).hunts[0].invalidatedIndex, 12);
});

test('a negative hold window is refused', () => {
  assert.throws(() => detectStopHunts(bars(HUNT_HIGH), { holdBars: -1 }), /holdBars must be >= 0/);
});

test('show decides whether a failed hunt stays on the chart', () => {
  const rows = bars(FAILED_HUNT);
  // Default keeps it: the mark already stops where the hunt ended.
  assert.equal(detectStopHunts(rows, { confirmBars: 1 }).hunts.length, 1);
  assert.deepEqual(detectStopHunts(rows, { confirmBars: 1, show: 'active' }).hunts, []);
});

test('the confirming bar cannot invalidate its own hunt', () => {
  // It closed back inside by definition; only a later bar can undo that.
  for (const h of detectStopHunts(bars(HUNT_HIGH), { confirmBars: 1 }).hunts) {
    assert.notEqual(h.invalidatedIndex, h.index);
  }
});

test('lookback counts back from the newest bar', () => {
  /* The hunt confirms at index 5. Two quiet bars after it put the newest bar
   * at index 7, so the window has to reach three bars back to include it. */
  const rows = bars([
    ...HUNT_HIGH,
    [13.5, 14, 13, 13.5],
    [13.5, 14, 13, 13.5],
  ]);
  const n = (lookback) => detectStopHunts(rows, { confirmBars: 1, lookback }).hunts.length;

  assert.equal(n(3), 1);
  assert.equal(n(2), 0, 'the window stopped short of the confirming bar');
  // Zero is off, not a window of nothing.
  assert.equal(n(0), 1);
});

/* ─── Edges ─────────────────────────────────────────────────────────────── */

test('too few bars to hold a swing produce nothing', () => {
  for (const n of [0, 1, 2, 3, 4]) {
    const rows = bars(HUNT_HIGH.slice(0, n));
    assert.deepEqual(detectStopHunts(rows, { strength: 2 }).hunts, [], `${n} bars`);
  }
});

test('no sources is a switched-off indicator, not an error', () => {
  assert.deepEqual(detectStopHunts(bars(HUNT_HIGH), { sources: [] }).hunts, []);
});

test('equal ties are not swings between themselves', () => {
  // Two bars at exactly the same high: neither is a fractal over the other.
  const rows = bars([
    [10, 11, 9, 10], [10, 15, 10, 14], [14, 15, 13, 14], [14, 14, 13, 13], [13, 14, 12, 13],
  ]);
  assert.deepEqual(findSwings(rows, 1).filter((s) => s.side === 'high' && s.price === 15), []);
});

test('a bad parameter is refused rather than guessed', () => {
  const rows = bars(HUNT_HIGH);
  assert.throws(() => detectStopHunts(rows, { sources: ['orderblock'] }), /unknown source/);
  assert.throws(() => detectStopHunts(rows, { sources: 'swing' }), /must be an array/);
  assert.throws(() => detectStopHunts(rows, { show: 'maybe' }), /unknown show/);
  assert.throws(() => detectStopHunts(rows, { strength: 0 }), /strength must be >= 1/);
  assert.throws(() => detectStopHunts(rows, { confirmBars: 0 }), /confirmBars must be >= 1/);
  assert.throws(() => detectStopHunts('nope'), /bars must be an array/);
});

/* ─── Registry ──────────────────────────────────────────────────────────── */

test('the indicator runs through the registry', () => {
  const { hunts } = computeIndicator('stophunt', bars(HUNT_HIGH), { confirmBars: 1 });
  assert.equal(hunts.length, 1);
  assert.equal(hunts[0].level, 15);
});

test('the registry validates a multi parameter like it validates a select', () => {
  const rows = bars(HUNT_HIGH);
  assert.throws(() => computeIndicator('stophunt', rows, { sources: ['orderblock'] }), /not one of/);
  assert.throws(() => computeIndicator('stophunt', rows, { sources: 'swing' }), /expected a list/);
  // A valid subset still passes.
  assert.doesNotThrow(() => computeIndicator('stophunt', rows, { sources: ['swing', 'equal'] }));
});

test('every hunt colour defaults to a token the theme actually defines', () => {
  const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
  const allowed = new Set(ZONE_PALETTE.map((o) => o.value));

  for (const p of STOPHUNT_PARAMS) {
    if (p.type !== 'color') continue;
    assert.ok(allowed.has(p.default), `${p.key} defaults outside the palette`);
    assert.ok(css.includes(`--${p.default}:`), `--${p.default} is not a token`);
  }
});

test('the function defaults and the panel defaults are the same rules', () => {
  /* The same trap fvg.js documents: a default lives in two places — the
   * destructuring defaults and the param schema — and nothing but a test keeps
   * them in step. A drift here means the chart and a strategy reading the same
   * indicator disagree about what it does. */
  const rows = bars(SLOW_RECLAIM);
  const schema = Object.fromEntries(STOPHUNT_PARAMS.map((p) => [p.key, p.default]));

  assert.deepEqual(
    detectStopHunts(rows, schema).hunts,
    detectStopHunts(rows).hunts,
    'schema defaults differ from code defaults',
  );
});

test('the spec declares the shape the chart branches on', () => {
  const spec = INDICATORS.stophunt;
  assert.equal(spec.kind, 'hunts');
  assert.equal(spec.pane, 'price');
  // The panel builds its fields from this, so every parameter needs a hint.
  for (const p of spec.params) {
    assert.ok(p.hint, `${p.key} has no hint`);
    assert.ok(p.label, `${p.key} has no label`);
  }
});
