/* Stop hunts — liquidity taken above a high or below a low, and given back.
 *
 * A stop hunt (also "liquidity grab", "sweep", "stop raid") is price running
 * through a level where stop orders are known to sit, filling them, and then
 * leaving. It is read off three things, in this order:
 *
 *   a level   somewhere stops are resting, and everyone can see it
 *   a breach  price trades beyond that level
 *   a reclaim price comes back and closes on the original side
 *
 * All three are needed. A breach without a reclaim is not a hunt, it is a
 * break — the level gave way and price kept going. That distinction is the
 * whole indicator: the same first two bars belong to both, and only what
 * happens afterwards says which one it was.
 *
 * Why a level is not just any high
 * --------------------------------
 * Stops cluster where a chart is legible. Three kinds of level carry enough of
 * them to be worth hunting, and they are different enough that this file
 * collects each in its own way:
 *
 *   swing    a fractal high or low — `strength` bars on each side are lower
 *            (higher). The universal case; every timeframe has them.
 *   equal    two or more swings at the same price within a tolerance. The
 *            real cluster: one obvious line, stops stacked behind all of it.
 *   session  the high and low of a completed trading session. Few, watched by
 *            everyone, and the reason the Asia range gets run at the London
 *            open.
 *
 * The sources are independent and can be combined; `sources` says which are on.
 *
 * Nothing may be known before it happened
 * ---------------------------------------
 * This is the one place a sweep detector goes quietly wrong, so it is worth
 * being explicit. A fractal high at bar i is not a fractal until `strength`
 * bars to its right have closed lower. At bar i nobody could know it: the next
 * bar might print higher and there would be no swing at all. Handing a
 * strategy that level at bar i lets it trade a line the market had not drawn
 * yet, and the backtest comes back beautiful.
 *
 * Every level therefore carries two indices, the same split fvg.js uses:
 *
 *   formedIndex  where the level sits on the chart. For drawing.
 *   knownIndex   the bar from which it could be acted on. For the engine.
 *
 * A sweep carries three, because it has one more moment than a zone does:
 *
 *   levelIndex   the level's formedIndex — where the line starts
 *   sweepIndex   the bar whose wick took the liquidity
 *   index        the bar that confirmed the reclaim; nothing earlier knew
 *
 * `index` is what a strategy reads, and it is never smaller than sweepIndex.
 * With `confirmBars` above 1 the two genuinely differ, and the gap between
 * them is the number of bars a trader spent not yet knowing.
 *
 * The confirmation window
 * -----------------------
 * `confirmBars` is how many bars price has to come back within, counted from
 * the breaching bar inclusive. So:
 *
 *   1   the breaching bar must itself close back inside. The strict reading —
 *       one candle, wick through, body back. Fewest and cleanest signals.
 *   n   price may close beyond the level for up to n-1 bars before reclaiming.
 *       Catches slower hunts, at the cost of more signals and a confirmation
 *       that arrives later.
 *
 * Past the window without a reclaim, the level is treated as genuinely broken
 * and dropped. It is not liquidity any more — it was spent, in the other
 * direction. This is why a level can only be swept once: the stops behind it
 * filled the first time, and a second run at the same price is running at
 * nothing.
 *
 * A hunt has a lifetime, and it is short
 * --------------------------------------
 * `holdBars` is how long after the reclaim price is still asked to respect the
 * level. Closing back through it inside that window means the reclaim failed —
 * the level broke after all, one leg later. Closing back through it a week
 * later means nothing: markets revisit old prices, and a level that was run in
 * July is not still on trial in August.
 *
 * Without a window it is the second reading that wins, and it swallows almost
 * everything. On a month of BTC 15m, 286 hunts: unbounded, 12 of them survive.
 * At ten bars, 117 do. The gap between those two numbers is not a market
 * effect, it is the definition eating the indicator — the same failure fvg.js
 * documents for inversions, where a retest as mitigation threw away 690 of 718.
 *
 * Ten bars is the default because that is roughly where the split stops moving
 * for the reason it should: of the hunts that do fail, the median fails after
 * six bars and a quarter within one, so a window of ten catches the rejections
 * that were about this level and few that were not.
 *
 * Direction is named after the trade, not the wick
 * ------------------------------------------------
 * A hunt through a *high* takes buy-side liquidity and turns down, so it is
 * `bear`. Through a *low* it is `bull`. This matches how the zones in fvg.js
 * are named — direction is what the level does to price afterwards — and it is
 * the opposite of what the wick did, which is exactly the point of the pattern.
 *
 * Time units are passed through untouched, with one exception: session levels
 * read a wall clock, so `sources` including 'session' needs millisecond bar
 * times, for the reason spelled out at the top of sessions.js.
 */

