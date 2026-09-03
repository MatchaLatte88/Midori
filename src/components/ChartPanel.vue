<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { HistogramSeries, LineSeries, createChart } from 'lightweight-charts';
import { chartStyle, styleEncoder } from './chart/chartStyles.js';
import { INDICATORS, computeIndicator } from '../../shared/indicators/index.js';
import { VolumeProfilePrimitive } from './chart/volumeProfilePrimitive.js';
import { FvgPrimitive } from './chart/fvgPrimitive.js';
import {
  RangeProfilePrimitive, profileWindow, windowKey,
} from './chart/rangeProfilePrimitive.js';
import { RangePrimitive } from './chart/rangePrimitive.js';
import { ReplayPrimitive } from './chart/replayPrimitive.js';
import {
  TAG_REACH, closeButtonRect, draggableLevels, draggableOrders, fieldForPrice, inRect, levelAt,
  levelRefusal, orderAt, orderCancelRect, orderPrice, orderRefusal,
} from './chart/replayLevels.js';
import { SessionPrimitive } from './chart/sessionPrimitive.js';
import { HuntPrimitive } from './chart/huntPrimitive.js';
import { SetupPrimitive } from './chart/setupPrimitive.js';
import { DrawingPrimitive } from './chart/drawings/drawingPrimitive.js';
import { useDrawings } from './chart/drawings/useDrawings.js';
import ChartContextMenu from './ChartContextMenu.vue';
import ConfirmModal from './ConfirmModal.vue';
import DrawingToolbar from './DrawingToolbar.vue';
import PositionStyleBar from './PositionStyleBar.vue';
import LineStyleBar from './LineStyleBar.vue';
import TextStyleBar from './TextStyleBar.vue';
import TextEditBox from './TextEditBox.vue';
import FvgToolBar from './FvgToolBar.vue';
import QuickTradeBar from './QuickTradeBar.vue';
import ChartLegend from './ChartLegend.vue';
import ChartObjects from './ChartObjects.vue';
import { ENTRY, STOP, TARGET, isPositionTool } from './chart/drawings/model.js';
import { TOOLS, specFor, styleKind } from './chart/drawings/registry.js';
import { orderFromPlan } from '../../shared/engine/plannedTrade.js';
import { barIndexAt } from '../../shared/engine/replaySession.js';
import { latestPage, prependBars, previousPage } from './chart/barPaging.js';
import {
  datasetFor, session, setError, setQuote, setVolumeProfile,
} from '../stores/session.js';
import {
  cancelOrder, closePosition, deliverPrice, modifyOrder, openTradeManager, placeFromPlan,
  protectPosition, replay, replayMarks, selectPosition, takeEnteredPlans,
} from '../stores/replay.js';

const props = defineProps({
  symbol: { type: String, default: null },
  timeframe: { type: String, required: true },
});

/** Bars loaded per request. Scrolling left pulls the next page. */
const PAGE = 3000;
/** Quiet period after panning before the profile is recomputed. */
const PROFILE_DEBOUNCE_MS = 180;

const host = ref(null);
const status = ref('');
const chart = shallowRef(null);
const candles = shallowRef(null);
const volume = shallowRef(null);

/* Everything painted on top of the price series, in paint order. Held so a
 * change of chart style can move them to the new series. */
let primitives = [];

let bars = [];          // ascending, seconds-based, as handed to the series
let earliestMs = null;  // left edge currently loaded
let loadingPage = false;
let themeObserver = null;
let profileTimer = null;
let profileToken = 0;   // guards against a slow response overwriting a newer one

let vpPrimitive = null;
let fvgPrimitive = null;
let rangePrimitive = null;
let sessionPrimitive = null;
let huntPrimitive = null;
/* Not `rangePrimitive` — that is the range volume profile, a drawing tool. This
 * one paints the Ranges indicator. Two different things, unfortunately close in
 * name; the classes they hold are RangeProfilePrimitive and RangePrimitive. */
let rangeIndicatorPrimitive = null;
let setupPrimitive = null;
/* The live account — the open position and whatever is still working. Drawn on
 * top of the candles rather than behind them: it is not context, it is state. */
let replayPrimitive = null;
/** windowKey -> profile, so panning or selecting never refetches. */
const rangeProfiles = new Map();
let rangeTimer = null;
let rangeToken = 0;
let drawPrimitive = null;
/** uid -> { series: ISeriesApi[], outputs: string[] } */
const indicatorSeries = new Map();

/* Drawing tools. The composable owns the state; this component wires it to the
 * chart and forwards pointer events from the overlay. */
const draw = useDrawings({
  chart: () => chart.value,
  series: () => candles.value,
  bars: () => bars,
  symbol: () => props.symbol,
  /* Two tools work something out while painting that the pointer layer cannot
   * recompute — an anchored VWAP's curve costs a pass over every bar. The
   * renderer keeps it; this is how the hit test reaches it. */
  cacheFor: (id) => drawPrimitive?.cacheFor(id),
  onError: setError,
});

const overlayEl = ref(null);
const hasSelection = computed(() => draw.selectedId.value !== null);

/* Which destructive action is waiting on an answer: 'one', 'all', a drawing's
 * id, or null. One slot rather than a flag per prompt, because two of these can
 * never be open at once and two flags could disagree about that. */
const pendingDelete = ref(null);

const drawingCount = computed(() => draw.drawings.value.length);

/* What the delete prompt is about to remove, named. "Trend line" is a warning;
 * "the selected drawing" is a sentence about the UI. */
const pendingName = computed(() => {
  const what = pendingDelete.value;
  const id = what === 'one' ? draw.selectedId.value : what;
  const drawing = draw.drawings.value.find((d) => d.id === id);
  if (!drawing) return 'The selected drawing';
  return TOOLS.find((t) => t.id === drawing.type)?.name ?? 'The drawing';
});

/* The chart's one line of feedback. Loading and data problems come from
 * `status`; the drawing tools add their own — a gap tool that found no gap
 * under the pointer has not errored, so it never goes through setError and
 * would otherwise have nowhere to say so. A level dropped somewhere it cannot
 * go is the same kind of thing. */
const chartStatus = computed(() => status.value || levelNotice.value || draw.notice.value);

/* The style bar only makes sense while a position block is selected — for a
 * trend line there is nothing on it to set. */
const selectedPosition = computed(() => {
  const selected = draw.drawings.value.find((d) => d.id === draw.selectedId.value);
  return selected && isPositionTool(selected.type) ? selected : null;
});

/* The stroke bar covers the plain shapes, and the text bar the annotations.
 * The three are mutually exclusive by construction — the registry gives every
 * tool exactly one style kind — so they can share a corner. */
const selectedLine = computed(() => {
  const selected = draw.drawings.value.find((d) => d.id === draw.selectedId.value);
  return selected && styleKind(selected.type) === 'line' ? selected : null;
});

const selectedText = computed(() => {
  const selected = draw.drawings.value.find((d) => d.id === draw.selectedId.value);
  return selected && styleKind(selected.type) === 'text' ? selected : null;
});

/** The annotation being typed into, if any — the editor needs its current text. */
const editingDrawing = computed(() => {
  const target = draw.editing.value;
  return target ? draw.drawings.value.find((d) => d.id === target.id) ?? null : null;
});

/* Whether the whole set is locked, for the rail's padlock. An empty chart reads
 * as unlocked: there is nothing to release. */
const allLocked = computed(() => (
  draw.drawings.value.length > 0 && draw.drawings.value.every((d) => d.locked)
));

const TF_MS = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

/** Reads the chart palette out of the CSS tokens so themes stay in one place. */
function palette() {
  const s = getComputedStyle(document.documentElement);
  const v = (name) => s.getPropertyValue(name).trim();
  return {
    bg: v('--chart-bg'),
    grid: v('--chart-grid'),
    text: v('--chart-text'),
    border: v('--chart-brd'),
    cross: v('--chart-cross'),
    priceLine: v('--chart-price-line'),
    labelBg: v('--chart-label-bg'),
    upBody: v('--candle-up-body'),
    upBrd: v('--candle-up-brd'),
    upWick: v('--candle-up-wick'),
    downBody: v('--candle-down-body'),
    downBrd: v('--candle-down-brd'),
    downWick: v('--candle-down-wick'),
    volUp: v('--vol-up'),
    volDown: v('--vol-down'),
    areaTop: v('--chart-area-top'),
    areaBottom: v('--chart-area-bottom'),
    downFillSoft: v('--chart-down-soft'),
    downFillStrong: v('--chart-down-strong'),
    ind: [1, 2, 3, 4, 5].map((i) => v(`--ind-${i}`)),
  };
}

