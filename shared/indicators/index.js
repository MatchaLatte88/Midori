/* Indicators — shared between the chart and the backtest engine.
 *
 * This file lives outside both `src/` and `electron/` on purpose. If the chart
 * drew one SMA and a strategy traded a different one, every backtest result
 * would be a lie that looks correct on screen. There is exactly one
 * implementation, imported by both sides.
 *
 * Contract
 * --------
 * Every indicator is a pure function over the whole bar array:
 *
 *   compute(bars, params) -> { [outputKey]: Array<number|null> }
 *
 * Each output array has the same length as `bars`, with `null` where the
 * indicator is not yet defined (warm-up). Same length means index i always
 * refers to bars[i] — no offset bookkeeping at the call site, and no way for a
 * strategy to accidentally read a value belonging to a different bar.
 *
 * Pure functions over the full array, rather than incremental state, is also
 * what keeps look-ahead impossible to introduce by accident: the engine hands a
 * strategy the slice [0..i], never the tail.
 *
 * Two output shapes
 * -----------------
 * Most indicators are series — one value per bar, as above. A few describe a
 * region of the chart instead: a price band that begins at one bar and ends
 * when price comes back to it. Those declare `kind: 'zones'` and return
 *
 *   compute(bars, params) -> { zones: Array<{ top, bottom, startIndex, index }> }
 *
 * A zone keeps the bar that confirms it apart from the bar it is drawn from,
 * so a strategy can never read a level into existence earlier than the market
 * formed it. Series indicators leave `kind` off — that is the default.
 *
 * `params` is validated by the caller against PARAM_SCHEMA; compute() trusts it.
 */

import {
  FVG_PARAMS, IFVG_PARAMS, detectFairValueGaps, detectInvertedFairValueGaps,
} from './fvg.js';
import { SESSION_PARAMS, checkSession, computeSessions } from './sessions.js';

/** Reusable schema fragment — the UI generates its input fields from this. */
const periodParam = (def, label = 'Period', hint) => ({
  key: 'period',
  label,
  type: 'number',
  default: def,
  min: 1,
  max: 1000,
  step: 1,
  hint: hint ?? 'How many bars go into the window. Larger is smoother and slower '
    + 'to turn; smaller reacts sooner and gives more false turns.',
});

const sourceParam = {
  key: 'source',
  label: 'Source',
  type: 'select',
  default: 'close',
  hint: 'Which price of each bar feeds the calculation. Close is the usual choice; '
    + 'the averaged ones are steadier because a single wick moves them less.',
  options: [
    { value: 'close', label: 'Close' },
    { value: 'open', label: 'Open' },
    { value: 'high', label: 'High' },
    { value: 'low', label: 'Low' },
    { value: 'hl2', label: '(H+L)/2' },
    { value: 'hlc3', label: 'Typical (H+L+C)/3' },
    { value: 'ohlc4', label: '(O+H+L+C)/4' },
  ],
};

/** Extracts the chosen price series from bars. */
export function sourceValues(bars, source = 'close') {
  switch (source) {
    case 'open': return bars.map((b) => b.open);
    case 'high': return bars.map((b) => b.high);
    case 'low': return bars.map((b) => b.low);
    case 'hl2': return bars.map((b) => (b.high + b.low) / 2);
    case 'hlc3': return bars.map((b) => (b.high + b.low + b.close) / 3);
    case 'ohlc4': return bars.map((b) => (b.open + b.high + b.low + b.close) / 4);
    case 'close': return bars.map((b) => b.close);
    default: throw new Error(`Unknown price source: ${source}`);
  }
}

/* ─── Primitives ────────────────────────────────────────────────────────── */

