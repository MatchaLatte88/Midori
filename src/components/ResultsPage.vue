<script setup>
/* Stored backtest runs: the library, one run in detail, and several compared.
 *
 * The equity curve is drawn as plain SVG rather than through the charting
 * library. A condensed curve is a hundred points with no candles, no crosshair
 * and no time scale to keep in step with anything — a path element does the
 * whole job, and it can hold several runs at once without one chart instance
 * per line.
 *
 * Comparison is in percent, never in currency. Two runs started with different
 * balances are not comparable in money: the one that began with more will look
 * better at the same skill. Percent asks the question everyone actually means.
 */
import { computed, onMounted, ref } from 'vue';
import ConfirmModal from './ConfirmModal.vue';
import TradeReview from './TradeReview.vue';
import { analyseRun } from '../../shared/analysis/runAnalysis.js';
import { describeSettings } from '../../shared/analysis/runSettings.js';
import { setError } from '../stores/session.js';

const runs = ref([]);
const selected = ref([]);          // ids, in the order they were picked
const detail = ref(null);          // the fully loaded run, when exactly one is picked
const loading = ref(false);
/* Which half of a single run is showing: the figures, or its trades on a
 * chart. Two ways of asking the same question — what did this run do — and
 * both want the whole panel, so they take turns rather than share it. */
const mode = ref('analysis');
/* The run waiting on a confirmation, or null. Held here rather than in the
 * modal so the prompt can name what it is about to remove. */
const pendingDelete = ref(null);
/* Strategy metadata, only for the parameter labels: a stored run keeps its
 * settings by key, and the schema is what turns `riskMode: 'percent'` into
 * "Risk per trade: Percent of equity". */
const catalog = ref([]);

/* Loaded runs are kept so switching back to a comparison does not refetch what
 * is already here. Keyed by id; a deleted run is dropped from it too. */
const cache = new Map();

const comparing = computed(() => selected.value.length > 1);

/* Trades belong to one run. Two runs' trades stepped through together would be
 * a list of two strategies taking turns, which answers nothing — so comparing
 * always shows the figures. */
const showTrades = computed(() => !comparing.value && mode.value === 'trades');

const analysis = computed(() => (detail.value ? analyseRun(detail.value) : null));

const settings = computed(() => (detail.value
  ? describeSettings(detail.value, catalog.value.find((c) => c.id === detail.value.strategy))
  : []));

/** The picked runs that are loaded, in pick order, for the overlay. */
const comparedRuns = computed(() => (
  selected.value.map((id) => cache.get(id)).filter(Boolean)
));

onMounted(async () => {
  try {
    catalog.value = await window.midori.backtest.strategies();
  } catch (err) {
    // Labels are a nicety; a missing catalog falls back to raw keys.
    setError(err);
  }
  await refresh();
});

async function refresh() {
  try {
    runs.value = await window.midori.backtest.list();
    if (runs.value.length > 0 && selected.value.length === 0) await pick(runs.value[0].id);
  } catch (err) {
    setError(err);
  }
}

async function load(id) {
  if (cache.has(id)) return cache.get(id);
  const run = await window.midori.backtest.load(id);
  cache.set(id, run);
  return run;
}

async function pick(id, additive = false) {
  loading.value = true;
  try {
    if (additive) {
      selected.value = selected.value.includes(id)
        ? selected.value.filter((x) => x !== id)
        : [...selected.value, id];
    } else {
      selected.value = [id];
    }
    // Every picked run has to be in the cache before anything is drawn.
    await Promise.all(selected.value.map(load));
    detail.value = selected.value.length === 1 ? cache.get(selected.value[0]) : null;
  } catch (err) {
    setError(err);
  } finally {
    loading.value = false;
  }
}

function askRemove(run) {
  pendingDelete.value = run;
}

async function confirmRemove() {
  const run = pendingDelete.value;
  pendingDelete.value = null;
  if (run) await remove(run.id);
}