function applyTheme() {
  if (!chart.value) return;
  const p = palette();
  chart.value.applyOptions({
    layout: { background: { color: p.bg }, textColor: p.text, attributionLogo: true },
    grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
    rightPriceScale: { borderColor: p.border },
    timeScale: { borderColor: p.border },
    crosshair: {
      vertLine: { color: p.cross, labelBackgroundColor: p.labelBg },
      horzLine: { color: p.cross, labelBackgroundColor: p.labelBg },
    },
  });
  candles.value?.applyOptions({
    ...chartStyle(session.chartStyle).options(p),
    /* The last price gets the accent and a dashed line, because it is the one
       level every other number on the chart is read against. Left to itself
       the label takes the last bar's colour, which makes the most important
       number on the axis change colour with the last bar. */
    priceLineColor: p.priceLine,
    priceLineStyle: 2,
    priceLineWidth: 1,
  });
}

/**
 * Builds the price series for the chosen style, and hangs everything on it.
 *
 * Recreated rather than reconfigured, because the styles are different series
 * types — a line is not a candlestick with different colours. What makes that
 * cheap is that every primitive in this chart is stateless about its series:
 * `attached` stores three references and nothing else, so the marks, zones and
 * drawings they hold survive being moved to a new one.
 *
 * The primitives are detached before the old series goes, in the order they
 * were attached, so nothing is left pointing at a series that has been removed.
 */
function mountPriceSeries() {
  const style = chartStyle(session.chartStyle);
  const previous = candles.value;

  if (previous) {
    for (const primitive of primitives) previous.detachPrimitive(primitive);
    chart.value.removeSeries(previous);
  }

  candles.value = chart.value.addSeries(style.series, {});
  for (const primitive of primitives) candles.value.attachPrimitive(primitive);

  applyTheme();
  // The new series has no data of its own, and wants it in its own shape.
  if (bars.length > 0) render();
}

function toSeries(raw) {
  return raw.map((b) => ({
    time: Math.floor(b.time / 1000),
    open: b.open, high: b.high, low: b.low, close: b.close,
    volume: b.volume,
  }));
}

async function fetchRange(from, to) {
  return window.midori.data.bars({
    symbol: props.symbol,
    timeframe: props.timeframe,
    from,
    to,
    // The chart may show the still-forming bar; the engine never does.
    dropIncomplete: false,
  });
}

/* Bars as an indicator sees them.
 *
 * The series wants seconds, so `bars` holds seconds. Anything that reads a
 * calendar off a bar — sessions, an anchored VWAP — needs milliseconds, and
 * silently gets 1970 otherwise: the numbers still look like timestamps, the
 * output still looks like an indicator, and every session lands on the wrong
 * day. Converted once per render rather than per indicator.
 */
let indicatorBars = [];

function buildIndicatorBars() {
  indicatorBars = bars.map((b) => ({ ...b, time: b.time * 1000 }));
}

/* Turns bars into whatever shape the chosen style draws.
 *
 * Rebuilt whenever the style or the window changes, and kept between renders
 * because Heikin Ashi's next bar depends on the one before it — see
 * `styleEncoder`. Every other style ignores that and maps one bar at a time. */
let encoder = styleEncoder('candle');

function render() {
  const p = palette(); // once per render, not once per bar
  encoder = styleEncoder(session.chartStyle, p);
  candles.value.setData(encoder.data(bars));
  volume.value.setData(bars.map((b) => ({
    time: b.time,
    value: b.volume,
    color: b.close >= b.open ? p.volUp : p.volDown,
  })));
  buildIndicatorBars();
  syncIndicators();
  publishQuote();
}

/**
 * Hands the bar at the right edge to the header above the chart.
 *
 * From `bars` and nowhere else, so the price in the instrument bar is by
 * construction the last candle on the screen — under a replay that is the bar
 * at the playhead, not the newest bar on disk, and a header that fetched its
 * own price would be quietly showing the future.
 */
function publishQuote() {
  const last = bars[bars.length - 1];
  if (!last) {
    setQuote(null);
    return;
  }
  const prev = bars[bars.length - 2] ?? null;
  setQuote({
    // Back to milliseconds: the series holds seconds, everything else does not.
    time: last.time * 1000,
    open: last.open,
    high: last.high,
    low: last.low,
    close: last.close,
    volume: last.volume,
    prevClose: prev ? prev.close : null,
  });
}

/* ─── Replay ────────────────────────────────────────────────────────────────
 *
 * A running replay hands the chart its bars instead of the chart fetching its
 * own, and hands it only the ones up to the playhead. Everything downstream
 * then follows without knowing a replay exists: an indicator computed over
 * `bars` cannot see a bar that has not been revealed, because it is not in the
 * array. That is a stronger guarantee than hiding the candles would be, and it
 * is the same guarantee the backtest engine gives a strategy.
 *
 * Why loading is frozen meanwhile: the session counts every index from the
 * front of its own array, so a page of older bars arriving at the front would
 * move every trade it has already taken onto a different bar. Forward chunks
 * are appended by the store, which is the one direction that is safe.
 */

/** How many replay bars are currently on the chart, or -1 for none. */
let replayShown = -1;
/** Which timeframe those bars are, so a switch is noticed rather than blended. */
let replayShownTf = null;

/**
 * Puts the revealed part of the replay window on the chart.
 *
 * One bar further along the same window is the common case — thirty times a
 * second at the top speed — so that path appends a single bar instead of
 * rebuilding fifteen hundred of them and every indicator's input array with
 * them. Anything else (a session starting, a chunk appended, a jump) rebuilds.
 *
 * The view itself is never touched. A replay is set up by hand — the zoom, and
 * where the newest candle sits so there is room to the right to read into — and
 * scrolling to the last bar on every reveal threw that away one step at a time.
 * Nothing has to be done to keep it: the time scale holds a right offset rather
 * than an absolute range, so revealing a bar leaves the newest candle exactly
 * where it was and moves the chart along under it. A chart that has been
 * scrolled back into history is compensated the other way by the library, and
 * stays on the bars being read. Both are what is wanted; both only happen while
 * nothing here interferes.
 */
function applyReplayBars() {
  const full = replay.bars;

  /* A timeframe switch replaces the whole window with a different number of
   * bars, so nothing about what is on the chart carries over: it is redrawn
   * and reframed, exactly as a session starting is. Without this the view
   * would keep a logical range that means something else now — twelve hours
   * of 5m bars and twelve hours of 1h bars are not the same picture. */
  if (replayShownTf !== replay.timeframe) {
    replayShownTf = replay.timeframe;
    replayShown = -1;
  }
  /* First pass for this chart instance — a session starting, or the view being
   * returned to while one is running. Either way the chart has to be aimed at
   * the playhead rather than at wherever it was left. */
  const first = replayShown === -1;

  if (full.length === 0) {
    bars = [];
    indicatorBars = [];
    replayShown = -1;
    candles.value?.setData([]);
    volume.value?.setData([]);
    syncIndicators();
    setQuote(null);
    return;
  }

  const wanted = replay.index + 1;
  const appending = wanted === replayShown + 1 && bars.length === replayShown;

  if (appending) {
    const [bar] = toSeries([full[replay.index]]);
    const p = palette();
    bars.push(bar);
    indicatorBars.push({ ...bar, time: bar.time * 1000 });
    // Through the encoder, so the appended bar continues the sequence the last
    // full render left off at rather than starting a new one.
    candles.value.update(encoder.point(bar));
    volume.value.update({
      time: bar.time,
      value: bar.volume,
      color: bar.close >= bar.open ? p.volUp : p.volDown,
    });
    syncIndicators();
    publishQuote();
  } else {
    bars = toSeries(full.slice(0, wanted));
    earliestMs = full[0].time;
    render();
  }

  replayShown = wanted;
  status.value = '';
  pushReplayMarks();
  if (first) frameReplay();
}

/** Frames the chart on the playhead when a session begins. */
function frameReplay() {
  if (bars.length === 0) return;
  /* The recent past and a little room to the right. Fitting the whole window
   * would show fifteen hundred bars of lead-in at a zoom nothing is readable
   * at, and the lead-in is context, not the subject. */
  chart.value?.timeScale().setVisibleLogicalRange({
    from: Math.max(0, bars.length - 250),
    to: bars.length + 8,
  });
}

/**
 * The open position and the working orders, for the primitive to paint.
 *
 * One drag channel and one hover channel for both kinds of thing that can be
 * taken hold of. A level drag is `{ origin, field, price }` and an order drag
 * is `{ orderId, price }`; the primitive tells them apart by which key is
 * there. Hover is a string throughout — a field name, 'close', or 'order:7' /
 * 'cancel:7' for one of the waiting orders.
 */
function pushReplayMarks() {
  replayPrimitive?.setMarks(
    replay.active ? replayMarks() : null,
    replay.bars,
    levelDrag.value ?? orderDrag.value,
    levelHover.value,
  );
}

/* ─── Taking hold of the position's levels ──────────────────────────────────
 *
 * A stop is moved by looking at the chart and putting it where it belongs, not
 * by typing a number into a ticket, so the two lines the open position draws
 * can be dragged. Nothing about the account changes while the pointer is down:
 * the drag is a preview the primitive paints, and only the drop replaces the
 * protection — through protectPosition, so a level moved by hand becomes
 * exactly the order a level typed in becomes, live from the next bar like
 * every other resting order.
 *
 * The geometry, and the rule about which drops are refused, are in
 * chart/replayLevels.js where they can be checked without a chart.
 */

