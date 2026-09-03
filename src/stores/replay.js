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
import { openPanel, setError } from './session.js';

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

/**
 * How long one bar of each timeframe is.
 *
 * Here rather than in the component that asks for a switch, because the store
 * is what has to turn a timeframe into a window and a clock, and a caller that
 * had to supply the duration could supply the wrong one.
 */
export const TIMEFRAME_MS = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

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
  /**
   * The playhead as an instant: where the revealed history ends.
   *
   * The index means something only against the current bars, and those are
   * replaced whenever the timeframe changes. This is the same moment on every
   * timeframe, so it is what the transport shows and what a jump aims at.
   */
  clock: null,
  /** Where the session began, so the chart can mark it. */
  startIndex: 0,

  playing: false,
  speed: 4,
  /** Finished trades stay on the chart — see `setShowClosedTrades`. */
  showClosedTrades: true,

  /* Reactive copies of what the session holds. The session's own objects are
   * not reactive on purpose — a Proxy around the Broker would be wrapped and
   * unwrapped on every fill for no benefit. */
  account: null,
  /** Every open position, oldest first. */
  positions: [],
  /**
   * The one the ticket and the chart's handles act on.
   *
   * With more than one position open, "the stop" is ambiguous — so one of them
   * is the one being worked on, and it is the one most recently opened or
   * clicked. Everything that is not aimed at a particular position lands here,
   * which is what makes dragging a level off the block mean something when
   * three blocks are on the chart.
   */
  activePositionId: null,
  /** The active position, or null. Kept for everything that predates the list. */
  position: null,
  orders: [],
  trades: [],

  /** Carried between trades, so sizing does not have to be re-entered. */
  risk: { mode: 'percent', value: 1, maxLeverage: 1 },
  balance: 10_000,
  costs: { ...DEFAULT_COSTS },

  /* The size the chart's quick bar sends, in base units.
   *
   * Null until one is typed, and that is the point: a size carried over from a
   * setup that is already over is the one mistake here that costs money, and a
   * default would be exactly that with nobody having chosen it. It lives in the
   * store rather than in the bar so that leaving the view and coming back does
   * not silently empty a field that was about to be used. */
  quickSize: null,

  /**
   * The stored session this one was picked up from, or last put down as.
   *
   * So that putting the same afternoon down twice leaves one entry rather than
   * a trail of them, and the name it was saved under is still its name.
   */
  savedSessionId: null,

  /**
   * What the whole account has at stake, rather than what each trade does.
   *
   * `risk` sums what the open stops would cost if every one of them filled;
   * `unprotected` counts the positions that have no stop, and they are counted
   * rather than added in. A position without a stop does not risk nothing, it
   * risks an amount nobody knows — folding a zero into the sum would report
   * the most dangerous account on the screen as the safest.
   */
  exposure: { risk: 0, unprotected: 0, netSize: 0 },

  /**
   * Which face of the left panel is showing.
   *
   * 'trade' is the manager for whichever position is active, and it is where
   * clicking a block on the chart lands: the thing you point at is the thing
   * the panel then talks about. 'ticket' opens a new one, 'session' is the
   * account and the ways of putting the afternoon down.
   */
  panelTab: 'trade',

  /**
   * Which face of the dock under the chart is showing.
   *
   * Separate from `panelTab` on purpose: opening the trade manager from a row
   * in the dock must not also change what the dock itself is listing, or
   * clicking "Manage" would take the row you clicked out from under the
   * pointer.
   */
  dockTab: 'positions',

  /**
   * A finished trade the history is pointing at, by its place in the list.
   *
   * `focused` survives until something else is clicked and pulls the chart to
   * the trade; `hovered` lasts as long as the pointer and only lights it up.
   * Two of them because pointing at a row to read it and choosing to go there
   * are different intentions, and one that scrolled the chart on hover would
   * make the list unreadable.
   */
  focusedTrade: null,
  hoveredTrade: null,

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
/** The same, for a timeframe switch: two at once would race on the window. */
let switching = false;
/** The newest position id this session has seen — see `sync`. */
let lastSeenPositionId = 0;

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
    state.positions = [];
    state.position = null;
    state.activePositionId = null;
    state.orders = [];
    state.trades = [];
    state.exposure = { risk: 0, unprotected: 0, netSize: 0 };
    state.focusedTrade = null;
    state.hoveredTrade = null;
    return;
  }

  const broker = session.broker;
  harvestPlans();
  state.index = session.index;
  state.clock = session.clock;
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
  state.positions = broker.positions.map((p) => ({
    id: p.id,
    size: p.size,
    entryPrice: p.entryPrice,
    openedAt: p.openedAt,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    trailing: p.trailing ? { ...p.trailing } : null,
    unrealized: broker.positionPnl(p),
    ...positionRisk(p),
  }));

  state.exposure = {
    /* What every stop in the market would come to together if all of them
     * filled, as a cost. Summed signed, so a position whose stop is past
     * break-even pays into it rather than adding to it — which is what would
     * actually happen to the account. */
    risk: state.positions.reduce((sum, p) => sum - (p.stopResult ?? 0), 0),
    unprotected: state.positions.filter((p) => p.stopResult == null).length,
    netSize: broker.netSize,
  };

  /* The active one follows what is open.
   *
   * A position that has just been opened becomes it: the next thing anyone
   * does after entering is put a stop on, and having to select the trade you
   * just took first would be a step nobody would understand the reason for.
   * Ids only climb, so "newer than anything seen" is the whole test.
   *
   * One that has closed cannot stay active either, or the chart's handles
   * would go on pointing at a trade that is over. */
  const newest = broker.positions[broker.positions.length - 1];
  if (newest && newest.id > lastSeenPositionId) {
    lastSeenPositionId = newest.id;
    state.activePositionId = newest.id;
  }
  if (!state.positions.some((p) => p.id === state.activePositionId)) {
    state.activePositionId = state.positions.length > 0
      ? state.positions[state.positions.length - 1].id
      : null;
    /* Nothing left to manage, so the panel stops offering to. A tab that is
     * lit but empty is worse than one that has stepped aside — and what a
     * person does after the last position closes is look for the next entry,
     * which is the face this moves to. */
    if (state.activePositionId === null && state.panelTab === 'trade') {
      state.panelTab = 'ticket';
  state.dockTab = 'positions';
    }
  }
  state.position = state.positions.find((p) => p.id === state.activePositionId) ?? null;
  // Newest first: a pending order is something to act on now, and the one just
  // placed is the one being looked for.
  state.orders = broker.pending.map((o) => ({
    id: o.id, side: o.side, type: o.type, size: o.size,
    limitPrice: o.limitPrice, stopPrice: o.stopPrice, tag: o.tag,
    positionId: o.positionId,
    /* Copied so the chart can refuse a drag that would drop a resting entry on
     * the far side of its own stop. Shallow, because the Broker never mutates
     * a bracket in place — it places the real orders and forgets it. */
    bracket: o.bracket ? { ...o.bracket } : null,
  })).reverse();
  /* Newest first for reading, but each one remembers where it sits in the
   * book it came from — that index is the only handle a trade has, and the
   * chart needs one to answer "this row, that line". */
  state.trades = broker.trades.map((t, n) => ({ ...t, n })).reverse();

  // A trade cannot be pointed at once the session it belongs to has moved on
  // past the end of the list — which only happens on a restore.
  if (state.focusedTrade != null && state.focusedTrade >= broker.trades.length) {
    state.focusedTrade = null;
  }
}

