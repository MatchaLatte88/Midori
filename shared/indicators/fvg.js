/* Fair value gaps and their inversions — three-bar imbalances, what price did
 * with them afterwards, and what a broken one turns into.
 *
 * A fair value gap (FVG, also "imbalance") is a stretch of price the market
 * moved through so fast that no two-sided auction happened there. It is read
 * off three consecutive bars:
 *
 *   bullish   bars[i].low  > bars[i-2].high   gap = [high(i-2), low(i)]
 *   bearish   bars[i].high < bars[i-2].low    gap = [high(i),  low(i-2)]
 *
 * The middle bar is the impulse; the gap is the part of its range that the
 * neighbours never traded into.
 *
 * An inverted fair value gap (IFVG) is what is left when price does not respect
 * one. A bullish gap that price closes below has failed as support; the same
 * prices are then read as resistance, and the zone flips direction. Both
 * detectors therefore share one definition of a gap — `findGaps` — because a
 * second one that drifted would put the chart and the engine on different
 * levels for the same market.
 *
 * Two indices, on purpose
 * -----------------------
 * A zone has a shape and a moment it becomes knowable, and they are not always
 * the same bar:
 *
 *   startIndex  where the zone begins on the chart. For drawing.
 *   index       the bar that confirms it. Nothing before this bar could have
 *               known the zone exists.
 *
 * For an FVG those differ: it is drawn from bar i-2 but only confirmed at i.
 * Collapsing the two is how look-ahead gets into a backtest — draw from i-2 and
 * hand a strategy the same number, and it trades a level two bars before that
 * level was formed. The engine reads `index`, the renderer reads `startIndex`,
 * and neither can borrow the other's.
 *
 * An IFVG keeps the same split, and needs it more: it is drawn from the gap it
 * came from — that is where the level is, and where anyone looking for it will
 * look — but it is only confirmed on the bar that breaks the gap, which can be
 * hundreds of bars later. The picture reaches back; what a strategy may act on
 * does not.
 *
 * Mitigation
 * ----------
 * A zone is "mitigated" once price returns into it. How far it has to come back
 * is a genuine disagreement between traders, so it is a parameter rather than a
 * baked-in rule:
 *
 *   touch   price reaches the near edge
 *   ce      price reaches the midpoint — consequent encroachment
 *   full    price crosses the whole zone
 *   break   price CLOSES past the zone — a retest leaves it standing
 *
 * Mitigation is only ever tested on bars after the confirming bar. The bar that
 * creates a zone cannot fill it, however far its own wick runs.
 *
 * Which also settles what "show" should default to. A filled gap is gone: the
 * imbalance no longer exists at any price, so hiding it is right. A broken
 * inversion is not gone, it is *over* — it held from one bar to another, and
 * its box already stops there. Dropping it as well deletes it from the stretch
 * of chart where it applied, which is the only stretch anyone wants to see it
 * on. So an inversion shows everything by default and a gap shows only what is
 * still open.
 *
 * The first three rules end a zone as soon as price returns into it. For a gap
 * that is exactly right — the imbalance has been auctioned away. For an
 * inversion it is backwards: the zone is a level price is expected to come back
 * and react to, so a retest is the reason it is drawn, not its end. Measured on
 * a month of BTC 15m, treating a retest as mitigation threw away 690 of 718
 * inversions, half of them within three bars. 'break' is therefore the default
 * for an inverted gap, and 'full' stays the default for a plain one.
 *
 * Inversion needs a close, by default
 * -----------------------------------
 * A wick through a gap is not the same event as a body through it: one is a
 * failed probe, the other is acceptance. `close` is the usual reading and the
 * default; `wick` is there for anyone who trades the probe.
 *
 * What the parameters do
 * ----------------------
 * `minSize` and `lookback` narrow what is reported without changing what a zone
 * is: too small to be worth trading, or too far back to still matter. Both are
 * useful to a strategy, so both live here.
 *
 * `boxWidth`, `bullColor` and `bearColor` are not. How wide and in what colour
 * the chart paints a rectangle says nothing about the market, so this file
 * validates them through the shared param schema and otherwise ignores them —
 * the renderer is the only reader. The volume profile carries its width the
 * same way.
 *
 * Time units are passed through untouched: this file never interprets
 * `bar.time`, so it works with the millisecond bars the engine holds and the
 * second-based bars the chart holds alike.
 */

const MITIGATIONS = ['touch', 'ce', 'full', 'break'];
const INVERSIONS = ['close', 'wick'];

/**
 * Fair value gaps, with the bar that filled each one.
 *
 * @param {Array<{time,open,high,low,close}>} bars ascending
 * @param {object} [params]
 * @param {'touch'|'ce'|'full'} [params.mitigation='full'] how far price must return
 * @param {number} [params.minSize=0]  smallest gap to report, in percent of its own price
 * @param {'open'|'all'} [params.show='open']  drop mitigated zones, or keep them
 * @param {number} [params.lookback=0]  only zones confirmed within the last N bars; 0 = all
 * @returns {{zones: Array<object>}}
 */
