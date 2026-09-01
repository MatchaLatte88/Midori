/* Ranges — the stretches where the market stops going anywhere.
 *
 * A range (also "consolidation", "balance", "accumulation") is a run of bars
 * that trades back and forth between two prices instead of travelling. It is
 * the other half of what a chart does: everything in this folder so far
 * detects a *move* — a gap, a sweep, an impulse — and none of them says where
 * the market was simply standing still, which is where most of the day goes.
 *
 * Four things have to hold, and each one removes a different impostor:
 *
 *   length      at least `minBars`. Three quiet candles are not a range.
 *   compression the span is far narrower than the market normally covers in
 *               that many bars. This is the whole indicator; see below.
 *   touches     both edges were reached `minTouches` separate times. Without
 *               it a slow diagonal drift qualifies — it is narrow, it just is
 *               not a range.
 *   an ending   price closes beyond an edge. That is the breakout, and it is
 *               what the range was drawn for.
 *
 * Why a percentage cannot work
 * ----------------------------
 * The obvious definition — "high minus low, under x%" — is the one that makes
 * a range indicator useless, and it is worth showing exactly how badly. On
 * three months of BTC, a 0.3% span over 20 bars marks 77% of the 1m chart and
 * *nothing at all* on 1h. Widen it to 1% and 1m goes to 99% while 1h reaches
 * 11%. There is no threshold in between that works on both: the number is
 * measuring the timeframe, not the market.
 *
 * The fix is to stop measuring price and start measuring price *against how
 * far this market normally travels in the same number of bars*. Over N bars a
 * random walk covers about ATR × √N — the √N is not a fudge, it is how
 * diffusion scales, and it is why 100 bars do not cover ten times what 10 bars
 * cover. So:
 *
 *     compression = height / (ATR × √length)
 *
 * Measured over the same three months, the distribution of that ratio is
 * almost the same number on every timeframe — median 1.21 on 1m, 1.05 on 5m,
 * 0.97 on 15m, 0.97 on 1h, 0.98 on 4h, and the low tail tracks just as
 * closely. One threshold therefore means the same thing everywhere, which is
 * precisely what a percentage could not do.
 *
 * And it settles the question this indicator exists to answer: an hourly range
 * must not appear on a 1m chart. It does not. Of the 24 ranges found on 1h in
 * that window, 0 have a counterpart on 1m — because 1200 minute bars of a
 * one-hour balance cover about what 1200 minute bars normally cover. The range
 * is only compressed relative to hourly bars, and only the hourly chart says
 * so. `maxBars` backs the same rule up bluntly: at 300 bars a chart cannot be
 * covered by a level belonging to a timeframe far above it.
 *
 * Compression is measured against the ATR of the bars *before* the range, not
 * inside it. Inside would be circular — a range compresses its own ATR, so
 * every range would pass. Before is also the right reading: the market arrived
 * here moving at some speed, and then stopped.
 *
 * How one is found
 * ----------------
 * Seed, extend, break.
 *
 *   seed    every position is tested as the start of a `minBars` window. The
 *           earliest one that is compressed enough wins, so the left edge is
 *           the market's, not the scan's.
 *   extend  bar by bar. A bar that only wicks past an edge widens the range —
 *           that is a raid on the edge, and the range survives it. A bar that
 *           *closes* past one ends it. The compression test is re-applied at
 *           every new length, so a range cannot slowly inflate into a trend.
 *   break   the closing bar is reported with its direction. 95% of ranges on
 *           1m and 92% on 15m end this way; the rest widen past the limit
 *           without a clean break, or run to the edge of the data.
 *
 * Ranges never overlap. After one ends the scan resumes past its breakout.
 *
 * Three indices, as everywhere else
 * ---------------------------------
 *   startIndex  the first bar of the range. For drawing.
 *   index       the bar on which all four conditions were first true. The only
 *               index a strategy may read.
 *   endIndex    the last bar inside the range.
 *
 * The edges need the same care and it is easy to miss. `top` and `bottom` are
 * final values, and a range does not have them until it is over — quoting them
 * at `index` would hand a strategy an edge the market had not printed yet. So
 * the edges as they stood on the confirming bar are carried separately, as
 * `confirmTop` and `confirmBottom`, and those are the two prices anything
 * trading in real time is allowed to use. In practice they are nearly the
 * final ones — the height grows by 0% at the median and 7% (1m) to 16% (1h) at
 * the 90th percentile — but "nearly always the same" is not a contract.
 *
 * What is deliberately not here
 * -----------------------------
 * A drift or efficiency filter, which is the first thing anyone reaches for to
 * exclude the slow diagonal. It is redundant: the ranges this file returns
 * already have a Kaufman efficiency ratio of 0.09–0.16 at the median against
 * 0.18 for arbitrary windows of the same length, so length, compression and
 * touches have already removed what it would remove. Adding it would cost a
 * parameter and change almost nothing.
 *
 * Time units are passed through untouched: nothing here reads a calendar off
 * `bar.time`, so millisecond and second bars both work.
 */

