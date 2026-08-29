/* Volume profile — volume traded per price level, rather than per unit of time.
 *
 * Why this lives next to the base-timeframe data
 * ----------------------------------------------
 * A profile is only as good as the resolution of the bars it is built from. A
 * tool that profiles the bars it happens to be displaying gives a coarser
 * answer on a 4h chart than on a 5m one — same market, different POC.
 *
 * Midori always stores 1m bars and always builds the profile from those, no
 * matter what the chart is showing. The displayed timeframe changes the
 * candles, never the profile.
 *
 * Distributing a bar's volume
 * ---------------------------
 * OHLCV bars do not record which price each contract traded at, so the volume
 * has to be spread across the bar's range. With 1m bars that range is small and
 * the error is correspondingly small — the reason the base timeframe matters
 * more here than anywhere else in the app.
 *
 *   uniform  spread evenly across [low, high], weighted by bin overlap (default)
 *   close    all volume at the close price — fast, and what some platforms do
 *   ohlc     a quarter at each of open, high, low, close
 *
 * `uniform` is the honest default: it makes no claim about where inside the
 * minute the trading happened.
 *
 * Buy, sell and delta
 * -------------------
 * When a source reports how much of a bar was bought by the aggressor (Binance
 * does; a plain CSV does not), each level also carries a buy/sell split and
 * their difference — the delta. Buy volume is spread with exactly the same
 * weights as total volume, so the two stay consistent level by level.
 *
 * A bar whose buy volume is unknown carries NaN and is counted in the total but
 * not in the split. `deltaCoverage` reports the share of volume the split
 * actually covers, so a partially migrated dataset states its own limits
 * instead of quietly drawing a wrong delta.
 */

/**
 * @param {Array<{time,open,high,low,close,volume,buyVolume?}>} bars  base-timeframe bars
 * @param {object} [options]
 * @param {number} [options.bins=120]          number of price levels
 * @param {number} [options.valueArea=70]      percent of volume in the value area
 * @param {'uniform'|'close'|'ohlc'} [options.distribution='uniform']
 * @param {number} [options.priceMin]          overrides the range taken from the bars
 * @param {number} [options.priceMax]
 */
export function computeVolumeProfile(bars, options = {}) {
  const {
    bins = 120,
    valueArea = 70,
    distribution = 'uniform',
    priceMin: forcedMin,
    priceMax: forcedMax,
  } = options;

  if (!Array.isArray(bars)) throw new Error('computeVolumeProfile: bars must be an array');
  if (!Number.isInteger(bins) || bins < 2 || bins > 5000) {
    throw new Error(`computeVolumeProfile: bins must be an integer between 2 and 5000, got ${bins}`);
  }
  if (valueArea <= 0 || valueArea > 100) {
    throw new Error(`computeVolumeProfile: valueArea must be in (0, 100], got ${valueArea}`);
  }

  if (bars.length === 0) return emptyProfile(bins);

  let min = forcedMin ?? Infinity;
  let max = forcedMax ?? -Infinity;
  if (forcedMin === undefined || forcedMax === undefined) {
    for (const b of bars) {
      if (b.low < min) min = b.low;
      if (b.high > max) max = b.high;
    }
  }

  // A range with no width (one flat bar) would make every bin zero-height.
  if (!(max > min)) {
    const pad = Math.max(Math.abs(max) * 1e-6, 1e-8);
    min -= pad;
    max += pad;
  }

  const height = (max - min) / bins;
  const volumes = new Float64Array(bins);
  const buyVolumes = new Float64Array(bins);
  /* Volume per level that came from bars reporting a split. Without this,
   * a level fed only by split-less bars (buy = 0 because it was never
   * recorded) would be indistinguishable from a level that genuinely saw no
   * buying — and would be drawn as fully sold. */
  const knownVolumes = new Float64Array(bins);

  const addAt = (price, volume, buyVolume) => {
    // Outside an explicit price window the volume is dropped, not pushed into
    // the edge bin — clamping would invent trading that never happened there.
    if (price < min || price > max) return;
    // The top price belongs to the last bin, not to a bin past the end.
    const idx = Math.min(bins - 1, Math.floor((price - min) / height));
    volumes[idx] += volume;
    if (buyVolume === buyVolume) { // false only for NaN
      buyVolumes[idx] += buyVolume;
      knownVolumes[idx] += volume;
    }
  };

  for (const b of bars) {
    const v = b.volume;
    if (!(v > 0)) continue; // a minute with no trades contributes nothing

    // undefined (a source without the column) is as unknown as NaN.
    const bv = b.buyVolume === undefined ? NaN : b.buyVolume;

    if (distribution === 'close') {
      addAt(b.close, v, bv);
      continue;
    }
    if (distribution === 'ohlc') {
      addAt(b.open, v / 4, bv / 4);
      addAt(b.high, v / 4, bv / 4);
      addAt(b.low, v / 4, bv / 4);
      addAt(b.close, v / 4, bv / 4);
      continue;
    }

    // uniform: split by how much of the bar's own range falls into each bin.
    const barSpan = b.high - b.low;
    if (barSpan <= 0) {
      addAt(b.close, v, bv); // a minute that never moved
      continue;
    }
    if (b.high < min || b.low > max) continue; // entirely outside the window

    const firstBin = Math.min(bins - 1, Math.max(0, Math.floor((Math.max(b.low, min) - min) / height)));
    const lastBin = Math.min(bins - 1, Math.max(0, Math.floor((Math.min(b.high, max) - min) / height)));

    // The share is measured against the bar's full range, so any part of it
    // lying outside the window simply does not arrive.
    const known = bv === bv;
    for (let i = firstBin; i <= lastBin; i++) {
      const binLow = min + i * height;
      const binHigh = binLow + height;
      const overlap = Math.min(b.high, binHigh) - Math.max(b.low, binLow);
      if (overlap <= 0) continue;

      const share = overlap / barSpan;
      volumes[i] += v * share;
      if (known) {
        buyVolumes[i] += bv * share;
        knownVolumes[i] += v * share;
      }
    }
  }

  // The total is what actually landed in the profile — the value area is a
  // share of the visible volume, not of volume that was clipped away.
  let total = 0;
  let totalBuy = 0;
  let knownVolume = 0;
  for (let i = 0; i < bins; i++) {
    total += volumes[i];
    totalBuy += buyVolumes[i];
    knownVolume += knownVolumes[i];
  }

  if (total === 0) return emptyProfile(bins, min, max, height);

  // Point of control: the price level that traded the most.
  let pocIndex = 0;
  for (let i = 1; i < bins; i++) {
    if (volumes[i] > volumes[pocIndex]) pocIndex = i;
  }

  const va = computeValueArea(volumes, pocIndex, total, valueArea);

  // Sell volume and delta are derived, but precomputing them keeps the
  // renderer free of arithmetic in its inner loop.
  const sellVolumes = new Float64Array(bins);
  const deltas = new Float64Array(bins);
  let maxAbsDelta = 0;
  const hasDelta = knownVolume > 0;

  if (hasDelta) {
    for (let i = 0; i < bins; i++) {
      // Sell is the known volume that was not bought by the aggressor. Volume
      // at this level without a split stays out of both sides.
      sellVolumes[i] = Math.max(0, knownVolumes[i] - buyVolumes[i]);
      deltas[i] = buyVolumes[i] - sellVolumes[i];
      const abs = Math.abs(deltas[i]);
      if (abs > maxAbsDelta) maxAbsDelta = abs;
    }
  }

  const totalSell = hasDelta ? Math.max(0, knownVolume - totalBuy) : 0;

  return {
    bins,
    binHeight: height,
    priceMin: min,
    priceMax: max,
    volumes,
    buyVolumes,
    sellVolumes,
    deltas,
    totalVolume: total,
    maxBinVolume: volumes[pocIndex],
    hasDelta,
    /** Share of the profiled volume for which a buy/sell split was available. */
    deltaCoverage: total > 0 ? knownVolume / total : 0,
    totalBuyVolume: hasDelta ? totalBuy : null,
    totalSellVolume: hasDelta ? totalSell : null,
    totalDelta: hasDelta ? totalBuy - totalSell : null,
    maxAbsDelta,
    poc: {
      index: pocIndex,
      price: min + (pocIndex + 0.5) * height,
      volume: volumes[pocIndex],
    },
    valueArea: {
      lowIndex: va.lowIndex,
      highIndex: va.highIndex,
      low: min + va.lowIndex * height,
      high: min + (va.highIndex + 1) * height,
      volume: va.volume,
    },
  };
}

