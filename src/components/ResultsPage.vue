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
 *
 * The arithmetic of comparing lives in shared/analysis/compare.js, and the
 * reason it does is in that file's header: a stored curve holds one point per
 * balance change, so laying two of them across the same width puts the ninth
 * trade of one run above the three hundredth of the other. Here the axis is
 * time and nothing else.
 */
import { computed, onMounted, ref } from 'vue';
import ConfirmModal from './ConfirmModal.vue';
import TradeReview from './TradeReview.vue';
import { analyseRun } from '../../shared/analysis/runAnalysis.js';
import { describeSettings } from '../../shared/analysis/runSettings.js';
import {
  comparability, compareCurves, metricTable, settingsDiff, valuesAt,
} from '../../shared/analysis/compare.js';
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
 * stretches with the panel without any measuring.
 *
 * The horizontal axis is time. It used to be the position of a point in its
 * own list, which is only the same thing when every run has the same number of
 * points — and a condensed curve never does. */
const W = 1000;
const H = 280;
const PAD = 6;

/** What the curve shows. Both are read off the same stored points. */
const MEASURES = [
  { id: 'equity', label: 'Equity' },
  { id: 'drawdown', label: 'Drawdown' },
];
/** How its axis is read; only a comparison has anything to choose between. */
const AXES = [
  { id: 'calendar', label: 'Calendar' },
  { id: 'aligned', label: 'Aligned starts' },
];

const measure = ref('equity');
const axisMode = ref('calendar');
/** Where the pointer sits on the axis, in the domain's units, or null. */
const hoverX = ref(null);

/** The runs on screen: the several being compared, or the single one picked. */
const shownRuns = computed(() => (
  comparing.value ? comparedRuns.value : (detail.value ? [detail.value] : [])
));

const compared = computed(() => compareCurves(shownRuns.value, {
  mode: axisMode.value,
  measure: measure.value,
}));

function toX(x) {
  const { minX, maxX } = compared.value;
  return PAD + ((x - minX) / (maxX - minX)) * (W - PAD * 2);
}

function toY(value) {
  const { minY, maxY } = compared.value;
  return PAD + (1 - (value - minY) / (maxY - minY)) * (H - PAD * 2);
}

/**
 * One run's curve as a stepped path.
 *
 * Stepped rather than sloped, because that is what the account did: between
 * two balance changes it sat at the older one. A straight line between the
 * points would draw a climb through days that had no trade in them, and the
 * readout under the pointer — which carries the last value forward — would
 * then disagree with the line above it.
 */
