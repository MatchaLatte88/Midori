import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FORMAT_VERSION, STRIDE, aggregate, lowerBound, mergeBars, migrateV1, readBars,
  readDataset, readMeta, timeframeMs,
} from '../electron/data/store/barStore.js';

const MIN = 60_000;

/** Builds a Float64Array of `count` consecutive 1m bars starting at `start`. */
function makeData(start, count, priceAt = (i) => 100 + i) {
  const data = new Float64Array(count * STRIDE);
  for (let i = 0; i < count; i++) {
    const p = priceAt(i);
    const base = i * STRIDE;
    data[base] = start + i * MIN;
    data[base + 1] = p;          // open
    data[base + 2] = p + 1;      // high
    data[base + 3] = p - 1;      // low
    data[base + 4] = p + 0.5;    // close
    data[base + 5] = 10;         // volume
    data[base + 6] = 6;          // buy volume
  }
  return data;
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'midori-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('lowerBound finds the first index at or after the target', () => {
  const data = makeData(1000, 5); // times 1000, 61000, 121000, 181000, 241000
  assert.equal(lowerBound(data, 0), 0);
  assert.equal(lowerBound(data, 1000), 0);
  assert.equal(lowerBound(data, 1001), 1);
  assert.equal(lowerBound(data, 121000), 2);
  assert.equal(lowerBound(data, 999999), 5, 'past the end returns the bar count');
});

test('aggregate builds correct OHLCV buckets on UTC boundaries', () => {
  // 15 one-minute bars from a clean 15m boundary.
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  const data = makeData(start, 15);
  const bars = aggregate(data, start, start + 15 * MIN, '15m');

  assert.equal(bars.length, 1);
  const b = bars[0];
  assert.equal(b.time, start, 'bucket is stamped with its opening time');
  assert.equal(b.open, 100, 'open comes from the first minute');
  assert.equal(b.close, 114.5, 'close comes from the last minute');
  assert.equal(b.high, 115, 'high is the max of the minute highs');
  assert.equal(b.low, 99, 'low is the min of the minute lows');
  assert.equal(b.volume, 150, 'volume is the sum');
  assert.equal(b.buyVolume, 90, 'buy volume is summed alongside it');
});

test('an unknown minute makes the whole aggregated bucket unknown', () => {
  // Mixing recorded and unrecorded buy volume must not produce a number that
  // looks complete — NaN propagating is the correct, visible outcome.
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  const data = makeData(start, 15);
  data[7 * STRIDE + 6] = NaN;

  const [bucket] = aggregate(data, start, start + 15 * MIN, '15m');
  assert.equal(bucket.volume, 150, 'total volume is unaffected');
  assert.ok(Number.isNaN(bucket.buyVolume), 'buy volume is unknown, not partial');
});

test('aggregate withholds a bucket the data does not fully cover', () => {
  // Only 7 of the 15 minutes exist — the 15m bar is still open.
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  const data = makeData(start, 7);

  const closedOnly = aggregate(data, start, start + 15 * MIN, '15m');
  assert.equal(closedOnly.length, 0, 'an unfinished bucket must not reach a strategy');

  const withOpen = aggregate(data, start, start + 15 * MIN, '15m', false);
  assert.equal(withOpen.length, 1, 'the chart may ask for the open bucket');
  assert.equal(withOpen[0].close, 106.5);
});

test('aggregate does not let a bucket peek past the requested end', () => {
  // 30 minutes of data, but the caller asks only up to minute 7.
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  const data = makeData(start, 30);
  const bars = aggregate(data, start, start + 7 * MIN, '15m');
  assert.equal(bars.length, 0, 'the 15m bucket is not closed within the window');
});

test('aggregate starts a new bucket when a gap crosses a boundary', () => {
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  const first = makeData(start, 15);
  const second = makeData(start + 30 * MIN, 15, (i) => 200 + i);
  const data = new Float64Array(first.length + second.length);
  data.set(first);
  data.set(second, first.length);

  const bars = aggregate(data, start, start + 45 * MIN, '15m');
  assert.equal(bars.length, 2, 'the empty 15m window in between produces no bar');
  assert.equal(bars[0].time, start);
  assert.equal(bars[1].time, start + 30 * MIN);
  assert.equal(bars[1].open, 200);
});

test('mergeBars sorts, deduplicates and survives a round trip', async () => {
  await withTempDir(async (dir) => {
    const t0 = Date.UTC(2024, 0, 1);
    const bar = (i, close) => ({
      time: t0 + i * MIN, open: 1, high: 2, low: 0.5, close, volume: 3,
    });

    // Deliberately out of order, with one duplicate timestamp.
    const first = await mergeBars(dir, 'TEST', [bar(2, 20), bar(0, 10), bar(1, 15)]);
    assert.equal(first.total, 3);
    assert.equal(first.added, 3);
    assert.equal(first.first, t0);

    const stored = await readDataset(dir, 'TEST');
    assert.deepEqual(
      [stored[0], stored[STRIDE], stored[2 * STRIDE]],
      [t0, t0 + MIN, t0 + 2 * MIN],
      'stored ascending by time',
    );

    // Re-merging an overlapping range replaces rather than duplicates.
    const second = await mergeBars(dir, 'TEST', [bar(2, 99), bar(3, 30)]);
    assert.equal(second.total, 4, 'one new bar, one replaced');
    assert.equal(second.added, 1);

    const bars = await readBars(dir, 'TEST', '1m', t0, t0 + 10 * MIN);
    assert.equal(bars.length, 4);
    assert.equal(bars[2].close, 99, 'the later write wins on a duplicate timestamp');
  });
});