/** { field, price } while a level is being dragged, else null. */
const levelDrag = ref(null);
/** The field under the pointer — what turns the overlay on for a level. */
const levelHover = ref(null);
/** Why the last drop was refused. Cleared by the next drag or the next bar. */
const levelNotice = ref(null);
/** True between pressing the close button and letting go over it. */
const pendingClose = ref(false);

/** Where an open position's levels are on screen, and how far they run. */
function levelTargets(position) {
  if (!replay.active || !position || !candles.value || !chart.value) return null;

  const levels = [];
  for (const { field, price } of draggableLevels(position)) {
    const y = candles.value.priceToCoordinate(price);
    if (y != null) levels.push({ field, y });
  }
  if (levels.length === 0) return null;

  // Where the block starts: the lines are drawn from the entry bar rightwards.
  const entry = draw.project({ time: position.openedAt, price: position.entryPrice });
  /* The pane's width, not the element's: the lines stop where the price scale
   * begins, and a band of the axis that could not be dragged because a level
   * happens to run across it would be a strange thing to have built.
   *
   * The left end is the entry, or the tags against the right edge where the
   * block is narrower than they are — see TAG_REACH. */
  const width = chart.value.paneSize().width;
  return {
    levels,
    extent: { left: Math.min(entry?.x ?? 0, width - TAG_REACH), right: width },
  };
}

/**
 * The level a pointer has hold of and the position it belongs to, or null.
 *
 * Never while a tool is armed, and never while the ticket is waiting for a
 * price: both mean the next click was already promised to something else.
 *
 * Every open position is tested, not only the one being worked on — otherwise
 * the second position on the chart could be seen and not touched, and the only
 * way to its stop would be to go and select it in the panel first. The active
 * one is tested first, so two blocks lying over each other resolve to the one
 * already in hand rather than swapping under the pointer.
 */
function levelUnder(point) {
  if (draw.activeTool.value !== 'cursor' || replay.picking) return null;

  const ordered = [
    ...(replay.position ? [replay.position] : []),
    ...replay.positions.filter((p) => p.id !== replay.activePositionId),
  ];

  for (const position of ordered) {
    const targets = levelTargets(position);
    const field = targets ? levelAt(point, targets.extent, targets.levels) : null;
    if (field) return { field, position };
  }
  return null;
}

/**
 * Where the button that closes the position is, or null when there is none.
 *
 * The rectangle comes from replayLevels.js, which is the same one the primitive
 * paints — a button whose picture and whose hit area were worked out separately
 * would eventually be a button that closes a position from somewhere it is not
 * drawn.
 */
function closeTarget() {
  const position = replay.position;
  if (!replay.active || !position || !candles.value || !chart.value) return null;
  const y = candles.value.priceToCoordinate(position.entryPrice);
  if (y == null) return null;
  return closeButtonRect(chart.value.paneSize().width, y);
}

function overClose(point) {
  if (draw.activeTool.value !== 'cursor' || replay.picking) return false;
  const rect = closeTarget();
  return rect ? inRect(point, rect) : false;
}

/**
 * Records what the pointer is over, and repaints only when it matters.
 *
 * A position's levels change nothing about the picture — they are a cursor and
 * a live overlay. Three things do change it: the close button fills when the
 * pointer is on it, an order's line brightens, and its × is only drawn while
 * the line is pointed at. So a repaint is asked for on the way into and out of
 * any of those, and never for the hundreds of moves in between.
 */
function setLevelHover(field) {
  if (levelHover.value === field) return;
  const paints = (v) => v === 'close' || (typeof v === 'string' && v.includes(':'));
  const before = paints(levelHover.value);
  levelHover.value = field;
  if (before || paints(field)) pushReplayMarks();
}

/** Everything the pointer could be over on a running session, in priority. */
function replayHover(point) {
  if (overClose(point)) return 'close';
  const order = orderHover(point);
  if (order) return order;
  return levelUnder(point)?.field ?? null;
}

function startLevelDrag(point) {
  const hit = levelUnder(point);
  if (!hit) return false;
  const { field, position } = hit;

  levelNotice.value = null;
  /* Taking hold of a position's line is how it becomes the one being worked
   * on: anything else would have the drag land on a different trade's stop
   * than the one under the pointer.
   *
   * Selecting only, not opening the manager. A drag is work on the chart, and
   * unfolding the side panel under someone who folded it away to get the room
   * — every time they touch a stop — is the app arguing with them. A *click*
   * does open it; see `dropLevel`. */
  selectPosition(position.id);

  /* `origin` is which line was actually taken hold of, and it does not change
   * for the length of the drag. `field` is what the drag currently means, which
   * for one off the entry line is decided anew on every move. */
  levelDrag.value = {
    origin: field,
    field,
    price: field === 'entry' ? position.entryPrice : position[field],
  };
  pushReplayMarks();
  return true;
}

function moveLevelDrag(point) {
  const position = replay.position;
  const price = candles.value?.coordinateToPrice(point.y);
  if (price == null || !position) return;

  const { origin } = levelDrag.value;
  /* Dragged off the entry: the side of the last price says which level this is,
   * not the direction the pointer went — see fieldForPrice. Everything else
   * stays the level it was picked up as. */
  const field = origin === 'entry'
    ? fieldForPrice(price, position, replay.bars[replay.index]?.close)
    : origin;

  levelDrag.value = { origin, field, price };
  pushReplayMarks();
}

/**
 * Drops the level — and only now does anything actually move.
 *
 * Both legs go back in together: protectPosition replaces what is on the
 * position, so sending only the one that was dragged would cancel the other.
 * The price is rounded the way the ticket's own picker rounds it, so a level
 * dragged and a level clicked land on the same number rather than on sixteen
 * digits of one.
 */
function dropLevel() {
  const { field, price } = levelDrag.value;
  const position = replay.position;
  levelDrag.value = null;
  levelHover.value = null;

  // It closed while the pointer was down — a stop the last step filled.
  if (!position) {
    pushReplayMarks();
    return;
  }

  /* Two ways of having moved nothing, and both of them are a click on the
   * position rather than a level being placed.
   *
   * Still on the entry line means the pointer never left it — and the entry is
   * not a thing that can be moved anyway, the position opened where it opened.
   * A level dropped on the price it was already at is the same gesture on a
   * different line; committing it would cancel and re-place the same two
   * orders, and the stored session would carry the churn.
   *
   * So a click on any of a position's lines opens its manager. That is the
   * whole gesture the layout is built around: point at a trade on the chart,
   * and the panel is about that trade — including everything that cannot be
   * dragged, which is the size to take off, the trail and the reversal. */
  if (field === 'entry' || price === position[field]) {
    openTradeManager(position.id);
    pushReplayMarks();
    return;
  }

  const refusal = levelRefusal(field, price, position, replay.bars[replay.index]?.close);
  if (refusal) {
    levelNotice.value = refusal;
    pushReplayMarks();
    return;
  }

  protectPosition({
    stopLoss: field === 'stopLoss' ? Number(price.toPrecision(8)) : position.stopLoss,
    takeProfit: field === 'takeProfit' ? Number(price.toPrecision(8)) : position.takeProfit,
  }, position.id);
  pushReplayMarks();
}

/* ─── Taking hold of the orders that are still waiting ──────────────────────
 *
 * The same gesture as a level, on the other kind of line. A resting order used
 * to be a thing you could see and not touch: moving it meant cancelling it in
 * the panel and placing another, which is a new id, a new place in the book,
 * and a moment with nothing in the market. The Broker has been able to amend an
 * order in place all along — `modifyOrder`, tested since it was written — and
 * nothing on this side ever asked it to.
 *
 * Which orders have a line, and which drops are refused, are in
 * chart/replayLevels.js beside the equivalents for levels.
 */

/** { orderId, price } while an order is being dragged, else null. */
const orderDrag = ref(null);
/** True between pressing an order's × and letting go over it. */
const pendingCancel = ref(null);

/** Where the draggable orders are on screen, and how far their lines run. */
function orderTargets() {
  if (!replay.active || !candles.value || !chart.value) return null;

  const orders = draggableOrders(replay.orders, replay.positions);
  if (orders.length === 0) return null;

  const rows = [];
  for (const order of orders) {
    const y = candles.value.priceToCoordinate(orderPrice(order));
    if (y != null) rows.push({ id: order.id, y, order });
  }
  if (rows.length === 0) return null;

  /* Only into the future: an order is waiting for bars that have not happened,
   * so its line starts at the playhead. Which is also where its hit area
   * starts — a line that could be grabbed to the left of where it is drawn
   * would be grabbing at revealed history. */
  const bar = replay.bars[replay.index];
  const head = bar ? draw.project({ time: bar.time, price: bar.close })?.x : null;
  return { rows, extent: { left: head ?? 0, right: chart.value.paneSize().width } };
}