function pathFor(series) {
  const points = series.points;
  if (points.length === 0) return '';

  let d = `M${toX(points[0].x).toFixed(1)},${toY(points[0].value).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` H${toX(points[i].x).toFixed(1)} V${toY(points[i].value).toFixed(1)}`;
  }
  return d;
}

/** Where zero sits vertically — the line a run has to stay above to matter. */
const zeroY = computed(() => toY(0));

/** The pointer's own x in view units, for the crosshair. */
const hoverPx = computed(() => (hoverX.value == null ? null : toX(hoverX.value)));

/** Each run's value where the pointer is, by run id. */
const readout = computed(() => {
  if (hoverX.value == null) return null;
  return new Map(valuesAt(compared.value, hoverX.value).map((v) => [v.id, v.value]));
});

function readAt(id) {
  const value = readout.value?.get(id);
  return value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function onCurveMove(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width === 0) return;
  const frac = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
  const { minX, maxX } = compared.value;
  hoverX.value = minX + frac * (maxX - minX);
}

/* ─── Comparison ────────────────────────────────────────────────────────── */

const notes = computed(() => comparability(shownRuns.value));
const metrics = computed(() => metricTable(shownRuns.value));
const diffRows = computed(() => settingsDiff(shownRuns.value, catalog.value));
const diffCount = computed(() => diffRows.value.filter((r) => r.differs).length);

/* Settings a comparison shares are noise in a diff — twenty identical rows to
 * read past before the one that changed. They stay one click away rather than
 * gone, because "nothing else differs" is itself worth being able to check. */
const onlyDiffs = ref(true);
const shownDiffRows = computed(() => (
  onlyDiffs.value ? diffRows.value.filter((r) => r.differs) : diffRows.value
));

const LINE_COLORS = ['accent', 'ind-1', 'ind-2', 'ind-3', 'ind-5'];

/* ─── Formatting ───────────────────────────────────────────────────────── */
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const money = (v) => (v == null ? '—' : v.toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}));
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const hours = (ms) => (ms == null ? '—' : `${(ms / 3_600_000).toFixed(1)}h`);

/** A figure rendered the way its own row asks for; see COMPARE_METRICS. */
function fmt(format, value) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (format === 'percent') return pct(value);
  if (format === 'money') return money(value);
  if (format === 'ratio') return value.toFixed(2);
  if (format === 'duration') return hours(value);
  return String(value);
}

/* A calendar axis is dated; an aligned one counts from each run's own start,
 * where a date would be a different day for every line on the chart. */
const axisLabel = (x) => (axisMode.value === 'aligned'
  ? `${Math.round(x / 86_400_000)}d`
  : day(x));
</script>

<template>
  <div class="results">
    <aside class="k-panel library">
      <header class="head">
        <span class="k-eyebrow">Runs</span>
        <span class="k-mono-label faint">{{ runs.length }}</span>
      </header>

      <p v-if="runs.length === 0" class="empty k-prose">
        Nothing stored yet. Run a backtest and it appears here.
      </p>

      <p v-else class="hint k-prose faint">Ctrl-click to compare several.</p>

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
      <div v-if="loading" class="placeholder k-prose">Loading…</div>

      <div v-else-if="selected.length === 0" class="placeholder k-prose">
        Select a run.
      </div>

      <template v-else>
        <header class="detail-head">
          <div>
            <h2 class="title">
              {{ comparing ? `${selected.length} runs compared` : (detail?.strategyName ?? '—') }}
            </h2>
            <p v-if="!comparing && detail" class="subtitle k-prose">
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

        <!-- Rebased so every run starts at zero, on a time axis so runs with
             different trade counts still line up by when things happened. -->
        <figure v-if="!showTrades" class="chart">
          <figcaption class="curve-head">
            <span class="k-mono-label faint">
              {{ measure === 'equity'
                ? 'Equity from zero, percent of starting balance'
                : 'Below the high-water mark, percent' }}
            </span>
            <span class="curve-controls">
              <span class="modes">
                <button
                  v-for="m in MEASURES"
                  :key="m.id"
                  class="mode-btn"
                  :class="{ 'is-active': measure === m.id }"
                  @click="measure = m.id"
                >{{ m.label }}</button>
              </span>
              <span v-if="comparing" class="modes">
                <button
                  v-for="a in AXES"
                  :key="a.id"
                  class="mode-btn"
                  :class="{ 'is-active': axisMode === a.id }"
                  @click="axisMode = a.id"
                >{{ a.label }}</button>
              </span>
            </span>
          </figcaption>

          <svg
            :viewBox="`0 0 ${W} ${H}`"
            preserveAspectRatio="none"
            class="curve"
            @pointermove="onCurveMove"
            @pointerleave="hoverX = null"
          >
            <line :x1="0" :x2="W" :y1="zeroY" :y2="zeroY" class="zero" />
            <line
              v-if="hoverPx !== null"
              :x1="hoverPx"
              :x2="hoverPx"
              :y1="0"
              :y2="H"
              class="hover-line"
            />
            <path
              v-for="(s, i) in compared.series"
              :key="s.id"
              :d="pathFor(s)"
              class="line"
              :style="{ stroke: `var(--${LINE_COLORS[i % LINE_COLORS.length]})` }"
            />
          </svg>

          <div class="axis k-mono-label faint">
            <span>{{ axisLabel(compared.minX) }}</span>
            <span v-if="hoverX !== null" class="axis-cursor">{{ axisLabel(hoverX) }}</span>
            <span>{{ axisLabel(compared.maxX) }}</span>
          </div>

          <ul class="legend">
            <li v-for="(s, i) in compared.series" :key="s.id">
              <span
                class="dot"
                :style="{ background: `var(--${LINE_COLORS[i % LINE_COLORS.length]})` }"
              ></span>
              <span class="k-mono-label">
                {{ s.label }} · {{ shownRuns[i].symbol }} {{ shownRuns[i].timeframe }} ·
                {{ pct(shownRuns[i].stats.returnPct) }}
              </span>
              <span v-if="readout" class="k-mono-label at-cursor">{{ readAt(s.id) }}</span>
            </li>
          </ul>
        </figure>

        <template v-if="comparing">
          <!-- What the compared runs disagree about. None of it stops the
               comparison; all of it changes how the numbers read. -->
          <ul v-if="notes.length > 0" class="notes">
            <li v-for="n in notes" :key="n.key" class="k-mono-label">{{ n.message }}</li>
          </ul>

          <!-- Figures as rows and runs as columns: a run is a column of numbers
               to read down, and the row is where they meet. The other way round
               it runs off the panel as soon as there is a third run. -->
          <table class="table compare">
            <thead>
              <tr>
                <th>Figure</th>
                <th v-for="(run, i) in shownRuns" :key="run.id">
                  <span
                    class="dot"
                    :style="{ background: `var(--${LINE_COLORS[i % LINE_COLORS.length]})` }"
                  ></span>
                  {{ run.strategyName }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in metrics" :key="row.key">
                <td class="row-name">{{ row.label }}</td>
                <td
                  v-for="(cell, i) in row.cells"
                  :key="i"
                  :class="{ 'is-best': cell.best }"
                >{{ fmt(row.format, cell.value) }}</td>
              </tr>
            </tbody>
          </table>

          <!-- The question a comparison is actually asking: what did I change? -->
          <section class="settings">
            <div class="diff-head">
              <span class="k-eyebrow">Settings</span>
              <button class="mode-btn" @click="onlyDiffs = !onlyDiffs">
                {{ onlyDiffs
                  ? `${diffCount} of ${diffRows.length} differ — show all`
                  : 'Show only what differs' }}
              </button>
            </div>

            <p v-if="shownDiffRows.length === 0" class="k-prose faint">
              These runs were configured identically.
            </p>

            <table v-else class="table compare">
              <tbody>
                <tr
                  v-for="row in shownDiffRows"
                  :key="row.key"
                  :class="{ 'is-diff': row.differs }"
                >
                  <td class="row-name">{{ row.label }}</td>
                  <td
                    v-for="(cell, i) in row.cells"
                    :key="i"
                    :class="{ faint: cell.missing }"
                  >{{ cell.text }}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </template>

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
  gap: 8px;
  width: 302px;
  flex: none;
  padding: 18px;
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
  padding: 13px 14px;
  text-align: left;
  border: 1px solid var(--brd);
  border-radius: var(--radius-md);
  background: var(--glass);
  cursor: pointer;
}
.run-row:hover { background: var(--glass-strong); }
.run-row.is-active { border-color: var(--accent-brd); background: var(--accent-bg); }
.run-top { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.run-name {
  font-family: var(--font-num);
  font-weight: 600;
  font-size: 12px;
}
.run-pnl { font-family: var(--font-mono); font-size: 12px; }
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
  gap: 16px;
  padding: 18px;
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
  font-family: var(--font-num);
  font-weight: 600;
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.mode-btn:hover { color: var(--txt); }
.mode-btn.is-active { color: var(--accent); background: var(--accent-bg); }
.title {
  margin: 0;
  font-family: var(--font-num);
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
  border: 1px solid var(--brd);
  border-radius: var(--radius-md);
  background: var(--glass);
}
/* Non-scaling strokes keep the line one pixel wide even though the viewBox is
   stretched to the panel — without it a wide panel gives a hairline and a
   narrow one a smear. */
.line { fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.zero { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }

.legend { display: flex; flex-wrap: wrap; gap: 12px; list-style: none; margin: 0; padding: 0; }
.legend li { display: flex; align-items: center; gap: 5px; }
.dot { width: 8px; height: 8px; border-radius: 2px; flex: none; }

.curve-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.curve-controls { display: flex; gap: 6px; }

/* Follows the pointer across the curve. Dashed so it never reads as a level
   the account actually touched. */
.hover-line {
  stroke: var(--chart-cross, var(--brd));
  stroke-width: 1;
  stroke-dasharray: 3 3;
  vector-effect: non-scaling-stroke;
}
.axis { display: flex; justify-content: space-between; gap: 8px; }
.axis-cursor { color: var(--txt); }
.at-cursor {
  min-width: 62px;
  text-align: right;
  color: var(--txt);
  font-variant-numeric: tabular-nums;
}

/* Reasons the compared runs are not answering quite the same question. A
   caution rather than an error: none of them stops the comparison. */
.notes {
  display: flex;
  flex-direction: column;
  gap: 3px;
  list-style: none;
  margin: 0;
  padding: 13px 15px;
  border: 1px solid var(--brd);
  border-left: 2px solid var(--accent-brd);
  border-radius: var(--radius-md);
  background: var(--glass);
}
.notes li { color: var(--sec); }

.compare td, .compare th { text-align: right; }
.compare td:first-child, .compare th:first-child { text-align: left; }
.compare th { white-space: nowrap; }
.compare th .dot { display: inline-block; margin-right: 5px; vertical-align: middle; }
.row-name { color: var(--sec); white-space: nowrap; }
/* The best cell of its row, in the direction that row is read — see
   COMPARE_METRICS.better, which is why the deepest drawdown is not it. */
.is-best { color: var(--accent); font-weight: 600; }
.is-diff td { background: var(--accent-bg); }

.diff-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }

.figures {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 10px 14px;
  margin: 0;
}
.figures div { display: flex; flex-direction: column; gap: 2px; }
.figures dt {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--faint);
}
.figures dd { margin: 0; font-family: var(--font-mono); font-size: 14px; }

.breakdowns { display: flex; flex-wrap: wrap; gap: 16px; }
.breakdown { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 4px; }

.table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
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
  font-family: var(--font-mono);
  font-size: 11.5px;
  text-align: right;
  overflow-wrap: anywhere;
}

.note-field { display: flex; flex-direction: column; gap: 4px; }
</style>
