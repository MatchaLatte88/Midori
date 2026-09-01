/* True range and Wilder's smoothing — the two pieces every volatility reading
 * in this folder is built from.
 *
 * They lived in index.js while the ATR indicator was their only reader. Ranges
 * need the same number to decide whether a stretch of chart is compressed, and
 * a second implementation is exactly the failure the header of index.js warns
 * about: the chart and a strategy would be measuring the same market against
 * two slightly different volatilities and nothing on screen would say so.
 *
 * Wilder's average, not a plain EMA. It smooths with 1/period rather than
 * 2/(period+1), which is what "ATR(14)" and "RSI(14)" mean everywhere else —
 * an EMA in their place gives numbers that are close enough to look right and
 * wrong enough to disagree with every other chart.
 *
 * Indicator files import from here; nothing here imports an indicator.
 */

/** True range per bar; the first bar has no previous close, so it is null. */
export function trueRange(bars) {
  const out = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prevClose = bars[i - 1].close;
    out[i] = Math.max(
      b.high - b.low,
      Math.abs(b.high - prevClose),
      Math.abs(b.low - prevClose),
    );
  }
  return out;
}

/** Wilder's smoothing — the average used by RSI and ATR, not a plain EMA. */
export function wilder(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Average true range, aligned one-to-one with `bars`.
 *
 * Index 0 holds no true range at all, so the smoothing runs over the tail and
 * the result is shifted back by one — which keeps the promise the whole folder
 * makes, that out[i] belongs to bars[i] and to nothing else.
 *
 * @param {Array<{high,low,close}>} bars ascending
 * @param {number} period
 * @returns {Array<number|null>}
 */
export function atr(bars, period = 14) {
  if (!(period >= 1)) throw new Error(`atr: period must be >= 1, got ${period}`);
  const smoothed = wilder(trueRange(bars).slice(1), period);
  const out = new Array(bars.length).fill(null);
  for (let i = 0; i < smoothed.length; i++) out[i + 1] = smoothed[i];
  return out;
}