async function remove(id) {
  try {
    await window.midori.backtest.remove(id);
    cache.delete(id);
    selected.value = selected.value.filter((x) => x !== id);
    detail.value = selected.value.length === 1 ? cache.get(selected.value[0]) ?? null : null;
    await refresh();
  } catch (err) {
    setError(err);
  }
}

async function saveNote(id, note) {
  try {
    await window.midori.backtest.annotate(id, note);
    const run = cache.get(id);
    if (run) run.note = note;
    runs.value = runs.value.map((r) => (r.id === id ? { ...r, note } : r));
  } catch (err) {
    setError(err);
  }
}

/* ─── Curve geometry ──────────────────────────────────────────────────────
 * The viewBox is a fixed 1000×280 and the path is scaled into it, so the SVG
 * stretches with the panel without any measuring. */
const W = 1000;
const H = 280;
const PAD = 6;

/** One run's curve as {points, last}, in percent of its own starting balance. */
function curveOf(run) {
  return analyseRun(run).equityPct;
}

/** The value range covering every curve, so compared runs share one scale. */
const scale = computed(() => {
  const curves = comparing.value
    ? comparedRuns.value.map(curveOf)
    : (analysis.value ? [analysis.value.equityPct] : []);

  let min = 0;   // zero is always in view: it is the line that means breakeven
  let max = 0;
  let count = 0;
  for (const c of curves) {
    for (const p of c) {
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    }
    count = Math.max(count, c.length);
  }
  // A flat run would divide by zero; give it a band to sit in the middle of.
  if (max - min < 1e-9) { min -= 1; max += 1; }
  return { min, max, count };
});

