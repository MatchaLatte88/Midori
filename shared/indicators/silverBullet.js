/* ICT Silver Bullet — a sweep, a gap, a shift, and a retest, inside one hour.
 *
 * Silver Bullet is a *time* before it is a pattern. Three one-hour windows, all
 * in New York local time, and outside them the setup does not exist however
 * good it looks:
 *
 *   03:00–04:00  London open
 *   10:00–11:00  New York AM — the one most people mean
 *   14:00–15:00  New York PM
 *
 * New York local, not UTC, and read through Intl for the reason sessions.js
 * spells out: the windows have to follow the US clock change rather than drift
 * an hour off it twice a year. Bar times must therefore be milliseconds.
 *
 * The sequence
 * ------------
 * Four things, in this order, and all four are required:
 *
 *   1. sweep   liquidity is taken — a high or a low is run and given back.
 *   2. gap     the reversal is impulsive enough to leave a fair value gap
 *              in the opposite direction.
 *   3. shift   price closes past the body of the last opposing candle before
 *              that gap. For a short: the last bullish candle before a bearish
 *              gap, closed below. This is the market structure shift.
 *   4. entry   price comes back and touches the near edge of the gap.
 *
 * None of these is invented here. The sweep comes from stophunt.js and the gap
 * from fvg.js — the same detectors the chart draws, so a setup can never sit on
 * a level the chart disagrees about. That is the whole reason `shared/` exists.
 *
 * What the shift actually does
 * ----------------------------
 * Measured on a month of BTC 5m: of 1267 bearish gaps, 91% already satisfy the
 * shift on the gap's own confirming bar and 97% within ten bars. That is
 * structural rather than a coincidence — an impulse steep enough to tear a gap
 * has almost always closed past the last candle that opposed it.
 *
 * So the shift confirms; it does not select. The filters that actually decide
 * how many setups exist are the window, the sweep, and `minGapSize`. This is
 * worth knowing before tuning it: loosening the shift will not produce more
 * setups, because it was never what removed them.
 *
 * Three indices, again
 * --------------------
 * The same discipline as everywhere else in `shared/indicators/`. A setup is
 * drawn from the sweep, but nothing about it is knowable until the entry bar:
 *
 *   startIndex  the sweep — where the story starts on the chart. For drawing.
 *   index       the entry bar. The only index a strategy may read.
 *
 * Every ingredient keeps its own confirmation index too (`sweepIndex` is the
 * wick, `sweep.index` was the reclaim), and the chain is assembled from the
 * confirmed ones only. A setup therefore cannot be built out of a gap that was
 * not yet a gap, or a sweep that was not yet a sweep.
 *
 * Outcomes are pessimistic, and that is a limitation
 * --------------------------------------------------
 * Each setup is walked forward to see whether the target or the stop came
 * first. Where one bar touches both, the stop wins — the rule ARCHITECTURE.md
 * calls honest but pessimistic.
 *
 * The engine does better: it resolves such a bar by replaying the minute bars
 * underneath it, and on BTC 1h with tight brackets that changed the outcome of
 * 103 of 1699 trades. This indicator has only the bars the chart is showing, so
 * its `outcome` is an estimate biased against the setup — read it as a sketch,
 * and let the engine settle anything that matters.
 */

import { ZONE_PALETTE, detectFairValueGaps } from './fvg.js';
import { inWindow, localReading, parseClock } from './sessions.js';
import { detectStopHunts } from './stophunt.js';

/** The three windows, in New York local time. */
export const SILVER_BULLET_WINDOWS = [
  { value: 'london', label: 'London', start: '03:00', end: '04:00' },
  { value: 'am', label: 'NY AM', start: '10:00', end: '11:00' },
  { value: 'pm', label: 'NY PM', start: '14:00', end: '15:00' },
];

const ZONE = 'America/New_York';
const SCOPES = ['entry', 'all'];
const SIZE_UNITS = ['percent', 'points'];

/**
 * Silver Bullet setups over the given bars.
 *
 * @param {Array<{time,open,high,low,close}>} bars  ascending, times in ms
 * @param {object} [params]
 * @param {string[]} [params.windows=['london','am','pm']]  which hours count
 * @param {'entry'|'all'} [params.scope='entry']  whether the whole chain must fall in the hour
 * @param {number} [params.strength=2]  swing strength for the sweep
 * @param {number} [params.confirmBars=3]  bars the sweep has to be reclaimed within
 * @param {number} [params.maxSweepToGap=12]  bars the gap may lag the sweep by
 * @param {number} [params.maxGapToEntry=12]  bars the entry may lag the gap by
 * @param {number} [params.minGapSize=0]  smallest gap worth trading
 * @param {'percent'|'points'} [params.minGapSizeUnit='points']
 * @param {number} [params.rrr=2]  target distance as a multiple of the risk
 * @returns {{setups: Array<object>}}
 */