import { ZONE_PALETTE } from './fvg.js';
import { atr } from './atr.js';

/**
 * Ranges over the given bars.
 *
 * @param {Array<{time,open,high,low,close}>} bars ascending
 * @param {object} [params]
 * @param {number} [params.minBars=20]  shortest run that may count as a range
 * @param {number} [params.maxBars=300]  longest; the blunt guard against a
 *   higher timeframe's range covering a lower timeframe's chart
 * @param {number} [params.compression=0.6]  height limit as a fraction of ATR × √length
 * @param {number} [params.atrPeriod=14]  window the reference volatility is read over
 * @param {number} [params.minTouches=2]  separate visits each edge needs
 * @param {number} [params.touchZone=15]  percent of the height that counts as an edge
 * @param {number} [params.breakBuffer=0]  percent of the height a close must clear
 * @param {number} [params.lookback=0]  only ranges confirmed in the last N bars
 * @returns {{ranges: Array<object>}}
 */
export function detectRanges(bars, params = {}) {
  const {
    /* Defaults must stay in step with RANGE_PARAMS at the foot of this file;
     * a test holds the two together. */
    minBars = 20, maxBars = 300, compression = 0.6, atrPeriod = 14,
    minTouches = 2, touchZone = 15, breakBuffer = 0, lookback = 0,
  } = params;

  if (!Array.isArray(bars)) throw new Error('detectRanges: bars must be an array');
  if (!(minBars >= 2)) throw new Error(`detectRanges: minBars must be >= 2, got ${minBars}`);
  if (!(maxBars >= minBars)) {
    throw new Error(`detectRanges: maxBars (${maxBars}) must be >= minBars (${minBars})`);
  }
  if (!(compression > 0)) {
    throw new Error(`detectRanges: compression must be > 0, got ${compression}`);
  }
  if (!(atrPeriod >= 1)) throw new Error(`detectRanges: atrPeriod must be >= 1, got ${atrPeriod}`);
  if (!(minTouches >= 1)) {
    throw new Error(`detectRanges: minTouches must be >= 1, got ${minTouches}`);
  }
  if (!(touchZone > 0 && touchZone <= 50)) {
    throw new Error(`detectRanges: touchZone must be in (0, 50], got ${touchZone}`);
  }
  if (!(breakBuffer >= 0)) {
    throw new Error(`detectRanges: breakBuffer must be >= 0, got ${breakBuffer}`);
  }
  if (bars.length === 0) return { ranges: [] };

  const found = scan(bars, {
    minBars,
    maxBars,
    compression,
    atrPeriod,
    minTouches,
    touchZone: touchZone / 100,
    breakBuffer: breakBuffer / 100,
  });
  return { ranges: report(found, bars.length, lookback) };
}

/* ─── The scan ──────────────────────────────────────────────────────────── */