export function detectFairValueGaps(bars, params = {}) {
  const { mitigation = 'full', minSize = 0, show = 'open', lookback = 0 } = params;
  check(bars, 'detectFairValueGaps', mitigation);

  const zones = findGaps(bars, minSize);
  applyMitigation(bars, zones, mitigation);
  return { zones: report(zones, bars.length, show, lookback) };
}

/**
 * Inverted fair value gaps: gaps price broke through, read as the opposite kind
 * of level from the bar that broke them onward.
 *
 * @param {object} [params]
 * @param {'close'|'wick'} [params.inversion='close'] what counts as breaking a gap
 *   — plus every parameter detectFairValueGaps takes, except that mitigation
 *   defaults to 'break' and show to 'all'.
 */
export function detectInvertedFairValueGaps(bars, params = {}) {
  const {
    /* Two defaults differ from a plain gap's, both for the same reason — an
     * inversion is an event with a lifetime, not a standing level. Must stay
     * in step with IFVG_PARAMS below; a test holds the two together. */
    mitigation = 'break', minSize = 0, show = 'all', lookback = 0, inversion = 'close',
  } = params;
  check(bars, 'detectInvertedFairValueGaps', mitigation);
  if (!INVERSIONS.includes(inversion)) {
    throw new Error(`detectInvertedFairValueGaps: unknown inversion "${inversion}"`);
  }

  const zones = invert(bars, findGaps(bars, minSize), inversion);
  applyMitigation(bars, zones, mitigation);
  return { zones: report(zones, bars.length, show, lookback) };
}

function check(bars, name, mitigation) {
  if (!Array.isArray(bars)) throw new Error(`${name}: bars must be an array`);
  if (!MITIGATIONS.includes(mitigation)) {
    throw new Error(`${name}: unknown mitigation "${mitigation}"`);
  }
}

/**
 * Every three-bar gap in the array, in the order they formed, with no opinion
 * about what happened to them afterwards.
 */
function findGaps(bars, minSize) {
  const gaps = [];

  for (let i = 2; i < bars.length; i++) {
    const bar = bars[i];
    const left = bars[i - 2];
    let direction = null;
    let bottom = 0;
    let top = 0;

    if (bar.low > left.high) {
      direction = 'bull';
      bottom = left.high;
      top = bar.low;
    } else if (bar.high < left.low) {
      direction = 'bear';
      bottom = bar.high;
      top = left.low;
    } else {
      continue;
    }

    // Percent of the gap's own price level, so one threshold works for BTC at
    // 100k and for an altcoin at 0.00001.
    if (minSize > 0) {
      const mid = (top + bottom) / 2;
      if (!(mid > 0)) continue;
      if (((top - bottom) / mid) * 100 < minSize) continue;
    }

    gaps.push({
      direction,
      top,
      bottom,
      size: top - bottom,
      startIndex: i - 2,
      startTime: left.time,
      index: i,
      time: bar.time,
      mitigatedIndex: null,
      mitigatedTime: null,
    });
  }

  return gaps;
}

/**
 * Walks the bars once and closes each zone on the first bar after its own that
 * reaches into it. Zones must be ordered by `index`, which both producers are.
 */
function applyMitigation(bars, zones, mitigation) {
  const open = [];
  let next = 0;

  for (let i = 0; i < bars.length; i++) {
    /* Closing runs before opening, which is what keeps a bar from filling the
     * zone it creates. Under 'touch' that would otherwise be the normal case:
     * the near edge of a fresh bullish gap is that bar's own low. */
    for (let k = open.length - 1; k >= 0; k--) {
      const zone = open[k];
      if (!reaches(zone, bars[i], mitigation)) continue;
      zone.mitigatedIndex = i;
      zone.mitigatedTime = bars[i].time;
      open.splice(k, 1);
    }

    while (next < zones.length && zones[next].index <= i) open.push(zones[next++]);
  }
}

/**
 * Turns each gap price broke through into the opposite kind of zone, starting
 * at the bar that broke it.
 */
function invert(bars, gaps, inversion) {
  const inverted = [];
  const pending = [];
  let next = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    for (let k = pending.length - 1; k >= 0; k--) {
      const gap = pending[k];
      if (!breaksThrough(gap, bar, inversion)) continue;
      pending.splice(k, 1);
      inverted.push({
        // The prices are the old gap's; only the reading of them changes.
        direction: gap.direction === 'bull' ? 'bear' : 'bull',
        top: gap.top,
        bottom: gap.bottom,
        size: gap.size,
        /* Drawn from the gap this came from: the level sits where the gap
         * was, and a box that started at the break would leave the prices it
         * describes unmarked. Confirmed at the break, though — see index. */
        startIndex: gap.startIndex,
        startTime: gap.startTime,
        index: i,
        time: bar.time,
        mitigatedIndex: null,
        mitigatedTime: null,
        /* Which gap this came from, so a strategy can tell a fresh inversion
         * from one that took two hundred bars to happen. */
        originIndex: gap.index,
      });
    }

    /* Opening after breaking keeps a gap from inverting on its own confirming
     * bar. That is impossible anyway — a bullish gap closes above its own
     * bottom by construction — but not by accident. */
    while (next < gaps.length && gaps[next].index <= i) pending.push(gaps[next++]);
  }

  return inverted;
}

