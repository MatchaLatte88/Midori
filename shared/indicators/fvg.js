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
 * Stacked gaps
 * ------------
 * One impulse rarely leaves one gap. A move that runs for five bars leaves a
 * gap under almost every one of them, separated by nothing but the thin strips
 * the wicks did trade. Read one at a time those are five zones; read the way a
 * trader reads them they are one imbalance with a few pinholes in it.
 *
 * `mergeWick` is how wide a traded strip may be before it counts as a real
 * separation. Below it, neighbouring gaps of the same direction become a single
 * zone spanning all of them.
 *
 * Neighbouring in time as well as in price, and that half is not optional. Two
 * gaps that merely happen to sit at the same prices are not one imbalance, they
 * are two, months apart. Measured on a month of BTC 15m: joining by price alone
 * turned 711 gaps into 81 zones, the widest running 2545 bars — one box over
 * most of the chart. Requiring the bar spans to overlap gives 613 zones, the
 * widest 6 bars, which is the picture the eye already sees. So a run breaks as
 * soon as one bar in it leaves no gap of its own. Allowing a bar or two of
 * slack was measured too and buys almost nothing — 85 merges against 83 — which
 * is not worth a second parameter.
 *
 * Merging happens before the size filter, never after: a run of thin gaps that
 * adds up to a tradable zone must not be thrown away one gap at a time before
 * anyone has looked at what they add up to.
 *
 * An inverted gap merges the gaps it is built from, so a stacked zone inverts
 * as a whole — broken when price closes past the outer edge of the run, not
 * past the edge of whichever sliver it crossed first.
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
/* Exported because the FVG drawing tool has a size control of its own, and a
 * control that could offer a unit this file rejects would be a control that
 * throws on click. */
export const SIZE_UNITS = ['percent', 'points'];

/**
 * Fair value gaps, with the bar that filled each one.
 *
 * @param {Array<{time,open,high,low,close}>} bars ascending
 * @param {object} [params]
 * @param {'touch'|'ce'|'full'} [params.mitigation='full'] how far price must return
 * @param {number} [params.minSize=0]  smallest gap to report; 0 = no filter
 * @param {'percent'|'points'} [params.minSizeUnit='percent'] how to read minSize
 * @param {'open'|'all'} [params.show='open']  drop mitigated zones, or keep them
 * @param {number} [params.lookback=0]  only zones confirmed within the last N bars; 0 = all
 * @returns {{zones: Array<object>}}
 */
export function detectFairValueGaps(bars, params = {}) {
  const {
    mitigation = 'full', minSize = 0, minSizeUnit = 'percent', show = 'open', lookback = 0,
    mergeWick = 0,
  } = params;
  check(bars, 'detectFairValueGaps', mitigation, minSizeUnit);

  const zones = gapsFor(bars, { minSize, minSizeUnit, mergeWick });
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
    mitigation = 'break', minSize = 0, minSizeUnit = 'percent', show = 'all',
    lookback = 0, inversion = 'close', mergeWick = 0,
  } = params;
  check(bars, 'detectInvertedFairValueGaps', mitigation, minSizeUnit);
  if (!INVERSIONS.includes(inversion)) {
    throw new Error(`detectInvertedFairValueGaps: unknown inversion "${inversion}"`);
  }

  const zones = invert(bars, gapsFor(bars, { minSize, minSizeUnit, mergeWick }), inversion);
  applyMitigation(bars, zones, mitigation);
  return { zones: report(zones, bars.length, show, lookback) };
}

function check(bars, name, mitigation, minSizeUnit) {
  if (!Array.isArray(bars)) throw new Error(`${name}: bars must be an array`);
  if (!MITIGATIONS.includes(mitigation)) {
    throw new Error(`${name}: unknown mitigation "${mitigation}"`);
  }
  if (!SIZE_UNITS.includes(minSizeUnit)) {
    throw new Error(`${name}: unknown minSizeUnit "${minSizeUnit}"`);
  }
}

/**
 * Every three-bar gap in the array, in the order they formed, with no opinion
 * about what happened to them afterwards.
 */