/**
 * What a position stands to lose, and how far in front it is in those units.
 *
 * Two different numbers that look like one, and keeping them apart is the
 * whole of this function.
 *
 * `stopResult` is what the stop that is in the market right now would come to
 * if it filled — net, so the fee already paid on the way in and the cost of
 * getting back out are both in it. Signed, because a stop is not always a
 * loss: past break-even it locks something in. `risk` is the part of that the
 * account can still lose, which is nothing once the stop is that far. Both
 * change every time the stop moves, which is the point of them.
 *
 * `rMultiple` and `targetR` are measured against `riskPerUnit` — what the trade
 * risked per unit the first time it had a stop at all, recorded once by the
 * Broker and never moved. Measuring R against the current stop instead is the
 * mistake that makes R useless exactly when it is being used: pull the stop to
 * break-even and the denominator goes to nothing, so a trade forty cents in
 * front reads as +23R. R is a fixed ruler or it is nothing.
 *
 * Both are null where there is nothing to measure, never zero. A position with
 * no stop does not risk nothing — it risks an amount nobody has decided, and
 * writing that down as zero is the one arithmetic mistake here that reads as
 * reassurance. A stop sitting exactly on the entry is a different thing: that
 * is a real decision with a real risk of nearly nothing, and it is a zero.
 */