/** The waiting order a pointer has hold of, or null. */
function orderUnder(point) {
  if (draw.activeTool.value !== 'cursor' || replay.picking) return null;
  const targets = orderTargets();
  if (!targets) return null;
  const id = orderAt(point, targets.extent, targets.rows);
  return id == null ? null : targets.rows.find((r) => r.id === id);
}

/**
 * The order whose × is under the pointer, or null.
 *
 * Only on the line the pointer is already on: the button is drawn on hover and
 * nowhere else, and a hit area for a button that is not painted is how an order
 * gets cancelled by a mouse passing over the price axis.
 */
function cancelUnder(point) {
  const row = orderUnder(point);
  if (!row) return null;
  const rect = orderCancelRect(chart.value.paneSize().width, row.y);
  return inRect(point, rect) ? row : null;
}

/**
 * What the pointer is over among the orders, as the primitive's hover string.
 *
 * One hit test rather than asking `cancelUnder` and then `orderUnder`: this
 * runs on every pointer move across the chart, and the button is on the line
 * anyway, so the line is the question and the button is a detail of the answer.
 */
function orderHover(point) {
  const row = orderUnder(point);
  if (!row) return null;
  const rect = orderCancelRect(chart.value.paneSize().width, row.y);
  return inRect(point, rect) ? `cancel:${row.id}` : `order:${row.id}`;
}

function startOrderDrag(point) {
  const row = orderUnder(point);
  if (!row) return false;
  levelNotice.value = null;
  orderDrag.value = { orderId: row.id, price: orderPrice(row.order) };
  pushReplayMarks();
  return true;
}

function moveOrderDrag(point) {
  const price = candles.value?.coordinateToPrice(point.y);
  if (price == null) return;
  orderDrag.value = { ...orderDrag.value, price };
  pushReplayMarks();
}

/**
 * Drops the order — and only now does the book change.
 *
 * Amended rather than replaced, so the order keeps its id: a bracket sibling
 * still knows it, the row in the dock does not jump, and there is never an
 * instant with nothing in the market. Refusals are the two ways a drag can
 * quietly ruin an order — onto a price it is already triggered at, or past its
 * own stop — and they are turned away here rather than sent and discovered a
 * bar later.
 */
function dropOrder() {
  const { orderId, price } = orderDrag.value;
  orderDrag.value = null;
  levelHover.value = null;

  const row = replay.orders.find((o) => o.id === orderId);
  if (!row) {
    // It filled or was cancelled while the pointer was down.
    pushReplayMarks();
    return;
  }

  // Pressed and let go without moving: a click on the line, not a new price.
  if (price === orderPrice(row)) {
    pushReplayMarks();
    return;
  }

  const refusal = orderRefusal(row, price, replay.bars[replay.index]?.close);
  if (refusal) {
    levelNotice.value = refusal;
    pushReplayMarks();
    return;
  }

  const rounded = Number(price.toPrecision(8));
  modifyOrder(orderId, row.type === 'limit' ? { limitPrice: rounded } : { stopPrice: rounded });
  pushReplayMarks();
}

/** Nothing left to hold on to: the session ended, or the view was left. */
function forgetLevels() {
  levelDrag.value = null;
  levelHover.value = null;
  levelNotice.value = null;
  pendingClose.value = false;
  orderDrag.value = null;
  pendingCancel.value = null;
}

/* The overlay takes pointer events for the drawing tools, for these levels and
 * for the close button; any of them is reason enough. What is under the pointer
 * wins the cursor, because it is the thing on top. */
const overlayOn = computed(() => draw.overlayActive.value || levelHover.value !== null);
const overlayCursor = computed(() => {
  const over = levelHover.value;
  if (over === 'close' || String(over).startsWith('cancel:')) return 'pointer';
  if (levelDrag.value || orderDrag.value || over) return 'ns-resize';
  return draw.cursorStyle.value;
});

/* Where a click on the chart goes while the ticket has a field armed. The
 * price comes from the y coordinate rather than from the bar under the
 * pointer: a stop is a level, and reading it off a candle's close would put it
 * wherever that candle happened to end. */
function onChartClick(param) {
  if (!replay.active || !replay.picking || !param.point || !candles.value) return;
  const price = candles.value.coordinateToPrice(param.point.y);
  if (price != null) deliverPrice(price);
}

/* ─── Turning a drawn position into an order ────────────────────────────────
 *
 * The position tool already asks for everything an order needs except the
 * size, so a block that is already on the chart should not have to be retyped
 * into a ticket — that is the moment the numbers get typed wrong. Right-click
 * it and it becomes an order.
 *
 * Only while a replay is running. On the plain chart there is no account for
 * an order to go to, and a menu offering to trade into nothing would be worse
 * than no menu.
 *
 * What each of the two does is in shared/engine/plannedTrade.js. Both rows are
 * built up front rather than on click, because a block that cannot become an
 * order — a stop sitting on the entry, a target on the wrong side — should say
 * so in the menu instead of failing after it is chosen.
 */
const menu = ref({ open: false, x: 0, y: 0, title: '', items: [], plan: null, drawingId: null });

const priceText = (v) => v.toLocaleString(undefined, { maximumFractionDigits: 8 });

/** One menu row per mode, or a row saying why that mode is unavailable. */
function planItems(plan, price) {
  return ['market', 'pending'].map((mode) => {
    try {
      const spec = orderFromPlan(plan, { price, mode });
      const target = spec.reward == null ? '' : ` · target ${priceText(spec.reward)}`;

      return mode === 'market'
        ? {
          id: mode,
          label: `Market ${spec.side}`,
          detail: `now, at the drawn distances — risk ${priceText(spec.risk)}${target}`,
        }
        : {
          id: mode,
          label: `${spec.side === 'buy' ? 'Buy' : 'Sell'} ${spec.type}`,
          detail: `waits at ${priceText(spec.price)} — risk ${priceText(spec.risk)}${target}`,
        };
    } catch (err) {
      return {
        id: mode,
        label: mode === 'market' ? 'Market order' : 'Pending order',
        detail: err.message,
        disabled: true,
      };
    }
  });
}

function onContextMenu(event) {
  closeMenu();
  if (!replay.active || draw.activeTool.value !== 'cursor') return;

  const point = localPoint(event);
  const hit = draw.findAt(point.x, point.y, paneSize());
  if (!hit || !isPositionTool(hit.type)) return;

  const price = replay.bars[replay.index]?.close;
  if (price == null) return;

  /* Only from here on is the browser's own menu suppressed: a right-click
   * anywhere else on the chart is not ours to take. */
  event.preventDefault();

  const plan = {
    entry: hit.points[ENTRY].price,
    stop: hit.points[STOP].price,
    target: hit.points[TARGET]?.price ?? null,
  };

  menu.value = {
    open: true,
    x: event.clientX,
    y: event.clientY,
    title: `Drawn position · last ${priceText(price)}`,
    items: planItems(plan, price),
    plan,
    drawingId: hit.id,
  };
}

function closeMenu() {
  menu.value = { ...menu.value, open: false };
}

/* The drawing is handed over with the order. It stays while the order is only
 * waiting — until a resting entry fills, the block is the only thing showing
 * where its stop and target will go — and is removed the moment the entry
 * actually happens, because from then on the engine draws the position and two
 * nearly identical blocks on top of each other say nothing extra. */
function onMenuSelect(mode) {
  placeFromPlan(menu.value.plan, mode, menu.value.drawingId);
}

/* Plans that have been entered, cleared out as they arrive. Watched rather
 * than done inside onMenuSelect, because the moment that matters is the fill,
 * which can be many bars later or never. */
watch(() => replay.enteredPlans.length, (count) => {
  if (count === 0) return;
  for (const id of takeEnteredPlans()) draw.remove(id);
  syncDrawings();
});

/* ─── Indicators ────────────────────────────────────────────────────────── */

