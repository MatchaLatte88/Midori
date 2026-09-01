<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { CandlestickSeries, HistogramSeries, LineSeries, createChart } from 'lightweight-charts';
import { INDICATORS, computeIndicator } from '../../shared/indicators/index.js';
import { VolumeProfilePrimitive } from './chart/volumeProfilePrimitive.js';
import { FvgPrimitive } from './chart/fvgPrimitive.js';
import {
  RangeProfilePrimitive, profileWindow, windowKey,
} from './chart/rangeProfilePrimitive.js';
import { RangePrimitive } from './chart/rangePrimitive.js';
import { ReplayPrimitive } from './chart/replayPrimitive.js';
import { draggableLevels, levelAt, levelRefusal } from './chart/replayLevels.js';
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
import FvgToolBar from './FvgToolBar.vue';
import { ENTRY, STOP, TARGET, isPositionTool } from './chart/drawings/model.js';
import { orderFromPlan } from '../../shared/engine/plannedTrade.js';
import { latestPage, prependBars, previousPage } from './chart/barPaging.js';
import { datasetFor, session, setError, setVolumeProfile } from '../stores/session.js';
import {
  deliverPrice, placeFromPlan, protectPosition, replay, replayMarks, takeEnteredPlans,
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
  onError: setError,
});

const overlayEl = ref(null);
const hasSelection = computed(() => draw.selectedId.value !== null);

/* Which destructive action is waiting on an answer: 'one', 'all', or null.
 * A string rather than two booleans, because the two prompts can never be
 * open at once and two flags could disagree about that. */
const pendingDelete = ref(null);

const drawingCount = computed(() => draw.drawings.value.length);

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

/* The stroke bar covers everything that is not a position block. The two are
 * mutually exclusive by construction, so they can share a corner. */
const selectedLine = computed(() => {
  const selected = draw.drawings.value.find((d) => d.id === draw.selectedId.value);
  return selected && !isPositionTool(selected.type) ? selected : null;
});

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
    upBody: v('--candle-up-body'),
    upBrd: v('--candle-up-brd'),
    upWick: v('--candle-up-wick'),
    downBody: v('--candle-down-body'),
    downBrd: v('--candle-down-brd'),
    downWick: v('--candle-down-wick'),
    volUp: v('--vol-up'),
    volDown: v('--vol-down'),
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
      vertLine: { color: p.cross, labelBackgroundColor: p.downBody },
      horzLine: { color: p.cross, labelBackgroundColor: p.downBody },
    },
  });
  candles.value?.applyOptions({
    upColor: p.upBody,
    downColor: p.downBody,
    borderUpColor: p.upBrd,
    borderDownColor: p.downBrd,
    wickUpColor: p.upWick,
    wickDownColor: p.downWick,
    borderVisible: true,
  });
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