/** Simple moving average over a plain number array. */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1) throw new Error(`sma: period must be >= 1, got ${period}`);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded with the first SMA so it is deterministic. */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1) throw new Error(`ema: period must be >= 1, got ${period}`);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing — the average used by RSI and ATR, not a plain EMA. */
function wilder(values, period) {
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

/* ─── Registry ──────────────────────────────────────────────────────────── */

export const INDICATORS = {
  sma: {
    id: 'sma',
    name: 'Moving Average',
    description: 'Simple moving average of the chosen price source.',
    pane: 'price',
    params: [periodParam(20), sourceParam],
    outputs: [{ key: 'value', label: 'SMA', style: 'line' }],
    compute(bars, { period = 20, source = 'close' } = {}) {
      return { value: sma(sourceValues(bars, source), period) };
    },
  },

  ema: {
    id: 'ema',
    name: 'Exponential MA',
    description: 'Exponential moving average, seeded with the first SMA.',
    pane: 'price',
    params: [periodParam(50), sourceParam],
    outputs: [{ key: 'value', label: 'EMA', style: 'line' }],
    compute(bars, { period = 50, source = 'close' } = {}) {
      return { value: ema(sourceValues(bars, source), period) };
    },
  },

  bbands: {
    id: 'bbands',
    name: 'Bollinger Bands',
    description: 'Moving average with a standard-deviation band on each side.',
    pane: 'price',
    params: [
      periodParam(20),
      {
        key: 'stddev',
        label: 'Std deviations',
        type: 'number',
        default: 2,
        min: 0.1,
        max: 5,
        step: 0.1,
        hint: 'How far each band sits from the basis, measured in standard deviations '
          + 'of the same window. At 2 the bands widen and narrow with volatility.',
      },
      sourceParam,
    ],
    outputs: [
      { key: 'upper', label: 'Upper', style: 'line' },
      { key: 'middle', label: 'Basis', style: 'line' },
      { key: 'lower', label: 'Lower', style: 'line' },
    ],
    compute(bars, { period = 20, stddev = 2, source = 'close' } = {}) {
      const values = sourceValues(bars, source);
      const middle = sma(values, period);
      const upper = new Array(values.length).fill(null);
      const lower = new Array(values.length).fill(null);

      for (let i = period - 1; i < values.length; i++) {
        const mean = middle[i];
        let variance = 0;
        for (let j = i - period + 1; j <= i; j++) {
          const d = values[j] - mean;
          variance += d * d;
        }
        // Population deviation, matching the common charting convention.
        const sd = Math.sqrt(variance / period);
        upper[i] = mean + sd * stddev;
        lower[i] = mean - sd * stddev;
      }
      return { upper, middle, lower };
    },
  },

  rsi: {
    id: 'rsi',
    name: 'RSI',
    description: 'Relative strength index using Wilder smoothing.',
    pane: 'separate',
    scale: { min: 0, max: 100, guides: [30, 50, 70] },
    params: [
      periodParam(14, 'Period', 'How many bars the strength is measured over. '
        + 'Shorter reaches the 30 and 70 lines far more often.'),
      sourceParam,
    ],
    outputs: [{ key: 'value', label: 'RSI', style: 'line' }],
    compute(bars, { period = 14, source = 'close' } = {}) {
      const values = sourceValues(bars, source);
      const gains = new Array(values.length).fill(0);
      const losses = new Array(values.length).fill(0);

      for (let i = 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];
        gains[i] = change > 0 ? change : 0;
        losses[i] = change < 0 ? -change : 0;
      }

      // Drop index 0: it has no change and would bias the first average.
      const avgGain = wilder(gains.slice(1), period);
      const avgLoss = wilder(losses.slice(1), period);
      const out = new Array(values.length).fill(null);

      for (let i = 0; i < avgGain.length; i++) {
        if (avgGain[i] == null) continue;
        const loss = avgLoss[i];
        // No losses in the window means maximum strength, not a division by zero.
        out[i + 1] = loss === 0 ? 100 : 100 - 100 / (1 + avgGain[i] / loss);
      }
      return { value: out };
    },
  },

  atr: {
    id: 'atr',
    name: 'ATR',
    description: 'Average true range — the usual basis for stop distance.',
    pane: 'separate',
    params: [periodParam(14, 'Period', 'How many bars the average range covers. '
      + 'This is the number a stop distance is usually sized against.')],
    outputs: [{ key: 'value', label: 'ATR', style: 'line' }],
    compute(bars, { period = 14 } = {}) {
      const tr = trueRange(bars);
      const smoothed = wilder(tr.slice(1), period);
      const out = new Array(bars.length).fill(null);
      for (let i = 0; i < smoothed.length; i++) out[i + 1] = smoothed[i];
      return { value: out };
    },
  },

  vwap: {
    id: 'vwap',
    name: 'VWAP',
    description: 'Volume-weighted average price, reset at the start of each session.',
    pane: 'price',
    params: [{
      key: 'anchor',
      label: 'Reset',
      type: 'select',
      default: 'day',
      hint: 'When the average starts over. Daily and weekly reset on UTC boundaries, '
        + 'which is the right split for a market that never closes.',
      options: [
        { value: 'day', label: 'Daily' },
        { value: 'week', label: 'Weekly' },
        { value: 'none', label: 'Whole range' },
      ],
    }],
    outputs: [{ key: 'value', label: 'VWAP', style: 'line' }],
    compute(bars, { anchor = 'day' } = {}) {
      const out = new Array(bars.length).fill(null);
      let cumPV = 0;
      let cumV = 0;
      let currentPeriod = null;

      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const period = anchorKey(b.time, anchor);
        if (period !== currentPeriod) {
          currentPeriod = period;
          cumPV = 0;
          cumV = 0;
        }
        const typical = (b.high + b.low + b.close) / 3;
        cumPV += typical * b.volume;
        cumV += b.volume;
        // A bar with no trades leaves VWAP where it was rather than dividing by zero.
        out[i] = cumV > 0 ? cumPV / cumV : (i > 0 ? out[i - 1] : null);
      }
      return { value: out };
    },
  },

  fvg: {
    id: 'fvg',
    name: 'Fair Value Gaps',
    description: 'Three-bar imbalances, kept on the chart until price fills them.',
    pane: 'price',
    kind: 'zones',
    params: FVG_PARAMS,
    outputs: [{ key: 'zones', label: 'FVG', style: 'zone' }],
    compute: detectFairValueGaps,
  },

  ifvg: {
    id: 'ifvg',
    name: 'Inverted FVG',
    description: 'Gaps price broke through, read as the opposite kind of level.',
    pane: 'price',
    kind: 'zones',
    params: IFVG_PARAMS,
    outputs: [{ key: 'zones', label: 'IFVG', style: 'zone' }],
    compute: detectInvertedFairValueGaps,
  },

  sessions: {
    id: 'sessions',
    name: 'Trading sessions',
    description: 'Asia, London and New York — or your own, in their own time zones.',
    pane: 'price',
    kind: 'sessions',
    params: SESSION_PARAMS,
    outputs: [{ key: 'sessions', label: 'Sessions', style: 'zone' }],
    compute: computeSessions,
  },
};

