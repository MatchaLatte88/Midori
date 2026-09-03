<script setup>
/* Auto backtest: try every combination of a set of ranges, then compare the
 * ends against each other.
 *
 * The sweep runs on a worker thread in the main process: this component starts
 * one, listens for progress, and gets the finished sweep back. The worker does
 * not care what is on screen, so a sweep survives switching tabs — though the
 * result does not, because nothing is stored.
 *
 * That is deliberate. A sweep is a question asked once — does this parameter
 * matter here — and its answer is read on the spot. A combination worth
 * keeping is worth re-running as a backtest, and those are stored. Leaving
 * this view therefore loses the table, and the panel says so before it starts.
 *
 * What the out-of-sample column is for
 * ------------------------------------
 * A sweep is a machine for overfitting. Try three hundred combinations on one
 * stretch of history and the best of them is, more often than not, the one
 * that memorised it. Every combination is therefore ranked on the earlier part
 * of the range and the handful shown are re-run on the later part, which had
 * no say in choosing them. The second number is the one worth reading, and
 * where the two disagree the first was noise.
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import ParamFields from './ParamFields.vue';
import SweepRangeFields from './SweepRangeFields.vue';
import {
  MAX_COMBINATIONS, RANK_METRICS, countCombinations, detectionCount,
} from '../../shared/analysis/sweep.js';
import { datasetFor, sendToBacktest, session, setError } from '../stores/session.js';

const catalog = ref([]);
const strategyId = ref(null);
const values = ref({});      // fixed parameter values
const ranges = ref({});      // key -> { from, to, step }

const balance = ref(10_000);
const from = ref('');
const to = ref('');
const metric = ref('expectancy');
const minTrades = ref(10);
const trainFraction = ref(0.7);

const running = ref(false);
const stage = ref(null);
const progress = ref(null);
const result = ref(null);
/** Set when the last sweep was stopped, so the panel can say so. */
const stopped = ref(false);

let unsubscribe = null;

const spec = computed(() => catalog.value.find((s) => s.id === strategyId.value) ?? null);
const dataset = computed(() => (session.symbol ? datasetFor(session.symbol) : null));

/* Only numbers can be swept — a range over a list of trading hours is a
 * handful of separate sweeps, not a range. The rest keep one value each. */
const numericParams = computed(() => (spec.value?.params ?? []).filter((p) => p.type === 'number'));
const otherParams = computed(() => (spec.value?.params ?? []).filter((p) => p.type !== 'number'));

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const combinations = computed(() => {
  try {
    return countCombinations(ranges.value);
  } catch {
    return 0;   // a half-typed range; the field says so itself
  }
});

/* What actually decides how long this takes. Combinations that differ only in
 * how a setup is traded reuse one detection; combinations that change what is
 * detected each need their own. 323 runs over one detection is seconds, 323
 * over 323 is minutes. */
const detections = computed(() => {
  try {
    return detectionCount(ranges.value, spec.value?.detectorKeys ?? []);
  } catch {
    return 0;
  }
});

const overLimit = computed(() => combinations.value > MAX_COMBINATIONS);

const rangeValid = computed(() => (
  !!from.value && !!to.value
  && Date.parse(`${from.value}T00:00:00Z`) < Date.parse(`${to.value}T00:00:00Z`)
));

const canRun = computed(() => (
  !running.value && !!strategyId.value && !!session.symbol
  && rangeValid.value && combinations.value > 0 && !overLimit.value && balance.value > 0
));

onMounted(async () => {
  unsubscribe = window.midori.sweep.onProgress((payload) => {
    if (payload.type === 'stage') stage.value = payload.stage;
    else if (payload.type === 'progress') progress.value = payload;
  });

  try {
    catalog.value = await window.midori.backtest.strategies();
    if (catalog.value.length > 0) select(catalog.value[0].id);
    // A sweep started before this tab was opened is still going.
    running.value = await window.midori.sweep.running();
  } catch (err) {
    setError(err);
  }

  const d = dataset.value;
  if (d) {
    from.value = isoDay(d.first);
    to.value = isoDay(d.last);
  }
});

onBeforeUnmount(() => {
  // The listener outlives the component otherwise, and fires into nothing.
  unsubscribe?.();
  unsubscribe = null;
});

function select(id) {
  strategyId.value = id;
  const found = catalog.value.find((s) => s.id === id);
  values.value = Object.fromEntries((found?.params ?? []).map((p) => [p.key, p.default]));
  ranges.value = {};
  result.value = null;
}

function setValue(key, value) {
  values.value = { ...values.value, [key]: value };
}