/** Walks the bars once, seeding at every position and extending what holds. */
function scan(bars, opt) {
  const { minBars, maxBars, compression, atrPeriod, minTouches, touchZone, breakBuffer } = opt;
  const volatility = atr(bars, atrPeriod);
  const out = [];

  /* The first bar that has an ATR behind it. Starting at 0 would read a null
   * reference for every seed until the average warms up. */
  let i = atrPeriod + 1;

  while (i + minBars <= bars.length) {
    const reference = volatility[i - 1];
    // No volatility to measure against — a flat patch, or still warming up.
    if (reference == null || !(reference > 0)) { i++; continue; }

    /* The most a range of `n` bars may span. √n because that is how far a
     * random walk gets; see the header. */
    const limit = (n) => compression * reference * Math.sqrt(n);

    let top = -Infinity;
    let bottom = Infinity;
    for (let j = i; j < i + minBars; j++) {
      if (bars[j].high > top) top = bars[j].high;
      if (bars[j].low < bottom) bottom = bars[j].low;
    }
    if (top - bottom > limit(minBars)) { i++; continue; }

    let end = i + minBars - 1;
    let confirmIndex = -1;
    let confirmTop = 0;
    let confirmBottom = 0;

    /* The seed may already be a range. Checked before extending, because the
     * confirming bar is the earliest bar on which all four conditions held —
     * not the earliest one this loop happens to look at. */
    if (hasTouches(bars, i, end, top, bottom, touchZone, minTouches)) {
      confirmIndex = end;
      confirmTop = top;
      confirmBottom = bottom;
    }

    let breakIndex = null;
    let breakDirection = null;

    for (let j = end + 1; j < bars.length && j - i + 1 <= maxBars; j++) {
      const bar = bars[j];
      const pad = (top - bottom) * breakBuffer;

      // A close beyond an edge is the end of the range, whatever the wick did.
      if (bar.close > top + pad) { breakIndex = j; breakDirection = 'up'; break; }
      if (bar.close < bottom - pad) { breakIndex = j; breakDirection = 'down'; break; }

      const nextTop = bar.high > top ? bar.high : top;
      const nextBottom = bar.low < bottom ? bar.low : bottom;
      /* Widened past what this many bars may span. The range ends here, but
       * without a breakout — nothing broke, it just stopped being a range. */
      if (nextTop - nextBottom > limit(j - i + 1)) break;

      top = nextTop;
      bottom = nextBottom;
      end = j;

      /* Only until it is confirmed. Afterwards the count is descriptive, and
       * the edges are allowed to move without putting the range back on trial. */
      if (confirmIndex < 0 && hasTouches(bars, i, end, top, bottom, touchZone, minTouches)) {
        confirmIndex = end;
        confirmTop = top;
        confirmBottom = bottom;
      }
    }

    // Never enough visits to either edge: narrow, but not a range.
    if (confirmIndex < 0) { i++; continue; }

    const visits = countTouches(bars, i, end, top, bottom, touchZone);
    out.push({
      startIndex: i,
      startTime: bars[i].time,
      // The bar that confirmed it; nothing earlier knew this was a range.
      index: confirmIndex,
      time: bars[confirmIndex].time,
      endIndex: end,
      endTime: bars[end].time,
      length: end - i + 1,

      top,
      bottom,
      // The middle — equilibrium, and the line premium and discount split on.
      middle: (top + bottom) / 2,
      height: top - bottom,
      // The edges as they stood on the confirming bar. See the header.
      confirmTop,
      confirmBottom,

      /* How narrow it actually came out, in the units of `compression`. Below
       * the setting by construction, and the lower the tighter. */
      compression: (top - bottom) / (reference * Math.sqrt(end - i + 1)),
      touchesTop: visits.top,
      touchesBottom: visits.bottom,

      breakIndex,
      breakTime: breakIndex == null ? null : bars[breakIndex].time,
      breakDirection,
      /* Where that bar settled. How far past the edge it closed is the only
       * thing about a breakout that is known on the bar itself. */
      breakClose: breakIndex == null ? null : bars[breakIndex].close,
      /* Still running at the right edge of the data. A range that ended by
       * widening is over without a breakout, and is not active. */
      active: breakIndex == null && end === bars.length - 1,
    });

    // Past the breakout, so ranges never overlap.
    i = (breakIndex ?? end) + 1;
  }

  return out;
}

/* ─── Touches ───────────────────────────────────────────────────────────── */

/**
 * Separate visits to each edge.
 *
 * Separate, not bars: price sitting at the top for twenty candles is one visit
 * to the top, not twenty. A visit ends when price leaves the edge zone, so the
 * count is how many times price came *back* — which is what tells a two-sided
 * auction apart from a stretch that merely began and ended in the right places.
 *
 * `zone` is a fraction of the height. At 0.15 the top zone is the upper 15% of
 * the range. Note that one visit to each edge is guaranteed by construction —
 * the edges are the extremes of these very bars — so `minTouches` of 1 is not
 * a filter, and 2 is the first setting that asks for anything.
 */
export function countTouches(bars, from, to, top, bottom, zone) {
  const height = top - bottom;
  const topLine = top - height * zone;
  const bottomLine = bottom + height * zone;
  let atTop = 0;
  let atBottom = 0;
  let inTop = false;
  let inBottom = false;

  for (let i = from; i <= to; i++) {
    const bar = bars[i];
    if (bar.high >= topLine) {
      if (!inTop) { atTop++; inTop = true; }
    } else inTop = false;
    if (bar.low <= bottomLine) {
      if (!inBottom) { atBottom++; inBottom = true; }
    } else inBottom = false;
  }

  return { top: atTop, bottom: atBottom };
}

/** Whether both edges have been visited often enough. */
function hasTouches(bars, from, to, top, bottom, zone, minTouches) {
  const visits = countTouches(bars, from, to, top, bottom, zone);
  return visits.top >= minTouches && visits.bottom >= minTouches;
}