function render() {
  const p = palette(); // once per render, not once per bar
  candles.value.setData(bars.map(({ volume: _v, ...b }) => b));
  volume.value.setData(bars.map((b) => ({
    time: b.time,
    value: b.volume,
    color: b.close >= b.open ? p.volUp : p.volDown,
  })));
  buildIndicatorBars();
  syncIndicators();
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
    return;
  }

  const wanted = replay.index + 1;
  const appending = wanted === replayShown + 1 && bars.length === replayShown;

  if (appending) {
    const [bar] = toSeries([full[replay.index]]);
    const p = palette();
    bars.push(bar);
    indicatorBars.push({ ...bar, time: bar.time * 1000 });
    candles.value.update({
      time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    });
    volume.value.update({
      time: bar.time,
      value: bar.volume,
      color: bar.close >= bar.open ? p.volUp : p.volDown,
    });
    syncIndicators();
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

/** The open position and the working orders, for the primitive to paint. */
function pushReplayMarks() {
  replayPrimitive?.setMarks(replay.active ? replayMarks() : null, replay.bars, levelDrag.value);
}

/* ─── Taking hold of the position's levels ──────────────────────────────────
 *
 * A stop is moved by looking at the chart and putting it where it belongs, not
 * by typing a number into a ticket, so the two lines the open position draws
 * can be dragged. Nothing about the account changes while the pointer is down:
 * the drag is a preview the primitive paints, and only the drop replaces the
 * protection — through protectPosition, so a level moved by hand becomes
 * exactly the order a level typed in becomes, live from the next bar like
 * everything else.
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

/** Where the open position's levels are on screen, and how far they run. */
function levelTargets() {
  const position = replay.position;
  if (!replay.active || !position || !candles.value || !chart.value) return null;

  const levels = [];
  for (const { field, price } of draggableLevels(position)) {
    const y = candles.value.priceToCoordinate(price);
    if (y != null) levels.push({ field, y });
  }
  if (levels.length === 0) return null;

  /* From the bar the position was opened on, because that is where the block
   * starts: a grab to the left of it would be a grab at nothing. */
  const entry = draw.project({ time: position.openedAt, price: position.entryPrice });
  /* The pane's width, not the element's: the lines stop where the price scale
   * begins, and a band of the axis that could not be dragged because a level
   * happens to run across it would be a strange thing to have built. */
  return { levels, extent: { left: entry?.x ?? 0, right: chart.value.paneSize().width } };
}

/**
 * The level a pointer has hold of, or null.
 *
 * Never while a tool is armed, and never while the ticket is waiting for a
 * price: both mean the next click was already promised to something else.
 */
function levelUnder(point) {
  if (draw.activeTool.value !== 'cursor' || replay.picking) return null;
  const targets = levelTargets();
  return targets ? levelAt(point, targets.extent, targets.levels) : null;
}

function startLevelDrag(point) {
  const field = levelUnder(point);
  if (!field) return false;
  levelNotice.value = null;
  levelDrag.value = { field, price: replay.position[field] };
  pushReplayMarks();
  return true;
}

function moveLevelDrag(point) {
  const price = candles.value?.coordinateToPrice(point.y);
  if (price == null) return;
  levelDrag.value = { ...levelDrag.value, price };
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

  /* Pressed and let go without moving: a click on the line, not a new level.
   * Committing it anyway would cancel and re-place the same two orders, and the
   * stored session would carry the churn. */
  if (price === position[field]) {
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
  });
  pushReplayMarks();
}

/** Nothing left to hold on to: the session ended, or the view was left. */
function forgetLevels() {
  levelDrag.value = null;
  levelHover.value = null;
  levelNotice.value = null;
}

/* The overlay takes pointer events for the drawing tools and for these levels;
 * either is reason enough. The level wins the cursor because it is the thing
 * on top. */
const overlayOn = computed(() => draw.overlayActive.value || levelHover.value !== null);
const overlayCursor = computed(() => (
  levelDrag.value || levelHover.value ? 'ns-resize' : draw.cursorStyle.value
));

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
  /* The open position's levels sit above everything drawn by hand, so they get
   * the press first — a stop that could not be grabbed because a trend line
   * happened to run under it would be the wrong way round. */
  if (startLevelDrag(p)) return;
  draw.onPointerDown(p.x, p.y, paneSize());
  syncDrawings();
}

function onOverlayMove(event) {
  const p = localPoint(event);
  if (levelDrag.value) {
    moveLevelDrag(p);
    return;
  }
  /* The overlay swallows the host's mousemove while it is switched on, so the
   * hover has to be kept current from here as well — otherwise a level, once
   * hovered, would stay hovered for good. Not while anything is being dragged:
   * a drawing pulled across a level must not take its cursor. */
  if (event.buttons === 0) levelHover.value = levelUnder(p);
  // Shift locks the drag to one axis; the state is read per event rather than
  // tracked, so releasing the key mid-drag takes effect on the next move.
  draw.onPointerMove(p.x, p.y, paneSize(), event.shiftKey);
  syncDrawings();
}

function onOverlayUp(event) {
  if (event.button !== 0) return;
  if (overlayEl.value.hasPointerCapture(event.pointerId)) {
    overlayEl.value.releasePointerCapture(event.pointerId);
  }
  if (levelDrag.value) {
    dropLevel();
    return;
  }
  draw.onPointerUp();
  syncDrawings();
}

/* Hit testing runs on plain mousemove over the chart host, which reaches this
 * handler even through the transparent overlay. That is what lets the overlay
 * stay out of the way until the pointer is actually over a drawing. */
function onHostMove(event) {
  if (!overlayEl.value || levelDrag.value) return;
  const p = localPoint(event);
  // Asked about first: a level is on top of everything, so it decides the
  // cursor even where a drawing is under the pointer as well.
  levelHover.value = levelUnder(p);
  draw.updateHover(p.x, p.y, paneSize());
}