function setRange(key, range) {
  ranges.value = { ...ranges.value, [key]: range };
}

function toggleRange(key, range) {
  const next = { ...ranges.value };
  if (range) next[key] = range;
  else delete next[key];
  ranges.value = next;
}

function patchOther(update) {
  values.value = { ...values.value, ...update };
}

async function run() {
  if (!canRun.value) return;
  running.value = true;
  result.value = null;
  stopped.value = false;
  progress.value = null;
  stage.value = 'starting';

  try {
    /* A JSON copy, because a Vue ref makes its object deeply reactive and the
     * structured clone behind IPC refuses a Proxy. */
    const plain = (v) => JSON.parse(JSON.stringify(v));
    const answer = await window.midori.sweep.run({
      strategy: strategyId.value,
      ranges: plain(ranges.value),
      base: plain(values.value),
      symbol: session.symbol,
      timeframe: session.timeframe,
      from: Date.parse(`${from.value}T00:00:00Z`),
      to: Date.parse(`${to.value}T00:00:00Z`),
      balance: Number(balance.value),
      metric: metric.value,
      minTrades: Number(minTrades.value),
      trainFraction: Number(trainFraction.value),
    });
    /* Stopped on request: nothing was stored, and nothing went wrong — but it
     * has to say so, or a stopped sweep looks like one that silently failed. */
    if (answer.cancelled) {
      result.value = null;
      stopped.value = true;
    } else {
      result.value = answer;
      stopped.value = false;
    }
  } catch (err) {
    setError(err);
  } finally {
    running.value = false;
    stage.value = null;
    progress.value = null;
  }
}

/**
 * Hands one combination to the backtest form.
 *
 * `params` already carries every setting, swept and fixed alike — a
 * combination is the full parameter set, not just the parts that varied — so
 * the form can be filled from it directly.
 *
 * The whole range goes with it, not just the stretch held back. That is the
 * period the sweep was asked about, and it is what makes the resulting report
 * comparable to any other backtest over the same span. It does mean the report
 * covers bars these settings were chosen on, so it will read better than the
 * out-of-sample column did; the button says so.
 */
function useForBacktest(row, sweep) {
  sendToBacktest({
    strategy: sweep.strategy,
    params: { ...row.params },
    symbol: sweep.symbol,
    timeframe: sweep.timeframe,
    from: sweep.from,
    to: sweep.to,
    balance: sweep.balance,
  });
}

async function stop() {
  try {
    await window.midori.sweep.stop();
  } catch (err) {
    setError(err);
  }
}

/* ─── Formatting ───────────────────────────────────────────────────────── */
const num = (v, digits = 2) => (v == null ? '—' : v.toFixed(digits));
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const duration = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = s / 60;
  return m < 90 ? `${m.toFixed(0)}m` : `${(m / 60).toFixed(1)}h`;
};
/**
 * A combination as the settings that made it differ from the others.
 *
 * Read off the result's own ranges, not the form's: editing the form after a
 * sweep has finished must not relabel the rows of a sweep that is already on
 * screen.
 */
const describe = (params, sweep) => Object.keys(sweep?.ranges ?? {})
  .map((k) => `${k} ${params[k]}`)
  .join(' · ');
</script>