export function detectSilverBullet(bars, params = {}) {
  const {
    windows = ['london', 'am', 'pm'], scope = 'entry', strength = 2, confirmBars = 3,
    maxSweepToGap = 12, maxGapToEntry = 12, minGapSize = 0, minGapSizeUnit = 'points',
    rrr = 2,
  } = params;

  if (!Array.isArray(bars)) throw new Error('detectSilverBullet: bars must be an array');
  if (!Array.isArray(windows)) throw new Error('detectSilverBullet: windows must be an array');
  for (const w of windows) {
    if (!SILVER_BULLET_WINDOWS.some((x) => x.value === w)) {
      throw new Error(`detectSilverBullet: unknown window "${w}". `
        + `Known: ${SILVER_BULLET_WINDOWS.map((x) => x.value).join(', ')}`);
    }
  }
  if (!SCOPES.includes(scope)) throw new Error(`detectSilverBullet: unknown scope "${scope}"`);
  if (!SIZE_UNITS.includes(minGapSizeUnit)) {
    throw new Error(`detectSilverBullet: unknown minGapSizeUnit "${minGapSizeUnit}"`);
  }
  if (!(rrr > 0)) throw new Error(`detectSilverBullet: rrr must be > 0, got ${rrr}`);
  if (!(maxSweepToGap >= 1)) {
    throw new Error(`detectSilverBullet: maxSweepToGap must be >= 1, got ${maxSweepToGap}`);
  }
  if (!(maxGapToEntry >= 1)) {
    throw new Error(`detectSilverBullet: maxGapToEntry must be >= 1, got ${maxGapToEntry}`);
  }
  // No windows is a switched-off indicator, not an error.
  if (windows.length === 0 || bars.length === 0) return { setups: [] };

  const slots = windowSlots(bars, windows);
  /* The sweep needs no hold window here: whether the reclaim survived ten bars
   * later says nothing about a trade that was already entered and resolved. */
  const { hunts } = detectStopHunts(bars, {
    sources: ['swing'], strength, confirmBars, holdBars: 0, show: 'all',
  });
  const { zones } = detectFairValueGaps(bars, {
    show: 'all', minSize: minGapSize, minSizeUnit: minGapSizeUnit,
  });

  const setups = [];
  const taken = new Set();   // one setup per window occurrence — the first that qualifies

  for (const hunt of hunts) {
    const setup = build(bars, hunt, zones, slots, {
      scope, maxSweepToGap, maxGapToEntry, rrr,
    });
    if (!setup) continue;
    if (taken.has(setup.slotKey)) continue;

    taken.add(setup.slotKey);
    resolve(bars, setup);
    setups.push(setup);
  }

  setups.sort((a, b) => a.index - b.index);
  return { setups };
}

/* ─── Windows ───────────────────────────────────────────────────────────── */

/**
 * Which Silver Bullet hour each bar falls in, if any.
 *
 * The key identifies one *occurrence* — a date plus a window — so "the first
 * setup" can mean the first of that morning rather than the first ever. Reading
 * the local date from the same call that reads the clock keeps the two from
 * disagreeing across midnight.
 */
function windowSlots(bars, windows) {
  const active = SILVER_BULLET_WINDOWS
    .filter((w) => windows.includes(w.value))
    .map((w) => ({ ...w, startMin: parseClock(w.start), endMin: parseClock(w.end) }));

  return bars.map((bar) => {
    const { minutes, day } = localReading(bar.time, ZONE);
    for (const w of active) {
      if (inWindow(minutes, w.startMin, w.endMin)) {
        return { name: w.value, label: w.label, key: `${day}:${w.value}` };
      }
    }
    return null;
  });
}

/* ─── The chain ─────────────────────────────────────────────────────────── */

/**
 * The first complete setup this sweep leads to, or null.
 *
 * One sweep can be followed by several gaps, and the first of them need not be
 * the one that works — price may never come back to it, or the structure shift
 * may not land in time. "The first setup that satisfies every rule" therefore
 * means walking the candidates in order and keeping the first whose whole
 * chain closes, not taking the first gap and giving up when it fails.
 */
function build(bars, hunt, zones, slots, opts) {
  /* The gap has to point the same way the sweep does: a high was run, so the
   * trade is short, so the gap is bearish. And it has to be confirmed after
   * the sweep was — the chain is built from confirmed parts only. */
  for (const gap of zones) {
    if (gap.direction !== hunt.direction) continue;
    if (gap.index <= hunt.index) continue;
    if (gap.index - hunt.index > opts.maxSweepToGap) break;   // zones are ordered

    const setup = chain(bars, hunt, gap, slots, opts);
    if (setup) return setup;
  }
  return null;
}

