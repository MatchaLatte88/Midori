/* Replay state — the playhead, the account, and the bars they move over.
 *
 * The session itself is `shared/engine/replaySession.js` and knows nothing
 * about Vue, IPC or a clock. This file is the other half: it fetches the bars,
 * drives the timer, and keeps a reactive copy of what the session holds so a
 * template can read it. The split is what lets the rules be tested with twenty
 * bars in an array and no browser.
 *
 * Why the store owns the bars and not the chart
 * ---------------------------------------------
 * Because a replay's window is a different shape from a chart's. The chart
 * loads the newest page and pages backwards as you scroll; a replay loads a
 * stretch of history *around a chosen moment* and then walks forwards through
 * it. Trying to serve both from one paging state meant the chart quietly
 * refetching under a running session — and the session's indices count from
 * the front of its array, so a page arriving at the front would move every
 * trade it had already taken onto a different bar.
 *
 * So while a replay is active the chart draws what is here, and nothing else
 * loads. `bars` only ever grows at the end, which is the one direction that
 * leaves existing indices where they were.
 *
 * Minutes are fetched only when they can matter
 * ----------------------------------------------
 * A bar's minutes decide a fill that touched both the stop and the target. If
 * nothing is pending, there is no fill to decide and the request is skipped —
 * which is most bars of most sessions, and the difference between a step that
 * feels instant and one that waits on a round trip.
 */
import { reactive, readonly } from 'vue';

import { DEFAULT_COSTS } from '../../shared/engine/broker.js';
import { orderFromPlan, sizingEntry, sizingStop } from '../../shared/engine/plannedTrade.js';
import { ReplaySession } from '../../shared/engine/replaySession.js';
import { positionSize } from '../../shared/strategies/risk.js';
import { setError } from './session.js';

/** Bars of history behind the start, so indicators are warm and there is context. */
export const LEAD_BARS = 1500;
/** Bars revealed per forward chunk, before another is fetched. */
export const CHUNK_BARS = 400;
/**
 * The most minutes one sub-bar fetch may ask for.
 *
 * A chunk of 400 daily bars is 576,000 minute bars, which is tens of megabytes
 * across the bridge for a step nobody is waiting on. Chunks shrink on high
 * timeframes instead — which is the right way round, because each of those
 * bars is more time to begin with.
 */
export const MINUTE_BUDGET = 50_000;

/** How fast Play advances, in bars per second. */
export const SPEEDS = [1, 2, 4, 10, 30];

const MINUTE = 60_000;

const state = reactive({
  /** True from the moment a session exists until it is closed. */
  active: false,
  /** '' | 'loading' | 'ready' | 'ended' — what the transport should say. */
  status: '',
  symbol: null,
  timeframe: null,
  stepMs: null,

  /** The whole window, ms times, ascending. Only ever appended to. */
  bars: [],
  /** Bumped whenever `bars` changes identity, so the chart can watch one number. */
  barsVersion: 0,
  /** The playhead: the last closed bar. Everything after it is not visible yet. */
  index: 0,
  /** Where the session began, so the chart can mark it. */
  startIndex: 0,

  playing: false,
  speed: 4,

  /* Reactive copies of what the session holds. The session's own objects are
   * not reactive on purpose — a Proxy around the Broker would be wrapped and
   * unwrapped on every fill for no benefit. */
  account: null,
  position: null,
  orders: [],
  trades: [],

  /** Carried between trades, so sizing does not have to be re-entered. */
  risk: { mode: 'percent', value: 1, maxLeverage: 1 },
  balance: 10_000,
  costs: { ...DEFAULT_COSTS },

  /** Set by the ticket while a price is being picked off the chart. */
  picking: null,     // 'stopLoss' | 'takeProfit' | 'entryPrice' | null
  picked: null,      // { field, price } — consumed by the ticket

  /* Drawings whose planned trade has now been entered, waiting for the chart
   * to remove them. See `enterPlan`. */
  enteredPlans: [],
});

export const replay = readonly(state);

/* The session and the timer live outside the reactive object: one is a class
 * with a Broker in it, the other a handle. Neither renders. */
let session = null;
let timer = null;
/** Guards a step that is still fetching from being started twice. */
let stepping = false;