<template>
  <div class="sweep">
    <section class="k-panel setup">
      <header class="head">
        <span class="k-eyebrow">Auto backtest</span>
        <span v-if="session.symbol" class="market k-mono-label">
          {{ session.symbol }} · {{ session.timeframe }}
        </span>
      </header>

      <div class="strategies">
        <button
          v-for="s in catalog"
          :key="s.id"
          class="strategy"
          :class="{ 'is-active': s.id === strategyId }"
          :disabled="running"
          @click="select(s.id)"
        >{{ s.name }}</button>
      </div>

      <template v-if="spec">
        <div class="k-divider-h"></div>
        <span class="k-eyebrow">Account</span>

        <label v-hint="{ label: 'Starting balance', text: 'The account every combination begins with. Each one starts fresh, so they are comparable.' }" class="field">
          <span class="k-mono-label">Balance</span>
          <input v-model.number="balance" class="input input--sm" type="number" min="1" step="1000" :disabled="running" />
        </label>
        <label v-hint="{ label: 'From', text: 'First day of the sweep, in UTC. The earlier part of this range is what the combinations are ranked on.' }" class="field">
          <span class="k-mono-label">From</span>
          <input v-model="from" class="input input--sm" type="date" :disabled="running" />
        </label>
        <label v-hint="{ label: 'To', text: 'Last day of the sweep, in UTC. The later part is held back to check the winners against.' }" class="field">
          <span class="k-mono-label">To</span>
          <input v-model="to" class="input input--sm" type="date" :disabled="running" />
        </label>
        <p v-if="dataset" class="k-prose faint">
          Data: {{ isoDay(dataset.first) }} → {{ isoDay(dataset.last) }}
        </p>

        <div class="k-divider-h"></div>
        <span class="k-eyebrow">Ranges</span>
        <SweepRangeFields
          :schema="numericParams"
          :values="values"
          :ranges="ranges"
          @update-value="setValue"
          @update-range="setRange"
          @toggle="toggleRange"
        />

        <template v-if="otherParams.length">
          <div class="k-divider-h"></div>
          <span class="k-eyebrow">Fixed</span>
          <ParamFields :schema="otherParams" :values="values" @update="patchOther" />
        </template>

        <div class="k-divider-h"></div>
        <span class="k-eyebrow">Ranking</span>

        <label v-hint="{ label: 'Rank by', text: 'Which measure decides the best. Expectancy asks whether the rule itself is worth anything; net profit favours whatever traded most; profit factor ignores how rare the trades were.' }" class="field">
          <span class="k-mono-label">Rank by</span>
          <select v-model="metric" class="input input--sm" :disabled="running">
            <option v-for="m in Object.values(RANK_METRICS)" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
        </label>

        <label v-hint="{ label: 'Minimum trades', text: 'A combination with fewer trades than this is set aside rather than ranked. Four trades can top any measure by luck, and reporting that as the best would be the sweep lying about what it found.' }" class="field">
          <span class="k-mono-label">Min trades</span>
          <input v-model.number="minTrades" class="input input--sm" type="number" min="1" step="1" :disabled="running" />
        </label>

        <label v-hint="{ label: 'Optimise on', text: 'The share of the range used to rank the combinations. The rest is held back, and the shown combinations are re-run on it — the only number that says whether a setting holds up on bars it never saw.' }" class="field">
          <span class="k-mono-label">Optimise on</span>
          <select v-model.number="trainFraction" class="input input--sm" :disabled="running">
            <option :value="0.5">First 50%</option>
            <option :value="0.7">First 70%</option>
            <option :value="0.8">First 80%</option>
          </select>
        </label>

        <div class="combos">
          <div class="k-mono-label" :class="{ 'is-bad': overLimit }">
            {{ combinations.toLocaleString() }} combination{{ combinations === 1 ? '' : 's' }}
            <span v-if="combinations === 0" class="faint">— switch a parameter to Range</span>
          </div>
          <div
            v-if="combinations > 0"
            v-hint="{ label: 'Detections', text: 'How many times the setups have to be found from scratch. Parameters that only change what is done with a setup — risk, reward-to-risk, leverage — reuse one detection across every combination. This is the number that decides how long the sweep takes, not the combination count.' }"
            class="k-mono-label faint"
          >
            {{ detections.toLocaleString() }} detection{{ detections === 1 ? '' : 's' }} — this is what costs the time
          </div>
          <div v-if="overLimit" class="warn k-prose">
            Over the limit of {{ MAX_COMBINATIONS.toLocaleString() }}. Widen a step or drop a parameter.
          </div>
        </div>

        <button v-if="!running" class="btn btn--accent" :disabled="!canRun" @click="run">
          Run sweep
        </button>
        <button v-else class="btn btn--danger" @click="stop">Stop</button>

        <p v-if="!session.symbol" class="warn k-prose">Select a symbol on the chart first.</p>
        <p class="k-prose faint">
          Results are not stored — they last as long as this view does.
        </p>
      </template>
    </section>

    <section class="k-panel output">
      <div v-if="running" class="progress">
        <span class="k-eyebrow">{{ stage === 'loading' ? 'Loading bars' : 'Running' }}</span>
        <template v-if="progress">
          <div class="bar"><div class="fill" :style="{ width: `${(progress.done / progress.total) * 100}%` }"></div></div>
          <div class="progress-text k-mono-label">
            {{ progress.done.toLocaleString() }} / {{ progress.total.toLocaleString() }}
            · {{ duration(progress.elapsedMs) }} elapsed
            · about {{ duration(progress.etaMs) }} left
          </div>
        </template>
        <p v-else class="k-prose faint">Reading the bars for this range…</p>
      </div>

      <div v-else-if="stopped" class="placeholder k-prose">
        Stopped. Nothing was stored — the combinations already run are not a sweep.
      </div>

      <div v-else-if="!result" class="placeholder k-prose">
        Give at least one parameter a range and press Run. Every combination is ranked on the
        earlier part of the range; the ones shown are then re-run on the later part.
      </div>

      <template v-else>
        <header class="result-head">
          <div>
            <h2 class="title">{{ result.combinationCount.toLocaleString() }} combinations</h2>
            <p class="subtitle k-prose">
              {{ result.symbol }} · {{ result.timeframe }} ·
              ranked by {{ RANK_METRICS[result.metric]?.label ?? result.metric }} ·
              {{ duration(result.elapsedMs) }}
            </p>
          </div>
        </header>

        <p v-if="result.excludedCount" class="k-prose faint">
          {{ result.excludedCount }} set aside for taking fewer than {{ result.minTrades }} trades.
        </p>
        <p v-if="result.overlapping" class="warn k-prose">
          Too few combinations ranked for the two ends to be distinct — they overlap.
        </p>

        <div v-for="side in [
          { key: 'best', title: 'Best', rows: result.best },
          { key: 'worst', title: 'Worst', rows: result.worst },
        ]" :key="side.key" class="side">
          <span class="k-eyebrow">{{ side.title }}</span>
          <table class="table">
            <thead>
              <tr>
                <th>Settings</th><th>Trades</th><th>Win rate</th><th>Max DD</th>
                <th>In-sample</th><th>Out-of-sample</th><th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in side.rows" :key="i">
                <td class="params">{{ describe(row.params, result) }}</td>
                <td>{{ row.stats.tradeCount }}</td>
                <td>{{ pct(row.stats.winRate) }}</td>
                <td>{{ pct(row.stats.maxDrawdownPct) }}</td>
                <td :class="row.stats.expectancy >= 0 ? 'is-up' : 'is-down'">
                  {{ num(row.stats.expectancy) }}
                </td>
                <td v-if="row.outOfSample" :class="row.outOfSample.expectancy >= 0 ? 'is-up' : 'is-down'">
                  {{ num(row.outOfSample.expectancy) }}
                  <span class="faint">({{ row.outOfSample.tradeCount }})</span>
                </td>
                <td v-else class="faint">—</td>
                <td class="action">
                  <button
                    v-hint="{ label: 'Use for a backtest', text: 'Fills these settings into the Backtest tab, with the same market and the same range. The report will cover bars these settings were chosen on, so expect it to read better than the out-of-sample column.' }"
                    class="btn btn--sm btn--default"
                    @click="useForBacktest(row, result)"
                  >Use</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="note k-prose">
          The out-of-sample column is the one worth reading. A combination that leads in-sample
          and collapses beside it was fitted to those particular bars.
        </p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.sweep { display: flex; gap: 12px; width: 100%; height: 100%; overflow: hidden; }

