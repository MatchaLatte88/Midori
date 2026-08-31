<script setup>
/* Stepping through the trades of a finished run, one chart at a time.
 *
 * A summary says a strategy lost; it never says why. Seeing the twenty bars
 * around an entry does — and doing that by hand, scrolling a year of chart to
 * a timestamp copied out of a table, is enough work that nobody does it. So
 * the chart goes to the trade instead.
 *
 * Only the window around the current trade is fetched, not the whole run. A
 * year of 5m is 105,000 bars; a trade needs about ninety of them, and paying
 * for the rest on the way to the first one would make the button feel broken.
 * How much chart that is comes from `stepMs`, which the engine reports and the
 * run stores — the alternative, a timeframe-to-milliseconds table copied into
 * the renderer, is the kind of duplicate that drifts.
 *
 * The bars are loaded again when the trade changes rather than cached. Each
 * window is one small IPC call, and a cache keyed by trade would hold the
 * whole run in memory again for a saving nobody would notice.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { CandlestickSeries, createChart, createSeriesMarkers } from 'lightweight-charts';
import { TradePrimitive, barIndexAt } from './chart/tradePrimitive.js';
import { setError } from '../stores/session.js';

const props = defineProps({
  run: { type: Object, required: true },
});

/** Bars of context before the entry and after the exit. */
const LEAD = 60;
const TRAIL = 25;
/* A run stored before the engine reported it has no step. One hour is a
 * reasonable guess that produces a usable window on every timeframe: too much
 * chart on 1m, too little on 1d, but never nothing. */
const FALLBACK_STEP = 3_600_000;

const host = ref(null);
const chart = shallowRef(null);
const candles = shallowRef(null);
const markers = shallowRef(null);
let tradePrimitive = null;

const index = ref(0);
const loading = ref(false);
let themeObserver = null;
/** Guards against a slow window arriving after the user has moved on. */
let token = 0;

const trades = computed(() => props.run?.trades ?? []);
const trade = computed(() => trades.value[index.value] ?? null);
const stepMs = computed(() => props.run?.stepMs || FALLBACK_STEP);

const canPrev = computed(() => index.value > 0);
const canNext = computed(() => index.value < trades.value.length - 1);

/** Reads the chart palette out of the CSS tokens, exactly as ChartPanel does. */
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
    pos: v('--pos'),
    neg: v('--neg'),
    txt: v('--txt'),
  };
}

function applyTheme() {
  if (!chart.value) return;
  const p = palette();
  chart.value.applyOptions({
    layout: { background: { color: p.bg }, textColor: p.text, attributionLogo: false },
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

onMounted(() => {
  chart.value = createChart(host.value, {
    autoSize: true,
    layout: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
    rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.12 } },
    timeScale: { timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
    localization: { locale: 'en-GB' },
  });
  candles.value = chart.value.addSeries(CandlestickSeries, {});
  markers.value = createSeriesMarkers(candles.value, []);

  tradePrimitive = new TradePrimitive();
  candles.value.attachPrimitive(tradePrimitive);

  applyTheme();
  themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  show();
});

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  themeObserver = null;
  tradePrimitive = null;
  chart.value?.remove();
  chart.value = null;
});

/* A different run means a different set of trades, so the position resets —
 * staying on trade 14 of a run that has nine would show nothing. */
watch(() => props.run?.id, () => {
  index.value = 0;
  show();
});

watch(index, show);

async function show() {
  const t = trade.value;
  if (!chart.value || !candles.value || !t) {
    tradePrimitive?.setTrade(null);
    candles.value?.setData([]);
    markers.value?.setMarkers([]);
    return;
  }

  const step = stepMs.value;
  const from = t.openedAt - LEAD * step;
  const to = t.closedAt + TRAIL * step;

  loading.value = true;
  const mine = ++token;
  try {
    const raw = await window.midori.data.bars({
      symbol: props.run.symbol,
      timeframe: props.run.timeframe,
      from,
      to,
      dropIncomplete: false,
    });
    // A newer trade was picked while this was in flight: its window wins.
    if (mine !== token || !chart.value) return;
    // No bars for this stretch — the data was deleted after the run, or never
    // covered it. Nothing to anchor a block or a marker to.
    if (raw.length === 0) {
      candles.value.setData([]);
      markers.value.setMarkers([]);
      tradePrimitive?.setTrade(null);
      return;
    }

    // The library works in seconds; everything else in the app is milliseconds.
    candles.value.setData(raw.map((b) => ({
      time: Math.floor(b.time / 1000),
      open: b.open, high: b.high, low: b.low, close: b.close,
    })));

    const p = palette();
    const long = t.side === 'long';
    const won = t.netPnl >= 0;

    const entryIdx = barIndexAt(raw, t.openedAt);
    const exitIdx = barIndexAt(raw, t.closedAt);

    /* The trade as a position block — the same shape the setup indicator and
     * the position tool draw, so the three read alike. */
    tradePrimitive?.setTrade({
      entryIndex: entryIdx,
      exitIndex: exitIdx,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      // Runs stored before the broker carried the bracket have neither.
      stop: t.stopLoss ?? null,
      target: t.takeProfit ?? null,
      side: t.side,
      // Net of fees: the number the account actually saw.
      pnl: t.netPnl,
      won,
    });

    /* Anchored to the bar that contains each fill, not to the fill's own
     * timestamp: with intrabar resolution that lands on a minute between two
     * bars, and a marker there has no bar to attach to. */
    markers.value.setMarkers([
      {
        time: Math.floor(raw[entryIdx].time / 1000),
        position: long ? 'belowBar' : 'aboveBar',
        color: p.txt,
        shape: long ? 'arrowUp' : 'arrowDown',
        text: long ? 'long' : 'short',
      },
      {
        time: Math.floor(raw[exitIdx].time / 1000),
        position: long ? 'aboveBar' : 'belowBar',
        color: won ? p.pos : p.neg,
        shape: 'circle',
        text: `${t.netPnl >= 0 ? '+' : ''}${t.netPnl.toFixed(2)}`,
      },
    ]);

    /* Framed on the trade with its context, rather than fitted to everything
     * loaded: the lead-in is there to be seen, not to be zoomed out of. */
    chart.value.timeScale().setVisibleRange({
      from: Math.floor((t.openedAt - LEAD * step) / 1000),
      to: Math.floor((t.closedAt + TRAIL * step) / 1000),
    });
  } catch (err) {
    if (mine === token) setError(err);
  } finally {
    if (mine === token) loading.value = false;
  }
}