/** Rebuilds every indicator series from the current bars. */
function syncIndicators() {
  if (!chart.value) return;
  const p = palette();
  const active = session.indicators;
  const wanted = new Set(active.map((i) => i.uid));

  // Drop series whose indicator is gone.
  for (const [uid, entry] of indicatorSeries) {
    if (!wanted.has(uid)) {
      for (const s of entry.series) chart.value.removeSeries(s);
      indicatorSeries.delete(uid);
    }
  }

  // Each 'separate' indicator gets its own pane so a 0-100 oscillator never
  // shares a scale with something measured in price.
  let nextPane = 1;

  /* Zone indicators do not get a series at all — they are rectangles, and the
   * library has none. Every one of them feeds the same primitive, so a chart
   * with three FVG settings on it still repaints in one pass. */
  const zoneGroups = [];
  const sessionGroups = [];
  const huntGroups = [];
  const setupGroups = [];
  const rangeGroups = [];

  for (const ind of active) {
    const spec = INDICATORS[ind.id];
    if (!spec) continue;

    if (spec.kind === 'sessions') {
      if (!ind.visible || bars.length === 0) continue;
      try {
        const { sessions } = computeIndicator(ind.id, indicatorBars, ind.params);
        sessionGroups.push({
          sessions,
          options: { extent: ind.params.extent, labels: ind.params.labels },
        });
      } catch (err) {
        setError(err);
      }
      continue;
    }

    if (spec.kind === 'setups') {
      if (!ind.visible || bars.length === 0) continue;
      try {
        const { setups } = computeIndicator(ind.id, indicatorBars, ind.params);
        setupGroups.push({
          setups,
          // Drawing-only, so these never reached compute() — see fvg.js.
          bullColor: ind.params.bullColor,
          bearColor: ind.params.bearColor,
        });
      } catch (err) {
        setError(err);
      }
      continue;
    }

    if (spec.kind === 'ranges') {
      if (!ind.visible || bars.length === 0) continue;
      try {
        const { ranges } = computeIndicator(ind.id, indicatorBars, ind.params);
        rangeGroups.push({
          ranges,
          // Drawing-only, so these never reached compute() — see fvg.js.
          color: ind.params.color,
          bullColor: ind.params.bullColor,
          bearColor: ind.params.bearColor,
        });
      } catch (err) {
        setError(err);
      }
      continue;
    }

    if (spec.kind === 'hunts') {
      if (!ind.visible || bars.length === 0) continue;
      try {
        const { hunts } = computeIndicator(ind.id, indicatorBars, ind.params);
        huntGroups.push({
          hunts,
          // Drawing-only, so these never reached compute() — see fvg.js.
          bullColor: ind.params.bullColor,
          bearColor: ind.params.bearColor,
        });
      } catch (err) {
        setError(err);
      }
      continue;
    }

    if (spec.kind === 'zones') {
      if (!ind.visible || bars.length === 0) continue;
      try {
        const { zones } = computeIndicator(ind.id, indicatorBars, ind.params);
        zoneGroups.push({
          zones,
          // The midpoint is only meaningful when it is the rule that fills a gap.
          midline: ind.params.mitigation === 'ce',
          // Drawing-only, so these never reached compute() — see fvg.js.
          boxWidth: ind.params.boxWidth,
          bullColor: ind.params.bullColor,
          bearColor: ind.params.bearColor,
        });
      } catch (err) {
        setError(err);
      }
      continue;
    }

    const paneIndex = spec.pane === 'separate' ? nextPane++ : 0;

    let entry = indicatorSeries.get(ind.uid);
    if (!entry) {
      const series = spec.outputs.map((out, i) => chart.value.addSeries(LineSeries, {
        color: p.ind[(ind.colorIndex - 1 + i) % p.ind.length],
        lineWidth: out.key === 'middle' ? 1 : 2,
        lineStyle: out.key === 'middle' ? 2 : 0,
        priceLineVisible: false,
        lastValueVisible: spec.outputs.length === 1,
        crosshairMarkerVisible: false,
      }, paneIndex));
      entry = { series, outputs: spec.outputs.map((o) => o.key) };
      indicatorSeries.set(ind.uid, entry);
    }

    if (!ind.visible || bars.length === 0) {
      for (const s of entry.series) s.setData([]);
      continue;
    }

    let result;
    try {
      result = computeIndicator(ind.id, indicatorBars, ind.params);
    } catch (err) {
      setError(err);
      continue;
    }

    entry.outputs.forEach((key, i) => {
      const values = result[key];
      const points = [];
      for (let j = 0; j < bars.length; j++) {
        // A null is warm-up, not a gap to interpolate across.
        if (values[j] == null) continue;
        points.push({ time: bars[j].time, value: values[j] });
      }
      entry.series[i].setData(points);
      entry.series[i].applyOptions({
        color: p.ind[(ind.colorIndex - 1 + i) % p.ind.length],
      });
    });
  }

  fvgPrimitive?.setGroups(zoneGroups);
  rangeIndicatorPrimitive?.setGroups(rangeGroups);
  sessionPrimitive?.setGroups(sessionGroups);
  huntPrimitive?.setGroups(huntGroups);
  setupPrimitive?.setGroups(setupGroups);
}

/* ─── Volume profile ────────────────────────────────────────────────────── */

function scheduleProfile() {
  clearTimeout(profileTimer);
  profileTimer = setTimeout(updateProfile, PROFILE_DEBOUNCE_MS);
}

async function updateProfile() {
  const cfg = session.volumeProfile;
  if (!vpPrimitive) return;

  if (!cfg.enabled || !props.symbol) {
    vpPrimitive.setProfile(null);
    setVolumeProfile({ stats: null });
    return;
  }

  const meta = datasetFor(props.symbol);
  if (!meta) return;

  let from = meta.first;
  let to = meta.last + TF_MS['1m'];

  if (cfg.range === 'visible') {
    const visible = chart.value?.timeScale().getVisibleRange();
    if (visible) {
      from = visible.from * 1000;
      to = visible.to * 1000;
    }
  }

  const token = ++profileToken;
  try {
    const profile = await window.midori.data.volumeProfile({
      symbol: props.symbol,
      from,
      to,
      bins: cfg.bins,
      valueArea: cfg.valueArea,
      distribution: cfg.distribution,
    });
    // A pan that happened while this was in flight wins.
    if (token !== profileToken) return;

    vpPrimitive.setProfile(profile);
    setVolumeProfile({
      stats: {
        poc: profile.poc?.price ?? null,
        vah: profile.valueArea?.high ?? null,
        val: profile.valueArea?.low ?? null,
        totalVolume: profile.totalVolume,
        barCount: profile.barCount,
        hasDelta: profile.hasDelta,
        deltaCoverage: profile.deltaCoverage,
        buyVolume: profile.totalBuyVolume,
        sellVolume: profile.totalSellVolume,
        delta: profile.totalDelta,
        from,
        to,
      },
    });
  } catch (err) {
    if (token === profileToken) setError(err);
  }
}

/* ─── Range volume profiles ─────────────────────────────────────────────── */

/* The bins, value area and spread are the ones set in the panel, whether or not
 * the panel profile itself is switched on. Two profiles of the same market
 * disagreeing about how volume is distributed would be worse than one setting
 * living in a slightly odd place. */
function rangeOptions() {
  const cfg = session.volumeProfile;
  return { bins: cfg.bins, valueArea: cfg.valueArea, distribution: cfg.distribution };
}

function scheduleRangeProfiles() {
  clearTimeout(rangeTimer);
  rangeTimer = setTimeout(updateRangeProfiles, PROFILE_DEBOUNCE_MS);
}

/** Pushes whatever is already computed; called after every fetch and on load. */
function publishRangeProfiles(spans, options) {
  rangePrimitive?.setEntries(
    spans
      .map((drawing) => ({ drawing, profile: rangeProfiles.get(windowKey(drawing, options)) }))
      .filter((entry) => entry.profile),
  );
}

async function updateRangeProfiles() {
  if (!rangePrimitive) return;
  const spans = draw.drawings.value.filter((d) => d.type === 'rangeprofile');

  if (!props.symbol || spans.length === 0) {
    rangeProfiles.clear();
    rangePrimitive.setEntries([]);
    return;
  }

  const options = rangeOptions();
  const wanted = new Set(spans.map((d) => windowKey(d, options)));
  /* Dragging a span produces a new key on every frame, so without this the map
   * would grow for as long as the mouse is down. */
  for (const key of rangeProfiles.keys()) {
    if (!wanted.has(key)) rangeProfiles.delete(key);
  }

  publishRangeProfiles(spans, options);

  const token = ++rangeToken;
  const missing = spans.filter((d) => !rangeProfiles.has(windowKey(d, options)));

  await Promise.all(missing.map(async (drawing) => {
    const { from, to } = profileWindow(drawing);
    // A span dragged out on one bar has no width yet; the data process would
    // reject it, and there is nothing to profile in it anyway.
    if (!(to > from)) return;
    try {
      const profile = await window.midori.data.volumeProfile({
        symbol: props.symbol, from, to, ...options,
      });
      rangeProfiles.set(windowKey(drawing, options), profile);
    } catch (err) {
      setError(err);
    }
  }));

  // A newer pass has already taken over; its own publish is the current one.
  if (token !== rangeToken) return;
  publishRangeProfiles(spans, options);
}

/* ─── Loading ───────────────────────────────────────────────────────────── */