function pathFor(curve) {
  const { min, max } = scale.value;
  if (curve.length === 0) return '';
  const span = max - min;
  const stepX = curve.length > 1 ? (W - PAD * 2) / (curve.length - 1) : 0;

  return curve.map((p, i) => {
    const x = PAD + i * stepX;
    const y = PAD + (1 - (p.value - min) / span) * (H - PAD * 2);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

/** Where zero sits vertically — the line a run has to stay above to matter. */
const zeroY = computed(() => {
  const { min, max } = scale.value;
  return PAD + (1 - (0 - min) / (max - min)) * (H - PAD * 2);
});

const LINE_COLORS = ['accent', 'ind-1', 'ind-2', 'ind-3', 'ind-5'];

/* ─── Formatting ───────────────────────────────────────────────────────── */
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const money = (v) => (v == null ? '—' : v.toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}));
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const hours = (ms) => (ms == null ? '—' : `${(ms / 3_600_000).toFixed(1)}h`);
</script>

<template>
  <div class="results">
    <aside class="k-panel library">
      <header class="head">
        <span class="k-eyebrow">Runs</span>
        <span class="k-mono-label faint">{{ runs.length }}</span>
      </header>

      <p v-if="runs.length === 0" class="empty k-mono-label">
        Nothing stored yet. Run a backtest and it appears here.
      </p>

      <p v-else class="hint k-mono-label faint">Ctrl-click to compare several.</p>

      <button
        v-for="r in runs"
        :key="r.id"
        class="run-row"
        :class="{ 'is-active': selected.includes(r.id) }"
        @click="pick(r.id, $event.ctrlKey || $event.metaKey)"
      >
        <span class="run-top">
          <span class="run-name">{{ r.strategyName ?? r.strategy }}</span>
          <span class="run-pnl" :class="r.stats.netPnl >= 0 ? 'is-up' : 'is-down'">
            {{ pct(r.stats.returnPct) }}
          </span>
        </span>
        <span class="run-meta k-mono-label">
          {{ r.symbol }} · {{ r.timeframe }} · {{ r.stats.tradeCount }} trades
        </span>
        <span class="run-meta k-mono-label faint">{{ day(r.from) }} → {{ day(r.to) }}</span>
        <span v-if="r.note" class="run-note">{{ r.note }}</span>
      </button>
    </aside>

    <section class="k-panel detail">
      <div v-if="loading" class="placeholder k-mono-label">Loading…</div>

      <div v-else-if="selected.length === 0" class="placeholder k-mono-label">
        Select a run.
      </div>

      <template v-else>
        <header class="detail-head">
          <div>
            <h2 class="title">
              {{ comparing ? `${selected.length} runs compared` : (detail?.strategyName ?? '—') }}
            </h2>
            <p v-if="!comparing && detail" class="subtitle k-mono-label">
              {{ detail.symbol }} · {{ detail.timeframe }} ·
              {{ day(detail.from) }} → {{ day(detail.to) }} ·
              balance {{ money(detail.initialBalance) }}
            </p>
          </div>
          <div class="head-actions">
            <div v-if="!comparing && detail" class="modes">
              <button
                v-for="m in [{ id: 'analysis', label: 'Analysis' }, { id: 'trades', label: 'Trades' }]"
                :key="m.id"
                class="mode-btn"
                :class="{ 'is-active': mode === m.id }"
                @click="mode = m.id"
              >{{ m.label }}</button>
            </div>
            <button
              v-if="!comparing && detail"
              class="btn btn--sm btn--default"
              @click="askRemove(detail)"
            >Delete</button>
          </div>
        </header>

        <!-- The trades themselves, taking the whole panel. -->
        <TradeReview v-if="showTrades" :run="detail" />

        <!-- Equity, rebased so every run starts at zero. -->
        <figure v-if="!showTrades" class="chart">
          <figcaption class="k-mono-label faint">Equity from zero, percent of starting balance</figcaption>
          <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="curve">
            <line :x1="0" :x2="W" :y1="zeroY" :y2="zeroY" class="zero" />
            <path
              v-for="(run, i) in (comparing ? comparedRuns : (detail ? [detail] : []))"
              :key="run.id"
              :d="pathFor(curveOf(run))"
              class="line"
              :style="{ stroke: `var(--${LINE_COLORS[i % LINE_COLORS.length]})` }"
            />
          </svg>
          <ul v-if="comparing" class="legend">
            <li v-for="(run, i) in comparedRuns" :key="run.id">
              <span class="dot" :style="{ background: `var(--${LINE_COLORS[i % LINE_COLORS.length]})` }"></span>
              <span class="k-mono-label">
                {{ run.strategyName }} · {{ run.timeframe }} · {{ pct(run.stats.returnPct) }}
              </span>
            </li>
          </ul>
        </figure>

        <!-- Comparison: one row per run, the figures side by side. -->
        <table v-if="comparing" class="table">
          <thead>
            <tr>
              <th>Run</th><th>Return</th><th>Trades</th><th>Win rate</th>
              <th>Max DD</th><th>PF</th><th>Fees</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="run in comparedRuns" :key="run.id">
              <td>{{ run.strategyName }} · {{ run.symbol }} {{ run.timeframe }}</td>
              <td :class="run.stats.netPnl >= 0 ? 'is-up' : 'is-down'">{{ pct(run.stats.returnPct) }}</td>
              <td>{{ run.stats.tradeCount }}</td>
              <td>{{ pct(run.stats.winRate) }}</td>
              <td>{{ pct(run.stats.maxDrawdownPct) }}</td>
              <td>{{ run.stats.profitFactor == null ? '—' : run.stats.profitFactor.toFixed(2) }}</td>
              <td>{{ money(run.stats.feesPaid) }}</td>
            </tr>
          </tbody>
        </table>

        <template v-else-if="detail && analysis && !showTrades">
          <dl class="figures">
            <div>
              <dt>Net PnL</dt>
              <dd :class="detail.stats.netPnl >= 0 ? 'is-up' : 'is-down'">
                {{ money(detail.stats.netPnl) }}
              </dd>
            </div>
            <div><dt>Return</dt><dd>{{ pct(detail.stats.returnPct) }}</dd></div>
            <div><dt>Trades</dt><dd>{{ detail.stats.tradeCount }}</dd></div>
            <div><dt>Win rate</dt><dd>{{ pct(detail.stats.winRate) }}</dd></div>
            <div><dt>Max drawdown</dt><dd>{{ pct(detail.stats.maxDrawdownPct) }}</dd></div>
            <div>
              <dt>Profit factor</dt>
              <dd>{{ detail.stats.profitFactor == null ? '—' : detail.stats.profitFactor.toFixed(2) }}</dd>
            </div>
            <div><dt>Expectancy</dt><dd>{{ money(detail.stats.expectancy) }}</dd></div>
            <div><dt>Fees paid</dt><dd>{{ money(detail.stats.feesPaid) }}</dd></div>
            <div><dt>Worst streak</dt><dd>{{ analysis.streaks.longestLoss }} losses</dd></div>
            <div><dt>Best streak</dt><dd>{{ analysis.streaks.longestWin }} wins</dd></div>
            <div><dt>Avg hold</dt><dd>{{ hours(analysis.avgHoldMs) }}</dd></div>
            <div><dt>Fills</dt><dd>{{ detail.resolution === 'intrabar' ? 'minute' : 'pessimistic' }}</dd></div>
          </dl>

          <div class="breakdowns">
            <div v-for="group in [
              { title: 'By direction', rows: analysis.byDirection },
              { title: 'By entry tag', rows: analysis.byTag },
              { title: 'By exit', rows: analysis.byExit },
            ]" :key="group.title" class="breakdown">
              <span class="k-eyebrow">{{ group.title }}</span>
              <table class="table table--tight">
                <tbody>
                  <tr v-for="row in group.rows" :key="row.name">
                    <td>{{ row.name }}</td>
                    <td>{{ row.trades }}</td>
                    <td>{{ pct(row.winRate) }}</td>
                    <td :class="row.netPnl >= 0 ? 'is-up' : 'is-down'">{{ money(row.netPnl) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- What the run was configured with. Below the figures rather than
               above them: the outcome is what draws the eye, the settings are
               what explains it once something looks worth explaining. -->
          <section class="settings">
            <span class="k-eyebrow">Settings</span>
            <div class="setting-groups">
              <div v-for="group in settings" :key="group.title" class="setting-group">
                <span class="group-title k-mono-label">{{ group.title }}</span>
                <dl class="setting-rows">
                  <div v-for="row in group.rows" :key="row.key" class="setting-row">
                    <dt>{{ row.label }}</dt>
                    <dd>{{ row.value }}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </section>

          <label class="note-field">
            <span class="k-eyebrow">Note</span>
            <input
              class="input input--sm"
              :value="detail.note"
              placeholder="What was this run testing?"
              @change="saveNote(detail.id, $event.target.value)"
            />
          </label>
        </template>
      </template>
    </section>

    <ConfirmModal
      :open="pendingDelete !== null"
      title="Delete this run?"
      :message="pendingDelete
        ? `${pendingDelete.strategyName} on ${pendingDelete.symbol} ${pendingDelete.timeframe}, `
          + `${pendingDelete.stats.tradeCount} trades. The stored result and its trades are `
          + `removed for good — the run itself can be repeated, but this record cannot be brought back.`
        : ''"
      @confirm="confirmRemove"
      @cancel="pendingDelete = null"
    />
  </div>
</template>

<style scoped>
.results { display: flex; gap: 12px; width: 100%; height: 100%; overflow: hidden; }

.library {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 290px;
  flex: none;
  padding: 12px;
  overflow-y: auto;
}
.head { display: flex; align-items: baseline; justify-content: space-between; }
.hint { margin: 0 0 2px; }
.empty, .placeholder { color: var(--faint); padding: 16px 0; }
.faint { color: var(--faint); }

.run-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 9px;
  text-align: left;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
}
.run-row:hover { border-color: var(--brd); }
.run-row.is-active { border-color: var(--accent-brd); background: var(--accent-bg); }
.run-top { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.run-name {
  font-family: 'Plus Jakarta Sans', Inter, sans-serif;
  font-weight: 600;
  font-size: 12px;
}
.run-pnl { font-family: 'DM Mono', ui-monospace, monospace; font-size: 12px; }
.run-meta { color: var(--sec); }
.run-note {
  font-size: 11px;
  color: var(--sec);
  font-style: italic;
  margin-top: 2px;
}

.detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  overflow-y: auto;
  /* A flex child will not shrink below its content by default, which would
     stop the trade chart from ever getting a height to fill. */
  min-height: 0;
}
.detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.head-actions { display: flex; align-items: center; gap: 8px; }

/* Segmented, because these are two views of one thing rather than two places —
   the top-level navigation is underlined for exactly that distinction. */
.modes {
  display: flex;
  gap: 1px;
  padding: 2px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
}
.mode-btn {
  padding: 3px 10px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--sec);
  font-family: 'Plus Jakarta Sans', Inter, sans-serif;
  font-weight: 600;
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.mode-btn:hover { color: var(--txt); }
.mode-btn.is-active { color: var(--accent); background: var(--accent-bg); }
.title {
  margin: 0;
  font-family: 'Plus Jakarta Sans', Inter, sans-serif;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.subtitle { margin: 3px 0 0; color: var(--sec); }

.chart { margin: 0; display: flex; flex-direction: column; gap: 5px; }
.curve {
  width: 100%;
  height: 200px;
  display: block;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--glass);
}
/* Non-scaling strokes keep the line one pixel wide even though the viewBox is
   stretched to the panel — without it a wide panel gives a hairline and a
   narrow one a smear. */
.line { fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.zero { stroke: var(--brd); stroke-width: 1; vector-effect: non-scaling-stroke; }

.legend { display: flex; flex-wrap: wrap; gap: 12px; list-style: none; margin: 0; padding: 0; }
.legend li { display: flex; align-items: center; gap: 5px; }
.dot { width: 8px; height: 8px; border-radius: 2px; }

.figures {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 10px 14px;
  margin: 0;
}
.figures div { display: flex; flex-direction: column; gap: 2px; }
.figures dt {
  font-family: 'DM Mono', ui-monospace, monospace;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--faint);
}
.figures dd { margin: 0; font-family: 'DM Mono', ui-monospace, monospace; font-size: 14px; }

.breakdowns { display: flex; flex-wrap: wrap; gap: 16px; }
.breakdown { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 4px; }

.table {
  width: 100%;
  border-collapse: collapse;
  font-family: 'DM Mono', ui-monospace, monospace;
  font-size: 11.5px;
}
.table th {
  text-align: left;
  font-weight: 500;
  color: var(--faint);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 4px 6px;
  border-bottom: 1px solid var(--line);
}
.table td { padding: 4px 6px; border-bottom: 1px solid var(--line-soft); }
.table--tight td:first-child { color: var(--sec); }

.is-up { color: var(--pos); }
.is-down { color: var(--neg); }

.settings { display: flex; flex-direction: column; gap: 6px; }
.setting-groups { display: flex; flex-wrap: wrap; gap: 18px; }
.setting-group { flex: 1; min-width: 210px; display: flex; flex-direction: column; gap: 3px; }
.group-title { color: var(--faint); }

.setting-rows { margin: 0; display: flex; flex-direction: column; gap: 1px; }
.setting-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 2px 0;
  border-bottom: 1px solid var(--line-soft);
}
.setting-row dt {
  font-size: 11.5px;
  color: var(--sec);
  white-space: nowrap;
}
.setting-row dd {
  margin: 0;
  font-family: 'DM Mono', ui-monospace, monospace;
  font-size: 11.5px;
  text-align: right;
  overflow-wrap: anywhere;
}

.note-field { display: flex; flex-direction: column; gap: 4px; }
</style>