function positionRisk(position) {
  const size = Math.abs(position.size);
  const broker = session.broker;
  const stop = position.stopLoss;

  /* What the stop standing in the market actually does if it fills, net of
   * what getting in and back out costs. Negative while it is protection,
   * zero at break-even, and positive once it has been moved past it — a stop
   * that no longer risks anything but has something locked in behind it.
   *
   * The distance from the entry to it, unsigned, cannot tell those three
   * apart: it reads a break-even stop as a loss the size of the round trip and
   * a stop trailed into profit as a loss twice that. `risk` is what is left of
   * it — what this position can still lose to its stop, which is nothing once
   * the stop is past break-even. */
  const stopResult = stop == null ? null : broker.exitResult(position, stop);
  const risk = stopResult == null ? null : Math.max(0, -stopResult);

  /* Why break-even is not available on this trade yet, so the panel can grey
   * the button and say so rather than offering one that throws. */
  const breakEvenRefusal = broker.breakEvenRefusal(position);

  const unit = position.riskPerUnit;
  if (!(unit > 0)) {
    return {
      risk, stopResult, breakEvenRefusal, riskPerUnit: null, rMultiple: null, targetR: null,
    };
  }

  const target = position.takeProfit;
  return {
    risk,
    stopResult,
    breakEvenRefusal,
    riskPerUnit: unit,
    rMultiple: broker.positionPnl(position) / (unit * size),
    targetR: target == null ? null : Math.abs(target - position.entryPrice) / unit,
  };
}

/**
 * Works on a different position from here on.
 *
 * What "the stop" means when three are open. Set by clicking a position in the
 * panel or its block on the chart; everything the ticket and the chart's
 * handles do without naming a position goes to this one.
 */
export function selectPosition(id) {
  if (id != null && !state.positions.some((p) => p.id === id)) return;
  state.activePositionId = id;
  state.position = state.positions.find((p) => p.id === id) ?? null;
}

/**
 * Which face of the left panel is showing.
 *
 * A plain setter, because the tabs are also clicked directly. Everything that
 * *means* "show me this trade" goes through `openTradeManager` instead, so
 * that selecting a position and showing what can be done with it stay one
 * action rather than two that can get out of step.
 */
export function setPanelTab(tab) {
  state.panelTab = tab;
}

/** Which of the dock's lists is showing. */
export function setDockTab(tab) {
  state.dockTab = tab;
}

/**
 * Works on this position, and shows what can be done with it.
 *
 * The chart is where a position is pointed at — the block is right there, with
 * its entry and its levels on it — and the panel is where the things that
 * cannot be dragged live: the size to take off, the trail distance, the
 * reversal. Clicking the block therefore opens the second, so that pointing at
 * a trade and managing it are one gesture instead of a click on the chart
 * followed by hunting for the matching row.
 */
export function openTradeManager(id) {
  selectPosition(id);
  state.panelTab = 'trade';
  /* And the panel it is in, if it was folded away — otherwise the click on the
   * chart would do nothing anybody can see. */
  openPanel('left');
}

/**
 * Points the chart at a finished trade, or lets go of it.
 *
 * The index is the trade's place in the book, which is the only handle it has
 * — trades are appended and never reordered, so it does not go stale. Clicking
 * the row that is already focused lets go, because the second click on a thing
 * that is already chosen means "no longer".
 */
export function focusTrade(n) {
  state.focusedTrade = state.focusedTrade === n ? null : n;
}