/* The palette comes from fvg.js rather than a second list: a bearish sweep and
 * a bearish gap are the same reading of the chart and have no business being
 * different colours by default. */
import { ZONE_PALETTE } from './fvg.js';
import { computeSessions } from './sessions.js';

const SOURCES = ['swing', 'equal', 'session'];
const SHOW = ['all', 'active'];

/* Which source wins when two levels are swept by the same bar at the same
 * price. An equal-highs cluster and the individual swings inside it are the
 * same liquidity described twice; reporting both would double every signal the
 * cluster produces. Higher wins. */
const SOURCE_RANK = { equal: 3, session: 2, swing: 1 };

/**
 * Stop hunts over the given bars.
 *
 * @param {Array<{time,open,high,low,close}>} bars ascending
 * @param {object} [params]
 * @param {string[]} [params.sources=['swing']]  which levels to watch
 * @param {number} [params.strength=2]  bars either side of a swing point
 * @param {number} [params.confirmBars=3]  bars price may take to reclaim
 * @param {number} [params.equalTolerance=0.05]  percent two swings may differ by
 * @param {'futures'|'forex'|'custom'} [params.sessionPreset='futures']
 * @param {Array<object>} [params.sessions=[]]  used when sessionPreset is 'custom'
 * @param {number} [params.minWick=0]  percent the wick must clear the level by
 * @param {number} [params.holdBars=10]  bars the reclaim must hold for; 0 = forever
 * @param {'all'|'active'} [params.show='all']  drop hunts price has invalidated
 * @param {number} [params.lookback=0]  only hunts confirmed in the last N bars
 * @returns {{hunts: Array<object>}}
 */
export function detectStopHunts(bars, params = {}) {
  const {
    /* Defaults must stay in step with STOPHUNT_PARAMS at the foot of this
     * file; a test holds the two together. */
    sources = ['swing'], strength = 2, confirmBars = 3, equalTolerance = 0.05,
    sessionPreset = 'futures', sessions = [], minWick = 0, holdBars = 10,
    show = 'all', lookback = 0,
  } = params;

  if (!Array.isArray(bars)) throw new Error('detectStopHunts: bars must be an array');
  if (!Array.isArray(sources)) throw new Error('detectStopHunts: sources must be an array');
  for (const s of sources) {
    if (!SOURCES.includes(s)) {
      throw new Error(`detectStopHunts: unknown source "${s}". Known: ${SOURCES.join(', ')}`);
    }
  }
  if (!SHOW.includes(show)) throw new Error(`detectStopHunts: unknown show "${show}"`);
  if (!(strength >= 1)) throw new Error(`detectStopHunts: strength must be >= 1, got ${strength}`);
  if (!(confirmBars >= 1)) {
    throw new Error(`detectStopHunts: confirmBars must be >= 1, got ${confirmBars}`);
  }
  if (!(holdBars >= 0)) throw new Error(`detectStopHunts: holdBars must be >= 0, got ${holdBars}`);
  // No sources is a switched-off indicator, not an error — the panel allows it.
  if (sources.length === 0 || bars.length === 0) return { hunts: [] };

  const levels = collectLevels(bars, {
    sources, strength, equalTolerance, sessionPreset, sessions,
  });
  const hunts = findSweeps(bars, levels, confirmBars, minWick);
  applyInvalidation(bars, hunts, holdBars);
  return { hunts: report(hunts, bars.length, show, lookback) };
}