test('readBars throws instead of returning empty when nothing is stored', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => readBars(dir, 'NOPE', '1m', 0, 1),
      /No local data for NOPE/,
    );
  });
});

test('timeframeMs rejects an unknown timeframe', () => {
  assert.equal(timeframeMs('4h'), 14_400_000);
  assert.throws(() => timeframeMs('7m'), /Unknown timeframe/);
});

test('buy volume survives a store round trip, and an absent one stays unknown', async () => {
  await withTempDir(async (dir) => {
    const t0 = Date.UTC(2024, 0, 1);
    const res = await mergeBars(dir, 'TEST', [
      { time: t0, open: 1, high: 2, low: 1, close: 2, volume: 10, buyVolume: 7 },
      // No buyVolume at all — a CSV import, for instance.
      { time: t0 + MIN, open: 2, high: 3, low: 2, close: 3, volume: 10 },
    ]);
    assert.equal(res.withBuyVolume, 1, 'only one of the two carries a split');

    const bars = await readBars(dir, 'TEST', '1m', t0, t0 + 10 * MIN);
    assert.equal(bars[0].buyVolume, 7);
    assert.ok(Number.isNaN(bars[1].buyVolume), 'unrecorded is NaN, never 0');

    const meta = await readMeta(dir, 'TEST');
    assert.equal(meta.format, FORMAT_VERSION);
    assert.equal(meta.barsWithBuyVolume, 1);
  });
});

test('migrateV1 widens old bars and marks buy volume unknown', () => {
  // v1 layout: [time, o, h, l, c, v] with no seventh value.
  const v1 = new Float64Array([
    1000, 1, 2, 0.5, 1.5, 10,
    2000, 2, 3, 1.5, 2.5, 20,
  ]);
  const v2 = migrateV1(v1);

  assert.equal(v2.length, 2 * STRIDE);
  assert.equal(v2[0], 1000);
  assert.equal(v2[5], 10);
  assert.ok(Number.isNaN(v2[6]), 'buy volume was never recorded in v1');
  assert.equal(v2[STRIDE], 2000);
  assert.equal(v2[STRIDE + 5], 20);
  assert.ok(Number.isNaN(v2[STRIDE + 6]));
});

test('a v1 file on disk is read transparently and rewritten on the next merge', async () => {
  await withTempDir(async (dir) => {
    const t0 = Date.UTC(2024, 0, 1);
    // Write a v1 dataset by hand: stride 6, and a meta without a format field.
    const v1 = new Float64Array([
      t0, 100, 101, 99, 100.5, 12,
      t0 + MIN, 100.5, 102, 100, 101, 15,
    ]);
    await writeFile(path.join(dir, 'OLD-1m.bin'), Buffer.from(v1.buffer));
    await writeFile(path.join(dir, 'OLD-1m.meta.json'), JSON.stringify({
      symbol: 'OLD', timeframe: '1m', count: 2, first: t0, last: t0 + MIN,
      source: 'binance-spot',
    }));

    const bars = await readBars(dir, 'OLD', '1m', t0, t0 + 10 * MIN);
    assert.equal(bars.length, 2, 'old data stays readable');
    assert.equal(bars[0].close, 100.5);
    assert.equal(bars[1].volume, 15);
    assert.ok(Number.isNaN(bars[0].buyVolume));

    // Reading must not have rewritten the file.
    const onDisk = await stat(path.join(dir, 'OLD-1m.bin'));
    assert.equal(onDisk.size, 2 * 6 * 8, 'still v1 on disk after a read');

    // Merging anything upgrades it.
    await mergeBars(dir, 'OLD', [
      { time: t0 + 2 * MIN, open: 101, high: 103, low: 101, close: 102, volume: 20, buyVolume: 11 },
    ]);
    const after = await stat(path.join(dir, 'OLD-1m.bin'));
    assert.equal(after.size, 3 * STRIDE * 8, 'rewritten in the current format');

    const merged = await readBars(dir, 'OLD', '1m', t0, t0 + 10 * MIN);
    assert.equal(merged.length, 3);
    assert.ok(Number.isNaN(merged[0].buyVolume), 'migrated bars stay unknown');
    assert.equal(merged[2].buyVolume, 11, 'new bars carry the split');
  });
});

test('a dataset from a future format is refused with an actionable message', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'FUT-1m.bin'), Buffer.alloc(STRIDE * 8));
    await writeFile(path.join(dir, 'FUT-1m.meta.json'), JSON.stringify({
      symbol: 'FUT', timeframe: '1m', format: 99, count: 1,
    }));
    await assert.rejects(
      () => readDataset(dir, 'FUT'),
      /format v99.*download the history again/s,
    );
  });
});
