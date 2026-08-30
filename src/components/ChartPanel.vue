<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { CandlestickSeries, HistogramSeries, LineSeries, createChart } from 'lightweight-charts';
import { INDICATORS, computeIndicator } from '../../shared/indicators/index.js';
import { VolumeProfilePrimitive } from './chart/volumeProfilePrimitive.js';
import { FvgPrimitive } from './chart/fvgPrimitive.js';
import {
  RangeProfilePrimitive, profileWindow, windowKey,
} from './chart/rangeProfilePrimitive.js';
import { SessionPrimitive } from './chart/sessionPrimitive.js';
import { HuntPrimitive } from './chart/huntPrimitive.js';
import { DrawingPrimitive } from './chart/drawings/drawingPrimitive.js';
import { useDrawings } from './chart/drawings/useDrawings.js';
import DrawingToolbar from './DrawingToolbar.vue';
import PositionStyleBar from './PositionStyleBar.vue';
import { isPositionTool } from './chart/drawings/model.js';
import { latestPage, prependBars, previousPage } from './chart/barPaging.js';
import { datasetFor, session, setError, setVolumeProfile } from '../stores/session.js';

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

/* The style bar only makes sense while a position block is selected — for a
 * trend line there is nothing on it to set. */
const selectedPosition = computed(() => {
  const selected = draw.drawings.value.find((d) => d.id === draw.selectedId.value);
  return selected && isPositionTool(selected.type) ? selected : null;
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
  sessionPrimitive?.setGroups(sessionGroups);
  huntPrimitive?.setGroups(huntGroups);
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

function onOverlayDown(event) {
  overlayEl.value.setPointerCapture(event.pointerId);
  const p = localPoint(event);
  draw.onPointerDown(p.x, p.y, paneSize());
  syncDrawings();
}

function onOverlayMove(event) {
  const p = localPoint(event);
  draw.onPointerMove(p.x, p.y, paneSize());
  syncDrawings();
}

function onOverlayUp(event) {
  if (overlayEl.value.hasPointerCapture(event.pointerId)) {
    overlayEl.value.releasePointerCapture(event.pointerId);
  }
  draw.onPointerUp();
  syncDrawings();
}

/* Hit testing runs on plain mousemove over the chart host, which reaches this
 * handler even through the transparent overlay. That is what lets the overlay
 * stay out of the way until the pointer is actually over a drawing. */
function onHostMove(event) {
  if (!overlayEl.value) return;
  const p = localPoint(event);
  draw.updateHover(p.x, p.y, paneSize());
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

function onToolbarDelete() {
  draw.deleteSelected();
  syncDrawings();
}

function onToolbarClear() {
  draw.clearAll();
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

  sessionPrimitive = new SessionPrimitive();
  candles.value.attachPrimitive(sessionPrimitive);

  huntPrimitive = new HuntPrimitive();
  candles.value.attachPrimitive(huntPrimitive);

  vpPrimitive = new VolumeProfilePrimitive({
    width: session.volumeProfile.width,
    showLabels: session.volumeProfile.showLabels,
    mode: session.volumeProfile.mode,
  });
  candles.value.attachPrimitive(vpPrimitive);

  drawPrimitive = new DrawingPrimitive();
  drawPrimitive.project = draw.project;
  drawPrimitive.barsBetween = draw.barsBetween;
  candles.value.attachPrimitive(drawPrimitive);

  host.value.addEventListener('mousemove', onHostMove);
  window.addEventListener('keydown', onKeyDown);

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

    <div class="chart-wrap">
      <div ref="host" class="chart-host"></div>

      <!-- Transparent until the pointer is over a drawing or a tool is armed;
           see useDrawings.js for why it cannot simply always be on. -->
      <div
        ref="overlayEl"
        class="chart-overlay"
        :style="{
          pointerEvents: draw.overlayActive.value ? 'auto' : 'none',
          cursor: draw.cursorStyle.value,
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

      <div v-if="status" class="chart-status k-mono-label">{{ status }}</div>
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