.setup {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 352px;
  flex: none;
  padding: 18px;
  overflow-y: auto;
}
.output {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  overflow-y: auto;
}

.head { display: flex; align-items: baseline; justify-content: space-between; }
.market { color: var(--sec); }
.faint { color: var(--faint); }
.warn { color: var(--neg); }
.placeholder { color: var(--faint); padding: 20px 0; line-height: 1.5; max-width: 46ch; }

.strategies { display: flex; flex-wrap: wrap; gap: 4px; }
.strategy {
  padding: 10px 15px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-md);
  background: var(--glass);
  color: var(--sec);
  font-family: var(--font-num);
  font-weight: 600;
  font-size: 11.5px;
  cursor: pointer;
}
.strategy.is-active { border-color: var(--accent-brd); background: var(--accent-bg); color: var(--accent); }

.field { display: flex; align-items: center; justify-content: space-between; gap: 5px; }
.field .input { width: 118px; flex: none; }

.k-divider-h { height: 1px; background: var(--line); margin: 3px 0; }

.combos {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0 2px;
  color: var(--sec);
}
.combos .is-bad { color: var(--neg); }

/* Progress */
.progress { display: flex; flex-direction: column; gap: 8px; }
.bar {
  height: 5px;
  border-radius: 3px;
  background: var(--line);
  overflow: hidden;
}
.fill { height: 100%; background: var(--accent); transition: width 0.3s; }
.progress-text { color: var(--sec); }

.result-head { display: flex; align-items: flex-start; justify-content: space-between; }
.title {
  margin: 0;
  font-family: var(--font-num);
  font-size: 17px;
  font-weight: 700;
}
.subtitle { margin: 3px 0 0; color: var(--sec); }

.side { display: flex; flex-direction: column; gap: 4px; }

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
.params { color: var(--txt); }
.action { text-align: right; white-space: nowrap; }

.is-up { color: var(--pos); }
.is-down { color: var(--neg); }

.note { color: var(--faint); max-width: 62ch; line-height: 1.5; }
</style>
