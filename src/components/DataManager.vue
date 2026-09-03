<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { refreshDatasets, selectSymbol, session, setError } from '../stores/session.js';

const symbol = ref('BTCUSDT');
const from = ref('2024-01-01');
const to = ref(new Date().toISOString().slice(0, 10));
const busy = ref(false);
const progress = ref(null);
const result = ref(null);

let unsubscribe = null;

onMounted(() => {
  unsubscribe = window.midori.data.onDownloadProgress((p) => { progress.value = p; });
});
onBeforeUnmount(() => unsubscribe?.());

const canDownload = computed(() => !busy.value && symbol.value.trim() && from.value < to.value);

async function download() {
  busy.value = true;
  result.value = null;
  progress.value = null;
  setError(null);
  try {
    const res = await window.midori.data.download({
      symbol: symbol.value.trim().toUpperCase(),
      from: `${from.value}T00:00:00Z`,
      to: `${to.value}T00:00:00Z`,
    });
    result.value = res;
    await refreshDatasets();
    selectSymbol(symbol.value.trim().toUpperCase());
  } catch (err) {
    setError(err);
    result.value = null;
  } finally {
    busy.value = false;
    progress.value = null;
  }
}

function fmtCount(n) {
  return n.toLocaleString('en-GB');
}
function fmtDate(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 10) : '—';
}
function fmtSize(bytes) {
  if (!bytes) return '—';
  const mb = bytes / 1_048_576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

/** Share of bars carrying a buy/sell split — 0 for anything stored before v2. */
function deltaShare(d) {
  if (!d.count) return 0;
  return (d.barsWithBuyVolume ?? 0) / d.count;
}

function deltaLabel(d) {
  const share = deltaShare(d);
  if (share === 0) return 'no buy/sell delta — re-download to add it';
  if (share > 0.999) return 'buy/sell delta available';
  return `buy/sell delta on ${(share * 100).toFixed(0)}% of bars`;
}
</script>

<template>
  <section class="data-panel">
    <div class="k-eyebrow">Market data</div>

    <p class="k-note">
      Downloads come straight from <b>Binance's public archive</b> — no key, no account.
      Files land on this machine only.
    </p>

    <label class="field">
      <span class="k-mono-label">Symbol</span>
      <input v-model="symbol" class="input" placeholder="BTCUSDT" spellcheck="false" />
    </label>

    <div class="row">
      <label class="field">
        <span class="k-mono-label">From</span>
        <input v-model="from" type="date" class="input" />
      </label>
      <label class="field">
        <span class="k-mono-label">To</span>
        <input v-model="to" type="date" class="input" />
      </label>
    </div>

    <button class="primary-btn" :disabled="!canDownload" @click="download">
      {{ busy ? 'Downloading…' : 'Download 1m history' }}
    </button>

    <div v-if="progress" class="progress">
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: `${(progress.done / progress.total) * 100}%` }"></div>
      </div>
      <span class="k-mono-meta">{{ progress.label }} · {{ progress.done }}/{{ progress.total }}</span>
    </div>

    <p v-if="result" class="k-note result">
      <b>{{ fmtCount(result.added) }}</b> new bars · {{ fmtCount(result.total) }} stored
      <template v-if="result.missing?.length">
        <br />Not published for: {{ result.missing.join(', ') }}
      </template>
    </p>

    <!-- Errors are shown once, app-wide, by App.vue: this panel only exists on
         the chart view, so an error raised anywhere else had nowhere to go. -->

    <div class="k-eyebrow library-head">Local library</div>
    <p v-if="!session.datasets.length" class="k-prose">Nothing downloaded yet.</p>
    <ul v-else class="library">
      <li
        v-for="d in session.datasets"
        :key="d.symbol"
        :class="['library-item', { active: d.symbol === session.symbol }]"
        @click="selectSymbol(d.symbol)"
      >
        <span class="lib-symbol">{{ d.symbol }}</span>
        <span class="k-mono-meta">{{ fmtDate(d.first) }} → {{ fmtDate(d.last) }}</span>
        <span class="k-mono-meta">{{ fmtCount(d.count) }} bars · {{ fmtSize(d.bytes) }}</span>
        <span class="k-mono-meta" :class="{ 'no-delta': !deltaShare(d) }">
          {{ deltaLabel(d) }}
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* A column of the workspace rather than a card in it: on the ground, square,
   and separated from the chart by the one hairline that faces it. */
.data-panel {
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 14px;
  width: 300px;
  flex-shrink: 0;
  overflow-y: auto;
  background: var(--bg);
}
.field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
/* Only in a row: in the column this panel is, `flex: 1` would grow the field
   downwards and push everything under it off the bottom. */
.row { display: flex; gap: 10px; }
.row .field { flex: 1; }
.input {
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--brd);
  border-radius: var(--radius-sm);
  background: var(--glass);
  color: var(--txt);
  font: inherit;
  min-width: 0;
}
.input:focus-visible { border-color: var(--accent-brd); }

.progress { display: flex; flex-direction: column; gap: 5px; }
.progress-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--line);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}
.result { border-color: var(--accent-brd); }
.error { color: var(--neg); border-color: rgba(220, 38, 38, 0.3); }

.library-head { margin-top: 4px; }
.library { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.library-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.library-item:hover { background: var(--glass); }
.library-item.active {
  border-color: var(--line-strong);
  background: var(--sel-bg);
}
.lib-symbol { font-family: var(--font-num); font-weight: 600; }
.no-delta { color: var(--ember); }
</style>
