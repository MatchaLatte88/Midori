import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  alignDown, isAscending, latestPage, prependBars, previousPage,
} from '../src/components/chart/barPaging.js';
import { aggregate, STRIDE } from '../electron/data/store/barStore.js';

const MIN = 60_000;
const HOUR = 3_600_000;

test('alignDown snaps to the bucket below', () => {
  const base = Date.UTC(2026, 2, 22, 14, 0);
  assert.equal(alignDown(base, HOUR), base, 'already on a boundary');
  assert.equal(alignDown(base + 59 * MIN, HOUR), base);
  assert.equal(alignDown(base - 1, HOUR), base - HOUR);
  assert.throws(() => alignDown(NaN, HOUR), /time must be finite/);
  assert.throws(() => alignDown(base, 0), /step must be positive/);
});

test('the newest page ends on a boundary past the last bar', () => {
  // Last bar at 23:59 on the 1m grid; on an hourly chart the page must reach
  // the end of the 23:00 bucket, not stop inside it.
  const meta = { first: Date.UTC(2026, 0, 1), last: Date.UTC(2026, 0, 31, 23, 59) };
  const { from, to } = latestPage(meta, HOUR, 100);

  assert.equal(to, Date.UTC(2026, 1, 1, 0, 0), 'the last bucket is included whole');
  assert.equal(to % HOUR, 0);
  assert.equal(from % HOUR, 0);
  assert.equal((to - from) / HOUR, 100, 'a full page when there is room for one');
});

test('a page shorter than the stored data is clamped to its start', () => {
  // Two days of data, a page asking for a hundred hours: it stops at the
  // beginning rather than inventing a range before the first bar.
  const meta = { first: Date.UTC(2026, 0, 1), last: Date.UTC(2026, 0, 2, 23, 59) };
  const { from, to } = latestPage(meta, HOUR, 100);

  assert.equal(from, meta.first, 'clamped to the first bar');
  assert.equal((to - from) / HOUR, 48, 'which is all there is');
});

test('the previous page ends exactly where the current one begins', () => {
  const meta = { first: Date.UTC(2026, 0, 1), last: Date.UTC(2026, 0, 20) };
  const first = latestPage(meta, HOUR, 24);
  const second = previousPage(meta, HOUR, 24, first.from);

  assert.equal(second.to, first.from, 'no gap and no overlap between pages');
  assert.equal(second.from % HOUR, 0);
});

test('paging stops at the start of the data', () => {
  const meta = { first: Date.UTC(2026, 0, 1), last: Date.UTC(2026, 0, 2) };
  const page = previousPage(meta, HOUR, 1000, meta.first);
  assert.equal(page, null, 'nothing older to ask for');

  // A page that would reach past the beginning is clamped to it.
  const clamped = previousPage(meta, HOUR, 1000, Date.UTC(2026, 0, 1, 5));
  assert.equal(clamped.from, Date.UTC(2026, 0, 1));
});

test('aligned pages produce no duplicate bucket — the bug this fixes', () => {
  /* Reproduces the reported failure: "data must be asc ordered by time,
   * index=3001, time=X, prev time=X". Two pages whose boundary fell inside an
   * hour each produced that hour's bucket, and the chart got it twice. */
  const start = Date.UTC(2026, 2, 22, 0, 0);
  const count = 600; // ten hours of minutes
  const data = new Float64Array(count * STRIDE);
  for (let i = 0; i < count; i++) {
    const base = i * STRIDE;
    data[base] = start + i * MIN;
    data[base + 1] = 100 + i;
    data[base + 2] = 101 + i;
    data[base + 3] = 99 + i;
    data[base + 4] = 100.5 + i;
    data[base + 5] = 1;
    data[base + 6] = 0.5;
  }
  const meta = { first: start, last: start + (count - 1) * MIN };

  // Unaligned boundaries, as the code did before: the same bucket twice.
  const unalignedBoundary = meta.last + HOUR - 5 * HOUR; // lands at :59
  const newerUnaligned = aggregate(data, unalignedBoundary, meta.last + HOUR, '1h', false);
  const olderUnaligned = aggregate(data, start, unalignedBoundary, '1h', false);
  const naive = [...olderUnaligned, ...newerUnaligned];
  assert.equal(isAscending(naive), false, 'the old behaviour really did collide');

  // Aligned pages: clean.
  const newer = latestPage(meta, HOUR, 5);
  const older = previousPage(meta, HOUR, 5, newer.from);
  const merged = prependBars(
    aggregate(data, older.from, older.to, '1h', false),
    aggregate(data, newer.from, newer.to, '1h', false),
  );

  assert.equal(isAscending(merged), true, 'no timestamp appears twice');
  for (const bar of merged) {
    assert.equal(bar.time % HOUR, 0, 'every bucket starts on the hour');
  }
});

test('a full bucket is not cut short by a page boundary', () => {
  // The quieter half of the same bug: the first bar of a page was built from
  // part of its bucket, so its OHLC was wrong without anything failing.
  const start = Date.UTC(2026, 2, 22, 0, 0);
  const count = 180;
  const data = new Float64Array(count * STRIDE);
  for (let i = 0; i < count; i++) {
    const base = i * STRIDE;
    data[base] = start + i * MIN;
    data[base + 1] = 100 + i;
    data[base + 2] = 100 + i;
    data[base + 3] = 100 + i;
    data[base + 4] = 100 + i;
    data[base + 5] = 1;
    data[base + 6] = 0.5;
  }

  const wholeHour = aggregate(data, start + HOUR, start + 2 * HOUR, '1h', false)[0];
  const cutShort = aggregate(data, start + HOUR + 50 * MIN, start + 2 * HOUR, '1h', false)[0];

  assert.equal(wholeHour.time, cutShort.time, 'both claim to be the same bar');
  assert.equal(wholeHour.open, 160, 'the real hour opens at its first minute');
  assert.equal(cutShort.open, 210, 'the cut one opens 50 minutes late');
  assert.notEqual(wholeHour.open, cutShort.open,
    'which is why boundaries have to be aligned');
});

/* ─── Merging ───────────────────────────────────────────────────────────── */

const bar = (t) => ({ time: t, open: 1, high: 2, low: 0, close: 1 });

test('prepend keeps the series ascending', () => {
  const existing = [bar(300), bar(400)];
  const merged = prependBars([bar(100), bar(200)], existing);
  assert.deepEqual(merged.map((b) => b.time), [100, 200, 300, 400]);
  assert.equal(isAscending(merged), true);
});

test('an overlapping older page loses its overlap rather than duplicating', () => {
  const existing = [bar(300), bar(400)];
  const merged = prependBars([bar(200), bar(300), bar(400)], existing);
  assert.deepEqual(merged.map((b) => b.time), [200, 300, 400],
    'the copies already loaded win');
  assert.equal(isAscending(merged), true);
});

test('prepending onto nothing just returns the page', () => {
  assert.deepEqual(prependBars([bar(1), bar(2)], []).map((b) => b.time), [1, 2]);
});

test('isAscending catches equal and out-of-order timestamps', () => {
  assert.equal(isAscending([]), true);
  assert.equal(isAscending([bar(1)]), true);
  assert.equal(isAscending([bar(1), bar(2)]), true);
  assert.equal(isAscending([bar(1), bar(1)]), false, 'equal is not ascending');
  assert.equal(isAscending([bar(2), bar(1)]), false);
});
