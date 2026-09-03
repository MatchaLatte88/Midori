<script setup>
/* Backtest setup: pick a strategy, set what it costs to be wrong, run it.
 *
 * The symbol and timeframe are not asked for here. They come from the session,
 * which is what the chart is already looking at — running a test on a market
 * you are not looking at is almost never what anyone means, and asking twice
 * invites the two to disagree.
 *
 * The run itself happens in the main process. A year of minute bars is already
 * there; sending them here to compute and sending the result back would move
 * tens of megabytes to save nothing. What comes back is the stored summary.
 */
import { computed, onMounted, ref, watch } from 'vue';
import ParamFields from './ParamFields.vue';
import {
  datasetFor, selectSymbol, session, setError, setTimeframe, setView, takeHandoff,
} from '../stores/session.js';

const catalog = ref([]);
const strategyId = ref(null);
const params = ref({});
const running = ref(false);
const lastRun = ref(null);
/** Set when the form was filled from a sweep, so the panel can say where from. */
const fromSweep = ref(false);

/** Account settings — the run's, not the strategy's. */
const balance = ref(10_000);
const from = ref('');
const to = ref('');

const spec = computed(() => catalog.value.find((s) => s.id === strategyId.value) ?? null);
const dataset = computed(() => (session.symbol ? datasetFor(session.symbol) : null));

/** ISO day for a date input, in UTC so it matches how the bars are stored. */
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const rangeValid = computed(() => {
  if (!from.value || !to.value) return false;
  return Date.parse(`${from.value}T00:00:00Z`) < Date.parse(`${to.value}T00:00:00Z`);
});

const canRun = computed(() => (
  !running.value && !!strategyId.value && !!session.symbol && rangeValid.value && balance.value > 0
));

onMounted(async () => {
  try {
    catalog.value = await window.midori.backtest.strategies();
    if (catalog.value.length > 0) select(catalog.value[0].id);
    applyHandoff();
  } catch (err) {
    setError(err);
  }
});

/**
 * Fills the form from a sweep result, if one was sent here.
 *
 * Taken after the catalog has loaded, because `select` resets the parameters
 * to the schema defaults and would wipe what arrived. The market travels with
 * the settings and is applied to the session: a combination found on BTC 5m
 * means nothing run against whatever the chart happens to be showing, and
 * doing that silently would be the kind of wrong that looks right.
 */
function applyHandoff() {
  const pending = takeHandoff();
  if (!pending) return;

  if (pending.strategy && catalog.value.some((s) => s.id === pending.strategy)) {
    select(pending.strategy);
  }
  /* Merged over the defaults rather than replacing them, so a sweep made
   * before a strategy gained a setting still leaves that setting valid. */
  if (pending.params) params.value = { ...params.value, ...pending.params };

  if (pending.symbol && pending.symbol !== session.symbol) selectSymbol(pending.symbol);
  if (pending.timeframe && pending.timeframe !== session.timeframe) setTimeframe(pending.timeframe);

  if (Number.isFinite(pending.from)) from.value = isoDay(pending.from);
  if (Number.isFinite(pending.to)) to.value = isoDay(pending.to);
  if (Number.isFinite(pending.balance)) balance.value = pending.balance;

  fromSweep.value = true;
}

/* The range follows the data that actually exists for the symbol. A default of
 * "everything downloaded" is both the most useful starting point and the only
 * one guaranteed to contain bars. */
watch(dataset, (d) => {
  if (!d) return;
  if (!from.value) from.value = isoDay(d.first);
  if (!to.value) to.value = isoDay(d.last);
}, { immediate: true });

function select(id) {
  strategyId.value = id;
  const found = catalog.value.find((s) => s.id === id);
  // Start from the schema defaults, so every field has a value from the outset.
  params.value = Object.fromEntries((found?.params ?? []).map((p) => [p.key, p.default]));
  lastRun.value = null;
  fromSweep.value = false;
}