/**
 * Orders that came from a drawn block, against the drawing that produced them.
 *
 * Keyed by the order *object*, not its id: the Broker mutates the order in
 * place when it fills, so there is nothing to look up — the status is simply
 * there to be read on the next sync.
 *
 * The drawing outlives the order being placed on purpose. Until a resting
 * entry fills, the block is the only thing on the chart showing where its stop
 * and target are going to be — the bracket does not exist as orders yet. Once
 * price actually gets there, the engine draws the position and the plan has
 * been answered, so the drawing goes.
 *
 * An order that is cancelled instead is dropped from here without touching the
 * drawing: nothing was entered, so the plan still stands.
 */
let planDrawings = new Map();

/* ─── Reading the session ───────────────────────────────────────────────── */

/** Copies what the session holds into the reactive mirrors. */
function sync() {
  if (!session) {
    state.account = null;
    state.position = null;
    state.orders = [];
    state.trades = [];
    return;
  }

  const broker = session.broker;
  harvestPlans();
  state.index = session.index;
  state.account = {
    balance: broker.balance,
    equity: broker.equity,
    unrealized: broker.unrealizedPnl,
    initialBalance: broker.initialBalance,
    peakEquity: session.peakEquity,
    maxDrawdown: session.maxDrawdown,
    maxDrawdownPct: session.maxDrawdownPct,
    tradeCount: broker.trades.length,
    resolution: session.resolution,
    progress: session.progress,
  };
  state.position = broker.position
    ? {
      size: broker.position.size,
      entryPrice: broker.position.entryPrice,
      openedAt: broker.position.openedAt,
      stopLoss: broker.position.stopLoss,
      takeProfit: broker.position.takeProfit,
      unrealized: broker.unrealizedPnl,
    }
    : null;
  // Newest first: a pending order is something to act on now, and the one just
  // placed is the one being looked for.
  state.orders = broker.pending.map((o) => ({
    id: o.id, side: o.side, type: o.type, size: o.size,
    limitPrice: o.limitPrice, stopPrice: o.stopPrice, tag: o.tag,
  })).reverse();
  state.trades = [...broker.trades].reverse();
}

/** Moves plans whose entry has filled into the list the chart clears out. */
function harvestPlans() {
  if (planDrawings.size === 0) return;

  for (const [order, drawingId] of planDrawings) {
    if (order.status === 'filled') {
      planDrawings.delete(order);
      if (!state.enteredPlans.includes(drawingId)) state.enteredPlans.push(drawingId);
    } else if (order.status === 'cancelled') {
      // Never entered, so the plan is still a plan. The drawing stays.
      planDrawings.delete(order);
    }
  }
}

/**
 * Takes the drawings whose plan has been entered, and clears the list.
 *
 * Consumed rather than read, like the picked price: leaving them in place
 * would have the chart trying to delete the same drawings on every repaint.
 */
export function takeEnteredPlans() {
  if (state.enteredPlans.length === 0) return [];
  const ids = [...state.enteredPlans];
  state.enteredPlans.length = 0;
  return ids;
}

/** The live session's marks, for the chart. Not reactive — read on repaint. */
export function replayMarks() {
  if (!session) return null;
  const broker = session.broker;
  return {
    index: session.index,
    startIndex: session.startIndex,
    position: broker.position,
    orders: broker.pending,
    lastPrice: broker.lastPrice,
    /* The Broker's own number, so the tag on the chart and the figure in the
     * panel are the same one rather than two computations of it. */
    unrealized: broker.unrealizedPnl,
  };
}

/* ─── Starting and stopping ─────────────────────────────────────────────── */

/** Largest multiple of `step` at or below `time`; the bar a moment falls in. */
function alignDown(time, step) {
  return Math.floor(time / step) * step;
}

/** How many bars one forward chunk may cover, given the minute budget. */
export function chunkSize(stepMs) {
  const minutes = Math.max(1, Math.round(stepMs / MINUTE));
  return Math.max(20, Math.min(CHUNK_BARS, Math.floor(MINUTE_BUDGET / minutes)));
}

async function fetchBars(symbol, timeframe, from, to) {
  return window.midori.data.bars({
    symbol, timeframe, from, to,
    /* Closed bars only. A replay that revealed the bar still forming would be
     * showing a candle that has not happened, which is the same lie as
     * look-ahead wearing different clothes. */
    dropIncomplete: true,
  });
}

/**
 * Loads a window around `from` and puts the playhead on it.
 *
 * @param {object} config
 * @param {string} config.symbol
 * @param {string} config.timeframe
 * @param {number} config.stepMs      one bar, in milliseconds
 * @param {number} config.from        the moment to start replaying from
 * @param {number} config.balance
 * @param {object} config.costs
 */
