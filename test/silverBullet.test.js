import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SILVER_BULLET_PARAMS, SILVER_BULLET_WINDOWS, detectSilverBullet,
} from '../shared/indicators/silverBullet.js';
import { INDICATORS, computeIndicator } from '../shared/indicators/index.js';

/* 5-minute bars starting 09:15 New York on 1 July 2026 (EDT, UTC-4), so bar 9
 * lands exactly on 10:00 — the opening minute of the NY AM window. Times must
 * be milliseconds; the windows are read off a wall clock. */
const START = Date.UTC(2026, 6, 1, 13, 15);
const STEP = 300_000;

function bars(rows, start = START) {
  return rows.map(([open, high, low, close], i) => ({
    time: start + i * STEP, open, high, low, close, volume: 1,
  }));
}

/* A complete long chain:
 *   bar 2  swing low at 95, knowable from bar 4
 *   bar 5  sweeps it (low 94) and closes back above — and is also the last
 *          bearish candle before the gap, so it is the shift reference
 *   bar 8  confirms the gap [103, 105]; its close of 110 clears the body at 99
 *   bar 9  10:00 NY — retests 105, which is the entry
 *   bar 10 reaches the 2R target at 127
 */
const LONG = [
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
];

/** The same chain reflected about a price, so a short is not written by hand. */
const MIRROR = 200;
const flip = (rows) => rows.map(([o, h, l, c]) => [MIRROR - o, MIRROR - l, MIRROR - h, MIRROR - c]);
const SHORT = flip(LONG);

const only = (rows, params) => {
  const { setups } = detectSilverBullet(bars(rows), params);
  assert.equal(setups.length, 1, `expected exactly one setup, got ${setups.length}`);
  return setups[0];
};

/* ─── The chain ─────────────────────────────────────────────────────────── */

test('a full long chain becomes one setup', () => {
  const s = only(LONG);
  assert.equal(s.direction, 'bull');
  assert.equal(s.window, 'am');

  assert.equal(s.sweepIndex, 5);
  assert.equal(s.sweepExtreme, 94);
  assert.deepEqual([s.gapBottom, s.gapTop], [103, 105]);
  assert.equal(s.gapIndex, 8);
  assert.equal(s.mssIndex, 8);
  assert.equal(s.mssRefIndex, 5, 'the last bearish candle before the gap');
  assert.equal(s.mssLevel, 99, 'its open — the body edge facing the impulse');
  assert.equal(s.entryIndex, 9);
  assert.equal(s.entryPrice, 105, 'the near edge of the gap');
});

test('the mirrored chain becomes the same setup, short', () => {
  const s = only(SHORT);
  assert.equal(s.direction, 'bear');
  assert.equal(s.sweepExtreme, MIRROR - 94);
  assert.deepEqual([s.gapBottom, s.gapTop], [MIRROR - 105, MIRROR - 103]);
  // A bearish gap is entered at its bottom — price has to come back up to it.
  assert.equal(s.entryPrice, MIRROR - 105);
  assert.equal(s.stop, MIRROR - 94);
});

test('the stop sits at the wick that took the liquidity', () => {
  const s = only(LONG);
  assert.equal(s.stop, 94);
  assert.equal(s.risk, 105 - 94);
});

test('the target is the risk times the reward multiple', () => {
  assert.equal(only(LONG).target, 105 + 2 * 11);
  assert.equal(only(LONG, { rrr: 3 }).target, 105 + 3 * 11);
  assert.equal(only(LONG, { rrr: 1 }).target, 105 + 11);
  // A short measures the same distance the other way.
  assert.equal(only(SHORT).target, (MIRROR - 105) - 2 * 11);
});

/* ─── Every link is required ────────────────────────────────────────────── */

test('without a sweep there is no setup', () => {
  // Bar 5 no longer trades below the swing low at 95, so nothing was taken.
  const rows = LONG.map((r, i) => (i === 5 ? [99, 99, 96, 98] : r));
  assert.deepEqual(detectSilverBullet(bars(rows)).setups, []);
});