/* ─── Levels ────────────────────────────────────────────────────────────── */

/**
 * Every level the chosen sources produce, ordered by the bar they became
 * knowable on — which is the order findSweeps needs to walk them in.
 */
function collectLevels(bars, { sources, strength, equalTolerance, sessionPreset, sessions }) {
  const swings = findSwings(bars, strength);
  const levels = [];

  if (sources.includes('swing')) levels.push(...swings);
  if (sources.includes('equal')) levels.push(...equalLevels(swings, equalTolerance));
  if (sources.includes('session')) levels.push(...sessionLevels(bars, sessionPreset, sessions));

  levels.sort((a, b) => a.knownIndex - b.knownIndex);
  return levels;
}

/**
 * Fractal swing points: a high with `strength` lower highs on each side, and
 * the mirror for lows.
 *
 * Ties count as failures on both sides. Two bars at exactly the same high are
 * not a swing between them — they are the equal-highs case, which is a
 * different level with different stops behind it, and is built separately.
 */
export function findSwings(bars, strength) {
  const out = [];

  for (let i = strength; i < bars.length - strength; i++) {
    let isHigh = true;
    let isLow = true;

    for (let k = 1; k <= strength; k++) {
      const left = bars[i - k];
      const right = bars[i + k];
      if (left.high >= bars[i].high || right.high >= bars[i].high) isHigh = false;
      if (left.low <= bars[i].low || right.low <= bars[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    /* knownIndex is i + strength, never i: the right-hand bars are what make
     * it a swing, and the last of them closes there. See the header. */
    if (isHigh) {
      out.push(level('high', bars[i].high, i, bars[i].time, i + strength, 'swing'));
    }
    if (isLow) {
      out.push(level('low', bars[i].low, i, bars[i].time, i + strength, 'swing'));
    }
  }

  return out;
}

/**
 * Clusters of swings at the same price — equal highs and equal lows.
 *
 * The level is the cluster's extreme, not its average: stops sit beyond the
 * furthest of them, so a run that stopped at the mean would not have filled
 * anything. It is drawn from the first swing in the cluster, because that is
 * where the line starts being visible on a chart, and becomes knowable with
 * the second — one high is not an equal high.
 *
 * A cluster stays open as long as further swings keep landing in tolerance of
 * its extreme, so a triple top is one level of three, not two of two.
 */
export function equalLevels(swings, tolerancePercent) {
  const out = [];

  for (const side of ['high', 'low']) {
    const pts = swings.filter((s) => s.side === side);
    const used = new Array(pts.length).fill(false);

    for (let i = 0; i < pts.length; i++) {
      if (used[i]) continue;
      const members = [pts[i]];
      let extreme = pts[i].price;

      for (let j = i + 1; j < pts.length; j++) {
        if (used[j]) continue;
        if (!withinTolerance(extreme, pts[j].price, tolerancePercent)) continue;
        used[j] = true;
        members.push(pts[j]);
        extreme = side === 'high'
          ? Math.max(extreme, pts[j].price)
          : Math.min(extreme, pts[j].price);
      }

      if (members.length < 2) continue;
      used[i] = true;

      const first = members[0];
      const second = members[1];
      out.push({
        ...level(side, extreme, first.formedIndex, first.formedTime, second.knownIndex, 'equal'),
        // How many swings stacked up here — a triple top is not a double top.
        count: members.length,
      });
    }
  }

  return out;
}

/** Whether two prices are the same level, within a percentage of the first. */
function withinTolerance(a, b, tolerancePercent) {
  if (tolerancePercent <= 0) return a === b;
  // A percentage of nothing cannot be compared against.
  if (!(Math.abs(a) > 0)) return a === b;
  return (Math.abs(a - b) / Math.abs(a)) * 100 <= tolerancePercent;
}

/**
 * The high and low of every completed session in the data.
 *
 * Only completed ones: a session's high is not a level while the session is
 * still making it. The session running at the right edge is therefore skipped,
 * which is right — its extremes are still moving.
 */
export function sessionLevels(bars, preset, custom) {
  const { sessions } = computeSessions(bars, { preset, custom });
  const out = [];
  const lastIndex = bars.length - 1;

  for (const s of sessions) {
    // Still open at the right edge of the data — its extremes are not final.
    if (s.endIndex >= lastIndex) continue;

    const known = s.endIndex + 1;
    out.push({
      ...level('high', s.high, s.startIndex, s.startTime, known, 'session'),
      sessionName: s.name,
    });
    out.push({
      ...level('low', s.low, s.startIndex, s.startTime, known, 'session'),
      sessionName: s.name,
    });
  }

  return out;
}

/** One level, in the shape findSweeps walks. */
function level(side, price, formedIndex, formedTime, knownIndex, source) {
  return { side, price, formedIndex, formedTime, knownIndex, source, count: 1 };
}

/* ─── Sweeps ────────────────────────────────────────────────────────────── */

/**
 * Walks the bars once, holding the levels that are both known and unspent, and
 * closes each one the first time price trades beyond it.
 *
 * A breach opens a window rather than producing a signal, because at the
 * breaching bar the outcome is not yet decided. The window resolves one of two
 * ways and the level is gone either way: reclaimed, and it was a hunt; or run
 * out, and the level genuinely broke.
 */
function findSweeps(bars, levels, confirmBars, minWick) {
  const hunts = [];
  const open = [];     // known, not yet breached
  const pending = [];  // breached, waiting on the reclaim window
  let next = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    /* Pending first: a level breached at an earlier bar can be reclaimed at
     * this one, and resolving those before opening new breaches keeps the two
     * from interleaving on the same bar. */
    for (let k = pending.length - 1; k >= 0; k--) {
      const p = pending[k];
      if (reclaims(p, bar)) {
        pending.splice(k, 1);
        hunts.push(hunt(p, bars, i));
        continue;
      }
      // Window counted from the breaching bar inclusive: 1 means that bar only.
      if (i - p.sweepIndex >= confirmBars - 1) pending.splice(k, 1);
    }

    /* A level becomes available on its knownIndex, never before. Levels are
     * sorted by it, so this walks the array once across the whole loop. */
    while (next < levels.length && levels[next].knownIndex <= i) open.push(levels[next++]);

    for (let k = open.length - 1; k >= 0; k--) {
      const lv = open[k];
      /* A level cannot be swept by a bar that helped form it. A session high
       * is some bar's high, and a swing high is literally bars[formedIndex]'s;
       * without this the level is breached on the bar it came from. */
      if (i <= lv.formedIndex) continue;
      if (!breaches(lv, bar, minWick)) continue;

      open.splice(k, 1);
      const p = {
        ...lv,
        sweepIndex: i,
        sweepTime: bar.time,
        extreme: lv.side === 'high' ? bar.high : bar.low,
      };

      /* The breaching bar gets the first chance to reclaim, whatever the
       * window is: one candle through and back is a hunt under every reading.
       * Only if it does not close back inside does the window open. */
      if (reclaims(p, bar)) hunts.push(hunt(p, bars, i));
      else if (confirmBars > 1) pending.push(p);
    }
  }

  hunts.sort((a, b) => a.index - b.index || a.sweepIndex - b.sweepIndex);
  return dedupe(hunts);
}

/** Whether a bar traded far enough beyond a level to have filled stops. */
function breaches(lv, bar, minWick) {
  if (lv.side === 'high') {
    if (!(bar.high > lv.price)) return false;
    return minWick <= 0 || beyondEnough(bar.high - lv.price, lv.price, minWick);
  }
  if (!(bar.low < lv.price)) return false;
  return minWick <= 0 || beyondEnough(lv.price - bar.low, lv.price, minWick);
}

/* Measured as a percentage of the level, for the reason bigEnough() in fvg.js
 * gives: one threshold has to keep meaning the same thing across instruments
 * and as price moves. */
function beyondEnough(distance, price, minWick) {
  if (!(Math.abs(price) > 0)) return false;
  return (distance / Math.abs(price)) * 100 >= minWick;
}

/** Whether a bar closed back on the level's original side. */
function reclaims(p, bar) {
  return p.side === 'high' ? bar.close < p.price : bar.close > p.price;
}

/** A resolved hunt, in the shape the chart and a strategy both read. */
function hunt(p, bars, confirmIndex) {
  return {
    // Named for what the level does to price now, not for where the wick went.
    direction: p.side === 'high' ? 'bear' : 'bull',
    side: p.side,
    source: p.source,
    level: p.price,
    extreme: p.extreme,
    // How far past the level the wick reached — the depth of the raid.
    depth: Math.abs(p.extreme - p.price),
    count: p.count,
    sessionName: p.sessionName,

    // Where the level sits. `startIndex` mirrors the zone contract in fvg.js.
    levelIndex: p.formedIndex,
    levelTime: p.formedTime,
    startIndex: p.formedIndex,
    startTime: p.formedTime,

    sweepIndex: p.sweepIndex,
    sweepTime: p.sweepTime,

    /* Confirmation. Never earlier than the sweep, and the only index a
     * strategy may read — see the header. */
    index: confirmIndex,
    time: bars[confirmIndex].time,

    invalidatedIndex: null,
    invalidatedTime: null,
  };
}

/**
 * Drops hunts that describe the same liquidity twice.
 *
 * An equal-highs cluster and each swing inside it are one line on the chart,
 * and a bar that runs the cluster runs all of them. Same bar, same side, same
 * price: keep the strongest source and drop the rest.
 */
function dedupe(hunts) {
  const seen = new Map();

  for (const h of hunts) {
    const key = `${h.sweepIndex}:${h.side}:${h.level}`;
    const prev = seen.get(key);
    if (!prev || SOURCE_RANK[h.source] > SOURCE_RANK[prev.source]) seen.set(key, h);
  }

  return hunts.filter((h) => seen.get(`${h.sweepIndex}:${h.side}:${h.level}`) === h);
}

/**
 * Marks each hunt with the bar that proved it wrong, if one did — but only
 * while it is still on trial.
 *
 * A hunt says price rejected a level. Closing back beyond that level says it
 * did not, and `holdBars` is how long that question stays open; see the header
 * for why an unbounded window answers it wrong for almost every hunt. A hunt
 * that survives its window is settled and stops being watched.
 *
 * The hunt still happened either way and its mark still says where, so a
 * failure is annotated rather than deleted; `show` decides whether it stays on
 * the chart.
 */
function applyInvalidation(bars, hunts, holdBars) {
  const live = [];
  let next = 0;

  for (let i = 0; i < bars.length; i++) {
    for (let k = live.length - 1; k >= 0; k--) {
      const h = live[k];
      // Out of its window: it held, and nothing later can take that back.
      if (holdBars > 0 && i - h.index > holdBars) {
        live.splice(k, 1);
        continue;
      }
      const failed = h.side === 'high' ? bars[i].close > h.level : bars[i].close < h.level;
      if (!failed) continue;
      h.invalidatedIndex = i;
      h.invalidatedTime = bars[i].time;
      live.splice(k, 1);
    }
    /* Opening after closing keeps the confirming bar from invalidating itself:
     * it closed back inside by definition, but the next bar need not have. */
    while (next < hunts.length && hunts[next].index <= i) live.push(hunts[next++]);
  }
}

/** The two filters that narrow what is reported without changing what a hunt is. */
function report(hunts, barCount, show, lookback) {
  let out = show === 'all' ? hunts : hunts.filter((h) => h.invalidatedIndex === null);

  // Counted back from the newest bar, so the window survives paging in history.
  if (lookback > 0) {
    const cutoff = barCount - lookback;
    out = out.filter((h) => h.index >= cutoff);
  }
  return out;
}

/* ─── Parameter schema ──────────────────────────────────────────────────── */

export const STOPHUNT_PARAMS = [
  {
    key: 'sources',
    label: 'Hunt',
    type: 'multi',
    default: ['swing'],
    hint: 'Which levels are treated as liquidity. Swing points exist on every '
      + 'chart; equal highs and lows are the real stop clusters and are far rarer; '
      + 'session extremes are the few levels an entire desk is watching.',
    options: [
      { value: 'swing', label: 'Swings' },
      { value: 'equal', label: 'Equal H/L' },
      { value: 'session', label: 'Sessions' },
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
    hint: 'How many bars either side must be lower for a high to count as a swing. '
      + 'Larger finds fewer and more significant levels — and takes that many more '
      + 'bars before one is known, because the right-hand side has to close first.',
  },
  {
    key: 'confirmBars',
    label: 'Reclaim within',
    type: 'number',
    default: 3,
    min: 1,
    max: 100,
    step: 1,
    hint: 'How many bars price has to close back inside within, counted from the bar '
      + 'that breached the level. 1 is the strict reading: wick through and body back '
      + 'on one candle. Higher catches slower hunts and confirms them that much later.',
  },
  {
    key: 'equalTolerance',
    label: 'Equal within',
    type: 'number',
    default: 0.05,
    min: 0,
    max: 10,
    step: 0.01,
    hint: 'How far apart two swings may be and still count as the same level, as a '
      + 'percentage of price. Only used by the Equal H/L source. 0 demands an exact match.',
  },
  {
    key: 'sessionPreset',
    label: 'Sessions',
    type: 'select',
    default: 'futures',
    hint: 'Which set of sessions provides the high and low levels. Only used by the '
      + 'Sessions source, and only for sessions that have already closed.',
    options: [
      { value: 'futures', label: 'Futures' },
      { value: 'forex', label: 'Forex' },
    ],
  },
  {
    key: 'minWick',
    label: 'Min penetration',
    type: 'number',
    default: 0,
    min: 0,
    max: 100,
    step: 0.01,
    hint: 'How far past the level the wick must reach, as a percentage of price. '
      + 'Filters out bars that grazed the level by a tick without reaching the stops '
      + 'behind it. 0 counts any breach.',
  },
  {
    key: 'holdBars',
    label: 'Must hold for',
    type: 'number',
    default: 10,
    min: 0,
    max: 500,
    step: 1,
    hint: 'How many bars after the reclaim price still has to respect the level. '
      + 'Closing back through it inside this window means the hunt failed; doing so '
      + 'long afterwards means nothing. 0 keeps every hunt on trial forever, which '
      + 'marks almost all of them failed.',
  },
  {
    key: 'show',
    label: 'Show',
    type: 'select',
    default: 'all',
    hint: 'Whether hunts price later closed back through stay on the chart. Those are '
      + 'the ones that failed — the reclaim did not hold and the level broke after all.',
    options: [
      { value: 'all', label: 'Including failed' },
      { value: 'active', label: 'Held only' },
    ],
  },
  {
    key: 'lookback',
    label: 'Last bars',
    type: 'number',
    default: 0,
    min: 0,
    max: 5000,
    step: 10,
    hint: 'Only show hunts confirmed within this many of the most recent bars, counted '
      + 'back from the newest one. 0 means no limit.',
  },
  {
    key: 'bullColor',
    label: 'Bull',
    type: 'color',
    default: 'candle-up-brd',
    options: ZONE_PALETTE,
    hint: 'Colour for a low that was run and reclaimed — sell-side liquidity taken, '
      + 'price expected up.',
  },
  {
    key: 'bearColor',
    label: 'Bear',
    type: 'color',
    default: 'candle-down-body',
    options: ZONE_PALETTE,
    hint: 'Colour for a high that was run and reclaimed — buy-side liquidity taken, '
      + 'price expected down.',
  },
];