function findGaps(bars) {
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
 * The gaps both detectors work from: found, stacked ones joined up, then
 * narrowed by size — in that order. Filtering first would drop the slivers a
 * run is made of before anyone had looked at what they add up to.
 */
function gapsFor(bars, { minSize, minSizeUnit, mergeWick }) {
  const gaps = mergeGaps(findGaps(bars), mergeWick, minSizeUnit);
  if (!(minSize > 0)) return gaps;
  return gaps.filter((g) => bigEnough(g.top, g.bottom, minSize, minSizeUnit));
}

/**
 * Joins runs of gaps separated only by strips too thin to count as a
 * separation. Zones that do not merge come back untouched.
 *
 * A run is per direction and has to be unbroken in time: a gap can only extend
 * the run whose bars its own overlap. The moment a bar leaves no gap, the run
 * is finished and the next gap starts a new one — the header has the numbers
 * for what happens without that rule.
 *
 * The merged zone spans every gap in the run, starts where the first one starts
 * and is confirmed where the last one is confirmed. Confirmation has to be the
 * latest of them: nothing could know the extent of the run before its last gap
 * existed, and a strategy handed the earlier index would trade a zone that had
 * not finished forming.
 */
function mergeGaps(gaps, mergeWick, unit) {
  if (!(mergeWick > 0)) return gaps;

  const out = [];
  // The run each direction is currently building, or null.
  const runs = { bull: null, bear: null };

  for (const gap of gaps) {
    const run = runs[gap.direction];
    const strip = run === null ? null : stripBetween(run, gap);
    // Overlapping bar spans, and a strip between them thinner than the setting.
    const joins = run !== null
      && gap.startIndex <= run.index
      && !bigEnough(strip.top, strip.bottom, mergeWick, unit);

    if (!joins) {
      // A copy: the caller's gaps are not ours to grow.
      const fresh = { ...gap };
      runs[gap.direction] = fresh;
      out.push(fresh);
      continue;
    }

    run.top = Math.max(run.top, gap.top);
    run.bottom = Math.min(run.bottom, gap.bottom);
    run.size = run.top - run.bottom;
    if (gap.startIndex < run.startIndex) {
      run.startIndex = gap.startIndex;
      run.startTime = gap.startTime;
    }
    if (gap.index > run.index) {
      run.index = gap.index;
      run.time = gap.time;
    }
  }

  /* Runs of the two directions interleave, so extending one can leave the array
   * out of order — and both applyMitigation and invert walk it expecting to
   * meet zones in the order they were confirmed. */
  return out.sort((a, b) => a.index - b.index);
}

/**
 * The traded strip between two zones: the stretch of price that lies between
 * them and did therefore change hands. Empty when they overlap or touch, since
 * then there is nothing between them at all.
 */
function stripBetween(a, b) {
  if (a.bottom > b.top) return { top: a.bottom, bottom: b.top };
  if (b.bottom > a.top) return { top: b.bottom, bottom: a.top };
  /* A percentage still needs a real price to measure against, so an empty strip
   * sits at the edge the two share rather than at zero. */
  const price = Math.max(a.bottom, b.bottom);
  return { top: price, bottom: price };
}

/**
 * Whether a gap clears the minimum size, in whichever unit was asked for.
 *
 * Percent measures against the gap's own price level, so one threshold works
 * for BTC at 100k and for an altcoin at 0.00001 — and keeps meaning the same
 * thing as price moves. Points measure the raw distance in whatever the
 * instrument is quoted in, which is what someone reads off their own chart and
 * what a fixed stop is sized in. Neither is right for every market, hence both.
 */
function bigEnough(top, bottom, minSize, minSizeUnit) {
  const height = top - bottom;
  if (minSizeUnit === 'points') return height >= minSize;

  const mid = (top + bottom) / 2;
  // A percentage of nothing is not a filter that can be applied.
  if (!(mid > 0)) return false;
  return (height / mid) * 100 >= minSize;
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
  { value: 'accent', label: 'Midorii' },
  { value: 'ind-1', label: 'Amber' },
  { value: 'ind-2', label: 'Violet' },
  { value: 'ind-3', label: 'Pink' },
];

const colorParam = (key, label, def, hint) => ({
  key, label, type: 'color', default: def, options: ZONE_PALETTE, hint,
});

/** The settings both detectors share. */
const commonParams = [
  {
    key: 'mitigation',
    label: 'Filled when',
    type: 'select',
    default: 'full',
    hint: 'How far price has to come back before the zone counts as used up. '
      + 'The first three end it as soon as price reaches into it; "Closed beyond" '
      + 'needs a bar to close past it, so a retest leaves the zone standing.',
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
    hint: 'Whether zones that are already filled stay on the chart. Their box '
      + 'stops where they ended, so they mark the stretch on which they applied '
      + 'rather than running on to the right edge.',
    options: [
      { value: 'open', label: 'Unfilled only' },
      { value: 'all', label: 'Including filled' },
    ],
  },
  /* One value, two readings. The bound has to cover both, so it is wide enough
   * for a points figure on an index; the unit says how to read it. */
  {
    key: 'minSize',
    label: 'Min size',
    type: 'number',
    default: 0,
    min: 0,
    max: 1e6,
    step: 0.05,
    hint: 'Ignore zones thinner than this. 0 keeps every one of them.',
  },
  {
    key: 'minSizeUnit',
    label: 'Measured in',
    type: 'select',
    default: 'percent',
    hint: 'How to read the two sizes it sits between. Percent measures against the '
      + 'price level the zone sits at, so it keeps meaning the same as price moves; '
      + 'points measure the raw distance in whatever the instrument is quoted in.',
    options: [
      { value: 'percent', label: 'Percent' },
      { value: 'points', label: 'Points' },
    ],
  },
  /* Zero is off here too, which does cost one reading — "join only gaps that
   * already touch". That case is worth 1 merge in 711 on a month of BTC 15m,
   * and anyone who wants it can ask for a tiny value. Cheaper than a second
   * control whose only job is to tell off apart from zero. */
  {
    key: 'mergeWick',
    label: 'Merge across',
    type: 'number',
    default: 0,
    min: 0,
    max: 1e6,
    step: 0.01,
    hint: 'Treat gaps stacked on top of each other as one zone, as long as the '
      + 'traded strip between them is no wider than this and their bars run '
      + 'together. Read in the same unit as the minimum size. 0 keeps every gap '
      + 'separate.',
  },
  /* Zero means "no limit" on both of these — the setting is off, rather than
   * set to something. Anything else would need a second control to say so. */
  {
    key: 'lookback',
    label: 'Last bars',
    type: 'number',
    default: 0,
    min: 0,
    max: 5000,
    step: 10,
    hint: 'Only show zones confirmed within this many of the most recent bars, '
      + 'counted back from the newest one. 0 means no limit.',
  },
  {
    key: 'boxWidth',
    label: 'Box width',
    type: 'number',
    default: 0,
    min: 0,
    max: 500,
    step: 1,
    hint: 'How many bars wide the box is drawn, counted from the bars that formed '
      + 'the gap. 0 runs it on to the right edge until something ends it.',
  },
];

export const FVG_PARAMS = [
  ...commonParams,
  colorParam('bullColor', 'Bull', 'candle-up-brd',
    'Colour for gaps left behind by a move up, which sit below price as support.'),
  colorParam('bearColor', 'Bear', 'candle-down-body',
    'Colour for gaps left behind by a move down, which sit above price as resistance.'),
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
    hint: 'What counts as breaking a gap, and so as flipping it. A close beyond '
      + 'the gap is acceptance of those prices; a wick through it is a probe that '
      + 'was rejected.',
    options: [
      { value: 'close', label: 'A close beyond' },
      { value: 'wick', label: 'A wick beyond' },
    ],
  },
  invertedMitigation,
  invertedShow,
  ...commonParams.slice(2),
  colorParam('bullColor', 'Bull', 'ind-2',
    'Colour for bearish gaps that failed and now read as support.'),
  colorParam('bearColor', 'Bear', 'ind-1',
    'Colour for bullish gaps that failed and now read as resistance.'),
];