/* Colour goes through setColor, which also arms it for the next drawing; the
 * rest go through setLineStyle, which does the same for width and dash. */
function onLineStyle(patch) {
  if (patch.color !== undefined) draw.setColor(patch.color);
  const { color, ...stroke } = patch;
  if (Object.keys(stroke).length > 0) draw.setLineStyle(stroke);
  syncDrawings();
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    draw.cancelGesture();
    draw.setTool('cursor');
    syncDrawings();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    // Never steal the key from a field the user is typing in.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (draw.deleteSelected()) {
      event.preventDefault();
      syncDrawings();
    }
  }
}

/** Pushes the current drawing state into the primitive and repaints. */
function syncDrawings() {
  drawPrimitive?.update({
    drawings: draw.drawings.value,
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
  syncDrawings();
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

  candles.value = chart.value.addSeries(CandlestickSeries, {});
  volume.value = chart.value.addSeries(HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
  });
  chart.value.priceScale('volume').applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 },
  });

  fvgPrimitive = new FvgPrimitive();
  candles.value.attachPrimitive(fvgPrimitive);

  rangePrimitive = new RangeProfilePrimitive();
  rangePrimitive.project = draw.project;
  candles.value.attachPrimitive(rangePrimitive);

  rangeIndicatorPrimitive = new RangePrimitive();
  candles.value.attachPrimitive(rangeIndicatorPrimitive);

  sessionPrimitive = new SessionPrimitive();
  candles.value.attachPrimitive(sessionPrimitive);

  huntPrimitive = new HuntPrimitive();
  candles.value.attachPrimitive(huntPrimitive);

  setupPrimitive = new SetupPrimitive();
  candles.value.attachPrimitive(setupPrimitive);

  vpPrimitive = new VolumeProfilePrimitive({
    width: session.volumeProfile.width,
    showLabels: session.volumeProfile.showLabels,
    mode: session.volumeProfile.mode,
  });
  candles.value.attachPrimitive(vpPrimitive);

  replayPrimitive = new ReplayPrimitive();
  candles.value.attachPrimitive(replayPrimitive);

  drawPrimitive = new DrawingPrimitive();
  drawPrimitive.project = draw.project;
  drawPrimitive.barsBetween = draw.barsBetween;
  candles.value.attachPrimitive(drawPrimitive);

  host.value.addEventListener('mousemove', onHostMove);
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
  clearTimeout(profileTimer);
  clearTimeout(rangeTimer);
  chart.value?.unsubscribeClick(onChartClick);
  themeObserver?.disconnect();
  host.value?.removeEventListener('mousemove', onHostMove);
  window.removeEventListener('keydown', onKeyDown);
  chart.value?.remove();
  chart.value = null;
  indicatorSeries.clear();
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
watch(() => [replay.position, replay.orders], () => {
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
  <div class="chart-area">
    <DrawingToolbar
      :active-tool="draw.activeTool.value"
      :active-color="draw.activeColor.value"
      :has-selection="hasSelection"
      :count="draw.drawings.value.length"
      @select-tool="onToolbarTool"
      @select-color="onToolbarColor"
      @delete="onToolbarDelete"
      @clear="onToolbarClear"
    />

    <div class="chart-wrap" @contextmenu="onContextMenu">
      <div ref="host" class="chart-host"></div>

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
      ></div>

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

      <!-- Armed rather than selected: this one says what the next click picks
           up. Arming a tool clears the selection, so it cannot collide with
           the two bars above it. -->
      <FvgToolBar
        v-if="draw.activeTool.value === 'fvg'"
        :merge-wick="draw.fvgStyle.value.mergeWick"
        :merge-unit="draw.fvgStyle.value.mergeUnit"
        @update="onFvgStyle"
      />

      <ConfirmModal
        :open="pendingDelete !== null"
        :title="pendingDelete === 'all' ? 'Remove every drawing?' : 'Delete this drawing?'"
        :message="pendingDelete === 'all'
          ? `All ${drawingCount} drawing${drawingCount === 1 ? '' : 's'} on `
            + `${session.symbol ?? 'this symbol'} will be removed. This cannot be undone.`
          : 'The selected drawing will be removed. This cannot be undone.'"
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
.chart-area {
  display: flex;
  gap: 8px;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.chart-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  border: 1px solid var(--chart-brd);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--chart-bg);
}
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
  color: var(--sec);
}
</style>
