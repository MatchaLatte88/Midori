<script setup>
/* The instrument row: what is being looked at, at what resolution, and what it
 * is worth right now.
 *
 * Everything in here is about one market. That is the line between this row
 * and the nav above it, and it is worth keeping sharp — a bar that mixes
 * "which page am I on" with "what is BTC doing" has to be read word by word,
 * where these two can each be taken in at a glance.
 *
 * The price is the chart's price
 * ------------------------------
 * It comes from `session.quote`, which the chart publishes from the bar at its
 * right edge — so under a running replay this is the price at the playhead and
 * not the newest bar on disk. A header that fetched its own last price would
 * be showing the future to a session that is not allowed to see it.
 */
import { computed, ref } from 'vue';

import SymbolPicker from './SymbolPicker.vue';
import ChartStyleMenu from './ChartStyleMenu.vue';
import IndicatorMenu from './IndicatorMenu.vue';
import { price as fmtPrice, percent, money, signedMoney } from '../format.js';
import { datasetFor, session, setView } from '../stores/session.js';
import { replay, switchTimeframe } from '../stores/replay.js';
import { setTimeframe } from '../stores/session.js';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

const pickerOpen = ref(false);

const dataset = computed(() => (session.symbol ? datasetFor(session.symbol) : null));

/* The quote currency split off, so the base carries the weight — the same
 * treatment the symbol list gives it, for the same reason. */
const QUOTES = ['USDT', 'FDUSD', 'USDC', 'BUSD', 'TUSD', 'USD', 'EUR', 'TRY', 'BTC', 'ETH', 'BNB'];
const parts = computed(() => {
  const s = session.symbol;
  if (!s) return { base: 'No symbol', quote: '' };
  const q = QUOTES.find((x) => s.length > x.length && s.endsWith(x));
  return q ? { base: s.slice(0, -q.length), quote: q } : { base: s, quote: '' };
});

/* What the last bar did against the one before it. Null rather than zero where
 * there is no bar before it: the first bar of a window did not open flat, it
 * has nothing to be measured against. */
const change = computed(() => {
  const q = session.quote;
  if (!q || q.prevClose == null || !(q.prevClose > 0)) return null;
  const abs = q.close - q.prevClose;
  return { abs, pct: abs / q.prevClose };
});

const changeClass = computed(() => {
  const c = change.value;
  if (!c || c.abs === 0) return 'flat';
  return c.abs > 0 ? 'up' : 'down';
});

/**
 * Changes the timeframe, including under a running replay.
 *
 * The shared timeframe follows only once the session has actually moved, so a
 * switch that could not be loaded leaves the two of them agreeing rather than
 * disagreeing. What makes switching mid-session safe at all is that the
 * session keeps a clock as well as an index — see `ReplaySession.rebase`.
 */
async function chooseTimeframe(tf) {
  if (tf === session.timeframe) return;
  if (!replay.active) {
    setTimeframe(tf);
    return;
  }
  await switchTimeframe(tf);
  if (replay.timeframe === tf) setTimeframe(tf);
}

function fmtDay(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 10) : '—';
}
function fmtCount(n) {
  return n == null ? '—' : n.toLocaleString('en-GB');
}
</script>

