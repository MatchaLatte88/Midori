import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeVolumeProfile } from '../shared/indicators/volumeProfile.js';

const MIN = 60_000;

function bar(i, low, high, volume, close = (low + high) / 2) {
  return { time: Date.UTC(2024, 0, 1) + i * MIN, open: low, high, low, close, volume };
}

/** Same bar, but with a recorded aggressive-buy share. */
function barWithBuy(i, low, high, volume, buyVolume, close = (low + high) / 2) {
  return { ...bar(i, low, high, volume, close), buyVolume };
}

test('every unit of volume ends up in a bin', () => {
  // The core invariant: spreading a bar across bins must not create or lose volume.
  const bars = [
    bar(0, 100, 110, 50),
    bar(1, 104, 106, 30),
    bar(2, 99, 120, 20),
  ];
  for (const distribution of ['uniform', 'close', 'ohlc']) {
    const p = computeVolumeProfile(bars, { bins: 37, distribution });
    const sum = p.volumes.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 100) < 1e-9, `${distribution}: binned ${sum}, expected 100`);
    assert.ok(Math.abs(p.totalVolume - 100) < 1e-9);
  }
});

test('uniform spreads a bar proportionally across the levels it spans', () => {
  // One bar spanning exactly the whole range, 10 bins → 10% each.
  const p = computeVolumeProfile([bar(0, 0, 100, 100)], { bins: 10, distribution: 'uniform' });
  for (const v of p.volumes) {
    assert.ok(Math.abs(v - 10) < 1e-9, `expected 10 per bin, got ${v}`);
  }
});

test('close distribution puts everything at the closing price', () => {
  const p = computeVolumeProfile([bar(0, 0, 100, 40, 95)], { bins: 10, distribution: 'close' });
  assert.equal(p.volumes[9], 40, 'the 90-100 bin holds all of it');
  assert.equal(p.volumes[0], 0);
});

test('the POC is the heaviest level and the price sits inside its bin', () => {
  const bars = [
    bar(0, 100, 101, 5),
    bar(1, 105, 106, 90),  // clear winner
    bar(2, 110, 111, 5),
  ];
  const p = computeVolumeProfile(bars, { bins: 11 });

  const heaviest = p.volumes.indexOf(Math.max(...p.volumes));
  assert.equal(p.poc.index, heaviest);
  assert.ok(p.poc.price >= 105 && p.poc.price <= 106,
    `POC price ${p.poc.price} should land in the traded level`);
  assert.equal(p.poc.volume, p.maxBinVolume);
});

test('the value area holds the requested share and contains the POC', () => {
  const bars = Array.from({ length: 200 }, (_, i) => {
    // A rough bell around 105 so the value area is a real subset.
    const centre = 105 + Math.sin(i / 8) * 4;
    return bar(i, centre - 0.5, centre + 0.5, 10);
  });
  const p = computeVolumeProfile(bars, { bins: 100, valueArea: 70 });

  assert.ok(p.valueArea.volume >= p.totalVolume * 0.7,
    'value area must reach the target share');
  assert.ok(p.valueArea.lowIndex <= p.poc.index && p.poc.index <= p.valueArea.highIndex,
    'the POC is by definition inside the value area');
  assert.ok(p.valueArea.low < p.poc.price && p.poc.price < p.valueArea.high);
  assert.ok(p.valueArea.highIndex - p.valueArea.lowIndex < 99,
    'a 70% area should not need every level');
});

test('a 100% value area covers the whole traded range', () => {
  const bars = [bar(0, 100, 110, 10), bar(1, 100, 110, 10)];
  const p = computeVolumeProfile(bars, { bins: 20, valueArea: 100 });
  assert.equal(p.valueArea.lowIndex, 0);
  assert.equal(p.valueArea.highIndex, 19);
});

test('the top price lands in the last bin rather than past the end', () => {
  // An off-by-one here would silently drop the highest level's volume.
  const p = computeVolumeProfile([bar(0, 100, 100, 7, 100)], { bins: 10 });
  const sum = p.volumes.reduce((a, b) => a + b, 0);
  assert.equal(sum, 7);
});

test('a flat range still produces a usable profile', () => {
  // Every bar at one price: the range has no width, which must not divide by zero.
  const bars = [bar(0, 50, 50, 3, 50), bar(1, 50, 50, 4, 50)];
  const p = computeVolumeProfile(bars, { bins: 10 });
  assert.equal(p.totalVolume, 7);
  assert.ok(p.priceMax > p.priceMin, 'the range is padded so bins have height');
  assert.ok(Number.isFinite(p.poc.price));
  assert.ok(Math.abs(p.poc.price - 50) < 1e-3);
});

test('bars with no trades are ignored, not counted as levels', () => {
  const bars = [bar(0, 100, 110, 0), bar(1, 100, 110, 25)];
  const p = computeVolumeProfile(bars, { bins: 10 });
  assert.equal(p.totalVolume, 25);
});

test('no bars, or bars with no volume at all, yields an empty profile', () => {
  const empty = computeVolumeProfile([], { bins: 20 });
  assert.equal(empty.totalVolume, 0);
  assert.equal(empty.poc, null);
  assert.equal(empty.valueArea, null);
  assert.equal(empty.volumes.length, 20);

  const silent = computeVolumeProfile([bar(0, 100, 110, 0)], { bins: 20 });
  assert.equal(silent.totalVolume, 0);
  assert.equal(silent.poc, null);
});