/** The one under the pointer, lit up but not travelled to. */
export function hoverTrade(n) {
  state.hoveredTrade = n;
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
  const active = broker.positionById(state.activePositionId) ?? broker.position;
  return {
    index: session.index,
    startIndex: session.startIndex,
    positions: broker.positions,
    /* The one the handles belong to. Drawn like the others, but it is the one
     * a drag takes hold of, so it is the one that carries them. */
    position: active,
    activeId: active?.id ?? null,
    orders: broker.pending,
    lastPrice: broker.lastPrice,
    /* The Broker's own numbers, so a tag on the chart and a figure in the
     * panel are the same one rather than two computations of it. */
    unrealized: broker.unrealizedPnl,
    pnlFor: (position) => broker.positionPnl(position),
    /* What a level on a position comes to if it fills: what the stop costs,
     * what the target makes, both net of the round trip. The Broker's own
     * arithmetic again, so the number beside a stop and the level `breakEven`
     * puts it at are the same calculation — a break-even stop reads as zero
     * there because it is zero here. */
    resultAt: (position, price, takesLiquidity) => (
      broker.exitResult(position, price, { takesLiquidity })
    ),
    trades: state.showClosedTrades ? broker.trades : [],
    /* Which of them the list is pointing at, by index. Drawn brighter and
     * with its result on it, so a row and a line on the chart are visibly the
     * same trade. Independent of showClosedTrades: choosing a trade in the
     * list is asking to see that one, whatever the blanket setting says. */
    focusedTrade: state.focusedTrade,
    hoveredTrade: state.hoveredTrade,
    allTrades: broker.trades,
  };
}

/**
 * Whether finished trades stay on the chart.
 *
 * Off used to be the only answer, and the argument for it was a good one: the
 * bars a trade happened on are already the record of it, and painting a
 * session's whole history over the candles turns the thing being read into a
 * scoreboard.
 *
 * It is still the wrong default for the one thing a replay is for. Reviewing
 * an afternoon means seeing where the entries went in against what the market
 * did next, and reconstructing that from a list of timestamps is exactly the
 * work the chart is supposed to save. So they are drawn — small, behind the
 * candles, and switchable, so the argument for leaving them off is still
 * available to anyone who wants it.
 */