/** One sweep and one gap, carried through to an entry — or null if it breaks. */
function chain(bars, hunt, gap, slots, opts) {
  const { scope, maxGapToEntry, rrr } = opts;

  const shift = findShift(bars, gap, maxGapToEntry);
  if (!shift) return null;

  const entry = findEntry(bars, gap, shift.index, maxGapToEntry);
  if (!entry) return null;

  const slot = slots[entry.index];
  if (!slot) return null;
  if (scope === 'all' && !sameSlot(slots, slot, [hunt.sweepIndex, gap.index, shift.index])) {
    return null;
  }

  /* The stop sits beyond the wick that took the liquidity. If the entry is
   * already past it the setup is upside down and there is no trade in it —
   * which happens when a later gap sits beyond the sweep's own extreme. */
  const stop = hunt.extreme;
  const risk = hunt.direction === 'bear' ? stop - entry.price : entry.price - stop;
  if (!(risk > 0)) return null;

  const target = hunt.direction === 'bear'
    ? entry.price - rrr * risk
    : entry.price + rrr * risk;

  return {
    direction: hunt.direction,
    window: slot.name,
    windowLabel: slot.label,
    slotKey: slot.key,

    // The sweep this grew out of.
    sweepIndex: hunt.sweepIndex,
    sweepTime: hunt.sweepTime,
    sweepLevel: hunt.level,
    sweepExtreme: hunt.extreme,

    // The gap, carried whole so the chart can draw the same box fvg.js would.
    gapTop: gap.top,
    gapBottom: gap.bottom,
    gapStartIndex: gap.startIndex,
    gapIndex: gap.index,

    // The shift, and the candle body it broke.
    mssIndex: shift.index,
    mssTime: bars[shift.index].time,
    mssLevel: shift.level,
    mssRefIndex: shift.refIndex,

    entryIndex: entry.index,
    entryTime: bars[entry.index].time,
    entryPrice: entry.price,
    stop,
    target,
    risk,
    rrr,

    /* Drawn from the sweep, tradable at the entry — the split every zone in
     * this folder keeps, for the reason fvg.js gives at length. */
    startIndex: hunt.sweepIndex,
    startTime: hunt.sweepTime,
    index: entry.index,
    time: bars[entry.index].time,

    outcome: 'open',
    outcomeIndex: null,
    outcomeTime: null,
    barsToOutcome: null,
  };
}

/**
 * The market structure shift: price closing past the body of the last opposing
 * candle before the gap.
 *
 * "Opposing" is what makes this a shift rather than a restatement of the gap.
 * For a bearish setup the reference is the last *bullish* candle — the final
 * push up before the reversal — and closing below its body says that push has
 * been undone. The level is that candle's open, which is the body edge facing
 * the impulse in both directions.
 *
 * Doji are skipped: a candle with no body has no body edge to break.
 */
function findShift(bars, gap, limit) {
  const wantBull = gap.direction === 'bear';

  let refIndex = null;
  for (let j = gap.startIndex - 1; j >= 0; j--) {
    const b = bars[j];
    if (b.close === b.open) continue;
    if (b.close > b.open === wantBull) { refIndex = j; break; }
  }
  if (refIndex == null) return null;

  const level = bars[refIndex].open;
  /* From the gap's confirming bar onwards — that bar is usually the impulse
   * itself and is allowed to be the one that breaks the body. */
  for (let k = gap.index; k < Math.min(bars.length, gap.index + limit + 1); k++) {
    const broke = gap.direction === 'bear' ? bars[k].close < level : bars[k].close > level;
    if (broke) return { index: k, level, refIndex };
  }
  return null;
}

/**
 * The first bar after the shift that touches the near edge of the gap.
 *
 * Near edge, not the middle: the entry is a limit order resting at the boundary
 * price returns to. For a bearish gap that is its bottom — price has to come
 * back *up* to it — and the fill happens at that price however far the bar
 * carries on past it.
 */
function findEntry(bars, gap, from, limit) {
  const edge = gap.direction === 'bear' ? gap.bottom : gap.top;

  for (let i = from + 1; i <= Math.min(bars.length - 1, gap.index + limit); i++) {
    const touched = gap.direction === 'bear' ? bars[i].high >= edge : bars[i].low <= edge;
    if (touched) return { index: i, price: edge };
  }
  return null;
}

/** Whether every given bar sits in the same window occurrence as the entry. */
function sameSlot(slots, slot, indices) {
  return indices.every((i) => slots[i]?.key === slot.key);
}