test('without a reclaim the sweep is a break and there is no setup', () => {
  // It runs below 95 and stays below — and nothing reclaims it in time.
  const rows = LONG.map((r, i) => (i === 5 ? [99, 99, 94, 94] : r));
  const { setups } = detectSilverBullet(bars(rows), { confirmBars: 1 });
  assert.deepEqual(setups, []);
});

test('without a gap there is no setup', () => {
  /* Bar 8 is pulled down so its low no longer clears bar 6's high: the move up
   * happened, but it left no imbalance behind. */
  const rows = LONG.map((r, i) => (i === 8 ? [107, 112, 100, 110] : r));
  assert.deepEqual(detectSilverBullet(bars(rows)).setups, []);
});

test('without the structure shift there is no setup', () => {
  /* Bar 6 is a large bearish candle opening at 130. It is the last opposing
   * candle before every gap that follows, so each of them measures its shift
   * against 130 — and nothing afterwards closes anywhere near it. The sweep,
   * the gaps and a retest all happen; only the shift is missing, and that is
   * enough to leave no setup. */
  const rows = [
    ...LONG.slice(0, 6),
    [130, 131, 96, 97],
    [97, 99, 96, 98],
    [98, 103, 98, 102],
    [102, 108, 101, 107],
    [107, 112, 105, 110],
    [110, 111, 104, 106],
  ];
  assert.deepEqual(detectSilverBullet(bars(rows)).setups, []);
});

test('without a retest there is no entry and no setup', () => {
  // Price runs away from the gap instead of coming back to 105.
  const rows = [
    ...LONG.slice(0, 9),
    [110, 140, 109, 138],
    [138, 150, 137, 148],
  ];
  assert.deepEqual(detectSilverBullet(bars(rows)).setups, []);
});

/* ─── Choosing among candidates ─────────────────────────────────────────── */

test('a sweep followed by several gaps takes the first that completes', () => {
  /* This chain contains two bullish gaps: [99, 101] confirmed at bar 7, and
   * [103, 105] at bar 8. Price never returns to 101, so the earlier gap has no
   * entry — and the setup is built from the later one rather than abandoned. */
  const s = only(LONG);
  assert.equal(s.gapIndex, 8);
  assert.deepEqual([s.gapBottom, s.gapTop], [103, 105]);
});

test('only the first qualifying setup of a window occurrence is kept', () => {
  /* The chain, then a second complete one later in the same hour. The window
   * has one setup in it — the first — not two. */
  const rows = [
    ...LONG,
    [128, 129, 120, 121],
    [121, 122, 112, 113],
    [113, 125, 112, 124],
    [124, 133, 123, 132],
    [132, 140, 134, 138],
    [138, 139, 130, 133],
  ];
  const { setups } = detectSilverBullet(bars(rows));
  assert.equal(setups.length, 1);
  assert.equal(setups[0].entryIndex, 9, 'the first one, not a later one');
});

/* ─── Windows ───────────────────────────────────────────────────────────── */

test('an entry outside every window is not a setup', () => {
  /* The identical chain, shifted three hours earlier: bar 9 now falls at 07:00
   * New York, which is not a Silver Bullet hour. */
  const shifted = bars(LONG, START - 3 * 3_600_000);
  assert.deepEqual(detectSilverBullet(shifted).setups, []);
});

test('the windows can be switched on and off individually', () => {
  const rows = bars(LONG);
  assert.equal(detectSilverBullet(rows, { windows: ['am'] }).setups.length, 1);
  assert.deepEqual(detectSilverBullet(rows, { windows: ['london', 'pm'] }).setups, []);
  // None at all is a switched-off indicator, not an error.
  assert.deepEqual(detectSilverBullet(rows, { windows: [] }).setups, []);
});

test('scope all demands the whole chain inside the hour', () => {
  /* The entry is at 10:00 but the sweep is at 09:40, so under 'entry' this is a
   * setup and under 'all' it is not. */
  const rows = bars(LONG);
  assert.equal(detectSilverBullet(rows, { scope: 'entry' }).setups.length, 1);
  assert.deepEqual(detectSilverBullet(rows, { scope: 'all' }).setups, []);
});