async function loadInitial() {
  bars = [];
  indicatorBars = [];
  earliestMs = null;

  /* A running session owns the window. Fetching the latest page underneath it
   * would replace the bars its indices are counted against. */
  if (replay.active) {
    applyReplayBars();
    return;
  }

  if (!props.symbol) {
    status.value = '';
    candles.value?.setData([]);
    volume.value?.setData([]);
    syncIndicators();
    setQuote(null);
    return;
  }

  const meta = datasetFor(props.symbol);
  if (!meta || !meta.last) {
    status.value = 'No data stored for this symbol yet.';
    return;
  }

  status.value = 'Loading…';
  try {
    const step = TF_MS[props.timeframe];
    // Page boundaries sit on timeframe buckets — see chart/barPaging.js.
    const { from, to } = latestPage(meta, step, PAGE);
    const raw = await fetchRange(from, to);
    bars = toSeries(raw);
    earliestMs = from;

    if (!bars.length) {
      status.value = 'No bars in the stored range.';
      return;
    }
    status.value = '';
    render();
    chart.value.timeScale().fitContent();
    scheduleProfile();
  } catch (err) {
    status.value = err.message;
    setError(err);
  }
}

/** Pulls the previous page when the view approaches the left edge. */
async function loadOlder() {
  // See applyReplayBars: prepending would move every index the session holds.
  if (replay.active) return;
  if (loadingPage || !props.symbol || earliestMs == null) return;
  const meta = datasetFor(props.symbol);
  if (!meta || earliestMs <= meta.first) return;

  loadingPage = true;
  try {
    const step = TF_MS[props.timeframe];
    const page = previousPage(meta, step, PAGE, earliestMs);
    if (!page) {
      earliestMs = meta.first; // nothing older exists; stop asking
      return;
    }

    const raw = await fetchRange(page.from, page.to);
    if (raw.length) {
      bars = prependBars(toSeries(raw), bars);
      earliestMs = page.from;
      render();
    } else {
      earliestMs = meta.first;
    }
  } catch (err) {
    setError(err);
  } finally {
    loadingPage = false;
  }
}

/* ─── Drawing wiring ────────────────────────────────────────────────────── */

/** Pointer position relative to the chart pane. */
function localPoint(event) {
  const rect = overlayEl.value.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function paneSize() {
  const rect = overlayEl.value?.getBoundingClientRect();
  return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
}

/* While a tool is armed, the chart must not pan or zoom under the pointer —
 * otherwise dragging out a rectangle scrolls the chart instead. */
watch(() => draw.activeTool.value, (tool) => {
  const drawing = tool !== 'cursor';
  chart.value?.applyOptions({
    handleScroll: !drawing,
    handleScale: !drawing,
  });
});

/* Only the primary button draws and drags. The secondary one opens the
 * context menu, and capturing it here would drag the very drawing that was
 * right-clicked out from under the menu that is about to cover it. */
function onOverlayDown(event) {
  if (event.button !== 0) return;
  overlayEl.value.setPointerCapture(event.pointerId);
  const p = localPoint(event);
  /* The close button first of all: it sits on the entry line, so the level
   * under it would otherwise take the press and start a drag. */
  if (overClose(p)) {
    pendingClose.value = true;
    return;
  }
  /* Then the button that cancels a waiting order, for the same reason: it sits
   * on that order's line, which would otherwise take the press. */
  const cancel = cancelUnder(p);
  if (cancel) {
    pendingCancel.value = cancel.id;
    return;
  }
  /* Then the open position's levels, which sit above everything drawn by hand
   * — a stop that could not be grabbed because a trend line happened to run
   * under it would be the wrong way round — and then the waiting orders, which
   * are below a live position's levels for the same reason in miniature: what
   * is on decides before what might be. */
  if (startLevelDrag(p)) return;
  if (startOrderDrag(p)) return;
  draw.onPointerDown(p.x, p.y, paneSize());
  syncDrawings();
}

function onOverlayMove(event) {
  const p = localPoint(event);
  if (levelDrag.value) {
    moveLevelDrag(p);
    return;
  }
  if (orderDrag.value) {
    moveOrderDrag(p);
    return;
  }
  /* The buttons are asked about before the lines they sit on, so that a button
   * which cannot be clicked because the line under it wants to be dragged is
   * never what gets built — see replayHover. */
  if (event.buttons === 0) setLevelHover(replayHover(p));
  // Shift locks the drag to one axis; the state is read per event rather than
  // tracked, so releasing the key mid-drag takes effect on the next move.
  draw.onPointerMove(p.x, p.y, paneSize(), event.shiftKey);
  syncDrawings();
}

/* A double-click ends a polyline or a path. The press that starts it has
 * already added its anchor, which is what the user meant — the last corner —
 * so finishing here keeps it rather than dropping it. */
function onOverlayDouble(event) {
  if (event.button !== 0) return;
  if (draw.finishPending()) syncDrawings();
}

function onOverlayUp(event) {
  if (event.button !== 0) return;
  if (overlayEl.value.hasPointerCapture(event.pointerId)) {
    overlayEl.value.releasePointerCapture(event.pointerId);
  }
  /* A button closes on the release, over itself: pressing it and sliding off
   * is how anyone takes back a click they did not mean, and this one liquidates
   * a position. */
  if (pendingClose.value) {
    pendingClose.value = false;
    if (overClose(localPoint(event))) closePosition();
    return;
  }
  if (pendingCancel.value !== null) {
    const id = pendingCancel.value;
    pendingCancel.value = null;
    if (cancelUnder(localPoint(event))?.id === id) cancelOrder(id);
    return;
  }
  if (levelDrag.value) {
    dropLevel();
    return;
  }
  if (orderDrag.value) {
    dropOrder();
    return;
  }
  draw.onPointerUp();
  syncDrawings();
}

/* Hit testing runs on plain mousemove over the chart host, which reaches this
 * handler even through the transparent overlay. That is what lets the overlay
 * stay out of the way until the pointer is actually over a drawing. */
/**
 * The bar under the crosshair, for the legend in the corner.
 *
 * Read off the series rather than off `bars`, because the series is what the
 * crosshair is actually pointing at — a lookup by index would have to repeat
 * the mapping from a pixel to a bar that the chart has already done, and would
 * disagree with it at the edges.
 *
 * Null whenever the pointer is off the chart, which is what makes the legend
 * fall back to the bar at the right edge.
 */
const hoverBar = ref(null);

function onCrosshairMove(param) {
  if (!param?.time || !param.point) {
    hoverBar.value = null;
    return;
  }
  /* Off `bars` rather than off the series. The series holds whatever the
   * chosen style draws — a single value for a line, an average for Heikin
   * Ashi — and the legend has to say what the market did, not what the picture
   * shows. It is also the only source that still has an open and a high when
   * the style is a line. */
  const bar = barAt(param.time);
  hoverBar.value = bar ? {
    time: bar.time * 1000,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume ?? null,
  } : null;
}

/**
 * The bar at a given time, by binary search.
 *
 * A scan would be run on every pointer move over a window that is a couple of
 * thousand bars, which is the one place in this component where that shows.
 */
function barAt(time) {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time === time) return bars[mid];
    if (bars[mid].time < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function onHostMove(event) {
  if (!overlayEl.value || levelDrag.value || orderDrag.value) return;
  const p = localPoint(event);
  // Asked about first: these are on top of everything, so they decide the
  // cursor even where a drawing is under the pointer as well.
  setLevelHover(replayHover(p));
  draw.updateHover(p.x, p.y, paneSize());
}

/**
 * Puts the chart on a finished trade the history has been asked about.
 *
 * A list of timestamps that cannot be got to is a receipt, not a review — the
 * whole reason to look at a trade again is to see where it went in against
 * what the market did next, and that is on the chart.
 *
 * The view is moved, never the playhead. Nothing about the session changes:
 * the account is where it is, the bars that are revealed are the ones that
 * were revealed, and scrolling back to look at something is exactly as safe as
 * scrolling back with the mouse.
 *
 * Framed on the trade with as much room round it as the trade itself takes, so
 * a scalp is not shown at a zoom where the candles are lines and a trade held
 * for two days still has its context.
 */
watch(() => replay.focusedTrade, (n) => {
  if (n == null || !chart.value || bars.length === 0) return;
  const trade = replay.trades.find((t) => t.n === n);
  if (!trade) return;

  const from = barIndexAt(replay.bars, trade.openedAt);
  const to = barIndexAt(replay.bars, trade.closedAt);
  const pad = Math.max(12, (to - from) * 0.6);
  chart.value.timeScale().setVisibleLogicalRange({
    from: Math.max(0, from - pad),
    to: Math.min(bars.length + 8, to + pad),
  });
});

/* Colour goes through setColor, which also arms it for the next drawing; the
 * rest go through setLineStyle, which does the same for width and dash. */
function onLineStyle(patch) {
  if (patch.color !== undefined) draw.setColor(patch.color);
  const { color, ...stroke } = patch;
  if (Object.keys(stroke).length > 0) draw.setLineStyle(stroke);
  syncDrawings();
}

/* Colour goes through setColor for the same reason as above; the rest are
 * per-annotation settings that also arm themselves for the next one. */
function onTextStyle(patch) {
  if (patch.color !== undefined) draw.setColor(patch.color);
  const { color, ...rest } = patch;
  if (Object.keys(rest).length > 0) draw.setTextStyle(rest);
  syncDrawings();
}

function onTextCommit(value) {
  draw.commitText(value);
  syncDrawings();
}

function onTextCancel() {
  draw.cancelText();
  syncDrawings();
}

function onTextEdit(id) {
  draw.editText(id);
  syncDrawings();
}

function onToolbarMagnet() {
  draw.cycleMagnet();
}

function onUndo() {
  if (draw.undo()) syncDrawings();
}

function onRedo() {
  if (draw.redo()) syncDrawings();
}

function onToolbarStay() {
  draw.setStayArmed(!draw.stayArmed.value);
}

function onToolbarLockAll() {
  draw.setAllLocked(!allLocked.value);
  syncDrawings();
}

/** Whether the user is typing somewhere a keystroke must not be stolen from. */
function inTextField() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    // The annotation editor owns Escape while it is open; it stops the event
    // itself, so reaching here means there is no editor to close.
    draw.cancelGesture();
    draw.setTool('cursor');
    syncDrawings();
    return;
  }
  /* Undo and redo. Never while a field has focus: a textarea has its own undo
   * stack, and taking Ctrl+Z off it to move a level somewhere else on the chart
   * would be the wrong answer to the keystroke every time. */
  if ((event.ctrlKey || event.metaKey) && !inTextField()) {
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      onUndo();
      return;
    }
    if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      onRedo();
      return;
    }
  }
  /* Enter ends an open-ended shape — a polyline has no last click, so
   * something has to say when it is done. Only when one is actually being
   * built, or Enter would be stolen from every form in the app. */
  if (event.key === 'Enter' && !inTextField()) {
    if (draw.finishPending()) {
      event.preventDefault();
      syncDrawings();
    }
    return;
  }
  // A one-key magnet, the way every terminal has one. Not while typing, and
  // not as part of a shortcut.
  if ((event.key === 'm' || event.key === 'M') && !event.ctrlKey && !event.metaKey
    && !event.altKey && !inTextField()) {
    draw.cycleMagnet();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    // Never steal the key from a field the user is typing in.
    if (inTextField()) return;
    if (draw.deleteSelected()) {
      event.preventDefault();
      syncDrawings();
    }
  }
}