test('an explicit price window clips the profile to it', () => {
  const bars = [bar(0, 0, 100, 100)];
  const p = computeVolumeProfile(bars, { bins: 10, priceMin: 40, priceMax: 60 });
  assert.equal(p.priceMin, 40);
  assert.equal(p.priceMax, 60);
  const sum = p.volumes.reduce((a, b) => a + b, 0);
  assert.ok(sum > 0 && sum < 100, 'volume outside the window is not counted');
});

/* ─── Buy / sell / delta ────────────────────────────────────────────────── */

test('buy and sell split adds back up to the total at every level', () => {
  const bars = [
    barWithBuy(0, 100, 110, 50, 30),
    barWithBuy(1, 104, 106, 30, 10),
  ];
  const p = computeVolumeProfile(bars, { bins: 20 });

  assert.equal(p.hasDelta, true);
  for (let i = 0; i < p.bins; i++) {
    assert.ok(
      Math.abs((p.buyVolumes[i] + p.sellVolumes[i]) - p.volumes[i]) < 1e-9,
      `level ${i}: buy + sell must equal total`,
    );
    assert.ok(
      Math.abs(p.deltas[i] - (p.buyVolumes[i] - p.sellVolumes[i])) < 1e-9,
      `level ${i}: delta must be buy minus sell`,
    );
  }
  assert.ok(Math.abs(p.totalBuyVolume - 40) < 1e-9);
  assert.ok(Math.abs(p.totalSellVolume - 40) < 1e-9);
  assert.ok(Math.abs(p.totalDelta - 0) < 1e-9);
});

test('delta is positive when buyers are the aggressors', () => {
  const p = computeVolumeProfile([barWithBuy(0, 100, 101, 100, 80)], { bins: 10 });
  assert.ok(Math.abs(p.totalBuyVolume - 80) < 1e-9);
  assert.ok(Math.abs(p.totalSellVolume - 20) < 1e-9);
  assert.ok(Math.abs(p.totalDelta - 60) < 1e-9);
  assert.ok(p.maxAbsDelta > 0);
});

test('buy volume is spread with the same weights as total volume', () => {
  // One bar over the whole range: every level gets a tenth of both.
  const p = computeVolumeProfile([barWithBuy(0, 0, 100, 100, 60)], {
    bins: 10, distribution: 'uniform',
  });
  for (let i = 0; i < 10; i++) {
    assert.ok(Math.abs(p.volumes[i] - 10) < 1e-9);
    assert.ok(Math.abs(p.buyVolumes[i] - 6) < 1e-9, `level ${i} buy share`);
    assert.ok(Math.abs(p.deltas[i] - 2) < 1e-9, `level ${i} delta = 6 - 4`);
  }
});

test('data without a split reports no delta instead of an all-sell profile', () => {
  // The dangerous failure: treating "not recorded" as zero buying would draw
  // a fully negative delta and look like heavy selling.
  const p = computeVolumeProfile([bar(0, 100, 110, 50)], { bins: 20 });

  assert.equal(p.hasDelta, false);
  assert.equal(p.deltaCoverage, 0);
  assert.equal(p.totalDelta, null);
  assert.equal(p.totalBuyVolume, null);
  for (let i = 0; i < p.bins; i++) {
    assert.equal(p.sellVolumes[i], 0, 'unknown volume is not counted as sold');
    assert.equal(p.deltas[i], 0);
  }
});

test('a mixed dataset reports the share the split actually covers', () => {
  // Half the volume migrated from v1 (unknown), half freshly downloaded.
  const bars = [
    bar(0, 100, 101, 40),                 // unknown
    barWithBuy(1, 100, 101, 60, 45),      // known
  ];
  const p = computeVolumeProfile(bars, { bins: 10 });

  assert.equal(p.hasDelta, true);
  assert.ok(Math.abs(p.deltaCoverage - 0.6) < 1e-9, 'coverage is 60 of 100');
  assert.ok(Math.abs(p.totalBuyVolume - 45) < 1e-9);
  assert.ok(Math.abs(p.totalSellVolume - 15) < 1e-9, 'only the known part is split');
  assert.ok(Math.abs(p.totalVolume - 100) < 1e-9, 'the total still counts everything');

  // The unknown 40 must not appear on either side of the split.
  let split = 0;
  for (let i = 0; i < p.bins; i++) split += p.buyVolumes[i] + p.sellVolumes[i];
  assert.ok(Math.abs(split - 60) < 1e-9);
});

test('the close and ohlc distributions carry the split too', () => {
  for (const distribution of ['close', 'ohlc']) {
    const p = computeVolumeProfile([barWithBuy(0, 100, 110, 40, 30)], {
      bins: 20, distribution,
    });
    assert.equal(p.hasDelta, true, distribution);
    assert.ok(Math.abs(p.totalBuyVolume - 30) < 1e-9, `${distribution} buy total`);
    assert.ok(Math.abs(p.totalSellVolume - 10) < 1e-9, `${distribution} sell total`);
  }
});

test('invalid options throw instead of being quietly clamped', () => {
  const bars = [bar(0, 100, 110, 10)];
  assert.throws(() => computeVolumeProfile(bars, { bins: 1 }), /bins must be an integer/);
  assert.throws(() => computeVolumeProfile(bars, { bins: 12.5 }), /bins must be an integer/);
  assert.throws(() => computeVolumeProfile(bars, { valueArea: 0 }), /valueArea must be/);
  assert.throws(() => computeVolumeProfile(bars, { valueArea: 101 }), /valueArea must be/);
  assert.throws(() => computeVolumeProfile('nope'), /bars must be an array/);
});