<template>
  <div class="bar">
    <!-- The symbol card: the one place on the screen that says which market
         this is, and therefore the one place worth clicking to change it. -->
    <button class="symbol-card" @click="pickerOpen = true">
      <span class="symbol-main">
        <span class="k-label venue">Binance</span>
        <span class="symbol-name">
          <b>{{ parts.base }}</b><span class="symbol-quote">{{ parts.quote }}</span>
        </span>
      </span>
      <span class="symbol-sep"></span>
      <span class="symbol-kind">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 010 18a15 15 0 010-18" />
        </svg>
        <span class="k-label">Spot</span>
      </span>
    </button>

    <SymbolPicker :open="pickerOpen" @close="pickerOpen = false" />

    <!-- Live under a running session as well. Only greyed while a window is
         loading, which is the one moment there are two answers to what the
         session is playing. -->
    <div
      class="k-group"
      v-hint="replay.active ? {
        label: 'Timeframe',
        text: 'Changes under a running session too. The playhead stays at the same '
          + 'instant, nothing already played is played again, and where the moment '
          + 'falls inside a bar of the new timeframe that bar is drawn as far as it '
          + 'has got.',
      } : null"
    >
      <button
        v-for="tf in TIMEFRAMES"
        :key="tf"
        class="tf"
        :class="{ 'is-active': session.timeframe === tf }"
        :disabled="replay.status === 'loading'"
        @click="chooseTimeframe(tf)"
      >{{ tf }}</button>
    </div>

    <ChartStyleMenu />

    <button
      class="replay-btn"
      :class="{ 'is-active': session.view === 'replay' }"
      title="Replay — play this market forward one bar at a time"
      @click="setView('replay')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
        <path d="M11 6L4 12l7 6zM20 6l-7 6 7 6z" />
      </svg>
      <span>Replay</span>
      <span v-if="replay.active" class="live-dot"></span>
    </button>

    <div class="k-divider"></div>

    <!-- The number the whole row exists for. -->
    <div class="price-block">
      <span class="price">{{ session.quote ? fmtPrice(session.quote.close) : '—' }}</span>
      <span v-if="change" class="change" :class="changeClass">
        {{ change.abs > 0 ? '+' : '' }}{{ percent(change.pct, 2) }}
      </span>
    </div>

    <div class="stats">
      <div class="k-stat">
        <span class="k-label">Bars stored</span>
        <span class="v">{{ fmtCount(dataset?.count) }}</span>
      </div>
      <div class="k-stat">
        <span class="k-label">History</span>
        <span class="v range">{{ fmtDay(dataset?.first) }} → {{ fmtDay(dataset?.last) }}</span>
      </div>
      <template v-if="replay.active">
        <div class="k-stat">
          <span class="k-label">Equity</span>
          <span class="v">{{ money(replay.account.equity) }}</span>
        </div>
        <div class="k-stat">
          <span class="k-label">Open result</span>
          <span
            class="v"
            :class="replay.account.unrealized > 0 ? 'up' : (replay.account.unrealized < 0 ? 'down' : '')"
          >{{ signedMoney(replay.account.unrealized) }}</span>
        </div>
      </template>
    </div>

    <div class="spacer"></div>

    <!-- The tools, in the corner a terminal keeps them. Indicators first
         because it is the one with a word on it; then the chart's own —
         hide-everything and the object list — which ChartPanel teleports in,
         because it owns the drawings they are about. -->
    <div class="tools">
      <IndicatorMenu />
      <div class="k-divider"></div>
      <div id="chart-tools" class="tool-slot"></div>
    </div>
  </div>
</template>

<style scoped>
.bar {
  position: relative;
  z-index: 3;
  height: var(--toolbar-height);
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--line);
  overflow: hidden;
}

/* ─── Symbol card ────────────────────────────────────────────────────────── */
.symbol-card {
  display: flex;
  align-items: stretch;
  height: 38px;
  padding: 0;
  border: 1px solid var(--brd);
  border-radius: var(--radius-md);
  background: var(--glass);
  cursor: pointer;
  flex: none;
  transition: background 0.12s, border-color 0.12s;
}
.symbol-card:hover { background: var(--glass-strong); border-color: var(--line-strong); }
.symbol-main {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  padding: 0 11px;
  text-align: left;
}
.venue { line-height: 1.1; }
.symbol-name {
  font-family: var(--font-num);
  font-size: 13.5px;
  line-height: 1.1;
  letter-spacing: -0.01em;
}
.symbol-name b { font-weight: 700; color: var(--txt); }
.symbol-quote { color: var(--faint); font-weight: 500; }
.symbol-sep { width: 1px; background: var(--line); }
.symbol-kind {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 0 9px;
  color: var(--faint);
}
.symbol-kind svg { width: 13px; height: 13px; }

/* ─── Timeframes ─────────────────────────────────────────────────────────── */
.tf {
  min-width: 30px;
  height: 24px;
  padding: 0 7px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--sec);
  font-family: var(--font-num);
  font-size: 11.5px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: color 0.12s, background 0.12s;
}
.tf:hover:not(:disabled) { color: var(--txt); background: var(--hover); }
/* Grey, not accent: this says "the one that is showing", and the accent in
   this row belongs to the live price. */
.tf.is-active { color: var(--txt); background: var(--sel-bg); font-weight: 600; }
.tf:disabled { opacity: 0.35; cursor: default; }

/* ─── Replay ─────────────────────────────────────────────────────────────── */
.replay-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: none;
  color: var(--sec);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  flex: none;
  transition: color 0.12s, background 0.12s;
}
.replay-btn:hover { color: var(--txt); background: var(--hover); }
.replay-btn.is-active { color: var(--txt); background: var(--sel-bg); }
.replay-btn svg { width: 14px; height: 14px; }
/* A session that is running is the one thing in this row worth the accent
   besides the price: it changes what every other control means. */
.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}

/* ─── Price ──────────────────────────────────────────────────────────────── */
.price-block {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: none;
}
.price {
  font-family: var(--font-num);
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--txt);
}
.change {
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  background: var(--glass);
  font-family: var(--font-num);
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.up { color: var(--pos); }
.down { color: var(--neg); }
.flat { color: var(--sec); }

/* ─── Stat columns ───────────────────────────────────────────────────────── */
.stats {
  display: flex;
  align-items: center;
  gap: 22px;
  min-width: 0;
  overflow: hidden;
}
/* Long enough to need its own size, but the same face as every other value
   in the row — a second typeface here would read as a second kind of fact. */
.range { font-size: 12px; font-weight: 500; color: var(--sec); }

.spacer { flex: 1; min-width: 8px; }

.tools {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.tool-slot { display: flex; align-items: center; gap: 2px; }
</style>