/** Pushes the current drawing state into the primitive and repaints. */
function syncDrawings() {
  drawPrimitive?.update({
    // What is on the chart, not what is stored: a drawing that has been put
    // away is not painted and, in useDrawings.findAt, cannot be grabbed either.
    drawings: draw.visibleDrawings(),
    draft: draw.draft.value,
    selectedId: draw.selectedId.value,
  });
  // A span that moved needs a new profile; everything else is a no-op by key.
  scheduleRangeProfiles();
}

function onToolbarTool(tool) {
  draw.setTool(tool);
  syncDrawings();
}

function onToolbarColor(color) {
  draw.setColor(color);
  syncDrawings();
}

function onPositionStyle(patch) {
  draw.setPositionStyle(patch);
  syncDrawings();
}

/* Nothing to repaint: the setting changes what the next click picks up, not
 * what is already on the chart. */
function onFvgStyle(patch) {
  draw.setFvgStyle(patch);
}

/* The buttons ask; the Delete key does not. Pressing Delete means selecting a
 * drawing and reaching for a specific key, which is already deliberate — and a
 * prompt on every press would make tidying up a chart painful. A button is
 * clickable by accident, and "clear" takes every drawing on the symbol with
 * it, so those are the ones worth interrupting. */
function onToolbarDelete() {
  if (!hasSelection.value) return;
  pendingDelete.value = 'one';
}

function onToolbarClear() {
  if (drawingCount.value === 0) return;
  pendingDelete.value = 'all';
}

function confirmDelete() {
  const what = pendingDelete.value;
  pendingDelete.value = null;
  if (what === 'one') draw.deleteSelected();
  else if (what === 'all') draw.clearAll();
  else if (what) draw.remove(what);
  syncDrawings();
}

/* ─── The object list ──────────────────────────────────────────────────────
 *
 * The list lives in the instrument bar and the drawings live here, so the
 * component is teleported up and these are what it calls back into. Each of
 * them ends in `syncDrawings`, which is what actually moves the picture: the
 * primitive is handed the visible set, so hiding and showing go through the
 * same one path a delete does.
 */

function onObjectToggle(id) {
  draw.toggleHidden(id);
  syncDrawings();
}

function onObjectLock(id) {
  draw.toggleLocked(id);
  syncDrawings();
}

function onObjectsToggleAll() {
  draw.setAllHidden(!draw.allHidden.value);
  syncDrawings();
}

/**
 * Points the chart at a drawing from the list.
 *
 * Arms the cursor on the way, because a selection made while a tool is armed
 * is cleared by the next click — which would make picking something out of the
 * list look like it had done nothing. A drawing that is put away is brought
 * back first: selecting something invisible would show handles floating on
 * their own.
 */
function onObjectSelect(id) {
  const drawing = draw.drawings.value.find((d) => d.id === id);
  if (!drawing) return;
  if (draw.allHidden.value) draw.setAllHidden(false);
  if (drawing.hidden) draw.setHidden(id, false);
  draw.setTool('cursor');
  draw.selectedId.value = id;
  syncDrawings();
}

/* Through the same prompt every other removal in the app goes through — see
 * ConfirmModal. The id is what is pending, so the modal can name it. */
function onObjectRemove(id) {
  pendingDelete.value = id;
}

onMounted(() => {
  chart.value = createChart(host.value, {
    autoSize: true,
    layout: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
    rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.26 } },
    timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 6 },
    crosshair: { mode: 0 },
    localization: { locale: 'en-GB' },
  });

  volume.value = chart.value.addSeries(HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
  });
  chart.value.priceScale('volume').applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 },
  });

  fvgPrimitive = new FvgPrimitive();

  rangePrimitive = new RangeProfilePrimitive();
  rangePrimitive.project = draw.project;

  rangeIndicatorPrimitive = new RangePrimitive();
  sessionPrimitive = new SessionPrimitive();
  huntPrimitive = new HuntPrimitive();
  setupPrimitive = new SetupPrimitive();

  vpPrimitive = new VolumeProfilePrimitive({
    width: session.volumeProfile.width,
    showLabels: session.volumeProfile.showLabels,
    mode: session.volumeProfile.mode,
  });

  replayPrimitive = new ReplayPrimitive();

  drawPrimitive = new DrawingPrimitive();
  drawPrimitive.project = draw.project;
  drawPrimitive.barsBetween = draw.barsBetween;
  // The regression channel, the anchored VWAP and the bars pattern are fitted
  // to the data rather than to the anchors, so they need the bars themselves.
  drawPrimitive.bars = () => bars;

  /* Paint order, back to front: context first, then what is live, then what is
   * being drawn by hand. The list is what `mountPriceSeries` re-attaches, so
   * the order survives a change of chart style. */
  primitives = [
    fvgPrimitive, rangePrimitive, rangeIndicatorPrimitive, sessionPrimitive,
    huntPrimitive, setupPrimitive, vpPrimitive, replayPrimitive, drawPrimitive,
  ];

  mountPriceSeries();

  host.value.addEventListener('mousemove', onHostMove);
  chart.value.subscribeCrosshairMove(onCrosshairMove);
  window.addEventListener('keydown', onKeyDown);
  chart.value.subscribeClick(onChartClick);

  applyTheme();

  chart.value.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (range && range.from < 30) loadOlder();
    if (session.volumeProfile.enabled && session.volumeProfile.range === 'visible') {
      scheduleProfile();
    }
  });

  // Re-read the palette whenever the theme class flips.
  themeObserver = new MutationObserver(() => {
    applyTheme();
    render();
    drawPrimitive?.repaint(); // drawings read their colours from the tokens too
    rangePrimitive?.repaint();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  loadInitial();
});

onBeforeUnmount(() => {
  /* The header reads this, and the header outlives the chart. A price left
     behind would sit above a view that is no longer showing it. */
  setQuote(null);
  clearTimeout(profileTimer);
  clearTimeout(rangeTimer);
  chart.value?.unsubscribeClick(onChartClick);
  chart.value?.unsubscribeCrosshairMove(onCrosshairMove);
  themeObserver?.disconnect();
  host.value?.removeEventListener('mousemove', onHostMove);
  window.removeEventListener('keydown', onKeyDown);
  chart.value?.remove();
  chart.value = null;
  indicatorSeries.clear();
});

/* A different shape for the same bars: the series is replaced, the primitives
 * move across with it, and nothing about the window or the account changes. */
watch(() => session.chartStyle, () => {
  if (chart.value) mountPriceSeries();
});

watch(() => [props.symbol, props.timeframe], loadInitial);

/* Drawings belong to the symbol, so they reload on a symbol change but survive
 * a timeframe switch — a level drawn on the 15m stays put on the 4h. */
watch(() => props.symbol, async () => {
  rangeProfiles.clear();
  await draw.load();
  syncDrawings();
}, { immediate: true });

