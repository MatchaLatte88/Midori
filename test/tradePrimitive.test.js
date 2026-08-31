/* Placing an executed trade on the chart.
 *
 * Two pieces of arithmetic that are wrong in ways nothing would report: a fill
 * put on the wrong bar draws a block a few candles off, and an extent computed
 * in logical space silently collapses to the left edge — the trap fvgPrimitive
 * documents. Both live in pure functions so they can be checked without a chart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { barIndexAt, tradeExtent } from '../src/components/chart/tradePrimitive.js';
import { positionStats } from '../src/components/chart/drawings/geometry.js';

/** 5-minute bars starting at zero. */
const BARS = Array.from({ length: 10 }, (_, i) => ({ time: i * 300_000 }));

const BAR = 10;                                  // pixels per bar
const indexToX = (index) => 5 + index * BAR;     // bar 0 at x = 5

/* ─── Placing a fill ────────────────────────────────────────────────────── */

test('a fill on a bar boundary lands on that bar', () => {
  assert.equal(barIndexAt(BARS, 0), 0);
  assert.equal(barIndexAt(BARS, 300_000), 1);
  assert.equal(barIndexAt(BARS, 900_000), 3);
});

test('a fill inside a bar lands on the bar containing it', () => {
  /* The case that matters: with minute resolution a fill happens partway
   * through the bar, and its timestamp is not any bar's own. */
  assert.equal(barIndexAt(BARS, 300_001), 1, 'one millisecond in');
  assert.equal(barIndexAt(BARS, 450_000), 1, 'halfway through bar 1');
  assert.equal(barIndexAt(BARS, 599_999), 1, 'just before bar 2 opens');
  assert.equal(barIndexAt(BARS, 600_000), 2, 'and exactly at bar 2');
});

test('a fill outside the loaded window clamps to an end', () => {
  /* Better a block drawn at the edge than one that vanished: the window around
   * a trade can start after a gap in the data. */
  assert.equal(barIndexAt(BARS, -1), 0);
  assert.equal(barIndexAt(BARS, 999_999_999), BARS.length - 1);
});

test('no bars gives a usable index rather than -1', () => {
  assert.equal(barIndexAt([], 500), 0);
  assert.equal(barIndexAt(null, 500), 0);
});

test('every bar is findable by its own timestamp', () => {
  // A binary search that is off by one somewhere fails exactly here.
  for (let i = 0; i < BARS.length; i++) {
    assert.equal(barIndexAt(BARS, BARS[i].time), i, `bar ${i}`);
  }
});

/* ─── The block ─────────────────────────────────────────────────────────── */

test('the block spans both the entry and the exit bar', () => {
  const { left, right } = tradeExtent({ entryIndex: 2, exitIndex: 5 }, BAR, indexToX);
  // Half a bar left of bar 2's centre (25) to half a bar past bar 5's (55).
  assert.equal(left, 20);
  assert.equal(right, 60);
  assert.equal(right - left, 4 * BAR, 'four bars: entry, exit and the two between');
});

test('a trade opened and closed on one bar is still one bar wide', () => {
  /* Common with minute resolution: a stop hit inside the same bar the entry
   * filled on. A zero-width block would be invisible. */
  const { left, right } = tradeExtent({ entryIndex: 3, exitIndex: 3 }, BAR, indexToX);
  assert.equal(right - left, BAR);
  assert.ok(right > left, 'the block must not be inverted');
});

test('the block never runs backwards', () => {
  // Defensive: an exit index before the entry cannot produce a negative width.
  const { left, right } = tradeExtent({ entryIndex: 5, exitIndex: 2 }, BAR, indexToX);
  assert.ok(right > left, `right ${right} is not past left ${left}`);
});

test('the block follows the bars when older ones are paged in', () => {
  const shifted = (index) => 5 + (index - 100) * BAR;
  const a = tradeExtent({ entryIndex: 2, exitIndex: 5 }, BAR, indexToX);
  const b = tradeExtent({ entryIndex: 102, exitIndex: 105 }, BAR, shifted);

  assert.equal(b.left, a.left);
  assert.equal(b.right, a.right);
});

test('the block scales with the zoom', () => {
  const wide = 40;
  const { left, right } = tradeExtent(
    { entryIndex: 2, exitIndex: 5 }, wide, (i) => 5 + i * wide,
  );
  assert.equal(right - left, 4 * wide);
});

/* ─── Why the labels guard against a missing bracket ────────────────────── */

test('position stats read a missing leg as zero, which is why it is guarded', () => {
  /* Not a complaint about positionStats — it is documented to take three
   * prices. This pins the behaviour the primitive has to protect against: runs
   * stored before the broker carried the bracket have no stop and no target,
   * and handing those straight in produces a confident, invented ratio rather
   * than an absence. */
  const bogus = positionStats(100, null, null);

  assert.equal(bogus.risk, 100, 'a null stop reads as a price of zero');
  assert.notEqual(bogus.rr, null, 'and yields a ratio that means nothing');

  // With a real bracket the same call is meaningful.
  const real = positionStats(100, 95, 110);
  assert.equal(real.risk, 5);
  assert.equal(real.reward, 10);
  assert.equal(real.rr, 2);
});