/** UTC period identifier used to reset anchored indicators. */
function anchorKey(timeMs, anchor) {
  if (anchor === 'none') return 'all';
  const d = new Date(timeMs);
  if (anchor === 'week') {
    // ISO-ish: group by the Monday that starts the week.
    const day = (d.getUTCDay() + 6) % 7;
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
    return `w${monday}`;
  }
  return `d${Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())}`;
}

/** Runs an indicator by id with validated params. */
export function computeIndicator(id, bars, params = {}) {
  const spec = INDICATORS[id];
  if (!spec) throw new Error(`Unknown indicator "${id}". Known: ${Object.keys(INDICATORS).join(', ')}`);

  const merged = {};
  for (const p of spec.params) {
    const given = params[p.key];
    if (given === undefined) {
      merged[p.key] = p.default;
      continue;
    }
    if (p.type === 'number') {
      const n = Number(given);
      if (!Number.isFinite(n)) throw new Error(`${id}.${p.key}: "${given}" is not a number`);
      if (p.min !== undefined && n < p.min) throw new Error(`${id}.${p.key}: ${n} is below ${p.min}`);
      if (p.max !== undefined && n > p.max) throw new Error(`${id}.${p.key}: ${n} is above ${p.max}`);
      merged[p.key] = n;
    } else if (p.type === 'sessions') {
      if (!Array.isArray(given)) {
        throw new Error(`${id}.${p.key}: expected a list of sessions`);
      }
      // Validated here rather than in the detector, so a bad entry is refused
      // at the edge with a message naming which one it was.
      given.forEach((session, i) => checkSession(session, `${id}.${p.key}[${i}]`));
      merged[p.key] = given;
    } else if (p.type === 'select' || p.type === 'color') {
      if (!p.options.some((o) => o.value === given)) {
        throw new Error(`${id}.${p.key}: "${given}" is not one of ${p.options.map((o) => o.value).join(', ')}`);
      }
      merged[p.key] = given;
    } else {
      merged[p.key] = given;
    }
  }
  return spec.compute(bars, merged);
}

/** Metadata for the UI, without the compute functions. */
export function indicatorCatalog() {
  return Object.values(INDICATORS).map(({ compute, ...rest }) => rest);
}