function patch(update) {
  params.value = { ...params.value, ...update };
}

function useFullRange() {
  const d = dataset.value;
  if (!d) return;
  from.value = isoDay(d.first);
  to.value = isoDay(d.last);
}

/* Everything crossing the bridge has to survive the structured clone
 * algorithm, and a Vue ref makes its object deeply reactive — `params.value`
 * and every array inside it are Proxies, which that algorithm refuses with
 * "could not be cloned". The parameters are plain data, so a JSON round trip
 * is both a faithful copy and a guarantee that what leaves here is inert. */
const plain = (value) => JSON.parse(JSON.stringify(value));

async function run() {
  if (!canRun.value) return;
  running.value = true;
  lastRun.value = null;
  try {
    lastRun.value = await window.midori.backtest.run({
      strategy: strategyId.value,
      params: plain(params.value),
      symbol: session.symbol,
      timeframe: session.timeframe,
      from: Date.parse(`${from.value}T00:00:00Z`),
      to: Date.parse(`${to.value}T00:00:00Z`),
      balance: Number(balance.value),
    });
  } catch (err) {
    setError(err);
  } finally {
    running.value = false;
  }
}

const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const money = (v) => (v == null ? '—' : v.toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}));
</script>

<template>
  <div class="backtest">
    <section class="k-panel setup">
      <header class="head">
        <span class="k-eyebrow">Strategy</span>
        <span v-if="session.symbol" class="market k-mono-label">
          {{ session.symbol }} · {{ session.timeframe }}
        </span>
      </header>

      <div v-if="catalog.length === 0" class="empty k-prose">No strategies registered</div>

      <div v-else class="strategies">
        <button
          v-for="s in catalog"
          :key="s.id"
          class="strategy"
          :class="{ 'is-active': s.id === strategyId }"
          @click="select(s.id)"
        >
          <span class="strategy-name">{{ s.name }}</span>
          <span class="strategy-desc">{{ s.description }}</span>
        </button>
      </div>

      <template v-if="spec">
        <p v-if="fromSweep" class="from-sweep k-prose">
          Filled from a sweep. This range includes the bars these settings were chosen on,
          so expect a friendlier result than the sweep's out-of-sample column.
        </p>

        <div class="k-divider-h"></div>
        <span class="k-eyebrow">Account</span>

        <label v-hint="{ label: 'Starting balance', text: 'The account the run begins with, in quote currency. Percentage risk is measured against it, so it also decides how large the first position is.' }" class="field">
          <span class="k-mono-label">Balance</span>
          <input v-model.number="balance" class="input input--sm" type="number" min="1" step="1000" />
        </label>

        <label v-hint="{ label: 'From', text: 'First day of the test, in UTC. The run uses closed bars only, in whatever timeframe the chart is set to.' }" class="field">
          <span class="k-mono-label">From</span>
          <input v-model="from" class="input input--sm" type="date" />
        </label>

        <label v-hint="{ label: 'To', text: 'Last day of the test, in UTC. Trades still open at the end are marked out at the final close.' }" class="field">
          <span class="k-mono-label">To</span>
          <input v-model="to" class="input input--sm" type="date" />
        </label>

        <div class="range-note">
          <span v-if="dataset" class="k-mono-label faint">
            Data: {{ isoDay(dataset.first) }} → {{ isoDay(dataset.last) }}
          </span>
          <button v-if="dataset" class="btn btn--sm btn--default" @click="useFullRange">Use all</button>
        </div>
        <p v-if="from && to && !rangeValid" class="warn k-prose">The end date must be after the start.</p>

        <div class="k-divider-h"></div>
        <span class="k-eyebrow">Parameters</span>
        <ParamFields :schema="spec.params" :values="params" @update="patch" />

        <button class="btn btn--accent run" :disabled="!canRun" @click="run">
          {{ running ? 'Running…' : 'Run backtest' }}
        </button>
        <p v-if="!session.symbol" class="warn k-prose">Select a symbol on the chart first.</p>
      </template>
    </section>

    <section class="k-panel result">
      <span class="k-eyebrow">Result</span>

      <div v-if="running" class="placeholder k-prose">Running…</div>

      <div v-else-if="!lastRun" class="placeholder k-prose">
        No run yet. Set the parameters and press Run.
      </div>

      <template v-else>
        <div class="headline" :class="lastRun.stats.netPnl >= 0 ? 'is-up' : 'is-down'">
          {{ lastRun.stats.netPnl >= 0 ? '+' : '' }}{{ money(lastRun.stats.netPnl) }}
          <span class="headline-pct">{{ pct(lastRun.stats.returnPct) }}</span>
        </div>

        <dl class="figures">
          <div><dt>Trades</dt><dd>{{ lastRun.stats.tradeCount }}</dd></div>
          <div><dt>Win rate</dt><dd>{{ pct(lastRun.stats.winRate) }}</dd></div>
          <div><dt>Max drawdown</dt><dd>{{ pct(lastRun.stats.maxDrawdownPct) }}</dd></div>
          <div>
            <dt>Profit factor</dt>
            <dd>{{ lastRun.stats.profitFactor == null ? '—' : lastRun.stats.profitFactor.toFixed(2) }}</dd>
          </div>
          <div>
            <dt>Expectancy</dt>
            <dd>{{ lastRun.stats.expectancy == null ? '—' : money(lastRun.stats.expectancy) }}</dd>
          </div>
          <div><dt>Fees paid</dt><dd>{{ money(lastRun.stats.feesPaid) }}</dd></div>
        </dl>

        <p class="k-prose faint">
          Fills resolved {{ lastRun.resolution === 'intrabar' ? 'from minute bars' : 'pessimistically' }}.
        </p>

        <button class="btn btn--sm btn--default self-start" @click="setView('results')">
          Open in results
        </button>
      </template>
    </section>
  </div>