const go = (i) => { index.value = Math.min(Math.max(i, 0), trades.value.length - 1); };

/* ─── Formatting ───────────────────────────────────────────────────────── */
const money = (v) => (v == null ? '—' : v.toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}));
const price = (v) => (v == null ? '—' : v.toLocaleString(undefined, {
  maximumFractionDigits: 8,
}));
const when = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
const held = (t) => {
  const minutes = (t.closedAt - t.openedAt) / 60_000;
  if (minutes < 90) return `${Math.round(minutes)}m`;
  const h = minutes / 60;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
};
</script>

<template>
  <section class="review">
    <header class="bar">
      <span class="k-eyebrow">Trade review</span>

      <div v-if="trades.length > 0" class="nav">
        <button class="btn btn--sm btn--default" :disabled="!canPrev" @click="go(0)" title="First">«</button>
        <button class="btn btn--sm btn--default" :disabled="!canPrev" @click="go(index - 1)">Prev</button>
        <span class="counter k-mono-label">{{ index + 1 }} / {{ trades.length }}</span>
        <button class="btn btn--sm btn--accent" :disabled="!canNext" @click="go(index + 1)">Next trade</button>
        <button class="btn btn--sm btn--default" :disabled="!canNext" @click="go(trades.length - 1)" title="Last">»</button>
      </div>
    </header>

    <p v-if="trades.length === 0" class="empty k-mono-label">This run took no trades.</p>

    <template v-else>
      <div v-if="trade" class="facts">
        <span class="side" :class="trade.side === 'long' ? 'is-long' : 'is-short'">
          {{ trade.side }}
        </span>
        <span class="k-mono-label">{{ when(trade.openedAt) }}</span>
        <span class="k-mono-label faint">held {{ held(trade) }}</span>
        <span class="k-mono-label">{{ price(trade.entryPrice) }} → {{ price(trade.exitPrice) }}</span>
        <span v-if="trade.entryTag" class="chip k-mono-label">{{ trade.entryTag }}</span>
        <span v-if="trade.exitTag" class="chip k-mono-label">{{ trade.exitTag }}</span>
        <span class="spacer"></span>
        <span class="pnl" :class="trade.netPnl >= 0 ? 'is-up' : 'is-down'">
          {{ trade.netPnl >= 0 ? '+' : '' }}{{ money(trade.netPnl) }}
        </span>
      </div>

      <div class="chart-wrap">
        <div ref="host" class="chart"></div>
        <div v-if="loading" class="loading k-mono-label">Loading…</div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.review {
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* Fills whatever the parent gives it, so the chart is as large as the panel
     allows rather than a fixed box with dead space under it. */
  flex: 1;
  min-height: 0;
}

.bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.nav { display: flex; align-items: center; gap: 4px; }
.counter { min-width: 62px; text-align: center; color: var(--sec); }

.empty { color: var(--faint); padding: 14px 0; }
.faint { color: var(--faint); }

.facts {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--glass);
}
.spacer { flex: 1; }

.side {
  font-family: 'DM Mono', ui-monospace, monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 2px 6px;
  border-radius: 4px;
}
.side.is-long { color: var(--pos); background: color-mix(in srgb, var(--pos) 12%, transparent); }
.side.is-short { color: var(--neg); background: color-mix(in srgb, var(--neg) 12%, transparent); }

.chip {
  color: var(--sec);
  padding: 2px 6px;
  border: 1px solid var(--line);
  border-radius: 4px;
}

.pnl { font-family: 'DM Mono', ui-monospace, monospace; font-size: 14px; }
.is-up { color: var(--pos); }
.is-down { color: var(--neg); }

.chart-wrap { position: relative; flex: 1; min-height: 260px; }
.chart {
  height: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.loading {
  position: absolute;
  top: 8px;
  left: 10px;
  color: var(--sec);
}
</style>