/**
 * Grows a window outward from the POC until it holds the requested share of
 * volume, always taking the heavier neighbour first.
 *
 * This is the single-bin variant. The classic Market Profile method compares
 * pairs of levels on each side; single-bin gives near-identical boundaries on
 * the fine bin counts used here and has no tie-break ambiguity.
 */
function computeValueArea(volumes, pocIndex, total, percent) {
  const target = total * (percent / 100);
  let low = pocIndex;
  let high = pocIndex;
  let acc = volumes[pocIndex];

  while (acc < target && (low > 0 || high < volumes.length - 1)) {
    const below = low > 0 ? volumes[low - 1] : -1;
    const above = high < volumes.length - 1 ? volumes[high + 1] : -1;
    if (above >= below) {
      high += 1;
      acc += volumes[high];
    } else {
      low -= 1;
      acc += volumes[low];
    }
  }

  return { lowIndex: low, highIndex: high, volume: acc };
}

function emptyProfile(bins, min = 0, max = 0, height = 0) {
  return {
    bins,
    binHeight: height,
    priceMin: min,
    priceMax: max,
    volumes: new Float64Array(bins),
    buyVolumes: new Float64Array(bins),
    sellVolumes: new Float64Array(bins),
    deltas: new Float64Array(bins),
    totalVolume: 0,
    maxBinVolume: 0,
    hasDelta: false,
    deltaCoverage: 0,
    totalBuyVolume: null,
    totalSellVolume: null,
    totalDelta: null,
    maxAbsDelta: 0,
    poc: null,
    valueArea: null,
  };
}

/** Parameter schema, so the UI builds its own controls. */
export const VOLUME_PROFILE_PARAMS = [
  {
    key: 'mode',
    label: 'Show',
    type: 'select',
    default: 'total',
    options: [
      { value: 'total', label: 'Total volume' },
      { value: 'buysell', label: 'Buy vs sell' },
      { value: 'delta', label: 'Delta only' },
    ],
  },
  { key: 'bins', label: 'Price levels', type: 'number', default: 120, min: 10, max: 500, step: 10 },
  { key: 'valueArea', label: 'Value area %', type: 'number', default: 70, min: 30, max: 95, step: 5 },
  {
    key: 'distribution',
    label: 'Volume spread',
    type: 'select',
    default: 'uniform',
    options: [
      { value: 'uniform', label: 'Across the bar range' },
      { value: 'close', label: 'At the close' },
      { value: 'ohlc', label: 'Split over O/H/L/C' },
    ],
  },
  { key: 'width', label: 'Width %', type: 'number', default: 30, min: 5, max: 90, step: 5 },
];