export async function startReplay({ symbol, timeframe, stepMs, from, balance, costs }) {
  if (!symbol) throw new Error('startReplay: no symbol selected');
  if (!Number.isFinite(from)) throw new Error('startReplay: the start must be a timestamp');
  if (!(balance > 0)) throw new Error('startReplay: the starting balance must be positive');

  stopReplay();

  state.active = true;
  state.status = 'loading';
  state.symbol = symbol;
  state.timeframe = timeframe;
  state.stepMs = stepMs;
  state.balance = balance;
  state.costs = { ...costs };

  try {
    const start = alignDown(from, stepMs);
    const windowFrom = start - LEAD_BARS * stepMs;
    const windowTo = start + chunkSize(stepMs) * stepMs;
    const bars = await fetchBars(symbol, timeframe, windowFrom, windowTo);

    if (bars.length === 0) {
      throw new Error('No bars stored around that date — download this symbol first');
    }

    const firstAfter = bars.findIndex((b) => b.time > start);
    if (firstAfter === -1) {
      throw new Error('That start date is at or past the end of the stored data — '
        + 'there is nothing left to replay forward into');
    }

    /* The last bar at or before the chosen moment. A date that lands in a gap
     * starts on the bar before it rather than refusing: the gap is the market
     * being closed, not the request being wrong. A date that predates the
     * whole dataset starts where the data does — less context to the left than
     * was asked for, which is the honest answer and not a reason to refuse. */
    const startIndex = Math.max(0, firstAfter - 1);

    session = new ReplaySession({
      bars, startIndex, balance, costs, stepMs,
    });

    state.bars = bars;
    state.barsVersion += 1;
    state.startIndex = startIndex;
    state.index = startIndex;
    state.status = 'ready';
    sync();
  } catch (err) {
    state.active = false;
    state.status = '';
    session = null;
    throw err;
  }
}

/** Ends the session and hands the chart back to normal paging. */
export function stopReplay() {
  pause();
  session = null;
  stepping = false;
  forgetMinutes();
  planDrawings = new Map();
  state.enteredPlans.length = 0;
  state.active = false;
  state.status = '';
  state.bars = [];
  state.barsVersion += 1;
  state.index = 0;
  state.startIndex = 0;
  state.picking = null;
  state.picked = null;
  sync();
}

/* ─── Stepping ──────────────────────────────────────────────────────────── */

/* Minutes, kept per chunk rather than per bar.
 *
 * Measured against the stored BTCUSDT dataset: one `data:bars` call costs
 * about 50ms whatever it asks for — fifteen minute bars and fifty thousand
 * both come back in the same time, because the read is dominated by opening
 * the file rather than by the span. Fetching a bar's minutes one bar at a time
 * therefore cost 40ms *per step*, which at ten bars a second is most of the
 * budget and at thirty is hopeless.
 *
 * So the first bar that needs minutes pulls them for the whole forward chunk,
 * and every bar after it reads them out of this map for nothing. The chunk is
 * already sized to stay inside MINUTE_BUDGET, so the fetch cannot grow beyond
 * what that allows.
 *
 * Nothing is fetched until an order is actually pending: with no order there
 * is no fill to decide, which is most bars of most sessions.
 */
let minutes = new Map();
/** The half-open span the map covers, so a gap is a miss and not an absence. */
let minutesFrom = 0;
let minutesTo = 0;

function forgetMinutes() {
  minutes = new Map();
  minutesFrom = 0;
  minutesTo = 0;
}

/** Buckets a stretch of minute bars by the bar of the replay timeframe. */
function bucketMinutes(bars, from, to) {
  const map = new Map();
  for (const bar of bars) {
    const key = from + Math.floor((bar.time - from) / state.stepMs) * state.stepMs;
    const bucket = map.get(key);
    if (bucket) bucket.push(bar);
    else map.set(key, [bar]);
  }
  minutes = map;
  minutesFrom = from;
  minutesTo = to;
}

/** The minutes inside a bar, or null when they cannot change anything. */
async function minutesFor(bar) {
  if (!session) return null;
  // A 1m replay already is the minutes; there is nothing finer to ask for.
  if (state.timeframe === '1m') return null;
  // Nothing pending means nothing can fill, so nothing needs deciding.
  if (session.broker.pending.length === 0) return null;

  if (bar.time < minutesFrom || bar.time >= minutesTo) {
    const from = bar.time;
    const to = from + chunkSize(state.stepMs) * state.stepMs;
    try {
      bucketMinutes(await fetchBars(state.symbol, '1m', from, to), from, to);
    } catch (err) {
      /* Losing the minutes costs precision, not correctness: the Broker falls
       * back to its pessimistic rule and every fill records that it did. Worth
       * surfacing, not worth stopping the session for. */
      forgetMinutes();
      setError(err);
      return null;
    }
  }

  return minutes.get(bar.time) ?? null;
}