/** The one filter that narrows what is reported without changing what a range is. */
function report(ranges, barCount, lookback) {
  if (lookback <= 0) return ranges;
  // Counted back from the newest bar, so the window survives paging in history.
  const cutoff = barCount - lookback;
  return ranges.filter((r) => r.index >= cutoff);
}

/* ─── Parameter schema ──────────────────────────────────────────────────── */

export const RANGE_PARAMS = [
  {
    key: 'minBars',
    label: 'Min length',
    type: 'number',
    default: 20,
    min: 2,
    max: 1000,
    step: 1,
    hint: 'How many bars a quiet stretch must last before it counts as a range. '
      + 'Counted in bars rather than hours, so the same setting means a proportionate '
      + 'stretch on every timeframe. Lower finds more and shorter consolidations.',
  },
  {
    key: 'maxBars',
    label: 'Max length',
    type: 'number',
    default: 300,
    min: 10,
    max: 5000,
    step: 10,
    hint: 'The longest a range may run. This is the blunt guard against a level that '
      + 'belongs to a much higher timeframe covering the whole chart — an hourly range '
      + 'is 1200 bars on a 1m chart, and is cut off long before it can be drawn.',
  },
  {
    key: 'compression',
    label: 'Compression',
    type: 'number',
    default: 0.6,
    min: 0.05,
    max: 3,
    step: 0.05,
    hint: 'How narrow the span has to be, measured against how far this market normally '
      + 'travels in the same number of bars. 0.6 means at most 60% of that. Because the '
      + 'comparison scales with volatility and length, one setting means the same thing '
      + 'on 1m and on 4h. Lower finds fewer and tighter ranges.',
  },
  {
    key: 'atrPeriod',
    label: 'Volatility over',
    type: 'number',
    default: 14,
    min: 2,
    max: 200,
    step: 1,
    hint: 'How many bars the reference volatility is averaged over. It is read from the '
      + 'bars before a range, never from inside it — inside, a range would be compared '
      + 'against its own calm and every one of them would pass.',
  },
  {
    key: 'minTouches',
    label: 'Touches per side',
    type: 'number',
    default: 2,
    min: 1,
    max: 10,
    step: 1,
    hint: 'How many separate times price has to come back to each edge. This is what '
      + 'separates a two-sided range from a narrow diagonal drift. 1 is no filter at all '
      + '— both edges are touched by definition — and 3 or more is rare.',
  },
  {
    key: 'touchZone',
    label: 'Edge zone',
    type: 'number',
    default: 15,
    min: 1,
    max: 50,
    step: 1,
    hint: 'How close to an edge counts as reaching it, as a percentage of the range '
      + 'height. Price rarely stops at the exact same tick twice, so demanding the '
      + 'extreme itself would find almost no touches.',
  },
  {
    key: 'breakBuffer',
    label: 'Breakout buffer',
    type: 'number',
    default: 0,
    min: 0,
    max: 50,
    step: 1,
    hint: 'How far past an edge a bar must close to end the range, as a percentage of '
      + 'its height. 0 already demands a close beyond the extreme of every bar so far. '
      + 'Raising it keeps ranges alive through false breaks, but they then tend to end '
      + 'by widening instead — at 25% only about a third still end on a clean break.',
  },
  {
    key: 'lookback',
    label: 'Last bars',
    type: 'number',
    default: 0,
    min: 0,
    max: 5000,
    step: 10,
    hint: 'Only show ranges confirmed within this many of the most recent bars, counted '
      + 'back from the newest one. 0 means no limit.',
  },
  {
    key: 'color',
    label: 'Range',
    type: 'color',
    default: 'ind-2',
    options: ZONE_PALETTE,
    hint: 'Colour of the box and its edges. Neutral on purpose: which way a range breaks '
      + 'is not known while it is forming, and colouring it by the outcome would put a '
      + 'reading on the chart that nobody had at the time.',
  },
  {
    key: 'bullColor',
    label: 'Break up',
    type: 'color',
    default: 'candle-up-brd',
    options: ZONE_PALETTE,
    hint: 'Colour of the mark on the bar that closed above the range, and of the arrow '
      + 'that points out of it.',
  },
  {
    key: 'bearColor',
    label: 'Break down',
    type: 'color',
    default: 'candle-down-body',
    options: ZONE_PALETTE,
    hint: 'Colour of the mark on the bar that closed below the range, and of the arrow '
      + 'that points out of it.',
  },
];