/** Whether a bar broke clean through a gap, rather than dipping into it. */
function breaksThrough(gap, bar, inversion) {
  if (gap.direction === 'bull') {
    // A bullish gap fails when price gets below it.
    return inversion === 'wick' ? bar.low < gap.bottom : bar.close < gap.bottom;
  }
  return inversion === 'wick' ? bar.high > gap.top : bar.close > gap.top;
}

/** Whether a bar returned far enough into the zone to count as mitigation. */
function reaches(zone, bar, mitigation) {
  /* 'break' is the same test that turns a gap into an inversion, read against
   * this zone's own direction: the zone survives being retested and dies only
   * when price closes past it. The other three rules end a zone the moment
   * price comes back into it, which is what "mitigated" means for a gap — and
   * the opposite of what it means for an inversion, where the retest is the
   * whole point. */
  if (mitigation === 'break') return breaksThrough(zone, bar, 'close');

  if (zone.direction === 'bull') {
    // Price comes back down into a bullish zone.
    const level = mitigation === 'touch' ? zone.top
      : mitigation === 'ce' ? (zone.top + zone.bottom) / 2
        : zone.bottom;
    return bar.low <= level;
  }
  const level = mitigation === 'touch' ? zone.bottom
    : mitigation === 'ce' ? (zone.top + zone.bottom) / 2
      : zone.top;
  return bar.high >= level;
}

/** Applies the two narrowing filters that do not change what a zone is. */
function report(zones, barCount, show, lookback) {
  let out = show === 'all' ? zones : zones.filter((z) => z.mitigatedIndex === null);

  /* Counted back from the newest bar, not from a date: the window has to mean
   * the same thing after older bars are paged in behind it. */
  if (lookback > 0) {
    const cutoff = barCount - lookback;
    out = out.filter((z) => z.index >= cutoff);
  }
  return out;
}

/* ─── Parameter schema ──────────────────────────────────────────────────── */

/* Colours are CSS token names, not hex: the same choice has to work in both
 * themes, and a token is the only thing that does. The two candle tones lead
 * the list because up-is-light / down-is-blue is the direction vocabulary the
 * rest of the chart already speaks. */
export const ZONE_PALETTE = [
  { value: 'candle-up-brd', label: 'Up tone' },
  { value: 'candle-down-body', label: 'Down tone' },
  { value: 'pos', label: 'Green' },
  { value: 'neg', label: 'Red' },
  { value: 'accent', label: 'Midori' },
  { value: 'ind-1', label: 'Amber' },
  { value: 'ind-2', label: 'Violet' },
  { value: 'ind-3', label: 'Pink' },
];

const colorParam = (key, label, def) => ({
  key, label, type: 'color', default: def, options: ZONE_PALETTE,
});

/** The settings both detectors share. */
const commonParams = [
  {
    key: 'mitigation',
    label: 'Filled when',
    type: 'select',
    default: 'full',
    options: [
      { value: 'full', label: 'Fully crossed' },
      { value: 'ce', label: 'Midpoint (CE)' },
      { value: 'touch', label: 'First touch' },
      { value: 'break', label: 'Closed beyond' },
    ],
  },
  {
    key: 'show',
    label: 'Show',
    type: 'select',
    default: 'open',
    options: [
      { value: 'open', label: 'Unfilled only' },
      { value: 'all', label: 'Including filled' },
    ],
  },
  { key: 'minSize', label: 'Min size %', type: 'number', default: 0, min: 0, max: 100, step: 0.05 },
  /* Zero means "no limit" on both of these — the setting is off, rather than
   * set to something. Anything else would need a second control to say so. */
  { key: 'lookback', label: 'Last bars', type: 'number', default: 0, min: 0, max: 5000, step: 10 },
  { key: 'boxWidth', label: 'Box width', type: 'number', default: 0, min: 0, max: 500, step: 1 },
];

export const FVG_PARAMS = [
  ...commonParams,
  colorParam('bullColor', 'Bull', 'candle-up-brd'),
  colorParam('bearColor', 'Bear', 'candle-down-body'),
];

/* An IFVG defaults to indicator colours rather than the candle tones, because
 * the two are most useful on the chart together and have to be told apart at a
 * glance. Neither default is blue (candles) or green (the accent). */
/* Same two controls, different defaults — see the notes above. */
const invertedMitigation = { ...commonParams[0], default: 'break' };
const invertedShow = { ...commonParams[1], default: 'all' };

export const IFVG_PARAMS = [
  {
    key: 'inversion',
    label: 'Broken by',
    type: 'select',
    default: 'close',
    options: [
      { value: 'close', label: 'A close beyond' },
      { value: 'wick', label: 'A wick beyond' },
    ],
  },
  invertedMitigation,
  invertedShow,
  ...commonParams.slice(2),
  colorParam('bullColor', 'Bull', 'ind-2'),
  colorParam('bearColor', 'Bear', 'ind-1'),
];