/** Fetches the next chunk of bars onto the end of the window. */
async function extendWindow() {
  if (!session) return 0;
  const last = state.bars[state.bars.length - 1].time;
  /* From the next bucket boundary, not from one millisecond later: a request
   * that starts inside a bucket comes back with that whole bucket, so asking
   * from `last + 1` returns the bar that is already here. `extend` would drop
   * it, but a request that has to be corrected afterwards is a request that
   * was wrong. */
  const from = last + state.stepMs;
  const to = from + chunkSize(state.stepMs) * state.stepMs;

  const more = await fetchBars(state.symbol, state.timeframe, from, to);
  const added = session.extend(more);
  if (added > 0) {
    state.bars = session.bars;
    state.barsVersion += 1;
  }
  return added;
}

/**
 * Reveals the next bar.
 *
 * Returns false when there is nothing more stored, which is the end of the
 * replay rather than a failure — the data simply stops there.
 */
export async function stepReplay() {
  if (!session || stepping) return false;
  stepping = true;

  try {
    if (session.atEnd && await extendWindow() === 0) {
      state.status = 'ended';
      pause();
      return false;
    }

    const next = session.bars[session.index + 1];
    session.step(await minutesFor(next));

    state.index = session.index;
    state.status = 'ready';
    sync();
    return true;
  } catch (err) {
    pause();
    setError(err);
    return false;
  } finally {
    stepping = false;
  }
}

/* ─── The transport ─────────────────────────────────────────────────────── */

function tick() {
  if (!state.playing) return;
  stepReplay().then((moved) => {
    if (!moved || !state.playing) return;
    timer = setTimeout(tick, 1000 / state.speed);
  });
}

export function play() {
  if (!session || state.playing) return;
  state.playing = true;
  tick();
}

export function pause() {
  state.playing = false;
  clearTimeout(timer);
  timer = null;
}

export function togglePlay() {
  if (state.playing) pause();
  else play();
}

export function setSpeed(speed) {
  if (!SPEEDS.includes(speed)) {
    throw new Error(`setSpeed: ${speed} is not one of ${SPEEDS.join(', ')}`);
  }
  state.speed = speed;
}

/* ─── Trading ───────────────────────────────────────────────────────────── */

export function setRisk(patch) {
  Object.assign(state.risk, patch);
}

/** Runs an action against the session and refreshes what the panel shows. */
function act(fn) {
  if (!session) throw new Error('There is no replay running');
  try {
    const result = fn(session);
    sync();
    return result;
  } catch (err) {
    setError(err);
    return null;
  }
}

export function marketEntry({ side, size, stopLoss, takeProfit, tag }) {
  return act((s) => (side === 'buy'
    ? s.buy({ size, stopLoss, takeProfit, tag })
    : s.sell({ size, stopLoss, takeProfit, tag })));
}

/**
 * A resting entry — a limit or a stop, waiting for price to come to it.
 *
 * Its stop and target ride along on the order rather than going into the
 * market beside it, and become real orders the moment it fills. Two live
 * orders against a position that does not exist yet would either open a trade
 * the wrong way round or cancel themselves before the entry ever arrived —
 * see Broker._attachBracket.
 */
export function restingEntry({ side, type, size, price, stopLoss, takeProfit, tag }) {
  return act((s) => s.order({
    side,
    type,
    size,
    limitPrice: type === 'limit' ? price : undefined,
    stopPrice: type === 'stop' ? price : undefined,
    bracket: stopLoss == null && takeProfit == null
      ? null
      : {
        ...(stopLoss == null ? {} : { stopLoss }),
        ...(takeProfit == null ? {} : { takeProfit }),
      },
    tag,
  }));
}

/**
 * Turns a drawn position block into an order.
 *
 * The tool already asks for everything an order needs bar the size: where you
 * get in, where you are wrong, where you are done. Retyping those three
 * numbers into a ticket is the moment they get typed wrong, so the block
 * becomes the order directly. What each mode means is in
 * shared/engine/plannedTrade.js; the size comes from the same risk settings
 * the ticket uses, so a trade taken this way and one taken by hand are the
 * same size for the same stop.
 *
 * The drawing it came from is remembered against the order, and removed once
 * that order actually fills — from then on the engine draws the position, and
 * two nearly identical blocks on top of each other would only be confusing.
 * Until then the block stays, because it is the only thing showing where a
 * resting entry's stop and target are going to be.
 *
 * @param {{entry:number, stop:number, target:?number}} plan
 * @param {'market'|'pending'} mode
 * @param {string} [drawingId]  the block this came from, to retire on entry
 */