export function setShowClosedTrades(on) {
  state.showClosedTrades = !!on;
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
    state.clock = session.clock;
    state.activePositionId = null;
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
  lastSeenPositionId = 0;
  forgetMinutes();
  planDrawings = new Map();
  state.enteredPlans.length = 0;
  state.active = false;
  state.status = '';
  state.bars = [];
  state.barsVersion += 1;
  state.index = 0;
  state.clock = null;
  state.startIndex = 0;
  state.activePositionId = null;
  state.savedSessionId = null;
  // A session that has not been started has nothing to manage yet, so the
  // panel opens on the way in rather than on the trade that is not there.
  state.panelTab = 'ticket';
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
 * Reveals one more bar. The mirrors are not refreshed — see `stepReplay`.
 *
 * Returns false when there is nothing more stored, which is the end of the
 * replay rather than a failure: the data simply stops there.
 */
async function advanceOne() {
  if (session.atEnd && await extendWindow() === 0) {
    state.status = 'ended';
    pause();
    return false;
  }

  /* A bar in progress is finished by this step rather than left behind, so the
   * minutes to fetch are its own — ReplaySession.step takes the ones after the
   * playhead out of them and ignores the rest. */
  const finishing = session.forming !== null && session.forming.index === session.index;
  const next = finishing ? session.forming.full : session.bars[session.index + 1];

  session.step(await minutesFor(next));

  state.index = session.index;
  state.clock = session.clock;
  state.status = 'ready';
  return true;
}

/** Reveals the next bar. */
export async function stepReplay() {
  if (!session || stepping || switching) return false;
  stepping = true;

  try {
    const moved = await advanceOne();
    sync();
    return moved;
  } catch (err) {
    pause();
    setError(err);
    return false;
  } finally {
    stepping = false;
  }
}

/**
 * Reveals several bars in one go, as if the button had been pressed n times.
 *
 * Every one of them is a real step through the engine: orders fill where they
 * would have filled, brackets are decided by the minutes inside their bars,
 * and a stop that would have been hit still is. A jump that simply moved the
 * playhead would be a different thing wearing the same name — it would hand
 * back a position that survived a move it did not survive.
 *
 * The mirrors are refreshed once at the end rather than after each bar: a
 * jump over a thousand bars is one answer, not a thousand renders.
 */
export async function stepBars(count) {
  if (!session || stepping || switching) return 0;
  if (!(count > 0)) return 0;
  stepping = true;
  pause();

  let moved = 0;
  try {
    for (let i = 0; i < count; i++) {
      if (!await advanceOne()) break;
      moved += 1;
    }
    return moved;
  } catch (err) {
    setError(err);
    return moved;
  } finally {
    sync();
    stepping = false;
  }
}

/** As many bars as one forward chunk holds — a page of the replay. */
export function chunkBars() {
  return chunkSize(state.stepMs);
}

/**
 * Plays forward until the playhead reaches a moment.
 *
 * The moment has to be ahead of it. A replay cannot be rewound: the account
 * has already traded through the bars in between, and taking those back would
 * mean deciding which of the trades it took never happened.
 *
 * Bounded by `maxBars` rather than by time, because the data can stop at any
 * point and a target years past the end of it would otherwise be a loop that
 * fetches until it gives up. What it does instead is stop where the data does,
 * which is the same thing the transport does at the end of a session.
 */
export async function jumpTo(time, { maxBars = 20_000 } = {}) {
  if (!session) return 0;
  if (!Number.isFinite(time)) throw new Error('jumpTo: give a timestamp to jump to');
  if (time <= session.clock) {
    throw new Error('A replay only runs forwards — that moment has already been played');
  }

  const target = time;
  const step = state.stepMs || 1;
  const bars = Math.ceil((target - session.clock) / step);
  return stepBars(Math.min(bars, maxBars));
}

/* ─── Changing timeframe under a running session ────────────────────────── */

/**
 * Aggregates the minutes of the bar the playhead is standing inside.
 *
 * Only needed switching to a slower timeframe, and only when the clock is not
 * on one of its boundaries: at 10:35 on an hourly chart there is an hour in
 * progress, and it has to be drawn as far as it has got. Showing the whole of
 * it would be showing the next 25 minutes; leaving it out would take back 35
 * that have already been played.
 *
 * Built from 1m bars because those are what the store keeps — the same source
 * the engine resolves intrabar fills from, so the candle and the fills inside
 * it come from one set of numbers.
 *
 * Returns null where there is nothing to aggregate, which is a clean boundary
 * or a gap in the data. The caller then simply has no bar in progress: the
 * playhead sits on the last closed one, which is honest and the case anyway on
 * every switch to a faster timeframe.
 */
async function formingBar(symbol, stepMs, clock) {
  const from = alignDown(clock, stepMs);
  if (from >= clock) return null;

  const mins = await fetchBars(symbol, '1m', from, clock);
  const inside = mins.filter((m) => m.time >= from && m.time < clock);
  if (inside.length === 0) return null;

  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  let quoteVolume = 0;
  let takerBuyVolume = 0;
  let hasTakerBuy = true;

  for (const m of inside) {
    if (m.high > high) high = m.high;
    if (m.low < low) low = m.low;
    volume += m.volume ?? 0;
    quoteVolume += m.quoteVolume ?? 0;
    if (m.takerBuyVolume == null) hasTakerBuy = false;
    else takerBuyVolume += m.takerBuyVolume;
  }

  return {
    time: from,
    open: inside[0].open,
    high,
    low,
    close: inside[inside.length - 1].close,
    volume,
    quoteVolume,
    ...(hasTakerBuy ? { takerBuyVolume } : {}),
    /* So everything downstream can tell this candle is still being written.
     * Nothing in the engine reads it — the session knows which bar is forming
     * from its own state — but a chart that draws it differently should be
     * able to. */
    forming: true,
  };
}

/**
 * Draws the same session at another resolution, without ending it.
 *
 * The timeframe used to be locked for the length of a session, and the reason
 * was sound: the session counts indices into one array of bars, so swapping
 * the array under it would move every trade it had taken onto a different bar.
 * But reading the higher timeframe and trading the lower one is not a
 * preference, it is the method — locking it asks the person either to trade
 * blind or to start again.
 *
 * What makes it safe is that the session now keeps a clock as well as an
 * index. The clock is an instant, it means the same thing on every timeframe,
 * and everything else is recomputed from it: where the playhead lands, where
 * the session started, and which bar — if any — is still in progress.
 * `ReplaySession.rebase` is where that happens and where the guarantees are
 * written down.
 *
 * Playing stops for the switch. A timer stepping bars while the array under it
 * is replaced is the one way to get a step onto the wrong bar.
 */
export async function switchTimeframe(timeframe) {
  if (!session) throw new Error('There is no replay running');
  const stepMs = TIMEFRAME_MS[timeframe];
  if (!(stepMs > 0)) throw new Error(`switchTimeframe: unknown timeframe "${timeframe}"`);
  if (timeframe === state.timeframe) return;
  /* Not while bars are being stepped, and not twice at once: both would swap
   * the window out from under a loop that is walking it. */
  if (switching || stepping) return;

  switching = true;
  pause();
  const previous = { timeframe: state.timeframe, stepMs: state.stepMs };
  state.status = 'loading';

  try {
    const clock = session.clock;
    /* Around the clock, not around the old window: the lead is what the
     * indicators warm up on and what there is to read to the left, and it is
     * counted in bars of the timeframe being switched to. */
    const windowFrom = clock - LEAD_BARS * stepMs;
    const windowTo = clock + chunkSize(stepMs) * stepMs;

    const bars = await fetchBars(state.symbol, timeframe, windowFrom, windowTo);
    if (bars.length === 0) {
      throw new Error(`No ${timeframe} bars stored around this date`);
    }

    const forming = await formingBar(state.symbol, stepMs, clock);

    state.timeframe = timeframe;
    state.stepMs = stepMs;
    session.rebase({ bars, stepMs, forming });

    /* The minutes cached for the old timeframe are bucketed by its bar
     * boundaries, so they answer the wrong question now. */
    forgetMinutes();

    state.bars = session.bars;
    state.barsVersion += 1;
    state.index = session.index;
    state.startIndex = session.startIndex;
    state.clock = session.clock;
    state.status = 'ready';
    sync();
  } catch (err) {
    state.timeframe = previous.timeframe;
    state.stepMs = previous.stepMs;
    state.status = 'ready';
    setError(err);
  } finally {
    switching = false;
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

/**
 * Sets the quick bar's size, or clears it.
 *
 * Anything that is not a positive number is not a size, and is kept as null
 * rather than as a zero the Buy button would have to know to refuse: there is
 * one representation of "nothing to send", and the button reads it.
 */
export function setQuickSize(size) {
  state.quickSize = Number.isFinite(size) && size > 0 ? size : null;
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

/**
 * Buy or sell at market — filled at once, at the last price on the screen.
 *
 * The position is therefore in `state.position` before this returns, which is
 * what the chart watches: the block is under the pointer that opened it and
 * its stop and target can be dragged straight away. Why that is not
 * look-ahead is at the top of shared/engine/replaySession.js.
 */
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
 * Unlike the entry itself, these are resting orders and live from the *next*
 * bar. Protection decided after a bar closed cannot have been in the market
 * during it, and there is nothing left in that bar for it to catch.
 */
export function protectPosition(levels, positionId = null) {
  return act((s) => s.protect(levels, positionId ?? state.activePositionId));
}

/**
 * Closes a position at market, all of it or part.
 *
 * Part of it is the point: half off at the first target and a runner behind it
 * is a different trade from either of the two whole ones, and a session that
 * can only be all-in or flat cannot practise it. What goes is a closed trade
 * with its own result; what stays keeps the entry it was opened at.
 */
export function closePosition(positionId = null, size = null) {
  const id = positionId ?? state.activePositionId;
  return act((s) => {
    if (size != null) return s.closePart(size, id);
    const order = s.broker.closePosition('manual', { positionId: id });
    return order === null ? null : s.broker.fillNow(order);
  });
}

/** Closes a fraction of a position — a half, a third — at market. */
export function closeFraction(fraction, positionId = null) {
  const id = positionId ?? state.activePositionId;
  const position = state.positions.find((p) => p.id === id);
  if (!position) return null;
  if (!(fraction > 0) || fraction > 1) {
    throw new Error(`closeFraction: give a fraction between 0 and 1, got ${fraction}`);
  }

  const size = Math.abs(position.size) * fraction;
  return fraction === 1 ? closePosition(id) : act((s) => s.closePart(size, id));
}

/**
 * Out of this one and into the same size the other way, in one action.
 *
 * Close-then-reopen by hand is three chances to be wrong — reading the size
 * off the panel, typing it back in, picking the side — while the reason for
 * turning round is still moving on the screen. Both fills are taken at the
 * same last price here, and what comes out is two trades, honestly: the one
 * that was wrong is closed with the result it had.
 */
export function reversePosition(positionId = null) {
  return act((s) => s.reverse(positionId ?? state.activePositionId));
}

/** Out of everything, at market. */
export function flattenAll() {
  return act((s) => s.flatten());
}

/**
 * Moves the stop to where the trade comes out flat after costs.
 *
 * Not to the entry: the commission on the way in is already paid and the way
 * out costs the fee again plus the spread, so a stop on the entry is a small
 * loss every time. The Broker works out where that actually is.
 */
export function breakEven(positionId = null) {
  return act((s) => s.breakEven(positionId ?? state.activePositionId));
}

/**
 * Follows price with the stop, at a fixed distance behind it.
 *
 * The distance is in price, because that is what a stop is: where the trade is
 * wrong. Null turns it off and leaves the stop where the trail last put it —
 * switching a trail off is not the same as giving back the ground it took.
 */
export function setTrailing(distance, options = {}, positionId = null) {
  return act((s) => s.setTrailing(distance, options, positionId ?? state.activePositionId));
}

/** Moves a resting order, keeping its id and its place in the book. */
export function modifyOrder(id, patch) {
  return act((s) => s.modifyOrder(id, patch));
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
/**
 * Puts the session down without ending it.
 *
 * The counterpart to `saveReplay`, and a different thing: that one files a
 * finished account in the library the backtests are in, where it is compared
 * against them. This one keeps an afternoon that is not over — eighty bars in,
 * three positions open — so that stopping is a decision about the evening
 * rather than about the session.
 *
 * What is stored is the account and the clock. The bars are not: they are in
 * the data store, they are the same bars tomorrow, and the clock is an instant
 * rather than an index, so the window can come back a different size without
 * moving anything that has already happened.
 */
export async function suspendReplay(name = '') {
  if (!session) throw new Error('There is no replay to put down');

  const broker = session.broker;
  const saved = await window.midori.replay.saveSession({
    id: state.savedSessionId,
    name,
    symbol: state.symbol,
    timeframe: state.timeframe,
    session: session.snapshot(),
    /* Enough to show the session in a list without opening it. */
    stats: {
      bars: session.progress,
      trades: broker.trades.length,
      openPositions: broker.positions.length,
      equity: broker.equity,
      initialBalance: broker.initialBalance,
    },
  });

  state.savedSessionId = saved.id;
  return saved;
}

/** Every session that has been put down, newest first. */
export function savedSessions() {
  return window.midori.replay.sessions();
}

export async function deleteSavedSession(id) {
  const done = await window.midori.replay.deleteSession(id);
  if (state.savedSessionId === id) state.savedSessionId = null;
  return done;
}

/**
 * Picks a stored session back up.
 *
 * The bars are fetched around the clock the session stopped at — the same
 * window a fresh session loads, just centred on a different moment — and the
 * playhead is recomputed from that clock rather than restored as a number.
 * Which is what makes it safe for the window to come back a different shape
 * than it was: how many bars sit in front of a given moment is not something
 * either side promised the other.
 */
export async function resumeSession(id) {
  const record = await window.midori.replay.loadSession(id);
  if (!record?.session) throw new Error('That session could not be read');

  stopReplay();

  const { symbol, timeframe } = record;
  const snapshot = record.session;
  const stepMs = snapshot.stepMs;

  state.active = true;
  state.status = 'loading';
  state.symbol = symbol;
  state.timeframe = timeframe;
  state.stepMs = stepMs;
  state.balance = snapshot.broker.initialBalance;
  state.costs = { ...snapshot.broker.costs };

  try {
    const clock = snapshot.clock;
    const bars = await fetchBars(
      symbol, timeframe, clock - LEAD_BARS * stepMs, clock + chunkSize(stepMs) * stepMs,
    );
    if (bars.length === 0) {
      throw new Error(`No ${timeframe} bars stored around where this session stopped`);
    }

    const forming = await formingBar(symbol, stepMs, clock);
    session = ReplaySession.restore(snapshot, { bars, forming });

    state.savedSessionId = id;
    state.bars = session.bars;
    state.barsVersion += 1;
    state.startIndex = session.startIndex;
    state.index = session.index;
    state.clock = session.clock;
    state.activePositionId = null;
    state.status = 'ready';
    sync();
  } catch (err) {
    state.active = false;
    state.status = '';
    session = null;
    throw err;
  }
}

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