</template>

<style scoped>
.backtest {
  display: flex;
  gap: 12px;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.setup {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 332px;
  flex: none;
  padding: 18px;
  overflow-y: auto;
}

.result {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  overflow-y: auto;
}
/* A stretch item in a column flexbox fills the width; this one is a button. */
.self-start { align-self: flex-start; }

.head { display: flex; align-items: baseline; justify-content: space-between; }
.market { color: var(--sec); }
.empty, .placeholder { color: var(--faint); padding: 20px 0; }
.faint { color: var(--faint); }

.strategies { display: flex; flex-direction: column; gap: 4px; }
.strategy {
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
.strategy:hover { background: var(--glass-strong); }
.strategy.is-active { border-color: var(--accent-brd); background: var(--accent-bg); }
.strategy-name {
  font-family: var(--font-num);
  font-weight: 600;
  font-size: 12px;
}
.strategy-desc { font-size: 11px; color: var(--sec); line-height: 1.35; }

.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
}
.field .input { width: 108px; flex: none; }

.range-note { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.warn { color: var(--neg); }

/* Says where the values came from, and what that costs in how they read. */
.from-sweep {
  margin: 0;
  padding: 7px 9px;
  border: 1px solid var(--accent-brd);
  border-radius: var(--radius-sm);
  background: var(--accent-bg);
  color: var(--sec);
  line-height: 1.45;
}

.run { margin-top: 6px; }

.k-divider-h { height: 1px; background: var(--line); margin: 3px 0; }

.headline {
  font-family: var(--font-mono);
  font-size: 30px;
  font-weight: 500;
  letter-spacing: -0.02em;
}
.headline.is-up { color: var(--pos); }
.headline.is-down { color: var(--neg); }
.headline-pct { font-size: 15px; color: var(--sec); margin-left: 8px; }

.figures {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px 16px;
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
.figures dd {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 15px;
}
</style>