export function placeFromPlan(plan, mode, drawingId = null) {
  return act((s) => {
    const price = state.bars[state.index]?.close;
    const spec = orderFromPlan(plan, { price, mode });

    const entry = sizingEntry(spec, price);
    const size = positionSize(
      s.broker.equity, entry, sizingStop(spec, entry),
      state.risk.mode, Number(state.risk.value), Number(state.risk.maxLeverage),
    );
    if (!size) {
      throw new Error('This account cannot carry a position at that risk — check the '
        + 'risk settings, or move the stop further from the entry');
    }

    const order = s.order({
      side: spec.side,
      type: spec.type,
      size,
      limitPrice: spec.type === 'limit' ? spec.price : undefined,
      stopPrice: spec.type === 'stop' ? spec.price : undefined,
      bracket: spec.bracket,
      /* Tagged by where it came from, so a stored session can be broken down
       * by whether a trade was drawn first or fired off from the ticket. */
      tag: mode === 'market' ? 'plan' : `plan-${spec.type}`,
    });

    if (drawingId) planDrawings.set(order, drawingId);
    return order;
  });
}

/**
 * Puts a stop and a target on the open position, replacing whatever was there.
 *
 * The target is placed as the stop's sibling so the two cancel each other when
 * one of them fills, exactly as a bracketed market entry does — a position
 * must never be left with a stray order behind it.
 *
 * Like every other order, these are live from the *next* bar. Protection
 * decided after a bar closed cannot have been in the market during it.
 */
export function protectPosition({ stopLoss = null, takeProfit = null }) {
  return act((s) => {
    const position = s.broker.position;
    if (!position) throw new Error('There is no position to protect');
    if (stopLoss == null && takeProfit == null) {
      throw new Error('Give a stop, a target, or both');
    }

    s.cancelAll('stop-loss');
    s.cancelAll('take-profit');

    const size = Math.abs(position.size);
    const exitSide = position.size > 0 ? 'sell' : 'buy';

    const stop = stopLoss == null ? null : s.order({
      side: exitSide, size, type: 'stop', stopPrice: stopLoss,
      reduceOnly: true, tag: 'stop-loss',
    });
    if (takeProfit != null) {
      s.order({
        side: exitSide, size, type: 'limit', limitPrice: takeProfit,
        reduceOnly: true, tag: 'take-profit',
        // Same group as the stop, so whichever fills retires the other.
        parentId: stop?.id ?? null,
      });
    }

    /* Kept on the position too, because that is what the closed trade carries
     * and what a review draws the bracket from. */
    position.stopLoss = stopLoss;
    position.takeProfit = takeProfit;
  });
}

export function closePosition() {
  return act((s) => s.close('manual'));
}

export function cancelOrder(id) {
  return act((s) => s.broker.cancelOrder(id));
}

export function cancelAll() {
  return act((s) => s.cancelAll());
}

/* ─── Picking a price off the chart ─────────────────────────────────────── */

export function pickPrice(field) {
  state.picking = state.picking === field ? null : field;
}

/** Called by the chart when a price is clicked while a field is armed. */
export function deliverPrice(price) {
  if (!state.picking || !Number.isFinite(price)) return;
  state.picked = { field: state.picking, price };
  state.picking = null;
}

/** Takes the picked price and clears it, so it is applied exactly once. */
export function takePicked() {
  const picked = state.picked;
  state.picked = null;
  return picked;
}

/* ─── Storing the session ───────────────────────────────────────────────── */

/**
 * Saves the session as a run, so it lands in the same library as a backtest.
 *
 * The point of doing it at all: a replay stored in the same shape can be put
 * next to a strategy run in the comparison, which is the question a replay is
 * usually asking — did I do better than the rule would have?
 */
export async function saveReplay(note = '') {
  if (!session) throw new Error('There is no replay to save');
  if (session.broker.trades.length === 0) {
    throw new Error('This session took no trades — there is nothing to store');
  }

  const result = session.result();
  return window.midori.replay.save({
    ...result,
    symbol: state.symbol,
    timeframe: state.timeframe,
    note,
  });
}