/**
 * Walks a setup forward to whichever of target and stop came first.
 *
 * Where one bar touches both, the stop wins. See the header: this is the
 * pessimistic rule the engine exists to replace, not a claim about what
 * actually happened inside that bar.
 */
function resolve(bars, setup) {
  const short = setup.direction === 'bear';

  for (let i = setup.entryIndex; i < bars.length; i++) {
    const bar = bars[i];
    const hitStop = short ? bar.high >= setup.stop : bar.low <= setup.stop;
    const hitTarget = short ? bar.low <= setup.target : bar.high >= setup.target;
    if (!hitStop && !hitTarget) continue;

    setup.outcome = hitStop ? 'stop' : 'target';
    setup.outcomeIndex = i;
    setup.outcomeTime = bar.time;
    setup.barsToOutcome = i - setup.entryIndex;
    return;
  }
}

/* ─── Parameter schema ──────────────────────────────────────────────────── */

export const SILVER_BULLET_PARAMS = [
  {
    key: 'windows',
    label: 'Hours',
    type: 'multi',
    default: ['london', 'am', 'pm'],
    hint: 'Which Silver Bullet hours count, in New York local time — 03:00, 10:00 and '
      + '14:00. They follow the US clock change rather than a fixed UTC hour.',
    options: SILVER_BULLET_WINDOWS.map(({ value, label }) => ({ value, label })),
  },
  {
    key: 'scope',
    label: 'Inside the hour',
    type: 'select',
    default: 'entry',
    hint: 'How much of the setup has to fall inside the hour. The entry always does; '
      + '"Everything" also demands the sweep, the gap and the shift, which is far stricter '
      + 'because the sweep often happens before the window opens.',
    options: [
      { value: 'entry', label: 'Entry only' },
      { value: 'all', label: 'Everything' },
    ],
  },
  {
    key: 'strength',
    label: 'Swing strength',
    type: 'number',
    default: 2,
    min: 1,
    max: 50,
    step: 1,
    hint: 'How many bars either side must be lower for a high to count as liquidity worth '
      + 'sweeping. Larger finds fewer and more significant levels.',
  },
  {
    key: 'confirmBars',
    label: 'Reclaim within',
    type: 'number',
    default: 3,
    min: 1,
    max: 100,
    step: 1,
    hint: 'How many bars price has to close back inside the swept level within, counted '
      + 'from the bar that breached it. 1 demands wick through and body back on one candle.',
  },
  {
    key: 'maxSweepToGap',
    label: 'Sweep → gap',
    type: 'number',
    default: 12,
    min: 1,
    max: 200,
    step: 1,
    hint: 'How many bars the gap may lag the sweep by. The two belong to one move, so a '
      + 'gap that shows up much later is a different move that happens to point the same way.',
  },
  {
    key: 'maxGapToEntry',
    label: 'Gap → entry',
    type: 'number',
    default: 12,
    min: 1,
    max: 200,
    step: 1,
    hint: 'How many bars the retest may lag the gap by. A gap price ignores for a long time '
      + 'is no longer the level that was left behind by this move.',
  },
  {
    key: 'minGapSize',
    label: 'Min gap size',
    type: 'number',
    default: 0,
    min: 0,
    max: 1e6,
    step: 0.5,
    hint: 'Ignore gaps thinner than this. A gap too small to hold a stop is not a setup, '
      + 'whatever else lines up around it. 0 keeps every one of them.',
  },
  {
    key: 'minGapSizeUnit',
    label: 'Measured in',
    type: 'select',
    default: 'points',
    hint: 'How to read the minimum size. Points are the raw distance in whatever the '
      + 'instrument is quoted in — what you read off your own chart and size a stop in; '
      + 'percent keeps its meaning as price moves.',
    options: [
      { value: 'points', label: 'Points' },
      { value: 'percent', label: 'Percent' },
    ],
  },
  {
    key: 'rrr',
    label: 'Reward : risk',
    type: 'number',
    default: 2,
    min: 0.1,
    max: 20,
    step: 0.1,
    hint: 'Where the target sits, as a multiple of the distance from entry to stop. The '
      + 'stop itself is always just beyond the wick that took the liquidity.',
  },
  {
    key: 'bullColor',
    label: 'Long',
    type: 'color',
    default: 'candle-up-brd',
    options: ZONE_PALETTE,
    hint: 'Colour for setups that follow a low being swept — sell-side liquidity taken, '
      + 'price expected up.',
  },
  {
    key: 'bearColor',
    label: 'Short',
    type: 'color',
    default: 'candle-down-body',
    options: ZONE_PALETTE,
    hint: 'Colour for setups that follow a high being swept — buy-side liquidity taken, '
      + 'price expected down.',
  },
];