watch(() => session.indicators, syncIndicators, { deep: true });

/* Every reveal, every appended chunk, and the moment a session starts or
 * stops. Starting or stopping goes through loadInitial, which decides between
 * the replay window and normal paging; the rest only redraw. */
watch(() => replay.active, () => {
  replayShown = -1;
  forgetLevels();
  closeMenu();
  loadInitial();
});
watch(() => [replay.index, replay.barsVersion], () => {
  if (!replay.active) return;
  applyReplayBars();
});

/* An order placed or cancelled changes nothing about the bars, so the marks
 * are pushed on their own rather than through a redraw. */
watch(() => [
  replay.positions, replay.activePositionId, replay.orders, replay.showClosedTrades,
  replay.focusedTrade, replay.hoveredTrade,
], () => {
  /* A refusal was about a level on an account that has since moved on; it has
   * had its bar to be read on. */
  levelNotice.value = null;
  pushReplayMarks();
}, { deep: true });
watch(
  () => {
    const v = session.volumeProfile;
    return [v.enabled, v.bins, v.valueArea, v.distribution, v.range];
  },
  updateProfile,
);
// The same three settings decide how a range profile is binned.
watch(
  () => {
    const v = session.volumeProfile;
    return [v.bins, v.valueArea, v.distribution];
  },
  scheduleRangeProfiles,
);
// Display-only options repaint the existing profile instead of refetching it.
watch(
  () => [session.volumeProfile.width, session.volumeProfile.showLabels, session.volumeProfile.mode],
  ([width, showLabels, mode]) => vpPrimitive?.setOptions({ width, showLabels, mode }),
);

defineExpose({ reload: loadInitial });
</script>

<template>
  <!-- The rail belongs to the drawing state, which lives here, but it belongs
       on the screen at the left edge of the workspace — outside the side panel,
       the way a terminal keeps it. Teleported rather than lifted: moving the
       component up would mean routing four props and four events through
       App.vue, which owns none of them and would have to learn about tools to
       pass them along. The target is a slot App.vue keeps as the first column
       of the workspace.

       `defer` is not optional: the target is rendered by Vue in the same pass
       as this chart, and a plain Teleport resolves its selector against the
       document while that pass is still building the tree in memory — so it
       would find nothing and warn. Deferred, the lookup happens after the
       cycle, by which time the slot is in the document. -->
  <Teleport defer to="#tool-rail">
    <DrawingToolbar
      :active-tool="draw.activeTool.value"
      :active-color="draw.activeColor.value"
      :has-selection="hasSelection"
      :count="draw.drawings.value.length"
      :magnet="draw.magnet.value"
      :stay-armed="draw.stayArmed.value"
      :can-undo="draw.canUndo.value"
      :can-redo="draw.canRedo.value"
      :all-hidden="draw.allHidden.value"
      :all-locked="allLocked"
      @select-tool="onToolbarTool"
      @select-color="onToolbarColor"
      @delete="onToolbarDelete"
      @clear="onToolbarClear"
      @cycle-magnet="onToolbarMagnet"
      @toggle-stay="onToolbarStay"
      @undo="onUndo"
      @redo="onRedo"
      @toggle-all-hidden="onObjectsToggleAll"
      @toggle-all-locked="onToolbarLockAll"
    />
  </Teleport>

  <!-- The object list belongs to the drawings, which live here, and belongs on
       the screen in the instrument bar's tool cluster. Teleported for the same
       reason and in the same way as the rail above. -->
  <Teleport defer to="#chart-tools">
    <ChartObjects
      :drawings="draw.drawings.value"
      :selected-id="draw.selectedId.value"
      :all-hidden="draw.allHidden.value"
      @toggle="onObjectToggle"
      @lock="onObjectLock"
      @edit="onTextEdit"
      @remove="onObjectRemove"
      @select="onObjectSelect"
      @toggle-all="onObjectsToggleAll"
      @clear="onToolbarClear"
    />
  </Teleport>

  <div class="chart-area">
    <div
      class="chart-wrap"
      :class="{ 'is-trading': replay.active }"
      @contextmenu="onContextMenu"
    >
      <div ref="host" class="chart-host"></div>

      <!-- Over the chart in the top left corner, where a terminal keeps it.
           Takes no pointer events; see ChartLegend. -->
      <ChartLegend
        :symbol="props.symbol"
        :timeframe="props.timeframe"
        :bar="hoverBar"
      />

      <!-- Transparent until the pointer is over something it can take hold of —
           a drawing, or one of a running replay's levels — or until a tool is
           armed; see useDrawings.js for why it cannot simply always be on. -->
      <div
        ref="overlayEl"
        class="chart-overlay"
        :style="{
          pointerEvents: overlayOn ? 'auto' : 'none',
          cursor: overlayCursor,
        }"
        @pointerdown="onOverlayDown"
        @pointermove="onOverlayMove"
        @pointerup="onOverlayUp"
        @pointercancel="onOverlayUp"
        @dblclick="onOverlayDouble"
      ></div>

      <!-- Over the anchor of the annotation being typed into. Inside the chart
           wrapper, because the anchor was measured against it. -->
      <TextEditBox
        :target="draw.editing.value"
        :value="editingDrawing?.text ?? ''"
        :font-size="editingDrawing?.fontSize ?? 'md'"
        :bold="editingDrawing?.bold ?? false"
        :italic="editingDrawing?.italic ?? false"
        :glyphs="editingDrawing ? specFor(editingDrawing.type)?.glyphs ?? [] : []"
        @commit="onTextCommit"
        @cancel="onTextCancel"
      />

      <PositionStyleBar
        v-if="selectedPosition"
        :profit-color="selectedPosition.profitColor"
        :loss-color="selectedPosition.lossColor"
        :fill-opacity="selectedPosition.fillOpacity"
        @update="onPositionStyle"
      />

      <LineStyleBar
        v-if="selectedLine"
        :color="selectedLine.color"
        :width="selectedLine.width"
        :line-style="selectedLine.lineStyle"
        @update="onLineStyle"
      />

      <TextStyleBar
        v-if="selectedText"
        :color="selectedText.color"
        :font-size="selectedText.fontSize"
        :bold="selectedText.bold"
        :italic="selectedText.italic"
        :boxed="selectedText.boxed"
        @update="onTextStyle"
        @edit="onTextEdit(selectedText.id)"
      />

      <!-- Armed rather than selected: this one says what the next click picks
           up. Arming a tool clears the selection, so it cannot collide with
           the two bars above it. -->
      <FvgToolBar
        v-if="draw.activeTool.value === 'fvg'"
        :merge-wick="draw.fvgStyle.value.mergeWick"
        :merge-unit="draw.fvgStyle.value.mergeUnit"
        @update="onFvgStyle"
      />

      <!-- Only while there is an account for an order to go to. In the bottom
           left, because the three bars above share the top left corner and this
           one is on screen at the same time as any of them. -->
      <QuickTradeBar v-if="replay.active" />

      <ConfirmModal
        :open="pendingDelete !== null"
        :title="pendingDelete === 'all' ? 'Remove every drawing?' : 'Delete this drawing?'"
        :message="pendingDelete === 'all'
          ? `All ${drawingCount} drawing${drawingCount === 1 ? '' : 's'} on `
            + `${session.symbol ?? 'this symbol'} will be removed. This cannot be undone.`
          : `${pendingName} will be removed. This cannot be undone.`"
        :confirm-label="pendingDelete === 'all' ? 'Remove all' : 'Delete'"
        @confirm="confirmDelete"
        @cancel="pendingDelete = null"
      />

      <div v-if="chartStatus" class="chart-status k-mono-label">{{ chartStatus }}</div>

      <ChartContextMenu
        :open="menu.open"
        :x="menu.x"
        :y="menu.y"
        :title="menu.title"
        :items="menu.items"
        @select="onMenuSelect"
        @close="closeMenu"
      />
    </div>
  </div>
</template>

<style scoped>
/* Nothing here is inset from anything: the chart is the desk, and it runs to
   the edges of the space it is given. The drawing rail used to be the first
   column of this box; it is teleported to the left edge of the workspace now,
   which is where the tools belong relative to everything, not only relative to
   the chart. */
.chart-area {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.chart-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  background: var(--chart-bg);

  /* Where the floating bars start, under the legend in the same corner. One
     variable because there are three of them and they must not overlap: the
     legend is always up, the quick bar is up whenever a session runs, and one
     style bar at a time sits under whichever of those is there. */
  --overlay-top: 70px;
}

.chart-wrap :deep(.quick-bar),
.chart-wrap :deep(.style-bar) { top: var(--overlay-top); }
/* The quick bar takes that slot while a session runs, so a style bar steps
   down past it — 40px of bar plus the gap. */
.chart-wrap.is-trading :deep(.style-bar) { top: calc(var(--overlay-top) + 46px); }

.chart-host {
  position: absolute;
  inset: 0;
}
.chart-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
}
.chart-status {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  color: var(--faint);
}
</style>