test('a chain entirely inside the hour survives scope all', () => {
  // Same bars, started so that bar 0 is already 10:00 rather than 09:15.
  const inside = bars(LONG, Date.UTC(2026, 6, 1, 14, 0));
  const { setups } = detectSilverBullet(inside, { scope: 'all' });
  assert.equal(setups.length, 1);
  assert.equal(setups[0].window, 'am');
});

test('the windows follow New York time across the clock change', () => {
  /* 10:00 New York is 14:00 UTC in summer and 15:00 UTC in winter. The same
   * bars at the same UTC hour therefore land inside the window in July and
   * outside it in January — which is the whole reason for reading a wall
   * clock instead of a fixed offset. */
  const july = bars(LONG, Date.UTC(2026, 6, 1, 13, 15));
  const january = bars(LONG, Date.UTC(2026, 0, 14, 13, 15));

  assert.equal(detectSilverBullet(july).setups.length, 1);
  assert.deepEqual(detectSilverBullet(january).setups, [], 'winter puts 09:15 UTC-5 elsewhere');

  // Shifted by the hour the clocks moved, January produces the setup again.
  const januaryShifted = bars(LONG, Date.UTC(2026, 0, 14, 14, 15));
  assert.equal(detectSilverBullet(januaryShifted).setups.length, 1);
});

/* ─── Distance limits and size ──────────────────────────────────────────── */

test('maxSweepToGap drops a gap that lagged the sweep too far', () => {
  const rows = bars(LONG);
  // The gap confirms at 8, the sweep at 5 — three bars apart.
  assert.equal(detectSilverBullet(rows, { maxSweepToGap: 3 }).setups.length, 1);
  assert.deepEqual(detectSilverBullet(rows, { maxSweepToGap: 2 }).setups, []);
});

test('maxGapToEntry drops a retest that came too late', () => {
  const rows = bars(LONG);
  // The entry is one bar after the gap confirmed.
  assert.equal(detectSilverBullet(rows, { maxGapToEntry: 1 }).setups.length, 1);
  /* At zero the parameter is refused rather than silently disabling entries —
   * a window of no bars is not a setting anyone means. */
  assert.throws(() => detectSilverBullet(rows, { maxGapToEntry: 0 }), /maxGapToEntry must be >= 1/);
});

test('minGapSize ignores a gap too thin to trade', () => {
  const rows = bars(LONG);
  const n = (params) => detectSilverBullet(rows, params).setups.length;

  // The gap is two points tall, on a price around 104.
  assert.equal(n({ minGapSize: 2, minGapSizeUnit: 'points' }), 1);
  assert.equal(n({ minGapSize: 2.5, minGapSizeUnit: 'points' }), 0);
  // The same number means something entirely different in the other unit.
  assert.equal(n({ minGapSize: 1, minGapSizeUnit: 'percent' }), 1);
  assert.equal(n({ minGapSize: 3, minGapSizeUnit: 'percent' }), 0);
});

/* ─── Look-ahead ────────────────────────────────────────────────────────── */

test('a setup is drawn from the sweep and tradable at the entry', () => {
  const s = only(LONG);
  assert.equal(s.startIndex, s.sweepIndex, 'drawn from where the story starts');
  assert.equal(s.index, s.entryIndex, 'knowable only once it was entered');
  assert.equal(s.time, s.entryTime);
});

test('every link happens in order', () => {
  const s = only(LONG);
  assert.ok(s.sweepIndex < s.gapIndex, 'the gap follows the sweep');
  assert.ok(s.mssIndex >= s.gapIndex, 'the shift cannot precede the gap');
  assert.ok(s.entryIndex > s.mssIndex, 'the entry cannot precede the shift');
  assert.ok(s.mssRefIndex < s.gapStartIndex, 'the reference is before the gap');
});

/* ─── Outcomes ──────────────────────────────────────────────────────────── */

test('a setup that reaches its target is reported as one', () => {
  const s = only(LONG);
  assert.equal(s.outcome, 'target');
  assert.equal(s.outcomeIndex, 10);
  assert.equal(s.barsToOutcome, 1);
});

test('a setup that is stopped out is reported as one', () => {
  // Bar 10 drops through 94 instead of running to the target.
  const rows = LONG.map((r, i) => (i === 10 ? [106, 107, 90, 92] : r));
  const s = only(rows);
  assert.equal(s.outcome, 'stop');
  assert.equal(s.outcomeIndex, 10);
});

test('a bar that touches both counts as the stop', () => {
  /* The pessimistic rule ARCHITECTURE.md sets out for data with nothing finer
   * underneath it. Bar 10 reaches 127 and 94 in the same bar. */
  const rows = LONG.map((r, i) => (i === 10 ? [106, 130, 90, 100] : r));
  assert.equal(only(rows).outcome, 'stop');
});

test('a setup still running is left open rather than guessed at', () => {
  const rows = LONG.map((r, i) => (i === 10 ? [106, 110, 100, 108] : r));
  const s = only(rows);
  assert.equal(s.outcome, 'open');
  assert.equal(s.outcomeIndex, null);
  assert.equal(s.barsToOutcome, null);
});

test('the entry bar itself can resolve the trade', () => {
  // Bar 9 touches the entry at 105 and then runs straight through the stop.
  const rows = LONG.map((r, i) => (i === 9 ? [110, 111, 90, 93] : r));
  const s = only(rows);
  assert.equal(s.outcomeIndex, s.entryIndex);
  assert.equal(s.barsToOutcome, 0);
});

/* ─── Edges and validation ──────────────────────────────────────────────── */

test('too few bars produce nothing rather than throwing', () => {
  for (const n of [0, 1, 5, 9]) {
    assert.deepEqual(detectSilverBullet(bars(LONG.slice(0, n))).setups, [], `${n} bars`);
  }
});

test('a bad parameter is refused rather than guessed', () => {
  const rows = bars(LONG);
  assert.throws(() => detectSilverBullet(rows, { windows: ['asia'] }), /unknown window/);
  assert.throws(() => detectSilverBullet(rows, { windows: 'am' }), /must be an array/);
  assert.throws(() => detectSilverBullet(rows, { scope: 'some' }), /unknown scope/);
  assert.throws(() => detectSilverBullet(rows, { minGapSizeUnit: 'pips' }), /unknown minGapSizeUnit/);
  assert.throws(() => detectSilverBullet(rows, { rrr: 0 }), /rrr must be > 0/);
  assert.throws(() => detectSilverBullet(rows, { maxSweepToGap: 0 }), /maxSweepToGap must be >= 1/);
  assert.throws(() => detectSilverBullet('nope'), /bars must be an array/);
});

/* ─── Registry ──────────────────────────────────────────────────────────── */

test('the indicator runs through the registry', () => {
  const { setups } = computeIndicator('silverbullet', bars(LONG), {});
  assert.equal(setups.length, 1);
  assert.equal(setups[0].entryPrice, 105);
});

test('the registry validates the window list', () => {
  const rows = bars(LONG);
  assert.throws(() => computeIndicator('silverbullet', rows, { windows: ['asia'] }), /not one of/);
  assert.throws(() => computeIndicator('silverbullet', rows, { windows: 'am' }), /expected a list/);
});

test('the spec declares the shape the chart branches on', () => {
  const spec = INDICATORS.silverbullet;
  assert.equal(spec.kind, 'setups');
  assert.equal(spec.pane, 'price');
  for (const p of spec.params) {
    assert.ok(p.hint, `${p.key} has no hint`);
    assert.ok(p.label, `${p.key} has no label`);
  }
});

test('the window schema and the detector agree on the three hours', () => {
  const schema = SILVER_BULLET_PARAMS.find((p) => p.key === 'windows');
  assert.deepEqual(
    schema.options.map((o) => o.value),
    SILVER_BULLET_WINDOWS.map((w) => w.value),
    'the panel would offer a window the detector does not know',
  );
});

test('the function defaults and the panel defaults are the same rules', () => {
  /* The same trap fvg.js documents: a default lives in the destructuring and
   * in the schema, and nothing but a test keeps the two in step. */
  const rows = bars(LONG);
  const schema = Object.fromEntries(SILVER_BULLET_PARAMS.map((p) => [p.key, p.default]));

  assert.deepEqual(
    detectSilverBullet(rows, schema).setups,
    detectSilverBullet(rows).setups,
    'schema defaults differ from code defaults',
  );
});
